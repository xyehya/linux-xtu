//! Helper link (PLAN §3.1): connect to the root helper's socket, prove it is the real one, and carry the allowlisted ops and the events
//! between it and the webview. Commands for JS: `helper_status`, `helper_connect`, `helper_call`.
//!
//! The app is an unprivileged client. The only trusted listener is root at `/run/linux-xtu/helper.sock`; the `dev-socket` feature (tests and
//! the simulator helper) trusts the current uid at `LINUX_XTU_DESKTOP_SOCKET` instead and cannot be built into a release profile:
//! `build.rs` panics on it and the `compile_error!` below fires when debug assertions are off.
//!
//! The JSON these commands return and the events the link emits are the contract with `ui/bridge.js`. `tests/contract_samples.rs`
//! serialises each shape into `ui/tests/contract-samples.json`, and `ui/tests/contract.test.mjs` feeds those samples through the bridge.
//!
//! Confirmation (package R-S3, D-053 item 4, assessment F-06): the webview never holds a plan's confirmation code and cannot write by
//! itself. `helper_call("app.confirm", {plans})` shows a native dialog ([`confirm`]); only the operator's click approves those plans, and
//! only approved plans are then sent by `helper_call("*.apply", {plan_id})`, with the code added here. A persistent op
//! (`profiles.accept`, `profiles.fingerprint`) shows its own dialog when the webview sends it and goes out only on the OK.
//!
//! Reconnecting (package R-A4, assessment 2026-11-11 F-02): only `helper_connect` opens a connection — the webview's Retry and its reconnect loop with backoff call it.
//! `helper_call` never connects unless it is asked to (`reconnect: true`), so a background poll can never reconnect silently.
//!
//! Version handshake (R-I1, [`version`]): every `preflight` the shell sends declares this app (`client: {name, version, protocol}`); the
//! helper's answer is compared with it. A protocol mismatch turns writes off: the shell refuses `app.confirm` and the mutating ops locally
//! (`VERSION_MISMATCH`), the webview's preflight says `writes_allowed: false` with a failed `app_version` check, and the status carries
//! `version {.., protocol_ok: false, message, fix}` (the bridge shows the message and the reinstall fix). A different op set is logged and
//! noted (`app_ops` check).

#[cfg(all(feature = "dev-socket", not(debug_assertions)))]
compile_error!("feature `dev-socket` must not be enabled in a release build (the AppImage is an unprivileged client of the root helper)");

pub mod confirm;
pub mod connect;
pub mod frame;
pub mod link;
pub mod native;
pub mod ops;
pub mod version;

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use confirm::Confirmer;
use connect::{ConnectError, Probe, SysProbe, Target};
use link::{public_response, EventSink, Link, Reply};
use version::VersionCheck;

/// A short op that gets no answer in this time is reported `TIMEOUT` (server.py `call_timeout_s`).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// May a call open a connection when none is up?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connect {
    /// One connection attempt if the link is down (a user action asked for it).
    IfDown,
    /// Never: answer `NOT_CONNECTED` (the default of `helper_call`; background polls must not reconnect).
    Never,
}

/// What `helper_status` / `helper_connect` return. `last_error` is the reason the link is down: the last failed connect, else the end
/// of a link that worked (kind `closed`), else `not_connected`; `null` while connected. `preflight` is the handshake's answer
/// (`{id, ok, result|error}`) of the last connection, kept after it ends. `version` is the handshake's comparison of the helper with this
/// app ([`VersionCheck::to_value`]: `{app, helper, protocol_ok, ops_hash_ok, message, fix}`) of that connection, kept likewise.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub connected: bool,
    pub path: String,
    pub dev_socket: bool,
    pub pending_long: usize,
    /// Last `state` / `heartbeat` events of the live link, by name.
    pub latest: Map<String, Value>,
    pub preflight: Option<Value>,
    pub version: Option<Value>,
    pub last_error: Option<ConnectError>,
}

impl Status {
    /// The status of `link` (the current one, live or ended, if any) for `target`.
    pub fn of(target: &Target, link: Option<&Link>, preflight: Option<Value>, last_error: Option<&ConnectError>) -> Status {
        let live = link.filter(|l| l.alive());
        let last_error = match (live, last_error) {
            (Some(_), _) => None,
            (None, Some(e)) => Some(e.clone()),
            (None, None) => Some(link.and_then(Link::closed_reason).map_or_else(ConnectError::not_connected, |r| ConnectError::lost(&r))),
        };
        Status {
            connected: live.is_some(),
            path: target.path().display().to_string(),
            dev_socket: target.is_dev(),
            pending_long: live.map_or(0, Link::pending_long),
            latest: live.map_or_else(Map::new, Link::latest),
            preflight,
            version: None,
            last_error,
        }
    }

    /// The same status with the handshake's version comparison.
    pub fn with_version(mut self, version: Option<&VersionCheck>) -> Status {
        self.version = version.map(VersionCheck::to_value);
        self
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// `{ok:false, error:{code, message, detail?}}`: an answer made by the shell itself (refused locally, not connected, link lost).
pub fn error_reply(code: &str, message: &str, detail: Option<Value>) -> Value {
    let mut err = json!({"code": code, "message": message});
    if let Some(d) = detail {
        err["detail"] = d;
    }
    json!({"ok": false, "error": err})
}

/// The answer to a call made while the link is down: nothing was sent. `detail.kind` is the link's failure kind.
pub fn not_connected_reply(e: &ConnectError) -> Value {
    error_reply("NOT_CONNECTED", &e.message, Some(json!({"kind": e.kind.as_str()})))
}

/// The answer to a long op that was sent: its final response comes later as the `helper://result` event.
pub fn started_reply(id: &str) -> Value {
    json!({"id": id, "ok": true, "pending": true})
}

/// The webview-facing state: at most one link; reconnects on demand.
pub struct HelperState {
    target: Target,
    probe: Box<dyn Probe>,
    sink: Arc<dyn EventSink>,
    /// The native dialog behind its gate (one at a time, a pause after Cancel).
    confirmer: confirm::GatedConfirmer,
    handshake_timeout: Duration,
    link: Mutex<Option<Arc<Link>>>,
    connecting: Mutex<()>,
    last_error: Mutex<Option<ConnectError>>,
    preflight: Mutex<Option<Value>>,
    /// The helper compared with this app, from the last preflight answer of the current (or last) connection.
    version: Mutex<Option<VersionCheck>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl HelperState {
    /// The app's state: the target from [`Target::from_environment`], real `lstat` / `SO_PEERCRED`, the given confirmer (the app's
    /// native dialog).
    pub fn new(sink: Arc<dyn EventSink>, confirmer: Arc<dyn Confirmer>) -> HelperState {
        HelperState::build(Target::from_environment(), Box::new(SysProbe), sink, confirmer, connect::HANDSHAKE)
    }

    /// Test seam: inject the probe and the target (the confirmer refuses: no dialog, nothing approved). Only with `dev-socket`.
    #[cfg(feature = "dev-socket")]
    pub fn with_parts(target: Target, probe: Box<dyn Probe>, sink: Arc<dyn EventSink>, handshake_timeout: Duration) -> HelperState {
        let none: Arc<dyn Confirmer> = Arc::new(confirm::FixedConfirmer::new(confirm::Answer::Unavailable("no dialog in this build".into())));
        HelperState::build(target, probe, sink, none, handshake_timeout)
    }

    /// Test seam with a confirmer. Only with `dev-socket`.
    #[cfg(feature = "dev-socket")]
    pub fn with_confirmer(target: Target, probe: Box<dyn Probe>, sink: Arc<dyn EventSink>, confirmer: Arc<dyn Confirmer>, handshake_timeout: Duration) -> HelperState {
        HelperState::build(target, probe, sink, confirmer, handshake_timeout)
    }

    fn build(target: Target, probe: Box<dyn Probe>, sink: Arc<dyn EventSink>, confirmer: Arc<dyn Confirmer>, handshake_timeout: Duration) -> HelperState {
        HelperState {
            target,
            probe,
            sink,
            confirmer: confirm::GatedConfirmer::new(confirmer),
            handshake_timeout,
            link: Mutex::new(None),
            connecting: Mutex::new(()),
            last_error: Mutex::new(None),
            preflight: Mutex::new(None),
            version: Mutex::new(None),
        }
    }

    /// Compare a raw preflight answer with this app, keep the result, log a mismatch, and return the answer as the webview gets it.
    fn take_preflight(&self, raw: &Value) -> Value {
        let check = VersionCheck::of(raw);
        if let Some(msg) = check.message() {
            eprintln!("linux-xtu-desktop: VERSION_MISMATCH: {msg}");
        }
        if let Some(note) = check.ops_note() {
            eprintln!("linux-xtu-desktop: ops_hash differs: {note}");
        }
        let public = check.decorate(public_response(raw));
        *lock(&self.version) = Some(check);
        public
    }

    /// A write or mutating op while the helper's protocol differs from this app's: refused here (`VERSION_MISMATCH`), nothing sent.
    fn version_fence(&self, op: &str) -> Option<Value> {
        if op != "app.confirm" && !ops::MUTATING_OPS.contains(&op) {
            return None;
        }
        let msg = lock(&self.version).as_ref().and_then(VersionCheck::message)?;
        Some(error_reply("VERSION_MISMATCH", &format!("refused locally: {msg}"), Some(json!({"check": "VERSION_MISMATCH", "writes_sent": 0}))))
    }

    fn live_link(&self) -> Option<Arc<Link>> {
        lock(&self.link).as_ref().filter(|l| l.alive()).cloned()
    }

    /// The live link, or one fresh connection attempt.
    fn ensure_link(&self) -> Result<Arc<Link>, ConnectError> {
        if let Some(l) = self.live_link() {
            return Ok(l);
        }
        let _one_at_a_time = lock(&self.connecting);
        if let Some(l) = self.live_link() {
            return Ok(l);
        }
        match connect::connect(&self.target, self.probe.as_ref(), Arc::clone(&self.sink), &connect::whoami(), self.handshake_timeout) {
            Ok((link, pre)) => {
                let link = Arc::new(link);
                *lock(&self.link) = Some(Arc::clone(&link));
                *lock(&self.last_error) = None;
                let public = self.take_preflight(&pre);
                *lock(&self.preflight) = Some(public);
                Ok(link)
            }
            Err(e) => {
                *lock(&self.link) = None;
                *lock(&self.last_error) = Some(e.clone());
                Err(e)
            }
        }
    }

    /// The live link, or why there is none ([`Status::last_error`]) without trying to connect.
    fn current_link(&self) -> Result<Arc<Link>, ConnectError> {
        if let Some(l) = self.live_link() {
            return Ok(l);
        }
        let status = Status::of(&self.target, lock(&self.link).as_deref(), None, lock(&self.last_error).as_ref());
        Err(status.last_error.unwrap_or_else(ConnectError::not_connected))
    }

    /// [`Status`] as JSON.
    pub fn status(&self) -> Value {
        let link = lock(&self.link).clone();
        let preflight = lock(&self.preflight).clone();
        let last_error = lock(&self.last_error).clone();
        let version = lock(&self.version).clone();
        Status::of(&self.target, link.as_deref(), preflight, last_error.as_ref()).with_version(version.as_ref()).to_value()
    }

    /// Connect now (if not already) and return the status.
    pub fn connect(&self) -> Value {
        let _ = self.ensure_link();
        self.status()
    }

    /// `{ok, result}` / `{ok:false, error}` for a short op; `{ok:true, id, pending:true}` for a long op, whose final response comes as
    /// the `helper://result` event. Refused locally (nothing connected, nothing written) when the op or its arguments are not allowlisted.
    /// With [`Connect::Never`] a call while the link is down answers `NOT_CONNECTED` and opens nothing.
    ///
    /// `app.confirm`, `*.apply` and the persistent ops never connect: they act on plans and state of the live link. While the helper's
    /// protocol differs from this app's they and the other mutating ops are refused here (`VERSION_MISMATCH`). `preflight` is sent with
    /// this app's `client` block (the webview sends `{}`) and its answer is compared and decorated ([`version`]).
    pub fn call(&self, op: &str, args: &Value, connect: Connect) -> Value {
        if op == "app.confirm" || ops::needs_operator(op) {
            let link = match self.current_link() {
                Ok(l) => l,
                Err(e) => return not_connected_reply(&e),
            };
            if let Some(refused) = self.version_fence(op) {
                return refused;
            }
            return match ops::apply_kind(op) {
                Some(kind) => confirm::apply_confirmed(&link, kind, args, CALL_TIMEOUT),
                None if op == "app.confirm" => confirm::confirm_plans(&link, &self.confirmer, args),
                None => confirm::persist_confirmed(&link, &self.confirmer, op, args, CALL_TIMEOUT),
            };
        }
        if let Err(r) = ops::check(op, args) {
            return error_reply(r.code, &r.message, None);
        }
        if op == "preflight" && args.as_object().is_some_and(|a| !a.is_empty()) {
            return error_reply("BAD_REQUEST", "refused locally: the page sends preflight {} (the app declares its own client and version)", None);
        }
        let link = match connect {
            Connect::IfDown => self.ensure_link(),
            Connect::Never => self.current_link(),
        };
        let link = match link {
            Ok(l) => l,
            Err(e) => return not_connected_reply(&e),
        };
        if let Some(refused) = self.version_fence(op) {
            return refused;
        }
        let sent = if op == "preflight" { version::preflight_args() } else { args.clone() };
        match link.call(op, &sent, CALL_TIMEOUT) {
            Ok(Reply::Done(resp)) if op == "preflight" => self.take_preflight(&resp),
            Ok(Reply::Done(resp)) => public_response(&resp),
            Ok(Reply::Started(id)) => started_reply(&id),
            Err(e) => {
                let (code, message) = e.code_message();
                error_reply(&code, &message, None)
            }
        }
    }
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, name: &str, payload: Value) {
        let _ = self.0.emit(name, payload);
    }
}

/// Register the state with the app (called once from `setup`).
pub fn init(app: &AppHandle) {
    app.manage(HelperState::new(Arc::new(TauriSink(app.clone())), Arc::new(native::NativeConfirmer::new(app.clone()))));
}

async fn blocking<F: FnOnce(&HelperState) -> Value + Send + 'static>(app: AppHandle, f: F) -> Value {
    // Connecting and waiting for answers block: never on the main thread.
    let joined = tauri::async_runtime::spawn_blocking(move || f(&app.state::<HelperState>())).await;
    joined.unwrap_or_else(|_| error_reply("INTERNAL", "the helper link task failed", None))
}

#[tauri::command]
pub async fn helper_status(app: AppHandle) -> Value {
    blocking(app, |s| s.status()).await
}

#[tauri::command]
pub async fn helper_connect(app: AppHandle) -> Value {
    blocking(app, |s| s.connect()).await
}

/// `reconnect` (default false): whether this call may open a connection when the link is down. The webview never sets it: it
/// reconnects through `helper_connect` (Retry, or its reconnect loop with backoff), so a call can never reconnect behind its back.
#[tauri::command]
pub async fn helper_call(app: AppHandle, op: String, args: Option<Value>, reconnect: Option<bool>) -> Value {
    let args = match args {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(v) => v,
    };
    let mode = if reconnect == Some(true) { Connect::IfDown } else { Connect::Never };
    blocking(app, move |s| s.call(&op, &args, mode)).await
}
