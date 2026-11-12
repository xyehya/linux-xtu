// node --test "desktop/app/ui/tests/*.test.mjs"   (R-A4: the JS <-> Rust contract; no DOM, no network, no hardware)
// contract-samples.json is written by desktop/app/src-tauri/tests/contract_samples.rs from the shell's real code (status, call answers, events, the detail
// allowlist) and checked there for drift. Here every sample goes through bridge.js and the readers the views use, and the mock backend is held to the same
// shapes. Before this file every UI test ran against the mock only, so four shape mismatches with the shell passed CI (assessment 2026-11-11 F-01..F-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge, createTauriTransport, normalizeLink, tauriEventName, EVENTS, FIXES, STALE_BEATS, STALE_MIN_MS, LINK_LOST_MESSAGE } from "../bridge.js";
import { createMockTransport, publicResponse, DETAIL_ALLOW, LINK_FAILURES, SHELL_OPS, PERSIST_OPS, MUTATING_OPS, checkArgs, webviewApplyArgs, itemOf, dialogText, versionCheck, APP, CLIENT, REINSTALL } from "../fixtures/mock-backend.js";
import { createAppStore, applyHelperEvent, SERIES, setPreflight } from "../store.js";
import { needsSetup, setupModel, SETUP_KINDS } from "../views/setup.js";
import { linkLabel } from "../components/topbar.js";
import { noWrites, createApplyController, CONFIRM_OP } from "../views/tune/apply.js";
import { wireLink, NO_RETRY_KINDS } from "../app.js";

const here = dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(readFileSync(join(here, "contract-samples.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(5);
  }
}

/** tauri-2.12.4 src/event/event_name.rs is_event_name_valid (char::is_alphanumeric is Unicode Alphabetic | Numeric). */
const tauriAccepts = (name) => [...name].every((c) => /[\p{Alphabetic}\p{N}]/u.test(c) || "-/:_".includes(c));

const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Same keys and the same JSON type under each key; nested one level into last_error / error / detail. */
function sameShape(a, b, path = "$") {
  assert.equal(kindOf(a), kindOf(b), `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  if (!isObj(a)) return;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
  for (const k of Object.keys(a)) {
    if (["last_error", "error", "detail"].includes(k) && isObj(a[k]) && isObj(b[k])) sameShape(a[k], b[k], `${path}.${k}`);
    else assert.equal(kindOf(a[k]), kindOf(b[k]), `${path}.${k}`);
  }
}

/** A window.__TAURI__ whose commands answer with the samples and whose `listen` applies Tauri's event-name rule, as the AppImage's does. */
function fakeTauri({ connect = [S.status.connected], call } = {}) {
  const listened = new Map();
  const invokes = [];
  const queue = [...connect];
  const tauri = {
    core: {
      invoke: async (cmd, args) => {
        invokes.push([cmd, clone(args ?? null)]);
        if (cmd === "helper_connect") return clone(queue.length > 1 ? queue.shift() : queue[0]);
        if (cmd === "helper_status") return clone(queue[0]);
        if (cmd === "helper_call") return clone(call ? call(args) : S.call.ok);
        throw new Error(`unknown command ${cmd}`);
      },
    },
    event: {
      listen: async (name, cb) => {
        if (!tauriAccepts(name)) throw new Error(`IllegalEventName: ${name}`);
        listened.set(name, cb);
        return () => listened.delete(name);
      },
    },
  };
  const fire = (name, payload) => {
    const cb = listened.get(name);
    assert.ok(cb, `nobody listens to ${name}`);
    cb({ event: name, id: 1, payload: clone(payload) });
  };
  const calls = () => invokes.filter(([c]) => c === "helper_call").map(([, a]) => a);
  return { tauri, invokes, listened, fire, calls };
}

/** helper_call answers for the start-up (preflight, tune.last, telemetry.start). */
const startUpAnswers = (args) => {
  if (args.op === "preflight") return { id: "d7", ok: true, result: { writes_allowed: false, mode: "read", checks: [] } };
  if (args.op === "tune.last") return { id: "d8", ok: true, result: { available: false } };
  if (args.op === "telemetry.start") return { id: "d9", ok: true, result: { running: true, op_id: "d9", interval_s: 1 } };
  return S.call.ok;
};

function harness(bridge, { delays } = {}) {
  const store = createAppStore();
  const toasts = [];
  const scheduled = [];
  const cycle = wireLink({
    store, bridge, toast: (kind, text) => toasts.push([kind, text]),
    schedule: (fn, ms) => (scheduled.push({ fn, ms }), scheduled.length), cancel: () => {}, ...(delays ? { delaysMs: delays } : {}),
  });
  for (const ev of ["heartbeat", "state", "progress", "telemetry"]) bridge.on(ev, (p) => applyHelperEvent(store, ev, p));
  const runNext = async () => {
    const s = scheduled.shift();
    assert.ok(s, "a reconnect attempt is scheduled");
    await s.fn();
    return s.ms;
  };
  return { store, toasts, scheduled, cycle, runNext };
}

// ================================================================ the samples file itself
test("contract: the samples come from the Rust generator and cover every shape the bridge reads", () => {
  assert.match(S._about, /contract_samples\.rs/);
  for (const k of ["connected", "lost", "not_connected"]) assert.ok(isObj(S.status[k]), k);
  for (const k of ["missing", "untrusted", "denied", "unavailable", "not_allowed", "busy", "closed", "timeout"]) assert.equal(S.status.failed[k].last_error.kind, k);
  for (const k of ["ok", "started", "error_detail", "not_connected", "not_connected_lost", "refused_locally", "link_lost"]) assert.ok(isObj(S.call[k]), k);
  for (const ev of EVENTS.filter((e) => e !== "link")) assert.ok(isObj(S.events[ev]), `event ${ev} is sampled`);
});

// ================================================================ F-01: a failed connect reaches the Setup screen
const EXPECT_STATE = { missing: "not_installed", unavailable: "not_installed", denied: "not_allowed", not_allowed: "not_allowed", busy: "busy", untrusted: "error", closed: "error", timeout: "error" };
const EXPECT_COMMAND = { missing: "sudo bash install.sh", unavailable: "sudo systemctl enable --now linux-xtu-helper.socket", denied: "sudo bash install.sh", not_allowed: "sudo bash install.sh --add-user $USER", busy: null, untrusted: null };

test("F-01: every failed-connect status from the shell normalizes to its state, kind and message, and the fixable ones open Setup", () => {
  for (const [kind, status] of Object.entries(S.status.failed)) {
    const link = normalizeLink(status);
    assert.equal(link.state, EXPECT_STATE[kind], kind);
    assert.equal(link.kind, kind);
    assert.equal(link.message, status.last_error.message, `${kind}: the shell's own text (it names the fix)`);
    assert.equal(needsSetup(link), SETUP_KINDS.includes(kind), kind);
    if (SETUP_KINDS.includes(kind)) {
      const m = setupModel(link);
      assert.equal(m.kind, kind);
      assert.equal(m.text, status.last_error.message);
      assert.equal(m.command, EXPECT_COMMAND[kind], kind);
    }
    if (FIXES[link.state]) assert.equal(link.fix, FIXES[link.state], `${kind}: the status bar's fix`);
  }
  const up = normalizeLink(S.status.connected);
  assert.deepEqual([up.state, up.kind, up.fix, needsSetup(up)], ["connected", null, null, false]);
  const never = normalizeLink(S.status.not_connected);
  assert.deepEqual([never.state, never.kind, needsSetup(never)], ["error", "not_connected", false]);
});

test("F-01: through the Tauri transport, a failed helper_connect shows Setup; Retry connects and runs the start-up exactly once", async () => {
  const f = fakeTauri({ connect: [S.status.failed.missing, S.status.connected], call: startUpAnswers });
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  const h = harness(bridge);
  const link = await bridge.connect();
  assert.equal(h.store.get().link.state, "not_installed");
  assert.equal(h.store.get().link.message, S.status.failed.missing.last_error.message);
  assert.ok(needsSetup(h.store.get().link), "the Setup screen replaces the work screens");
  assert.equal(setupModel(link).command, "sudo bash install.sh");
  assert.equal(h.cycle.ready, null, "no start-up while down");
  // Setup's Retry is bridge.connect() (views/setup.js); the app's link watcher runs the start-up
  assert.equal((await bridge.connect()).state, "connected");
  await h.cycle.ready;
  assert.equal(h.store.get().link.state, "connected");
  assert.ok(!needsSetup(h.store.get().link));
  assert.deepEqual(f.calls().map((a) => a.op), ["preflight", "tune.last", "telemetry.start"]);
  assert.equal(h.store.get().mode.label, "read-only", "the preflight landed in the store");
  assert.equal(h.scheduled.length, 0, "no reconnect loop is pending once connected");
});

// ================================================================ F-02: helper://closed
test("F-02: helper://closed marks the link down and the telemetry stale; calls never reconnect; the loop does, and the start-up (telemetry) runs again", async () => {
  let down = false;
  const f = fakeTauri({ connect: [S.status.connected, S.status.connected], call: (a) => (down ? S.call.not_connected_lost : startUpAnswers(a)) });
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  const h = harness(bridge);
  await bridge.connect();
  await h.cycle.ready;
  f.fire("helper://telemetry", S.events.telemetry.payload);
  assert.equal(h.store.get().telemetry.samples.pkg_power.value, 85.2);
  const lastT = h.store.get().telemetry.t;

  down = true;
  f.fire(S.events.closed.name, S.events.closed.payload);
  const st = h.store.get();
  assert.deepEqual([st.link.state, st.link.kind], ["error", "closed"]);
  assert.match(st.link.message, /lost \(eof\).*Reconnecting/);
  assert.equal(linkLabel(st.link), "helper disconnected");
  assert.equal(st.telemetry.values, null, "no frozen values");
  for (const s of SERIES) assert.deepEqual([st.telemetry.samples[s.key].value, st.telemetry.samples[s.key].reason], [null, "helper disconnected"], s.key);
  assert.equal(st.telemetry.history.pkg_power.at(-1), null, "the sparkline gets a gap");
  assert.equal(st.telemetry.t, lastT, "the age of the last sample stays visible");
  assert.equal(st.telemetry.throttle.state, "na");
  assert.equal(st.helperOp.state, "disconnected");
  assert.ok(h.toasts.some(([k, t]) => k === "warn" && /lost/.test(t)));

  // a background poll while down: answered NOT_CONNECTED by the shell, which was not asked to reconnect
  const r = await bridge.call("throttle.tail", { n: 5 });
  assert.deepEqual([r.ok, r.error.code, r.error.detail.kind], [false, "NOT_CONNECTED", "closed"]);
  assert.equal(f.invokes.filter(([c]) => c === "helper_connect").length, 1, "only the boot connect so far");
  assert.ok(f.calls().every((a) => !("reconnect" in a)), "the bridge never asks helper_call to reconnect");

  // the loop: one helper_connect after the first backoff step, then the start-up again (telemetry.start included)
  assert.equal(h.scheduled.length, 1);
  down = false;
  assert.equal(await h.runNext(), 1000);
  await h.cycle.ready;
  assert.equal(f.invokes.filter(([c]) => c === "helper_connect").length, 2);
  assert.deepEqual(f.calls().map((a) => a.op), ["preflight", "tune.last", "telemetry.start", "throttle.tail", "preflight", "tune.last", "telemetry.start"]);
  assert.equal(h.store.get().link.state, "connected");
  assert.ok(h.toasts.some(([k, t]) => k === "ok" && /Reconnected/.test(t)));
  f.fire("helper://telemetry", S.events.telemetry.payload);
  assert.equal(h.store.get().telemetry.samples.pkg_power.value, 85.2, "telemetry flows again");
});

test("F-02: the loop backs off while the helper stays away and stops on a failure a retry cannot change", async () => {
  const f = fakeTauri({ connect: [S.status.connected, S.status.failed.missing, S.status.failed.unavailable, S.status.failed.not_allowed], call: startUpAnswers });
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  const h = harness(bridge, { delays: [1000, 2000, 4000] });
  await bridge.connect();
  await h.cycle.ready;
  f.fire("helper://closed", { reason: "eof" });
  assert.equal(await h.runNext(), 1000);
  assert.equal(h.store.get().link.state, "not_installed"); // the socket is gone for a moment (reinstall): Setup shows, the loop keeps going
  assert.equal(await h.runNext(), 2000);
  assert.equal(h.store.get().link.kind, "unavailable");
  assert.equal(await h.runNext(), 4000);
  assert.equal(h.store.get().link.kind, "not_allowed");
  assert.ok(NO_RETRY_KINDS.includes("not_allowed"));
  assert.equal(h.scheduled.length, 0, "not_allowed waits for the operator's fix and Retry");
  h.cycle.dispose();
});

test("F-02: a `closed` from a connection attempt that never came up (a refused handshake) is not a loss: no toast, no loop, the attempt's answer decides", async () => {
  // connect.rs handshake: Link::start, the helper sends its REFUSED line and hangs up, the reader ends -> the events sampled below, then helper_connect answers busy
  assert.deepEqual(S.failed_connect_events.map((e) => e.name), ["helper://closed"], "what the shell emits for a refused handshake");
  let fire = null;
  const listened = new Map();
  const tauri = {
    core: {
      invoke: async (cmd) => {
        if (cmd !== "helper_connect") return clone(S.call.not_connected);
        for (const e of S.failed_connect_events) fire(e.name, e.payload);
        return clone(S.status.failed.busy);
      },
    },
    event: { listen: async (name, cb) => (listened.set(name, cb), () => listened.delete(name)) },
  };
  fire = (name, payload) => listened.get(name)?.({ event: name, payload });
  const bridge = new Bridge(createTauriTransport(tauri), "tauri");
  const h = harness(bridge);
  const closed = [];
  bridge.on("closed", (p) => closed.push(p));
  const link = await bridge.connect();
  assert.deepEqual([link.state, link.kind], ["busy", "busy"]);
  assert.deepEqual(closed, [], "not dispatched as a loss");
  assert.deepEqual(h.toasts, []);
  assert.equal(h.scheduled.length, 0, "busy is not retried by the loop");
  assert.ok(needsSetup(h.store.get().link));
  // the same while the loop is already reconnecting after a real loss: the failed attempt's `closed` does not restart the backoff
  const f = fakeTauri({ connect: [S.status.connected, S.status.failed.closed, S.status.connected], call: startUpAnswers });
  const b2 = new Bridge(createTauriTransport(f.tauri), "tauri");
  const h2 = harness(b2, { delays: [1000, 2000] });
  await b2.connect();
  await h2.cycle.ready;
  f.fire("helper://closed", { reason: "eof" });
  assert.equal(h2.scheduled.length, 1);
  const attempt = h2.scheduled.shift();
  for (const e of S.failed_connect_events) f.fire(e.name, e.payload); // the next attempt's own handshake ending, before its answer
  await attempt.fn();
  assert.equal(h2.store.get().link.kind, "closed");
  assert.deepEqual(h2.scheduled.map((s) => s.ms), [2000], "backoff continues, not restarted");
  assert.equal(h2.toasts.filter(([k]) => k === "warn").length, 1, "one loss, one toast");
  await h2.runNext();
  await h2.cycle.ready;
  assert.equal(h2.store.get().link.state, "connected");
});

test("F-02 (mock): the mock drops its link like the shell; telemetry stops, a wait() ends LINK_LOST, and after the reconnect telemetry restarts", async () => {
  const t = createMockTransport({ intervalMs: 10, stepMs: 20 });
  const bridge = new Bridge(t, "mock");
  const h = harness(bridge);
  const closed = [];
  bridge.on("closed", (p) => closed.push(p));
  await bridge.connect();
  await h.cycle.ready;
  await until(() => h.store.get().telemetry.values !== null);
  const started = await bridge.call("tune.read");
  sameShape(started, S.call.started, "mock long op started");
  const waiting = bridge.wait(started.id);
  sameShape((await t.status()), S.status.connected, "mock connected status with a long op in flight");
  assert.equal((await t.status()).pending_long, 1);

  t.dropLink("eof");
  const fin = await waiting;
  assert.deepEqual([fin.id, fin.ok, fin.error.code, fin.error.message], [started.id, false, "LINK_LOST", LINK_LOST_MESSAGE]);
  sameShape(fin, S.link_lost_result, "mock LINK_LOST result");
  assert.deepEqual(closed, [S.events.closed.payload]);
  const lost = await t.status();
  sameShape(lost, S.status.lost, "mock lost status");
  assert.deepEqual(lost.last_error, S.status.lost.last_error, "the shell's words");
  assert.equal(h.store.get().telemetry.values, null);
  await sleep(40);
  assert.equal(h.store.get().telemetry.values, null, "no telemetry while down");
  const r = await bridge.call("audit.tail", { n: 3 });
  assert.deepEqual(r, S.call.not_connected_lost, "a call while down: the shell's NOT_CONNECTED, nothing reconnected");
  assert.equal((await t.status()).connected, false);

  await h.runNext();
  await h.cycle.ready;
  assert.equal(h.store.get().link.state, "connected");
  await until(() => h.store.get().telemetry.values !== null);
  await bridge.close();
});

// ================================================================ F-03: event names
test("F-03: every event the UI subscribes to is listened under the name the shell emits, and Tauri accepts it", async () => {
  const f = fakeTauri();
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await bridge.connect();
    const got = {};
    for (const ev of EVENTS.filter((e) => e !== "link")) bridge.on(ev, (p) => (got[ev] = p));
    await sleep(5);
    for (const ev of EVENTS.filter((e) => e !== "link")) {
      const { name, payload } = S.events[ev];
      assert.equal(tauriEventName(ev), name, ev);
      assert.ok(tauriAccepts(name), name);
      assert.ok(f.listened.has(name), `listening to ${name}`);
      f.fire(name, payload);
      assert.deepEqual(got[ev], payload, `${ev} reaches the UI's subscribers`);
    }
    assert.deepEqual(errors, []);
  } finally {
    console.error = orig;
  }
  assert.equal(tauriEventName("vf.point"), "helper://vf-point");
  assert.ok(!tauriAccepts("helper://vf.point"), "the fake applies Tauri's rule");
});

test("F-03: a listen the runtime refuses is logged, not swallowed", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  try {
    const bridge = new Bridge({ connect: async () => ({ connected: true }), call: async () => ({ ok: true, result: {} }), listen: (ev) => { if (ev === "bogus") throw new Error("IllegalEventName"); return () => {}; } }, "x");
    bridge.on("bogus", () => {});
    await sleep(5);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /cannot listen to bogus/.test(e) && /IllegalEventName/.test(e)), errors.join("\n"));
});

// ================================================================ F-04: error.detail
test("F-04: the shell passes the detail keys the UI reads; 'Nothing was written' is recognised from a real filtered error", () => {
  const err = S.call.error_detail.error;
  assert.equal(err.detail.writes_sent, 0);
  assert.equal(err.detail.key, "pl1_w");
  assert.ok(Array.isArray(err.detail.problems) && err.detail.problems.length <= S.detail_allow.lists.problems && err.detail.problems.every((p) => typeof p === "string"));
  assert.match(err.detail.problems.at(-1), /more not shown/, "a capped list says so");
  for (const gone of ["partial", "path", "ops_done", "tripped", "op_id"]) assert.ok(!(gone in err.detail), `${gone} does not reach the webview`);
  for (const status of ["failed", "cancelled"]) assert.equal(noWrites({ status, error: err }), true, status);
  assert.deepEqual(S.events.result.payload, S.call.error_detail, "a long op's result is filtered the same way");
});

/** Every `detail.<key>` the UI source reads off a helper error. */
function detailReads() {
  const ui = join(here, "..");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "tests" && name !== "fixtures") walk(p);
      } else if (name.endsWith(".js")) files.push(p);
    }
  };
  walk(ui);
  const reads = new Map();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\bdetail\.([a-z_]+)/g)) if (!reads.has(m[1])) reads.set(m[1], f.slice(ui.length + 1));
  return reads;
}
// keys that are not a helper error's detail
const NOT_HELPER_DETAIL = { requests: "the tune:review DOM CustomEvent's detail (profiles.js, runtime-kinds.js, apply.js)" };

test("F-04: every helper error detail key the UI reads is on the shell's allowlist", () => {
  const allowed = new Set([...S.detail_allow.scalars, ...Object.keys(S.detail_allow.lists)]);
  const reads = detailReads();
  assert.ok(reads.size >= 5, `found only ${[...reads.keys()]}: the scan is broken`);
  const missing = [...reads].filter(([k]) => !allowed.has(k) && !NOT_HELPER_DETAIL[k]).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], "the UI reads detail keys the shell strips");
});

test("F-04: the mock filters details exactly as the shell does (same allowlist, same output for the same helper error)", () => {
  assert.deepEqual(DETAIL_ALLOW, S.detail_allow);
  // the very error contract_samples.rs sends through link.rs public_response
  const problems = Array.from({ length: 12 }, (_, i) => `P0 point ${i + 1}: no stable reading`);
  const raw = { id: "d1", ok: false, error: { code: "CANCELLED", message: "vf.measure was cancelled; the points measured so far were kept",
    detail: { check: "PLAN_ERROR", writes_sent: 0, ops_done: 3, key: "pl1_w", state: "idle", curve_id: "20261111T101500Z-a1b2", problems, partial: { units: { P0: { points: [] } } }, tripped: false, op_id: "d1", path: "/etc/linux-xtu/policy.toml" } } };
  assert.deepEqual(publicResponse(raw), S.call.error_detail);
  assert.deepEqual(publicResponse({ id: "d2", ok: true, result: { profiles: [] }, extra: 1 }), S.call.ok);
});

// ================================================================ F-15: a wait() never hangs on a lost answer
function beatingBridge() {
  let clock = 0;
  const handlers = {};
  const bridge = new Bridge({
    connect: async () => clone(S.status.connected),
    call: async (op, args) => (op === "cancel" ? { id: "d9", ok: true, result: { cancelled: true, op_id: args.op_id } } : clone(S.call.started)),
    listen: (ev, cb) => ((handlers[ev] = cb), () => delete handlers[ev]),
  }, "x", { now: () => clock });
  return { bridge, beat: (op_id) => handlers.heartbeat({ ...S.events.heartbeat.payload, op_id }), result: (p) => handlers.result(p), tick: (ms) => (clock += ms) };
}

test("F-15: a long op the helper no longer runs ends STALE once its heartbeats say so; one it still runs keeps waiting", async () => {
  const { bridge, beat, tick } = beatingBridge();
  await bridge.connect();
  const first = await bridge.call("tune.read");
  sameShape(first, S.call.started);
  let fin = null;
  bridge.wait(first.id).then((r) => (fin = r));
  await sleep(0);
  for (let i = 0; i < 10; i++) {
    tick(2000);
    beat(first.id); // the helper still runs it
  }
  await sleep(0);
  assert.equal(fin, null, "still running: keeps waiting");
  for (let i = 0; i < STALE_BEATS - 1; i++) {
    tick(2000);
    beat(null);
  }
  await sleep(0);
  assert.equal(fin, null, "not yet: fewer than STALE_BEATS heartbeats in a row");
  tick(2000);
  beat(null);
  await sleep(0);
  assert.deepEqual([fin.id, fin.ok, fin.error.code], [first.id, false, "STALE"]);
  assert.match(fin.error.message, /no longer running/);
});

test("F-15: STALE needs the minimum wait too; a late real result still wins before it; cancel() sends cancel {op_id}", async () => {
  const { bridge, beat, result, tick } = beatingBridge();
  await bridge.connect();
  let fin = null;
  bridge.wait("d1").then((r) => (fin = r));
  for (let i = 0; i < STALE_BEATS + 2; i++) beat(null); // many beats, no time passed
  await sleep(0);
  assert.equal(fin, null);
  tick(STALE_MIN_MS - 1);
  beat(null);
  await sleep(0);
  assert.equal(fin, null, "under STALE_MIN_MS");
  result({ ...S.events.result.payload, id: "d1" });
  await sleep(0);
  assert.equal(fin.error.code, "CANCELLED", "the real answer");
  const c = await bridge.cancel("d1");
  assert.deepEqual(c.result, { cancelled: true, op_id: "d1" });
});

test("F-15/F-02: a wait() still pending when the link closes ends LINK_LOST", async () => {
  const f = fakeTauri({ call: () => S.call.started });
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  await bridge.connect();
  const first = await bridge.call("vf.measure", { mode: "quick" });
  const w = bridge.wait(first.id);
  f.fire("helper://closed", { reason: "read error" });
  const fin = await w;
  assert.deepEqual([fin.ok, fin.error.code, fin.error.message], [false, "LINK_LOST", LINK_LOST_MESSAGE]);
  assert.match(bridge.link.message, /read error/);
});

// ================================================================ the bridge reads every call answer the shell gives
test("contract: call answers pass through the bridge as the views expect them", async () => {
  for (const [name, reply] of Object.entries(S.call)) {
    const bridge = new Bridge({ connect: async () => clone(S.status.connected), call: async () => clone(reply), listen: () => () => {} }, "x");
    const r = await bridge.call("preflight");
    if (name === "started") assert.deepEqual(r, { ok: true, pending: true, id: reply.id });
    else assert.deepEqual(r, reply, name);
    assert.equal(typeof r.ok, "boolean", name);
    if (!r.ok) assert.ok(typeof r.error.code === "string" && typeof r.error.message === "string", name);
  }
});

test("contract: a call made while connect() is in flight waits for it instead of failing", async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const order = [];
  const bridge = new Bridge({
    connect: async () => (await gate, order.push("connect"), clone(S.status.connected)),
    call: async (op) => (order.push(op), clone(S.call.ok)),
    listen: () => () => {},
  }, "x");
  const c = bridge.connect();
  const r = bridge.call("throttle.tail", { n: 5 });
  await sleep(5);
  assert.deepEqual(order, []);
  open();
  await c;
  assert.equal((await r).ok, true);
  assert.deepEqual(order, ["connect", "throttle.tail"]);
});

// ================================================================ item 7: the mock answers in the shell's shapes
test("mock parity: status before any connect, after each failed connect and once connected", async () => {
  const fresh = createMockTransport({ intervalMs: 10_000 });
  sameShape(await fresh.status(), S.status.not_connected, "before connect");
  assert.deepEqual((await fresh.status()).last_error, S.status.not_connected.last_error);
  const nc = await fresh.call("preflight", {});
  sameShape(nc, S.call.not_connected, "call before connect");
  assert.deepEqual(nc.error.detail, { kind: "not_connected" });
  const up = await fresh.connect();
  sameShape(up, S.status.connected, "connected");
  assert.deepEqual([up.path, up.dev_socket, up.last_error], [S.status.connected.path, false, null]);
  sameShape(up.preflight, S.status.connected.preflight, "preflight");
  fresh.close();

  const MODE_KIND = { busy: "busy", not_installed: "missing", not_allowed: "not_allowed", error: "closed" };
  for (const [mode, kind] of Object.entries(MODE_KIND)) {
    const t = createMockTransport({ intervalMs: 10_000, helper: mode });
    const s = await t.connect();
    sameShape(s, S.status.failed[kind], mode);
    assert.deepEqual(s.last_error, S.status.failed[kind].last_error, `${mode}: the shell's kind and words`);
    assert.deepEqual(LINK_FAILURES[mode], S.status.failed[kind].last_error);
    const r = await t.call("preflight", {});
    sameShape(r, S.call.not_connected, `${mode}: call`);
    assert.deepEqual(r.error.detail, { kind });
    t.close();
  }
});

test("mock parity: short answers, errors and the long-op start look like the shell's", async () => {
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1 });
  await t.connect();
  const ok = await t.call("profiles.list", {});
  sameShape(ok, S.call.ok, "ok");
  const unk = await t.call("nope.op", {});
  sameShape(unk, { id: "x", ok: false, error: { code: "X", message: "m" } }, "error without detail");
  const started = await t.call("tune.read", {});
  sameShape(started, S.call.started, "started");
  t.close();
});

// ================================================================ R-S3: the shell owns the confirmation (D-053 item 4, F-06)
const C = S.confirm;
const strip = (r) => ({ ok: r.ok, ...(r.ok ? { result: r.result } : { error: r.error }) });

test("R-S3: the webview's plan carries no confirmation code, from the shell and from the mock", async () => {
  assert.ok(isObj(C.plan.result) && typeof C.plan.result.plan_id === "string");
  assert.equal("nonce" in C.plan.result, false);
  assert.equal(C.wire_apply.args.typed, "CONFIRM Q2W3E4", "the shell kept it and sent it on the wire");
  assert.deepEqual(SHELL_OPS, C.shell_ops);
  assert.ok(SHELL_OPS.includes(CONFIRM_OP));
  assert.deepEqual(PERSIST_OPS, C.persist_ops);
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1 });
  await t.connect();
  const plans = [
    await t.call("tune.plan", { intent: { scope: "unit", rows: [{ target: "P0", offset: { kind: "points", mv: { 53: -20 } }, v_target_v: null, ratio: null }] } }),
    await t.call("power.plan", { power: { pl1_w: 230 } }),
    await t.call("runtime.plan", { caps: { 0: 50 } }),
  ];
  for (const p of plans) {
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal("nonce" in p.result, false, "the mock's shell keeps the code too");
    assert.match(p.result.plan_id, /^[0-9a-f]{64}$/, "a plan id the shell accepts");
  }
  t.close();
});

test("R-S3: the mock answers the confirmation contract word for word (refusals before anything is sent, confirmed, spent)", async () => {
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1 });
  await t.connect();
  const plan = (await t.call("tune.plan", { intent: { scope: "unit", rows: [{ target: "P0", offset: { kind: "points", mv: { 53: -20 } }, v_target_v: null, ratio: null }] } })).result;
  assert.deepEqual(strip(await t.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.plan_id, typed: "CONFIRM Q2W3E4" }] })), C.confirm.bad_args);
  assert.deepEqual(strip(await t.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: "9".repeat(64) }] })), C.confirm.stale);
  assert.deepEqual(strip(await t.call("tune.apply", { plan_id: plan.plan_id })), C.apply.unconfirmed);
  assert.deepEqual(strip(await t.call("tune.apply", { plan_id: plan.plan_id, typed: "CONFIRM Q2W3E4" })), C.apply.typed_from_page);
  const yes = await t.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.plan_id }] });
  sameShape(yes, C.confirm.confirmed, "confirmed");
  assert.deepEqual({ ...yes.result, dialog: undefined }, { confirmed: true, plans: 1, writes: plan.writes, dialog: undefined });
  sameShape(yes.result.dialog, C.dialog, "the confirmed answer carries the dialog text");
  assert.match(yes.result.dialog.secondary, /(^|\n)• P0 · point 5 · 53× · offset 0 → −19\.5 mV\n/, "the value, not just the unit");
  sameShape(await t.call("tune.apply", { plan_id: plan.plan_id }), C.apply.started, "sent");
  assert.deepEqual(strip(await t.call("tune.apply", { plan_id: plan.plan_id })), C.apply.spent);
  assert.deepEqual(strip(await t.call("profiles.accept", { plan_id: "6".repeat(64), typed: "CONFIRM Z9X8C7" })), C.accept.step2_from_page);
  t.close();
  for (const [mode, sample, accept] of [["no", C.confirm.not_confirmed, C.accept.not_confirmed], ["unavailable", C.confirm.unavailable, null]]) {
    const m = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1, confirm: mode });
    await m.connect();
    const p = (await m.call("power.plan", { power: { pl1_w: 230 } })).result;
    assert.deepEqual(strip(await m.call("app.confirm", { plans: [{ op: "power.apply", plan_id: p.plan_id }] })), sample, mode);
    assert.deepEqual(strip(await m.call("power.apply", { plan_id: p.plan_id })), C.apply.unconfirmed, `${mode}: still nothing to send`);
    if (accept) {
      const busy = await m.call("profiles.accept", { name: "x" });
      assert.deepEqual([busy.error.code, busy.error.detail.writes_sent], ["BUSY", 0], "no dialog for 2 s after a Cancel (confirm.rs COOLDOWN)");
      const fresh = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1, confirm: "no" });
      await fresh.connect();
      assert.deepEqual(strip(await fresh.call("profiles.accept", { name: "good-p57" })), accept, "a persistent op has its own dialog");
      fresh.close();
    }
    m.close();
  }
  for (const k of ["unconfirmed", "typed_from_page", "spent"]) assert.equal(noWrites({ status: "failed", error: C.apply[k].error }), true, k);
  assert.equal(noWrites({ status: "failed", error: C.confirm.not_confirmed.error }), true);
});

test("R-S3: through the Tauri transport the commit sheet never sends a code and never applies without the shell's yes", async () => {
  let dialog = C.confirm.not_confirmed;
  const f = fakeTauri({
    call: (a) => {
      if (a.op === "tune.plan") return C.plan;
      if (a.op === "app.confirm") return dialog;
      if (a.op === "tune.apply") return C.apply.started;
      if (a.op === "tune.last") return { id: "d8", ok: true, result: { available: false } };
      return S.call.ok;
    },
  });
  const bridge = new Bridge(createTauriTransport(f.tauri), "tauri");
  await bridge.connect();
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  const kinds = { tune: { label: "V/F", planOp: "tune.plan", applyOp: "tune.apply", request: () => ({ intent: { scope: "unit", rows: [] } }) } };
  const ctl = createApplyController({ store, bridge, kinds });
  assert.equal(await ctl.review(["tune"]), "review");
  assert.equal(await ctl.apply(), false, "the operator clicked Cancel");
  assert.deepEqual(f.calls().map((a) => a.op), ["tune.plan", "app.confirm"], "no apply was even asked for");
  assert.equal(store.get().apply.confirm.code, "NOT_CONFIRMED");
  dialog = C.confirm.confirmed;
  const done = ctl.apply();
  await until(() => f.calls().some((a) => a.op === "tune.apply"));
  const apply = f.calls().find((a) => a.op === "tune.apply");
  assert.deepEqual(apply.args, { plan_id: C.plan.result.plan_id, intent: { scope: "unit", rows: [] } }, "the plan id and the intent on screen (R-I1), never a code");
  f.fire("helper://result", { id: C.apply.started.id, ok: true, result: { complete: true, readback: [] } });
  await done;
  for (const a of f.calls()) assert.ok(!JSON.stringify(a).includes("CONFIRM "), "no confirmation code ever leaves the page: " + JSON.stringify(a));
  assert.deepEqual(f.calls().filter((a) => a.op === "app.confirm").map((a) => a.args), [1, 2].map(() => ({ plans: [{ op: "tune.apply", plan_id: C.plan.result.plan_id }] })));
});

// ================================================================ R-I1: the dialog's values, the new arguments, the version handshake — mock and shell alike
test("R-I1: the shell's dialog names every value (raises first, counted) and fails closed on a value it cannot name; the mock builds the same text", () => {
  assert.match(C.dialog.secondary, /^↑ raises a voltage: 2 lines listed first\n• ↑ P2 · OC point · ratio unset → 58× · target unset → 1\.250 V\n/);
  assert.ok(C.dialog.secondary.includes("• turbo table P · 57 57 55 55 55 55 55 55 → 56 56 54 54 54 54 54 54\n"));
  assert.match(C.dialog.secondary, /\n\nEach write is read back\. Undo: Restore accepted, or a cold boot\.$/, "G-252: one short closing line");
  assert.doesNotMatch(C.dialog.secondary, /V\/F and ratio words|sent alone/, "G-252: no repeated label or paragraph");
  assert.equal(C.confirm.undescribed.error.code, "CONFIRM_UNAVAILABLE");
  assert.equal(C.confirm.undescribed.error.detail.writes_sent, 0);
  assert.equal(noWrites({ status: "failed", error: C.confirm.undescribed.error }), true);
  const items = {};
  for (const [name, c] of Object.entries(S.dialog.cases)) {
    const got = itemOf({ kind: c.kind, plan: c.plan, request: c.request, tables: c.tables });
    if (c.error !== null) assert.deepEqual(got, { error: c.error }, `${name}: the same refusal`);
    else {
      assert.deepEqual({ label: got.item.label, writes: got.item.writes, targets: got.item.targets, raises: got.item.raises, conditional: got.item.conditional }, c.item, `${name}: the same lines`);
      items[name] = got.item;
    }
  }
  assert.ok(Object.values(S.dialog.cases).some((c) => c.error) && Object.values(S.dialog.cases).some((c) => c.item && c.item.raises > 0), "the samples cover both");
  for (const t of S.dialog.texts) assert.deepEqual(dialogText(t.items.map((n) => items[n])), t.text, `text of ${t.items.join(", ")}`);
});

test("R-I1: the mock checks the new arguments exactly as the shell does (preflight, plans, profiles.save / accept, applies with an intent)", () => {
  assert.ok(S.validators.wire.some((c) => c.ok) && S.validators.wire.some((c) => !c.ok));
  for (const c of S.validators.wire) {
    const got = checkArgs(c.op, clone(c.args));
    assert.equal(got === null, c.ok, `${c.op} ${JSON.stringify(c.args)}`);
  }
  assert.deepEqual(checkArgs("power.plan", { restore: "boot" }), S.validators.refusal.error, "the same refusal text");
  for (const c of S.validators.page) {
    const got = webviewApplyArgs({ "tune.apply": "tune", "power.apply": "power", "runtime.apply": "runtime" }[c.op], clone(c.args));
    assert.equal(!got.refusal, c.ok, `page ${c.op} ${JSON.stringify(c.args)}`);
  }
  assert.deepEqual(MUTATING_OPS, C.mutating_ops);
});

test("R-I1: through the mock, an apply forwards the page's intent; a changed intent is refused by the helper (PLAN_STALE / INTENT_CHANGED), nothing written", async () => {
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1 });
  await t.connect();
  const bridge = new Bridge(t, "mock");
  const intent = (mv) => ({ scope: "unit", rows: [{ target: "P0", offset: { kind: "points", mv: { 53: mv } }, v_target_v: null, ratio: null }] });
  const plan = (await t.call("tune.plan", { intent: intent(-25) })).result;
  assert.equal((await t.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.plan_id }] })).ok, true);
  const res = await bridge.run("tune.apply", { plan_id: plan.plan_id, intent: intent(-30) });
  assert.deepEqual([res.ok, res.error.code, res.error.detail], [false, "PLAN_STALE", { check: "INTENT_CHANGED", writes_sent: 0 }], JSON.stringify(res));
  assert.equal(noWrites({ status: "stale", error: res.error }), true);
  const again = await t.call("tune.apply", { plan_id: plan.plan_id, intent: intent(-25) });
  assert.equal(again.error.code, "PLAN_STALE", "the plan was spent by the refusal");
  const bad = await t.call("tune.apply", { plan_id: plan.plan_id, intent: { power: { pl1_w: 200 } } });
  assert.deepEqual([bad.error.code, bad.error.detail.writes_sent], ["BAD_REQUEST", 0], "an intent of the wrong shape never leaves the shell");
  assert.deepEqual(strip(await t.call("power.plan", { restore: "boot" })), { ok: false, error: S.validators.refusal.error });
  t.close();
});

test("R-I1: through the mock, the dialog's turbo line takes the old ratios from the helper's read and the new ones from the intent; a profile's table write gets no dialog", async () => {
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1, profiles: "accepted" });
  await t.connect();
  const bridge = new Bridge(t, "mock");
  const read = await bridge.run("tune.read", {});
  assert.equal(read.ok, true);
  assert.deepEqual(t.tables(), read.result.tables, "the shell keeps the tables the read reported");
  const lower = read.result.tables.p.map((r) => r - 1);
  const plan = (await t.call("tune.plan", { intent: { turbo: { P: lower } } })).result;
  const ok = await t.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.plan_id }] });
  assert.ok(ok.result.dialog.secondary.includes(`turbo table P · ${read.result.tables.p.join(" ")} → ${lower.join(" ")}`), ok.result.dialog.secondary);
  const done = await bridge.run("tune.apply", { plan_id: plan.plan_id, intent: { turbo: { P: lower } } });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(t.tables().p, lower, "the read-back of the table write is the table in force");
  t.close();
});

test("R-I1: the version handshake — the mock compares the helper's answer as the shell does, and the samples reach the page as the shell means them", async () => {
  assert.deepEqual(CLIENT, S.version.client);
  assert.deepEqual({ client: CLIENT }, S.version.preflight_args);
  assert.deepEqual(APP, S.status.connected.version.app, "the app's name, version, protocol and op-set hash");
  assert.equal(REINSTALL, S.version.cases.protocol_differs.version.fix);
  for (const [name, c] of Object.entries(S.version.cases)) {
    const v = versionCheck(clone(c.raw));
    assert.deepEqual(v.value, c.version, `${name}: version`);
    assert.deepEqual(v.decorate(publicResponse(clone(c.raw))), c.webview, `${name}: the preflight the page gets`);
  }
  // the shell's samples through the bridge: a helper of another protocol stays connected (reads work) and says why, with the fix; writes are off
  const other = { ...clone(S.status.connected), version: S.version.cases.protocol_differs.version };
  const link = normalizeLink(other);
  assert.deepEqual([link.state, link.kind, link.fix], ["connected", "version", REINSTALL]);
  assert.match(link.message, /^Helper and app versions differ/);
  assert.deepEqual(normalizeLink(S.status.connected), { state: "connected", kind: null, message: "", fix: null }, "a matching helper is a plain connected link");
  const store = createAppStore();
  setPreflight(store, S.version.cases.protocol_differs.webview.result);
  assert.equal(store.get().mode.writes, false);
  assert.match(store.get().mode.reason, /^app_version: Helper and app versions differ/);
  setPreflight(store, S.version.cases.ops_differ.webview.result);
  assert.equal(store.get().mode.writes, true, "another op set is a note, not a fence");
});

test("R-I1: a mock helper of another protocol (?helper=version): connected and readable, every write refused here with the reason, the page's preflight decorated", async () => {
  const t = createMockTransport({ intervalMs: 10_000, stepMs: 1, confirmMs: 1, helper: "version" });
  const status = await t.connect();
  sameShape(status, S.status.connected, "the shell's connected shape");
  assert.deepEqual([status.version.protocol_ok, status.version.fix], [false, REINSTALL]);
  assert.equal(status.preflight.result.writes_allowed, false);
  assert.equal(status.preflight.result.checks[0].name, "app_version");
  const bridge = new Bridge(t, "mock");
  assert.equal((await bridge.connect()).kind, "version");
  for (const [op, args] of [["app.confirm", { plans: [{ op: "tune.apply", plan_id: "a".repeat(64) }] }], ["tune.apply", { plan_id: "a".repeat(64) }], ["profiles.accept", { name: "x" }], ["profiles.save", { name: "x", from: "read" }]]) {
    const r = await t.call(op, args);
    assert.deepEqual([r.error.code, r.error.detail.writes_sent], ["VERSION_MISMATCH", 0], op);
  }
  assert.equal((await t.call("profiles.list", {})).ok, true, "reads still work");
  assert.equal((await t.call("preflight", { client: CLIENT })).error.code, "BAD_REQUEST", "the page cannot declare a client");
  const pre = await t.call("preflight", {});
  assert.deepEqual([pre.result.writes_allowed, pre.result.checks[0].status, pre.result.client.protocol_ok], [false, "fail", false]);
  t.close();
});
