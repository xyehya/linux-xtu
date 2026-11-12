// node --test desktop/app/ui/tests/   (R-S5: Profiles, System, Audit, Setup in the new design — the pure models and the screens on the small fake DOM with
// the mock bridge. Selectors are data-* / roles / ids, never lx- classes. No browser, no helper, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { install, fire, text } from "./fakedom.mjs";

const doc = install();
const FIX = (await import("../fixtures/fixtures.js")).default;
const { Bridge } = await import("../bridge.js");
const { createMockTransport } = await import("../fixtures/mock-backend.js");
const { createAppStore, setLink, setPreflight, setPref } = await import("../store.js");
const { createWorkHead } = await import("../components/workhead.js");
const { modelFromRead } = await import("../lib/units.js");
const { HINTS } = await import("../lib/hints.js");
const { fmtLocalDateTime } = await import("../lib/format.js");
const P = await import("../views/profiles.js");
const A = await import("../views/audit.js");
const SY = await import("../views/system.js");
const SU = await import("../views/setup.js");

const READ = FIX["tune-read"].result;
const GET_P0 = FIX["profiles-get-sim-p0-undervolt"].result;
const RECS = FIX["audit-tail"].result.records;
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
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

/** A mounted screen on the mock bridge: {root, store, bridge, ctx, calls, view}. */
async function mountView(view, opts = {}) {
  const bridge = new Bridge(createMockTransport({ ...FAST, ...opts }), "mock");
  const calls = [];
  const call = bridge.call.bind(bridge);
  bridge.call = async (op, args = {}) => {
    calls.push({ op, args });
    return call(op, args);
  };
  const store = createAppStore();
  const link = await bridge.connect();
  setLink(store, link);
  const pre = await bridge.call("preflight");
  if (pre.ok) setPreflight(store, pre.result);
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const toasts = [];
  const gone = [];
  const ctx = { store, bridge, toast: (kind, t) => toasts.push({ kind, t }), head: createWorkHead(headEl), goto: (s, tab) => gone.push([s, tab]), drawer: null };
  view.mount(root, ctx);
  return { root, headEl, store, bridge, ctx, calls, toasts, gone, view };
}

// ================================================================ Profiles: pure
const SCHEMA2 = {
  complete: true,
  version: 2,
  rows: [
    { target: "P0", offset: null, v_target_v: null, ratio: null, layers: { curve_mv: -10, points_mv: { 48: -20, 53: -25 } } },
    { target: "EC0", offset: { kind: "curve", mv: -15 }, v_target_v: null, ratio: null, layers: { curve_mv: -15, points_mv: {} } },
  ],
  turbo: { P: [57, 57, 55, 55, 55, 55, 55, 55], E: [48, 48, 48, 48, 48, 48, 48, 48] },
  ring: { oc_word: "0x00000000", points: { 1: 0, 2: -10 } },
  power: { pl1_w: 200, pl2_w: 250, tau_s: 28 },
  caps: { P0: 57, EC0: 46 },
  uncore: { min_ratio: 8, max_ratio: 39 },
  fan_curve: { mode: "quiet" },
};

test("profileSections: known sections named, both offset layers shown, absent ones say so, unknown keys shown plainly last; no value invented", () => {
  const secs = P.profileSections(SCHEMA2);
  assert.deepEqual(secs.map((s) => [s.key, s.state]), [["rows", "set"], ["turbo", "set"], ["ring", "set"], ["power", "set"], ["caps", "set"], ["uncore", "set"], ["fan_curve", "unknown"]]);
  const p0 = secs[0].rows.find((r) => r.unit === "P0");
  assert.equal(p0.curve, "−10 mV");
  assert.equal(p0.points, "48× −20 mV, 53× −25 mV");
  assert.deepEqual(secs[3].rows.map((r) => r.slice(0, 2)), [["Long-term limit PL1", "200 W"], ["Short-term limit PL2", "250 W"], ["Time window tau", "28.0 s"]]);
  assert.deepEqual(secs[6].rows, [["mode", "quiet", true]]);
  const v2 = P.profileSections({ ...SCHEMA2, power: null, caps: undefined });
  assert.deepEqual(v2.filter((x) => x.state === "absent").map((x) => [x.key, x.note]), [["power", "Not captured · left as the CPU has it"], ["caps", "Not captured · left as the CPU has it"]]);
  assert.equal(P.listCells({ contents: { ...SCHEMA2, power: null, caps: null, uncore: null } }).runtime, "not captured");
  const old = P.profileSections(GET_P0.contents); // schema 1: rows + turbo only
  assert.deepEqual(old.filter((s) => s.state === "absent").map((s) => s.key), ["ring", "power", "caps", "uncore"]);
  assert.equal(P.profileSections(null).every((s) => s.state === "absent"), true);
});

test("listCells / compareRefs: the table's short cells; compare offers the accepted state, the CPU now and the saved profiles", () => {
  const c = P.listCells({ contents: SCHEMA2, summary: { units: 2, deepest_offset_mv: -35 } });
  assert.deepEqual(c, { units: "2", deepest: "−35", turbo: "P E", ring: "2", runtime: "power · caps · ring clock" });
  assert.equal(P.listCells(GET_P0).runtime, "not in profile");
  assert.equal(P.listCells(null).units, "—");
  const refs = P.compareRefs([{ name: "a", source: "accepted" }, { name: "a", source: "saved" }, { name: "b", source: "saved" }]);
  assert.deepEqual(refs.map((r) => r.value), ["accepted", "read", "a", "b"]);
  assert.deepEqual(P.compareRefs([]).map((r) => r.value), ["read"]);
});

test("acceptOutcome: accepted, the shell's dialog declined (nothing sent), a stray confirmation request, a refusal", () => {
  assert.equal(P.acceptOutcome({ ok: true, result: { name: "x" } }).kind, "accepted");
  assert.equal(P.acceptOutcome({ ok: true, result: { confirm_required: true, plan_id: "p", nonce: "ABCDEF", expires_s: 600 } }).kind, "confirm");
  for (const code of ["NOT_CONFIRMED", "CONFIRM_UNAVAILABLE", "BUSY"]) assert.equal(P.acceptOutcome({ ok: false, error: { code, message: "m", detail: { writes_sent: 0 } } }).kind, "declined", code);
  assert.equal(P.acceptOutcome({ ok: false, error: { code: "BUSY", message: "helper busy" } }).kind, "refused", "a helper BUSY without writes_sent is a refusal");
  assert.equal(P.acceptOutcome({ ok: false, error: { code: "REFUSED", message: "m", detail: { check: "NOT_APPLIED" } } }).kind, "refused");
  assert.equal(P.notCapturedText({ not_captured: ["ratio caps not captured: x"] }), "Not captured (left as the CPU has it when applied): ratio caps not captured: x.");
  assert.equal(P.notCapturedText({ not_captured: [] }), "");
});

test("evidenceText: the newest clean full-length quick screen that ran on the state now; nothing clean -> empty", () => {
  const runs = { ok: true, result: { state_fingerprint: "aaaa1111aaaa1111", results: [
    { started: "2026-11-01T10:00:00Z", health: "changed", errors: 0, stopped_by: "time", state_fingerprint: "aaaa1111aaaa1111" },
    { started: "2026-10-30T09:00:00Z", health: "clean", errors: 0, stopped_by: "time", elapsed_s: 900, kind: "cpu", state_fingerprint: "aaaa1111aaaa1111" }] } };
  assert.equal(P.evidenceText(runs), `${fmtLocalDateTime("2026-10-30T09:00:00Z")} · 15 min · cpu · clean, 0 errors`); // G-248: local time
  assert.equal(P.evidenceText({ ok: true, result: { results: [{ health: "clean", errors: 0, stopped_by: "cancel" }] } }), "");
  assert.equal(P.evidenceText({ ok: false }), "");
});

test("windowsCommand names tools\\win\\Apply-Profile.ps1 with its real parameter (-From, a folder)", () => {
  const ps1 = readFileSync(fileURLToPath(new URL("../../../../tools/win/Apply-Profile.ps1", import.meta.url)), "utf8");
  assert.match(ps1, /param\(.*\[string\]\$From/);
  assert.equal(P.windowsCommand(), 'tools\\win\\Apply-Profile.ps1 -From "$env:ProgramData\\linux-xtu\\accepted"');
});

test("draftFromContents (R-S5): both layers, the ring points and the runtime sections load; a ring the read lacks is named", () => {
  const m = modelFromRead({ ...structuredClone(READ), intent_features: ["ring"] });
  const r = P.draftFromContents(m, SCHEMA2);
  assert.equal(r.draft.units.P0.curveMv, -10);
  assert.deepEqual(r.draft.units.P0.pts, { 48: -20, 53: -25 });
  assert.equal(r.draft.units.EC0.curveMv, -15);
  assert.deepEqual(r.draft.units.ring.pts, { 2: -10 });
  assert.deepEqual(r.rtEdits, { power: { pl1_w: 200, pl2_w: 250, tau_s: 28 }, caps: { P0: 57, EC0: 46 }, uncore: { min_ratio: 8, max_ratio: 39 } });
  assert.deepEqual(r.loaded.sort(), ["caps", "power", "ring", "rows", "turbo", "uncore"]);
  const noRingRead = structuredClone(READ);
  const noRingModel = modelFromRead(noRingRead);
  noRingModel.features = { ...noRingModel.features, ring: false }; // a helper that reports no "ring" intent feature
  const noRing = P.draftFromContents(noRingModel, SCHEMA2);
  assert.ok(noRing.skipped.includes("ring (not read)"));
  assert.equal(P.hasRtEdits(r.rtEdits), true);
  assert.equal(P.hasRtEdits({ power: {}, caps: {}, uncore: {} }), false);
});

// ================================================================ Audit: pure
test("audit groupAudit: the fixture tail is two operations, newest first, with plain lines; a read-back joins what it reads back", () => {
  const ops = A.groupAudit(RECS);
  assert.deepEqual(ops.map((g) => [g.id, g.label, g.result, g.line]), [["310", "Apply", "ok", "3 requests · 1 write · read back equal"], ["297", "Ring read", "ok", "6 requests"]]);
  assert.equal(ops[0].records.length, 7);
  assert.equal(A.opKey({ purpose: "read-back of: apply: write V/F" }), "apply");
  assert.equal(A.opKey({ event: "result", op: "profiles.save" }), "op:profiles.save");
  assert.equal(A.opLabel("op:profiles.save"), "Profile saved");
  const gap = A.groupAudit([{ ts: "2026-10-18T09:00:00Z", purpose: "x: a", event: "attempt" }, { ts: "2026-10-18T09:00:10Z", purpose: "x: b", event: "attempt" }]);
  assert.equal(gap.length, 2, "a gap over OP_GAP_S starts a new operation");
  const bad = A.groupAudit([{ event: "attempt", purpose: "apply: w", cmd: "0x11" }, { event: "readback", purpose: "read-back of: apply: w", verified: false }]);
  assert.equal(bad[0].result, "mismatch");
  assert.equal(A.groupAudit([{ event: "refused", purpose: "apply: w", reason: "r" }])[0].result, "refused");
  assert.deepEqual(A.groupAudit(null), []);
});

test("audit filterOps / tookText / clockMs", () => {
  const ops = A.groupAudit(RECS);
  assert.deepEqual(A.filterOps(ops, { filter: "changes" }).map((g) => g.label), ["Apply"]);
  assert.deepEqual(A.filterOps(ops, { text: "ring" }).map((g) => g.label), ["Ring read"]);
  assert.equal(A.filterOps(ops, { text: "zzz" }).length, 0);
  assert.equal(A.tookText(0.04), "40 ms");
  assert.equal(A.tookText(1.25), "1.3 s");
  assert.equal(A.tookText(null), "—");
  assert.match(A.clockMs("2026-10-18T09:45:53.792+00:00"), /^\d\d:\d\d:\d\d\.792$/);
});

// ================================================================ System / Setup: pure
test("system: glyphs, counts worst first, the optional boot-restore line, the settings answer", () => {
  assert.deepEqual(["pass", "fail", "unknown"].map((s) => SY.checkGlyph(s).glyph), ["✓", "✕", "?"]);
  assert.equal(SY.countsText({ pass: 13, unknown: 1 }), "1 unknown · 13 pass");
  assert.equal(SY.bootRestoreModel({}), null);
  assert.equal(SY.bootRestoreModel(null), null);
  assert.deepEqual(SY.bootRestoreModel({ boot_restore: "armed" }), { state: "armed", label: "armed", tag: "ok", note: "" });
  assert.deepEqual(SY.bootRestoreModel({ boot_restore: { state: "not_installed" } }), { state: "not_installed", label: "not installed", tag: "", note: "" });
  assert.equal(SY.bootRestoreModel({ boot_restore: { state: "disarmed", note: "n" } }).tag, "warn");
  assert.deepEqual(SY.settingsModel({ ok: true, result: { refresh_s: 2, notifications: false } }), { saved: true, refresh_s: 2, notifications: false, hints: null, why: "" });
  assert.equal(SY.settingsModel({ ok: true, result: { refresh_s: 2, hints: "quiet" } }).hints, "quiet");
  assert.equal(SY.settingsModel({ ok: true, result: { hints: "loud" } }).hints, null, "an unknown Hints mode is not taken");
  assert.equal(SY.settingsModel({ ok: false, error: { code: "UNSUPPORTED", message: "no" } }).refresh_s, 1, "without settings the default interval");
  assert.equal(SY.settingsModel({ ok: false, error: { code: "UNSUPPORTED", message: "no" } }).saved, false);
});

test("setup: one caption per kind", () => {
  assert.equal(SU.kindMeta("missing"), "helper not installed");
  assert.equal(SU.kindMeta("zzz"), "helper not reachable");
});

// ================================================================ the screens on the fake DOM
test("Setup screen: says it once — the command with Copy, Retry 0 req, the helper's own words closed", async () => {
  const store = createAppStore();
  setLink(store, { state: "not_installed", kind: "missing", message: "the helper is not installed. Run: sudo bash install.sh" });
  const root = doc.createElement("main");
  const headEl = doc.createElement("div");
  doc.body.append(headEl, root);
  const v = SU.setupView();
  assert.equal(v.lx, true);
  v.mount(root, { store, bridge: { connect: async () => ({ state: "not_installed", kind: "missing", message: "still" }) }, toast: () => {}, head: createWorkHead(headEl) });
  assert.equal(text($(root, "[data-setup=command]")), "sudo bash install.sh");
  assert.match(text($(root, "[data-setup=retry]")), /^Retry\s*0 req$/);
  assert.ok($(root, "[data-setup=copy]"));
  assert.equal($(root, "[data-setup=said]").hasAttribute("open"), false);
  assert.equal($(root, "[data-setup-kind]").dataset.setupKind, "missing");
  $(root, "[data-setup=retry]").click();
  assert.equal(await until(() => /Still not connected/.test(text($(root, "[data-setup=status]")))), true);
  setLink(store, { state: "busy", kind: "busy", message: "" });
  assert.equal($(root, "[data-setup=command]"), null, "busy has nothing to run");
  assert.match(text(root), /Close the other Linux XTU/);
  v.unmount();
});

test("Audit screen: operations newest first; open one for its raw rows and a raw record; Changes and search filter", async () => {
  const m = await mountView(A.auditView());
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length === 2), true);
  assert.deepEqual($$(m.root, "tr[data-op]").map((tr) => tr.dataset.op), ["310", "297"]);
  $(m.root, "tr[data-op='310']").click();
  assert.equal($$(m.root, "tr[data-raw-row]").length, 7);
  $$(m.root, "button[data-raw]").find((b) => b.dataset.raw === "310:4").click();
  assert.match(text($$(m.root, "tr[data-raw-of]").find((tr) => tr.dataset.rawOf === "310:4")), /"cmd": "0x11"/);
  $(m.headEl, "#audit-filter [data-value=changes]").click();
  assert.deepEqual($$(m.root, "tr[data-op]").map((tr) => tr.dataset.op), ["310"]);
  const search = $(m.headEl, "#audit-search");
  search.value = "zzz";
  fire(search, "input");
  assert.equal($$(m.root, "tr[data-op]").length, 0);
  assert.ok($(m.root, "tr[data-none]"));
  assert.equal(m.calls.filter((c) => c.op === "audit.tail").length, 1);
  m.view.unmount();
});

test("System screen: glyphs worst first, Max ratio (cpufreq), boot restore only when the preflight says, Hints from the settings", async () => {
  const m = await mountView(SY.systemView());
  const rows = $$(m.root, "#sys-checks tr");
  assert.equal(rows[0].dataset.status, "unknown");
  assert.equal(text(rows[0].querySelector("td")), "?");
  assert.match(text($(m.root, "#sys-topology thead")), /Max ratio× cpufreq/);
  const { boot_restore: _br, ...noBoot } = m.store.get().preflight; // the fixture carries boot_restore (G-243); without the field the panel stays hidden
  setPreflight(m.store, noBoot);
  assert.equal($(m.root, "#sys-boot").hidden, true);
  setPreflight(m.store, { ...m.store.get().preflight, boot_restore: { state: "armed" } });
  assert.equal($(m.root, "#sys-boot").hidden, false);
  assert.match(text($(m.root, "#sys-boot-state")), /Boot restore:\s*armed/);
  // the mock has no settings commands: the controls say once that nothing is saved; notifications cannot change
  assert.equal(await until(() => !$(m.root, "#sys-unsaved").hidden), true);
  assert.match(text($(m.root, "#sys-unsaved")), new RegExp(HINTS["system.unsaved.why"].label));
  assert.equal($(m.root, "#sys-notify [data-value=on]").disabled, true);
  $(m.root, "#sys-hints [data-value=quiet]").click();
  assert.equal(m.store.get().prefs.hints, "quiet");
  setPref(m.store, "hints", "on");
  assert.equal($(m.root, "#sys-hints [data-value=on]").getAttribute("aria-pressed"), "true");
  assert.equal(await until(() => /App version\s*0\.2\.0-dev/.test(text($(m.root, "#sys-helper")))), true, "the shell's app_version (the mock answers lib.rs VERSION)");
  m.view.unmount();
});

test("System screen: settings through the bridge — saved interval and notifications go to settings_set", async () => {
  const bridgeExtras = { saved: [] };
  const v = SY.systemView();
  const m = await mountView({ id: "x", mount() {}, unmount() {} });
  m.bridge.settingsGet = async () => ({ ok: true, result: { refresh_s: 1, notifications: true, strip_series: [], window: { density: "comfortable" } } });
  m.bridge.settingsSet = async (patch) => {
    bridgeExtras.saved.push(patch);
    return { ok: true, result: { refresh_s: patch.refresh_s ?? 1, notifications: patch.notifications ?? true } };
  };
  m.bridge.appVersion = async () => ({ ok: true, result: "0.2.0-dev" });
  v.mount(m.root, m.ctx);
  assert.equal(await until(() => $(m.root, "#sys-unsaved").hidden && /0\.2\.0-dev/.test(text($(m.root, "#sys-helper")))), true);
  $(m.root, "#sys-notify [data-value=off]").click();
  assert.equal(await until(() => bridgeExtras.saved.length === 1), true);
  assert.deepEqual(bridgeExtras.saved[0], { notifications: false });
  $(m.root, "#sys-refresh [data-value='2']").click();
  assert.equal(await until(() => bridgeExtras.saved.length === 2), true);
  assert.deepEqual(bridgeExtras.saved[1], { refresh_s: 2 });
  assert.ok(m.calls.some((c) => c.op === "telemetry.start" && c.args.interval_s === 2));
  v.unmount();
});

test("Profiles screen: the library, contents by section with 'not in this profile', compare by the helper, header saves", async () => {
  const m = await mountView(P.profilesView());
  assert.equal(await until(() => $$(m.root, "[data-pr=list] tr[data-profile]").length === 2 && !/Reading/.test(text($(m.root, "#pr-contents")))), true);
  const sel = $(m.root, "[data-pr=list] tr[aria-selected=true]");
  assert.ok(sel, "a profile is selected");
  const secs = $$(m.root, "#pr-contents [data-section]");
  assert.deepEqual(secs.map((s) => [s.dataset.section, s.dataset.sectionState]), [["rows", "set"], ["turbo", "set"], ["ring", "absent"], ["power", "absent"], ["caps", "absent"], ["uncore", "absent"]]);
  assert.match(text(secs[2]), /Not in this profile/); // the recorded fixture predates schema 2
  assert.ok(m.calls.some((c) => c.op === "profiles.diff"), "compare asks the helper");
  assert.match(text($(m.headEl, "[data-pr=save-state]")), /Save CPU state as/);
  // the empty accepted state teaches, Restore accepted is not offered
  assert.ok($(m.root, "#pr-noaccepted"));
  assert.equal($(m.root, "[data-pr=restore]").hidden, true);
  // the save row: one at a time, the gate speaks, Escape closes
  $(m.headEl, "[data-pr=save-edits]").click();
  assert.equal($(m.root, "[data-pr=save-panel]").hidden, false);
  const name = $(m.root, "[data-pr=name]");
  name.value = "Bad Name";
  fire(name, "input");
  assert.match(text($(m.root, "[data-pr=name-note]")), /^Not allowed/);
  assert.equal($(m.root, "[data-pr=save]").disabled, true);
  m.view.unmount();
});

test("Profiles screen: the commit sheet's profiles:accept opens the inline confirm; Accept goes through the shell's dialog and refreshes", async () => {
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  m.store.events.dispatchEvent(new CustomEvent("profiles:accept", { detail: { from: "read" } }));
  assert.equal(await until(() => !!$(m.root, "[data-pr=ask-yes]")), true);
  assert.ok(m.calls.some((c) => c.op === "profiles.diff" && c.args.a === "accepted" && c.args.b === "read"));
  assert.ok(m.calls.some((c) => c.op === "stress.list"), "evidence is looked up");
  assert.ok($(m.root, "[data-pr=evidence]"));
  assert.equal(m.calls.filter((c) => c.op === "profiles.accept").length, 0, "nothing is accepted before the answer");
  $(m.root, "[data-pr=ask-yes]").click();
  assert.equal(await until(() => /Accepted/.test(text($(m.root, "[data-pr=notice]")))), true);
  assert.deepEqual(m.calls.find((c) => c.op === "profiles.accept").args, { from: "read" });
  assert.equal(await until(() => m.calls.filter((c) => c.op === "profiles.list").length >= 2), true, "the library reloads after an accept");
  assert.ok($(m.root, "[data-pr=undo]"), "Undo accepts the kept previous state again");
  assert.equal($(m.root, "[data-pr=restore]").hidden, false);
  assert.match(text($(m.root, "[data-pr=command]")), /Apply-Profile\.ps1 -From/);
  m.view.unmount();
});

test("Profiles screen: a Cancel in the shell's dialog accepts nothing and says so plainly", async () => {
  const m = await mountView(P.profilesView(), { profiles: "accepted", confirm: "no" });
  assert.equal(await until(() => !$(m.root, "[data-pr=accept-read]").disabled && $$(m.root, "tr[data-profile]").length > 0), true);
  $(m.root, "[data-pr=accept-read]").click();
  assert.equal(await until(() => !!$(m.root, "[data-pr=ask-yes]")), true);
  $(m.root, "[data-pr=ask-yes]").click();
  assert.equal(await until(() => /Not accepted/.test(text($(m.root, "[data-pr=notice]")))), true);
  assert.match(text($(m.root, "[data-pr=notice]")), /Not confirmed in the system dialog/);
  m.view.unmount();
});
