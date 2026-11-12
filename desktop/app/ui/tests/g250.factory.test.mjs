// G-250: factory V/F voltages from ANY complete measured curve (measured - the offsets it was measured with), no n/a in Tune › Cores; the Ring row's live clock.
// The golden cases are shared with tests/test_vfmodel.py (factory-golden.json: the Python reference and this port must agree). No browser, no helper, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { install, text } from "./fakedom.mjs";

const doc = install();
const { deriveUnit, deriveFromRecord, decodeWord, topCheck, derivable } = await import("../lib/factory.js");
const { createAppStore, applyHelperEvent } = await import("../store.js");
const { createWorkHead } = await import("../components/workhead.js");
const tune = await import("../views/tune.js");
const { modelFromRead } = await import("../lib/units.js");
const { baseTip } = await import("../views/tune/curve-editor.js");
const { ringNow } = await import("../lib/ringclock.js");
const FIX = (await import("../fixtures/fixtures.js")).default;
const READ = FIX["tune-read"].result;
const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./factory-golden.json", import.meta.url)), "utf8")).cases;

const golden = (name) => GOLDEN.find((c) => c.name === name);
const runGolden = (c, fused = c.fused ? { ratio: c.fused[0], v: c.fused[1] } : null) => deriveUnit({ ratios: c.point_ratios, measured: c.measured, words: c.words, fused });
const rounded = (pts) => pts.map((p) => ({ ratio: p.ratio, v: p.v === null ? null : Math.round(p.v * 10000) / 10000, src: p.src, clamped: p.clamped, check_mv: p.checkMv }));

// ---- the derivation (golden, P and E, whole-curve + point offsets) ------------------------------------------------------------------------------------------
test("golden: every case derives the values and tags the Python reference does (P live offsets, P whole-curve + points, E cluster with a clamped point)", () => {
  assert.equal(GOLDEN.length, 3);
  for (const c of GOLDEN) assert.deepEqual(rounded(runGolden(c)), c.expect, c.name);
});

test("a curve measured with known offsets gives back the factory voltages: whole-curve and point offsets both come off (P)", () => {
  const c = golden("p0_whole_curve_and_points");
  const by = Object.fromEntries(runGolden(c).map((p) => [p.ratio, p]));
  for (const r of c.point_ratios) assert.ok(Math.abs(by[r].v - c.factory[r]) < 1e-4, r + "x");
  assert.ok(Math.abs(by[55].offsetMv - (-51 * 1000) / 1024) < 1e-9, "raw -20 whole + raw -31 point");
  assert.ok(Math.abs(by[8].offsetMv - (-20 * 1000) / 1024) < 1e-9, "a point without its own offset still carries the whole-curve layer");
  assert.ok(runGolden(c).filter((p) => p.src === "derived").length === 7);
});

test("E cluster: the OC word (47x) is not a fused point; the clamped 42x point is interpolated, not measured - offset", () => {
  const c = golden("ec_point_offsets_with_clamp");
  const pts = runGolden(c);
  assert.deepEqual(pts.map((p) => p.ratio), [8, 18, 28, 38, 42, 46], "no 47x");
  const p42 = pts.find((p) => p.ratio === 42);
  assert.deepEqual([p42.src, p42.clamped], ["interpolated", true]);
  assert.ok(Math.abs(p42.v - (0.93 + (0.07 * 4) / 8)) < 5e-4, "the line between the trusted 38x and the fused 46x");
  const naive = p42.measuredV - p42.offsetMv / 1000;
  assert.ok(naive > p42.v + 0.02, "measured - offset would have been too high: " + naive);
  assert.equal(pts.find((p) => p.ratio === 38).clamped, false);
});

test("clamp detection: flat (within the step) AND a deeper effective offset than the level-setting point; a flat point with an equal offset is trusted; a lower-offset point is trusted", () => {
  const w = (...offs) => [0, ...offs.map(([r, mv]) => (((Math.round(mv * 1.024) & 0x7ff) << 21) | r) >>> 0)];
  const flat = deriveUnit({ ratios: [8, 20, 30], measured: { 8: 0.7, 20: 0.7, 30: 0.8 }, words: w([8, 0], [20, 0], [30, 0]) });
  assert.deepEqual(flat.map((p) => p.src), ["derived", "derived", "derived"]);
  const deeper = deriveUnit({ ratios: [8, 20, 30], measured: { 8: 0.7, 20: 0.7, 30: 0.8 }, words: w([8, 0], [20, -30], [30, 0]) });
  assert.deepEqual(deeper.map((p) => [p.src, p.clamped]), [["derived", false], ["interpolated", true], ["derived", false]]);
  assert.ok(Math.abs(deeper[1].v - (0.7 + (0.1 * 12) / 22)) < 1e-9, "on the line between 0.700 (8x) and 0.800 (30x)");
  // the level stays with the point that set it: 30x is flat with 20x (which was lifted) and deeper than 8x, the level-setter
  const chain = deriveUnit({ ratios: [8, 20, 30, 40], measured: { 8: 0.7, 20: 0.7, 30: 0.7, 40: 0.9 }, words: w([8, 0], [20, -30], [30, -40], [40, 0]) });
  assert.deepEqual(chain.map((p) => p.clamped), [false, true, true, false]);
});

test("the top point is the CPU's fused 0x09 voltage, tagged fused, with the difference to the derived value reported; without it a clamped top stays unknown", () => {
  const c = golden("p0_live_offsets");
  const top = runGolden(c).at(-1);
  assert.deepEqual([top.src, top.v, top.clamped], ["fused", 1.4258, true]);
  assert.equal(top.checkMv, 15.9);
  const pts = runGolden(c);
  const chk = topCheck(pts, { ratio: 57, v: 1.4258 });
  assert.deepEqual([chk.ratio, chk.mv, chk.clamped], [57, 15.9, true]);
  assert.equal(topCheck(pts, null), null);
  const none = runGolden(c, null).at(-1);
  assert.deepEqual([none.v, none.src], [null, ""], "no flat copy is invented above 56x");
  assert.equal(runGolden(golden("p0_whole_curve_and_points")).at(-1).checkMv, 0, "an unclamped top agrees with the fused word");
});

test("a stock curve has no words and no offsets; words decode like the V/F word (offset [31:21] signed, 1/1024 V)", () => {
  const pts = deriveUnit({ ratios: [8, 20, 57], measured: { 8: 0.7, 20: 0.75, 57: 1.43 }, words: null, fused: { ratio: 57, v: 1.4258 } });
  assert.deepEqual(pts.map((p) => [p.src, p.offsetMv]), [["derived", 0], ["derived", 0], ["fused", 0]]);
  assert.deepEqual(decodeWord("0x0005b439"), { ratio: 57, offsetMv: 0 });
  const d = decodeWord("0xfce00039"); // [31:21] = 0x7e7 -> -25
  assert.equal(d.ratio, 57);
  assert.ok(Math.abs(d.offsetMv - (-25 * 1000) / 1024) < 1e-9);
  assert.equal(decodeWord("nope"), null);
});

// ---- from a stored record + the tune model ------------------------------------------------------------------------------------------------------------
const wordHex = (ratio, mv) => "0x" + ((((Math.round(mv * 1.024) & 0x7ff) << 21) | ratio) >>> 0).toString(16).padStart(8, "0");
const OFFS = { P0: { 53: -49.8, 55: -28.3, 56: -14.6, 57: -70.3 }, P3: { 48: -20 }, EC1: { 30: -10, 40: -60 } };
/** A complete tuned curve of every P / E unit of READ: factory = a ramp ending at the fused top; measured = the hardware model (offsets in OFFS, whole-curve -20 mV on P1, F4 clamp). */
function tunedRecord(model, over = {}) {
  const units = {};
  const words = {};
  for (const id of model.order) {
    const u = model.units[id];
    if (u.kind === "R") continue;
    const q = (mv) => (Math.round(mv * 1.024) * 1000) / 1024; // what the 1/1024 V offset field holds
    const curve = id === "P1" ? q(-20) : 0;
    const rs = u.points.map((p) => p.ratio);
    const top = u.fused.ratio;
    let prev = -Infinity;
    const points = rs.map((r, i) => {
      const base = u.fused.v - (top - r) * 0.012;
      const v = Math.max(prev, base + (curve + q((OFFS[id] || {})[r] || 0)) / 1000);
      prev = v;
      return { ratio: r, mhz: r * 100, vid_v: Math.round(v * 10000) / 10000, vid_min: v, vid_max: v, kept: 5, total: 5, status: "ok", fused_point: i + 1 };
    });
    units[id] = { cpus: [u.cpu], points };
    words[String(u.cpu)] = [wordHex(0, curve), ...rs.map((r) => wordHex(r, (OFFS[id] || {})[r] || 0))];
  }
  return { id: "20261112T152000Z-ab12", name: "Quick · Nov 12 15:20", created: "2026-11-12T15:20:00Z", mode: "quick", complete: true, baseline: false, tuning_state: { kind: "words", words }, units, ...over };
}

test("deriveFromRecord: P0's live offsets (-49.8 / -28.3 / -14.6 / -70.3) give the factory table; 57x = the fused 1.4258 V; ring and unread units are skipped", () => {
  const model = modelFromRead(structuredClone(READ));
  const d = deriveFromRecord(tunedRecord(model), model);
  assert.equal(d.kind, "derived");
  const f = (id, r) => d.fn(id, r);
  const top = model.units.P0.fused.v;
  for (const r of [8, 20, 30, 48, 53, 55, 56]) assert.ok(Math.abs(f("P0", r).v - (top - (57 - r) * 0.012)) < 2e-4, "P0 " + r + "x"); // 1/1024 V offsets, vid_v at 0.1 mV
  assert.deepEqual([f("P0", 57).src, f("P0", 57).v], ["fused", top]);
  assert.equal(f("P0", 57).clamped, true, "the 57x point sat on the clamp");
  assert.ok(f("P0", 53).src === "derived" && f("P0", 53).clamped === false);
  assert.ok(Math.abs(f("P1", 8).v - (model.units.P1.fused.v - 49 * 0.012)) < 2e-4, "whole-curve -20 mV on P1 taken off every point");
  assert.equal(d.fn("ring", 8), null);
  assert.equal(d.fn("P0", 99), null);
  const partial = tunedRecord(model);
  delete partial.tuning_state.words["3"]; // P3's words are missing: its offsets are unknown, nothing is claimed
  const d2 = deriveFromRecord(partial, model);
  assert.equal(d2.fn("P3", 48), null);
  assert.ok(d2.fn("P0", 48));
  assert.equal(deriveFromRecord({ ...tunedRecord(model), tuning_state: { kind: "unknown" } }, model), null, "unknown tuning state: cannot take offsets off");
  const stock = deriveFromRecord({ ...tunedRecord(model), tuning_state: { kind: "stock" } }, model);
  assert.equal(stock.kind, "stock");
  assert.equal(stock.fn("P0", 53).offsetMv, 0);
});

test("derivable / baselineCandidates: a marked baseline wins; none marked = the newest complete curve of this CPU (all its units), any boot; unknown, partial and short curves are out", () => {
  const model = modelFromRead(structuredClone(READ));
  const all = model.order.filter((id) => id !== "ring");
  const row = (id, over = {}) => ({ id, name: id, created: "2026-11-12T10:00:00Z", complete: true, baseline: false, units: all, tuning_state: { kind: "words" }, ...over });
  const list = [
    row("new-partial", { created: "2026-11-12T16:00:00Z", complete: false }),
    row("new-unknown", { created: "2026-11-12T15:50:00Z", tuning_state: { kind: "unknown" } }),
    row("new-short", { created: "2026-11-12T15:40:00Z", units: ["P0"] }),
    row("newest-ok", { created: "2026-11-12T15:20:00Z" }),
    row("older-stock", { created: "2026-11-01T10:00:00Z", tuning_state: { kind: "stock" } }),
  ];
  assert.deepEqual(tune.baselineCandidates(list, model).map((c) => c.id), ["newest-ok", "older-stock"]);
  const marked = [...list.slice(0, 4), row("old-marked", { created: "2026-10-01T10:00:00Z", baseline: true, tuning_state: { kind: "stock" } })];
  assert.deepEqual(tune.baselineCandidates(marked, model).map((c) => c.id), ["old-marked"], "a marked stock baseline keeps priority over a newer curve");
  assert.deepEqual(tune.baselineCandidates([], model), []);
  assert.equal(derivable({ complete: true, tuning_state: { kind: "unknown" } }), false);
});

test("baselineFromCurve: a marked stock curve stays src baseline (as measured); a tuned or unmarked one is derived", () => {
  const model = modelFromRead(structuredClone(READ));
  const stockRec = { ...tunedRecord(model), tuning_state: { kind: "stock" } };
  const asBase = tune.baselineFromCurve(stockRec, { id: stockRec.id, baseline: true }, model);
  assert.deepEqual([asBase.kind, asBase.marked, asBase.fn("P0", 53).src], ["stock", true, "baseline"]);
  const tuned = tunedRecord(model);
  const derived = tune.baselineFromCurve(tuned, { id: tuned.id, baseline: false }, model);
  assert.deepEqual([derived.kind, derived.marked, derived.fn("P0", 53).src], ["derived", false, "derived"]);
  const markedTuned = tune.baselineFromCurve(tuned, { id: tuned.id, baseline: true }, model);
  assert.deepEqual([markedTuned.kind, markedTuned.marked], ["derived", true]);
  assert.equal(tune.baselineFromCurve({ ...tuned, tuning_state: { kind: "unknown" } }, { id: "x", baseline: false }, model), null);
});

// ---- Tune › Cores ---------------------------------------------------------------------------------------------------------------------------------------
function bridgeFor(records) {
  return {
    name: "stub",
    call: async (op, args) => {
      if (op === "curves.list") return { ok: true, result: { curves: records.map((r) => ({ id: r.id, name: r.name, created: r.created, mode: r.mode, complete: r.complete, baseline: r.baseline === true, tuning_state: { kind: r.tuning_state.kind }, units: Object.keys(r.units) })) } };
      if (op === "curves.get") {
        const r = records.find((x) => x.id === args.id);
        return r ? { ok: true, result: r } : { ok: false, error: { code: "BAD_REQUEST", message: "no such curve" } };
      }
      return { ok: false, error: { code: "X", message: "not in this test" } };
    },
    on: () => () => {},
    wait: async () => ({ ok: false, error: { message: "x" } }),
  };
}

function mount(records) {
  doc.body.replaceChildren();
  const store = createAppStore();
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  root.id = "screen";
  doc.body.append(headEl, root);
  const head = createWorkHead(headEl);
  const bridge = bridgeFor(records);
  const view = tune.tuneView();
  view.mount(root, { store, bridge, toast: () => {}, head, goto: () => {} });
  return { store, root, bridge, view };
}

const factoryCells = (root, kind, ratios) => ratios.map((r) => text(root.querySelector(`[data-vf-table='${kind}'] tr[data-ratio='${r}']`).querySelectorAll("td")[2]));

test("Tune › Cores: with NO marked baseline and only a tuned curve stored, Factory V is derived for every point of P0 and an E cluster (no n/a), and the note says from which curve", async () => {
  const model0 = modelFromRead(structuredClone(READ));
  const rec = tunedRecord(model0);
  const t = mount([rec]);
  tune.patchTune(t.store, { model: modelFromRead(structuredClone(READ)), selection: ["P0"], anchor: "P0" });
  const ctl = tune.createController({ store: t.store, bridge: t.bridge, toast: () => {} });
  await ctl.loadBaseline();
  const b = t.store.get().tune.base;
  assert.deepEqual([b.state, b.kind, b.name, b.marked], ["ready", "derived", "Quick · Nov 12 15:20", false]);
  const base = (id) => (r) => ctl.baseFn()(id, r);
  assert.ok([8, 20, 30, 48, 53, 55, 56, 57].every((r) => base("P0")(r) !== null), "every P0 point has a factory voltage");
  const cells = factoryCells(t.root, "P", [8, 20, 30, 48, 53, 55, 56, 57]);
  assert.ok(cells.every((c) => /^\d\.\d{3}$/.test(c)), "no n/a in P0's Factory column: " + cells.join(" "));
  const foot = text(t.root.querySelector("[data-foot='P']"));
  assert.match(foot, /Factory V derived from the curve “Quick · Nov 12 15:20” minus the offsets it was measured with/);
  assert.doesNotMatch(foot, /n\/a/);
  tune.patchTune(t.store, { selection: ["EC1"], anchor: "EC1" });
  const ecells = factoryCells(t.root, "E", [8, 15, 23, 30, 40, 46]);
  assert.ok(ecells.every((c) => /^\d\.\d{3}$/.test(c)), "no n/a in EC1's Factory column: " + ecells.join(" "));
});

test("Tune › Cores: before the change a tuned curve alone gave only the fused top (the others n/a); a MARKED stock curve keeps priority over a newer tuned one", async () => {
  const model = modelFromRead(structuredClone(READ));
  const tuned = tunedRecord(model);
  const stock = { ...tunedRecord(model), id: "20261001T100000Z-st01", name: "Stock", created: "2026-10-01T10:00:00Z", baseline: true, tuning_state: { kind: "stock" } };
  for (const id of Object.keys(stock.units)) stock.units[id].points.forEach((p, i) => { p.vid_v = 0.9 + i * 0.05; });
  const t = mount([tuned, stock]);
  tune.patchTune(t.store, { model, selection: ["P0"], anchor: "P0" });
  const ctl = tune.createController({ store: t.store, bridge: t.bridge, toast: () => {} });
  await ctl.loadBaseline();
  const b = t.store.get().tune.base;
  assert.deepEqual([b.kind, b.name, b.marked], ["stock", "Stock", true]);
  assert.deepEqual(ctl.baseFn()("P0", 8), { v: 0.9, src: "baseline" });
  assert.match(text(t.root.querySelector("[data-foot='P']")), /the others from “Stock”/);
});

test("Tune › Cores: nothing derivable (only an unknown-state curve) keeps the n/a with its reason", async () => {
  const model = modelFromRead(structuredClone(READ));
  const t = mount([{ ...tunedRecord(model), tuning_state: { kind: "unknown" } }]);
  tune.patchTune(t.store, { model, selection: ["P0"], anchor: "P0" });
  const ctl = tune.createController({ store: t.store, bridge: t.bridge, toast: () => {} });
  await ctl.loadBaseline();
  assert.equal(t.store.get().tune.base.state, "none");
  assert.match(t.store.get().tune.base.reason, /no baseline curve/);
});

test("baseTip: says where a factory voltage comes from (fused with the self-check, derived with measured and offset, interpolated by the clamp)", () => {
  assert.match(baseTip({ src: "fused", baseInfo: { checkMv: 15.9, clamped: true } }), /fused top-point voltage \(0x09\).*\+15\.9 mV off \(the top point was lifted by the clamp\)/);
  assert.match(baseTip({ src: "derived", baseInfo: { measuredV: 1.3714, offsetMv: -14.6484375 } }), /measured 1\.371 V minus the offsets it was measured with \(−14\.6 mV\)/);
  assert.match(baseTip({ src: "interpolated", baseInfo: { clamped: true } }), /hardware clamp/);
  assert.equal(baseTip({ src: "baseline", baseInfo: {} }), "");
  assert.equal(baseTip(null), "");
});

// ---- Ring row clock -------------------------------------------------------------------------------------------------------------------------------------
const leaf = (value, unit) => ({ value, unit, source: "intel_uncore_frequency/package_00_die_00/current_freq_khz", status: "ok" });

test("Tune › Cores › Units: the Ring row's Clock GHz is the live ring clock (telemetry values.ring), n/a only until it is reported", () => {
  const model = modelFromRead(structuredClone(READ));
  const t = mount([]);
  tune.patchTune(t.store, { model, selection: ["P0"], anchor: "P0" });
  const clock = () => text(t.root.querySelector("[data-unit-table] tr[data-unit='ring']").querySelector("[data-col='clk']"));
  assert.equal(clock(), "n/a", "no telemetry yet");
  applyHelperEvent(t.store, "telemetry", { t: 1, values: { ring: { mhz: leaf(4100, "MHz"), ratio: leaf(41, "x") } } });
  assert.equal(clock(), "4.10");
  applyHelperEvent(t.store, "telemetry", { t: 2, values: { ring: { mhz: leaf(800, "MHz"), ratio: leaf(8, "x") } } });
  assert.equal(clock(), "0.80", "follows each telemetry tick");
  assert.equal(ringNow({ ring: { mhz: leaf(4100, "MHz"), ratio: leaf(41, "x") } }).text, "41× · 4100 MHz", "the same helper the Ring & uncore tab uses");
});

// ---- Curves library -------------------------------------------------------------------------------------------------------------------------------------
test("Curves: a tuned curve can be the baseline (labelled derived); the notes say so and report the top-point self-check against the fused 0x09 voltage", async () => {
  const { curveNotes, baselineAllowed } = await import("../views/curves.js");
  assert.equal(baselineAllowed({ tuning_state: { kind: "words" }, complete: true }), true);
  assert.equal(baselineAllowed({ tuning_state: { kind: "unknown" }, complete: true }), false);
  const list = [{ id: "T", name: "Quick · Nov 12 15:20", baseline: true, tuning_state: { kind: "words" } }, { id: "C", name: "other", tuning_state: { kind: "stock" } }];
  const tuned = { id: "T", name: list[0].name, tuning_state: { kind: "words" }, units: {} };
  const checks = [{ unit: "P0", mv: 15.9, clamped: true }, { unit: "P1", mv: -0.4, clamped: false }];
  const n = curveNotes({ a: tuned, list, live: false, baseline: "T", drawn: new Set(), ids: [], wordsRead: true, topChecks: checks });
  assert.match(n.base, /^Derived baseline: a tuned curve\. Tune's Factory V is this curve minus the offsets it was measured with/);
  assert.equal(n.check, "Top point check (derived − fused 0x09): P0 +15.9 mV (lifted by the clamp) · P1 −0.4 mV.");
  assert.match(curveNotes({ a: { id: "C", tuning_state: { kind: "stock" } }, list, live: false, baseline: "T", drawn: new Set(), ids: [], wordsRead: true }).base, /^Derived baseline: Quick · Nov 12 15:20\. Tune takes the offsets/);
  assert.equal(curveNotes({ a: tuned, list, live: false, baseline: "T", drawn: new Set(), ids: [], wordsRead: true }).check, "", "no check without a kept read");
  assert.match(curveNotes({ a: tuned, list: [], live: false, baseline: null, drawn: new Set(), ids: [], wordsRead: false }).base, /Tune derives its Factory V from the newest complete curve/);
});
