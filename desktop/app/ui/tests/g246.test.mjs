// node --test "desktop/app/ui/tests/*.test.mjs"   (G-246: copy and small view fixes of the 2026-11-12 QA — UVP wording, typed offsets shown as the 1/1024 V step, Curve top vs Max,
// Binds for 1 busy / all busy, local time, the app-wide history buffer, curves status / estimate / label gap, Tips ways back, the Overview limit popover. No hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { install, key, text } from "./fakedom.mjs";

const doc = install();
const { Bridge } = await import("../bridge.js");
const { createAppStore, setLink, setPreflight, applyHelperEvent, setUvp, setLastApply, HISTORY_S } = await import("../store.js");
const { createMockTransport, FIXTURES } = await import("../fixtures/mock-backend.js");
const { wrapMockTransport } = await import("../fixtures/mock-backend-g218.js");
const { dashboardView } = await import("../views/dashboard.js");
const { createWorkHead } = await import("../components/workhead.js");
const tune = await import("../views/tune.js");
const { modelFromRead, snapOffsetMv } = await import("../lib/units.js");
const { buildIntent } = await import("../lib/intent.js");
const { fmtLocalDateTime, fmtLocalStamp } = await import("../lib/format.js");
const { curveName, curveTitle, libraryRow, estimateCost, measureText, measuringText, chartSpec } = await import("../views/curves.js");
const { bindsText, runsUpTo } = await import("../views/tune/frequency.js");
const { TIPS } = await import("../lib/tips.js");
const { HINTS } = await import("../lib/hints.js");
const { popoverModel } = await import("../components/throttle.js");
const { deriveThrottle } = await import("../store.js");
const FIX = (await import("../fixtures/fixtures.js")).default;

const pre = FIXTURES.preflight.result;
const READ = FIX["tune-read"].result;

async function rig() {
  const bridge = new Bridge(wrapMockTransport(createMockTransport({ intervalMs: 10_000 }), { stepMs: 1, seed: "recorded" }), "mock");
  const store = createAppStore();
  setLink(store, await bridge.connect());
  setPreflight(store, pre);
  const gotos = [];
  const ctx = { store, bridge, head: { set: () => {} }, goto: (s, t) => gotos.push([s, t]), toast: () => {} };
  const root = doc.createElement("main");
  doc.body.append(root);
  return { bridge, store, ctx, root, gotos };
}
function liveFrame(t, extra = {}) {
  const cores = {};
  for (const u of pre.topology.units) for (const cpu of u.cpus) {
    const leaf = (value) => ({ value, status: "ok", source: "test", unit: "" });
    cores[String(cpu)] = { mhz: leaf(5000 + cpu), busy: leaf(50), vid: leaf(1.1), ratio: leaf(50) };
  }
  return { t, values: { cores, power: { package: { value: 120.5, status: "ok", unit: "W", source: "rapl" } }, vcore: { value: 1.2, status: "ok", unit: "V", source: "hwmon" }, ...extra } };
}
const word = (raw, status = [], log = []) => ({ value: { raw, status, log, unknown_bits: [] }, status: "ok", unit: "", source: "msr 0x64F" });

// ---------------------------------------------------------------- QA-02
test("QA-02: the Overview UVP line says the first apply tells, not a Read", async () => {
  const { store, ctx, root } = await rig();
  const v = dashboardView();
  v.mount(root, ctx);
  assert.match(text(root.querySelector("#ov-uvp")), /the first apply tells/);
  assert.doesNotMatch(text(root.querySelector("#ov-uvp")), /Read or an apply/);
  setUvp(store, "off");
  assert.equal(text(root.querySelector("#ov-uvp")), "off");
  v.unmount();
  root.remove();
});

// ---------------------------------------------------------------- QA-04
test("QA-04: a typed -70 is the 1/1024 V step -72 raw = -70.3125 mV (the helper's rounding), shown in the editor; the intent still carries the whole mV", () => {
  assert.equal(snapOffsetMv(-70), -72 / 1.024);
  assert.equal(snapOffsetMv(0), 0);
  assert.equal(snapOffsetMv(-1000), -1000);
  assert.equal(snapOffsetMv(-30), -31 / 1.024, "the plan of the golden R09 case shows -30.273");
  assert.equal(snapOffsetMv(snapOffsetMv(-70)), snapOffsetMv(-70), "idempotent: a value read back snaps to itself");
});

test("QA-04: Tune › Cores shows -70.3 in the field after typing -70, with the nearest-step note; the draft and the intent keep the whole mV", () => {
  doc.body.replaceChildren();
  const store = createAppStore();
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const BRIDGE = { name: "stub", call: async () => ({ ok: false, error: { code: "X", message: "x" } }), on: () => () => {}, wait: async () => ({ ok: false, error: { message: "x" } }) };
  const view = tune.tuneView();
  view.mount(root, { store, bridge: BRIDGE, toast: () => {}, head: createWorkHead(headEl), goto: () => {} });
  const model = modelFromRead(structuredClone(READ));
  tune.patchTune(store, { model, selection: ["P0"], anchor: "P0" });
  const input = root.querySelector("[data-vf-table='P'] tr[data-ratio='53'] input");
  input.focus();
  input.value = "-70";
  key(input, "Enter");
  const d = store.get().tune.draft;
  assert.deepEqual(d.units.P0.pts, { 53: -70 }, "what the intent sends stays whole mV");
  assert.equal(buildIntent(model, d).intent.rows[0].offset.mv["53"], -70);
  assert.equal(input.value, "−70.3");
  const tr = root.querySelector("[data-vf-table='P'] tr[data-ratio='53']");
  assert.equal(text(tr.querySelectorAll("td")[6]).startsWith("−70.3"), true, "the Δ column follows the held value");
  assert.match(text(root), /holds offsets in 1\/1024 V steps: −70 mV is held as −70\.3 mV/);
  view.unmount();
});

// ---------------------------------------------------------------- QA-08 / QA-09
test("QA-08: the factory top is 'Curve top' on Cores and Overview; the hint says Max (Tune › Frequency) is what the core may run", async () => {
  assert.equal(HINTS["unit.top"].label, "Curve top");
  assert.match(HINTS["unit.top"].line, /not what the core may run/);
  const { ctx, root } = await rig();
  const v = dashboardView();
  v.mount(root, ctx);
  assert.ok(root.querySelectorAll("#ov-units th").some((th) => /Curve top/.test(text(th))), "Overview column header");
  assert.ok(!root.querySelectorAll("#ov-units th").some((th) => /^Top\b/.test(text(th))));
  v.unmount();
  root.remove();
});

test("QA-09: Binds names the limit for 1 busy and for all busy when they differ", () => {
  const L = { ...runsUpTo({ ceiling: 55, t1: 57, tall: 54, cap: null }) };
  assert.deepEqual([L.binds, L.bindsAll], ["max ratio", "turbo table"], "P1 with the all-busy turbo bucket lowered to 54");
  assert.equal(bindsText(L), "max ratio · all busy: turbo table");
  assert.equal(bindsText({ binds: "turbo table", bindsAll: "turbo table" }), "turbo table");
  assert.equal(bindsText({ binds: null, bindsAll: null }), "—");
});

// ---------------------------------------------------------------- QA-34
test("QA-34: a UTC ISO stamp renders as local time (24 h, no locale), epoch seconds too; names and labels use it", () => {
  const was = process.env.TZ;
  process.env.TZ = "Etc/GMT-2"; // UTC+2
  try {
    assert.equal(fmtLocalDateTime("2026-11-12T08:53:00Z"), "Nov 12 10:53");
    assert.equal(fmtLocalStamp("2026-11-12T08:53:00Z"), "2026-11-12 10:53");
    assert.equal(fmtLocalDateTime(Date.UTC(2026, 10, 12, 22, 5) / 1000), "Nov 13 00:05", "crosses midnight in local time");
    assert.equal(fmtLocalDateTime("nonsense"), "");
    assert.equal(fmtLocalDateTime(null), "");
    // a default-named curve (an older helper stamped the name in UTC) is shown in local time, once, without a second "quick"
    const c = { id: "20261112T085300Z-ab12", name: "Quick 2026-11-12 08:53", created: "2026-11-12T08:53:00Z", mode: "quick", units: ["P0"] };
    assert.equal(curveName(c), "Quick 2026-11-12 10:53");
    assert.equal(curveTitle(c), "Quick · Nov 12 10:53");
    assert.equal(libraryRow(c).name, "Quick 2026-11-12 10:53");
    assert.equal(libraryRow(c).created, "Nov 12 10:53");
    // a name the operator chose stays theirs
    const mine = { ...c, name: "stock" };
    assert.equal(curveName(mine), "stock");
    assert.equal(curveTitle(mine), "stock · Nov 12 10:53 · quick");
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

// ---------------------------------------------------------------- QA-36
test("QA-36: the history buffer lives in the store and fills while another screen is shown", async () => {
  const { store, ctx, root } = await rig();
  store.set({ screen: "tune" }); // the Overview is not mounted
  for (let i = 0; i < 20; i++) applyHelperEvent(store, "telemetry", liveFrame(1000 + i));
  assert.equal(store.get().telemetry.chart.length, 20);
  assert.equal(store.get().telemetry.chart[19].v.pkg_power, 120.5);
  applyHelperEvent(store, "telemetry", liveFrame(1019)); // same sample time: one entry per time
  assert.equal(store.get().telemetry.chart.length, 20);
  applyHelperEvent(store, "telemetry", liveFrame(1019 + HISTORY_S + 5));
  assert.ok(store.get().telemetry.chart.every((p) => p.t >= 1019 + 5), "capped to the history window");
  const v = dashboardView();
  v.mount(root, ctx);
  applyHelperEvent(store, "telemetry", liveFrame(1019 + HISTORY_S + 6));
  assert.match(text(root.querySelector("#ov-history")), /2 samples kept/, "the view reads the app-wide buffer");
  v.unmount();
  const n = store.get().telemetry.chart.length;
  applyHelperEvent(store, "telemetry", liveFrame(1019 + HISTORY_S + 7));
  assert.equal(store.get().telemetry.chart.length, n + 1, "still filling with the view unmounted");
  root.remove();
});

test("QA-36: arriving on the Overview shows the samples kept while it was away", async () => {
  const { store, ctx, root } = await rig();
  for (let i = 0; i < 30; i++) applyHelperEvent(store, "telemetry", liveFrame(2000 + i));
  const v = dashboardView();
  v.mount(root, ctx);
  applyHelperEvent(store, "telemetry", liveFrame(2030));
  assert.match(text(root.querySelector("#ov-history")), /31 samples kept/);
  v.unmount();
  root.remove();
});

// ---------------------------------------------------------------- QA-37
test("QA-37: no estimate for zero units, the status never names an operation id, and the live label sits clear of its marker", () => {
  assert.equal(estimateCost("quick", 0), "");
  assert.equal(estimateCost("quick", 12), "~2 min");
  assert.equal(estimateCost("quick", 1), "~10 s");
  assert.equal(measureText({ mode: "quick", sel: new Set() }, ["P0", "P1"], { running: false, gate: null }), "Select at least one unit.");
  assert.equal(measuringText({ step: 1, of: 8, unit: "P0", ratio: 8 }), "Measuring P0 · point 1 of 8");
  assert.equal(measuringText({ step: 0, of: 8, unit: "P0" }), "Measuring P0 · point 1 of 8", "never 'point 0'");
  assert.equal(measuringText({ step: 3, of: 8 }), "Measuring point 3 of 8");
  assert.equal(measuringText({ elapsed_s: 3 }), null);
  const model = (live) => ({ ymode: "v", series: [{ key: "P0", unit: "P0", label: "P0 ★", live, pts: [{ mhz: 800, v: 0.7 }] }] });
  const done = chartSpec(model(false)).labels[0].text;
  const live = chartSpec(model(true)).labels[0].text;
  assert.equal(done, " P0 ★");
  assert.ok(live.startsWith("    ") && live.endsWith("P0 ★"), "non-breaking gap: the marker is not under the text");
});

// ---------------------------------------------------------------- QA-39
test("QA-39: Tips 'Ways back' lists Restore boot values and says reboot vs cold boot", () => {
  const s = JSON.stringify(TIPS.sections);
  const steps = TIPS.sections.flatMap((x) => x.blocks || []).filter((b) => Array.isArray(b.steps)).flatMap((b) => b.steps);
  const back = steps.filter((t) => /Restore accepted|Restore boot values|cold boot/.test(t));
  assert.ok(back.some((t) => /^\*\*Restore boot values\*\* \(Tune › Power, Frequency, Ring & uncore\): puts back what this boot started with/.test(t)));
  assert.ok(back.some((t) => /A reboot\*\* clears power limits, ratio caps and the ring range; \*\*a cold boot\*\* also clears V\/F offsets/.test(t)));
  assert.ok(s.includes("Restore boot values"));
});

// ---------------------------------------------------------------- QA-40
test("QA-40: an Overview limit row opens the same Limit reasons popover; the footer is plain words with the bits in tooltips", async () => {
  const { store, ctx, root } = await rig();
  const log = ["thermal", "vr_therm_alert", "vr_tdc", "other", "pl2"];
  applyHelperEvent(store, "telemetry", liveFrame(5000, { limit_reasons: word(0x1000, ["max_turbo_limit"], log) }));
  const v = dashboardView();
  v.mount(root, ctx);
  const row = root.querySelector("#ov-limits tr[data-limit=turbo]");
  assert.ok(row);
  const pop = doc.getElementById("ov-lim-pop");
  assert.equal(pop.hidden, true);
  row.click(); // a click anywhere in the row opens it (its legend button does too, below)
  assert.equal(pop.hidden, false, "the row opens the popover");
  assert.equal(pop.getAttribute("aria-label"), "Limit reasons");
  const lines = pop.querySelectorAll(".lx-pop-line");
  const since = lines.find((l) => /^Since boot/.test(text(l)));
  assert.ok(since, "a since-boot line");
  assert.equal(text(since), "Since boot the CPU has also been limited by: temperature, VR temperature, VR current, PL4, PL2");
  assert.match(since.getAttribute("title"), /0x64F Core limit reasons \(log\): Thermal, VR thermal alert/);
  for (const l of lines) assert.doesNotMatch(text(l), /\bbit \d+\b|0x64F/, "no register words in the visible text: " + text(l));
  const now = lines.find((l) => /Max turbo/.test(text(l)));
  assert.ok(now && /^bit 12 · /.test(now.getAttribute("title")), "the bit number is the tooltip of the line");
  assert.match(pop.querySelector("#ov-lim-pop-note").getAttribute("title"), /0x64F = 0x1000/);
  row.click();
  assert.equal(pop.hidden, true, "a second click closes it");
  const ann = root.querySelector("#ov-ann-pl1");
  ann.click();
  assert.equal(pop.hidden, false, "the legend button opens it too");
  v.unmount();
  root.remove();
});

test("QA-40: popoverModel carries plain since-boot and now lines next to the raw ones", () => {
  const m = deriveThrottle({ limit_reasons: word(0x400, ["pl1"], ["thermal", "pl1"]) });
  const pm = popoverModel(m, { seconds: {} });
  assert.deepEqual(pm.sinceBoot.map((x) => x.text), ["Since boot the CPU has also been limited by: temperature, PL1"]);
  assert.equal(pm.activeWords[0].text, "Package power limit PL1 · Power limit");
  assert.match(pm.activeWords[0].title, /^bit 10 · /);
  assert.deepEqual(popoverModel(null, null).sinceBoot, []);
});

// ---------------------------------------------------------------- store: last apply / restore result time (for Stress, G-244)
test("store: lastApplyAt sits next to lastReadAt; setLastApply takes an ISO string, epoch seconds or now", () => {
  const store = createAppStore();
  assert.equal(store.get().lastApplyAt, null);
  setLastApply(store, "2026-11-12T08:53:00Z");
  assert.equal(store.get().lastApplyAt, "2026-11-12T08:53:00Z");
  setLastApply(store, 1762937580);
  assert.equal(store.get().lastApplyAt, new Date(1762937580 * 1000).toISOString());
  setLastApply(store);
  assert.ok(Date.now() - Date.parse(store.get().lastApplyAt) < 5000);
  assert.equal(store.get().lastReadAt, null, "a read time is not touched");
});
