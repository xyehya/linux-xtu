// node --test "desktop/app/ui/tests/*.test.mjs"   (G-208, rebuilt for R-S1: the pure parts of Tune › Cores — unit rows, V/F rows on the R-B4 voltage model,
// refusals planned by lib/draft.js, the plot model, the OC helpers, the inspector heading, the Tune slice; recorded simulator fixture, no hardware, no DOM)
import test from "node:test";
import assert from "node:assert/strict";
import FIX from "../fixtures/fixtures.js";
import { modelFromRead, sections, quickSelections, favoredIds } from "../lib/units.js";
import { emptyDraft, setPoint, setVt, setOcRatio, clearOcEdits, setCurve, diff, setBucket, editCurve, editPoint } from "../lib/draft.js";
import { MINUS } from "../lib/format.js";
import { buildIntent } from "../lib/intent.js";
import { WHY } from "../lib/hints.js";
import { MISSING_HINT_KEYS } from "../lib/limits.js";
import { unitFace, tileFace, liveFace } from "../views/tune/grid.js";
import { curveRows, sectionCurve, sectionLock, offsetRange, rowDelta, plotModel, readoutParts, plannedMv, planCurve, planPoint, largeStep, whyVars, mvText, NO_BASELINE } from "../views/tune/curve-editor.js";
import { ocInfo, offsetUnits, ocPointNo, ocAboveTable, ocShown, ocFlags } from "../views/tune/oc.js";
import { selectionTitle, selectionFacts, factsText } from "../views/tune/inspector.js";
import { baselineFromRecord, initialTune, syncPending, patchTune, discardDraft, requestReview, ensureTune, fmtSeconds, SUBTABS, tabId, PERSIST } from "../views/tune.js";
import { createAppStore } from "../store.js";

import { snapOffsetMv as S } from "../lib/units.js";
const READ = FIX["tune-read"].result;
const model = (patch = {}) => modelFromRead({ ...structuredClone(READ), ...patch });
const m = model();
const secOf = (ids) => sections(m, ids)[0];
const BASE = baselineFromRecord({ units: { P0: { points: [8, 20, 30, 48, 53, 55, 56, 57].map((r, i) => ({ ratio: r, status: "ok", vid_v: 0.9 + i * 0.05 })) } } });

// ---- the unit table's rows ----
test("units: top, OC (an OC point, or a ratio the BIOS set above the factory top), the deepest EFFECTIVE offset, edits", () => {
  const p0 = unitFace(m, emptyDraft(), "P0");
  assert.deepEqual([p0.top, p0.oc.ratio, p0.deepest, p0.edited], [57, null, 0, false]);
  const ec0 = unitFace(m, emptyDraft(), "EC0");
  assert.deepEqual([ec0.top, ec0.oc.ratio, ec0.oc.boot, ec0.oc.edited], [46, 48, true, false], "EC0 runs 48x set at boot over a 46x factory top: shown, not an edit");
  const ring = unitFace(m, emptyDraft(), "ring");
  assert.deepEqual([ring.kind, ring.top, ring.oc.ratio], ["R", 39, null], "the ring's top is its highest point below the OC slot; its OC word is never written (D-045)");
  // whole curve + point add: −10 on the curve and −20 on 48x make −30 there (R-B4)
  let d = editCurve(m, emptyDraft(), ["P0"], -10).draft;
  assert.equal(unitFace(m, d, "P0").deepest, S(-10), "QA-04: as the CPU will hold it");
  d = { ...d, units: { ...d.units, P0: { ...d.units.P0, pts: { 48: -20 } } } };
  assert.equal(unitFace(m, d, "P0").deepest, S(-10) + S(-20));
  assert.equal(unitFace(m, d, "P0", diff(m, d).perUnit).edited, true);
  const oc = unitFace(m, setOcRatio(m, emptyDraft(), ["P1"], 58), "P1");
  assert.deepEqual([oc.oc.ratio, oc.oc.edited], [58, true]);
  assert.equal(tileFace(m, d, "P0").deepest, S(-10) + S(-20), "the pre-R-S1 name stays for apply.test.mjs");
});

test("units: the live clock is the fastest CPU of the unit, n/a when not reported", () => {
  const values = { cores: { 8: { mhz: { value: 4600 } }, 9: { mhz: { value: 4700 } }, 10: { mhz: { status: "unavailable", value: null } } } };
  assert.equal(liveFace(m.units.EC0, values).mhz, 4700);
  assert.equal(liveFace(m.units.P0, values).mhz, null);
  assert.equal(liveFace(m.units.P0, null).mhz, null);
});

// ---- the V/F rows ----
test("rows: one per point, the point layer in the field, the effective offset in `total`, nothing pending on an empty draft", () => {
  const rows = curveRows(m, emptyDraft(), secOf(["P0"]), null);
  assert.deepEqual(rows.map((r) => [r.ratio, r.point]), [[8, 1], [20, 2], [30, 3], [48, 4], [53, 5], [55, 6], [56, 7], [57, 8]]);
  assert.ok(rows.every((r) => r.agg.value === 0 && r.total.value === 0 && !r.pending));
  assert.equal(rows[7].pred.value, 1.4258, "the factory top point has a voltage even without a baseline");
  assert.equal(rows[3].pred.state, "none");
  assert.equal(rows[3].why, NO_BASELINE);
});

test("rows: the whole-curve offset is its own layer and ADDS to the point offsets (R-B4, not a replacement)", () => {
  let d = editCurve(m, emptyDraft(), ["P0"], -10).draft;
  const c = sectionCurve(m, d, secOf(["P0"]), true);
  assert.deepEqual(c, { state: "same", value: S(-10) });
  assert.deepEqual(sectionCurve(m, d, secOf(["P0"]), false), { state: "same", value: 0 });
  let rows = curveRows(m, d, secOf(["P0"]), BASE);
  const r48 = rows.find((r) => r.ratio === 48);
  assert.deepEqual([r48.agg.value, r48.total.value, r48.pending], [0, S(-10), true], "the point's own field stays 0; its effective offset is −10");
  assert.ok(Math.abs(r48.pred.value - (1.05 + S(-10) / 1000)) < 1e-9);
  assert.equal(rowDelta(r48), -9.8, "the same Δ Review shows for the typed -10");
  // a point edit on top of a read whole curve: −10 (read) + −20 = −30
  const r = structuredClone(READ);
  r.tune.P0.cpus[0].points[0].offset_mv = -10;
  const mr = modelFromRead(r);
  d = editPoint(mr, emptyDraft(), ["P0"], 48, -20).draft;
  rows = curveRows(mr, d, sections(mr, ["P0"])[0], BASE);
  const p = rows.find((x) => x.ratio === 48);
  assert.deepEqual([p.agg.value, p.readAgg.value, p.total.value, p.readTotal.value], [S(-20), 0, S(-20) - 10, -10]);
  assert.equal(rowDelta(p), -19.5);
});

test("rows: the clamp is reported, a baseline fills every row, multi-select is mixed", () => {
  let d = setPoint(m, emptyDraft(), ["P0"], 48, -20);
  d = setPoint(m, d, ["P0"], 53, -200);
  const rows = curveRows(m, d, secOf(["P0"]), BASE);
  const r53 = rows.find((r) => r.ratio === 53);
  assert.deepEqual(r53.clampedBy, { ratio: 48, point: 4 }, "53x cannot go below 48x's voltage");
  const e = curveRows(m, setPoint(m, emptyDraft(), ["EC0"], 15, -35), secOf(["EC0", "EC1", "EC2", "EC3"]), null);
  assert.deepEqual(e.find((r) => r.ratio === 15).agg, { state: "mixed", min: S(-35), max: 0, count: 4 });
  assert.equal(sectionCurve(m, setCurve(m, emptyDraft(), ["EC0", "EC1"], -10), secOf(["EC0", "EC1", "EC2"]), true).state, "mixed");
});

test("rows: ring rows by point number, the OC slot marked, no voltage claimed", () => {
  const rows = curveRows(m, emptyDraft(), sections(m, ["ring"])[0], null);
  assert.deepEqual(rows.map((r) => r.key), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(rows[8].ocSlot, true);
  assert.ok(rows.every((r) => r.pred.state === "none" && r.baseV.state === "none"));
  assert.equal(sectionCurve(m, emptyDraft(), sections(m, ["ring"])[0]).state, "none", "the ring has no whole-curve layer (D-045)");
});

// ---- refusals, planned by the voltage model, shown in the field ----
test("plan: positive, below the floor, UVP, curve + points on one unit are refused with a WHY key; nothing is clamped", () => {
  const pos = planPoint(m, emptyDraft(), ["P0"], 48, 5);
  assert.deepEqual([pos.ok, pos.reason], [false, "refused.positive_offset"]);
  const low = planPoint(m, emptyDraft(), ["P0"], 48, -1200);
  assert.deepEqual([low.ok, low.reason, whyVars(low.values)], [false, "refused.below_floor", { value: `${MINUS}1200`, min: `${MINUS}1000`, unit: "mV" }]);
  const uvp = planPoint(model({ uvp: "on" }), emptyDraft(), ["P0"], 48, -10);
  assert.equal(uvp.reason, "locked.uvp");
  const withCurve = editCurve(m, emptyDraft(), ["P0"], -10).draft;
  assert.equal(planPoint(m, withCurve, ["P0"], 48, -20).reason, "refused.curve_and_points", "one offset kind per unit in one apply (lib/intent.js)");
  const withPoint = editPoint(m, emptyDraft(), ["P0"], 48, -20).draft;
  assert.equal(planCurve(m, withPoint, ["P0"], -10).reason, "refused.curve_and_points");
  assert.equal(planCurve(m, withPoint, ["P1"], -10).ok, true, "another unit is free");
  for (const k of ["refused.curve_and_points", "refused.oc_mode_not_offered", "refused.target_needs_oc_point", "refused.no_such_point", "locked.ring_unsupported", "warn.interp_not_measured"]) assert.ok(WHY[k], k);
  assert.deepEqual(MISSING_HINT_KEYS, []);
});

test("plan: the committed whole mV — no edit for the value already held (a 1/1024 V read), whole mV away from it otherwise; a large step warns", () => {
  assert.equal(plannedMv(-19.5, -19.53), null);
  assert.equal(plannedMv(-20, -19.53), null);
  assert.equal(plannedMv(-20.5, -19.53), -21);
  assert.equal(plannedMv(-18.5, -19.53), -18);
  assert.equal(plannedMv(-25, 0), -25);
  assert.equal(mvText(-19.53), `${MINUS}19.5`);
  assert.equal(mvText(0), "0");
  assert.deepEqual(largeStep(-60, 0), { key: "warn.large_step", vars: { value: `${MINUS}60` } });
  assert.equal(largeStep(-20, 0), null);
});

test("locks: said once per section — no limits read, UVP on, a helper without ring edits; the offered range ends at 0", () => {
  assert.equal(sectionLock(m, "P"), null);
  assert.equal(sectionLock(m, "R"), null);
  assert.equal(sectionLock(model({ intent_features: undefined }), "R").key, "locked.ring_unsupported");
  assert.equal(sectionLock(model({ cpu_limits: null }), "P").key, "locked.no_read");
  assert.equal(sectionLock(m, "P", "on").key, "locked.uvp");
  assert.equal(offsetRange(m, "P"), `${MINUS}1000…0`);
  assert.equal(offsetRange(model({ cpu_limits: null }), "P"), "");
});

// ---- the plot ----
test("plot: volts with a baseline (x = ratio to scale), the after trace only with edits, edited markers filled; mV without one", () => {
  let p = plotModel(curveRows(m, emptyDraft(), secOf(["P0"]), BASE));
  assert.equal(p.mode, "volt");
  assert.deepEqual(p.x, { min: 0, max: 60, ticks: [10, 20, 30, 40, 50, 60] });
  assert.deepEqual(p.traces.map((t) => t.kind), ["base", "meas"]);
  assert.deepEqual(p.cursorXs, [8, 20, 30, 48, 53, 55, 56, 57]);
  const d = setPoint(m, emptyDraft(), ["P0"], 48, -20);
  p = plotModel(curveRows(m, d, secOf(["P0"]), BASE));
  assert.deepEqual(p.traces.map((t) => t.kind), ["base", "meas", "set"]);
  assert.deepEqual(p.markers.filter((k) => k.kind === "set").map((k) => k.x), [48]);
  assert.deepEqual(readoutParts(p, 48), ["48×", ["factory", "1.050"], ["now", "1.050"], ["after", "1.030", "V"]]);
  const mv = plotModel(curveRows(m, d, secOf(["P0"]), null));
  assert.equal(mv.mode, "mv");
  assert.equal(mv.y.title, "mV");
  assert.deepEqual(mv.traces.find((t) => t.kind === "set").pts.find((q) => q[0] === 48), [48, S(-20)]);
});

test("plot: the OC point extends the curve; with a whole-curve offset on it the segment is an approximation (not measured)", () => {
  const d0 = setOcRatio(m, emptyDraft(), ["P1"], 58);
  const base = baselineFromRecord({ units: { P1: { points: [8, 20, 30, 48, 53, 55, 56, 57].map((r, i) => ({ ratio: r, status: "ok", vid_v: 0.9 + i * 0.05 })) } } });
  let p = plotModel(curveRows(m, d0, sections(m, ["P1"])[0], base));
  const seg = p.traces.filter((t) => t.pts.some((q) => q[0] === 58));
  assert.equal(seg.length, 1);
  assert.equal(seg[0].approx, false);
  assert.ok(p.cursorXs.includes(58));
  const d1 = editCurve(m, d0, ["P1"], -10).draft;
  p = plotModel(curveRows(m, d1, sections(m, ["P1"])[0], base));
  assert.equal(p.traces.find((t) => t.pts.some((q) => q[0] === 58)).approx, true);
  // OC 60x over a 57x top with an offset on the top point: the line between them is not measured
  const d2 = setPoint(m, setOcRatio(m, emptyDraft(), ["P1"], 60), ["P1"], 57, -20);
  const rows = curveRows(m, d2, sections(m, ["P1"])[0], base);
  assert.equal(rows.at(-1).interpNotMeasured, true);
  p = plotModel(rows);
  assert.equal(p.approx, true);
  assert.equal(plotModel(curveRows(m, setOcRatio(m, emptyDraft(), ["P1"], 60), sections(m, ["P1"])[0], base)).approx, false, "top point at offset 0: measured");
});

// ---- OC ----
test("oc: the OC state wording, ocShown, 'no OC point' where the ratio is set at boot", () => {
  assert.equal(ocInfo(m, emptyDraft(), ["P0"]).text, "No OC ratio configured");
  assert.equal(ocInfo(m, emptyDraft(), ["EC0"]).text, "OC ratio 48× (fused top 46×, set at boot) · no OC point");
  const d = setOcRatio(m, emptyDraft(), ["P0"], 58);
  assert.equal(ocInfo(m, d, ["P0"]).text, "OC ratio 58× (fused top 57×) · OC point 9 · adaptive V");
  assert.equal(ocShown(m.units.P0, 57), null, "the OC word at the stock ratio is no OC ratio");
  assert.equal(ocShown(m.units.P0, 58), 58);
  assert.equal(ocShown(m.units.P1, 56), 56, "above stock, on a factory point");
  assert.equal(ocPointNo([m.units.P0]), 9);
  assert.equal(ocPointNo([m.units.EC0]), 7);
  assert.deepEqual(offsetUnits(m, d, ["P0", "EC0"]).map((u) => u.id), ["P0", "EC0"]);
});

test("oc: D-050 the turbo table still caps an OC ratio above it; a drafted table lifts it; the intent carries no table", () => {
  assert.equal(ocAboveTable(m, emptyDraft(), "P"), null);
  const d = setOcRatio(m, emptyDraft(), ["P0"], 58);
  const o = ocAboveTable(m, d, "P");
  assert.deepEqual([o.top, o.units], [57, [{ id: "P0", ratio: 58 }]]);
  assert.equal(ocAboveTable(m, setBucket(m, d, "P", 0, 58), "P"), null);
  assert.equal(buildIntent(m, d).intent.turbo, undefined);
});

test("oc: flags — a target below the top point is lifted; the line to the OC ratio is not measured when the top point has an offset", () => {
  let d = setOcRatio(m, emptyDraft(), ["P1"], 59);
  d = setVt(m, d, ["P1"], 1.2);
  assert.deepEqual(ocFlags(m, d, ["P1"], null).map((f) => f.key), ["warn.target_lifted"]);
  d = setPoint(m, d, ["P1"], 57, -20);
  assert.deepEqual(ocFlags(m, d, ["P1"], null).map((f) => f.key), ["warn.target_lifted", "warn.interp_not_measured"]);
  assert.deepEqual(ocFlags(m, clearOcEdits(m, d, ["P1"]), ["P1"], null), []);
});

// ---- inspector heading ----
test("inspector: the heading is the unit; the facts line says cpu, factory top, max ratio, OC state, favored; an E-cluster is one unit of four CPUs", () => {
  assert.equal(selectionTitle(m, ["P0"]), "P0");
  assert.equal(selectionTitle(m, ["ring"]), "Ring");
  assert.equal(selectionTitle(m, ["P0", "P3"]), "P0, P3");
  assert.equal(selectionTitle(m, quickSelections(m).P), "all 8 P-cores");
  assert.equal(selectionTitle(m, []), "Nothing selected");
  assert.equal(factsText(selectionFacts(m, emptyDraft(), ["P0"])), "cpu 0 · factory top 57× · max ratio 57× · no OC point · favored");
  assert.equal(factsText(selectionFacts(m, emptyDraft(), ["EC0"])), "cpus 8–11 · 4 CPUs, one ratio, one curve · factory top 46× · runs 48× (set at boot), no OC point");
  assert.equal(factsText(selectionFacts(m, setOcRatio(m, emptyDraft(), ["P1"], 58), ["P1"])), "cpu 1 · factory top 57× · max ratio 55× · OC point 58×");
  assert.match(factsText(selectionFacts(m, emptyDraft(), ["ring"])), /9 points, by number/);
  assert.deepEqual(favoredIds(m), ["P0", "P3"]);
});

// ---- the Tune slice ----
test("tabs: Cores · Frequency · Power · Ring & uncore; the old ids land in their new tab", () => {
  assert.deepEqual(SUBTABS.map((t) => t.label), ["Cores", "Frequency", "Power", "Ring & uncore"]);
  assert.deepEqual(["ratios", "frequency", "uncore", "nope", "power"].map(tabId), ["turbo", "turbo", "ring", "cores", "power"]);
  assert.equal(PERSIST.turbo, null, "Frequency mixes mailbox, MSR and runtime values: tags per column");
  const store = createAppStore();
  patchTune(store, { subtab: "ratios" });
  assert.equal(store.get().tune.subtab, "turbo");
});

test("tune slice: a new model re-diffs the kept draft (rebaseDraft): what the CPU now holds leaves it, the rest stays", () => {
  const store = createAppStore();
  ensureTune(store);
  patchTune(store, { model: m });
  const d = setPoint(m, setPoint(m, emptyDraft(), ["P0"], 53, -20), ["P1"], 48, -10);
  patchTune(store, { draft: d });
  assert.equal(store.get().pending.changes, 2);
  const r = structuredClone(READ);
  r.tune.P0.cpus[0].points.find((p) => p.ratio === 53).offset_mv = -19.53; // the CPU now holds P0's edit (as the 1/1024 V word reads back)
  patchTune(store, { model: modelFromRead(r) });
  assert.deepEqual(Object.keys(store.get().tune.draft.units), ["P1"]);
  assert.equal(store.get().pending.changes, 1);
  patchTune(store, { model: m, draft: emptyDraft() });
  assert.equal(store.get().pending.changes, 0, "an explicit draft wins");
});

test("tune slice: pending is counted from the draft, discard and review work on the store alone", () => {
  const store = createAppStore();
  ensureTune(store);
  patchTune(store, { model: m });
  const d = setPoint(m, setPoint(m, emptyDraft(), ["P0"], 53, -20), ["EC0"], 15, -5);
  patchTune(store, { draft: d });
  assert.deepEqual(store.get().pending, { changes: 2, units: 2 });
  const seen = [];
  store.events.addEventListener("tune:review", (e) => seen.push(e.detail));
  requestReview(store);
  assert.deepEqual(seen, [{ changes: 2, units: 2 }]);
  discardDraft(store);
  assert.deepEqual(store.get().tune.draft, { units: {}, turbo: {} });
  syncPending(store);
  assert.equal(initialTune().subtab, "cores");
});

test("baseline: exact points, interpolated points, interpolation between measured neighbours only, nothing outside", () => {
  const rec = { units: { P0: { points: [{ ratio: 20, status: "ok", vid_v: 1.0 }, { ratio: 30, status: "ok", vid_v: 1.1 }, { ratio: 40, status: "interpolated", vid_v: 1.15 }, { ratio: 55, status: "ok", vid_v: 1.3 }] } } };
  const f = baselineFromRecord(rec);
  assert.deepEqual(f("P0", 20), { v: 1.0, src: "baseline" });
  assert.deepEqual(f("P0", 40), { v: 1.15, src: "interpolated" });
  assert.ok(Math.abs(f("P0", 25).v - 1.05) < 1e-9);
  assert.equal(f("P0", 10), null);
  assert.equal(f("P0", 60), null);
  assert.equal(baselineFromRecord(null)("P0", 20), null);
});

test("read duration text", () => {
  assert.equal(fmtSeconds(420), "420 ms");
  assert.equal(fmtSeconds(18200), "18.2 s");
});
