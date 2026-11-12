//! One live connection to the helper: request/response matching, id allocation, event emission (PLAN §3.1; mirrors
//! `src/linux_xtu/web/helperlink.py` `HelperLink`).
//!
//! * Every request passes [`ops::check`] right before it is written: nothing outside the allowlist reaches the socket.
//! * A reader thread owns the read half. It dispatches responses by id, publishes events as `helper://<name>` (dots become `-`:
//!   Tauri event names allow only alphanumerics, `-`, `/`, `:` and `_`), and on EOF fails every waiter. Malformed, non-object or
//!   oversize lines are dropped; they never end the reader.
//! * Short ops are waited for by the caller. Long ops return their id at once; the final response is emitted as `helper://result`.
//! * An op in flight when the link dies is reported lost (`LINK_LOST`), never replayed.
//! * Confirmation (D-053 item 4, assessment F-06): a plan's `nonce` stays here. It is kept from the `*.plan` answer and removed from what
//!   the webview sees ([`public_response`]). [`Link::call`] refuses every op the operator must confirm (`*.apply`, `ops::PERSIST_OPS`):
//!   only [`Link::apply`] sends an apply, for a plan the operator approved in the native dialog ([`Link::approve`], called by
//!   `HelperState` after the human's OK), adding `typed` from the kept nonce, spent on use; only [`Link::persist`] sends a persistent op,
//!   right after the dialog `HelperState` showed for that request, and completes a two-step accept itself (fail closed).
//! * What the dialog shows (R-I1): each kept plan also keeps the request the shell sent for it and the turbo tables the helper's own answers
//!   reported by then (`tune.read` / `tune.last` `tables`, folded with the read-backs of a `tune.apply`): a plan lists a table write without
//!   its ratios, so the dialog takes the new ones from the tune intent the plan was made from and the old ones from those answers.

use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::frame::{encode_line, read_frame, Frame, MAX_LINE};
use super::ops::{self, plan_role, PlanKind, Refusal};

pub const EVENT_PREFIX: &str = "helper://";
/// Long ops (`server.py` `max_pending_long`) a client may have in flight at once.
pub const MAX_PENDING_LONG: usize = 4;
/// A send that blocks this long means the helper stopped reading (it drops such clients itself after the same time).
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
/// `error.detail` keys that reach the webview as one scalar each (a string is cut to [`DETAIL_STR_MAX`] characters). Each is read by the
/// UI: `check` (every refusal), `state` (stress), `curve_id` (curves: the partial curve kept), `key` (power/runtime: the field a refusal
/// names), `writes_sent` (apply drawer, G-241: "Nothing was written" when 0). `ui/tests/contract.test.mjs` checks that every
/// `detail.<key>` the UI reads is listed here or in [`DETAIL_LISTS`]. (The browser GUI's `server.py` `_DETAIL_ALLOW` is narrower; that
/// GUI is being retired.)
pub const DETAIL_SCALARS: [&str; 5] = ["state", "check", "curve_id", "key", "writes_sent"];
/// `error.detail` keys that may carry a list of strings, with the most items kept: `problems` (a failed or cancelled vf.measure's
/// notes; the helper caps them at 10 itself). A longer list keeps `max - 1` items and says how many were left out, never a silent cut.
pub const DETAIL_LISTS: [(&str, usize); 1] = [("problems", 10)];
/// Longest string kept in `detail` (a scalar or one list item), in characters.
pub const DETAIL_STR_MAX: usize = 500;
/// Plan ids remembered per connection and kind (`*.apply` is accepted only for one of these).
const MAX_PLANS: usize = 8;
/// How long the operator's OK in the native dialog stays good for a plan it named (the helper's own plans expire after 600 s).
pub const APPROVAL_TTL: Duration = Duration::from_secs(600);

/// A plan this connection received: its id, the confirmation code the helper made for it (never shown to the webview), the plan itself
/// (what the native dialog summarises), the request the shell sent for it (the dialog reads a turbo table's new ratios from a tune intent:
/// the plan lists only "write table P"), the turbo tables the helper's answers had reported when it was made (the dialog's "before"), and
/// whether the operator approved it.
#[derive(Debug, Clone)]
pub struct PlanRecord {
    pub kind: PlanKind,
    pub plan_id: String,
    pub nonce: Option<String>,
    pub plan: Value,
    pub request: Value,
    pub tables: Map<String, Value>,
    approved_at: Option<Instant>,
}

impl PlanRecord {
    /// A record as the link keeps it (tests and the contract samples build the dialog from one).
    pub fn new(kind: PlanKind, plan_id: &str, nonce: Option<&str>, plan: Value, request: Value, tables: Map<String, Value>) -> PlanRecord {
        PlanRecord { kind, plan_id: plan_id.to_string(), nonce: nonce.map(str::to_string), plan, request, tables, approved_at: None }
    }

    pub fn approved(&self) -> bool {
        self.approved_at.is_some_and(|t| t.elapsed() <= APPROVAL_TTL)
    }
}

/// The eight ratios of a turbo table as the helper reports them (`tables: {e, p}` of `tune.read`): 8 integers 0..255.
pub fn turbo_ratios_ok(v: &Value) -> bool {
    v.as_array().is_some_and(|b| b.len() == 8 && b.iter().all(|r| r.as_u64().is_some_and(|x| x <= 255)))
}

/// Why a confirmed op was not sent. Nothing reached the socket in any of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyRefusal {
    /// No plan of that kind with that id on this connection (never made here, spent, pushed out, or another connection's).
    UnknownPlan,
    /// The plan carries no confirmation code (a malformed plan), or a two-step accept answered no usable code: nothing was accepted.
    NoNonce,
    /// The operator has not approved it (or the approval expired).
    NotApproved,
}

/// Outcome of a [`Link::apply`] that did not produce a [`Reply`].
#[derive(Debug)]
pub enum ApplyError {
    /// Refused here; nothing was sent.
    Refused(ApplyRefusal),
    /// The send failed (as for [`Link::call`]).
    Call(CallError),
}
/// Request ids come from one process-wide counter: an id is never reused across reconnects, so a late answer to an old
/// connection's request can never match a new one.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Where the link publishes events. The Tauri build wraps an `AppHandle`; tests collect.
pub trait EventSink: Send + Sync + 'static {
    /// `name` is the full event name (`helper://state`).
    fn emit(&self, name: &str, payload: Value);
}

#[derive(Debug)]
pub enum CallError {
    /// Refused before anything was written (not allowlisted / wrong argument shape).
    Refused(Refusal),
    /// The request would not fit in 64 KiB.
    TooLarge,
    /// [`MAX_PENDING_LONG`] long ops are already in flight.
    TooManyLong,
    /// The link is closed, or the write failed: the request may not have been sent and is not retried.
    Unavailable,
    /// No answer in time (the helper may still be working: watch the events).
    Timeout,
}

impl CallError {
    /// `(code, message)` as the webview sees them.
    pub fn code_message(&self) -> (String, String) {
        match self {
            CallError::Refused(r) => (r.code.to_string(), r.message.clone()),
            CallError::TooLarge => ("BAD_REQUEST".into(), "refused locally: the request exceeds the 64 KiB line limit".into()),
            CallError::TooManyLong => ("BUSY".into(), format!("refused locally: {MAX_PENDING_LONG} long operations are already running")),
            CallError::Unavailable => (
                "LINK_LOST".into(),
                "the helper connection is closed; the request was not replayed. Retry to reconnect.".into(),
            ),
            CallError::Timeout => ("TIMEOUT".into(), "no answer from the helper in time; it may still be working (watch the events)".into()),
        }
    }
}

/// Outcome of [`Link::call`].
#[derive(Debug)]
pub enum Reply {
    /// A short op's raw helper response (`{id, ok, result|error}`).
    Done(Value),
    /// A long op was sent; its final response arrives as the `helper://result` event.
    Started(String),
}

enum Waiter {
    Short(Sender<Option<Value>>),
    /// A long op in flight, by name (its final answer may tell the link the turbo tables the CPU holds).
    Long(String),
}

#[derive(Default)]
struct State {
    alive: bool,
    /// Why the reader ended (`eof` / `read error`), once it has.
    closed: Option<String>,
    finished: bool,
    pending: HashMap<String, Waiter>,
    latest: HashMap<String, Value>,
    refusal: Option<Value>,
    /// Successful `*.plan` responses on this connection, oldest first; one bounded set per [`PlanKind`], so a plan id of one kind is
    /// never accepted by another kind's `*.apply`.
    plans: [VecDeque<PlanRecord>; PlanKind::COUNT],
    /// The turbo tables (`"e"` / `"p"` -> 8 ratios) the helper's own answers last reported: `tune.read` / `tune.last` `tables`, then the
    /// read-backs of the table writes of a `tune.apply` (as the helper folds them, ops_tune.py `_fold_applied_tables`). A table no answer
    /// vouches for is absent: the dialog then says "not read".
    tables: Map<String, Value>,
}

impl State {
    /// `tables` of a `tune.read` result (or of the read inside a `tune.last` result): what the helper now holds as the tables in force.
    fn take_tables(&mut self, read: &Value) {
        let Some(tables) = read.get("tables") else { return };
        for key in ["e", "p"] {
            match tables.get(key).filter(|t| turbo_ratios_ok(t)) {
                Some(t) => {
                    self.tables.insert(key.to_string(), t.clone());
                }
                None => {
                    self.tables.remove(key);
                }
            }
        }
    }

    /// The final answer of a `tune.apply`: each turbo-table write read back equal becomes the table in force (the read-back word, bucket 0 in
    /// bits 7:0); a refusal that wrote nothing (`writes_sent: 0`) changes nothing; after any other failed or partial apply a table may hold
    /// anything, so both are forgotten.
    fn fold_apply(&mut self, resp: &Value) {
        let wrote_nothing = resp.get("error").and_then(|e| e.get("detail")).and_then(|d| d.get("writes_sent")).and_then(Value::as_u64) == Some(0);
        if resp.get("ok") != Some(&Value::Bool(true)) && wrote_nothing {
            return;
        }
        let result = resp.get("result").filter(|_| resp.get("ok") == Some(&Value::Bool(true)));
        if result.and_then(|r| r.get("complete")) != Some(&Value::Bool(true)) {
            self.tables.clear();
            return;
        }
        let rows = result.and_then(|r| r.get("readback")).and_then(Value::as_array).cloned().unwrap_or_default();
        for row in rows.iter().filter(|r| r.get("point").and_then(Value::as_str) == Some("turbo")) {
            let Some(key) = row.get("unit").and_then(Value::as_str).map(str::to_ascii_lowercase).filter(|k| k == "e" || k == "p") else { continue };
            let word = row.get("actual").and_then(Value::as_str).and_then(|s| s.strip_prefix("0x")).and_then(|h| u64::from_str_radix(h, 16).ok());
            match word.filter(|_| row.get("match") == Some(&Value::Bool(true))) {
                Some(w) => {
                    self.tables.insert(key, Value::Array((0..8).map(|k| Value::from((w >> (8 * k)) & 0xFF)).collect()));
                }
                None => {
                    self.tables.remove(&key);
                }
            }
        }
    }
}

struct Shared {
    state: Mutex<State>,
    finished: Condvar,
    sink: Arc<dyn EventSink>,
    stream: UnixStream,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, name: &str, payload: Value) {
        self.sink.emit(&format!("{EVENT_PREFIX}{name}"), payload);
    }

    /// The pipe is over: fail every waiter (short: `None`; long: a `result` event saying the op was lost).
    fn fail_all(&self, reason: &str) {
        let pending = {
            let mut st = self.lock();
            st.alive = false;
            st.closed = Some(reason.to_string());
            std::mem::take(&mut st.pending)
        };
        for (id, waiter) in pending {
            match waiter {
                Waiter::Short(tx) => {
                    let _ = tx.send(None);
                }
                Waiter::Long(_) => self.emit(
                    "result",
                    json!({"id": id, "ok": false, "error": {"code": "LINK_LOST", "message":
                        "the helper connection was lost while this operation was running; its outcome is unknown and it was not replayed"}}),
                ),
            }
        }
        let _ = self.stream.shutdown(Shutdown::Both);
        self.emit("closed", json!({"reason": reason}));
        self.lock().finished = true;
        self.finished.notify_all();
    }

    fn dispatch(&self, obj: Map<String, Value>) {
        match obj.get("id") {
            Some(Value::String(id)) => {
                let waiter = self.lock().pending.remove(id);
                match waiter {
                    Some(Waiter::Short(tx)) => {
                        let _ = tx.send(Some(Value::Object(obj)));
                    }
                    Some(Waiter::Long(op)) => {
                        let resp = Value::Object(obj);
                        match op.as_str() {
                            "tune.read" if resp.get("ok") == Some(&Value::Bool(true)) => self.lock().take_tables(resp.get("result").unwrap_or(&Value::Null)),
                            "tune.apply" => self.lock().fold_apply(&resp),
                            _ => {}
                        }
                        self.emit("result", public_response(&resp));
                    }
                    None => {} // answered after a timeout, or an id we never sent: dropped
                }
            }
            Some(Value::Null) => {
                // The socket service's one framed line before it closes (D-043): ACCESS_DENIED / CLIENT_BUSY. Kept for the connect error.
                let refused = obj.get("ok") == Some(&Value::Bool(false))
                    && obj.get("error").and_then(|e| e.get("code")).and_then(Value::as_str) == Some("REFUSED");
                if refused {
                    let mut st = self.lock();
                    if st.refusal.is_none() {
                        st.refusal = obj.get("error").cloned();
                    }
                }
            }
            Some(_) => {} // a non-string id matches nothing
            None => {
                let Some(name) = obj.get("event").and_then(Value::as_str) else { return };
                // "result" is the link's own event name: a helper line cannot impersonate a long op's outcome.
                if !event_name_ok(name) || name == "result" || name == "closed" {
                    return;
                }
                let mapped = name.replace('.', "-");
                if name == "state" || name == "heartbeat" {
                    self.lock().latest.insert(name.to_string(), Value::Object(obj.clone()));
                }
                self.emit(&mapped, Value::Object(obj));
            }
        }
    }
}

/// `[a-z0-9_.]{1,32}` (`server.py` `_EVENT_RE`).
fn event_name_ok(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

pub struct Link {
    shared: Arc<Shared>,
    writer: Mutex<UnixStream>,
}

impl Link {
    /// Take over a connected stream and start the reader thread.
    pub fn start(stream: UnixStream, sink: Arc<dyn EventSink>) -> std::io::Result<Link> {
        stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
        let reader = stream.try_clone()?;
        let writer = stream.try_clone()?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State { alive: true, ..State::default() }),
            finished: Condvar::new(),
            sink,
            stream,
        });
        let sh = Arc::clone(&shared);
        thread::Builder::new().name("helper-reader".into()).spawn(move || read_loop(&sh, reader))?;
        Ok(Link { shared, writer: Mutex::new(writer) })
    }

    pub fn alive(&self) -> bool {
        self.shared.lock().alive
    }

    /// Why the link ended (`eof` / `read error`); `None` while it is up.
    pub fn closed_reason(&self) -> Option<String> {
        self.shared.lock().closed.clone()
    }

    /// Long ops currently in flight.
    pub fn pending_long(&self) -> usize {
        self.shared.lock().pending.values().filter(|w| matches!(w, Waiter::Long(_))).count()
    }

    /// Last `state` / `heartbeat` events seen (replayed to a UI that attaches late).
    pub fn latest(&self) -> Map<String, Value> {
        self.shared.lock().latest.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// The framed `REFUSED` error (`{code, message, detail}`) the service sent before closing, if any.
    pub fn refusal(&self) -> Option<Value> {
        self.shared.lock().refusal.clone()
    }

    /// Wait until the reader has ended (the framed refusal arrives before the EOF). `true` if it ended in time.
    pub fn wait_finished(&self, timeout: Duration) -> bool {
        let guard = self.shared.lock();
        let (guard, _) = self.shared.finished.wait_timeout_while(guard, timeout, |s| !s.finished).unwrap_or_else(|p| p.into_inner());
        guard.finished
    }

    /// Send one request. Short ops wait up to `timeout`; long ops return [`Reply::Started`] at once. An op the operator must confirm
    /// (`*.apply`, `ops::PERSIST_OPS`) is refused here: it goes through [`Link::apply`] / [`Link::persist`] after the operator's OK.
    pub fn call(&self, op: &str, args: &Value, timeout: Duration) -> Result<Reply, CallError> {
        let info = ops::check(op, args).map_err(CallError::Refused)?;
        if ops::needs_operator(op) {
            return Err(CallError::Refused(Refusal {
                code: "BAD_REQUEST",
                message: format!("refused locally: {op} is sent only by the app, after you confirm it in its own dialog"),
            }));
        }
        let role = plan_role(op);
        let (id, rx) = self.submit(op, args, info.long)?;
        let Some(rx) = rx else { return Ok(Reply::Started(id)) };
        let resp = self.wait_short(&id, rx, timeout)?;
        if let Some((kind, false)) = role {
            self.remember_plan(kind, &resp, args);
        }
        if op == "tune.last" && resp.get("ok") == Some(&Value::Bool(true)) {
            // the stored read of this boot (`{available, result: <tune.read result>}`): the helper restores its tables from it too
            if let Some(read) = resp.get("result").filter(|r| r.get("available") == Some(&Value::Bool(true))).and_then(|r| r.get("result")) {
                self.shared.lock().take_tables(read);
            }
        }
        Ok(Reply::Done(resp))
    }

    /// The turbo tables the helper's answers have reported on this connection (`"e"` / `"p"` -> 8 ratios; absent = not known).
    pub fn tables(&self) -> Map<String, Value> {
        self.shared.lock().tables.clone()
    }

    /// Send the confirmed op that spends plan `plan_id` of `kind`: only when this connection made the plan, the plan has a confirmation
    /// code and the operator approved it ([`Link::approve`]). The request carries `typed: "CONFIRM <nonce>"` from the kept plan; the plan
    /// is spent before the write (the helper spends it too). `intent` (R-B1 / R-26), checked by the caller with `ops::webview_apply_args`, is
    /// what the editor holds now: the helper refuses `PLAN_STALE` / `INTENT_CHANGED` when it is not the planned one.
    pub fn apply(&self, kind: PlanKind, plan_id: &str, intent: Option<&Value>, timeout: Duration) -> Result<Reply, ApplyError> {
        let nonce = {
            let mut st = self.shared.lock();
            let set = &mut st.plans[kind.index()];
            let Some(at) = set.iter().position(|p| p.plan_id == plan_id) else { return Err(ApplyError::Refused(ApplyRefusal::UnknownPlan)) };
            let Some(nonce) = set[at].nonce.clone() else { return Err(ApplyError::Refused(ApplyRefusal::NoNonce)) };
            if !set[at].approved() {
                return Err(ApplyError::Refused(ApplyRefusal::NotApproved));
            }
            set.remove(at);
            nonce
        };
        let op = kind.apply_op();
        let mut args = json!({"plan_id": plan_id, "typed": format!("CONFIRM {nonce}")});
        if let Some(i) = intent {
            args["intent"] = i.clone();
        }
        let info = ops::check(op, &args).map_err(|r| ApplyError::Call(CallError::Refused(r)))?;
        let (id, rx) = self.submit(op, &args, info.long).map_err(ApplyError::Call)?;
        let Some(rx) = rx else { return Ok(Reply::Started(id)) };
        self.wait_short(&id, rx, timeout).map(Reply::Done).map_err(ApplyError::Call)
    }

    /// Send a [`ops::PERSIST_OPS`] request the operator has just confirmed (the caller showed the dialog for exactly these `args`). A
    /// `profiles.accept` answered in the two-step form (`confirm_required`, `plan_id`, `nonce`: the R-B1 helper) is completed here with
    /// `typed` from that answer, and the second answer is returned; a two-step answer without a well-formed id and code is refused
    /// (nothing was accepted: step 1 writes nothing). Fail closed: whatever the helper's protocol, nothing persists without the dialog.
    pub fn persist(&self, op: &str, args: &Value, timeout: Duration) -> Result<Value, ApplyError> {
        if !ops::PERSIST_OPS.contains(&op) {
            return Err(ApplyError::Call(CallError::Refused(Refusal { code: "BAD_REQUEST", message: format!("refused locally: {op} is not a persistent op") })));
        }
        let info = ops::check(op, args).map_err(|r| ApplyError::Call(CallError::Refused(r)))?;
        let (id, rx) = self.submit(op, args, info.long).map_err(ApplyError::Call)?;
        let rx = rx.ok_or(ApplyError::Call(CallError::Unavailable))?;
        let first = self.wait_short(&id, rx, timeout).map_err(ApplyError::Call)?;
        let result = first.get("result");
        let two_step = op == "profiles.accept" && first.get("ok") == Some(&Value::Bool(true)) && result.and_then(|r| r.get("confirm_required")) == Some(&Value::Bool(true));
        if !two_step {
            return Ok(first);
        }
        let plan = result.and_then(|r| r.get("plan_id")).and_then(Value::as_str).filter(|p| ops::plan_id_ok(p));
        let nonce = result.and_then(|r| r.get("nonce")).and_then(Value::as_str).filter(|n| ops::nonce_ok(n));
        let (Some(plan), Some(nonce)) = (plan, nonce) else { return Err(ApplyError::Refused(ApplyRefusal::NoNonce)) };
        let step2 = json!({"plan_id": plan, "typed": format!("CONFIRM {nonce}")});
        let info = ops::check(op, &step2).map_err(|r| ApplyError::Call(CallError::Refused(r)))?;
        let (id, rx) = self.submit(op, &step2, info.long).map_err(ApplyError::Call)?;
        let rx = rx.ok_or(ApplyError::Call(CallError::Unavailable))?;
        self.wait_short(&id, rx, timeout).map_err(ApplyError::Call)
    }

    /// The plan `plan_id` of `kind` this connection holds, if any (what the native dialog describes).
    pub fn plan_record(&self, kind: PlanKind, plan_id: &str) -> Option<PlanRecord> {
        self.shared.lock().plans[kind.index()].iter().find(|p| p.plan_id == plan_id).cloned()
    }

    /// Mark the named plans approved by the operator (all or none: `false` when one of them is gone or has no confirmation code).
    pub fn approve(&self, plans: &[(PlanKind, String)]) -> bool {
        let mut st = self.shared.lock();
        let all = plans.iter().all(|(k, id)| st.plans[k.index()].iter().any(|p| &p.plan_id == id && p.nonce.is_some()));
        if !all {
            return false;
        }
        let now = Instant::now();
        for (k, id) in plans {
            if let Some(p) = st.plans[k.index()].iter_mut().find(|p| &p.plan_id == id) {
                p.approved_at = Some(now);
            }
        }
        true
    }

    fn wait_short(&self, id: &str, rx: Receiver<Option<Value>>, timeout: Duration) -> Result<Value, CallError> {
        match rx.recv_timeout(timeout) {
            Ok(Some(resp)) => Ok(resp),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => Err(CallError::Unavailable),
            Err(RecvTimeoutError::Timeout) => {
                self.shared.lock().pending.remove(id);
                Err(CallError::Timeout)
            }
        }
    }

    fn remember_plan(&self, kind: PlanKind, resp: &Value, request: &Value) {
        if resp.get("ok") != Some(&Value::Bool(true)) {
            return;
        }
        let Some(result) = resp.get("result") else { return };
        let Some(plan) = result.get("plan_id").and_then(Value::as_str) else { return };
        let nonce = result.get("nonce").and_then(Value::as_str).filter(|n| ops::nonce_ok(n));
        let mut kept = result.clone();
        if let Some(o) = kept.as_object_mut() {
            o.remove("nonce");
        }
        let mut st = self.shared.lock();
        let tables = st.tables.clone();
        let set = &mut st.plans[kind.index()];
        set.retain(|p| p.plan_id != plan);
        set.push_back(PlanRecord::new(kind, plan, nonce, kept, request.clone(), tables));
        while set.len() > MAX_PLANS {
            set.pop_front();
        }
    }

    fn submit(&self, op: &str, args: &Value, long: bool) -> Result<(String, Option<Receiver<Option<Value>>>), CallError> {
        let id;
        let mut rx = None;
        {
            let mut st = self.shared.lock();
            if !st.alive {
                return Err(CallError::Unavailable);
            }
            if long && st.pending.values().filter(|w| matches!(w, Waiter::Long(_))).count() >= MAX_PENDING_LONG {
                return Err(CallError::TooManyLong);
            }
            id = format!("d{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
            let line = encode_line(&json!({"id": id, "op": op, "args": args})).ok_or(CallError::TooLarge)?;
            // Registered before the write: the answer can arrive before write() returns.
            if long {
                st.pending.insert(id.clone(), Waiter::Long(op.to_string()));
            } else {
                let (tx, r) = mpsc::channel();
                st.pending.insert(id.clone(), Waiter::Short(tx));
                rx = Some(r);
            }
            drop(st);
            if self.write(&line).is_err() {
                self.shared.lock().pending.remove(&id);
                let _ = self.shared.stream.shutdown(Shutdown::Both); // the reader sees EOF and fails the others
                return Err(CallError::Unavailable);
            }
        }
        Ok((id, rx))
    }

    fn write(&self, line: &[u8]) -> std::io::Result<()> {
        debug_assert!(line.len() <= MAX_LINE);
        let mut w = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        w.write_all(line)?;
        w.flush()
    }

    /// Close the connection; the helper sees EOF. Pending waiters fail.
    pub fn close(&self) {
        let _ = self.shared.stream.shutdown(Shutdown::Both);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_loop(shared: &Shared, stream: UnixStream) {
    let mut reader = BufReader::with_capacity(16 * 1024, stream);
    let reason = loop {
        match read_frame(&mut reader, MAX_LINE) {
            Ok(Frame::Eof) => break "eof",
            Err(_) => break "read error",
            Ok(Frame::Oversize) => continue,
            Ok(Frame::Line(bytes)) => {
                // from_slice rejects non-UTF-8 strings and nesting beyond serde_json's recursion limit with an error: dropped.
                if let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(&bytes) {
                    shared.dispatch(obj);
                }
            }
        }
    };
    shared.fail_all(reason);
}

fn cut(s: &str) -> String {
    s.chars().take(DETAIL_STR_MAX).collect()
}

/// The part of a helper error's `detail` the webview may see: scalars of [`DETAIL_SCALARS`] keys, string lists of [`DETAIL_LISTS`] keys
/// (non-strings dropped, length capped). Nothing else: no objects (e.g. `partial`, a whole curve record), no paths, no other keys.
fn public_detail(det: &Map<String, Value>) -> Map<String, Value> {
    let mut keep = Map::new();
    for (k, v) in det {
        if DETAIL_SCALARS.contains(&k.as_str()) {
            match v {
                Value::String(s) => {
                    keep.insert(k.clone(), Value::String(cut(s)));
                }
                Value::Null | Value::Bool(_) | Value::Number(_) => {
                    keep.insert(k.clone(), v.clone());
                }
                Value::Array(_) | Value::Object(_) => {}
            }
        } else if let Some(&(_, max)) = DETAIL_LISTS.iter().find(|(name, _)| *name == k.as_str()) {
            let Value::Array(items) = v else { continue };
            let strs: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            let over = strs.len() > max;
            let mut list: Vec<Value> = strs.iter().take(if over { max - 1 } else { max }).map(|s| Value::String(cut(s))).collect();
            if over {
                list.push(Value::String(format!("... and {} more not shown", strs.len() - (max - 1))));
            }
            keep.insert(k.clone(), Value::Array(list));
        }
    }
    keep
}

/// What the webview may see of a helper response: `{id, ok, result}` or `{id, ok:false, error:{code, message, detail?}}` with `detail`
/// restricted by [`public_detail`] and the message cut to 500 characters (as `server.py` `public_response`, with the desktop's allowlist).
/// A result's `nonce` (a plan's confirmation code) never reaches the webview: the shell keeps it (D-053 item 4).
pub fn public_response(resp: &Value) -> Value {
    let id = resp.get("id").cloned().unwrap_or(Value::Null);
    if resp.get("ok") == Some(&Value::Bool(true)) {
        let mut result = resp.get("result").cloned().unwrap_or(Value::Null);
        if let Some(o) = result.as_object_mut() {
            o.remove("nonce");
        }
        return json!({"id": id, "ok": true, "result": result});
    }
    let err = resp.get("error").and_then(Value::as_object);
    let code = err.and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("INTERNAL");
    let message: String = match err.and_then(|e| e.get("message")) {
        Some(Value::String(s)) => s.chars().take(500).collect(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string().chars().take(500).collect(),
    };
    let mut out = json!({"code": code, "message": message});
    if let Some(det) = err.and_then(|e| e.get("detail")).and_then(Value::as_object) {
        let keep = public_detail(det);
        if !keep.is_empty() {
            out["detail"] = Value::Object(keep);
        }
    }
    json!({"id": id, "ok": false, "error": out})
}
