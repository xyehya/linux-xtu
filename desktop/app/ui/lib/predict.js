// predict.js: predicted voltage per V/F point from a baseline voltage + the (drafted) EFFECTIVE offset, with the hardware's V(n) >= V(n-1) clamp (G-207; layers and flags R-B4).
// Ported from web/app.js baseVid / predictUnit / predAt / predFlat (F4, G-133, G-150): web/app.js:2777-2846, 4391-4399.
//
// The tune.read alone knows ONE voltage per unit: the fused top point (0x09 word: ratio + volts). Lower points have no readable voltage, so without a baseline they are `null`
// (never guessed). A baseline is injected: `base(unitId, ratio)` -> {v, src} | null, or {unitId: {ratio: {v, src}}} (e.g. from a measured stock curve, src "baseline").
// G-250: the injected base may also carry {clamped, offsetMv, measuredV, checkMv} and src "fused" / "derived" / "interpolated" (lib/factory.js: measured - offsets from any complete curve).
// Rules:
//  - effective offset of a point = whole-curve layer (P2 = 0 offset) + the point's own offset [MEASURED lnx 2026-10-11/12, platform-arl-s.md §3 "additive"];
//  - V(n) = max(base(n) + offset(n), V(n-1)) [MEASURED lnx 2026-10-02, monotonic clamp]; linear between points [MEASURED lnx 2026-10-02/03/11];
//  - above the top fused point with no OC point: flat at the top point's voltage [MEASURED lnx 2026-10-11, E 47-48x follow 46x];
//  - the OC point (adaptive mode, the only one offered, D-053 item 6) asks for max(target, V(top point)), the top point taken WITH its offset [MEASURED lnx 2026-10-13: a 1.100 V target
//    ran 1.1125 V = point 6 with its offset]; a target typed nowhere is the un-offset fused top voltage (lib/draft.js autoTarget).
// NOT MEASURED, so flagged (`notMeasured`: keys of lib/hints.js WHY) instead of presented as fact (assessment 05 §3.3, §3.6 E2/E5/E6):
//  - "warn.curve_with_oc": whether a whole-curve offset also shifts the OC point's target (this model leaves the target unshifted);
//  - "warn.interp_not_measured": between the top point and the OC ratio the line is assumed to start at the top point's EFFECTIVE voltage; measured only with the top point at offset 0.
import { isNum } from "./format.js";
import { effPointMv, effRatio, effVt, effCurveMv } from "./draft.js";
import { fusedTopOf, ocClass, sameMv } from "./units.js";

export const NOT_MEASURED = Object.freeze({ curveOnOc: "warn.curve_with_oc", interpStart: "warn.interp_not_measured" });

const baseOf = (base, unit, ratio) => {
  const own = typeof base === "function" ? base(unit.id, ratio) : base && base[unit.id] ? base[unit.id][ratio] : null;
  if (own && isNum(own.v)) return { v: own.v, src: own.src || "baseline", clamped: own.clamped === true, offsetMv: isNum(own.offsetMv) ? own.offsetMv : null, measuredV: isNum(own.measuredV) ? own.measuredV : null, checkMv: isNum(own.checkMv) ? own.checkMv : null };
  return unit.fused && unit.fused.ratio === ratio && isNum(unit.fused.v) ? { v: unit.fused.v, src: "fused" } : null; // the fused top stands in where nothing else is known
};

/**
 * Per fused point, lowest ratio first: {ratio, point, base, src, offset (effective mV), want, v, clampedBy: {ratio, point} | null} or {ratio, point, v: null} (no baseline voltage, or a
 * layer unknown). `any` is false when nothing can be predicted. `want` = base + effective offset before the clamp, `v` after it.
 */
export function predictUnit(model, draft, id, base = null) {
  const unit = model.units[id];
  const out = { id, points: [], any: false };
  if (!unit) return out;
  let prev = null;
  for (const p of unit.points.slice().sort((a, b) => a.ratio - b.ratio)) {
    const b = baseOf(base, unit, p.ratio);
    const off = effPointMv(draft, unit, p);
    if (!b || !isNum(off)) {
      out.points.push({ ratio: p.ratio, point: p.point, v: null });
      continue;
    }
    const want = b.v + off / 1000;
    const clamped = prev !== null && want < prev.v - 1e-9;
    out.points.push({ ratio: p.ratio, point: p.point, base: b.v, src: b.src, baseInfo: { clamped: b.clamped === true, offsetMv: b.offsetMv ?? null, measuredV: b.measuredV ?? null, checkMv: b.checkMv ?? null }, offset: off, want, v: clamped ? prev.v : want, clampedBy: clamped ? { ratio: prev.ratio, point: prev.point } : null });
    out.any = true;
    prev = { v: clamped ? prev.v : want, ratio: p.ratio, point: p.point };
  }
  return out;
}

/** Predicted point of `ratio` of a unit, or null. */
export const predictedAt = (pred, ratio) => pred.points.find((q) => q.ratio === ratio) || null;

/**
 * The OC point of a unit as drafted, or null when it has none: {ratio, mode: "adaptive", target (V) | null, auto (the un-offset fused top fill), v (predicted V) | null,
 * clampedBy: {ratio, point} | null (the target is below the top point's effective voltage and is lifted to it), notMeasured: [WHY keys]}.
 */
export function ocPointPrediction(model, draft, id, base = null) {
  const unit = model.units[id];
  if (!unit || unit.kind === "R") return null;
  const r0 = effRatio(draft, unit);
  if (ocClass(unit, r0) !== "oc") return null;
  const t = effVt(draft, unit);
  const target = isNum(t) && t > 0 ? t : null;
  const d = draft.units[id];
  const ft = fusedTopOf(unit);
  const top = predictedAt(predictUnit(model, draft, id, base), ft);
  const notMeasured = [];
  const c = effCurveMv(draft, unit);
  if (isNum(c) && !sameMv(c, 0)) notMeasured.push(NOT_MEASURED.curveOnOc);
  let v = null;
  let clampedBy = null;
  if (target !== null && top && isNum(top.v)) {
    v = Math.max(top.v, target);
    if (top.v > target + 1e-9) clampedBy = { ratio: top.ratio, point: top.point };
  }
  return { ratio: r0, mode: "adaptive", target, auto: !!(d && d.vtAuto), v, clampedBy, notMeasured };
}

/**
 * Effective voltage at any ratio with what of it is not measured: {v | null, notMeasured: [WHY keys], clampedBy}. Linear between predicted points, flat below the first and above the
 * top one with no OC point; with an OC point, linear from the top point to the OC ratio and flat above it.
 */
export function voltageDetail(model, draft, id, ratio, base = null) {
  const unit = model.units[id];
  const out = { v: null, notMeasured: [], clampedBy: null };
  const pred = predictUnit(model, draft, id, base);
  const pts = pred.points.filter((q) => q.v !== null);
  if (!unit || !pts.length) return out;
  const flat = (r) => {
    if (r <= pts[0].ratio) return pts[0].v;
    if (r >= pts[pts.length - 1].ratio) return pts[pts.length - 1].v;
    const i = pts.findIndex((q) => q.ratio >= r);
    const a = pts[i - 1];
    const b = pts[i];
    return a.v + ((b.v - a.v) * (r - a.ratio)) / (b.ratio - a.ratio);
  };
  out.v = flat(ratio);
  const ft = fusedTopOf(unit);
  const oc = ocPointPrediction(model, draft, id, base);
  if (!oc || oc.target === null || !isNum(ft) || ratio <= ft) return out;
  const topPred = predictedAt(pred, ft);
  const top = flat(ft);
  const hi = Math.max(top, oc.target);
  out.notMeasured.push(...oc.notMeasured);
  out.clampedBy = oc.clampedBy;
  if (ratio >= oc.ratio) {
    out.v = hi;
    return out;
  }
  // between the fused top and the OC ratio: linear between the top point and the OC voltage [MEASURED lnx 2026-10-11/12: 47x = midpoint of 46x and the 48x OC point, top at offset 0]
  if (topPred && isNum(topPred.offset) && !sameMv(topPred.offset, 0)) out.notMeasured.push(NOT_MEASURED.interpStart);
  out.v = top + ((hi - top) * (ratio - ft)) / (oc.ratio - ft);
  return out;
}

/** Effective voltage at any ratio (a number, or null with no prediction). voltageDetail says which part of it is not measured. */
export function voltageAt(model, draft, id, ratio, base = null) {
  return voltageDetail(model, draft, id, ratio, base).v;
}
