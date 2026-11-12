//! Op allowlist with argument-shape checks (PLAN §3.1, defence in depth: the helper re-validates everything).
//!
//! Mirrors `OPS` and its validators in `src/linux_xtu/web/server.py:57-171` (same op names, same shapes, same bounds). Python's
//! `type(x) is int` becomes "a JSON integer" (`Number` without fraction; booleans and floats are not integers). Nothing outside this table
//! ever reaches the socket: [`crate::helper::link::Link`] calls [`check`] on every request it writes.
//! `power.*` mirrors `src/linux_xtu/helper/ops_power.py` and `runtime.*` mirrors `ops_runtime.py` (PLAN §6). Core parking is held (D-048):
//! a `parking` key is refused here as well as by the helper.
//! R-I1 (the R-B1 / R-B3 arguments): a `tune.plan` intent is checked field by field like `ops_tune.py` `canonical_intent` ([`tune_intent`]);
//! `*.apply` may carry the editor's `intent` (the helper refuses `PLAN_STALE` / `INTENT_CHANGED` when it is not the planned one), checked
//! with the plan op's own validator; `power.plan` / `runtime.plan` take `{profile}` / `{restore: "accepted"}`; `profiles.save` takes
//! `intent` / `power` / `runtime` (or `from: "read"`); `preflight` carries the shell's `client` block (helper::version).

use serde_json::{Map, Value};

type Args = Map<String, Value>;

/// A local refusal: `code` is a helper protocol code (`UNKNOWN_OP`, `BAD_REQUEST`), `message` says what was wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

/// What the allowlist knows about an accepted op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpInfo {
    /// Long ops answer at the end (events meanwhile): the link returns `{id}` at once and delivers the result as `helper://result`.
    pub long: bool,
}

/// Largest `intent` (compact JSON, bytes) the allowlist forwards (server.py `_tune_plan`: 16 KiB).
pub const MAX_INTENT_BYTES: usize = 16 * 1024;
const MAX_UNITS: usize = 256;
/// CPU numbers a `runtime.plan` cap may name are 0..1023 (ops_runtime.py `_CPU_MAX`).
const CPU_MAX: usize = 1024;
/// ops_tune.py `canonical_intent`: at most 32 rows, 12 point offsets per row, 15 ring points (profiles/schema.py `POINT_RANGE`).
const MAX_ROWS: usize = 32;
const MAX_ROW_POINTS: usize = 12;
const MAX_RING_POINTS: usize = 15;
/// ops.py `_CLIENT_TEXT_MAX`, and the largest protocol number `preflight` accepts.
const CLIENT_TEXT_MAX: usize = 64;
const PROTOCOL_MAX: u64 = 1_000_000;

/// Every allowed op name, in the order of `server.py` `OPS`.
pub const ALLOWED_OPS: &[&str] = &[
    "preflight", "audit.tail", "telemetry.start", "telemetry.stop", "cancel", "vf.dump", "tune.read", "tune.plan", "tune.apply",
    "profiles.list", "profiles.save", "profiles.accept", "profiles.diff", "profiles.fingerprint", "profiles.get", "tune.last", "vf.measure", "curves.list",
    "curves.get", "curves.update", "curves.delete", "mem.read", "stress.start", "stress.stop", "stress.list", "power.read", "power.plan",
    "power.apply", "runtime.read", "runtime.plan", "runtime.apply", "throttle.tail",
];

/// Ops the shell answers itself (they never reach the socket): `app.confirm` asks the operator in a native dialog (D-053 item 4, see
/// [`crate::helper::confirm`]). `ui/tests/allowlist.test.mjs` accepts a UI op when it is here or in [`ALLOWED_OPS`].
pub const SHELL_OPS: &[&str] = &["app.confirm"];

/// Most plans one `app.confirm` may cover (V/F + power + caps/uncore is three; one spare).
pub const MAX_CONFIRM_PLANS: usize = 4;

/// The helper's `MUTATING_OPS` (src/linux_xtu/helper/ops.py): what a connection whose protocol differs may not send (the helper refuses them too,
/// `VERSION_MISMATCH`). `HelperState` refuses these and `app.confirm` locally on a mismatch (helper::version).
pub const MUTATING_OPS: &[&str] = &[
    "tune.apply", "power.apply", "runtime.apply", "vf.measure", "stress.start", "profiles.save", "profiles.accept", "profiles.fingerprint", "curves.update",
    "curves.delete",
];

/// Ops that change persistent state the boot restore and the Windows restore depend on (the accepted state and its CPU fingerprint). The shell
/// sends each only after the operator's OK in a native dialog shown for that very request (`HelperState`; fail closed whatever the helper's
/// protocol: `profiles.accept` of a one-step helper accepts at once, the two-step helper (R-B1) answers a confirmation code the shell spends
/// itself). The other persistent ops do not change what the CPU runs or what a restore applies: `profiles.save` never overwrites (the helper
/// refuses an existing or accepted name), `curves.update` / `curves.delete` touch measured curves only (predictions).
pub const PERSIST_OPS: &[&str] = &["profiles.accept", "profiles.fingerprint"];

/// A family of plans: `*.apply` is bound to plan ids this connection got from the same kind's `*.plan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanKind {
    Tune,
    Power,
    Runtime,
}

impl PlanKind {
    pub const COUNT: usize = 3;

    pub fn index(self) -> usize {
        self as usize
    }

    /// The op that spends a plan of this kind.
    pub fn apply_op(self) -> &'static str {
        match self {
            PlanKind::Tune => "tune.apply",
            PlanKind::Power => "power.apply",
            PlanKind::Runtime => "runtime.apply",
        }
    }

    /// The op that makes a plan of this kind.
    pub fn plan_op(self) -> &'static str {
        match self {
            PlanKind::Tune => "tune.plan",
            PlanKind::Power => "power.plan",
            PlanKind::Runtime => "runtime.plan",
        }
    }
}

/// `Some((kind, is_apply))` for a `*.plan` (`false`) or `*.apply` (`true`) op.
pub fn plan_role(op: &str) -> Option<(PlanKind, bool)> {
    match op {
        "tune.plan" => Some((PlanKind::Tune, false)),
        "tune.apply" => Some((PlanKind::Tune, true)),
        "power.plan" => Some((PlanKind::Power, false)),
        "power.apply" => Some((PlanKind::Power, true)),
        "runtime.plan" => Some((PlanKind::Runtime, false)),
        "runtime.apply" => Some((PlanKind::Runtime, true)),
        _ => None,
    }
}

/// The plan kind an `*.apply` op spends (the operator confirms it first with `app.confirm`); `None` for every other op.
pub fn apply_kind(op: &str) -> Option<PlanKind> {
    match plan_role(op) {
        Some((kind, true)) => Some(kind),
        _ => None,
    }
}

/// An op the shell sends only after the operator's OK: an `*.apply` or a [`PERSIST_OPS`] op.
pub fn needs_operator(op: &str) -> bool {
    apply_kind(op).is_some() || PERSIST_OPS.contains(&op)
}

/// What the webview may send for an `*.apply` of `kind`: `{plan_id[, intent]}` (the shell adds `typed` from its own copy of the nonce).
/// `intent` is what the editor holds now, in the shape of the plan op's request (R-B1 / R-26: the helper refuses `PLAN_STALE` /
/// `INTENT_CHANGED` when it is not the planned one); it is checked with that plan op's validator. -> `(plan_id, intent)`.
pub fn webview_apply_args(kind: PlanKind, args: &Value) -> Result<(String, Option<Value>), Refusal> {
    let Some(a) = args.as_object() else {
        return Err(refuse("BAD_REQUEST", "args must be a JSON object"));
    };
    if a.contains_key("typed") {
        return Err(refuse("BAD_REQUEST", "the page never sends a confirmation code (the app asks you in its own dialog and adds it)"));
    }
    if !keys_within(a, &["plan_id", "intent"]) || !a.get("plan_id").is_some_and(|p| str_is(p, hex64)) {
        return Err(refuse("BAD_REQUEST", "an apply names its plan_id and, optionally, the intent the editor holds now"));
    }
    let intent = a.get("intent").cloned();
    if intent.as_ref().is_some_and(|i| !apply_intent_ok(kind, i)) {
        return Err(refuse(
            "BAD_REQUEST",
            &format!("the intent of {} has the wrong shape (it is the {} request the editor would send now)", kind.apply_op(), kind.plan_op()),
        ));
    }
    Ok((a["plan_id"].as_str().unwrap_or_default().to_string(), intent))
}

/// The `intent` of an `*.apply` of `kind`: the request its plan op takes (tune: the `intent` of `tune.plan`; power / runtime: the whole request).
pub fn apply_intent_ok(kind: PlanKind, intent: &Value) -> bool {
    match (kind, intent.as_object()) {
        (PlanKind::Tune, _) => tune_intent(intent, false),
        (PlanKind::Power, Some(o)) => power_plan(o),
        (PlanKind::Runtime, Some(o)) => runtime_plan(o),
        _ => false,
    }
}

/// What the webview may send for a [`PERSIST_OPS`] op: `profiles.accept` step 1 (`{name}` | `{from: "read"}` [+ `set_aside_unreadable`]) — never
/// the confirmation step, which the shell sends itself — and `profiles.fingerprint {}`.
pub fn webview_persist_args(op: &str, args: &Value) -> Result<(), Refusal> {
    let Some(a) = args.as_object() else {
        return Err(refuse("BAD_REQUEST", "args must be a JSON object"));
    };
    match op {
        "profiles.accept" if a.contains_key("plan_id") || a.contains_key("typed") => {
            Err(refuse("BAD_REQUEST", "the page never sends the confirmation step of an accept (the app asks you in its own dialog and sends it)"))
        }
        "profiles.accept" if profiles_accept(a) => Ok(()),
        "profiles.fingerprint" if a.is_empty() => Ok(()),
        _ => Err(refuse("BAD_REQUEST", &format!("arguments of {} have the wrong shape", clip(op)))),
    }
}

/// `app.confirm {plans: [{op, plan_id}, ...]}`: 1..=[`MAX_CONFIRM_PLANS`] distinct plans, each named by the `*.apply` that will spend it.
pub fn confirm_args(args: &Value) -> Result<Vec<(PlanKind, String)>, Refusal> {
    let bad = || refuse("BAD_REQUEST", "app.confirm takes {plans: [{op, plan_id}, ...]} (1 to 4 plans)");
    let a = args.as_object().ok_or_else(bad)?;
    if !keys_exactly(a, &["plans"]) {
        return Err(bad());
    }
    let list = a["plans"].as_array().ok_or_else(bad)?;
    if list.is_empty() || list.len() > MAX_CONFIRM_PLANS {
        return Err(bad());
    }
    let mut out: Vec<(PlanKind, String)> = Vec::with_capacity(list.len());
    for item in list {
        let o = item.as_object().ok_or_else(bad)?;
        if !keys_exactly(o, &["op", "plan_id"]) || !str_is(&o["plan_id"], hex64) {
            return Err(bad());
        }
        let kind = apply_kind(o["op"].as_str().unwrap_or_default()).ok_or_else(bad)?;
        let id = o["plan_id"].as_str().unwrap_or_default().to_string();
        if out.iter().any(|(_, p)| p == &id) {
            return Err(bad());
        }
        out.push((kind, id));
    }
    Ok(out)
}

/// A plan's confirmation code as the helper makes it (`ops_tune.py` `_NONCE_ALPHABET`, 6 characters): the shell keeps only well-formed ones.
pub fn nonce_ok(s: &str) -> bool {
    all_chars(s, 6, 6, |c| matches!(c, 'A'..='Z' | '2'..='9'))
}

/// A 64-character lowercase hex id (plan ids).
pub fn plan_id_ok(s: &str) -> bool {
    hex64(s)
}

/// Judge a request locally: the op must be allowlisted and `args` (a JSON object) must have the op's shape.
pub fn check(op: &str, args: &Value) -> Result<OpInfo, Refusal> {
    let Some(a) = args.as_object() else {
        return Err(refuse("BAD_REQUEST", "args must be a JSON object"));
    };
    let (ok, long): (bool, bool) = match op {
        "telemetry.stop" | "profiles.list" | "profiles.fingerprint" | "tune.last" | "curves.list" | "mem.read" | "stress.stop" | "stress.list"
        | "runtime.read" => (a.is_empty(), false),
        "preflight" => (preflight(a), false),
        "power.read" => (a.is_empty(), true), // guarded MSR reads: a long op in the helper
        "audit.tail" => (audit_tail(a), false), // optional n 1..200 and (QA-32) before: a byte offset 0..2^53, or null (ops.py _validate_audit_tail)
        "throttle.tail" => (throttle_tail(a), false), // optional n 1..200 (helper telemetry/throttle.validate_tail_n)
        "telemetry.start" => (telemetry_start(a), false),
        "cancel" => (cancel(a), false),
        "vf.dump" | "tune.read" => (vf_dump(a), true),
        "tune.plan" => (tune_plan(a), false),
        "tune.apply" => (apply_with(a, PlanKind::Tune), true),
        "power.apply" => (apply_with(a, PlanKind::Power), true),
        "runtime.apply" => (apply_with(a, PlanKind::Runtime), true),
        // The helper registers both *.plan ops long=True; here they are short like tune.plan, so the link sees the answer and remembers its plan_id.
        "power.plan" => (power_plan(a), false),
        "runtime.plan" => (runtime_plan(a), false),
        "profiles.save" => (profiles_save(a), false),
        "profiles.accept" => (profiles_accept(a), false),
        "profiles.diff" => (profiles_diff(a), false),
        "profiles.get" => (profiles_get(a), false),
        "vf.measure" => (vf_measure(a), true),
        "curves.get" => (curves_get(a), false),
        "curves.update" => (curves_update(a), false),
        "curves.delete" => (curves_delete(a), false),
        "stress.start" => (stress_start(a), true),
        _ => return Err(refuse("UNKNOWN_OP", &format!("op {:?} is not allowed", clip(op)))),
    };
    if ok {
        Ok(OpInfo { long })
    } else {
        Err(refuse("BAD_REQUEST", &format!("arguments of {op} have the wrong shape")))
    }
}

fn refuse(code: &'static str, message: &str) -> Refusal {
    Refusal { code, message: format!("refused locally: {message}") }
}

fn clip(s: &str) -> String {
    s.chars().take(40).collect()
}

// ---- small matchers (the regexes of server.py, by hand: no regex crate) ------------------------------------------------------------
fn all_chars(s: &str, min: usize, max: usize, ok: impl Fn(char) -> bool) -> bool {
    let n = s.chars().count();
    (min..=max).contains(&n) && s.chars().all(ok)
}

fn req_id(s: &str) -> bool {
    all_chars(s, 1, 64, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn hex64(s: &str) -> bool {
    all_chars(s, 64, 64, |c| matches!(c, '0'..='9' | 'a'..='f'))
}

fn typed(s: &str) -> bool {
    s.strip_prefix("CONFIRM ").is_some_and(|rest| all_chars(rest, 6, 6, |c| matches!(c, 'A'..='Z' | '2'..='9')))
}

fn profile_name(s: &str) -> bool {
    all_chars(s, 1, 64, |c| matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '-'))
}

/// A saved profile name an accept may name (profiles/accepted.py `SAFE_PROFILE_NAME`, ops_accept.py: no `..`, not starting with `.` or `-`).
fn safe_profile_name(s: &str) -> bool {
    profile_name(s) && !s.starts_with(['.', '-']) && !s.contains("..")
}

fn curve_id_str(s: &str) -> bool {
    // 8 digits, 'T', 6 digits, 'Z', '-', 4 of [a-z0-9]
    let b = s.as_bytes();
    b.len() == 21
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z'
        && b[16] == b'-'
        && b[17..].iter().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

fn unit_str(s: &str) -> bool {
    let digits = s.strip_prefix("EC").or_else(|| s.strip_prefix('P'));
    digits.is_some_and(|d| (1..=3).contains(&d.len()) && d.bytes().all(|c| c.is_ascii_digit()))
}

/// curves/record.py `_UNIT_RE` (`(P|EC)(0|[1-9][0-9]{0,2})`): a row target of the unit scope (no leading zero).
fn unit_id(s: &str) -> bool {
    unit_str(s) && s.strip_prefix("EC").or_else(|| s.strip_prefix('P')).is_some_and(|d| d == "0" || !d.starts_with('0'))
}

// ---- value checks -------------------------------------------------------------------------------------------------------------------
fn int_in(v: &Value, lo: i64, hi: i64) -> bool {
    v.as_i64().is_some_and(|x| (lo..=hi).contains(&x))
}

fn str_is(v: &Value, f: fn(&str) -> bool) -> bool {
    v.as_str().is_some_and(f)
}

fn keys_within(a: &Args, allowed: &[&str]) -> bool {
    a.keys().all(|k| allowed.contains(&k.as_str()))
}

fn keys_exactly(a: &Args, wanted: &[&str]) -> bool {
    a.len() == wanted.len() && wanted.iter().all(|k| a.contains_key(*k))
}

fn intent_ok(v: &Value) -> bool {
    v.is_object() && serde_json::to_string(v).is_ok_and(|s| s.len() <= MAX_INTENT_BYTES)
}

fn unit_list(v: &Value) -> bool {
    let Some(list) = v.as_array() else { return false };
    if list.is_empty() || list.len() > MAX_UNITS {
        return false;
    }
    let mut seen: Vec<&str> = Vec::with_capacity(list.len());
    for item in list {
        match item.as_str() {
            Some(s) if unit_str(s) && !seen.contains(&s) => seen.push(s),
            _ => return false,
        }
    }
    true
}

fn name_ok(v: &Value) -> bool {
    // server.py `_name`: 1..64 characters once stripped, printable. Python's isprintable() is approximated: no control character and no
    // whitespace other than the plain space (the helper is the authority).
    let Some(s) = v.as_str() else { return false };
    (1..=64).contains(&s.trim().chars().count()) && s.chars().all(|c| !c.is_control() && (c == ' ' || !c.is_whitespace()))
}

// ---- per-op argument validators (server.py names in comments) -----------------------------------------------------------------------
fn throttle_tail(a: &Args) -> bool {
    keys_within(a, &["n"]) && a.get("n").map_or(true, |n| int_in(n, 1, 200))
}

/// ops.py `_validate_audit_tail`: `n` 1..200 and `before` (the previous answer's `start`, a byte offset 0..2^53; null = the newest page).
fn audit_tail(a: &Args) -> bool {
    keys_within(a, &["n", "before"])
        && a.get("n").map_or(true, |n| int_in(n, 1, 200))
        && a.get("before").map_or(true, |b| b.is_null() || int_in(b, 0, 1 << 53))
}

fn vf_dump(a: &Args) -> bool {
    if !keys_within(a, &["cpus", "all_e"]) || a.get("all_e").is_some_and(|v| !v.is_boolean()) {
        return false;
    }
    match a.get("cpus") {
        None | Some(Value::Null) => true,
        Some(Value::Array(c)) => (1..=64).contains(&c.len()) && c.iter().all(|x| int_in(x, 0, 1023)),
        Some(_) => false,
    }
}

fn telemetry_start(a: &Args) -> bool {
    keys_within(a, &["interval_s"])
        && a.get("interval_s").map_or(true, |v| v.is_number() && v.as_f64().is_some_and(|f| (0.2..=60.0).contains(&f)))
}

fn cancel(a: &Args) -> bool {
    keys_within(a, &["op_id"]) && a.get("op_id").map_or(true, |v| str_is(v, req_id))
}

/// ops.py `_validate_preflight`: `{}` or `{client: {name?, version?, protocol?}}` (name / version 1..64 printable characters, protocol 0..1000000).
fn preflight(a: &Args) -> bool {
    if a.is_empty() {
        return true;
    }
    let Some(c) = a.get("client").and_then(Value::as_object).filter(|_| keys_exactly(a, &["client"])) else { return false };
    let text = |v: &Value| v.as_str().is_some_and(|s| (1..=CLIENT_TEXT_MAX).contains(&s.chars().count()) && !s.chars().any(char::is_control));
    keys_within(c, &["name", "version", "protocol"])
        && c.get("name").map_or(true, |v| v.is_null() || text(v))
        && c.get("version").map_or(true, |v| v.is_null() || text(v))
        && c.get("protocol").map_or(true, |v| v.is_null() || v.as_u64().is_some_and(|p| p <= PROTOCOL_MAX))
}

/// `*.apply` on the wire: `{plan_id, typed[, intent]}` (ops_tune.py `validate_apply_args`), the intent in the shape of `kind`'s plan request.
fn apply_with(a: &Args, kind: PlanKind) -> bool {
    match a.get("intent") {
        None => apply(a),
        Some(i) => {
            let mut rest = a.clone();
            rest.remove("intent");
            apply(&rest) && apply_intent_ok(kind, i)
        }
    }
}

/// `{plan_id, typed}` exactly (also the step 2 of an accept, which ops_accept.py validates without an intent).
fn apply(a: &Args) -> bool {
    keys_exactly(a, &["plan_id", "typed"]) && str_is(&a["plan_id"], hex64) && str_is(&a["typed"], typed)
}

fn tune_plan(a: &Args) -> bool {
    keys_exactly(a, &["intent"]) && tune_intent(&a["intent"], false)
}

/// A number of millivolts (its range and whole-ness are the helper's to judge: its refusal names the field, `offset.mv[53] -1001 mV is outside ...`).
fn mv_number(v: &Value) -> bool {
    v.is_number()
}

/// A short decimal key (`"53"`, `"3"`): a ratio of `offset.mv`, a ring point number.
fn digits(k: &str, max: usize) -> bool {
    all_chars(k, 1, max, |c| c.is_ascii_digit())
}

/// The shape of one row of ops_tune.py `_canonical_row`: known keys, a target, `offset` null | `{kind: "curve", mv}` | `{kind: "points", mv: {ratio: mV}}`
/// (1..12), `v_target_v` null | a number, `ratio` null | an integer. Value ranges and cross-row rules (a target twice: CURVE_AND_POINTS) are the
/// helper's: it names the field, and the page lands the refusal on it.
fn tune_row(v: &Value, simple: bool) -> bool {
    let Some(r) = v.as_object().filter(|r| keys_within(r, &["target", "offset", "v_target_v", "ratio"])) else { return false };
    let target_ok = r.get("target").and_then(Value::as_str).is_some_and(|t| if simple { matches!(t, "P" | "E") } else { unit_id(t) });
    let offset_ok = match r.get("offset") {
        None | Some(Value::Null) => true,
        Some(Value::Object(o)) if keys_exactly(o, &["kind", "mv"]) => match (o["kind"].as_str(), &o["mv"]) {
            (Some("curve"), mv) => mv_number(mv),
            (Some("points"), Value::Object(pts)) => (1..=MAX_ROW_POINTS).contains(&pts.len()) && pts.iter().all(|(k, mv)| digits(k, 3) && mv_number(mv)),
            _ => false,
        },
        Some(_) => false,
    };
    let vt_ok = r.get("v_target_v").map_or(true, |x| x.is_null() || x.is_number());
    let ratio_ok = r.get("ratio").map_or(true, |x| x.is_null() || x.is_i64() || x.is_u64());
    target_ok && offset_ok && vt_ok && ratio_ok
}

/// The shape of ops_tune.py `_canonical_turbo`: `{P?, E?}` (not empty), each 8 integers (the ratio range is the helper's to judge).
fn turbo_tables(v: &Value) -> bool {
    v.as_object().is_some_and(|t| {
        !t.is_empty() && keys_within(t, &["P", "E"]) && t.values().all(|table| table.as_array().is_some_and(|b| b.len() == 8 && b.iter().all(|r| r.is_i64() || r.is_u64())))
    })
}

/// The shape of ops_tune.py `_canonical_ring`: `{points: {"<P2>": mV}}`, 1..15 points keyed by 1-2 digits.
fn ring_points(v: &Value) -> bool {
    let Some(pts) = v.as_object().filter(|r| keys_exactly(r, &["points"])).and_then(|r| r["points"].as_object()) else { return false };
    (1..=MAX_RING_POINTS).contains(&pts.len()) && pts.iter().all(|(k, mv)| digits(k, 2) && mv_number(mv))
}

/// The shape of an ops_tune.py `canonical_intent`: the editor's edits `{scope, rows[, turbo][, ring]}` / `{turbo}` / `{ring}` (scope and rows come
/// together; scope "unit" | "simple"; at most 32 rows), or — unless `edits_only` (profiles.save) — a whole-state intent `{profile}`, `{reset: "stock"}`,
/// `{restore: "accepted"}`. At most [`MAX_INTENT_BYTES`]. Known keys, types and sizes only: the helper judges the values and names the field it refuses.
pub fn tune_intent(v: &Value, edits_only: bool) -> bool {
    let Some(o) = v.as_object().filter(|_| intent_ok(v)) else { return false };
    let has = |k: &str| o.contains_key(k);
    if keys_within(o, &["scope", "rows", "turbo", "ring"]) && (has("rows") || has("turbo") || has("ring")) && has("rows") == has("scope") {
        if o.get("turbo").is_some_and(|t| !turbo_tables(t)) || o.get("ring").is_some_and(|r| !ring_points(r)) {
            return false;
        }
        let Some(rows) = o.get("rows") else { return true };
        let simple = match o["scope"].as_str() {
            Some("simple") => true,
            Some("unit") => false,
            _ => return false,
        };
        return rows.as_array().is_some_and(|l| l.len() <= MAX_ROWS && l.iter().all(|row| tune_row(row, simple)));
    }
    if edits_only || o.len() != 1 {
        return false;
    }
    match o.iter().next() {
        Some((k, v)) if k == "profile" => str_is(v, profile_name),
        Some((k, v)) if k == "reset" => v.as_str() == Some("stock"),
        Some((k, v)) if k == "restore" => v.as_str() == Some("accepted"),
        _ => false,
    }
}

/// ops_tune.py `_validate_profiles_save`: `{name, from: "read"}` (the last read as it is), or `{name}` with at least one of `intent` (the editor's
/// edits `{scope, rows[, turbo][, ring]}`, never a whole-state intent), `power` (`{pl1_w?, pl2_w?, tau_s?}` or null) and `runtime` (`{caps?, uncore?}`
/// or null).
fn profiles_save(a: &Args) -> bool {
    if !keys_within(a, &["name", "intent", "from", "power", "runtime"]) || !a.get("name").is_some_and(|v| str_is(v, profile_name)) {
        return false;
    }
    if a.contains_key("from") {
        return keys_exactly(a, &["name", "from"]) && a["from"].as_str() == Some("read");
    }
    if a.len() < 2 {
        return false; // nothing but the name: no edits and no `from`
    }
    a.get("intent").map_or(true, |i| tune_intent(i, true))
        && a.get("power").map_or(true, |p| p.is_null() || p.as_object().is_some_and(power_values))
        && a.get("runtime").map_or(true, |r| r.is_null() || r.as_object().is_some_and(|m| keys_within(m, &["caps", "uncore"]) && runtime_plan(m)))
}

fn profiles_accept(a: &Args) -> bool {
    // R-B1 / D-053 item 4: step 2 confirms what step 1 answered, like an apply (the shell sends it after the operator's OK)
    if a.contains_key("plan_id") || a.contains_key("typed") {
        return apply(a);
    }
    // G-228: the optional `set_aside_unreadable: true` moves an unreadable accepted directory aside (the helper keeps it whole), only when the operator chose that
    let aside_ok = a.get("set_aside_unreadable").map_or(true, |v| v.as_bool() == Some(true));
    let mut rest = a.clone();
    rest.remove("set_aside_unreadable");
    aside_ok && ((keys_exactly(&rest, &["name"]) && str_is(&rest["name"], safe_profile_name)) || (keys_exactly(&rest, &["from"]) && rest["from"].as_str() == Some("read")))
}

fn profiles_diff(a: &Args) -> bool {
    // G-228: {a, b}, each "accepted", "read" or a saved profile name (the last two are also valid names)
    keys_exactly(a, &["a", "b"]) && str_is(&a["a"], profile_name) && str_is(&a["b"], profile_name)
}

fn profiles_get(a: &Args) -> bool {
    keys_exactly(a, &["name"]) && str_is(&a["name"], profile_name)
}

fn vf_measure(a: &Args) -> bool {
    keys_within(a, &["mode", "units", "name", "baseline"])
        && a.get("mode").map_or(true, |m| matches!(m.as_str(), Some("quick" | "dense")))
        && a.get("baseline").map_or(true, Value::is_boolean)
        && a.get("units").map_or(true, unit_list)
        && a.get("name").map_or(true, name_ok)
}

fn stress_start(a: &Args) -> bool {
    if !keys_within(a, &["kind", "method", "units", "ratio_cap", "duration_s", "memory_mb"])
        || !matches!(a.get("kind").and_then(Value::as_str), Some("cpu" | "memory"))
    {
        return false;
    }
    a.get("duration_s").is_some_and(|d| int_in(d, 30, 3600))
        && a.get("method").map_or(true, |m| matches!(m.as_str(), Some("integer" | "vector-math" | "cache")))
        && a.get("units").map_or(true, unit_list)
        && a.get("ratio_cap").map_or(true, |c| c.is_null() || int_in(c, 8, 60))
        && a.get("memory_mb").map_or(true, |m| int_in(m, 256, 1 << 20))
}

/// ops_power.py `_validate_power_plan`: exactly one of `power` ({pl1_w?, pl2_w?, tau_s?}: numbers, at least one set), `revert: true`, `profile`
/// (a saved profile's `[power]`) or `restore: "accepted"` (R-B1, D-053 item 7).
fn power_plan(a: &Args) -> bool {
    if a.len() != 1 {
        return false;
    }
    match a.iter().next() {
        Some((k, v)) if k == "revert" => v == &Value::Bool(true),
        Some((k, v)) if k == "profile" => str_is(v, profile_name),
        Some((k, v)) if k == "restore" => v.as_str() == Some("accepted"),
        Some((k, v)) if k == "power" => v.as_object().is_some_and(power_values),
        _ => false,
    }
}

/// `{pl1_w?, pl2_w?, tau_s?}`: numbers or null, at least one number.
fn power_values(p: &Args) -> bool {
    keys_within(p, &["pl1_w", "pl2_w", "tau_s"]) && p.values().all(|v| v.is_null() || v.is_number()) && p.values().any(Value::is_number)
}

fn ratio(v: &Value) -> bool {
    int_in(v, 1, 255)
}

fn cpu_key(k: &str) -> bool {
    all_chars(k, 1, 4, |c| c.is_ascii_digit()) && k.parse::<usize>().is_ok_and(|n| n < CPU_MAX)
}

/// ops_runtime.py `_validate_runtime_plan`: `{revert: true}`, `{profile}` or `{restore: "accepted"}` alone (R-B1, D-053 item 7), or `caps`
/// ({"cpu": ratio}) and/or `uncore` ({min_ratio?, max_ratio?}) with at least one value set. Parking is not supported (D-048): any other key is refused.
fn runtime_plan(a: &Args) -> bool {
    if !keys_within(a, &["caps", "uncore", "revert", "profile", "restore"]) {
        return false;
    }
    if let Some(r) = a.get("revert") {
        return a.len() == 1 && r == &Value::Bool(true);
    }
    if let Some(p) = a.get("profile") {
        return a.len() == 1 && str_is(p, profile_name);
    }
    if let Some(r) = a.get("restore") {
        return a.len() == 1 && r.as_str() == Some("accepted");
    }
    let caps = match a.get("caps") {
        None | Some(Value::Null) => false,
        Some(Value::Object(c)) if !c.is_empty() && c.len() <= CPU_MAX && c.iter().all(|(k, v)| cpu_key(k) && ratio(v)) => true,
        Some(_) => return false,
    };
    let uncore = match a.get("uncore") {
        None | Some(Value::Null) => false,
        Some(Value::Object(u)) if keys_within(u, &["min_ratio", "max_ratio"]) && u.values().all(|v| v.is_null() || ratio(v)) => {
            u.values().any(|v| !v.is_null())
        }
        Some(_) => return false,
    };
    caps || uncore
}

fn curves_get(a: &Args) -> bool {
    keys_within(a, &["id", "units"]) && a.get("id").is_some_and(|v| str_is(v, curve_id_str)) && a.get("units").map_or(true, unit_list)
}

fn curves_update(a: &Args) -> bool {
    keys_within(a, &["id", "name", "baseline"])
        && a.get("id").is_some_and(|v| str_is(v, curve_id_str))
        && (a.contains_key("name") || a.contains_key("baseline"))
        && a.get("name").map_or(true, name_ok)
        && a.get("baseline").map_or(true, Value::is_boolean)
}

fn curves_delete(a: &Args) -> bool {
    keys_exactly(a, &["id"]) && str_is(&a["id"], curve_id_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_listed_op_is_known_to_check() {
        for op in ALLOWED_OPS {
            // an op with args that are surely wrong is BAD_REQUEST (known op), never UNKNOWN_OP; {} may be fine.
            let e = check(op, &json!({"zzz": 1}));
            assert!(e.as_ref().err().map_or(true, |r| r.code == "BAD_REQUEST"), "{op}: {e:?}");
        }
        assert_eq!(check("rm -rf", &json!({})).unwrap_err().code, "UNKNOWN_OP");
        assert_eq!(ALLOWED_OPS.len(), 32);
    }

    fn ok(op: &str, args: Value) -> bool {
        check(op, &args).is_ok()
    }

    #[test]
    fn throttle_tail_shapes() {
        assert!(ok("throttle.tail", json!({})) && ok("throttle.tail", json!({"n": 20})) && ok("throttle.tail", json!({"n": 200})));
        assert!(!ok("throttle.tail", json!({"n": 0})) && !ok("throttle.tail", json!({"n": 201})) && !ok("throttle.tail", json!({"x": 1})));
        assert!(!check("throttle.tail", &json!({})).unwrap().long);
    }

    #[test]
    fn audit_tail_shapes() {
        assert!(ok("audit.tail", json!({})) && ok("audit.tail", json!({"n": 200})) && ok("audit.tail", json!({"n": 50, "before": 0})));
        assert!(ok("audit.tail", json!({"before": 123_456})) && ok("audit.tail", json!({"before": null})) && ok("audit.tail", json!({"before": 1u64 << 53})));
        for bad in [json!({"before": -1}), json!({"before": (1u64 << 53) + 1}), json!({"before": 1.5}), json!({"before": "5"}), json!({"before": true}), json!({"after": 1}), json!({"n": 0, "before": 1})] {
            assert!(!ok("audit.tail", bad.clone()), "{bad}");
        }
        assert!(!ok("throttle.tail", json!({"before": 5})), "throttle.tail has no paging");
    }

    #[test]
    fn power_shapes() {
        assert!(ok("power.read", json!({})) && check("power.read", &json!({})).unwrap().long);
        assert!(!ok("power.read", json!({"x": 1})));
        assert!(ok("power.plan", json!({"power": {"pl1_w": 250, "pl2_w": 295.5, "tau_s": 28}})));
        assert!(ok("power.plan", json!({"power": {"pl1_w": 200, "tau_s": null}})));
        assert!(ok("power.plan", json!({"revert": true})));
        assert!(!check("power.plan", &json!({"revert": true})).unwrap().long, "a plan is answered in line so the link can remember its id");
        for bad in [
            json!({}),
            json!({"revert": false}),
            json!({"revert": 1}),
            json!({"revert": true, "power": {"pl1_w": 200}}),
            json!({"power": {}}),
            json!({"power": {"pl1_w": null}}),
            json!({"power": {"pl1_w": "200"}}),
            json!({"power": {"pl1_w": true}}),
            json!({"power": {"pl3_w": 200}}),
            json!({"power": [200]}),
            json!({"power": {"pl1_w": 200}, "extra": 1}),
            json!({"intent": {"power": {"pl1_w": 200}}}),
        ] {
            assert!(!ok("power.plan", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn runtime_shapes() {
        assert!(ok("runtime.read", json!({})) && !ok("runtime.read", json!({"cpus": [0]})));
        assert!(ok("runtime.plan", json!({"caps": {"0": 40, "23": 255}})));
        assert!(ok("runtime.plan", json!({"uncore": {"min_ratio": 8, "max_ratio": 40}})));
        assert!(ok("runtime.plan", json!({"caps": {"1": 30}, "uncore": {"max_ratio": null}})));
        assert!(ok("runtime.plan", json!({"caps": null, "uncore": {"max_ratio": 36}})));
        assert!(ok("runtime.plan", json!({"revert": true})));
        for bad in [
            json!({}),
            json!({"parking": {"3": false}}),
            json!({"caps": {"1": 30}, "parking": {"3": false}}),
            json!({"parking": null, "caps": {"1": 30}}),
            json!({"revert": true, "caps": {"1": 30}}),
            json!({"revert": false}),
            json!({"caps": {}}),
            json!({"caps": null}),
            json!({"caps": [30]}),
            json!({"caps": {"x": 30}}),
            json!({"caps": {"-1": 30}}),
            json!({"caps": {"+1": 30}}),
            json!({"caps": {"1024": 30}}),
            json!({"caps": {"12345": 30}}),
            json!({"caps": {"": 30}}),
            json!({"caps": {"1": 0}}),
            json!({"caps": {"1": 256}}),
            json!({"caps": {"1": 30.5}}),
            json!({"caps": {"1": "30"}}),
            json!({"caps": {"1": null}}),
            json!({"uncore": {}}),
            json!({"uncore": {"min_ratio": null}}),
            json!({"uncore": {"lo": 8}}),
            json!({"uncore": {"min_ratio": 0}}),
            json!({"uncore": 8}),
            json!({"uncore": {"min_khz": 800_000}}),
        ] {
            assert!(!ok("runtime.plan", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn apply_shapes_and_plan_roles() {
        let good = json!({"plan_id": "a".repeat(64), "typed": "CONFIRM ABCDEF"});
        for op in ["tune.apply", "power.apply", "runtime.apply"] {
            assert!(check(op, &good).unwrap().long, "{op}");
            assert!(!ok(op, json!({"plan_id": "a".repeat(64)})), "{op}");
            assert!(!ok(op, json!({"plan_id": "x", "typed": "CONFIRM ABCDEF"})), "{op}");
            let mut extra = good.clone();
            extra["power"] = json!({"pl1_w": 400});
            assert!(!ok(op, extra), "{op}: unknown key");
        }
        assert_eq!(plan_role("power.plan"), Some((PlanKind::Power, false)));
        assert_eq!(plan_role("runtime.apply"), Some((PlanKind::Runtime, true)));
        assert_eq!(plan_role("power.read"), None);
        let idx: Vec<usize> = [PlanKind::Tune, PlanKind::Power, PlanKind::Runtime].iter().map(|k| k.index()).collect();
        assert_eq!(idx, [0, 1, 2]);
        assert_eq!(PlanKind::COUNT, 3);
        assert_eq!(PlanKind::Runtime.apply_op(), "runtime.apply");
    }

    #[test]
    fn the_ops_the_operator_must_confirm_and_their_webview_shapes() {
        let id = "a".repeat(64);
        for op in ["tune.apply", "power.apply", "runtime.apply", "profiles.accept", "profiles.fingerprint"] {
            assert!(needs_operator(op), "{op}");
        }
        for op in ["tune.plan", "profiles.save", "profiles.diff", "curves.delete", "stress.start", "app.confirm"] {
            assert!(!needs_operator(op), "{op}");
        }
        assert_eq!(apply_kind("power.apply"), Some(PlanKind::Power));
        assert_eq!(apply_kind("profiles.accept"), None);
        assert_eq!(webview_apply_args(PlanKind::Tune, &json!({"plan_id": id})).unwrap(), (id.clone(), None));
        let typed = webview_apply_args(PlanKind::Tune, &json!({"plan_id": id, "typed": "CONFIRM ABCDEF"})).unwrap_err();
        assert!(typed.message.contains("never sends a confirmation code"), "{}", typed.message);
        for bad in [json!({}), json!({"plan_id": "x"}), json!({"plan_id": id, "extra": 1}), json!([id]), json!({"intent": {"restore": "accepted"}})] {
            assert!(webview_apply_args(PlanKind::Tune, &bad).is_err(), "{bad}");
        }
        // R-B1 (R-26): the editor's intent rides along, checked with the plan op's own validator
        let rows = json!({"scope": "unit", "rows": [{"target": "P0", "offset": {"kind": "points", "mv": {"53": -20}}, "v_target_v": null, "ratio": null}]});
        assert_eq!(webview_apply_args(PlanKind::Tune, &json!({"plan_id": id, "intent": rows})).unwrap().1, Some(rows.clone()));
        assert!(webview_apply_args(PlanKind::Power, &json!({"plan_id": id, "intent": {"power": {"pl1_w": 200}}})).is_ok());
        assert!(webview_apply_args(PlanKind::Runtime, &json!({"plan_id": id, "intent": {"restore": "accepted"}})).is_ok());
        for (kind, bad) in [
            (PlanKind::Tune, json!({"power": {"pl1_w": 200}})),
            (PlanKind::Tune, json!({"intent": rows})),
            (PlanKind::Tune, json!({})),
            (PlanKind::Power, rows.clone()),
            (PlanKind::Power, json!({"power": {}})),
            (PlanKind::Runtime, json!({"power": {"pl1_w": 200}})),
            (PlanKind::Runtime, json!({"parking": {"3": false}})),
            (PlanKind::Power, json!(null)),
        ] {
            let e = webview_apply_args(kind, &json!({"plan_id": id, "intent": bad})).unwrap_err();
            assert!(e.message.contains("intent of"), "{kind:?} {bad}: {}", e.message);
        }
        // persistent ops: step 1 of an accept and an empty fingerprint request; never the confirmation step
        for good in [json!({"name": "mine"}), json!({"from": "read"}), json!({"from": "read", "set_aside_unreadable": true})] {
            assert!(webview_persist_args("profiles.accept", &good).is_ok(), "{good}");
        }
        for bad in [json!({"plan_id": id}), json!({"plan_id": id, "typed": "CONFIRM ABCDEF"}), json!({"typed": "CONFIRM ABCDEF", "name": "x"}), json!({}), json!({"name": "UPPER"})] {
            assert!(webview_persist_args("profiles.accept", &bad).is_err(), "{bad}");
        }
        assert!(webview_persist_args("profiles.fingerprint", &json!({})).is_ok());
        assert!(webview_persist_args("profiles.fingerprint", &json!({"x": 1})).is_err());
        // on the wire (sent by the shell): both steps of an accept
        assert!(ok("profiles.accept", json!({"plan_id": id, "typed": "CONFIRM ABCDEF"})), "step 2 on the wire");
        assert!(!ok("profiles.accept", json!({"plan_id": id})), "never without the code on the wire");
        assert!(!ok("profiles.accept", json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "name": "x"})));
        assert!(nonce_ok("37IRHH") && !nonce_ok("37IRH1") && !nonce_ok("37irhh") && !nonce_ok("37IRHHX"));
    }

    #[test]
    fn app_confirm_shapes() {
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let got = confirm_args(&json!({"plans": [{"op": "tune.apply", "plan_id": a}, {"op": "power.apply", "plan_id": b}]})).unwrap();
        assert_eq!(got, vec![(PlanKind::Tune, a.clone()), (PlanKind::Power, b.clone())]);
        let five: Vec<Value> = (0..5).map(|i| json!({"op": "tune.apply", "plan_id": format!("{i}").repeat(64)})).collect();
        for bad in [
            json!({}),
            json!({"plans": []}),
            json!({"plans": five}),
            json!({"plans": [{"op": "tune.plan", "plan_id": a}]}),
            json!({"plans": [{"op": "profiles.accept", "plan_id": a}]}),
            json!({"plans": [{"op": "stress.start", "plan_id": a}]}),
            json!({"plans": [{"op": "tune.apply", "plan_id": "x"}]}),
            json!({"plans": [{"op": "tune.apply", "plan_id": a, "typed": "CONFIRM ABCDEF"}]}),
            json!({"plans": [{"op": "tune.apply", "plan_id": a}, {"op": "power.apply", "plan_id": a}]}),
            json!({"plans": [{"op": "tune.apply", "plan_id": a}], "extra": 1}),
        ] {
            assert!(confirm_args(&bad).is_err(), "{bad}");
        }
        assert!(!ALLOWED_OPS.contains(&"app.confirm") && SHELL_OPS.contains(&"app.confirm"), "a shell op never reaches the socket");
        assert_eq!(check("app.confirm", &json!({"plans": []})).unwrap_err().code, "UNKNOWN_OP", "the link refuses it: only HelperState answers it");
    }

    #[test]
    fn profiles_save_shapes() {
        let none = json!({"scope": "unit", "rows": []}); // the Profiles screen's "no edits": the read as it is
        let row = json!({"scope": "unit", "rows": [{"target": "EC1", "offset": {"kind": "curve", "mv": -30}, "v_target_v": null, "ratio": null}]});
        for good in [
            json!({"name": "mine", "intent": none}),
            json!({"name": "mine", "intent": row}),
            json!({"name": "mine", "intent": {"turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 55]}}}),
            json!({"name": "mine", "from": "read"}),
            json!({"name": "mine", "power": {"pl1_w": 200, "tau_s": null}}),
            json!({"name": "mine", "runtime": {"caps": {"0": 50}, "uncore": {"max_ratio": 38}}}),
            json!({"name": "mine", "intent": none, "power": null, "runtime": null}),
            json!({"name": "mine", "intent": row, "power": {"pl2_w": 250}, "runtime": {"uncore": {"min_ratio": 8}}}),
        ] {
            assert!(ok("profiles.save", good.clone()), "{good}");
        }
        for bad in [
            json!({"name": "mine"}),
            json!({"name": "mine", "from": "elsewhere"}),
            json!({"name": "mine", "from": 1}),
            json!({"name": "mine", "from": "read", "intent": none}),
            json!({"name": "mine", "from": "read", "power": {"pl1_w": 200}}),
            json!({"name": "mine", "from": "read", "extra": 1}),
            json!({"name": "UPPER", "from": "read"}),
            json!({"from": "read"}),
            json!({"name": "mine", "intent": []}),
            json!({"name": "mine", "intent": {}}),
            json!({"name": "mine", "intent": null}),
            json!({"name": "mine", "intent": {"profile": "other"}}),
            json!({"name": "mine", "intent": {"restore": "accepted"}}),
            json!({"name": "mine", "power": {}}),
            json!({"name": "mine", "power": {"pl1_w": null}}),
            json!({"name": "mine", "power": {"pl4_w": 300}}),
            json!({"name": "mine", "power": 200}),
            json!({"name": "mine", "runtime": {"revert": true}}),
            json!({"name": "mine", "runtime": {"profile": "other"}}),
            json!({"name": "mine", "runtime": {"parking": {"3": false}}}),
            json!({"name": "mine", "runtime": {"caps": {"0": 0}}}),
            json!({"name": "mine", "runtime": {}}),
            json!({"name": "mine", "extra": 1, "intent": none}),
        ] {
            assert!(!ok("profiles.save", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn tune_intents_are_checked_for_keys_types_and_sizes() {
        let row = |r: Value| json!({"scope": "unit", "rows": [r]});
        let point = json!({"target": "P0", "offset": {"kind": "points", "mv": {"53": -20, "48": -15}}, "v_target_v": null, "ratio": null});
        for good in [
            row(point.clone()),
            row(json!({"target": "EC3", "offset": {"kind": "curve", "mv": -30.0}, "v_target_v": null, "ratio": null})),
            row(json!({"target": "P2", "offset": null, "v_target_v": 1.25, "ratio": 58})),
            row(json!({"target": "P2", "ratio": 58})),
            row(json!({"target": "P1", "offset": null, "v_target_v": null, "ratio": null})), // dropped by the helper
            json!({"scope": "simple", "rows": [{"target": "E", "offset": {"kind": "curve", "mv": -10}}]}),
            json!({"scope": "unit", "rows": [point.clone()], "turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 55]}, "ring": {"points": {"3": -10}}}),
            json!({"turbo": {"E": [47, 47, 47, 47, 47, 47, 47, 47]}}),
            json!({"ring": {"points": {"1": -5, "15": 0}}}),
            json!({"profile": "good-p57"}),
            json!({"reset": "stock"}),
            json!({"restore": "accepted"}),
            // values the helper refuses with the field named (golden offset-below-field, R09-curve-and-points, turbo-P-rise-refused): its message reaches the page
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": {"53": -1001}}})),
            row(json!({"target": "P0", "offset": {"kind": "curve", "mv": -20.5}})),
            row(json!({"target": "P0", "v_target_v": 4.2, "ratio": 300})),
            json!({"scope": "unit", "rows": [{"target": "P0", "ratio": 58}, {"target": "P0", "offset": {"kind": "curve", "mv": -5}}]}),
            json!({"turbo": {"P": [57, 57, 55, 55, 55, 56, 55, 55]}}),
            json!({"ring": {"points": {"0": -5}}}),
        ] {
            assert!(tune_intent(&good, false), "{good}");
            assert!(ok("tune.plan", json!({"intent": good})), "{good}");
        }
        let many_rows: Vec<Value> = (0..33).map(|n| json!({"target": format!("P{n}"), "ratio": 50})).collect();
        let many_points: Value = (40..53).map(|r| (r.to_string(), json!(-5))).collect::<Map<String, Value>>().into();
        let many_ring: Value = (1..17).map(|r| (r.to_string(), json!(-5))).collect::<Map<String, Value>>().into();
        for bad in [
            json!({}),
            json!([]),
            json!({"rows": []}),
            json!({"scope": "unit"}),
            json!({"scope": "all", "rows": []}),
            json!({"scope": "unit", "rows": {}}),
            json!({"scope": "unit", "rows": many_rows}),
            row(json!({"target": "P0", "extra": 1})),
            row(json!({"ratio": 50})),
            row(json!({"target": "P01", "ratio": 50})),
            row(json!({"target": "P1234", "ratio": 50})),
            row(json!({"target": "E", "ratio": 50})),
            json!({"scope": "simple", "rows": [{"target": "P0", "ratio": 50}]}),
            row(json!({"target": "P0", "offset": {"kind": "curve", "mv": "-20"}})),
            row(json!({"target": "P0", "offset": {"kind": "curve", "mv": true}})),
            row(json!({"target": "P0", "offset": {"kind": "curve"}})),
            row(json!({"target": "P0", "offset": {"kind": "both", "mv": -20}})),
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": {}}})),
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": many_points}})),
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": {"x": -5}}})),
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": {"1234": -5}}})),
            row(json!({"target": "P0", "offset": {"kind": "points", "mv": [-5]}})),
            row(json!({"target": "P0", "offset": -20})),
            row(json!({"target": "P0", "v_target_v": "1.2"})),
            row(json!({"target": "P0", "ratio": 50.5})),
            row(json!({"target": "P0", "ratio": "50"})),
            json!({"turbo": {}}),
            json!({"turbo": {"P": [57, 57, 55]}}),
            json!({"turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 55.5]}}),
            json!({"turbo": {"X": [57, 57, 55, 55, 55, 55, 55, 55]}}),
            json!({"ring": {"points": {}}}),
            json!({"ring": {"points": many_ring}}),
            json!({"ring": {"points": {"100": -5}}}),
            json!({"ring": {"points": {"1": "-5"}}}),
            json!({"ring": {"points": {"1": -5}, "oc": 1}}),
            json!({"profile": "UPPER"}),
            json!({"profile": "x", "reset": "stock"}),
            json!({"reset": "all"}),
            json!({"restore": "boot"}),
            json!({"profile": "x", "turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 55]}}),
        ] {
            assert!(!tune_intent(&bad, false), "{bad}");
            assert!(!ok("tune.plan", json!({"intent": bad})), "{bad}");
        }
        let big = json!({"profile": "x".repeat(MAX_INTENT_BYTES)});
        assert!(!tune_intent(&big, false));
        assert!(!tune_intent(&json!({"profile": "mine"}), true), "profiles.save takes edits only");
    }
    #[test]
    fn preflight_carries_the_client_block_only() {
        assert!(ok("preflight", json!({})));
        assert!(ok("preflight", json!({"client": {"name": "linux-xtu-desktop", "version": "0.2.0-dev", "protocol": 1}})));
        assert!(ok("preflight", json!({"client": {"protocol": 0}})));
        for bad in [
            json!({"client": null}),
            json!({"client": "x"}),
            json!({"client": {"name": ""}}),
            json!({"client": {"name": "x".repeat(65)}}),
            json!({"client": {"name": "a\nb"}}),
            json!({"client": {"protocol": -1}}),
            json!({"client": {"protocol": 1.5}}),
            json!({"client": {"protocol": 1_000_001}}),
            json!({"client": {"uid": 0}}),
            json!({"client": {}, "x": 1}),
        ] {
            assert!(!ok("preflight", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn plans_of_a_profile_or_the_accepted_state() {
        for op in ["power.plan", "runtime.plan"] {
            assert!(ok(op, json!({"profile": "good-p57"})), "{op}");
            assert!(ok(op, json!({"restore": "accepted"})), "{op}");
            for bad in [json!({"profile": "UPPER"}), json!({"profile": 1}), json!({"restore": "boot"}), json!({"restore": "accepted", "revert": true}), json!({"profile": "x", "restore": "accepted"})] {
                assert!(!ok(op, bad.clone()), "{op} {bad}");
            }
        }
        assert!(!ok("power.plan", json!({"profile": "x", "power": {"pl1_w": 200}})));
        assert!(!ok("runtime.plan", json!({"profile": "x", "caps": {"0": 50}})));
    }

    #[test]
    fn applies_on_the_wire_carry_the_intent_in_the_plan_shape() {
        let id = "a".repeat(64);
        let base = |intent: Value| json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "intent": intent});
        assert!(ok("tune.apply", base(json!({"restore": "accepted"}))));
        assert!(ok("power.apply", base(json!({"revert": true}))));
        assert!(ok("runtime.apply", base(json!({"caps": {"8": 40}}))));
        assert!(!ok("tune.apply", base(json!({"revert": true}))));
        assert!(!ok("power.apply", base(json!({"restore": "accepted", "power": {"pl1_w": 200}}))));
        assert!(!ok("runtime.apply", base(json!({"intent": {"caps": {"8": 40}}}))));
        assert!(!ok("tune.apply", json!({"plan_id": id, "intent": {"restore": "accepted"}})), "never without the code on the wire");
        assert!(!ok("profiles.accept", base(json!({"restore": "accepted"}))), "an accept's step 2 has no intent");
    }

    #[test]
    fn an_accept_names_a_safe_profile() {
        for good in ["good-p57", "a", "0.x", "_x", "a.b-c_d"] {
            assert!(ok("profiles.accept", json!({"name": good})), "{good}");
        }
        for bad in [".hidden", "-x", "a..b", "..", "UPPER", ""] {
            assert!(!ok("profiles.accept", json!({"name": bad})), "{bad}");
        }
        assert!(ok("profiles.get", json!({"name": ".hidden"})), "other ops keep the store's own name rule");
    }

    #[test]
    fn profiles_accept_shapes() {
        assert!(ok("profiles.accept", json!({"name": "mine"})));
        assert!(ok("profiles.accept", json!({"from": "read"})));
        assert!(ok("profiles.accept", json!({"from": "read", "set_aside_unreadable": true})));
        assert!(ok("profiles.accept", json!({"name": "mine", "set_aside_unreadable": true})));
        for bad in [
            json!({}),
            json!({"set_aside_unreadable": true}),
            json!({"from": "read", "set_aside_unreadable": false}),
            json!({"from": "read", "set_aside_unreadable": "yes"}),
            json!({"from": "read", "set_aside_unreadable": 1}),
            json!({"from": "read", "set_aside_unreadable": null}),
            json!({"from": "elsewhere"}),
            json!({"name": "mine", "from": "read"}),
            json!({"from": "read", "extra": true}),
            json!({"name": "UPPER"}),
        ] {
            assert!(!ok("profiles.accept", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn profiles_diff_shapes() {
        assert!(ok("profiles.diff", json!({"a": "accepted", "b": "read"})));
        assert!(ok("profiles.diff", json!({"a": "mine", "b": "read"})));
        assert!(ok("profiles.diff", json!({"a": "accepted", "b": "mine"})));
        assert!(!check("profiles.diff", &json!({"a": "accepted", "b": "read"})).unwrap().long);
        for bad in [
            json!({}),
            json!({"a": "accepted"}),
            json!({"b": "read"}),
            json!({"a": "accepted", "b": "read", "c": "x"}),
            json!({"a": "UPPER", "b": "read"}),
            json!({"a": "accepted", "b": 1}),
            json!({"a": null, "b": "read"}),
            json!({"a": "accepted", "b": ""}),
            json!({"a": "../x", "b": "read"}),
        ] {
            assert!(!ok("profiles.diff", bad.clone()), "{bad}");
        }
    }

    #[test]
    fn matchers() {
        assert!(curve_id_str("20261018T101500Z-a1b2"));
        assert!(!curve_id_str("20261018T101500Z-A1b2"));
        assert!(!curve_id_str("20261018T101500Z-a1b2x"));
        assert!(unit_str("P0") && unit_str("EC3") && unit_str("P123"));
        assert!(!unit_str("P") && !unit_str("P1234") && !unit_str("E3") && !unit_str("EC") && !unit_str("p1") && !unit_str("P+1"));
        assert!(typed("CONFIRM AB2345") && !typed("CONFIRM AB1345") && !typed("CONFIRM AB234") && !typed("confirm AB2345"));
    }
}
