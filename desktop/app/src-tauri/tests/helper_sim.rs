//! Integration: the link against the Python simulator helper (`tools/linux-xtu-helper.py --sim --socket`) on a temp socket.
//! Simulator only: every path (socket, audit log, lock, state dir, helper.toml) is a temp path; nothing touches /run/linux-xtu or hardware.
//! Needs `python3` and `--features dev-socket`.
#![cfg(feature = "dev-socket")]

#[path = "fixtures/common.rs"]
mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use linux_xtu_desktop_lib::helper::connect::{SysProbe, Target};
use linux_xtu_desktop_lib::helper::{Connect, HelperState};
use common::*;
use serde_json::{json, Value};

struct Sim {
    child: Child,
    sock: PathBuf,
    _dir: TempDir,
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn user_name() -> String {
    let out = Command::new("id").arg("-un").output().expect("id -un");
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn spawn_sim(admitted_user: &str) -> Sim {
    spawn_sim_with(admitted_user, &[])
}

/// The simulator with extra arguments (`--policy <the shipped policy>` for the tune ops: the built-in default denies the point reads).
fn spawn_sim_with(admitted_user: &str, extra: &[&std::ffi::OsStr]) -> Sim {
    let dir = TempDir::new("sim");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let toml = dir.0.join("helper.toml");
    std::fs::write(&toml, format!("[access]\nusers = [\"{admitted_user}\"]\n")).unwrap();
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o600)).unwrap();
    let sock = dir.0.join("h.sock");
    let state = dir.0.join("state");
    std::fs::create_dir(&state).unwrap();
    let child = Command::new("python3")
        .arg(root.join("tools/linux-xtu-helper.py"))
        .args(["--sim", "--socket", "--socket-path"])
        .arg(&sock)
        .args(extra)
        .arg("--audit")
        .arg(dir.0.join("audit.jsonl"))
        .arg("--lock")
        .arg(dir.0.join("lock"))
        .arg("--state-dir")
        .arg(&state)
        .arg("--helper-toml")
        .arg(&toml)
        .current_dir(&dir.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("python3 starts the simulator");
    let mut sim = Sim { child, sock, _dir: dir };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !sim.sock.exists() {
        if let Some(status) = sim.child.try_wait().unwrap() {
            panic!("the simulator exited early: {status}");
        }
        assert!(Instant::now() < deadline, "the simulator did not create its socket in time");
        std::thread::sleep(Duration::from_millis(50));
    }
    sim
}

#[test]
fn preflight_then_telemetry_events_from_the_simulator() {
    let sim = spawn_sim(&user_name());
    let (sink, rx) = collect_sink();
    let st = HelperState::with_parts(Target::dev(&sim.sock), Box::new(SysProbe), sink, Duration::from_secs(20));

    let status = st.connect();
    assert_eq!(status["connected"], true, "{status}");
    assert_eq!(status["dev_socket"], true);
    assert_eq!(status["preflight"]["ok"], true, "{status}");

    let pre = st.call("preflight", &json!({}), Connect::Never);
    assert_eq!(pre["ok"], true, "{pre}");
    assert!(pre["result"].is_object());

    // an op outside the allowlist never reaches the simulator
    let bad = st.call("mailbox.write", &json!({"word": 1}), Connect::Never);
    assert_eq!(bad["error"]["code"], "UNKNOWN_OP");

    let started = st.call("telemetry.start", &json!({"interval_s": 0.2}), Connect::Never);
    assert_eq!(started["ok"], true, "{started}");
    let first = next_event(&rx, "helper://telemetry");
    let second = next_event(&rx, "helper://telemetry");
    assert!(first["values"].is_object() && second["values"].is_object(), "{first} {second}");
    assert_ne!(first["t"], second["t"]);

    let stopped = st.call("telemetry.stop", &json!({}), Connect::Never);
    assert_eq!(stopped["ok"], true, "{stopped}");
    assert_eq!(st.status()["connected"], true);
}

/// F-02's premise, against the real helper code: telemetry belongs to a connection. A new connection gets no telemetry until it sends
/// `telemetry.start` again, which is why the UI re-runs its start-up after every reconnect.
#[test]
fn a_new_connection_gets_telemetry_only_after_starting_it_again() {
    let sim = spawn_sim(&user_name());
    let (sink, rx) = collect_sink();
    let first = HelperState::with_parts(Target::dev(&sim.sock), Box::new(SysProbe), sink, Duration::from_secs(20));
    assert_eq!(first.connect()["connected"], true);
    assert_eq!(first.call("telemetry.start", &json!({"interval_s": 0.2}), Connect::Never)["ok"], true);
    next_event(&rx, "helper://telemetry");
    drop(first); // the connection ends (as when the helper restarts, seen from the other side)

    let (sink, rx) = collect_sink();
    let second = HelperState::with_parts(Target::dev(&sim.sock), Box::new(SysProbe), sink, Duration::from_secs(20));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        // the helper serves one client at a time: the old connection may still be winding down (CLIENT_BUSY)
        let s = second.connect();
        if s["connected"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "no reconnect: {s}");
        std::thread::sleep(Duration::from_millis(100));
    }
    let quiet_until = Instant::now() + Duration::from_millis(800);
    while let Some(left) = quiet_until.checked_duration_since(Instant::now()) {
        if let Ok((name, _)) = rx.recv_timeout(left) {
            assert_ne!(name, "helper://telemetry", "telemetry arrived on a new connection that never started it");
        }
    }
    assert_eq!(second.call("telemetry.start", &json!({"interval_s": 0.2}), Connect::Never)["ok"], true);
    next_event(&rx, "helper://telemetry");
}

#[test]
fn a_user_the_simulator_does_not_admit_gets_the_add_user_fix() {
    let sim = spawn_sim("nobody-at-all-g204");
    let (sink, _rx) = collect_sink();
    let st = HelperState::with_parts(Target::dev(&sim.sock), Box::new(SysProbe), sink, Duration::from_secs(20));
    let status = st.connect();
    assert_eq!(status["connected"], false);
    assert_eq!(status["last_error"]["kind"], "not_allowed", "{status}");
    assert!(status["last_error"]["message"].as_str().unwrap().contains("sudo bash install.sh --add-user "));
}

/// R-I1 version handshake against the real helper code: the shell declares itself, the simulator speaks its protocol and serves exactly the
/// op set of the app's allowlist (`ops_hash`), so nothing is fenced and no note is added.
#[test]
fn the_simulator_speaks_the_apps_protocol_and_serves_its_op_set() {
    let sim = spawn_sim(&user_name());
    let (sink, _rx) = collect_sink();
    let st = HelperState::with_parts(Target::dev(&sim.sock), Box::new(SysProbe), sink, Duration::from_secs(20));
    let status = st.connect();
    assert_eq!(status["connected"], true, "{status}");
    let v = &status["version"];
    assert_eq!((v["protocol_ok"].as_bool(), v["ops_hash_ok"].as_bool()), (Some(true), Some(true)), "{v}");
    assert_eq!(v["helper"]["ops_hash"], v["app"]["ops_hash"]);
    assert_eq!(v["message"], Value::Null);
    let pre = &status["preflight"]["result"];
    assert_eq!(pre["client"]["protocol_ok"], true, "{pre}");
    assert_eq!(pre["client"]["name"], linux_xtu_desktop_lib::APP_NAME);
    assert!(!pre["checks"].as_array().unwrap().iter().any(|c| c["name"] == "app_version" || c["name"] == "app_ops"), "{pre}");
    let again = st.call("preflight", &json!({}), Connect::Never);
    assert_eq!(again["result"]["client"]["protocol_ok"], true, "the page's preflight goes out with the client block too: {again}");
}

/// The final `result` event of the long op `id`.
fn result_of(rx: &Receiver<(String, Value)>, id: &str) -> Value {
    loop {
        let ev = next_event(rx, "helper://result");
        if ev["id"] == id {
            return ev;
        }
    }
}

/// R-I1 against the real helper code: the native dialog names the values of a real plan (a point offset; a turbo table, old ratios from the
/// read), and an apply whose intent is not the planned one is refused by the helper (PLAN_STALE / INTENT_CHANGED), nothing written.
#[test]
fn the_dialog_shows_a_real_plans_values_and_a_changed_intent_is_refused() {
    use linux_xtu_desktop_lib::helper::confirm::{Answer, FixedConfirmer};
    let policy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../policies/default.toml").canonicalize().unwrap();
    let sim = spawn_sim_with(&user_name(), &["--policy".as_ref(), policy.as_os_str()]);
    let (sink, rx) = collect_sink();
    let yes = Arc::new(FixedConfirmer::new(Answer::Yes));
    let st = HelperState::with_confirmer(Target::dev(&sim.sock), Box::new(SysProbe), sink, yes.clone(), Duration::from_secs(20));
    assert_eq!(st.connect()["connected"], true);
    let read = st.call("tune.read", &json!({}), Connect::Never);
    assert_eq!(read["pending"], true, "{read}");
    let done = result_of(&rx, read["id"].as_str().unwrap());
    assert_eq!(done["ok"], true, "{done}");
    let point = |mv: i64| json!({"scope": "unit", "rows": [{"target": "P0", "offset": {"kind": "points", "mv": {"53": mv}}, "v_target_v": null, "ratio": null}]});
    let plan = st.call("tune.plan", &json!({"intent": point(-20)}), Connect::Never);
    assert_eq!(plan["ok"], true, "{plan}");
    let id = plan["result"]["plan_id"].as_str().unwrap().to_string();
    let ok = st.call("app.confirm", &json!({"plans": [{"op": "tune.apply", "plan_id": id}]}), Connect::Never);
    assert_eq!(ok["ok"], true, "{ok}");
    let text = ok["result"]["dialog"]["secondary"].as_str().unwrap();
    assert!(text.contains("P0 · point 5 · 53× · offset 0 → −19.5 mV"), "{text}");
    let stale = st.call("tune.apply", &json!({"plan_id": id, "intent": point(-25)}), Connect::Never);
    assert_eq!(stale["pending"], true, "{stale}");
    let refused = result_of(&rx, stale["id"].as_str().unwrap());
    assert_eq!(refused["error"]["code"], "PLAN_STALE", "{refused}");
    assert_eq!((refused["error"]["detail"]["check"].as_str(), refused["error"]["detail"]["writes_sent"].as_u64()), (Some("INTENT_CHANGED"), Some(0)), "{refused}");

    // a turbo table: before = what the read reported, after = the planned ratios
    let tables = &done["result"]["tables"];
    let was: Vec<u64> = tables["p"].as_array().expect("the simulator reads the turbo tables").iter().map(|r| r.as_u64().unwrap()).collect();
    let lower: Vec<u64> = was.iter().map(|r| r - 1).collect();
    let plan = st.call("tune.plan", &json!({"intent": {"turbo": {"P": lower}}}), Connect::Never);
    assert_eq!(plan["ok"], true, "{plan}");
    let id = plan["result"]["plan_id"].as_str().unwrap().to_string();
    let ok = st.call("app.confirm", &json!({"plans": [{"op": "tune.apply", "plan_id": id}]}), Connect::Never);
    let text = ok["result"]["dialog"]["secondary"].as_str().unwrap_or_default();
    let words = |r: &[u64]| r.iter().map(u64::to_string).collect::<Vec<_>>().join(" ");
    assert!(text.contains(&format!("turbo table P · {} → {}", words(&was), words(&lower))), "{ok}");
    assert_eq!(yes.asked().len(), 2);
}
