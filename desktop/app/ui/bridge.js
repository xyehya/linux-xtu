// bridge.js: the only file that touches window.__TAURI__ (PLAN §3.2). One interface, two backends behind it:
//   - Tauri backend: `invoke('helper_status' | 'helper_connect' | 'helper_call')` and `listen('helper://<event>')` (PLAN §3.1). The shapes the shell
//     answers in are pinned by tests/contract-samples.json, which src-tauri/tests/contract_samples.rs generates from the real Rust code; tests/contract.test.mjs
//     feeds every sample through this file, so a shape change on either side fails a test instead of the AppImage.
//   - mock backend (`?bridge=mock`): replays the JSON fixtures from fixtures/ (loaded lazily, so the AppImage never parses them); it answers in the same shapes.
// Interface: connect(), status(), call(op, args), on(event, cb), off(event, cb) (+ wait(id), run(op, args), cancel(id), close(), and the shell's own
// commands appVersion(), settingsGet(), settingsSet(patch), notify(title, body)).
//   - call() resolves with the helper's response `{id?, ok:true, result}` / `{ok:false, error:{code,message,detail?}}`.
//     A long op (tune.read, tune.apply, vf.measure, stress.start) resolves at once with `{ok:true, pending:true, id}`; its final response arrives as
//     the `result` event ({id, ok, result|error}); wait(id) / run() hide that.
//   - events: heartbeat state progress telemetry vf.point result (payloads exactly as the helper sends them, contract 9), `closed` ({reason}: the link
//     ended) and `link` ({state,kind,message,fix}, produced here).
// Reconnecting: a call never opens a connection (the shell's helper_call defaults to reconnect:false, so a background poll cannot reconnect behind the
// UI's back). connect() is the only way back: the Setup screen's Retry and the app's reconnect loop (app.js wireLink) call it.

export const EVENTS = ["heartbeat", "state", "progress", "telemetry", "vf.point", "result", "closed", "link"];
const RESULT_KEEP = 32; // final responses remembered so wait(id) works even if the result event arrived first
/** The events the bridge itself listens to for as long as it lives (link state, wait(), the stale-op watchdog). */
const INTERNAL = ["result", "closed", "heartbeat"];

export const LINK_STATES = ["connecting", "connected", "busy", "not_installed", "not_allowed", "error"];

/** Fix text per failure kind (named fixes, same wording as the web GUI's helperlink; the app never runs sudo itself). */
export const FIXES = {
  not_installed: "sudo bash install.sh",
  not_allowed: "sudo bash install.sh --add-user $USER",
  busy: "Close the other Linux XTU window or client, then retry.",
  version: "sudo bash install.sh",
};

/** The `result` a long op gets when the link ends before its final answer (the shell's own words, link.rs fail_all). */
export const LINK_LOST_MESSAGE = "the helper connection was lost while this operation was running; its outcome is unknown and it was not replayed";

/** F-15 watchdog: a wait() ends as STALE once the helper, still sending heartbeats (every 2 s), has said this many times in a row that it runs no
 *  operation with this id, and at least STALE_MIN_MS have passed. Its final answer was lost; nothing more will come for it. */
export const STALE_BEATS = 3;
export const STALE_MIN_MS = 10000;

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** One side of the shell's version check (`version.app` / `version.helper`): {version, protocol} (each null when not reported), or null. */
function versionSide(x) {
  if (!isObject(x)) return null;
  return { version: typeof x.version === "string" && x.version ? x.version : null, protocol: Number.isInteger(x.protocol) ? x.protocol : null };
}

/**
 * Map whatever a backend reports to {state, kind, message, fix} (+ `versions: {app, helper}` for kind "version": what differs).
 *  - the shell's helper_status / helper_connect JSON: {connected, last_error: {kind, message} | null, path, dev_socket, pending_long, latest, preflight, version}
 *    (Rust `Status`; kinds missing untrusted denied unavailable not_allowed busy closed timeout root not_connected);
 *  - the older flat form {state?, kind?, message?, fix?} (the "no runtime" backend, tests).
 * R-I1 version handshake: a connected link whose helper speaks another protocol (`version.protocol_ok === false`) stays connected (reads work) with kind "version",
 * the shell's reason as the message and its fix (reinstall); the shell has turned writes off (preflight `writes_allowed: false`, failed check `app_version`).
 */
export function normalizeLink(raw) {
  const r = isObject(raw) ? raw : {};
  if (r.connected === true) {
    const v = isObject(r.version) ? r.version : null;
    if (v && v.protocol_ok === false) {
      return {
        state: "connected", kind: "version", message: String(v.message ?? "Helper and app versions differ. Writes are off."), fix: typeof v.fix === "string" ? v.fix : FIXES.version,
        versions: { app: versionSide(v.app), helper: versionSide(v.helper) },
      };
    }
    return { state: "connected", kind: null, message: String(r.message ?? ""), fix: null };
  }
  const err = isObject(r.last_error) ? r.last_error : {};
  const kind = r.kind ?? err.kind ?? null;
  const message = String(r.message ?? err.message ?? "");
  let state = r.state;
  if (!LINK_STATES.includes(state)) {
    if (kind === "busy") state = "busy";
    else if (kind === "missing" || kind === "unavailable") state = "not_installed";
    else if (kind === "not_allowed" || kind === "denied") state = "not_allowed";
    else state = "error";
  }
  const fix = r.fix ?? (state === "connected" || state === "connecting" ? null : FIXES[state] || null);
  return { state, kind, message, fix };
}

/** The link after `helper://closed`: down, kind `closed` (as the shell's status reports it), and the app is reconnecting. */
export function lostLink(reason) {
  const why = typeof reason === "string" && reason ? reason : "closed";
  return { state: "error", kind: "closed", message: `The connection to the helper was lost (${why}). Reconnecting; nothing in flight was replayed.`, fix: null };
}

/** Tauri accepts event names of alphanumerics, `-`, `/`, `:` and `_` only (tauri-2.12.4 src/event/event_name.rs is_event_name_valid); the shell emits the
 *  helper's `vf.point` as `helper://vf-point` (link.rs). */
export function tauriEventName(event) {
  return `helper://${String(event).replace(/\./g, "-")}`;
}

export class Bridge {
  #t;
  #name;
  #now;
  #link = { state: "connecting", kind: null, message: "", fix: null };
  #connecting = null; // the connect() in flight: calls made meanwhile wait for it instead of failing NOT_CONNECTED
  #subs = new Map(); // event -> Set(cb)
  #unlisten = new Map(); // event -> unlisten fn | Promise<fn>
  #results = new Map(); // id -> final response
  #waiters = new Map(); // id -> {resolve: [fn], since: ms, misses: heartbeats in a row that named no op / another op}

  constructor(transport, name = "custom", { now = () => Date.now() } = {}) {
    this.#t = transport;
    this.#name = name;
    this.#now = now;
  }

  get name() {
    return this.#name;
  }

  get link() {
    return this.#link;
  }

  /** helper_connect: the only way the link comes (back) up. Concurrent calls share one attempt. */
  connect() {
    if (!this.#connecting) {
      this.#connecting = this.#connectOnce().finally(() => {
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  async #connectOnce() {
    for (const ev of INTERNAL) await this.#ensure(ev).catch((e) => console.error(`bridge: cannot listen to ${ev}`, e));
    let raw;
    try {
      raw = await this.#t.connect();
    } catch (e) {
      raw = { state: "error", message: e && e.message ? e.message : String(e) };
    }
    this.#setLink(normalizeLink(raw));
    return this.#link;
  }

  async status() {
    try {
      if (this.#t.status) this.#setLink(normalizeLink(await this.#t.status()));
    } catch (e) {
      this.#setLink(normalizeLink({ state: "error", message: e && e.message ? e.message : String(e) }));
    }
    return this.#link;
  }

  async call(op, args = {}) {
    if (typeof op !== "string" || !op) throw new TypeError("bridge.call: op must be a non-empty string");
    if (!isObject(args)) throw new TypeError("bridge.call: args must be an object");
    if (this.#connecting) await this.#connecting;
    await this.#ensure("result");
    let res;
    try {
      res = await this.#t.call(op, args);
    } catch (e) {
      return { ok: false, error: { code: "BRIDGE_ERROR", message: e && e.message ? e.message : String(e) } };
    }
    if (isObject(res) && res.ok === undefined && typeof res.id === "string") return { ok: true, pending: true, id: res.id }; // long op: the result comes as an event
    if (!isObject(res) || typeof res.ok !== "boolean") return { ok: false, error: { code: "BRIDGE_ERROR", message: "malformed reply from the backend" } };
    return res;
  }

  /** Ask the helper to stop the long op `id` between transactions (`cancel {op_id}`); its final answer still arrives as its `result`. */
  cancel(id) {
    return this.call("cancel", { op_id: id });
  }

  /** This app's version (the shell's `app_version` command, lib.rs VERSION): `{ok: true, result: "0.2.0-dev"}`. A backend without it answers UNSUPPORTED. */
  appVersion() {
    return this.#native("appVersion");
  }

  /** App settings (G-219): `{ok, result: {refresh_s, strip_series, window, notifications, hints}, warning?}`. A backend without them answers UNSUPPORTED. */
  settingsGet() {
    return this.#native("settingsGet");
  }

  /** Merge `patch` into the persisted settings; the whole new settings object comes back, or `{ok:false, error}` and nothing changes. */
  settingsSet(patch) {
    if (!isObject(patch)) throw new TypeError("bridge.settingsSet: patch must be an object");
    return this.#native("settingsSet", patch);
  }

  /** Desktop notification, raised by the Rust side (no webview permission); only while the window is unfocused and notifications are on. */
  notify(title, body = "") {
    if (typeof title !== "string" || !title.trim()) throw new TypeError("bridge.notify: title must be a non-empty string");
    return this.#native("notify", title, String(body));
  }

  /**
   * Final response of a long op (resolves from the `result` event; immediately if it already arrived). It never hangs on a lost answer: the link ending
   * resolves it LINK_LOST, and the helper saying (by its heartbeats) that it no longer runs the op resolves it STALE (see STALE_BEATS).
   */
  wait(id) {
    if (this.#results.has(id)) return Promise.resolve(this.#results.get(id));
    this.#ensure("heartbeat").catch(() => {});
    return new Promise((resolve) => {
      const w = this.#waiters.get(id) || { resolve: [], since: this.#now(), misses: 0 };
      w.resolve.push(resolve);
      this.#waiters.set(id, w);
    });
  }

  /** call() and, for a long op, wait for its final response. */
  async run(op, args = {}) {
    const first = await this.call(op, args);
    return first.pending ? this.wait(first.id) : first;
  }

  on(event, cb) {
    if (typeof cb !== "function") throw new TypeError("bridge.on: callback must be a function");
    let set = this.#subs.get(event);
    if (!set) this.#subs.set(event, (set = new Set()));
    set.add(cb);
    this.#ensure(event).catch((e) => console.error(`bridge: cannot listen to ${event}`, e));
    return () => this.off(event, cb);
  }

  off(event, cb) {
    const set = this.#subs.get(event);
    if (!set) return;
    if (cb) set.delete(cb);
    else set.clear();
    if (set.size === 0 && !INTERNAL.includes(event) && event !== "link") void this.#drop(event);
  }

  async close() {
    for (const ev of [...this.#unlisten.keys()]) await this.#drop(ev);
    this.#subs.clear();
    if (this.#t.close) await this.#t.close();
  }

  // ---- internals ----
  /** Pass-through to an optional transport function that answers `{ok, ...}` like the helper commands do. */
  async #native(name, ...args) {
    if (typeof this.#t[name] !== "function") {
      return { ok: false, error: { code: "UNSUPPORTED", message: `${name} is not available in the ${this.#name} backend` } };
    }
    let res;
    try {
      res = await this.#t[name](...args);
    } catch (e) {
      return { ok: false, error: { code: "BRIDGE_ERROR", message: e && e.message ? e.message : String(e) } };
    }
    if (!isObject(res) || typeof res.ok !== "boolean") return { ok: false, error: { code: "BRIDGE_ERROR", message: "malformed reply from the backend" } };
    return res;
  }

  #setLink(link) {
    const same = link.state === this.#link.state && link.kind === this.#link.kind && link.message === this.#link.message;
    this.#link = link;
    if (!same) this.#dispatch("link", link);
  }

  /** Resolve the waiters of `id` with `payload` (a synthesized answer: not remembered, not dispatched as a `result` event). */
  #settle(id, payload) {
    const w = this.#waiters.get(id);
    if (!w) return;
    this.#waiters.delete(id);
    for (const resolve of w.resolve) resolve(payload);
  }

  #watchdog(beat) {
    const now = this.#now();
    for (const [id, w] of [...this.#waiters]) {
      if (beat.op_id === id) {
        w.misses = 0;
        continue;
      }
      w.misses += 1;
      if (w.misses >= STALE_BEATS && now - w.since >= STALE_MIN_MS) {
        this.#settle(id, {
          id, ok: false,
          error: { code: "STALE", message: `the helper is no longer running this operation and its final answer never arrived (${w.misses} heartbeats); its outcome is unknown, see the Audit screen. Nothing was replayed.` },
        });
      }
    }
  }

  #dispatch(event, payload) {
    if (event === "result" && isObject(payload) && typeof payload.id === "string") {
      this.#results.set(payload.id, payload);
      if (this.#results.size > RESULT_KEEP) this.#results.delete(this.#results.keys().next().value);
      this.#settle(payload.id, payload);
    }
    if (event === "heartbeat" && isObject(payload)) this.#watchdog(payload);
    if (event === "closed") {
      // The shell also emits `closed` when a connection attempt ends in its handshake (a refused or silent helper: connect.rs starts a Link, its reader
      // ends). That is not a loss: the attempt's own answer (helper_connect's status) says why. Only the end of a link we had is one.
      if (this.#link.state !== "connected") return;
      // the shell reports each long op in flight LINK_LOST before `closed`; anything still waiting gets the same answer
      for (const id of [...this.#waiters.keys()]) this.#settle(id, { id, ok: false, error: { code: "LINK_LOST", message: LINK_LOST_MESSAGE } });
      this.#setLink(lostLink(isObject(payload) ? payload.reason : ""));
    }
    const set = this.#subs.get(event);
    if (set) for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (e) {
        console.error("bridge listener for", event, "threw", e);
      }
    }
  }

  async #ensure(event) {
    if (event === "link") return; // `link` is produced by the bridge itself, not by a backend event
    if (this.#unlisten.has(event)) return this.#unlisten.get(event);
    let p;
    try {
      p = Promise.resolve(this.#t.listen(event, (payload) => this.#dispatch(event, payload)));
    } catch (e) {
      p = Promise.reject(e);
    }
    this.#unlisten.set(event, p);
    p.then((fn) => this.#unlisten.set(event, fn), () => this.#unlisten.delete(event));
    return p;
  }

  async #drop(event) {
    const u = this.#unlisten.get(event);
    this.#unlisten.delete(event);
    if (!u) return;
    const fn = await u;
    if (typeof fn === "function") fn();
  }
}

// ---- Tauri backend ----
export function createTauriTransport(tauri = globalThis.__TAURI__) {
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") throw new Error("window.__TAURI__ is not available");
  const invoke = tauri.core.invoke.bind(tauri.core);
  return {
    connect: () => invoke("helper_connect"),
    status: () => invoke("helper_status"),
    // no `reconnect`: the shell's default (false) is the point — a call never reconnects; connect() does (see the header)
    call: (op, args) => invoke("helper_call", { op, args }),
    listen: (event, cb) => tauri.event.listen(tauriEventName(event), (e) => cb(e.payload)),
    appVersion: async () => ({ ok: true, result: String(await invoke("app_version")) }), // the command answers a bare string
    settingsGet: () => invoke("settings_get"),
    settingsSet: (patch) => invoke("settings_set", { patch }),
    notify: (title, body) => invoke("notify", { title, body }),
  };
}

/** What a plain browser gets without ?bridge=mock: no helper to talk to, says so in the status bar. */
function createUnavailableTransport() {
  const message = "no desktop runtime here: open the Linux XTU app, or add ?bridge=mock to try the UI with fixtures";
  return {
    connect: async () => ({ state: "error", kind: "no_runtime", message }),
    status: async () => ({ state: "error", kind: "no_runtime", message }),
    call: async () => ({ ok: false, error: { code: "NOT_CONNECTED", message } }),
    listen: () => () => {},
  };
}

/** `search` is location.search. bridge=mock[&motion=1][&tick=<ms>][&helper=busy|not_installed|not_allowed|error] */
export async function selectBridge(search = globalThis.location?.search ?? "", tauri = globalThis.__TAURI__) {
  const q = new URLSearchParams(search);
  if (q.get("bridge") === "mock") {
    const { createMockTransport } = await import("./fixtures/mock-backend.js");
    const tick = Number(q.get("tick"));
    return new Bridge(
      createMockTransport({ motion: q.get("motion") === "1", intervalMs: Number.isFinite(tick) && tick >= 10 ? tick : 1000, helper: q.get("helper") || "ok" }),
      "mock",
    );
  }
  if (tauri && tauri.core) return new Bridge(createTauriTransport(tauri), "tauri");
  return new Bridge(createUnavailableTransport(), "none");
}
