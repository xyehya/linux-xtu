// node --test desktop/app/ui/tests/   (R-F1b: the integration follow-ups of the redesign — the app version through the bridge, the saved settings at boot and
// Hints through them, Setup's version-mismatch state and the System banner in it, the mock's schema-2 profiles. Selectors are data-* / ids, never lx- classes.
// No browser, no helper, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { install, text } from "./fakedom.mjs";

const doc = install();
const { Bridge, createTauriTransport, normalizeLink } = await import("../bridge.js");
const { createMockTransport, APP, REINSTALL } = await import("../fixtures/mock-backend.js");
const { createAppStore, setLink, setPreflight, setPref, PREFS_KEY } = await import("../store.js");
const { loadSettings, persistHints, startUp } = await import("../app.js");
const { createWorkHead } = await import("../components/workhead.js");
const SU = await import("../views/setup.js");
const SY = await import("../views/system.js");
const S = JSON.parse(readFileSync(fileURLToPath(new URL("./contract-samples.json", import.meta.url)), "utf8"));

const FAST = { intervalMs: 5, stepMs: 1, applyMode: null, profiles: null, accept: null, fingerprint: null, confirmMs: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}
const $ = (root, sel) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ================================================================ 1. the app version
test("bridge.appVersion: the shell's app_version (a bare string) arrives as {ok, result}; a backend without it says UNSUPPORTED; the mock answers lib.rs VERSION", async () => {
  const calls = [];
  const tauri = { core: { invoke: async (cmd, args) => (calls.push([cmd, args]), cmd === "app_version" ? "0.2.0-dev" : null) }, event: { listen: async () => () => {} } };
  const b = new Bridge(createTauriTransport(tauri), "tauri");
  assert.deepEqual(await b.appVersion(), { ok: true, result: "0.2.0-dev" });
  assert.deepEqual(calls, [["app_version", undefined]]);
  const bare = new Bridge({ connect: async () => ({}), call: async () => ({}), listen: () => () => {} }, "x");
  assert.equal((await bare.appVersion()).error.code, "UNSUPPORTED");
  const mock = new Bridge(createMockTransport(FAST), "mock");
  assert.deepEqual(await mock.appVersion(), { ok: true, result: APP.version });
  const allowed = JSON.parse(readFileSync(fileURLToPath(new URL("../../src-tauri/capabilities/default.json", import.meta.url)), "utf8")).permissions;
  assert.ok(allowed.includes("allow-app-version"), "the capability allows the command the bridge invokes");
});

// ================================================================ 2. / 3. the saved settings at boot, Hints through them
function settingsBridge(initial, { failSet = false } = {}) {
  let saved = { refresh_s: 1, strip_series: [], window: { density: "comfortable" }, notifications: true, hints: "on", ...initial };
  const sets = [];
  const calls = [];
  return {
    sets, calls,
    settingsGet: async () => ({ ok: true, result: { ...saved } }),
    settingsSet: async (patch) => {
      sets.push(patch);
      if (failSet) return { ok: false, error: { code: "IO", message: "disk full" } };
      saved = { ...saved, ...patch };
      return { ok: true, result: { ...saved } };
    },
    call: async (op, args) => {
      calls.push({ op, args });
      if (op === "preflight") return { ok: true, result: { writes_allowed: true, mode: "write", checks: [] } };
      if (op === "tune.last") return { ok: true, result: { available: false } };
      return { ok: true, result: {} };
    },
  };
}
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test("boot settings: the saved refresh interval reaches the start-up's telemetry.start, the saved Hints mode is applied", async () => {
  const store = createAppStore();
  const b = settingsBridge({ refresh_s: 2, hints: "quiet" });
  const m = await loadSettings({ store, bridge: b });
  assert.deepEqual([m.saved, m.refresh_s, m.hints], [true, 2, "quiet"]);
  assert.equal(store.get().prefs.hints, "quiet", "the saved Hints mode wins over the webview's copy");
  await startUp({ store, bridge: b, toast: () => {} });
  assert.deepEqual(b.calls.find((c) => c.op === "telemetry.start").args, { interval_s: 2 });
});

test("boot settings: without settings commands (the mock) the defaults stay, telemetry runs at 1 s and Hints keeps its localStorage copy", async () => {
  const store = createAppStore();
  const mem = memStorage();
  setPref(store, "hints", "quiet", mem);
  const mock = new Bridge(createMockTransport(FAST), "mock");
  const m = await loadSettings({ store, bridge: mock });
  assert.deepEqual([m.saved, m.refresh_s], [false, 1]);
  assert.equal(store.get().prefs.hints, "quiet");
  assert.equal(JSON.parse(mem.getItem(PREFS_KEY)).hints, "quiet");
  const toasts = [];
  const off = persistHints({ store, bridge: mock, toast: (k, t) => toasts.push([k, t]) });
  setPref(store, "hints", "on", mem);
  await sleep(5);
  assert.deepEqual(toasts, [], "nothing to save to: no error either");
  off();
});

test("Hints persists through settings_set once per change, never on the boot load itself; a failed save says so", async () => {
  const store = createAppStore();
  const b = settingsBridge({ hints: "on" });
  await loadSettings({ store, bridge: b });
  const toasts = [];
  const off = persistHints({ store, bridge: b, toast: (k, t) => toasts.push([k, t]) });
  await sleep(1);
  assert.deepEqual(b.sets, [], "the value the backend already holds is not written back");
  setPref(store, "hints", "quiet", null);
  assert.equal(await until(() => b.sets.length === 1), true);
  assert.deepEqual(b.sets[0], { hints: "quiet" });
  assert.equal(await until(() => store.get().settings.hints === "quiet"), true);
  setPref(store, "hints", "quiet", null);
  await sleep(5);
  assert.equal(b.sets.length, 1, "no change, no write");
  off();

  const store2 = createAppStore();
  const bad = settingsBridge({ hints: "on" }, { failSet: true });
  await loadSettings({ store: store2, bridge: bad });
  const t2 = [];
  persistHints({ store: store2, bridge: bad, toast: (k, t) => t2.push([k, t]) });
  setPref(store2, "hints", "quiet", null);
  assert.equal(await until(() => t2.length === 1), true);
  assert.equal(t2[0][0], "warn");
  assert.match(t2[0][1], /not saved: disk full/);
  assert.equal(store2.get().prefs.hints, "quiet", "the switch still works for this session");
});

test("System Settings: the interval control shows the saved interval; a change goes to telemetry.start, then settings_set, and lands in store.settings", async () => {
  const bridge = new Bridge(createMockTransport(FAST), "mock");
  await bridge.connect();
  const b = settingsBridge({ refresh_s: 0.5 });
  bridge.settingsGet = b.settingsGet;
  bridge.settingsSet = b.settingsSet;
  const store = createAppStore();
  setLink(store, bridge.link);
  await loadSettings({ store, bridge });
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const v = SY.systemView();
  v.mount(root, { store, bridge, toast: () => {}, head: createWorkHead(headEl), goto: () => {} });
  assert.equal($(root, "#sys-refresh [data-value='0.5']").getAttribute("aria-pressed"), "true");
  $(root, "#sys-refresh [data-value='5']").click();
  assert.equal(await until(() => b.sets.length === 1), true);
  assert.deepEqual(b.sets[0], { refresh_s: 5 });
  assert.equal(await until(() => store.get().settings.refresh_s === 5), true);
  v.unmount();
});

// ================================================================ 4. version mismatch: Setup's state, the System banner
const VERSION_STATUS = { ...clone(S.status.connected), version: clone(S.version.cases.protocol_differs.version) };

test("version mismatch: the link keeps what differs; Setup replaces the screens until Continue read-only; a plain connected link never shows Setup", () => {
  const link = normalizeLink(VERSION_STATUS);
  assert.deepEqual(link.versions, { app: { version: "0.2.0-dev", protocol: 1 }, helper: { version: "0.3.0", protocol: 2 } });
  assert.equal(SU.needsSetup(link), true);
  assert.equal(SU.needsSetup(link, { dismissed: true }), false);
  assert.equal(SU.needsSetup(normalizeLink(S.status.connected)), false);
  const store = createAppStore();
  setLink(store, link);
  assert.deepEqual(store.get().link.versions, link.versions);
  assert.equal(SU.showSetup(store.get()), true);
  const m = SU.setupModel(link);
  assert.deepEqual([m.kind, m.command, m.tone], ["version", REINSTALL, "warn"]);
  assert.equal(SU.kindMeta("version"), "versions differ");
  assert.equal(SU.versionText(link.versions.helper), "0.3.0 · protocol 2");
  assert.equal(SU.versionText(null), "n/a · not reported");
});

test("Setup screen, version mismatch (?helper=version): what differs, the reinstall command, Retry re-checks by preflight, Continue read-only", async () => {
  const bridge = new Bridge(createMockTransport({ ...FAST, helper: "version" }), "mock");
  const calls = [];
  const call = bridge.call.bind(bridge);
  bridge.call = async (op, args = {}) => (calls.push(op), call(op, args));
  const store = createAppStore();
  setLink(store, await bridge.connect());
  assert.equal(store.get().link.kind, "version");
  const root = doc.createElement("main");
  const headEl = doc.createElement("div");
  doc.body.append(headEl, root);
  const v = SU.setupView();
  v.mount(root, { store, bridge, toast: () => {}, head: createWorkHead(headEl) });
  assert.equal($(root, "[data-setup-kind]").dataset.setupKind, "version");
  assert.match(text($(root, "[data-setup=versions]")), /This app\s*0\.2\.0-dev · protocol 1\s*Helper\s*0\.3\.0 · protocol 2/);
  assert.equal(text($(root, "[data-setup=command]")), REINSTALL);
  assert.match(text($(root, "[data-setup=retry]")), /^Retry\s*0 req$/);
  $(root, "[data-setup=retry]").click();
  assert.equal(await until(() => /Still different/.test(text($(root, "[data-setup=status]")))), true);
  assert.deepEqual(calls, ["preflight"], "Retry asks for a preflight; it sends no mailbox request");
  assert.equal(store.get().preflight.checks[0].name, "app_version");
  $(root, "[data-setup=continue]").click();
  assert.equal(store.get().setupDismissed, true);
  assert.equal(SU.showSetup(store.get()), false);
  v.unmount();
});

test("System banner, version mismatch: writes are off, reading works (not 'reading and applying are off'); the helper's own refusal keeps its wording", () => {
  const pre = clone(S.version.cases.protocol_differs.webview.result);
  const s = SY.preflightSummary(pre);
  assert.equal(s.writes, false);
  assert.equal(s.version, true);
  assert.match(s.banner, /^Helper and app versions differ/);
  assert.match(s.banner, /Reading works/);
  assert.doesNotMatch(s.banner, /reading and applying are off/);
  const own = SY.preflightSummary({ mode: "write", writes_allowed: false, checks: [{ name: "msr_allow_writes", status: "unknown", reason: "cannot read it" }] });
  assert.match(own.banner, /reading and applying are off/);
  assert.equal(own.version, false);
});

test("store: a subscriber removed during a dispatch is not called by it (a screen unmounted by a nested update cannot write into the next one)", () => {
  const store = createAppStore();
  const calls = [];
  let offB = null;
  // A reacts to the link by updating the store again (as the Overview's events refresh does); the nested update removes B (the screen switch)
  store.subscribe((s, prev) => {
    if (s.link !== prev.link && s.link.state === "connected") {
      offB();
      store.set({ toasts: [] });
    }
  });
  offB = store.subscribe((s, prev) => {
    if (s.link !== prev.link) calls.push("B");
  });
  setLink(store, { state: "connected", kind: "version", message: "m" });
  assert.deepEqual(calls, []);
});

test("System banner, version mismatch: the shell's reason and the reading note are two paragraphs", () => {
  const s = SY.preflightSummary(clone(S.version.cases.protocol_differs.webview.result));
  assert.deepEqual(s.banner.split("\n").slice(1), [SY.VERSION_NOTE]);
});

// ================================================================ 5. stress.css: result colours scoped to the Stress screen
test("stress.css: the [data-result] colours apply inside the Stress screen only", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles/stress.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter((x) => x.includes("[data-result"));
  assert.ok(selectors.length >= 3);
  for (const sel of selectors) assert.match(sel, /^\.lx-st\b/, sel);
});

// ================================================================ 6. the mock's profiles in the helper's schema-2 shape
test("mock profiles.save takes turbo, ring, power and runtime edits like the helper; profiles.get answers every schema-2 section", async () => {
  const b = new Bridge(createMockTransport(FAST), "mock");
  await b.connect();
  const turbo = { P: [57, 57, 55, 55, 55, 55, 55, 55] };
  const saved = await b.call("profiles.save", {
    name: "all-sections",
    intent: { scope: "unit", rows: [{ target: "P0", offset: { kind: "curve", mv: -10 }, ratio: null, v_target_v: null }], turbo, ring: { points: { 2: -5 } } },
    power: { pl1_w: 200, pl2_w: 250 },
    runtime: { caps: { 0: 50 }, uncore: { max_ratio: 38 } },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const r = saved.result;
  assert.deepEqual([r.complete, r.turbo, r.power, r.caps, r.uncore, r.version], [true, true, true, true, true, 2]);
  assert.ok(r.ring_points > 0);
  assert.deepEqual(r.not_captured, []);
  const got = (await b.call("profiles.get", { name: "all-sections" })).result;
  const c = got.contents;
  for (const k of ["rows", "turbo", "complete", "ring", "power", "caps", "uncore", "version"]) assert.ok(k in c, k);
  assert.deepEqual(c.turbo.P, turbo.P);
  assert.equal(c.ring.points["2"], -5);
  assert.match(c.ring.oc_word, /^0x[0-9A-F]{8}$/);
  assert.deepEqual([c.power.pl1_w, c.power.pl2_w], [200, 250]);
  assert.equal(c.caps.P0, 50, "caps are kept by unit");
  assert.equal(c.uncore.max_ratio, 38);
  const p0 = c.rows.find((x) => x.target === "P0");
  assert.equal(p0.layers.curve_mv, -10);
  assert.ok(Object.values(p0.layers.points_mv).every((mv) => mv === 0));
  assert.deepEqual(p0.offset, { kind: "curve", mv: -10 });
  // both layers set: one intent offset cannot carry them (helper _offset_of), the layers do
  const both = await b.call("profiles.save", { name: "both", intent: { scope: "unit", rows: [{ target: "P1", offset: { kind: "points", mv: { 48: -10 } }, ratio: null, v_target_v: null }] } });
  assert.equal(both.ok, true);
  const before = (await b.call("profiles.get", { name: "both" })).result.contents.rows.find((x) => x.target === "P1");
  assert.equal(before.layers.points_mv["48"], -10);
});

test("mock profiles.save refuses what the helper refuses: a rising turbo table, edits with from:read, nothing to save, a min above max, two caps for one cluster", async () => {
  const b = new Bridge(createMockTransport(FAST), "mock");
  await b.connect();
  const rising = await b.call("profiles.save", { name: "x1", intent: { turbo: { P: [55, 57, 57, 57, 57, 57, 57, 57] } } });
  assert.deepEqual([rising.error.code, rising.error.detail.check], ["REFUSED", "TURBO_ORDER"]);
  assert.equal((await b.call("profiles.save", { name: "x2", from: "read", power: { pl1_w: 100 } })).error.code, "BAD_REQUEST");
  const uncore = await b.call("profiles.save", { name: "x3", runtime: { uncore: { min_ratio: 40, max_ratio: 30 } } });
  assert.match(uncore.error.message, /min_ratio 40 is above max_ratio 30/);
  const cluster = await b.call("profiles.save", { name: "x4", runtime: { caps: { 16: 30, 17: 32 } } });
  assert.equal(cluster.error.detail.check, "CAPS_CLUSTER_CONFLICT");
  const onlyPower = await b.call("profiles.save", { name: "x5", power: { pl1_w: 125 } });
  assert.equal(onlyPower.ok, true, "power edits alone save the read with them");
  assert.equal((await b.call("profiles.get", { name: "x5" })).result.contents.power.pl1_w, 125);
  assert.deepEqual((await b.call("profiles.list")).result.profiles.map((p) => p.name).filter((n) => n.startsWith("x")), ["x5"], "a refusal saves nothing");
});
