// draft.js: the pending edits over a units model (G-207; voltage model rebuilt in R-B4). Ported from web/app.js T.draft / setPoint / setVt / setRatio / setOcOffset / setBucket.
//
// A draft is plain data and every edit returns a NEW draft (store-friendly, no mutation):
//   { units: { <id>: { curveMv?, pts: { <ratio | ring point no>: mV }, ratio?, vt?, vtAuto?, restate? } }, turbo: { P?: [8 ratios], E?: [8 ratios] } }
//
// The voltage model (R-B4; golden cases in tests/golden/voltage_cases.json, shared with the helper):
//  - Two offset LAYERS per P/E unit, kept apart everywhere (draft, diff, intent): `curveMv` = the whole-curve offset (the offset field of the P2 = 0 word) and `pts` = the fused points'
//    own offsets. The CPU ADDS them: effective offset of a point = whole-curve + point [MEASURED lnx 2026-10-11/12, platform-arl-s.md §3]. A whole-curve edit never touches the point
//    layer and a point edit never spreads the curve (the old "replace" model, assessment 03 R-09 / U-04, is gone).
//  - Fused points take offsets only. The OC point is one extra point above the fused top (the P2 = 0 word's ratio + adaptive target). Only the adaptive-target mode is offered
//    (D-053 item 6): the mode is explicit where it is used (ocModeOf, diff item `mode`, predict.js ocPointPrediction `mode`, the intent's explicit `v_target_v`); the draft stores no
//    mode field while there is only one (views' tests pin the unit keys). With no voltage typed, a new OC point takes the UN-OFFSET fused top voltage (0x09) as its target, exactly what the
//    helper writes [MEASURED win 2026-10-01 XTU fill; G-241 P0 58x word 0x0005B43A]: the top point's offset is not inherited.
//  - E clusters are one unit (one curve, one ratio) of four CPUs.
//  - Refusals, never silent clamps (D-053 item 5): the edit* functions answer {ok: true, draft, ...} or {ok: false, reason, values} with `reason` a key of WHY in lib/hints.js
//    (lib/limits.js REASON). Positive point / ring / whole-curve offsets are refused.
//  - The set* functions are the pre-R-B4 API, kept for views that have not migrated: they return a draft (the old one when the edit is refused) and still accept a positive
//    offset where the CPU ceiling was read (tests of the G-238 / G-240 views use one). New code uses edit*.
// An edit equal to what was read is dropped (offsets compare as the 1/1024 V raw word), so "pending" always means "differs from the CPU". Multi-unit edits (PLAN §4.2): an edit on point
// ratio R applies to every selected unit that HAS a point at R and to no other; P and E selected together are two sections. Nothing here talks to the helper.
import { isNum, fmtMvNum } from "./format.js";
import { limitsFor, checkOffset, checkVt, vtWindow, snapGrid, refusal, REASON, GRID } from "./limits.js";
import {
  RING_ID, unitKind, sameMv, sameV, snapOffsetMv, aggregate, pointAt, ringPoint, unitsWithPoint, fusedTopOf, ocClass, aboveTop, ocRatioWindow, turboFloor,
} from "./units.js";

export const emptyDraft = () => ({ units: {}, turbo: {} });
export const isEmpty = (draft) => !Object.keys(draft.units).length && !Object.keys(draft.turbo).length;

/** OC-point voltage modes (assessment 03 R-03..R-06). Only "adaptive" is offered (D-053 item 6); the others wait for the experiments of assessment 05 §3.6 (E-1..E-6). */
export const OC_MODES = Object.freeze({
  adaptive: Object.freeze({ offered: true, what: "the OC point asks for its own target voltage; the CPU lifts a lower one to the top point [MEASURED lnx 2026-10-11/13]" }),
  offset: Object.freeze({ offered: false, what: "an offset on the OC point alone: the P2 = 0 offset is the whole-curve offset; with an OC point its effect is not measured" }),
  target_offset: Object.freeze({ offered: false, what: "target and offset in one P2 = 0 word: resulting voltage not measured" }),
});
export const OC_MODE = "adaptive";

function clone(draft) {
  const units = {};
  for (const [id, d] of Object.entries(draft.units)) units[id] = { ...d, pts: { ...d.pts } };
  const turbo = {};
  for (const [k, t] of Object.entries(draft.turbo)) turbo[k] = t.slice();
  return { units, turbo };
}
const ensure = (next, id) => next.units[id] || (next.units[id] = { pts: {} });
function tidy(next, id) {
  const d = next.units[id];
  if (!d) return;
  if (d.vt === undefined) delete d.vtAuto;
  if (d.ratio === undefined) delete d.restate;
  if (d.curveMv === undefined && !Object.keys(d.pts).length && d.vt === undefined && d.ratio === undefined) delete next.units[id];
}
const liveIds = (model, ids) => ids.filter((id) => model.units[id]);
const ok = (draft, extra = {}) => ({ ok: true, draft, ...extra });
const firstRefusal = (results) => results.find((r) => r && r.ok === false) || null;

// ---- effective (draft over read) and current values -----------------------------------------------------------------------------------------
export const curRatio = (unit) => (unit.oc && isNum(unit.oc.ratio) && unit.oc.ratio > 0 ? unit.oc.ratio : null);
export const curVt = (unit) => (unit.oc && isNum(unit.oc.v_target_v) ? unit.oc.v_target_v : null);
/** The whole-curve layer as read: the P2 = 0 word's offset (mV); null = that word was not read; 0 for the ring (not modelled, D-045). */
export const curCurveMv = (unit) => (!unit ? null : unit.kind === "R" ? 0 : isNum(unit.curveMv) ? unit.curveMv : null);

/** The whole-curve layer with the draft applied (mV); null when unknown (not read, not drafted). */
export function effCurveMv(draft, unit) {
  if (!unit) return null;
  if (unit.kind === "R") return 0;
  const d = draft.units[unit.id];
  return d && isNum(d.curveMv) ? snapOffsetMv(d.curveMv) : curCurveMv(unit); // a typed value shows as the 1/1024 V step the CPU will hold (QA-04)
}
/** A fused point's OWN offset (the point layer) with the draft applied: ratio-keyed for P/E, point-number-keyed for the ring. This is what a point's offset field edits. */
export function effPointLayerMv(draft, unit, p) {
  const d = draft.units[unit.id];
  const key = unit.kind === "R" ? p.point : p.ratio;
  if (d && d.pts[key] !== undefined) return snapOffsetMv(d.pts[key]); // QA-04, as effCurveMv
  return p.offset_mv;
}
/** The EFFECTIVE offset a point runs at with the draft applied = whole-curve layer + point layer (R-09); null when a layer is unknown. The ring: its point offset. */
export function effPointMv(draft, unit, p) {
  const pt = effPointLayerMv(draft, unit, p);
  const c = effCurveMv(draft, unit);
  return isNum(pt) && isNum(c) ? pt + c : null;
}
/** The effective offset of a point as read (both layers of the read). */
export function readPointMv(unit, p) {
  const c = curCurveMv(unit);
  return isNum(p.offset_mv) && isNum(c) ? p.offset_mv + c : null;
}
export function effRatio(draft, unit) {
  const d = draft.units[unit.id];
  return d && d.ratio !== undefined ? d.ratio : curRatio(unit);
}
export function effVt(draft, unit) {
  const d = draft.units[unit.id];
  return d && d.vt !== undefined ? d.vt : curVt(unit);
}
/** The OC voltage mode of a unit: "adaptive" when it has (or will have) an OC point, else null. */
export function ocModeOf(draft, unit) {
  return unit && unit.kind !== "R" && ocClass(unit, effRatio(draft, unit)) === "oc" ? OC_MODE : null;
}
export const turboCur = (model, kind) => (model.turbo && model.turbo[kind] ? model.turbo[kind].ratios : null);
export const turboEff = (model, draft, kind) => draft.turbo[kind] || turboCur(model, kind);

// ---- aggregates for the editors ("mixed") ---------------------------------------------------------------------------------------------------
const mvAgg = (values) => aggregate(values, sameMv);
const peIds = (model, ids) => liveIds(model, ids).filter((id) => unitKind(id) !== "R");

/** The whole-curve LAYER over the P/E units of `ids` (the P2 = 0 offset): read (eff false) or as edited. This is what the whole-curve field shows and edits. */
export function curveLayerValue(model, draft, ids, eff = true) {
  return mvAgg(peIds(model, ids).map((id) => (eff ? effCurveMv(draft, model.units[id]) : curCurveMv(model.units[id]))));
}
/**
 * The EFFECTIVE offsets (whole-curve + point) over every fused point of the P/E units in `ids`, read (eff false) or as edited. Pre-R-B4 name: views that show it in the whole-curve
 * field must move to curveLayerValue (the field edits the layer, not this sum).
 */
export function curveValue(model, draft, ids, eff = true) {
  const vals = peIds(model, ids).flatMap((id) => model.units[id].points.map((p) => (eff ? effPointMv(draft, model.units[id], p) : readPointMv(model.units[id], p))));
  return mvAgg(vals);
}
/**
 * The point at `ratio` over the selected units that have it: {agg (the POINT layer: what the field edits), total (effective offsets: curve + point), ids (the units it applies to),
 * pending (the point's effective offset or its own offset differs from the read)}.
 */
export function pointValue(model, draft, ids, ratio, eff = true) {
  const us = unitsWithPoint(model, liveIds(model, ids), ratio);
  const at = (id) => pointAt(model.units[id], ratio);
  const layer = (id) => (eff ? effPointLayerMv(draft, model.units[id], at(id)) : at(id).offset_mv);
  const total = (id) => (eff ? effPointMv(draft, model.units[id], at(id)) : readPointMv(model.units[id], at(id)));
  const pending = us.some((id) => {
    const u = model.units[id];
    const p = at(id);
    const rt = readPointMv(u, p);
    const et = effPointMv(draft, u, p);
    return !sameMv(p.offset_mv, effPointLayerMv(draft, u, p)) || (isNum(rt) && isNum(et) && !sameMv(rt, et)) || isNum(rt) !== isNum(et);
  });
  return { agg: mvAgg(us.map(layer)), total: mvAgg(us.map(total)), ids: us, pending };
}
export function ringValue(model, draft, no, eff = true) {
  const u = model.units[RING_ID];
  const p = ringPoint(u, no);
  if (!p) return { agg: { state: "none" }, total: { state: "none" }, ids: [], pending: false };
  const now = effPointLayerMv(draft, u, p);
  const v = { state: "same", value: eff ? now : p.offset_mv };
  return { agg: v, total: v, ids: [RING_ID], pending: !sameMv(p.offset_mv, now) };
}
export function ocRatioValue(model, draft, ids, eff = true) {
  return aggregate(peIds(model, ids).map((id) => (eff ? effRatio(draft, model.units[id]) : curRatio(model.units[id]))));
}
export function vtValue(model, draft, ids, eff = true) {
  return aggregate(peIds(model, ids).map((id) => (eff ? effVt(draft, model.units[id]) : curVt(model.units[id]))), sameV);
}

// ---- editing: the refusal API (R-B4) ---------------------------------------------------------------------------------------------------------
const uvpOn = (model) => !!model && model.uvp === "on";
const offsetCheck = (model, kind, mv, opts) => checkOffset(model, kind, mv, { allowPositive: !!opts.allowPositive, uvp: uvpOn(model) });
const hasOcPoint = (draft, unit) => unit.kind !== "R" && ocClass(unit, effRatio(draft, unit)) === "oc";

/**
 * The whole-curve offset (the P2 = 0 word's offset field) of the P/E units of `ids`; the point layer is left as it is. The ring has no whole-curve field (its P2 = 0 word is never
 * written, D-045): a ring in `ids` sets every ring point to `mv` instead. -> {ok, draft, notes: [{reason: "warn.curve_with_oc", unit}]} | refusal.
 * Note "warn.curve_with_oc": the unit has an OC point; whether the whole-curve offset shifts its target has not been measured (assessment 05 §3.6 E5/E6).
 */
export function editCurve(model, draft, ids, mv, opts = {}) {
  const us = liveIds(model, ids).map((id) => model.units[id]);
  if (!us.length) return refusal(REASON.noSuchPoint, { value: mv });
  const ring = us.find((u) => u.kind === "R");
  if (ring && !model.features.ring) return refusal(REASON.ringUnsupported, {}, { unit: RING_ID });
  const checks = us.map((u) => offsetCheck(model, u.kind, mv, opts));
  const bad = firstRefusal(checks);
  if (bad) return { ...bad, unit: us[checks.indexOf(bad)].id };
  const next = clone(draft);
  const notes = [];
  us.forEach((unit, i) => {
    const v = checks[i].mv;
    const d = ensure(next, unit.id);
    if (unit.kind === "R") {
      for (const p of unit.points) {
        if (sameMv(p.offset_mv, v)) delete d.pts[p.point];
        else d.pts[p.point] = v;
      }
    } else {
      if (isNum(curCurveMv(unit)) && sameMv(curCurveMv(unit), v)) delete d.curveMv;
      else d.curveMv = v;
      if (hasOcPoint(next, unit) && !sameMv(effCurveMv(next, unit) ?? 0, 0)) notes.push({ reason: "warn.curve_with_oc", unit: unit.id });
    }
    tidy(next, unit.id);
  });
  return ok(next, { notes });
}

/** One fused point (by ratio) on every selected P/E unit that has it; only the point layer changes. -> {ok, draft, ids} | refusal (no unit has the point: refused.no_such_point). */
export function editPoint(model, draft, ids, ratio, mv, opts = {}) {
  const us = unitsWithPoint(model, liveIds(model, ids), ratio);
  if (!us.length) return refusal(REASON.noSuchPoint, { ratio });
  const checks = us.map((id) => offsetCheck(model, model.units[id].kind, mv, opts));
  const bad = firstRefusal(checks);
  if (bad) return { ...bad, unit: us[checks.indexOf(bad)] };
  const next = clone(draft);
  us.forEach((id, i) => {
    const d = ensure(next, id);
    if (sameMv(pointAt(model.units[id], ratio).offset_mv, checks[i].mv)) delete d.pts[ratio];
    else d.pts[ratio] = checks[i].mv;
    tidy(next, id);
  });
  return ok(next, { ids: us });
}

/** A ring point by P2 point number. Refused unless the helper reported the "ring" intent feature (G-212). */
export function editRingPoint(model, draft, no, mv, opts = {}) {
  const unit = model.units[RING_ID];
  if (!model.features.ring || !unit) return refusal(REASON.ringUnsupported, {}, { unit: RING_ID });
  if (!ringPoint(unit, no)) return refusal(REASON.noSuchPoint, { point: no }, { unit: RING_ID });
  const c = offsetCheck(model, "R", mv, opts);
  if (!c.ok) return { ...c, unit: RING_ID };
  const next = clone(draft);
  const d = ensure(next, RING_ID);
  if (sameMv(ringPoint(unit, no).offset_mv, c.mv)) delete d.pts[no];
  else d.pts[no] = c.mv;
  tidy(next, RING_ID);
  return ok(next);
}

/**
 * The adaptive target (V) of the OC point, snapped to the 5 mV grid unless `snap` is false. Only units whose effective ratio creates an OC point take one (D-035: a target without an
 * OC point is not retained); the others of `ids` are left alone. -> {ok, draft, ids} | refusal (no unit has an OC point: refused.target_needs_oc_point; out of window).
 */
export function editVt(model, draft, ids, volts, { snap = true } = {}) {
  const us = peIds(model, ids).filter((id) => hasOcPoint(draft, model.units[id]));
  if (!us.length) return refusal(REASON.targetNeedsOcPoint, { value: volts });
  const checks = us.map((id) => checkVt(model, model.units[id].kind, volts));
  const bad = firstRefusal(checks);
  if (bad) return { ...bad, unit: us[checks.indexOf(bad)] };
  const next = clone(draft);
  for (const id of us) {
    const unit = model.units[id];
    const w = vtWindow(model, unit.kind);
    let v = snap ? snapGrid(volts) : volts;
    if (v > w.max + 1e-9) v = GRID.vtMin + Math.floor((w.max - GRID.vtMin) / GRID.vtStep + 1e-9) * GRID.vtStep; // grid rounding near an off-grid ceiling: the step below it
    v = Math.round(v * 10000) / 10000;
    const d = ensure(next, id);
    if (sameV(curVt(unit), v)) delete d.vt;
    else d.vt = v;
    delete d.vtAuto;
    tidy(next, id);
  }
  return ok(next, { ids: us });
}

/** The OC voltage mode. Only "adaptive" is offered (D-053 item 6); "offset" and "target_offset" are refused with refused.oc_mode_not_offered. */
export function editOcMode(model, draft, ids, mode) {
  if (mode !== OC_MODE) return refusal(REASON.ocModeNotOffered, { mode: String(mode), what: OC_MODES[mode] ? OC_MODES[mode].what : "unknown mode" });
  return ok(draft);
}

/** The window check of one unit's OC ratio: null = fine, else a refusal. */
function ratioRefusal(model, unit, ratio) {
  if (!Number.isInteger(ratio)) return refusal(REASON.notNumber, { value: String(ratio) }, { unit: unit.id });
  if (ratio === curRatio(unit)) return null;
  const w = ocRatioWindow(model, [unit.id]);
  if (w.min === null || w.max === null) return refusal(REASON.noRead, { why: w.reason }, { unit: unit.id });
  if (ratio < w.min) return refusal(REASON.belowFloor, { value: ratio, min: w.min, unit: "×" }, { unit: unit.id });
  if (ratio > w.max) return refusal(REASON.aboveLimit, { value: ratio, max: w.max, unit: "×", source: w.source || "" }, { unit: unit.id });
  return null;
}
/** The target a new OC point takes when none is typed: the UN-OFFSET fused top voltage (0x09), as the helper writes it; null when 0x09 was not read (the helper then fills it). */
export function autoTarget(unit) {
  return unit && unit.fused && isNum(unit.fused.v) ? Math.round(unit.fused.v * 10000) / 10000 : null;
}
function applyRatio(model, next, unit, ratio) {
  const d = ensure(next, unit.id);
  delete d.restate; // G-239: any ratio edit replaces the explicit "restate what is in force"
  if (ratio === null || curRatio(unit) === ratio) delete d.ratio;
  else d.ratio = ratio;
  if (ocClass(unit, effRatio(next, unit)) === "oc") {
    if (!(isNum(effVt(next, unit)) && effVt(next, unit) > 0)) {
      const t = autoTarget(unit);
      if (t !== null) {
        d.vt = t;
        d.vtAuto = true;
      }
    }
  } else if (d.vt !== undefined) {
    delete d.vt; // a target without an OC point is not retained (D-035, G-124): it goes with the OC point
    delete d.vtAuto;
  }
  tidy(next, unit.id);
}
/**
 * The OC ratio. `ratio` null = back to what was read. A ratio above a unit's top fused point creates the OC point, which needs a target: where the unit has none the draft takes
 * the un-offset fused top voltage (autoTarget), marked `vtAuto` (dropping the ratio takes it back). -> {ok, draft} | refusal (any unit outside its window: nothing changes).
 */
export function editOcRatio(model, draft, ids, ratio) {
  const us = peIds(model, ids).map((id) => model.units[id]);
  if (!us.length) return refusal(REASON.noSuchPoint, { value: ratio });
  if (ratio !== null) {
    const bad = us.map((u) => ratioRefusal(model, u, ratio)).find(Boolean);
    if (bad) return bad;
  }
  const next = clone(draft);
  for (const unit of us) applyRatio(model, next, unit, ratio);
  return ok(next);
}

// G-150 "48x offset": the OC ratio's voltage entered as an offset from the fused top point's voltage (0x09); it is still the adaptive target (mode "adaptive"), not an OC-point offset.
function ocOffUnit(model, draft, unit) {
  const f = unit.fused;
  const ft = fusedTopOf(unit);
  const top = unit.points.find((p) => p.ratio === ft);
  const r = effRatio(draft, unit);
  const ab = aboveTop(model, unit, r);
  const ratio = ocClass(unit, r) === "oc" ? r : ab ? ab.max : null;
  return f && isNum(f.v) && top && isNum(ratio) ? { unit, f, ft, ratio, topMv: effPointMv(draft, unit, top) } : null;
}
/** The "OC offset" of a unit as the number XTU shows (target - fused V, mV), or null when it does not apply. */
export function ocOffsetOf(model, draft, id) {
  const unit = model.units[id];
  const c = unit && unit.kind !== "R" ? ocOffUnit(model, draft, unit) : null;
  const vt = c ? effVt(draft, unit) : null;
  return c && isNum(vt) ? Math.round((vt - c.f.v) * 1000) : null;
}
/**
 * x mV above the fused top voltage as the adaptive target (target = fused V + x, exact). No clamp: a target below the top point's effective voltage is lifted by the CPU
 * [MEASURED lnx 2026-10-11/13], which the prediction shows (clampedBy). -> {ok, draft} | refusal.
 */
export function editOcOffset(model, draft, ids, x) {
  if (!isNum(x)) return refusal(REASON.notNumber, { value: String(x) });
  const us = peIds(model, ids).map((id) => [id, ocOffUnit(model, draft, model.units[id])]).filter(([, c]) => c);
  if (!us.length) return refusal(REASON.targetNeedsOcPoint, { value: x });
  let next = draft;
  for (const [id, c] of us) {
    const r = editOcRatio(model, next, [id], c.ratio);
    if (!r.ok) return r;
    const v = editVt(model, r.draft, [id], c.f.v + x / 1000, { snap: false });
    if (!v.ok) return v;
    next = v.draft;
  }
  return ok(next);
}

/** Busy-core count of turbo bucket i of a kind (the read's counts, else i + 1). */
const busyOf = (model, kind, i) => (model.turbo && model.turbo[kind] && Array.isArray(model.turbo[kind].counts) && isNum(model.turbo[kind].counts[i]) ? model.turbo[kind].counts[i] : i + 1);
/**
 * Turbo bucket i of a kind. The table stays non-increasing with the active-core count (D-053 item 5): a value above the bucket to its left is refused (refused.turbo_rise), and
 * lowering a bucket brings the buckets to its right down with it (`moved` lists them, so a view can show the link). -> {ok, draft, moved: [indices]} | refusal.
 */
export function editBucket(model, draft, kind, i, value) {
  const cur = turboCur(model, kind);
  if (!cur) return refusal(REASON.noRead);
  if (!Number.isInteger(i) || i < 0 || i >= cur.length) return refusal(REASON.noSuchPoint, { bucket: i });
  if (!isNum(value) || !Number.isInteger(value)) return refusal(REASON.notNumber, { value: String(value) });
  const lim = limitsFor(model, kind);
  const eff = turboEff(model, draft, kind).slice();
  const floor = turboFloor(model, kind) ?? 1;
  if (value < floor) return refusal(REASON.belowFloor, { value, min: floor, unit: "×" });
  if (i === 0 && value > cur[0] && !lim.ratio) return refusal(REASON.noRead, { value }); // no ceiling stated = no raise above what was read (G-133)
  if (i === 0 && lim.ratio && value > lim.ratio.max) return refusal(REASON.aboveLimit, { value, max: lim.ratio.max, unit: "×", source: lim.ratio.source });
  if (i > 0 && value > eff[i - 1]) return refusal(REASON.turboRise, { value, n: busyOf(model, kind, i), prev: busyOf(model, kind, i - 1), prevRatio: eff[i - 1] });
  eff[i] = value;
  const moved = [];
  for (let j = i + 1; j < eff.length; j++) {
    if (eff[j] > value) {
      eff[j] = value;
      moved.push(j);
    }
  }
  const next = clone(draft);
  if (eff.every((x, j) => x === cur[j])) delete next.turbo[kind];
  else next.turbo[kind] = eff;
  return ok(next, { moved });
}

// ---- editing: the pre-R-B4 API (a draft back; a refused edit leaves the draft as it was) -----------------------------------------------------------
const LEGACY = { allowPositive: true };
const perUnit = (model, draft, ids, fn) => liveIds(model, ids).reduce((d, id) => {
  const r = fn(d, [id]);
  return r.ok ? r.draft : d;
}, draft);
/** Deprecated: editCurve. Unit by unit (a unit whose kind refuses is left alone); positive offsets pass where the CPU ceiling was read. */
export const setCurve = (model, draft, ids, mv) => perUnit(model, draft, ids, (d, one) => editCurve(model, d, one, mv, LEGACY));
/** Deprecated: editPoint. */
export const setPoint = (model, draft, ids, ratio, mv) => perUnit(model, draft, unitsWithPoint(model, liveIds(model, ids), ratio), (d, one) => editPoint(model, d, one, ratio, mv, LEGACY));
/** Deprecated: editRingPoint (the old draft back on a refusal, as before). */
export function setRingPoint(model, draft, no, mv) {
  const r = editRingPoint(model, draft, no, mv, LEGACY);
  return r.ok ? r.draft : draft;
}
/** Deprecated: editVt. */
export function setVt(model, draft, ids, volts, opts = {}) {
  const r = editVt(model, draft, ids, volts, opts);
  return r.ok ? r.draft : draft;
}
/** Deprecated: editOcRatio, unit by unit (a ratio outside one unit's window leaves that unit alone, as before). */
export const setOcRatio = (model, draft, ids, ratio) => perUnit(model, draft, ids, (d, one) => editOcRatio(model, d, one, ratio));
/** Deprecated: editBucket (a refused value leaves the table as it was; it is no longer clamped). */
export function setBucket(model, draft, kind, i, value) {
  const r = editBucket(model, draft, kind, i, isNum(value) ? Math.round(value) : value);
  return r.ok ? r.draft : draft;
}
/**
 * Deprecated (G-150): x (mV above the fused top voltage) or null = "same voltage as the top point". A value below the top point's effective offset is raised to it (the old
 * behaviour; editOcOffset leaves that to the CPU and the prediction). Units with no OC ratio above the fused top are skipped.
 */
export function setOcOffset(model, draft, ids, x) {
  let next = draft;
  for (const id of liveIds(model, ids)) {
    const unit = model.units[id];
    const c = unit.kind === "R" ? null : ocOffUnit(model, next, unit);
    if (!c) continue;
    const read = ocClass(unit, curRatio(unit)) === "oc";
    if (x === null && !read) {
      next = clearOcEdits(model, next, [id]);
    } else {
      const top = isNum(c.topMv) ? c.topMv : 0;
      next = setOcRatio(model, next, [id], c.ratio);
      next = setVt(model, next, [id], c.f.v + Math.max(x === null ? top : x, top) / 1000, { snap: false });
    }
  }
  return next;
}

/** G-208: back to what was read for the OC ratio AND its target of these units (a target with no OC ratio is not retained, D-035, so one is never left behind). */
export function clearOcEdits(model, draft, ids) {
  const next = clone(draft);
  for (const id of liveIds(model, ids)) {
    const d = next.units[id];
    if (!d) continue;
    delete d.ratio;
    delete d.restate;
    delete d.vt;
    delete d.vtAuto;
    tidy(next, id);
  }
  return next;
}

/**
 * G-239: an OC ratio that was not completed. The OC word (0x11) of a P-core says R, but its own maximum ratio (0x1C[7:0], read with the unit as `unit.favored`) is lower: the apply that set the
 * word stopped before 0x1D / 0x27 [MEASURED lnx 2026-10-19: word 0x0005b43a = 58x, 0x1C[7:0] = 57]. P-cores only: an E cluster's 0x1C[7:0] is not in the model (E follows 0x650).
 */
export function ocIncomplete(unit) {
  const r = curRatio(unit);
  return !!unit && unit.kind === "P" && isNum(r) && isNum(unit.favored) && r > unit.favored;
}

/**
 * G-239: "Complete the OC ratio" for the incomplete units of `ids`: the draft carries the ratio that is already in force (`ratio` = the read OC ratio, `restate: true`), which setOcRatio
 * would drop as "equal to what was read". The intent then names the ratio, so the planner restates it with 0x1D and 0x27; one change per unit in the pending bar. Nothing else is edited.
 */
export function completeOcRatio(model, draft, ids) {
  const next = clone(draft);
  for (const id of liveIds(model, ids)) {
    const unit = model.units[id];
    if (!ocIncomplete(unit)) continue;
    const d = ensure(next, id);
    d.ratio = curRatio(unit);
    d.restate = true;
  }
  return next;
}

export function discardUnits(draft, ids) {
  const next = clone(draft);
  for (const id of ids) delete next.units[id];
  return next;
}
export function discardTurbo(draft, kind) {
  const next = clone(draft);
  delete next.turbo[kind];
  return next;
}

// ---- a kept draft over a new read ------------------------------------------------------------------------------------------------------------
/**
 * Re-diff a draft against a NEW model (after a re-read or an apply): every edit the CPU now holds is dropped, edits on units / points the new read lacks are dropped, a ratio that left
 * its window and an automatic target are re-derived. -> {draft, dropped: [{unit, field, key, reason}]}; reason "equal_to_read" | "no_such_unit" | "no_such_point" | a refusal key.
 * The whole-curve layer is compared with the new read's own P2 = 0 offset, so it never "vanishes": after an apply it is in the read and leaves the draft as equal.
 */
export function rebaseDraft(model, draft) {
  const next = emptyDraft();
  const dropped = [];
  const drop = (unit, field, key, reason) => dropped.push({ unit, field, key, reason });
  for (const [id, d] of Object.entries(draft.units)) {
    const unit = model.units[id];
    if (!unit) {
      drop(id, "unit", null, "no_such_unit");
      continue;
    }
    const n = { pts: {} };
    if (isNum(d.curveMv)) {
      if (unit.kind !== "R" && isNum(curCurveMv(unit)) && sameMv(curCurveMv(unit), d.curveMv)) drop(id, "curve", null, "equal_to_read");
      else n.curveMv = d.curveMv;
    }
    for (const [k, v] of Object.entries(d.pts)) {
      const p = unit.kind === "R" ? ringPoint(unit, Number(k)) : pointAt(unit, Number(k));
      if (!p) drop(id, unit.kind === "R" ? "ring-point" : "point", Number(k), "no_such_point");
      else if (sameMv(p.offset_mv, v)) drop(id, unit.kind === "R" ? "ring-point" : "point", Number(k), "equal_to_read");
      else n.pts[k] = v;
    }
    if (d.ratio !== undefined) {
      const bad = ratioRefusal(model, unit, d.ratio);
      if (d.restate && ocIncomplete(unit) && curRatio(unit) === d.ratio) Object.assign(n, { ratio: d.ratio, restate: true });
      else if (curRatio(unit) === d.ratio) drop(id, "ratio", null, "equal_to_read");
      else if (bad) drop(id, "ratio", null, bad.reason);
      else n.ratio = d.ratio;
    }
    if (d.vt !== undefined && !d.vtAuto) {
      if (sameV(curVt(unit), d.vt)) drop(id, "vt", null, "equal_to_read");
      else n.vt = d.vt;
    }
    const tmp = { units: { [id]: n }, turbo: {} };
    if (unit.kind !== "R" && n.ratio !== undefined && !n.restate) applyRatio(model, tmp, unit, n.ratio); // re-derives the automatic target from the new fused word
    else if (unit.kind !== "R" && n.vt !== undefined && !hasOcPoint(tmp, unit)) {
      drop(id, "vt", null, REASON.targetNeedsOcPoint);
      delete n.vt;
    }
    if (tmp.units[id]) {
      tidy(tmp, id);
      if (tmp.units[id]) next.units[id] = tmp.units[id];
    }
  }
  for (const [kind, t] of Object.entries(draft.turbo)) {
    const cur = turboCur(model, kind);
    if (!cur) drop("turbo:" + kind, "bucket", null, REASON.noRead);
    else if (t.every((x, j) => x === cur[j])) drop("turbo:" + kind, "bucket", null, "equal_to_read");
    else next.turbo[kind] = t.slice();
  }
  return { draft: next, dropped };
}

/**
 * What in a draft cannot be planned as it is, as refusals [{ok: false, reason, values, unit}]: a whole-curve change and point changes on one unit (the helper's intent carries one
 * offset kind per unit: apply one first), a positive offset (left by the deprecated set* API; D-053 item 5), a target on a unit with no OC point. Empty = plannable.
 */
export function draftProblems(model, draft) {
  const out = [];
  for (const id of model.order) {
    const d = draft.units[id];
    const unit = model.units[id];
    if (!d || !unit) continue;
    if (unit.kind !== "R" && isNum(d.curveMv) && Object.keys(d.pts).length) out.push(refusal(REASON.curveAndPoints, { points: Object.keys(d.pts).length }, { unit: id }));
    const pos = [...(isNum(d.curveMv) ? [d.curveMv] : []), ...Object.values(d.pts)].filter((v) => isNum(v) && v > 0);
    if (pos.length) out.push(refusal(REASON.positive, { value: Math.max(...pos) }, { unit: id }));
    if (unit.kind !== "R" && d.vt !== undefined && !hasOcPoint(draft, unit)) out.push(refusal(REASON.targetNeedsOcPoint, { value: d.vt }, { unit: id }));
  }
  return out;
}

// ---- diff: what is pending ------------------------------------------------------------------------------------------------------------------
/**
 * Pending changes vs the read: {total, unitCount, perUnit: {id: n}, turbo: {P?: n, E?: n}, items: [{unit, field, key, from, to, ...}]}.
 * Counts: the whole-curve offset is one change (field "curve", from = the read P2 = 0 offset), each point one (field "point" / "ring-point"; from/to = the point's OWN offset, and
 * `effective: {from, to}` = whole-curve + point), the OC ratio one, the target one (with `mode`), each changed turbo bucket one. `unitCount` counts units + changed turbo tables.
 */
export function diff(model, draft) {
  const items = [];
  const perUnit = {};
  for (const id of model.order) {
    const d = draft.units[id];
    const unit = model.units[id];
    if (!d) continue;
    if (isNum(d.curveMv)) items.push({ unit: id, field: "curve", key: null, from: curCurveMv(unit), to: d.curveMv });
    for (const key of Object.keys(d.pts).sort((a, b) => a - b)) {
      const p = unit.kind === "R" ? ringPoint(unit, Number(key)) : pointAt(unit, Number(key));
      const item = { unit: id, field: unit.kind === "R" ? "ring-point" : "point", key: Number(key), from: p ? p.offset_mv : null, to: d.pts[key] };
      if (p && unit.kind !== "R") item.effective = { from: readPointMv(unit, p), to: effPointMv(draft, unit, p) };
      items.push(item);
    }
    if (d.ratio !== undefined) items.push({ unit: id, field: "ratio", key: null, from: curRatio(unit), to: d.ratio, ...(d.restate ? { restate: true } : {}) });
    if (d.vt !== undefined) items.push({ unit: id, field: "vt", key: null, from: curVt(unit), to: d.vt, mode: OC_MODE, ...(d.vtAuto ? { auto: true } : {}) });
    perUnit[id] = items.filter((x) => x.unit === id).length;
  }
  const turbo = {};
  for (const kind of ["P", "E"]) {
    const t = draft.turbo[kind];
    const cur = turboCur(model, kind);
    if (!t || !cur) continue;
    t.forEach((v, i) => v !== cur[i] && items.push({ unit: "turbo:" + kind, field: "bucket", key: i, from: cur[i], to: v }));
    turbo[kind] = items.filter((x) => x.unit === "turbo:" + kind).length;
  }
  const total = items.length;
  return { total, unitCount: Object.keys(perUnit).length + Object.keys(turbo).length, perUnit, turbo, items };
}

/** Hints that are not refusals: the editor shows them in place, the plan still decides. {code, hint (lib/hints.js WHY key), unit, text}. */
export function warnings(model, draft) {
  const out = [];
  for (const id of model.order) {
    const unit = model.units[id];
    const d = draft.units[id];
    if (!d || unit.kind === "R") continue;
    const p = unit.kind === "E" ? pointAt(unit, 40) : null;
    if (p) {
      const now = effPointMv(draft, unit, p);
      const was = readPointMv(unit, p);
      if (isNum(now) && !sameMv(now, 0) && !(isNum(was) && sameMv(now, was))) {
        out.push({ code: "E40_OFFSET", hint: "warn.e40", unit: id, text: id + ": an offset on the 40x point (" + fmtMvNum(now) + " mV) caused OCCT errors on one chip [MEASURED lnx 2026-10-02]; a hint from one CPU, not a limit" });
      }
    }
    const c = effCurveMv(draft, unit);
    if (hasOcPoint(draft, unit) && isNum(c) && !sameMv(c, 0) && (isNum(d.curveMv) || d.ratio !== undefined || d.vt !== undefined)) {
      out.push({ code: "CURVE_WITH_OC", hint: "warn.curve_with_oc", unit: id, text: id + ": this unit has an OC point; how a whole-curve offset (" + fmtMvNum(c) + " mV) combines with its target has not been measured" });
    }
  }
  return out;
}
