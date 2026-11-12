//! `dev-socket` seam against a scripted Rust listener: the dev target, reconnect-on-demand, lost ops. Run with `--features dev-socket`.
#![cfg(feature = "dev-socket")]

#[path = "fixtures/common.rs"]
mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;

use linux_xtu_desktop_lib::helper::connect::{NodeObs, Probe, SysProbe, Target};
use linux_xtu_desktop_lib::helper::version;
use linux_xtu_desktop_lib::helper::{Connect, HelperState};
use common::*;
use serde_json::{json, Value};

fn state(path: &Path) -> (HelperState, std::sync::mpsc::Receiver<(String, Value)>) {
    let (sink, rx) = collect_sink();
    (HelperState::with_parts(Target::dev(path), Box::new(SysProbe), sink, T), rx)
}

/// The `helper` block of a helper that speaks this app's protocol and serves its op set (R-I1 version handshake).
fn same_helper() -> Value {
    json!({"version": "0.2.0-dev", "protocol": version::PROTOCOL, "ops_hash": version::built_ops_hash(), "ops": 32})
}

fn serve_one(l: &UnixListener, then: impl FnOnce(&mut BufReader<UnixStream>, &mut UnixStream) -> Vec<Value>) -> Vec<Value> {
    serve_one_as(l, same_helper(), then)
}

/// One connection whose preflight answer carries `helper` (the version block), then `then`.
fn serve_one_as(l: &UnixListener, helper: Value, then: impl FnOnce(&mut BufReader<UnixStream>, &mut UnixStream) -> Vec<Value>) -> Vec<Value> {
    let (s, _) = l.accept().unwrap();
    s.set_read_timeout(Some(T)).unwrap();
    let mut w = s.try_clone().unwrap();
    let mut r = BufReader::new(s);
    let mut seen = vec![];
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let pre: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(pre["op"], "preflight");
    assert_eq!(pre["args"], version::preflight_args(), "the handshake declares this app");
    seen.push(pre.clone());
    writeln!(w, "{}", json!({"id": pre["id"], "ok": true, "result": {"writes_allowed": false, "helper": helper}})).unwrap();
    seen.extend(then(&mut r, &mut w));
    seen
}

fn read_req(r: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn dev_target_connects_reports_a_lost_op_and_reconnects_on_the_next_action() {
    let dir = TempDir::new("dev");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (st, rx) = state(&sock);
    assert_eq!(st.status()["connected"], false);

    let server = std::thread::spawn(move || {
        // connection 1: preflight, then a request arrives and the helper dies without answering
        let first = serve_one(&listener, |r, _w| vec![read_req(r)]);
        // connection 2: preflight, then one short op
        let second = serve_one(&listener, |r, w| {
            let req = read_req(r);
            writeln!(w, "{}", json!({"id": req["id"], "ok": true, "result": {"rows": []}})).unwrap();
            let mut rest = String::new();
            let _ = r.read_line(&mut rest); // stay up until the client leaves
            vec![req]
        });
        (first, second)
    });

    // the first user action connects (a call that is allowed to)
    let r = st.call("profiles.list", &json!({}), Connect::IfDown);
    assert_eq!(r["ok"], false); // connection 1's helper never answers this one: it reads it and hangs up
    assert_eq!(r["error"]["code"], "LINK_LOST");
    next_event(&rx, "helper://closed");
    assert_eq!(st.status()["connected"], false);
    assert_eq!(st.status()["dev_socket"], true);

    // the next user action reconnects (once) and works; the lost op is not replayed
    let r = st.call("audit.tail", &json!({"n": 3}), Connect::IfDown);
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(st.status()["connected"], true);
    assert_eq!(st.status()["preflight"]["result"]["writes_allowed"], false);

    drop(st);
    let (first, second) = server.join().unwrap();
    assert_eq!(first.iter().map(|v| v["op"].as_str().unwrap()).collect::<Vec<_>>(), ["preflight", "profiles.list"]);
    assert_eq!(second.iter().map(|v| v["op"].as_str().unwrap()).collect::<Vec<_>>(), ["preflight", "audit.tail"]);
}

#[test]
fn a_long_op_returns_its_id_and_finishes_as_an_event() {
    let dir = TempDir::new("dev-long");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (st, rx) = state(&sock);
    let server = std::thread::spawn(move || {
        serve_one(&listener, |r, w| {
            let req = read_req(r);
            writeln!(w, "{}", json!({"event": "progress", "op_id": req["id"], "step": 1, "of": 1})).unwrap();
            writeln!(w, "{}", json!({"id": req["id"], "ok": true, "result": {"units": 12}})).unwrap();
            // keep the connection open until the client has what it needs
            let mut rest = String::new();
            let _ = r.read_line(&mut rest);
            vec![req]
        })
    });
    let r = st.call("tune.read", &json!({}), Connect::IfDown);
    assert_eq!(r["ok"], true);
    assert_eq!(r["pending"], true);
    let id = r["id"].as_str().unwrap().to_string();
    let res = next_event(&rx, "helper://result");
    assert_eq!(res, json!({"id": id, "ok": true, "result": {"units": 12}}));
    drop(st);
    let seen = server.join().unwrap();
    assert_eq!(seen[1]["op"], "tune.read");
}

#[test]
fn unknown_ops_are_refused_without_connecting() {
    let dir = TempDir::new("dev-unknown");
    let (st, _rx) = state(&dir.0.join("never.sock")); // does not exist
    for (op, args) in [("rm", json!({})), ("preflight", json!({"x": 1}))] {
        let r = st.call(op, &args, Connect::IfDown);
        assert_eq!(r["ok"], false);
        assert!(["UNKNOWN_OP", "BAD_REQUEST"].contains(&r["error"]["code"].as_str().unwrap()));
        assert!(r["error"]["message"].as_str().unwrap().starts_with("refused locally"));
    }
    assert_eq!(st.status()["last_error"]["kind"], "not_connected"); // no connection was even attempted
}

#[test]
fn a_missing_socket_is_reported_with_the_fix_and_remembered() {
    let dir = TempDir::new("dev-missing");
    let (st, _rx) = state(&dir.0.join("never.sock"));
    // a call that may not connect does not even look: nothing was tried yet
    let r = st.call("preflight", &json!({}), Connect::Never);
    assert_eq!(r, json!({"ok": false, "error": {"code": "NOT_CONNECTED", "message": "not connected to the helper yet; nothing was sent", "detail": {"kind": "not_connected"}}}));
    assert_eq!(st.status()["last_error"]["kind"], "not_connected");
    let r = st.call("preflight", &json!({}), Connect::IfDown);
    assert_eq!(r["error"]["code"], "NOT_CONNECTED");
    assert_eq!(r["error"]["detail"]["kind"], "missing");
    assert!(r["error"]["message"].as_str().unwrap().contains("does not exist. Run: sudo bash install.sh"));
    assert_eq!(st.status()["last_error"]["kind"], "missing");
    // and a later call that may not connect reports the same reason
    assert_eq!(st.call("preflight", &json!({}), Connect::Never)["error"]["detail"]["kind"], "missing");
}

/// F-02: after the link is lost, a call that may not connect (every `helper_call` from the webview) answers NOT_CONNECTED with the
/// reason and opens nothing; the status says `closed`; only `connect` (Retry / the UI's reconnect loop) opens the next connection.
#[test]
fn after_a_loss_calls_never_reconnect_and_only_connect_does() {
    let dir = TempDir::new("dev-never");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (st, rx) = state(&sock);
    let (hang_up_tx, hang_up_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        // preflight answered, then the helper hangs up when the test says so
        let first = serve_one(&listener, |_r, _w| {
            hang_up_rx.recv().unwrap();
            vec![]
        });
        // a connection waiting in the backlog before the test says so would be a silent reconnect
        go_rx.recv().unwrap();
        listener.set_nonblocking(true).unwrap();
        let early = listener.accept().is_ok();
        listener.set_nonblocking(false).unwrap();
        checked_tx.send(()).unwrap();
        let second = serve_one(&listener, |r, w| {
            let req = read_req(r);
            writeln!(w, "{}", json!({"id": req["id"], "ok": true, "result": {"records": []}})).unwrap();
            let mut rest = String::new();
            let _ = r.read_line(&mut rest);
            vec![req]
        });
        (first, early, second)
    });

    assert_eq!(st.connect()["connected"], true);
    hang_up_tx.send(()).unwrap();
    next_event(&rx, "helper://closed");
    let s = st.status();
    assert_eq!(s["connected"], false);
    assert_eq!(s["last_error"]["kind"], "closed");
    assert!(s["last_error"]["message"].as_str().unwrap().starts_with("the connection to the helper was lost (eof)"), "{s}");

    for _ in 0..3 {
        let r = st.call("throttle.tail", &json!({"n": 5}), Connect::Never);
        assert_eq!(r["error"]["code"], "NOT_CONNECTED", "{r}");
        assert_eq!(r["error"]["detail"]["kind"], "closed");
    }
    go_tx.send(()).unwrap(); // the server now checks that nobody connected, then serves the reconnect
    checked_rx.recv().unwrap();
    assert_eq!(st.connect()["connected"], true);
    let r = st.call("throttle.tail", &json!({"n": 5}), Connect::Never);
    assert_eq!(r["ok"], true, "{r}");
    drop(st);
    let (first, early, second) = server.join().unwrap();
    assert_eq!(first.len(), 1);
    assert!(!early, "a call reconnected by itself");
    assert_eq!(second.iter().map(|v| v["op"].as_str().unwrap()).collect::<Vec<_>>(), ["preflight", "throttle.tail"]);
}

#[test]
fn the_dev_target_still_refuses_a_non_socket_and_a_node_owned_by_someone_else() {
    let dir = TempDir::new("dev-untrusted");
    let file = dir.0.join("plain");
    std::fs::write(&file, b"x").unwrap();
    let (st, _rx) = state(&file);
    assert_eq!(st.connect()["last_error"]["kind"], "untrusted");

    // a socket the probe says is root's: the dev target wants the current uid
    struct RootOwned;
    impl Probe for RootOwned {
        fn lstat(&self, _: &Path) -> std::io::Result<NodeObs> {
            Ok(NodeObs { is_socket: true, uid: 0 })
        }
        fn peer_uid(&self, _: &UnixStream) -> std::io::Result<u32> {
            Ok(0)
        }
    }
    let (sink, _rx2) = collect_sink();
    let st = HelperState::with_parts(Target::dev(dir.0.join("whatever")), Box::new(RootOwned), sink, T);
    assert_eq!(st.connect()["last_error"]["kind"], "untrusted");
}

#[test]
fn the_environment_variable_selects_the_dev_target() {
    std::env::set_var("LINUX_XTU_DESKTOP_SOCKET", "/tmp/linux-xtu-g204-dev.sock");
    let t = Target::from_environment();
    assert_eq!(t.path(), Path::new("/tmp/linux-xtu-g204-dev.sock"));
    assert!(t.is_dev());
    std::env::remove_var("LINUX_XTU_DESKTOP_SOCKET");
    assert!(!Target::from_environment().is_dev());
}

#[test]
fn concurrent_actions_share_one_connection() {
    let dir = TempDir::new("dev-concurrent");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (st, _rx) = state(&sock);
    let st = Arc::new(st);
    let server = std::thread::spawn(move || {
        serve_one(&listener, |r, w| {
            let mut seen = vec![];
            for _ in 0..4 {
                let req = read_req(r);
                writeln!(w, "{}", json!({"id": req["id"], "ok": true, "result": {}})).unwrap();
                seen.push(req);
            }
            seen
        })
    });
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let st = st.clone();
            std::thread::spawn(move || st.call("mem.read", &json!({}), Connect::IfDown)["ok"] == true)
        })
        .collect();
    assert!(threads.into_iter().all(|t| t.join().unwrap()));
    let seen = server.join().unwrap();
    let ids: std::collections::HashSet<_> = seen.iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids.len(), 5); // preflight + 4 distinct ids on the one connection
}

/// R-S3 (D-053 item 4, F-06): through the object behind `helper_call`. The webview's plan has no code; an apply without the operator's OK
/// is refused with nothing sent; "Cancel" approves nothing and pauses the next dialog; a persistent op (accept) shows its own dialog and the
/// shell completes the two-step accept; after "Apply" the shell sends the apply with the kept code, once.
#[test]
fn the_webview_cannot_write_without_the_operators_click_in_the_native_dialog() {
    use linux_xtu_desktop_lib::helper::confirm::{Answer, ConfirmRequest, Confirmer, COOLDOWN};
    use std::sync::Mutex;

    /// Answers from a script, one per dialog, and records what each dialog said.
    struct Scripted(Mutex<(Vec<Answer>, Vec<ConfirmRequest>)>);
    impl Confirmer for Scripted {
        fn confirm(&self, req: &ConfirmRequest) -> Answer {
            let mut s = self.0.lock().unwrap();
            s.1.push(req.clone());
            s.0.remove(0)
        }
    }

    let dir = TempDir::new("dev-confirm");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (sink, _rx) = collect_sink();
    let dialog = Arc::new(Scripted(Mutex::new((vec![Answer::No, Answer::Yes, Answer::Yes], vec![]))));
    let st = HelperState::with_confirmer(Target::dev(&sock), Box::new(SysProbe), sink, dialog.clone(), T);
    let (plan_id, accept_id) = ("a".repeat(64), "c".repeat(64));
    let (pid, aid) = (plan_id.clone(), accept_id.clone());
    let server = std::thread::spawn(move || {
        serve_one(&listener, move |r, w| {
            let plan = read_req(r);
            let result = json!({"plan_id": pid, "nonce": "Q2W3E4", "writes": 1, "units": ["P0"],
                "steps": [{"n": 1, "kind": "write_percore_enable", "conditional": true}, {"n": 2, "kind": "write_vf_point", "unit": "P0", "cpu": 0, "point": 5, "offset_mv": -20}],
                "before": {"P0": {"5": {"ratio": 53, "offset_mv": 0.0, "v_target_v": null}}}, "after": {"P0": {"5": {"ratio": 53, "offset_mv": -19.531, "v_target_v": null}}}});
            writeln!(w, "{}", json!({"id": plan["id"], "ok": true, "result": result})).unwrap();
            let acc1 = read_req(r);
            writeln!(w, "{}", json!({"id": acc1["id"], "ok": true, "result": {"confirm_required": true, "plan_id": aid, "nonce": "Z9X8C7", "name": "mine"}})).unwrap();
            let acc2 = read_req(r);
            writeln!(w, "{}", json!({"id": acc2["id"], "ok": true, "result": {"accepted": "mine"}})).unwrap();
            let apply = read_req(r); // the only other request that ever arrives
            let _ = writeln!(w, "{}", json!({"id": apply["id"], "ok": true, "result": {"complete": true, "readback": []}})); // the client may be gone
            let mut rest = String::new();
            let _ = r.read_line(&mut rest);
            vec![plan, acc1, acc2, apply]
        })
    });
    assert_eq!(st.connect()["connected"], true);
    let plan = st.call("tune.plan", &json!({"intent": {"scope": "unit", "rows": []}}), Connect::Never);
    assert_eq!(plan["result"]["plan_id"], plan_id.as_str());
    assert!(plan["result"].get("nonce").is_none(), "the webview never sees the code: {plan}");

    let apply = json!({"plan_id": plan_id});
    let confirm = json!({"plans": [{"op": "tune.apply", "plan_id": plan_id}]});
    // no confirmation yet; the right code from the page; a guessed one: all refused, nothing sent
    for args in [apply.clone(), json!({"plan_id": plan_id, "typed": "CONFIRM Q2W3E4"}), json!({"plan_id": plan_id, "typed": "CONFIRM ABCDEF"})] {
        let r = st.call("tune.apply", &args, Connect::Never);
        assert_eq!(r["ok"], false, "{args}");
        assert_eq!(r["error"]["detail"]["writes_sent"], 0, "{r}");
    }
    assert_eq!(st.call("tune.apply", &apply, Connect::Never)["error"]["code"], "NOT_CONFIRMED");
    // the operator clicks Cancel: still nothing; a second request right away gets no dialog at all
    let no = st.call("app.confirm", &confirm, Connect::Never);
    assert_eq!((no["ok"].as_bool(), no["error"]["code"].as_str()), (Some(false), Some("NOT_CONFIRMED")), "{no}");
    assert_eq!(st.call("tune.apply", &apply, Connect::Never)["error"]["code"], "NOT_CONFIRMED");
    let storm = st.call("app.confirm", &confirm, Connect::Never);
    assert_eq!(storm["error"]["code"], "BUSY", "{storm}");
    assert_eq!(st.call("profiles.accept", &json!({"name": "mine"}), Connect::Never)["error"]["code"], "BUSY", "persistent ops share the pause");
    // a plan the app never made cannot even be shown
    let stranger = st.call("app.confirm", &json!({"plans": [{"op": "tune.apply", "plan_id": "b".repeat(64)}]}), Connect::Never);
    assert_eq!(stranger["error"]["code"], "PLAN_STALE");
    std::thread::sleep(COOLDOWN);
    // an accept from the page: its own dialog (Yes), then the shell sends both steps; the page's step 2 is refused
    assert_eq!(st.call("profiles.accept", &json!({"plan_id": accept_id, "typed": "CONFIRM Z9X8C7"}), Connect::Never)["error"]["code"], "BAD_REQUEST");
    let acc = st.call("profiles.accept", &json!({"name": "mine"}), Connect::Never);
    assert_eq!(acc["result"], json!({"accepted": "mine"}), "{acc}");
    // the operator clicks "Apply 2 writes"
    let yes = st.call("app.confirm", &confirm, Connect::Never);
    assert_eq!((yes["ok"].as_bool(), yes["result"]["plans"].as_u64(), yes["result"]["writes"].as_u64()), (Some(true), Some(1), Some(1)), "{yes}");
    let asked = dialog.0.lock().unwrap().1.clone();
    assert_eq!(asked.len(), 3, "Cancel, the accept, Apply; the storm and the stranger plan showed none");
    assert_eq!(asked[1].primary(), "Set profile “mine” as the accepted state?");
    assert_eq!((asked[2].primary().as_str(), asked[2].ok_label().as_str()), ("Apply 1 write to the CPU?", "Apply 1 write"));
    assert!(asked[2].secondary().contains("• P0 · point 5 · 53× · offset 0 → −19.5 mV\n"), "the value, not just the unit: {}", asked[2].secondary());
    assert_eq!(yes["result"]["dialog"]["secondary"], asked[2].secondary());
    let sent = st.call("tune.apply", &json!({"plan_id": plan_id, "intent": {"scope": "unit", "rows": []}}), Connect::Never);
    assert_eq!((sent["ok"].as_bool(), sent["pending"].as_bool()), (Some(true), Some(true)), "{sent}");
    // spent: the same click cannot be replayed
    assert_eq!(st.call("tune.apply", &apply, Connect::Never)["error"]["code"], "PLAN_STALE");
    drop(st);
    let seen = server.join().unwrap();
    assert_eq!(seen.iter().map(|v| v["op"].as_str().unwrap()).collect::<Vec<_>>(), ["preflight", "tune.plan", "profiles.accept", "profiles.accept", "tune.apply"]);
    assert_eq!(seen[2]["args"], json!({"name": "mine"}));
    assert_eq!(seen[3]["args"], json!({"plan_id": accept_id, "typed": "CONFIRM Z9X8C7"}), "the shell completed the two-step accept");
    assert_eq!(
        seen[4]["args"],
        json!({"plan_id": plan_id, "typed": "CONFIRM Q2W3E4", "intent": {"scope": "unit", "rows": []}}),
        "the shell added the kept code and forwarded the page's intent"
    );
}

/// R-I1 version handshake: a helper of another protocol stays readable, but every write and mutating op is refused here, nothing sent; the
/// status says why and how to fix it; the page's preflight is sent with this app's client block and comes back with writes off.
#[test]
fn a_helper_of_another_protocol_is_read_only_from_the_app() {
    use linux_xtu_desktop_lib::helper::confirm::{Answer, FixedConfirmer};
    let dir = TempDir::new("dev-version");
    let sock = dir.0.join("h.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let (sink, _rx) = collect_sink();
    let yes = Arc::new(FixedConfirmer::new(Answer::Yes));
    let st = HelperState::with_confirmer(Target::dev(&sock), Box::new(SysProbe), sink, yes.clone(), T);
    let other = json!({"version": "0.3.0", "protocol": version::PROTOCOL + 1, "ops_hash": "0".repeat(64), "ops": 33});
    let server = std::thread::spawn(move || {
        serve_one_as(&listener, other, |r, w| {
            let read = read_req(r); // a read goes through
            writeln!(w, "{}", json!({"id": read["id"], "ok": true, "result": {"rows": []}})).unwrap();
            let pre = read_req(r); // the page's preflight, sent with the app's client block
            writeln!(w, "{}", json!({"id": pre["id"], "ok": true, "result": {"writes_allowed": true, "checks": [], "helper": {"version": "0.3.0", "protocol": 2},
                "client": {"protocol": 1, "protocol_ok": false}}})).unwrap();
            let mut rest = String::new();
            let _ = r.read_line(&mut rest); // nothing else arrives before the client leaves
            vec![read, pre]
        })
    });
    let status = st.connect();
    assert_eq!(status["connected"], true, "{status}");
    let v = &status["version"];
    assert_eq!((v["protocol_ok"].as_bool(), v["ops_hash_ok"].as_bool(), v["fix"].as_str()), (Some(false), Some(false), Some(version::REINSTALL)), "{v}");
    assert!(v["message"].as_str().unwrap().starts_with("Helper and app versions differ: the helper (0.3.0) speaks protocol 2"), "{v}");
    assert_eq!(status["preflight"]["result"]["writes_allowed"], false, "the handshake's report says writes are off");
    assert_eq!(status["preflight"]["result"]["checks"][0]["name"], "app_version");

    for (op, args) in [
        ("app.confirm", json!({"plans": [{"op": "tune.apply", "plan_id": "a".repeat(64)}]})),
        ("tune.apply", json!({"plan_id": "a".repeat(64)})),
        ("profiles.accept", json!({"name": "mine"})),
        ("profiles.save", json!({"name": "mine", "from": "read"})),
        ("curves.delete", json!({"id": "20261018T101500Z-a1b2"})),
    ] {
        let r = st.call(op, &args, Connect::Never);
        assert_eq!((r["error"]["code"].as_str(), r["error"]["detail"]["writes_sent"].as_u64()), (Some("VERSION_MISMATCH"), Some(0)), "{op}: {r}");
    }
    assert!(yes.asked().is_empty(), "no dialog was shown");
    assert_eq!(st.call("profiles.list", &json!({}), Connect::Never)["ok"], true, "reads still work");
    let bad = st.call("preflight", &json!({"client": {"protocol": 1}}), Connect::Never);
    assert_eq!(bad["error"]["code"], "BAD_REQUEST", "the page cannot declare a client: {bad}");
    let pre = st.call("preflight", &json!({}), Connect::Never);
    assert_eq!((pre["result"]["writes_allowed"].as_bool(), pre["result"]["checks"][0]["status"].as_str()), (Some(false), Some("fail")), "{pre}");
    drop(st);
    let seen = server.join().unwrap();
    assert_eq!(seen.iter().map(|v| v["op"].as_str().unwrap()).collect::<Vec<_>>(), ["preflight", "profiles.list", "preflight"]);
    assert_eq!(seen[2]["args"], version::preflight_args());
}
