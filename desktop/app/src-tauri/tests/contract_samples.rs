//! The JS <-> Rust contract (assessment 2026-11-11 F-01..F-04, F-09). Every shape the shell hands the webview — the `helper_status` /
//! `helper_connect` JSON (connected, each failed connect, a lost link), `helper_call` answers (ok, long op started, not connected, refused
//! locally, link lost, an error with detail) and every `helper://…` event — is produced here by the real code and serialised into
//! `ui/tests/contract-samples.json`. `ui/tests/contract.test.mjs` feeds those samples through `ui/bridge.js` and the views' readers, and
//! checks the mock backend answers in the same shapes. The samples file is checked in: this test fails when the shell's output drifts
//! from it. After an intended change, regenerate it and commit it with the change:
//!
//!   LINUX_XTU_UPDATE_CONTRACT=1 cargo test --manifest-path desktop/app/src-tauri/Cargo.toml --test contract_samples
//!
//! No hardware and no real helper: fake `lstat` / peer observations, socketpairs with a scripted helper end. The installed target is used
//! only for its path text and with probes that fail before any connect.
//!
//! R-S3 (D-053 item 4): `confirm` holds the confirmation contract — a plan as the webview receives it (no `nonce`), every `app.confirm`
//! answer (confirmed, Cancel, no dialog, a plan the app does not hold, bad arguments), every answer to an apply the webview sends
//! (`{plan_id}` only: not confirmed, a `typed` from the page, a spent plan, sent) and the request the helper then receives; for the
//! persistent ops (`profiles.accept`): Cancel, the page's own step 2, a one-step and a two-step helper, and a two-step answer without a code.

#[path = "fixtures/common.rs"]
mod common;

use std::collections::HashMap;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use linux_xtu_desktop_lib::helper::connect::{check_node, handshake, open_error, ConnectError, NodeObs, Probe, Target};
use linux_xtu_desktop_lib::helper::confirm::{
    apply_confirmed, confirm_plans, item_of, persist_confirmed, sample_tune_record, Answer, ConfirmItem, ConfirmRequest, FixedConfirmer,
};
use linux_xtu_desktop_lib::helper::link::{public_response, CallError, Link, PlanRecord, Reply, DETAIL_LISTS, DETAIL_SCALARS, DETAIL_STR_MAX};
use linux_xtu_desktop_lib::helper::ops::PlanKind;
use linux_xtu_desktop_lib::helper::version::{self, VersionCheck};
use linux_xtu_desktop_lib::helper::{error_reply, not_connected_reply, ops, started_reply, Status};
use common::*;
use serde_json::{json, Map, Value};

/// Login name in the add-user fix of the samples (the app uses `$USER`).
const WHO: &str = "YOURNAME";
const UPDATE_ENV: &str = "LINUX_XTU_UPDATE_CONTRACT";

fn samples_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/tests/contract-samples.json")
}

// ---- observations without a filesystem or a root socket --------------------------------------------------------------------------
struct Fake(io::Result<NodeObs>);

impl Probe for Fake {
    fn lstat(&self, _: &Path) -> io::Result<NodeObs> {
        match &self.0 {
            Ok(v) => Ok(*v),
            Err(e) => Err(io::Error::from(e.kind())),
        }
    }
    fn peer_uid(&self, _: &UnixStream) -> io::Result<u32> {
        Ok(0)
    }
}

fn refused_by(fixture_name: &str) -> ConnectError {
    let (client, mut helper) = pair();
    helper.send_raw(fixture(fixture_name).as_bytes());
    drop(helper); // the service closes after its one line
    let (sink, _rx) = collect_sink();
    handshake(client, sink, WHO, T).err().expect("refused")
}

/// Every failed connect the operator can meet, each from the code path that makes it (root: the app refuses before any check; not here).
fn connect_failures() -> Vec<ConnectError> {
    let installed = Target::installed();
    let mut out = vec![
        check_node(&installed, &Fake(Err(io::ErrorKind::NotFound.into()))).unwrap_err(),
        check_node(&installed, &Fake(Ok(NodeObs { is_socket: true, uid: 1000 }))).unwrap_err(),
        open_error(&installed, &io::Error::from(io::ErrorKind::PermissionDenied)),
        open_error(&installed, &io::Error::from(io::ErrorKind::ConnectionRefused)),
        refused_by("refused_access_denied.jsonl"),
        refused_by("refused_client_busy.jsonl"),
    ];
    let (client, helper) = pair();
    drop(helper);
    let (sink, _rx) = collect_sink();
    out.push(handshake(client, sink, WHO, T).err().expect("closed"));
    let (client, _quiet) = pair(); // kept open, never answers
    let (sink, _rx) = collect_sink();
    out.push(handshake(client, sink, WHO, Duration::from_secs(1)).err().expect("timeout"));
    out
}

fn short_answer(link: &Link, helper: &mut FakeHelper, op: &str, args: Value, answer: impl FnOnce(&Value) -> Value + Send) -> Value {
    std::thread::scope(|s| {
        let h = s.spawn(|| {
            let req = helper.request();
            helper.send(&answer(&req));
        });
        let r = link.call(op, &args, T);
        h.join().unwrap();
        match r {
            Ok(Reply::Done(v)) => public_response(&v),
            other => panic!("expected a short answer, got {other:?}"),
        }
    })
}

/// The confirmation contract, from the real link + confirm code over a socketpair (see the header).
fn confirm_samples() -> Value {
    let (client, mut helper) = pair();
    let (sink, rx) = collect_sink();
    let link = Link::start(client, sink).unwrap();
    // a tune.read whose answer reports the turbo tables: the dialog's "before" of a table write
    let Ok(Reply::Started(_)) = link.call("tune.read", &json!({}), T) else { panic!("tune.read is a long op") };
    let read = helper.request();
    let sample = sample_tune_record();
    helper.send(&json!({"id": read["id"], "ok": true, "result": {"tables": {"e": sample.tables["e"], "p": sample.tables["p"]}}}));
    next_event(&rx, "helper://result");
    assert_eq!(link.tables(), sample.tables, "the link keeps the tables the helper reported");

    let (tune_id, power_id, gone_id, profile_id) = (sample.plan_id.clone(), "8".repeat(64), "9".repeat(64), "5".repeat(64));
    let mut plan_raw = sample.plan.clone();
    plan_raw["nonce"] = json!("Q2W3E4");
    plan_raw["expires_s"] = json!(600);
    let plan = short_answer(&link, &mut helper, "tune.plan", sample.request.clone(), |req| json!({"id": req["id"], "ok": true, "result": plan_raw}));
    short_answer(&link, &mut helper, "power.plan", json!({"power": {"pl1_w": 200}}), |req| {
        json!({"id": req["id"], "ok": true, "result": {"plan_id": power_id, "nonce": "R3T4Y5", "writes": 1, "steps": [{"n": 1, "key": "pl1_w", "before": 250_000_000, "value": 200_000_000}]}})
    });
    // a profile's plan that writes a turbo table: the plan does not give the new ratios, so no dialog (fail closed)
    let mut profile_raw = sample.plan.clone();
    profile_raw["plan_id"] = json!(profile_id);
    profile_raw["nonce"] = json!("P2R3F4");
    short_answer(&link, &mut helper, "tune.plan", json!({"intent": {"profile": "good-p57"}}), |req| json!({"id": req["id"], "ok": true, "result": profile_raw}));
    let both = json!({"plans": [{"op": "tune.apply", "plan_id": tune_id}, {"op": "power.apply", "plan_id": power_id}]});
    let one = |id: &str| json!({"plan_id": id});
    let intent = sample.request["intent"].clone();

    let no = FixedConfirmer::new(Answer::No);
    let not_confirmed = confirm_plans(&link, &no, &both);
    let unavailable = confirm_plans(&link, &FixedConfirmer::new(Answer::Unavailable("no window".into())), &both);
    let stale = confirm_plans(&link, &no, &json!({"plans": [{"op": "tune.apply", "plan_id": gone_id}]}));
    let bad_args = confirm_plans(&link, &no, &json!({"plans": [{"op": "tune.apply", "plan_id": tune_id, "typed": "CONFIRM Q2W3E4"}]}));
    let never = FixedConfirmer::new(Answer::Yes);
    let undescribed = confirm_plans(&link, &never, &json!({"plans": [{"op": "tune.apply", "plan_id": profile_id}]}));
    assert!(never.asked().is_empty(), "no dialog for a plan the app cannot describe");
    let apply_unconfirmed = apply_confirmed(&link, PlanKind::Tune, &one(&tune_id), T);
    let apply_typed = apply_confirmed(&link, PlanKind::Tune, &json!({"plan_id": tune_id, "typed": "CONFIRM Q2W3E4"}), T);
    let apply_bad_intent = apply_confirmed(&link, PlanKind::Tune, &json!({"plan_id": tune_id, "intent": {"power": {"pl1_w": 200}}}), T);
    let yes = FixedConfirmer::new(Answer::Yes);
    let confirmed = confirm_plans(&link, &yes, &both);
    let dialog: Vec<ConfirmRequest> = yes.asked();
    // R-B1 (R-26): the page sends the intent its editor holds now; the shell forwards it with the code
    let apply_started = apply_confirmed(&link, PlanKind::Tune, &json!({"plan_id": tune_id, "intent": intent}), T);
    let wire = helper.request();
    let apply_spent = apply_confirmed(&link, PlanKind::Tune, &one(&tune_id), T);

    // persistent ops: one dialog per request, sent only on Yes; the shell completes a two-step accept and fails closed without a code
    let accept_args = json!({"name": "good-p57"});
    let accept_no = persist_confirmed(&link, &no, "profiles.accept", &accept_args, T);
    let accept_step2 = persist_confirmed(&link, &yes, "profiles.accept", &json!({"plan_id": "6".repeat(64), "typed": "CONFIRM Z9X8C7"}), T);
    let mut persist = |answers: Vec<Value>| -> (Value, Vec<Value>) {
        std::thread::scope(|s| {
            let h = s.spawn(|| {
                let mut seen = vec![];
                for a in answers {
                    let req = helper.request();
                    let mut ans = a;
                    ans["id"] = req["id"].clone();
                    helper.send(&ans);
                    seen.push(req);
                }
                seen
            });
            let r = persist_confirmed(&link, &yes, "profiles.accept", &accept_args, T);
            (r, h.join().unwrap())
        })
    };
    let (accept_one_step, _) = persist(vec![json!({"ok": true, "result": {"name": "good-p57", "replaced": []}})]);
    let (accept_two_step, two_wire) = persist(vec![
        json!({"ok": true, "result": {"confirm_required": true, "plan_id": "6".repeat(64), "nonce": "Z9X8C7", "expires_s": 600, "name": "good-p57"}}),
        json!({"ok": true, "result": {"name": "good-p57", "replaced": []}}),
    ]);
    let (accept_no_code, _) = persist(vec![json!({"ok": true, "result": {"confirm_required": true, "plan_id": "6".repeat(64), "name": "good-p57"}})]);
    json!({
        "plan": plan,
        "intent": intent,
        "confirm": {"confirmed": confirmed, "not_confirmed": not_confirmed, "unavailable": unavailable, "stale": stale, "bad_args": bad_args,
                    "undescribed": undescribed},
        "apply": {"unconfirmed": apply_unconfirmed, "typed_from_page": apply_typed, "bad_intent": apply_bad_intent, "started": apply_started, "spent": apply_spent},
        "wire_apply": wire,
        "accept": {"not_confirmed": accept_no, "step2_from_page": accept_step2, "one_step": accept_one_step, "two_step": accept_two_step,
                   "two_step_wire": two_wire, "no_code": accept_no_code},
        "dialog": dialog[0].text(),
        "shell_ops": ops::SHELL_OPS,
        "persist_ops": ops::PERSIST_OPS,
        "mutating_ops": ops::MUTATING_OPS,
    })
}

/// The dialog's items and text from plans of every kind (R-I1): the mock builds the same from the same records (contract.test.mjs).
fn dialog_samples() -> Value {
    let rec = |kind: PlanKind, plan: Value, request: Value, tables: Map<String, Value>| PlanRecord::new(kind, &"7".repeat(64), Some("Q2W3E4"), plan, request, tables);
    let sample = sample_tune_record();
    let mut no_tables = sample.clone();
    no_tables.tables.clear();
    let mut profile = sample.clone();
    profile.request = json!({"intent": {"profile": "good-p57"}});
    let mut cut = json!({"writes": 20, "units": [], "steps": [], "before": {}, "after": {}});
    for n in 0..20u64 {
        let unit = format!("P{n}");
        cut["steps"].as_array_mut().unwrap().push(json!({"kind": "write_vf_point", "unit": unit, "point": 3}));
        cut["before"][&unit] = json!({"3": {"ratio": 40, "offset_mv": 0.0, "v_target_v": null}});
        cut["after"][&unit] = json!({"3": {"ratio": 40, "offset_mv": if n < 14 { 5.0 } else { -5.0 }, "v_target_v": null}});
    }
    let oc = json!({"writes": 3, "units": ["P0"], "steps": [{"kind": "write_vf", "unit": "P0", "point": 0}, {"kind": "write_favored", "unit": "P0", "point": 0},
        {"kind": "write_granular", "unit": "P0", "point": 0}],
        "before": {"P0": {"0": {"ratio": 58, "offset_mv": -10.0, "v_target_v": 1.3}}}, "after": {"P0": {"0": {"ratio": 58, "offset_mv": -10.0, "v_target_v": 1.28}}}});
    let unread = json!({"writes": 2, "units": ["EC0", "ring"], "steps": [{"kind": "write_vf", "unit": "EC0", "point": 0}, {"kind": "write_ring_point", "unit": "ring", "point": 3}],
        "before": {"EC0": {"0": null}}, "after": {"EC0": {"0": {"ratio": 47, "offset_mv": -15.0, "v_target_v": 1.1}}, "ring": {"3": {"ratio": 40, "offset_mv": -9.766, "v_target_v": null}}}});
    let power = json!({"writes": 2, "steps": [{"n": 1, "key": "pl1_w", "before": 250_000_000, "value": 200_000_000}, {"n": 2, "key": "tau_s", "before": 56_000_000, "value": 28_000_000}]});
    let runtime = json!({"writes": 3, "steps": [{"domain": "caps", "key": "cpu8", "before": 4_900_000, "ratio": 40, "value": 4_000_000}, {"domain": "caps", "key": "cpu9", "before": 4_900_000, "ratio": 40, "value": 4_000_000},
        {"domain": "uncore", "key": "max_ratio", "before": 4_000_000, "value": 3_800_000}]});
    let cases = vec![
        ("sample", sample),
        ("tables_not_read", no_tables),
        ("profile_turbo", profile),
        ("cut", rec(PlanKind::Tune, cut, json!({}), Map::new())),
        ("oc_target_lowered", rec(PlanKind::Tune, oc, json!({}), Map::new())),
        ("unread_and_ring", rec(PlanKind::Tune, unread, json!({}), Map::new())),
        ("bad_step", rec(PlanKind::Tune, json!({"writes": 1, "steps": [{"kind": "write_mystery", "unit": "P0"}]}), json!({}), Map::new())),
        ("power", rec(PlanKind::Power, power, json!({}), Map::new())),
        ("power_bad", rec(PlanKind::Power, json!({"writes": 1, "steps": [{"key": "pl4_w", "value": 1}]}), json!({}), Map::new())),
        ("runtime", rec(PlanKind::Runtime, runtime, json!({}), Map::new())),
    ];
    let kind_name = |k: PlanKind| match k {
        PlanKind::Tune => "tune",
        PlanKind::Power => "power",
        PlanKind::Runtime => "runtime",
    };
    let mut items: Map<String, Value> = Map::new();
    let mut built: HashMap<&str, ConfirmItem> = HashMap::new();
    for (name, r) in &cases {
        let out = item_of(r);
        items.insert(
            (*name).to_string(),
            json!({
                "kind": kind_name(r.kind), "plan": r.plan, "request": r.request, "tables": r.tables,
                "item": out.as_ref().ok().map(|i| json!({"label": i.label, "writes": i.writes, "targets": i.targets, "raises": i.raises, "conditional": i.conditional})),
                "error": out.as_ref().err(),
            }),
        );
        if let Ok(i) = out {
            built.insert(name, i);
        }
    }
    let texts: Vec<Value> = [vec!["sample"], vec!["sample", "power", "runtime"], vec!["cut"], vec!["oc_target_lowered", "unread_and_ring"]]
        .into_iter()
        .map(|names| json!({"items": names, "text": ConfirmRequest { items: names.iter().map(|n| built[n].clone()).collect() }.text()}))
        .collect();
    json!({"cases": items, "texts": texts})
}

/// The argument checks the mock mirrors (R-I1): each `{op, args}` with the shell's verdict (`ops::check` on the wire, `webview_apply_args` from the page).
fn validator_samples() -> Value {
    let id = "a".repeat(64);
    let rows = json!({"scope": "unit", "rows": [{"target": "P0", "offset": {"kind": "points", "mv": {"53": -20}}, "v_target_v": null, "ratio": null}]});
    let wire: Vec<(&str, Value)> = vec![
        ("preflight", json!({})),
        ("preflight", json!({"client": {"name": "linux-xtu-desktop", "version": "0.2.0-dev", "protocol": 1}})),
        ("preflight", json!({"client": {"protocol": -1}})),
        ("preflight", json!({"client": {"name": "", "protocol": 1}})),
        ("preflight", json!({"client": {"uid": 0}})),
        ("tune.plan", json!({"intent": rows})),
        ("tune.plan", json!({"intent": {"scope": "unit", "rows": []}})),
        ("tune.plan", json!({"intent": {"turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 55]}, "ring": {"points": {"3": -10}}}})),
        ("tune.plan", json!({"intent": {"profile": "good-p57"}})),
        ("tune.plan", json!({"intent": {"restore": "accepted"}})),
        ("tune.plan", json!({"intent": {"reset": "stock"}})),
        ("tune.plan", json!({"intent": {}})),
        ("tune.plan", json!({"intent": {"rows": []}})),
        ("tune.plan", json!({"intent": {"scope": "unit", "rows": [{"target": "P0", "offset": {"kind": "curve", "mv": -20.5}}]}})),
        ("tune.plan", json!({"intent": {"scope": "unit", "rows": [{"target": "P0", "ratio": 58}, {"target": "P0", "offset": {"kind": "curve", "mv": -5}}]}})),
        ("tune.plan", json!({"intent": {"scope": "unit", "rows": [{"target": "P01", "ratio": 58}]}})),
        ("tune.plan", json!({"intent": {"scope": "unit", "rows": [{"target": "P0", "v_target_v": 4.2}]}})),
        ("tune.plan", json!({"intent": {"turbo": {"P": [57, 57, 55]}}})),
        ("tune.plan", json!({"intent": {"ring": {"points": {"0": -5}}}})),
        ("tune.plan", json!({"intent": {"profile": "x", "reset": "stock"}})),
        ("power.plan", json!({"power": {"pl1_w": 200, "tau_s": null}})),
        ("power.plan", json!({"revert": true})),
        ("power.plan", json!({"profile": "good-p57"})),
        ("power.plan", json!({"restore": "accepted"})),
        ("power.plan", json!({"restore": "boot"})),
        ("power.plan", json!({"profile": "x", "power": {"pl1_w": 200}})),
        ("power.plan", json!({"power": {"pl1_w": null}})),
        ("runtime.plan", json!({"caps": {"8": 40}, "uncore": {"max_ratio": 38}})),
        ("runtime.plan", json!({"profile": "good-p57"})),
        ("runtime.plan", json!({"restore": "accepted"})),
        ("runtime.plan", json!({"restore": "accepted", "caps": {"8": 40}})),
        ("runtime.plan", json!({"parking": {"3": false}})),
        ("profiles.save", json!({"name": "mine", "intent": {"scope": "unit", "rows": []}})),
        ("profiles.save", json!({"name": "mine", "intent": rows, "power": {"pl1_w": 200}, "runtime": {"caps": {"8": 40}}})),
        ("profiles.save", json!({"name": "mine", "power": null, "runtime": {"uncore": {"min_ratio": 8}}})),
        ("profiles.save", json!({"name": "mine", "from": "read"})),
        ("profiles.save", json!({"name": "mine", "from": "read", "power": {"pl1_w": 200}})),
        ("profiles.save", json!({"name": "mine"})),
        ("profiles.save", json!({"name": "mine", "intent": {"profile": "x"}})),
        ("profiles.save", json!({"name": "mine", "runtime": {"revert": true}})),
        ("profiles.save", json!({"name": "mine", "power": {}})),
        ("profiles.accept", json!({"name": "good-p57"})),
        ("profiles.accept", json!({"name": ".hidden"})),
        ("profiles.accept", json!({"name": "a..b"})),
        ("profiles.accept", json!({"from": "read", "set_aside_unreadable": true})),
        ("profiles.accept", json!({"plan_id": id, "typed": "CONFIRM ABCDEF"})),
        ("tune.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF"})),
        ("tune.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "intent": rows})),
        ("tune.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "intent": {"power": {"pl1_w": 200}}})),
        ("power.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "intent": {"restore": "accepted"}})),
        ("runtime.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF", "intent": {"caps": {"8": 0}}})),
    ];
    let page: Vec<(&str, Value)> = vec![
        ("tune.apply", json!({"plan_id": id})),
        ("tune.apply", json!({"plan_id": id, "intent": rows})),
        ("tune.apply", json!({"plan_id": id, "intent": {"profile": "good-p57"}})),
        ("tune.apply", json!({"plan_id": id, "intent": {}})),
        ("tune.apply", json!({"plan_id": id, "intent": {"power": {"pl1_w": 200}}})),
        ("tune.apply", json!({"plan_id": id, "typed": "CONFIRM ABCDEF"})),
        ("tune.apply", json!({"plan_id": id, "extra": 1})),
        ("power.apply", json!({"plan_id": id, "intent": {"power": {"pl1_w": 200}}})),
        ("power.apply", json!({"plan_id": id, "intent": {"revert": true}})),
        ("power.apply", json!({"plan_id": id, "intent": rows})),
        ("runtime.apply", json!({"plan_id": id, "intent": {"caps": {"8": 40}}})),
        ("runtime.apply", json!({"plan_id": id, "intent": {"profile": "good-p57"}})),
        ("runtime.apply", json!({"plan_id": id, "intent": {"parking": {"3": false}}})),
    ];
    let checked = |(op, args): (&str, Value)| {
        let ok = ops::check(op, &args).is_ok();
        json!({"op": op, "args": args, "ok": ok})
    };
    let from_page = |(op, args): (&str, Value)| {
        let kind = ops::apply_kind(op).unwrap();
        let ok = ops::webview_apply_args(kind, &args).is_ok();
        json!({"op": op, "args": args, "ok": ok})
    };
    let e = ops::check("power.plan", &json!({"restore": "boot"})).unwrap_err();
    json!({"wire": wire.into_iter().map(checked).collect::<Vec<_>>(), "page": page.into_iter().map(from_page).collect::<Vec<_>>(),
           "refusal": error_reply(e.code, &e.message, None)})
}

/// A raw helper preflight answer carrying `helper` (and, when the client declared itself, `client`).
fn helper_preflight(id: &str, helper: Value, client_ok: Option<bool>) -> Value {
    let mut result = json!({"mode": "write", "writes_allowed": true, "checks": [{"name": "cpuid", "status": "pass", "reason": "family 6 model 198"}], "helper": helper});
    if let Some(ok) = client_ok {
        result["client"] = json!({"name": "linux-xtu-desktop", "version": "0.2.0-dev", "protocol": version::PROTOCOL, "protocol_ok": ok});
    }
    json!({"id": id, "ok": true, "result": result})
}

/// The version handshake (R-I1): what the shell sends, and for each helper answer the status's `version` and the preflight the webview gets.
fn version_samples() -> Value {
    let same = json!({"version": "0.2.0-dev", "protocol": version::PROTOCOL, "ops_hash": version::built_ops_hash(), "ops": ops::ALLOWED_OPS.len()});
    let cases = vec![
        ("match", helper_preflight("d900010", same.clone(), Some(true))),
        ("protocol_differs", helper_preflight("d900011", json!({"version": "0.3.0", "protocol": version::PROTOCOL + 1, "ops_hash": version::built_ops_hash(), "ops": 32}), Some(false))),
        ("older_helper", json!({"id": "d900012", "ok": true, "result": {"mode": "write", "writes_allowed": true, "checks": []}})),
        ("ops_differ", helper_preflight("d900013", json!({"version": "0.2.1", "protocol": version::PROTOCOL, "ops_hash": "0".repeat(64), "ops": 33}), Some(true))),
        ("preflight_failed", json!({"id": "d900014", "ok": false, "error": {"code": "PREFLIGHT_FAILED", "message": "the helper's preflight failed", "detail": {"helper": same}}})),
    ];
    let mut out = Map::new();
    for (name, raw) in cases {
        let v = VersionCheck::of(&raw);
        out.insert(name.into(), json!({"raw": raw, "version": v.to_value(), "webview": v.decorate(public_response(&raw))}));
    }
    json!({"client": version::client(), "preflight_args": version::preflight_args(), "cases": out})
}

/// The whole sample document, ids not yet made stable.
fn build() -> Value {
    let installed = Target::installed();
    // literal ids are far above what the process-wide counter reaches in a test run, so the renaming below never merges two ids
    let same = json!({"version": "0.2.0-dev", "protocol": version::PROTOCOL, "ops_hash": version::built_ops_hash(), "ops": ops::ALLOWED_OPS.len()});
    let raw_preflight = helper_preflight("d900001", same, Some(true));
    let checked = VersionCheck::of(&raw_preflight);
    let preflight = checked.decorate(public_response(&raw_preflight));

    // ---- a live link: events, a short op, a long op, an error with every detail key the helper sends ----
    let (client, mut helper) = pair();
    let (sink, rx) = collect_sink();
    let link = Link::start(client, sink).unwrap();
    let mut events = Map::new();
    let mut take = |rx: &std::sync::mpsc::Receiver<(String, Value)>, ui: &str, name: &str| {
        events.insert(ui.to_string(), json!({"name": name, "payload": next_event(rx, name)}));
    };

    helper.send(&json!({"event": "heartbeat", "op_id": null, "state": "idle", "ops_used": 3, "ops_budget": 100000}));
    take(&rx, "heartbeat", "helper://heartbeat");
    let ok = short_answer(&link, &mut helper, "profiles.list", json!({}), |req| json!({"id": req["id"], "ok": true, "result": {"profiles": []}}));

    let Ok(Reply::Started(measure)) = link.call("vf.measure", &json!({"mode": "quick"}), T) else { panic!("vf.measure is a long op") };
    helper.request();
    let started = started_reply(&measure);
    helper.send(&json!({"event": "state", "op_id": measure, "state": "measuring"}));
    take(&rx, "state", "helper://state");
    helper.send(&json!({"event": "progress", "op_id": measure, "step": 1, "of": 2}));
    take(&rx, "progress", "helper://progress");
    helper.send(&json!({"event": "vf.point", "op_id": measure, "unit": "P0", "ratio": 13, "mhz": 1300, "vid_v": 0.71, "status": "ok"}));
    take(&rx, "vf.point", "helper://vf-point");
    helper.send(&json!({"event": "telemetry", "op_id": "d900002", "t": 1700000000.5, "values": {"power": {"package": {"value": 85.2, "unit": "W", "source": "rapl"}}}}));
    take(&rx, "telemetry", "helper://telemetry");
    // every detail key the helper's ops raise (ops_tune / ops_measure / ops_power / ops_runtime / core), and more problems than the cap
    let problems: Vec<String> = (1..=12).map(|n| format!("P0 point {n}: no stable reading")).collect();
    helper.send(&json!({"id": measure, "ok": false, "error": {"code": "CANCELLED", "message": "vf.measure was cancelled; the points measured so far were kept",
        "detail": {"check": "PLAN_ERROR", "writes_sent": 0, "ops_done": 3, "key": "pl1_w", "state": "idle", "curve_id": "20261111T101500Z-a1b2",
                   "problems": problems, "partial": {"units": {"P0": {"points": []}}}, "tripped": false, "op_id": measure, "path": "/etc/linux-xtu/policy.toml"}}}));
    let error_detail = next_event(&rx, "helper://result");
    events.insert("result".into(), json!({"name": "helper://result", "payload": error_detail.clone()}));

    let Ok(Reply::Started(read)) = link.call("tune.read", &json!({}), T) else { panic!("tune.read is a long op") };
    helper.request();
    let latest = {
        // the live status: `latest` holds the last state / heartbeat events
        let s = Status::of(&installed, Some(&link), Some(preflight.clone()), None).with_version(Some(&checked)).to_value();
        assert_eq!(s["pending_long"], 1);
        s
    };
    drop(helper); // the helper goes away with tune.read in flight
    let link_lost_event = next_event(&rx, "helper://result");
    assert_eq!(link_lost_event["id"], read.as_str());
    events.insert("closed".into(), json!({"name": "helper://closed", "payload": next_event(&rx, "helper://closed")}));
    let lost = Status::of(&installed, Some(&link), Some(preflight.clone()), None).with_version(Some(&checked)).to_value();
    let link_lost_call = {
        let Err(e) = link.call("preflight", &json!({}), T) else { panic!("a dead link refuses") };
        assert!(matches!(e, CallError::Unavailable));
        let (code, message) = e.code_message();
        error_reply(&code, &message, None)
    };

    // ---- failed connects, as `helper_status` reports them after `helper_connect` ----
    let mut failed = Map::new();
    for e in connect_failures() {
        let kind = e.kind.as_str().to_string();
        failed.insert(kind, Status::of(&installed, None, None, Some(&e)).to_value());
    }
    let missing = check_node(&installed, &Fake(Err(io::ErrorKind::NotFound.into()))).unwrap_err();
    let refusal = ops::check("mailbox.write", &json!({"word": 1})).unwrap_err();
    // the events a refused handshake emits: its Link's reader ends too, so the webview sees `closed` for an attempt that never came up
    let failed_connect_events: Vec<Value> = {
        let (client, mut helper) = pair();
        helper.send_raw(fixture("refused_client_busy.jsonl").as_bytes());
        drop(helper);
        let (sink, rx) = collect_sink();
        let _ = handshake(client, sink, WHO, T).err().expect("refused");
        rx.try_iter().map(|(name, payload)| json!({"name": name, "payload": payload})).collect()
    };

    json!({
        "_about": "Generated by desktop/app/src-tauri/tests/contract_samples.rs from the shell's real code; do not edit. Regenerate: LINUX_XTU_UPDATE_CONTRACT=1 cargo test --manifest-path desktop/app/src-tauri/Cargo.toml --test contract_samples",
        "status": {
            "connected": latest,
            "failed": failed,
            "lost": lost,
            "not_connected": Status::of(&installed, None, None, None).to_value(),
        },
        "call": {
            "ok": ok,
            "started": started,
            "error_detail": error_detail,
            "not_connected": not_connected_reply(&missing),
            "not_connected_lost": not_connected_reply(&ConnectError::lost("eof")),
            "refused_locally": error_reply(refusal.code, &refusal.message, None),
            "link_lost": link_lost_call,
        },
        "events": events,
        "failed_connect_events": failed_connect_events,
        "link_lost_result": link_lost_event,
        "confirm": confirm_samples(),
        "dialog": dialog_samples(),
        "validators": validator_samples(),
        "version": version_samples(),
        "detail_allow": {
            "scalars": DETAIL_SCALARS,
            "lists": DETAIL_LISTS.iter().map(|(k, n)| ((*k).to_string(), json!(n))).collect::<Map<String, Value>>(),
            "str_max": DETAIL_STR_MAX,
        },
    })
}

/// Request ids come from a process-wide counter (tests run in parallel): rename them `d1`, `d2`, … in order of first appearance.
fn stable_ids(v: &mut Value, seen: &mut HashMap<String, String>) {
    match v {
        Value::Object(m) => {
            for (k, child) in m.iter_mut() {
                if k == "id" || k == "op_id" {
                    if let Value::String(s) = child {
                        if s.len() > 1 && s.starts_with('d') && s[1..].bytes().all(|b| b.is_ascii_digit()) {
                            let n = seen.len() + 1;
                            *s = seen.entry(s.clone()).or_insert_with(|| format!("d{n}")).clone();
                            continue;
                        }
                    }
                }
                stable_ids(child, seen);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|c| stable_ids(c, seen)),
        _ => {}
    }
}

fn rendered() -> String {
    let mut v = build();
    stable_ids(&mut v, &mut HashMap::new());
    serde_json::to_string_pretty(&v).unwrap() + "\n"
}

#[test]
fn the_checked_in_samples_match_what_the_shell_produces() {
    let now = rendered();
    assert_eq!(now, rendered(), "the samples are not deterministic");
    let path = samples_path();
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    if now == checked_in {
        return;
    }
    if std::env::var(UPDATE_ENV).as_deref() == Ok("1") {
        std::fs::write(&path, &now).unwrap();
        return;
    }
    let first = now.lines().zip(checked_in.lines()).position(|(a, b)| a != b).unwrap_or_else(|| now.lines().count().min(checked_in.lines().count()));
    panic!(
        "{} is out of date with the shell (first difference at line {}: {:?}). If the change is intended, run {UPDATE_ENV}=1 cargo test --test contract_samples, \
         then make ui/bridge.js, the mock backend and ui/tests/contract.test.mjs agree with the new samples.",
        path.display(),
        first + 1,
        now.lines().nth(first).unwrap_or("<end>")
    );
}

#[test]
fn the_confirmation_contract_holds() {
    let c = confirm_samples();
    assert!(c["plan"]["result"].get("nonce").is_none(), "the webview's plan has no code");
    let confirmed = &c["confirm"]["confirmed"]["result"];
    assert_eq!((confirmed["confirmed"].as_bool(), confirmed["plans"].as_u64(), confirmed["writes"].as_u64()), (Some(true), Some(2), Some(9)));
    assert_eq!(confirmed["dialog"], c["dialog"], "the answer carries the text the operator confirmed");
    for (k, code) in [("not_confirmed", "NOT_CONFIRMED"), ("unavailable", "CONFIRM_UNAVAILABLE"), ("stale", "PLAN_STALE"), ("bad_args", "BAD_REQUEST"), ("undescribed", "CONFIRM_UNAVAILABLE")] {
        assert_eq!(c["confirm"][k]["error"]["code"], code, "{k}");
        assert_eq!(c["confirm"][k]["error"]["detail"]["writes_sent"], 0, "{k}: confirming never writes");
    }
    assert!(c["confirm"]["undescribed"]["error"]["message"].as_str().unwrap().contains("new ratios of turbo table P"));
    for (k, code) in [("unconfirmed", "NOT_CONFIRMED"), ("typed_from_page", "BAD_REQUEST"), ("bad_intent", "BAD_REQUEST"), ("spent", "PLAN_STALE")] {
        assert_eq!(c["apply"][k]["error"]["code"], code, "{k}");
        assert_eq!(c["apply"][k]["error"]["detail"]["writes_sent"], 0, "{k}: nothing was sent");
    }
    assert_eq!(c["apply"]["started"]["pending"], true);
    assert_eq!(c["wire_apply"]["args"]["typed"], "CONFIRM Q2W3E4", "the helper gets the code the shell kept");
    assert_eq!(c["wire_apply"]["args"]["intent"], c["intent"], "and the intent the page holds now");
    assert_eq!(c["dialog"]["ok_label"], "Apply 9 writes");
    let text = c["dialog"]["secondary"].as_str().unwrap();
    for line in ["↑ P2 · OC point · ratio unset → 58× · target unset → 1.250 V", "P0 · point 5 · 53× · offset 0 → −19.5 mV", "turbo table P · 57 57 55 55 55 55 55 55 → 56 56 54 54 54 54 54 54", "• PL1 250 → 200 W"] {
        assert!(text.contains(line), "the dialog names {line:?}:\n{text}");
    }
    for (k, code) in [("not_confirmed", "NOT_CONFIRMED"), ("step2_from_page", "BAD_REQUEST"), ("no_code", "BAD_REQUEST")] {
        assert_eq!(c["accept"][k]["error"]["code"], code, "{k}");
        assert_eq!(c["accept"][k]["error"]["detail"]["writes_sent"], 0, "{k}");
    }
    assert_eq!(c["accept"]["one_step"]["result"]["name"], "good-p57");
    assert_eq!(c["accept"]["two_step"]["result"]["name"], "good-p57");
    assert_eq!(c["accept"]["two_step_wire"][1]["args"]["typed"], "CONFIRM Z9X8C7", "step 2 sent by the shell");
    assert!(c["accept"]["two_step"]["result"].get("nonce").is_none());
}

/// `tauri-2.12.4/src/event/event_name.rs` `is_event_name_valid`: alphanumerics, `-`, `/`, `:`, `_` (an emit or listen with any other
/// character fails, and the link's emits ignore the error). Every name the link emits must pass.
fn tauri_accepts(name: &str) -> bool {
    name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '/' || c == ':' || c == '_')
}

#[test]
fn every_emitted_event_name_is_one_tauri_accepts() {
    let v = build();
    let events = v["events"].as_object().unwrap();
    for ui in ["heartbeat", "state", "progress", "telemetry", "vf.point", "result", "closed"] {
        let name = events[ui]["name"].as_str().unwrap();
        assert!(tauri_accepts(name), "{name}");
        assert!(name.starts_with("helper://"));
    }
    assert!(!tauri_accepts("helper://vf.point"), "the rule as Tauri applies it");
}

/// With the dev seam, the real `HelperState` (the object behind the commands) answers in exactly the sampled shapes.
#[cfg(feature = "dev-socket")]
mod real_state {
    use super::*;
    use linux_xtu_desktop_lib::helper::connect::SysProbe;
    use linux_xtu_desktop_lib::helper::{Connect, HelperState};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    /// Same keys, and the same JSON type under each key (nested one level for `last_error` / `error` / `detail`).
    fn same_shape(a: &Value, b: &Value, path: &str) {
        let kind = |v: &Value| match v {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        };
        assert_eq!(kind(a), kind(b), "{path}: {a} vs {b}");
        if let (Value::Object(x), Value::Object(y)) = (a, b) {
            let mut kx: Vec<_> = x.keys().collect();
            let mut ky: Vec<_> = y.keys().collect();
            kx.sort();
            ky.sort();
            assert_eq!(kx, ky, "{path}: keys differ");
            for k in ["last_error", "error", "detail"] {
                if let (Some(p), Some(q)) = (x.get(k), y.get(k)) {
                    same_shape(p, q, &format!("{path}.{k}"));
                }
            }
            for (k, v) in x {
                if !["last_error", "error", "detail"].contains(&k.as_str()) {
                    assert_eq!(kind(v), kind(&y[k]), "{path}.{k}");
                }
            }
        }
    }

    #[test]
    fn the_real_state_answers_in_the_sampled_shapes() {
        let s = build();
        let dir = TempDir::new("contract");
        let (sink, rx) = collect_sink();
        let sock = dir.0.join("h.sock");
        let st = HelperState::with_parts(Target::dev(&sock), Box::new(SysProbe), sink, T);

        same_shape(&st.status(), &s["status"]["not_connected"], "status before any connect");
        same_shape(&st.call("preflight", &json!({}), Connect::Never), &s["call"]["not_connected"], "call before any connect");
        let failed = st.connect();
        assert_eq!(failed["last_error"]["kind"], "missing");
        same_shape(&failed, &s["status"]["failed"]["missing"], "failed connect");
        same_shape(&st.call("rm", &json!({}), Connect::Never), &s["call"]["refused_locally"], "refused locally");

        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (c, _) = listener.accept().unwrap();
            let mut w = c.try_clone().unwrap();
            let mut r = BufReader::new(c);
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let pre: Value = serde_json::from_str(&line).unwrap();
            writeln!(w, "{}", json!({"id": pre["id"], "ok": true, "result": {"writes_allowed": false}})).unwrap();
            writeln!(w, "{}", json!({"event": "heartbeat", "op_id": null, "state": "idle", "ops_used": 0, "ops_budget": 1})).unwrap();
            writeln!(w, "{}", json!({"event": "state", "op_id": null, "state": "idle"})).unwrap();
            line.clear();
            r.read_line(&mut line).unwrap(); // tune.read: never answered; the helper then goes away
            line
        });
        let up = st.connect();
        assert_eq!(up["connected"], true, "{up}");
        next_event(&rx, "helper://state");
        same_shape(&st.status(), &s["status"]["connected"], "connected status");
        same_shape(&st.call("tune.read", &json!({}), Connect::Never), &s["call"]["started"], "long op started");
        server.join().unwrap();
        same_shape(&next_event(&rx, "helper://result"), &s["link_lost_result"], "LINK_LOST result");
        next_event(&rx, "helper://closed");
        let lost = st.status();
        same_shape(&lost, &s["status"]["lost"], "lost status");
        assert_eq!(lost["last_error"], s["status"]["lost"]["last_error"]);
        same_shape(&st.call("preflight", &json!({}), Connect::Never), &s["call"]["not_connected_lost"], "call after the loss");
        assert_eq!(st.call("preflight", &json!({}), Connect::Never), s["call"]["not_connected_lost"]);
    }
}
