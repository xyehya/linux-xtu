//! Link behaviour over a socketpair with a scripted fake helper: allowlist, framing, matching, events, loss. No hardware.

#[path = "fixtures/common.rs"]
mod common;

use std::io::Read;
use std::time::Duration;

use linux_xtu_desktop_lib::helper::frame::MAX_LINE;
use linux_xtu_desktop_lib::helper::link::{public_response, ApplyError, ApplyRefusal, CallError, Link, Reply, MAX_PENDING_LONG};
use linux_xtu_desktop_lib::helper::ops::PlanKind;
use common::*;
use serde_json::{json, Value};

fn start() -> (Link, FakeHelper, std::sync::mpsc::Receiver<(String, Value)>) {
    let (client, helper) = pair();
    let (sink, rx) = collect_sink();
    (Link::start(client, sink).unwrap(), helper, rx)
}

fn done(r: Result<Reply, CallError>) -> Value {
    match r {
        Ok(Reply::Done(v)) => v,
        other => panic!("expected a short answer, got {other:?}"),
    }
}

/// The confirmation code the fake helper puts in every plan (the helper's alphabet: A-Z, 2-9).
const NONCE: &str = "K7MNPQ";

/// Plan on `link` the way the app does: a successful `tune.plan` answer carrying `plan_id` and `nonce`.
fn make_plan(link: &Link, helper: &mut FakeHelper, plan_id: &str) {
    make_plan_of(link, helper, "tune.plan", json!({"intent": {"restore": "accepted"}}), plan_id);
}

fn make_plan_of(link: &Link, helper: &mut FakeHelper, op: &str, args: Value, plan_id: &str) -> Value {
    answer_plan(link, helper, op, args, json!({"plan_id": plan_id, "nonce": NONCE, "writes": 1}))
}

/// `op` answered with `result`; the answer as the link returns it (raw: the webview gets `public_response` of it).
fn answer_plan(link: &Link, helper: &mut FakeHelper, op: &str, args: Value, result: Value) -> Value {
    std::thread::scope(|s| {
        let t = s.spawn(|| {
            let req = helper.request();
            assert_eq!(req["op"], op);
            helper.send(&json!({"id": req["id"], "ok": true, "result": result}));
        });
        let raw = done(link.call(op, &args, T));
        assert_eq!(raw["ok"], true);
        t.join().unwrap();
        raw
    })
}

/// What the app does after the operator's OK in the native dialog: approve the plan, then send its apply.
fn approve_and_apply(link: &Link, kind: PlanKind, plan_id: &str) -> Result<Reply, ApplyError> {
    assert!(link.approve(&[(kind, plan_id.to_string())]), "approve {plan_id}");
    link.apply(kind, plan_id, None, T)
}

fn refused(r: Result<Reply, ApplyError>) -> ApplyRefusal {
    match r {
        Err(ApplyError::Refused(x)) => x,
        other => panic!("expected a local refusal, got {other:?}"),
    }
}

fn power_plan(link: &Link, helper: &mut FakeHelper, plan_id: &str) {
    make_plan_of(link, helper, "power.plan", json!({"power": {"pl1_w": 200}}), plan_id);
}

fn runtime_plan(link: &Link, helper: &mut FakeHelper, plan_id: &str) {
    make_plan_of(link, helper, "runtime.plan", json!({"caps": {"1": 30}}), plan_id);
}

#[test]
fn unknown_op_is_refused_locally_and_nothing_is_written() {
    let (link, mut helper, _rx) = start();
    for (op, args) in [
        ("rm", json!({})),
        ("mem.write", json!({})),
        ("power.set", json!({"pl1_w": 400})),
        ("", json!({})),
        ("PREFLIGHT", json!({})),
        ("preflight\n", json!({})),
    ] {
        match link.call(op, &args, T) {
            Err(CallError::Refused(r)) => assert_eq!(r.code, "UNKNOWN_OP", "{op}"),
            other => panic!("{op:?}: {other:?}"),
        }
    }
    // wrong argument shapes of allowed ops
    for (op, args) in [
        ("preflight", json!({"x": 1})),
        ("preflight", json!([])),
        ("preflight", json!(null)),
        ("audit.tail", json!({"n": 201})),
        ("audit.tail", json!({"n": 1.5})),
        ("audit.tail", json!({"n": true})),
        ("telemetry.start", json!({"interval_s": 0.1})),
        ("telemetry.start", json!({"interval_s": "1"})),
        ("tune.apply", json!({"plan_id": "x", "typed": "CONFIRM ABCDEF"})),
        ("tune.apply", json!({"plan_id": "a".repeat(64), "typed": "CONFIRM ABC1EF"})),
        ("tune.plan", json!({"intent": []})),
        ("tune.plan", json!({"intent": {"pad": "x".repeat(17_000)}})),
        ("profiles.save", json!({"name": "UPPER", "intent": {}})),
        ("curves.get", json!({"id": "nope"})),
        ("curves.update", json!({"id": "20261018T101500Z-a1b2"})),
        ("vf.measure", json!({"units": ["P1", "P1"]})),
        ("vf.measure", json!({"units": ["X1"]})),
        ("stress.start", json!({"kind": "cpu"})),
        ("stress.start", json!({"kind": "cpu", "duration_s": 29})),
        ("stress.start", json!({"kind": "gpu", "duration_s": 60})),
        ("stress.start", json!({"kind": "cpu", "duration_s": 60, "extra": 1})),
        ("cancel", json!({"op_id": "a b"})),
        ("tune.read", json!({"cpus": [1024]})),
        ("tune.read", json!({"cpus": []})),
    ] {
        match link.call(op, &args, T) {
            Err(CallError::Refused(r)) => assert_eq!(r.code, "BAD_REQUEST", "{op} {args}"),
            other => panic!("{op} {args}: {other:?}"),
        }
    }
    // The helper side saw nothing at all.
    helper.w.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    let mut buf = [0u8; 16];
    let got = helper.r.get_mut().read(&mut buf);
    assert!(matches!(got, Err(ref e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)), "{got:?}");
}

#[test]
fn allowed_shapes_pass_and_go_out_as_compact_lines_with_unique_ids() {
    let (link, mut helper, _rx) = start();
    let t = std::thread::spawn(move || {
        let a = helper.answer_ok();
        let b = helper.answer_ok();
        (a, b)
    });
    assert_eq!(done(link.call("preflight", &json!({}), T))["ok"], true);
    done(link.call("audit.tail", &json!({"n": 5}), T));
    let (a, b) = t.join().unwrap();
    assert_eq!(a["op"], "preflight");
    assert_eq!(b["args"], json!({"n": 5}));
    assert_ne!(a["id"], b["id"]);
    assert!(a["id"].as_str().unwrap().len() <= 64);
    assert_eq!(a.as_object().unwrap().len(), 3); // exactly id, op, args
}

#[test]
fn responses_are_matched_by_id_even_out_of_order() {
    let (link, mut helper, _rx) = start();
    let link = std::sync::Arc::new(link);
    let l1 = link.clone();
    let l2 = link.clone();
    let t1 = std::thread::spawn(move || done(l1.call("audit.tail", &json!({"n": 1}), T)));
    let first = helper.request();
    let t2 = std::thread::spawn(move || done(l2.call("audit.tail", &json!({"n": 2}), T)));
    let second = helper.request();
    // answer the second request first
    helper.send(&json!({"id": second["id"], "ok": true, "result": {"which": 2}}));
    helper.send(&json!({"id": first["id"], "ok": true, "result": {"which": 1}}));
    assert_eq!(t1.join().unwrap()["result"]["which"], 1);
    assert_eq!(t2.join().unwrap()["result"]["which"], 2);
}

#[test]
fn oversize_inbound_line_is_dropped_and_the_link_keeps_working() {
    let (link, mut helper, rx) = start();
    let t = std::thread::spawn(move || {
        let req = helper.request();
        let mut junk = vec![b'x'; MAX_LINE + 5000];
        junk.push(b'\n');
        helper.send_raw(&junk);
        // an exact-limit event (64 KiB with the newline) is still delivered
        let head = br#"{"event":"progress","pad":""#;
        let tail = b"\"}\n";
        let pad = MAX_LINE - head.len() - tail.len();
        let mut at_limit = head.to_vec();
        at_limit.extend(std::iter::repeat(b'p').take(pad));
        at_limit.extend_from_slice(tail);
        assert_eq!(at_limit.len(), MAX_LINE);
        helper.send_raw(&at_limit);
        helper.send(&json!({"id": req["id"], "ok": true, "result": {"after": "junk"}}));
        helper
    });
    let r = done(link.call("preflight", &json!({}), T));
    assert_eq!(r["result"]["after"], "junk");
    let ev = next_event(&rx, "helper://progress");
    assert_eq!(ev["pad"].as_str().unwrap().len(), MAX_LINE - 30);
    drop(t.join().unwrap());
}

#[test]
fn one_byte_over_the_limit_is_dropped() {
    let (link, mut helper, rx) = start();
    let head = br#"{"event":"progress","pad":""#;
    let tail = b"\"}\n";
    let mut over = head.to_vec();
    over.extend(std::iter::repeat(b'p').take(MAX_LINE + 1 - head.len() - tail.len()));
    over.extend_from_slice(tail);
    assert_eq!(over.len(), MAX_LINE + 1);
    helper.send_raw(&over);
    helper.send(&json!({"event": "state", "state": "idle"}));
    assert_eq!(next_event(&rx, "helper://state")["state"], "idle");
    while let Ok((name, _)) = rx.try_recv() {
        assert_ne!(name, "helper://progress");
    }
    assert!(link.alive());
}

#[test]
fn malformed_lines_never_kill_the_reader() {
    let (link, mut helper, rx) = start();
    helper.send_raw(b"this is not json\n");
    helper.send_raw(b"[1,2,3]\n");
    helper.send_raw(b"42\n");
    helper.send_raw(b"\n");
    helper.send_raw(b"\xff\xfe\xfd{\n"); // not UTF-8
    helper.send_raw(&[vec![b'['; 60_000], b"\n".to_vec()].concat()); // nesting far beyond the recursion limit
    helper.send_raw(br#"{"id":7,"ok":true}"#); // non-string id, no newline yet
    helper.send_raw(b"\n");
    helper.send_raw(br#"{"event":5}"#);
    helper.send_raw(b"\n");
    helper.send_raw(br#"{"event":"Has Upper"}"#);
    helper.send_raw(b"\n");
    helper.send_raw(br#"{"id":"never-sent","ok":true,"result":{}}"#);
    helper.send_raw(b"\n");
    helper.send(&json!({"event": "heartbeat", "state": "idle", "ops_used": 3}));
    let hb = next_event(&rx, "helper://heartbeat");
    assert_eq!(hb["ops_used"], 3);
    assert!(link.alive());
    assert_eq!(link.latest()["heartbeat"]["ops_used"], 3);
}

#[test]
fn events_are_published_as_helper_scheme_names_with_dots_mapped() {
    let (_link, mut helper, rx) = start();
    for ev in ["heartbeat", "state", "progress", "telemetry", "vf.point"] {
        helper.send(&json!({"event": ev, "op_id": null, "n": 1}));
    }
    // order is preserved
    let names: Vec<String> = (0..5).map(|_| rx.recv_timeout(T).unwrap().0).collect();
    assert_eq!(names, ["helper://heartbeat", "helper://state", "helper://progress", "helper://telemetry", "helper://vf-point"]);
}

#[test]
fn a_helper_line_cannot_impersonate_the_links_result_or_closed_events() {
    let (_link, mut helper, rx) = start();
    helper.send(&json!({"event": "result", "id": "d1", "ok": true}));
    helper.send(&json!({"event": "closed"}));
    helper.send(&json!({"event": "state", "state": "idle"}));
    let (name, _) = rx.recv_timeout(T).unwrap();
    assert_eq!(name, "helper://state");
}

#[test]
fn a_long_ops_result_is_delivered_as_an_event() {
    let (link, mut helper, rx) = start();
    let reply = link.call("tune.read", &json!({}), T).expect("sent");
    let Reply::Started(id) = reply else { panic!("long op must return its id") };
    let req = helper.request();
    assert_eq!(req["id"], id.as_str());
    assert_eq!(req["op"], "tune.read");
    assert_eq!(link.pending_long(), 1);
    helper.send(&json!({"event": "progress", "op_id": id, "step": 1, "of": 2}));
    helper.send(&json!({"id": id, "ok": true, "result": {"units": 12}}));
    let res = next_event(&rx, "helper://result");
    assert_eq!(res, json!({"id": id, "ok": true, "result": {"units": 12}}));
    assert_eq!(link.pending_long(), 0);
}

#[test]
fn error_results_reach_the_webview_without_unlisted_detail() {
    let (link, mut helper, rx) = start();
    make_plan(&link, &mut helper, &"a".repeat(64));
    let Ok(Reply::Started(id)) = approve_and_apply(&link, PlanKind::Tune, &"a".repeat(64)) else { panic!() };
    helper.request();
    let raw = fixture("error_with_detail.json").replace("REPLACE", &id);
    helper.send_raw(raw.as_bytes());
    let res = next_event(&rx, "helper://result");
    assert_eq!(
        res,
        json!({"id": id, "ok": false, "error": {"code": "REFUSED", "message": "policy window exceeded",
                                                 "detail": {"check": "POLICY_RANGE", "state": "idle", "curve_id": "20261018T101500Z-a1b2"}}})
    );
}

#[test]
fn short_errors_are_filtered_too() {
    let (link, mut helper, _rx) = start();
    let t = std::thread::spawn(move || {
        let req = helper.request();
        let raw = fixture("error_with_detail.json").replace("REPLACE", req["id"].as_str().unwrap());
        helper.send_raw(raw.as_bytes());
        helper
    });
    let r = public_response(&done(link.call("profiles.list", &json!({}), T)));
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"]["detail"], json!({"check": "POLICY_RANGE", "state": "idle", "curve_id": "20261018T101500Z-a1b2"}));
    assert!(r["error"].get("secret_path").is_none() && r["error"]["detail"].get("partial").is_none());
    drop(t.join().unwrap());
}

/// F-04: the keys the UI reads pass (`writes_sent` -> "Nothing was written", `key`, `problems`); objects, paths and other keys do not.
#[test]
fn detail_keys_the_ui_reads_pass_and_nothing_else() {
    let r = public_response(&json!({"id": "d9", "ok": false, "error": {"code": "CANCELLED", "message": "tune.apply was cancelled before the first write; nothing was changed",
        "detail": {"ops_done": 4, "writes_sent": 0, "key": "pl1_w", "check": "PLAN_ERROR", "tripped": true, "op_id": "d3", "path": "/etc/x"}}}));
    assert_eq!(r["error"]["detail"], json!({"writes_sent": 0, "key": "pl1_w", "check": "PLAN_ERROR"}));
}

#[test]
fn detail_problems_are_a_capped_list_of_short_strings() {
    let long = "x".repeat(800);
    let mut problems: Vec<Value> = (1..=12).map(|n| json!(format!("note {n}"))).collect();
    problems.insert(1, json!({"not": "a string"}));
    problems.insert(2, json!(long));
    let r = public_response(&json!({"id": "d9", "ok": false, "error": {"code": "INTERNAL", "message": "vf.measure failed",
        "detail": {"problems": problems, "curve_id": "c1", "partial": {"units": {}}}}}));
    let got = r["error"]["detail"]["problems"].as_array().unwrap();
    assert_eq!(got.len(), 10); // 9 kept + one line that says how many were left out: never a silent cut
    assert_eq!(got[0], "note 1");
    assert_eq!(got[1].as_str().unwrap().chars().count(), 500); // the long one, cut; the object dropped
    assert_eq!(got[9], "... and 4 more not shown"); // 13 strings, 9 shown
    assert_eq!(r["error"]["detail"]["curve_id"], "c1");
    assert!(r["error"]["detail"].get("partial").is_none());
    // a list of exactly the cap stays whole; a scalar key never carries a list or an object
    let ten: Vec<Value> = (1..=10).map(|n| json!(format!("n{n}"))).collect();
    let r = public_response(&json!({"ok": false, "error": {"code": "X", "message": "", "detail": {"problems": ten.clone(), "check": ["A"], "key": {"k": 1}}}}));
    assert_eq!(r["error"]["detail"], json!({"problems": ten}));
    // a scalar string is cut too
    let r = public_response(&json!({"ok": false, "error": {"code": "X", "message": "", "detail": {"state": long}}}));
    assert_eq!(r["error"]["detail"]["state"].as_str().unwrap().len(), 500);
}

#[test]
fn a_long_op_in_flight_when_the_link_dies_is_reported_lost_not_replayed() {
    let (link, mut helper, rx) = start();
    let Ok(Reply::Started(id)) = link.call("vf.measure", &json!({}), T) else { panic!() };
    helper.request();
    drop(helper); // helper vanishes
    let res = next_event(&rx, "helper://result");
    assert_eq!(res["id"], id.as_str());
    assert_eq!(res["ok"], false);
    assert_eq!(res["error"]["code"], "LINK_LOST");
    next_event(&rx, "helper://closed");
    assert!(link.wait_finished(T));
    assert!(!link.alive());
    // later calls fail at once and write nothing
    assert!(matches!(link.call("preflight", &json!({}), T), Err(CallError::Unavailable)));
}

#[test]
fn a_short_op_in_flight_when_the_link_dies_fails() {
    let (link, mut helper, _rx) = start();
    let t = std::thread::spawn(move || {
        helper.request();
        drop(helper);
    });
    assert!(matches!(link.call("mem.read", &json!({}), T), Err(CallError::Unavailable)));
    t.join().unwrap();
}

#[test]
fn a_silent_helper_times_out_and_a_late_answer_is_dropped() {
    let (link, mut helper, rx) = start();
    let err = link.call("mem.read", &json!({}), Duration::from_millis(200));
    assert!(matches!(err, Err(CallError::Timeout)), "{err:?}");
    let req = helper.request();
    helper.send(&json!({"id": req["id"], "ok": true, "result": {}})); // late
    let t = std::thread::spawn(move || {
        helper.answer_ok();
        helper
    });
    assert_eq!(done(link.call("stress.list", &json!({}), T))["ok"], true);
    drop(t.join().unwrap());
    assert!(rx.try_iter().all(|(n, _)| n != "helper://result"));
}

#[test]
fn at_most_four_long_ops_run_at_once() {
    let (link, mut helper, _rx) = start();
    for _ in 0..MAX_PENDING_LONG {
        assert!(matches!(link.call("tune.read", &json!({}), T), Ok(Reply::Started(_))));
        helper.request();
    }
    assert!(matches!(link.call("tune.read", &json!({}), T), Err(CallError::TooManyLong)));
    // short ops still go
    let t = std::thread::spawn(move || {
        helper.answer_ok();
        helper
    });
    assert_eq!(done(link.call("preflight", &json!({}), T))["ok"], true);
    drop(t.join().unwrap());
}

#[test]
fn the_framed_refusal_line_is_kept_for_the_connect_error() {
    let (link, mut helper, _rx) = start();
    helper.send_raw(fixture("refused_client_busy.jsonl").as_bytes());
    drop(helper);
    assert!(link.wait_finished(T));
    assert_eq!(link.refusal().unwrap()["detail"]["check"], "CLIENT_BUSY");
}

#[test]
fn an_apply_is_sent_only_for_a_plan_of_this_connection_the_operator_approved_with_its_kept_code_and_once() {
    let (link, mut helper, _rx) = start();
    let (known, other) = ("a".repeat(64), "b".repeat(64));

    // nothing planned yet: refused locally, nothing written
    assert_eq!(refused(link.apply(PlanKind::Tune, &known, None, T)), ApplyRefusal::UnknownPlan);
    let raw = make_plan_of(&link, &mut helper, "tune.plan", json!({"intent": {"restore": "accepted"}}), &known);
    // the webview's copy of the plan has no confirmation code; the link keeps it
    assert_eq!(raw["result"]["nonce"], NONCE);
    let public = public_response(&raw);
    assert_eq!(public["result"]["plan_id"], known.as_str());
    assert!(public["result"].get("nonce").is_none(), "{public}");
    assert_eq!(link.plan_record(PlanKind::Tune, &known).unwrap().nonce.as_deref(), Some(NONCE));
    assert!(link.plan_record(PlanKind::Tune, &known).unwrap().plan.get("nonce").is_none(), "the dialog's copy has none either");

    // the webview's way (even with the right code) is refused: the link never sends a confirmed op from call()
    for args in [json!({"plan_id": known, "typed": format!("CONFIRM {NONCE}")}), json!({"plan_id": known, "typed": "CONFIRM ABCDEF"})] {
        match link.call("tune.apply", &args, T) {
            Err(CallError::Refused(r)) => assert!(r.message.contains("only by the app, after you confirm"), "{}", r.message),
            other => panic!("{other:?}"),
        }
    }
    // planned but not approved: refused
    assert_eq!(refused(link.apply(PlanKind::Tune, &known, None, T)), ApplyRefusal::NotApproved);
    // an approval names existing plans only, all or nothing
    assert!(!link.approve(&[(PlanKind::Tune, other.clone())]));
    assert!(!link.approve(&[(PlanKind::Tune, known.clone()), (PlanKind::Tune, other.clone())]));
    assert_eq!(refused(link.apply(PlanKind::Tune, &known, None, T)), ApplyRefusal::NotApproved, "a failed approval approved nothing");
    // approved: goes out with the kept code ...
    assert!(matches!(approve_and_apply(&link, PlanKind::Tune, &known), Ok(Reply::Started(_))));
    let req = helper.request();
    assert_eq!(req["op"], "tune.apply", "the refused applies wrote nothing");
    assert_eq!(req["args"], json!({"plan_id": known, "typed": format!("CONFIRM {NONCE}")}));
    // ... and is spent
    assert_eq!(refused(link.apply(PlanKind::Tune, &known, None, T)), ApplyRefusal::UnknownPlan);
    assert!(!link.approve(&[(PlanKind::Tune, known.clone())]));
}

#[test]
fn a_plan_without_a_well_formed_code_cannot_be_approved_or_applied() {
    let (link, mut helper, _rx) = start();
    let (none, bad) = ("c".repeat(64), "d".repeat(64));
    answer_plan(&link, &mut helper, "tune.plan", json!({"intent": {"restore": "accepted"}}), json!({"plan_id": none}));
    answer_plan(&link, &mut helper, "tune.plan", json!({"intent": {"restore": "accepted"}}), json!({"plan_id": bad, "nonce": "abc1EF"}));
    for id in [&none, &bad] {
        assert!(!link.approve(&[(PlanKind::Tune, id.clone())]));
        assert_eq!(refused(link.apply(PlanKind::Tune, id, None, T)), ApplyRefusal::NoNonce);
    }
}

#[test]
fn power_and_runtime_apply_need_a_plan_of_their_own_kind_and_spend_it() {
    let (link, mut helper, _rx) = start();
    let (t, p, r) = ("1".repeat(64), "2".repeat(64), "3".repeat(64));
    for kind in [PlanKind::Power, PlanKind::Runtime] {
        assert_eq!(refused(link.apply(kind, &t, None, T)), ApplyRefusal::UnknownPlan, "{kind:?}: nothing planned");
    }
    make_plan(&link, &mut helper, &t);
    power_plan(&link, &mut helper, &p);
    runtime_plan(&link, &mut helper, &r);

    // cross-kind: every kind's id is unknown to the other two kinds (approval too)
    for (kind, bad) in [(PlanKind::Tune, [&p, &r]), (PlanKind::Power, [&t, &r]), (PlanKind::Runtime, [&t, &p])] {
        for id in bad {
            assert!(!link.approve(&[(kind, id.clone())]), "{kind:?}");
            assert_eq!(refused(link.apply(kind, id, None, T)), ApplyRefusal::UnknownPlan, "{kind:?}");
        }
    }
    for op in ["power.apply", "runtime.apply"] {
        assert!(matches!(link.call(op, &json!({"plan_id": p, "typed": format!("CONFIRM {NONCE}")}), T), Err(CallError::Refused(_))), "{op}");
    }
    // the matching kind goes out, once
    assert!(matches!(approve_and_apply(&link, PlanKind::Power, &p), Ok(Reply::Started(_))));
    let req = helper.request();
    assert_eq!((req["op"].as_str(), req["args"]["plan_id"].as_str()), (Some("power.apply"), Some(p.as_str())), "refused applies wrote nothing");
    assert_eq!(refused(link.apply(PlanKind::Power, &p, None, T)), ApplyRefusal::UnknownPlan, "spent");
    // one approval may cover several kinds (one dialog for the whole review); spending a power plan leaves the others alone
    assert!(link.approve(&[(PlanKind::Runtime, r.clone()), (PlanKind::Tune, t.clone())]));
    assert!(matches!(link.apply(PlanKind::Runtime, &r, None, T), Ok(Reply::Started(_))));
    assert_eq!(helper.request()["op"], "runtime.apply");
    assert!(matches!(link.apply(PlanKind::Tune, &t, None, T), Ok(Reply::Started(_))));
    assert_eq!(helper.request()["op"], "tune.apply");
}

#[test]
fn power_and_runtime_plan_sets_are_bounded_separately() {
    let (link, mut helper, _rx) = start();
    let ids: Vec<String> = (0..9).map(|i| format!("{i:x}").repeat(64)).collect();
    let first_tune = "f".repeat(64);
    make_plan(&link, &mut helper, &first_tune);
    for i in &ids {
        power_plan(&link, &mut helper, i);
    }
    // nine power plans push the oldest power plan out, but not the tune plan
    assert!(!link.approve(&[(PlanKind::Power, ids[0].clone())]));
    assert!(matches!(approve_and_apply(&link, PlanKind::Power, &ids[8]), Ok(Reply::Started(_))));
    helper.request();
    for i in &ids {
        runtime_plan(&link, &mut helper, i);
    }
    assert!(!link.approve(&[(PlanKind::Runtime, ids[0].clone())]));
    assert!(matches!(approve_and_apply(&link, PlanKind::Runtime, &ids[8]), Ok(Reply::Started(_))));
    helper.request();
    assert!(matches!(approve_and_apply(&link, PlanKind::Tune, &first_tune), Ok(Reply::Started(_))));
}

#[test]
fn persistent_ops_are_never_sent_by_call_and_persist_completes_a_two_step_accept_or_fails_closed() {
    let (link, mut helper, _rx) = start();
    let id = "e".repeat(64);
    // call() refuses every persistent op, whatever its shape (step 1, step 2, fingerprint): only the app sends them, after the dialog
    for (op, args) in [
        ("profiles.accept", json!({"name": "mine"})),
        ("profiles.accept", json!({"from": "read"})),
        ("profiles.accept", json!({"plan_id": id, "typed": format!("CONFIRM {NONCE}")})),
        ("profiles.fingerprint", json!({})),
    ] {
        match link.call(op, &args, T) {
            Err(CallError::Refused(r)) => assert!(r.message.contains("only by the app, after you confirm"), "{op}: {}", r.message),
            other => panic!("{op}: {other:?}"),
        }
    }
    let persist = |helper: &mut FakeHelper, args: Value, answers: Vec<Value>| -> (Result<Value, ApplyError>, Vec<Value>) {
        std::thread::scope(|s| {
            let t = s.spawn(move || {
                let mut seen = vec![];
                for a in answers {
                    let req = helper.request();
                    let mut ans = a.clone();
                    ans["id"] = req["id"].clone();
                    helper.send(&ans);
                    seen.push(req);
                }
                seen
            });
            let r = link.persist("profiles.accept", &args, T);
            (r, t.join().unwrap())
        })
    };
    // a one-step helper (today's): the accept is step 1 itself; its answer is returned as is
    let (r, seen) = persist(&mut helper, json!({"name": "mine"}), vec![json!({"ok": true, "result": {"accepted": "mine"}})]);
    assert_eq!(r.unwrap()["result"]["accepted"], "mine");
    assert_eq!(seen[0]["args"], json!({"name": "mine"}));
    // the two-step helper (R-B1): step 1 answers a code; the shell sends step 2 with it and returns step 2's answer (the code never leaves)
    let step1 = json!({"ok": true, "result": {"confirm_required": true, "plan_id": id, "nonce": NONCE, "expires_s": 600, "name": "mine"}});
    let (r, seen) = persist(&mut helper, json!({"from": "read"}), vec![step1, json!({"ok": true, "result": {"accepted": "read-1"}})]);
    let last = r.unwrap();
    assert_eq!(last["result"]["accepted"], "read-1");
    assert!(public_response(&last)["result"].get("nonce").is_none());
    assert_eq!(seen[1]["op"], "profiles.accept");
    assert_eq!(seen[1]["args"], json!({"plan_id": id, "typed": format!("CONFIRM {NONCE}")}));
    // a two-step answer without a usable code: refused, step 2 is never sent (nothing was accepted: step 1 writes nothing)
    for bad in [json!({"confirm_required": true, "plan_id": id}), json!({"confirm_required": true, "plan_id": id, "nonce": "abc1EF"}), json!({"confirm_required": true, "plan_id": "x", "nonce": NONCE})] {
        let (r, seen) = persist(&mut helper, json!({"name": "mine"}), vec![json!({"ok": true, "result": bad.clone()})]);
        assert!(matches!(r, Err(ApplyError::Refused(ApplyRefusal::NoNonce))), "{bad}: {r:?}");
        assert_eq!(seen.len(), 1, "{bad}");
    }
    // a refusal of step 1 is passed through
    let (r, _) = persist(&mut helper, json!({"name": "mine"}), vec![json!({"ok": false, "error": {"code": "REFUSED", "message": "not applied", "detail": {"check": "NOT_APPLIED"}}})]);
    assert_eq!(r.unwrap()["error"]["detail"]["check"], "NOT_APPLIED");
    // only the persistent ops go through persist()
    assert!(matches!(link.persist("tune.apply", &json!({"plan_id": id, "typed": "CONFIRM ABCDEF"}), T), Err(ApplyError::Call(CallError::Refused(_)))));
    // the helper saw nothing else
    helper.w.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    let mut buf = [0u8; 1];
    assert!(helper.r.get_mut().read(&mut buf).is_err(), "nothing more was written");
}

#[test]
fn a_refused_power_or_runtime_plan_and_the_read_ops_go_through_the_allowlist() {
    let (link, mut helper, _rx) = start();
    for (op, args) in [
        ("power.plan", json!({"power": {"pl1_w": 200}, "revert": true})),
        ("runtime.plan", json!({"parking": {"3": false}})),
        ("runtime.plan", json!({"caps": {"1": 30}, "parking": {"3": false}})),
        ("runtime.read", json!({"x": 1})),
        ("power.read", json!({"x": 1})),
    ] {
        match link.call(op, &args, T) {
            Err(CallError::Refused(r)) => assert_eq!(r.code, "BAD_REQUEST", "{op}"),
            other => panic!("{op}: {other:?}"),
        }
    }
    // power.read is long (the id comes back at once), runtime.read is answered in line
    assert!(matches!(link.call("power.read", &json!({}), T), Ok(Reply::Started(_))));
    assert_eq!(helper.request()["op"], "power.read");
    std::thread::scope(|s| {
        let t = s.spawn(|| {
            let req = helper.request();
            assert_eq!(req["op"], "runtime.read");
            helper.send(&json!({"id": req["id"], "ok": true, "result": {}}));
        });
        assert_eq!(done(link.call("runtime.read", &json!({}), T))["ok"], true);
        t.join().unwrap();
    });
}

#[test]
fn a_failed_plan_is_not_remembered_and_only_the_last_eight_plans_are() {
    let (link, mut helper, _rx) = start();
    std::thread::scope(|s| {
        let t = s.spawn(|| {
            let req = helper.request();
            helper.send(&json!({"id": req["id"], "ok": false, "error": {"code": "REFUSED", "message": "no"}}));
        });
        assert_eq!(done(link.call("tune.plan", &json!({"intent": {"restore": "accepted"}}), T))["ok"], false);
        t.join().unwrap();
    });
    let plans: Vec<String> = (0..9).map(|i| format!("{i:x}").repeat(64)).collect();
    for p in &plans {
        make_plan(&link, &mut helper, p);
    }
    assert!(!link.approve(&[(PlanKind::Tune, plans[0].clone())]), "oldest of nine was dropped");
    assert!(matches!(approve_and_apply(&link, PlanKind::Tune, &plans[8]), Ok(Reply::Started(_))));
}

#[test]
fn request_ids_are_not_reused_across_links() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..3 {
        let (link, mut helper, _rx) = start();
        for _ in 0..2 {
            let t = std::thread::scope(|s| {
                let t = s.spawn(|| helper.answer_ok());
                done(link.call("preflight", &json!({}), T));
                t.join().unwrap()
            });
            assert!(seen.insert(t["id"].as_str().unwrap().to_string()), "id repeated");
        }
    }
}

/// R-I1: the turbo tables the dialog shows as "before" come only from the helper's own answers — a `tune.read`, the read inside `tune.last`,
/// the read-backs of an apply's table writes — and a plan keeps the request it was made from and the tables known then.
#[test]
fn the_link_keeps_the_turbo_tables_the_helper_reported_and_each_plans_request() {
    let (link, mut helper, rx) = start();
    let long = |link: &Link, helper: &mut FakeHelper, op: &str, args: Value, answer: Value| {
        let Ok(Reply::Started(id)) = link.call(op, &args, T) else { panic!("{op} is a long op") };
        let req = helper.request();
        let mut a = answer;
        a["id"] = req["id"].clone();
        helper.send(&a);
        let ev = next_event(&rx, "helper://result");
        assert_eq!(ev["id"], id.as_str());
        req
    };
    let (p, e) = (json!([57, 57, 55, 55, 55, 55, 55, 55]), json!([48, 48, 48, 48, 48, 48, 48, 48]));
    assert!(link.tables().is_empty(), "nothing known before a read");
    long(&link, &mut helper, "tune.read", json!({}), json!({"ok": true, "result": {"tables": {"p": p, "e": e}}}));
    assert_eq!((link.tables()["p"].clone(), link.tables()["e"].clone()), (p.clone(), e.clone()));
    long(&link, &mut helper, "tune.read", json!({}), json!({"ok": true, "result": {"tables": {"p": p, "e": [1, 2]}}}));
    assert!(link.tables().get("e").is_none(), "a table the answer does not vouch for is forgotten");
    long(&link, &mut helper, "tune.read", json!({}), json!({"ok": true, "result": {"tables": null}}));
    assert!(link.tables().is_empty(), "a read that read no tables: unknown");
    // tune.last: the stored read of this boot
    answer_plan(&link, &mut helper, "tune.last", json!({}), json!({"available": true, "result": {"tables": {"p": p, "e": e}}}));
    assert_eq!(link.tables().len(), 2);
    // a plan keeps its request and the tables known when it was made
    let intent = json!({"intent": {"turbo": {"P": [56, 56, 54, 54, 54, 54, 54, 54]}}});
    let id = "a".repeat(64);
    answer_plan(&link, &mut helper, "tune.plan", intent.clone(), json!({"plan_id": id, "nonce": NONCE, "writes": 1}));
    let rec = link.plan_record(PlanKind::Tune, &id).unwrap();
    assert_eq!((rec.request.clone(), rec.tables.len()), (intent, 2));
    // an apply's table write read back equal becomes the table in force (bucket 0 = bits 7:0); a refusal that wrote nothing changes nothing
    assert!(link.approve(&[(PlanKind::Tune, id.clone())]));
    let Ok(Reply::Started(apply)) = link.apply(PlanKind::Tune, &id, None, T) else { panic!("tune.apply is a long op") };
    let req = helper.request();
    helper.send(&json!({"id": req["id"], "ok": true, "result": {"complete": true, "readback": [
        {"unit": "P", "point": "turbo", "expected": "0x3636363636363838", "actual": "0x3636363636363838", "match": true}]}}));
    assert_eq!(next_event(&rx, "helper://result")["id"], apply.as_str());
    assert_eq!(link.tables()["p"], json!([56, 56, 54, 54, 54, 54, 54, 54]));
    assert_eq!(link.tables()["e"], e, "the table not written stays");
    let (id2, id3) = ("b".repeat(64), "c".repeat(64));
    for (pid, answer, kept) in [
        (&id2, json!({"ok": false, "error": {"code": "PLAN_STALE", "message": "x", "detail": {"check": "INTENT_CHANGED", "writes_sent": 0}}}), true),
        (&id3, json!({"ok": false, "error": {"code": "REFUSED", "message": "stopped after a write", "detail": {"writes_sent": 1}}}), false),
    ] {
        answer_plan(&link, &mut helper, "tune.plan", json!({"intent": {"restore": "accepted"}}), json!({"plan_id": pid, "nonce": NONCE, "writes": 1}));
        assert!(link.approve(&[(PlanKind::Tune, pid.clone())]));
        let Ok(Reply::Started(_)) = link.apply(PlanKind::Tune, pid, None, T) else { panic!("long") };
        let req = helper.request();
        let mut a = answer;
        a["id"] = req["id"].clone();
        helper.send(&a);
        next_event(&rx, "helper://result");
        assert_eq!(!link.tables().is_empty(), kept, "{pid}");
    }
}
