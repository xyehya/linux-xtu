// node --test "desktop/app/ui/tests/*.test.mjs"   (R-B4: every case of tests/golden/voltage_cases.json through the UI lib AND through the mock backend; no hardware)
// The golden file is shared with the Python helper: the same cases, the same expected layers, intents, words, predictions and refusals on both sides (tests/golden/README.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge } from "../bridge.js";
import { createMockTransport } from "../fixtures/mock-backend.js";
import { modelFromRead, pointAt, snapOffsetMv } from "../lib/units.js";
import * as D from "../lib/draft.js";
import { buildIntent } from "../lib/intent.js";
import { predictUnit, predictedAt, voltageDetail, ocPointPrediction } from "../lib/predict.js";
import { MISSING_HINT_KEYS } from "../lib/limits.js";
import { WHY } from "../lib/hints.js";

const GOLDEN = JSON.parse(readFileSync(new URL("../../../../tests/golden/voltage_cases.json", import.meta.url), "utf8"));
const TOL_V = GOLDEN.tolerance_v;
const rawOf = (mv) => (mv < 0 ? -1 : 1) * Math.floor((Math.abs(mv) * 1024 + 512) / 1000 + 1e-9);
const near = (a, b, tol, what) => assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const subset = (actual, want, what) => {
  for (const [k, v] of Object.entries(want || {})) assert.deepEqual(actual[k], v, `${what}.${k}`);
};

async function mockFor(c) {
  const bridge = new Bridge(createMockTransport({ intervalMs: 60_000, stepMs: 1, applyMode: null, profiles: null, uvp: null, cpuState: c.read || null }), "mock");
  await bridge.connect();
  return bridge;
}
async function readModel(bridge, c) {
  const r = await bridge.run("tune.read", {});
  assert.equal(r.ok, true, "tune.read");
  if (c.uvp) r.result.uvp = c.uvp;
  return modelFromRead(r.result);
}
const baseOf = (c) => (id, ratio) => {
  const v = c.baseline_v && c.baseline_v[id] ? c.baseline_v[id][String(ratio)] : undefined;
  return typeof v === "number" ? { v, src: "baseline" } : null;
};

function applyEdit(m, d, e) {
  switch (e.op) {
    case "curve": return D.editCurve(m, d, e.units, e.mv);
    case "point": return D.editPoint(m, d, e.units, e.ratio, e.mv);
    case "ring_point": return D.editRingPoint(m, d, e.point, e.mv);
    case "oc_ratio": return D.editOcRatio(m, d, e.units, e.ratio);
    case "oc_target": return D.editVt(m, d, e.units, e.v);
    case "oc_mode": return D.editOcMode(m, d, e.units, e.mode);
    case "bucket": return D.editBucket(m, d, e.kind, e.i, e.ratio);
    default: throw new Error("unknown golden op " + e.op);
  }
}
/** The edits of a case over a model: {draft, last (the last edit's answer), refusal (the refusal answer, if the case expects one)}. */
function runEdits(m, c) {
  let d = D.emptyDraft();
  let last = null;
  for (const [i, e] of c.edits.entries()) {
    const r = applyEdit(m, d, e);
    if (c.expect.refusal && c.expect.refusal.op === i) {
      assert.equal(r.ok, false, `${c.id}: edit ${i} must be refused`);
      return { draft: d, last: r, refusal: r };
    }
    assert.equal(r.ok, true, `${c.id}: edit ${i} (${e.op}) refused: ${r.reason} ${JSON.stringify(r.values)}`);
    d = r.draft;
    last = r;
  }
  return { draft: d, last, refusal: null };
}

/** Every lib-side expectation of a case over model `m`. */
function checkLib(c, m) {
  const x = c.expect;
  const { draft: d, last, refusal } = runEdits(m, c);
  if (x.refusal) {
    assert.ok(refusal, `${c.id}: no refusal`);
    assert.equal(refusal.reason, x.refusal.reason);
    subset(refusal.values, x.refusal.values, c.id + " refusal.values");
    assert.ok(refusal.reason in WHY || MISSING_HINT_KEYS.includes(refusal.reason), `${c.id}: ${refusal.reason} is neither a hints.js WHY key nor listed as missing`);
    return d;
  }
  for (const [id, want] of Object.entries(x.draft || {})) {
    const u = d.units[id] || { pts: {} };
    assert.equal(u.ratio ?? null, want.ratio, `${c.id} ${id} draft ratio`);
    if (want.vt === null) assert.equal(u.vt, undefined, `${c.id} ${id}: no target drafted`);
    else near(u.vt, want.vt, 1e-9, `${c.id} ${id} draft vt`);
    assert.equal(!!u.vtAuto, want.vt_auto, `${c.id} ${id} vtAuto`);
  }
  for (const [id, want] of Object.entries(x.layers || {})) {
    const u = d.units[id] || { pts: {} };
    assert.equal(u.curveMv ?? null, want.curve_mv, `${c.id} ${id}: the drafted whole-curve layer`);
    assert.deepEqual(Object.fromEntries(Object.entries(u.pts).map(([k, v]) => [String(k), v])), want.points_mv, `${c.id} ${id}: the drafted point layer`);
    if (want.curve_mv !== null) assert.deepEqual(D.curveLayerValue(m, d, [id]), { state: "same", value: snapOffsetMv(want.curve_mv) }); // QA-04: the editor shows the 1/1024 V step
    for (const [r, mv] of Object.entries(want.points_mv)) assert.deepEqual(D.pointValue(m, d, [id], Number(r)).agg, { state: "same", value: snapOffsetMv(mv) }, `${c.id} ${id} ${r}x: the field shows the point layer as the CPU will hold it`);
  }
  for (const [id, want] of Object.entries(x.read_layers || {})) {
    near(D.curCurveMv(m.units[id]), want.curve_mv, 0.5, `${c.id} ${id} read whole-curve layer`);
    for (const [r, mv] of Object.entries(want.points_mv || {})) near(pointAt(m.units[id], Number(r)).offset_mv, mv, 0.5, `${c.id} ${id} ${r}x read point layer`);
  }
  for (const [id, pts] of Object.entries(x.effective_offset_mv || {})) {
    for (const [r, mv] of Object.entries(pts)) near(D.effPointMv(d, m.units[id], pointAt(m.units[id], Number(r))), mv, 1, `${c.id} ${id} ${r}x effective offset`);
  }
  for (const [id, pts] of Object.entries(x.effective_offset_raw || {})) {
    const u = m.units[id];
    for (const [r, want] of Object.entries(pts)) {
      const p = pointAt(u, Number(r));
      assert.equal(rawOf(D.effCurveMv(d, u)) + rawOf(D.effPointLayerMv(d, u, p)), want, `${c.id} ${id} ${r}x: whole-curve raw + point raw`);
      assert.ok(Math.abs(Math.round(D.effPointMv(d, u, p) * 1.024) - want) <= 1, `${c.id} ${id} ${r}x: effPointMv within one raw step`);
    }
  }
  if (x.pending) assert.equal(D.diff(m, d).total, x.pending.total, `${c.id} pending`);
  if (x.intent !== undefined) assert.deepEqual(buildIntent(m, d), { intent: x.intent }, `${c.id} intent`);
  if (x.intent_refusal) {
    const b = buildIntent(m, d);
    assert.equal(b.intent, undefined);
    assert.equal(b.reason, x.intent_refusal.reason);
    assert.equal(b.unit, x.intent_refusal.unit);
    assert.ok(D.draftProblems(m, d).some((p) => p.reason === x.intent_refusal.reason && p.unit === x.intent_refusal.unit), `${c.id}: draftProblems names it`);
  }
  const base = baseOf(c);
  for (const [id, vs] of Object.entries(x.voltage_v || {})) for (const [r, v] of Object.entries(vs)) near(voltageDetail(m, d, id, Number(r), base).v, v, TOL_V, `${c.id} ${id} V(${r}x)`);
  for (const [id, cs] of Object.entries(x.clamped_by || {})) for (const [r, cb] of Object.entries(cs)) assert.deepEqual(predictedAt(predictUnit(m, d, id, base), Number(r)).clampedBy, cb, `${c.id} ${id} ${r}x clamp`);
  for (const [id, ns] of Object.entries(x.not_measured || {})) for (const [r, keys] of Object.entries(ns)) assert.deepEqual(voltageDetail(m, d, id, Number(r), base).notMeasured, keys, `${c.id} ${id} ${r}x not measured`);
  for (const [id, want] of Object.entries(x.oc || {})) {
    const oc = ocPointPrediction(m, d, id, base);
    assert.ok(oc, `${c.id} ${id}: an OC point is predicted`);
    assert.deepEqual([oc.ratio, oc.mode, oc.clampedBy, oc.notMeasured], [want.ratio, want.mode, want.clamped_by, want.not_measured], `${c.id} ${id} OC point`);
    near(oc.target, want.target, TOL_V, `${c.id} ${id} OC target`);
    near(oc.v, want.v, TOL_V, `${c.id} ${id} OC voltage`);
    for (const k of oc.notMeasured) assert.ok(k in WHY || k === "warn.interp_not_measured", `${c.id}: flag ${k} has a hint (or is reported missing)`);
  }
  for (const w of x.warnings || []) assert.ok(D.warnings(m, d).some((g) => g.code === w.code && g.unit === w.unit && g.hint === w.hint), `${c.id}: warning ${w.code} ${w.unit}`);
  for (const [k, t] of Object.entries(x.turbo || {})) assert.deepEqual(D.turboEff(m, d, k), t, `${c.id} turbo ${k}`);
  if (x.moved) assert.deepEqual(last.moved, x.moved, `${c.id} moved`);
  return d;
}

for (const c of GOLDEN.cases) {
  test(`golden ${c.id}: lib — ${c.title}`, async () => {
    const bridge = await mockFor(c);
    const m = await readModel(bridge, c);
    for (const [id, s] of Object.entries(c.read || {})) {
      const u = m.units[id];
      if (s.oc && typeof s.oc.offset_mv === "number") near(D.curCurveMv(u), s.oc.offset_mv, 0.5, `${c.id} ${id}: the read whole-curve layer (P2 = 0 offset)`);
      for (const [r, mv] of Object.entries(s.points_mv || {})) near(pointAt(u, Number(r)).offset_mv, mv, 0.5, `${c.id} ${id} ${r}x: the read point layer`);
    }
    checkLib(c, m);
    await bridge.close();
  });

  const x = c.expect;
  if (!(x.intent || x.helper_intent)) continue;
  test(`golden ${c.id}: mock — plans, writes and re-reads like the helper`, async () => {
    const bridge = await mockFor(c);
    if (x.helper_intent) {
      const r = await bridge.call("tune.plan", { intent: x.helper_intent });
      if (x.helper_refusal) {
        assert.equal(r.ok, false, `${c.id}: the helper refuses this intent`);
        assert.equal(r.error.code, x.helper_refusal.code);
        if (x.helper_refusal.check) assert.equal(r.error.detail.check, x.helper_refusal.check);
        assert.match(r.error.message, new RegExp(x.helper_refusal.message_re));
      }
      if (x.helper_warning) {
        assert.equal(r.ok, true, `${c.id}: the helper plans this intent`);
        assert.ok(r.result.warnings.some((w) => w.code === x.helper_warning), `${c.id}: warning ${x.helper_warning}`);
      }
    }
    if (!x.intent) return bridge.close();
    const m = await readModel(bridge, c);
    const d = checkLib(c, m);
    const plan = await bridge.call("tune.plan", { intent: x.intent });
    assert.equal(plan.ok, true, `${c.id}: plan refused: ${plan.error && plan.error.message}`);
    for (const u of [...new Set((x.words || []).map((w) => w.unit))]) assert.ok(plan.result.units.includes(u), `${c.id}: the plan names ${u}`);
    const wrote = new Set(plan.result.steps.filter((s) => !s.conditional).map((s) => s.cpu));
    for (const w of x.words || []) assert.ok(wrote.has(w.cpu), `${c.id}: a write on cpu ${w.cpu}`);
    await bridge.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.result.plan_id }] }); // R-S3: the shell's native dialog (the mock answers yes)
    const applied = await bridge.run("tune.apply", { plan_id: plan.result.plan_id });
    assert.equal(applied.ok, true, `${c.id}: apply`);
    const words = applied.result.readback.filter((r) => r.point !== "turbo").map((r) => ({ unit: r.unit, cpu: r.cpu, p2: r.point, word: r.expected.toUpperCase().replace("0X", "0x") }));
    if (x.words) assert.deepEqual(words, x.words.map((w) => ({ unit: w.unit, cpu: w.cpu, p2: w.p2, word: w.word })), `${c.id}: the 0x11 words written, in order`);
    const after = await readModel(bridge, c);
    for (const [id, want] of Object.entries(x.read_after || {})) {
      const u = after.units[id];
      near(D.curCurveMv(u), want.curve_mv, 0.01, `${c.id} ${id}: the whole-curve layer after the apply (it must not vanish)`);
      for (const [r, mv] of Object.entries(want.points_mv)) near(pointAt(u, Number(r)).offset_mv, mv, 0.01, `${c.id} ${id} ${r}x after`);
      if (want.oc_ratio !== undefined) assert.equal(D.curRatio(u), want.oc_ratio);
      if (want.v_target_v !== undefined) near(D.curVt(u), want.v_target_v, 1e-4, `${c.id} ${id} target after`);
    }
    const kept = D.rebaseDraft(after, d);
    assert.deepEqual(kept.draft, D.emptyDraft(), `${c.id}: a re-read that holds the edits leaves nothing pending`);
    assert.ok(kept.dropped.every((x2) => x2.reason === "equal_to_read"), `${c.id}: ${JSON.stringify(kept.dropped)}`);
    await bridge.close();
  });
}

test("golden file: every case has evidence, a known op and an expectation; the units match the recorded read", () => {
  const ops = new Set(["curve", "point", "ring_point", "oc_ratio", "oc_target", "oc_mode", "bucket"]);
  const ids = new Set();
  for (const c of GOLDEN.cases) {
    assert.ok(!ids.has(c.id), "unique id " + c.id);
    ids.add(c.id);
    assert.ok(c.evidence.length && c.evidence.every((e) => /^\[(MEASURED|DECOMPILED|DOC|COMMUNITY|UNVERIFIED)[ \]]/.test(e)), `${c.id}: evidence tags`);
    assert.ok(c.edits.every((e) => ops.has(e.op)), `${c.id}: ops`);
    assert.ok(Object.keys(c.expect).length, `${c.id}: expectations`);
  }
  assert.ok(GOLDEN.cases.length >= 25);
  const m = modelFromRead(GOLDEN_READ());
  for (const [id, u] of Object.entries(GOLDEN.units)) {
    assert.deepEqual(m.units[id].cpus, u.cpus, id + " cpus");
    assert.deepEqual([m.units[id].fused.ratio, m.units[id].fused.v], [u.fused.ratio, u.fused.v], id + " fused");
    assert.deepEqual(m.units[id].points.map((p) => [String(p.point), p.ratio]), Object.entries(u.points), id + " points");
    if (u.favored !== null) assert.equal(m.units[id].favored, u.favored);
    const w = parseInt(u.oc_word, 16);
    assert.deepEqual([m.units[id].oc.ratio ?? 0, m.units[id].curveMv], [w & 0xff, 0], id + " OC word (ratio, whole-curve offset)");
  }
});

// R-09 regression (assessment 03 U-04 / R-09, probe3): -20 on 53x with a whole-curve -30 shows -50 and plans the P2 = 0 word only
test("R-09 regression: a point at -20 with whole-curve -30 shows -50 everywhere (editor value, pending diff, prediction) and plans the right words", async () => {
  const c = GOLDEN.cases.find((k) => k.id === "R09-curve-over-point");
  const bridge = await mockFor(c);
  const m = await readModel(bridge, c);
  const d = D.setCurve(m, D.emptyDraft(), ["P0"], -30); // the deprecated API agrees with editCurve
  const p53 = pointAt(m.units.P0, 53);
  assert.ok(Math.abs(D.effPointMv(d, m.units.P0, p53) - (-19.531 + snapOffsetMv(-30))) < 0.01, "-19.531 (the read raw) + -30.273 (the raw the typed -30 becomes)");
  assert.deepEqual(D.pointValue(m, d, ["P0"], 53).agg, { state: "same", value: p53.offset_mv }, "the point field keeps showing the point's own -20");
  const item = D.diff(m, d).items.find((i) => i.field === "curve");
  assert.deepEqual([item.from, item.to], [0, -30], "one change: the whole-curve layer");
  assert.equal(D.diff(m, d).total, 1, "not eight point writes");
  const v = voltageDetail(m, d, "P0", 53, baseOf(c)).v;
  near(v, 1.2 - 0.0495, TOL_V, "predicted 53x");
  const plan = await bridge.call("tune.plan", { intent: buildIntent(m, d).intent });
  assert.deepEqual(plan.result.steps.filter((s) => !s.conditional).map((s) => [s.kind, s.unit, s.point]), [["write_vf", "P0", 0]], "the P2 = 0 word, no point writes");
  assert.deepEqual(plan.result.after.P0["0"].offset_mv, -30.273);
  await bridge.close();
});

test("R-09 regression: after the apply the whole-curve offset is its own layer in the re-read; a kept draft is re-diffed, not dropped blindly", async () => {
  const bridge = await mockFor({ read: null });
  const m = await readModel(bridge, {});
  let d = D.editCurve(m, D.emptyDraft(), ["P0"], -30).draft;
  const plan = await bridge.call("tune.plan", { intent: buildIntent(m, d).intent });
  await bridge.call("app.confirm", { plans: [{ op: "tune.apply", plan_id: plan.result.plan_id }] }); // R-S3: the shell's native dialog
  await bridge.run("tune.apply", { plan_id: plan.result.plan_id });
  d = D.editPoint(m, d, ["P0"], 53, -20).draft; // typed after the apply, over the old read
  const after = await readModel(bridge, {});
  assert.ok(Math.abs(after.units.P0.curveMv - -30.273) < 1e-3, "the OC word's offset is read as the whole-curve layer");
  assert.ok(Math.abs(D.effPointMv(D.emptyDraft(), after.units.P0, pointAt(after.units.P0, 53)) - -30.273) < 1e-3, "and every point runs it");
  const r = D.rebaseDraft(after, d);
  assert.deepEqual(r.draft.units.P0, { pts: { 53: -20 } }, "the applied curve leaves the draft, the new point edit stays");
  assert.deepEqual(r.dropped, [{ unit: "P0", field: "curve", key: null, reason: "equal_to_read" }]);
  await bridge.close();
});

test("refusals: each reason is a hints.js WHY key or listed in MISSING_HINT_KEYS (the report names the missing ones)", () => {
  for (const k of MISSING_HINT_KEYS) assert.equal(k in WHY, false, k + " is listed as missing but exists: drop it from MISSING_HINT_KEYS");
  const reasons = GOLDEN.cases.flatMap((c) => [c.expect.refusal && c.expect.refusal.reason, c.expect.intent_refusal && c.expect.intent_refusal.reason]).filter(Boolean);
  for (const r of reasons) assert.ok(r in WHY || MISSING_HINT_KEYS.includes(r), r);
});

test("mock preflight (STATE backlog 'mock still shows E 49x'): E clusters top out at 48x (kernel 4900 MHz), as the G-233 helper reports it", async () => {
  const bridge = await mockFor({});
  const pre = await bridge.call("preflight", {});
  const units = Object.fromEntries(pre.result.topology.units.map((u) => [u.id, u]));
  assert.deepEqual([units.EC0.max_ratio, units.EC0.max_khz, units.EC0.ratio_model], [48, 4900000, "measured"]);
  assert.deepEqual([units.P0.max_ratio, units.P0.max_khz, units.P1.max_ratio], [57, 5700000, 55]);
  assert.ok(pre.result.topology.units.every((u) => u.max_ratio !== 49));
  await bridge.close();
});

function GOLDEN_READ() {
  return JSON.parse(readFileSync(new URL("../fixtures/tune-read.json", import.meta.url), "utf8")).result;
}
