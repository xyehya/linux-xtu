//! Version handshake with the helper (R-B3 / R-B8 / R-I1; `src/linux_xtu/helper/ops.py` module docstring, "Version handshake").
//!
//! * Every `preflight` the shell sends declares this app: `client: {name, version, protocol}` ([`client`]); the handshake's and the webview's
//!   alike (the webview cannot send its own `client`).
//! * The helper answers `helper: {version, protocol, ops_hash, ops}` (in `result`, or in `error.detail` when its preflight failed) and
//!   `client.protocol_ok`. [`VersionCheck::of`] compares that with this app: a `protocol` other than [`PROTOCOL`] (or none: an older helper)
//!   is a mismatch — the shell refuses writes and mutating ops locally (`HelperState::call`), and the webview gets the preflight with
//!   `writes_allowed: false` and a failed `app_version` check ([`VersionCheck::decorate`]) and the link status with the reason and the fix.
//!   The helper fences the same connection on its own side. An `ops_hash` other than the hash of [`ALLOWED_OPS`] is logged and noted
//!   (`app_ops` check, `warn`): the app's allowlist still decides what is sent, and an op the helper lacks is refused by the helper.
//! * `ops_hash` is SHA-256 (hex) of the op names, sorted, joined with `\n` — computed here from the allowlist (std only: [`sha256_hex`]).

use serde_json::{json, Map, Value};

use super::ops::ALLOWED_OPS;

/// The helper protocol this app is built against (`src/linux_xtu/helper/ops.py` `PROTOCOL`).
pub const PROTOCOL: u64 = 1;
/// The fix for a version mismatch: install the helper and the app from one release.
pub const REINSTALL: &str = "sudo bash install.sh";
/// Longest helper `version` string kept (ops.py `_CLIENT_TEXT_MAX`).
const TEXT_MAX: usize = 64;

/// What this app declares in `preflight`.
pub fn client() -> Value {
    json!({"name": crate::APP_NAME, "version": crate::VERSION, "protocol": PROTOCOL})
}

/// The arguments of every `preflight` the shell sends.
pub fn preflight_args() -> Value {
    json!({"client": client()})
}

/// ops.py `ops_hash`: SHA-256 (lowercase hex) of the names, sorted, joined with `\n` (no trailing newline).
pub fn ops_hash(names: &[&str]) -> String {
    let mut sorted: Vec<&str> = names.to_vec();
    sorted.sort_unstable();
    sha256_hex(sorted.join("\n").as_bytes())
}

/// The hash of the op set this app was built against (its allowlist).
pub fn built_ops_hash() -> String {
    ops_hash(ALLOWED_OPS)
}

/// The helper's side of the handshake and how it compares with this app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionCheck {
    /// `helper.version` (cut to 64 characters); `None` when the helper sent no version block.
    pub helper_version: Option<String>,
    pub helper_protocol: Option<u64>,
    pub helper_ops_hash: Option<String>,
    pub helper_ops: Option<u64>,
    /// The helper's own verdict on this client (`client.protocol_ok`), when it gave one.
    pub client_protocol_ok: Option<bool>,
    /// Same protocol on both sides (and the helper did not fence this client).
    pub protocol_ok: bool,
    /// `None` when the helper sent no hash.
    pub ops_hash_ok: Option<bool>,
}

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| s.chars().filter(|c| !c.is_control()).take(TEXT_MAX).collect())
}

impl VersionCheck {
    /// Compare a raw `preflight` response (`{id, ok, result}` / `{id, ok:false, error:{detail}}`) with this app.
    pub fn of(resp: &Value) -> VersionCheck {
        let body = if resp.get("ok") == Some(&Value::Bool(true)) { resp.get("result") } else { resp.get("error").and_then(|e| e.get("detail")) };
        let helper = body.and_then(|b| b.get("helper")).filter(|h| h.is_object());
        let field = |k: &str| helper.and_then(|h| h.get(k));
        let helper_ops_hash = field("ops_hash").and_then(Value::as_str).filter(|h| super::ops::plan_id_ok(h)).map(str::to_string);
        let helper_protocol = field("protocol").and_then(Value::as_u64);
        let client_protocol_ok = body.and_then(|b| b.get("client")).and_then(|c| c.get("protocol_ok")).and_then(Value::as_bool);
        let ops_hash_ok = helper_ops_hash.as_ref().map(|h| *h == built_ops_hash());
        VersionCheck {
            helper_version: text(field("version")),
            helper_protocol,
            helper_ops_hash,
            helper_ops: field("ops").and_then(Value::as_u64),
            client_protocol_ok,
            protocol_ok: helper_protocol == Some(PROTOCOL) && client_protocol_ok != Some(false),
            ops_hash_ok,
        }
    }

    fn helper_name(&self) -> String {
        match &self.helper_version {
            Some(v) => format!("the helper ({v})"),
            None => "the helper".to_string(),
        }
    }

    /// Why writes are off, for the operator (`None` when the protocols match).
    pub fn message(&self) -> Option<String> {
        if self.protocol_ok {
            return None;
        }
        let app = format!("this app ({} {})", crate::APP_NAME, crate::VERSION);
        let why = match self.helper_protocol {
            None => format!("{} reports no protocol (it is older than {app}, which speaks protocol {PROTOCOL})", self.helper_name()),
            Some(p) if p != PROTOCOL => format!("{} speaks protocol {p}, {app} protocol {PROTOCOL}", self.helper_name()),
            Some(_) => format!("{} refused {app}'s protocol for this connection", self.helper_name()),
        };
        Some(format!("Helper and app versions differ: {why}. Writes are off. Install both from the same release: {REINSTALL}"))
    }

    /// The note for a different op set (`None` when the hashes match or the helper sent none).
    pub fn ops_note(&self) -> Option<String> {
        if self.ops_hash_ok != Some(false) {
            return None;
        }
        let served = self.helper_ops.map_or_else(|| "an unknown number of".to_string(), |n| n.to_string());
        Some(format!(
            "{} serves a different set of operations ({served}) than this app was built against ({}): the app sends only its own; one the helper lacks is refused by it. Install both from the same release.",
            self.helper_name(),
            ALLOWED_OPS.len()
        ))
    }

    /// `helper_status`'s `version`: `{app, helper, protocol_ok, ops_hash_ok, message, fix}`.
    pub fn to_value(&self) -> Value {
        let helper = if self.helper_version.is_none() && self.helper_protocol.is_none() && self.helper_ops_hash.is_none() {
            Value::Null
        } else {
            json!({"version": self.helper_version, "protocol": self.helper_protocol, "ops_hash": self.helper_ops_hash, "ops": self.helper_ops})
        };
        json!({
            "app": {"name": crate::APP_NAME, "version": crate::VERSION, "protocol": PROTOCOL, "ops_hash": built_ops_hash(), "ops": ALLOWED_OPS.len()},
            "helper": helper,
            "protocol_ok": self.protocol_ok,
            "ops_hash_ok": self.ops_hash_ok,
            "message": self.message(),
            "fix": if self.protocol_ok { Value::Null } else { Value::String(REINSTALL.to_string()) },
        })
    }

    /// The public preflight answer as the webview gets it: on a protocol mismatch `writes_allowed: false` and a failed `app_version` check
    /// first; on a different op set an `app_ops` warning last. An error answer passes unchanged (writes are off without a report anyway).
    pub fn decorate(&self, public: Value) -> Value {
        let mut out = public;
        let Some(result) = out.get_mut("result").and_then(Value::as_object_mut) else { return out };
        if let Some(msg) = self.message() {
            result.insert("writes_allowed".into(), Value::Bool(false));
            checks(result).insert(0, json!({"name": "app_version", "status": "fail", "reason": msg}));
        }
        if let Some(note) = self.ops_note() {
            checks(result).push(json!({"name": "app_ops", "status": "warn", "reason": note}));
        }
        out
    }
}

fn checks(result: &mut Map<String, Value>) -> &mut Vec<Value> {
    if !result.get("checks").is_some_and(Value::is_array) {
        result.insert("checks".into(), Value::Array(Vec::new()));
    }
    match result.get_mut("checks") {
        Some(Value::Array(a)) => a,
        _ => unreachable!("checks was made an array above"),
    }
}

// ---- SHA-256 (FIPS 180-4), std only -------------------------------------------------------------------------------------------------
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256 of `data`, lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(sha256_hex(&[b'a'; 1000]), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }

    #[test]
    fn the_ops_hash_is_the_helpers_definition() {
        assert_eq!(ops_hash(&["b", "a"]), sha256_hex(b"a\nb"));
        assert_eq!(ops_hash(&["b", "a"]), ops_hash(&["a", "b"]));
        // the helper's builtin op set at the time of writing (src/linux_xtu/helper/ops.py builtin_ops; tests/helper/test_version.py): the
        // simulator test helper_sim.rs compares with the live helper, this pins the computation
        assert_eq!(built_ops_hash(), "e09a47177e019c38639a922ec19b9fe4d0ec93d71be6bb57e243d2a18469350e");
    }

    fn pre(helper: Value, client: Value) -> Value {
        json!({"id": "d1", "ok": true, "result": {"mode": "write", "writes_allowed": true, "checks": [{"name": "cpuid", "status": "pass", "reason": "ok"}], "helper": helper, "client": client}})
    }

    #[test]
    fn a_matching_helper_passes_and_changes_nothing() {
        let h = json!({"version": "0.2.0-dev", "protocol": PROTOCOL, "ops_hash": built_ops_hash(), "ops": ALLOWED_OPS.len()});
        let resp = pre(h, json!({"name": "linux-xtu-desktop", "protocol": PROTOCOL, "protocol_ok": true}));
        let v = VersionCheck::of(&resp);
        assert!(v.protocol_ok && v.ops_hash_ok == Some(true) && v.message().is_none() && v.ops_note().is_none());
        assert_eq!(v.decorate(resp.clone()), resp);
        assert_eq!(v.to_value()["fix"], Value::Null);
        assert_eq!(v.to_value()["app"]["protocol"], PROTOCOL);
    }

    #[test]
    fn a_protocol_mismatch_turns_writes_off_with_the_reason_and_the_fix() {
        let other = pre(json!({"version": "0.3.0", "protocol": PROTOCOL + 1, "ops_hash": built_ops_hash(), "ops": 32}), json!({"protocol_ok": false}));
        let v = VersionCheck::of(&other);
        assert!(!v.protocol_ok);
        let msg = v.message().unwrap();
        assert!(msg.starts_with("Helper and app versions differ: the helper (0.3.0) speaks protocol 2, this app (linux-xtu-desktop "), "{msg}");
        assert!(msg.ends_with(REINSTALL), "{msg}");
        let out = v.decorate(other);
        assert_eq!(out["result"]["writes_allowed"], false);
        assert_eq!(out["result"]["checks"][0]["name"], "app_version");
        assert_eq!(out["result"]["checks"][0]["status"], "fail");
        assert_eq!(v.to_value()["fix"], REINSTALL);

        // an older helper says nothing about its protocol: a mismatch too
        let old = json!({"id": "d1", "ok": true, "result": {"mode": "write", "writes_allowed": true}});
        let v = VersionCheck::of(&old);
        assert!(!v.protocol_ok && v.helper_version.is_none());
        assert!(v.message().unwrap().contains("reports no protocol"));
        assert_eq!(v.to_value()["helper"], Value::Null);
        assert_eq!(v.decorate(old)["result"]["checks"][0]["name"], "app_version", "a report without checks gets the list");

        // the helper fenced this client (sticky for the connection) although the numbers agree
        let fenced = pre(json!({"protocol": PROTOCOL}), json!({"protocol_ok": false}));
        assert!(VersionCheck::of(&fenced).message().unwrap().contains("refused this app"));

        // a failed helper preflight still carries the versions in error.detail
        let failed = json!({"id": "d1", "ok": false, "error": {"code": "PREFLIGHT_FAILED", "message": "x", "detail": {"helper": {"version": "0.2.0-dev", "protocol": PROTOCOL}}}});
        let v = VersionCheck::of(&failed);
        assert!(v.protocol_ok && v.ops_hash_ok.is_none());
        assert_eq!(v.decorate(failed.clone()), failed);
    }

    #[test]
    fn a_different_op_set_is_a_note_not_a_fence() {
        let resp = pre(json!({"version": "0.2.1", "protocol": PROTOCOL, "ops_hash": "0".repeat(64), "ops": 33}), json!({"protocol_ok": true}));
        let v = VersionCheck::of(&resp);
        assert!(v.protocol_ok && v.ops_hash_ok == Some(false) && v.message().is_none());
        let out = v.decorate(resp);
        assert_eq!(out["result"]["writes_allowed"], true);
        let last = out["result"]["checks"].as_array().unwrap().last().unwrap().clone();
        assert_eq!((last["name"].as_str(), last["status"].as_str()), (Some("app_ops"), Some("warn")));
        assert!(last["reason"].as_str().unwrap().contains("(33) than this app was built against (32)"));
    }
}
