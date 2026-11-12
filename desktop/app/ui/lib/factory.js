// factory.js (G-250): the factory (offset-free) voltage of every fused point from ANY complete measured curve, stock or tuned:
//
//     factory(n) = measured(n) - (whole-curve offset + point n's offset) / 1000
//
// both offsets read from the V/F words in force while the curve was measured (`tuning_state.words`: per CPU [P2 = 0 word, point 1, point 2, ...]; offset = [31:21] of a word,
// signed 11 bit, 1/1024 V per step; the whole-curve offset is the P2 = 0 word's; a point's own is the word whose [7:0] ratio is the point's [registers.md, MEASURED lnx 2026-10-11/12]).
// This is the JS twin of src/linux_xtu/vfmodel.py derive_factory (same rules, same golden cases: tests/factory-golden.json); change both together.
//
// Rules (the Tune › Cores footnote states them too):
//  - the hardware clamp V(n) >= V(n-1) [MEASURED lnx 2026-10-02]: a point that is not above the last trusted measured point by more than CLAMP_FLAT_V AND carries a deeper effective offset
//    than the point that set that level was probably lifted by the clamp, so measured - offset would be too high there: it is NOT derived but interpolated between trusted neighbours;
//  - the top point takes the CPU's fused 0x09 voltage when known (exact; it also anchors the interpolation); the difference to its derived value is `checkMv`;
//  - OC points are not fused points: the caller passes the unit's fused point ratios only;
//  - a point with no trusted neighbour on one side stays unknown (null), never a flat copy;
//  - src tags: "fused" (0x09), "derived" (measured - offset), "interpolated" (clamped / unmeasured / offset unknown), "baseline" is a marked stock curve (lib: views/tune.js baselineFromRecord).
import { isNum } from "./format.js";

/** A measured point at most this far (V) above the one below it is "flat" (the measurement step). Same value as vfmodel.CLAMP_FLAT_V. */
export const CLAMP_FLAT_V = 0.004;
const OFFSET_EPS_MV = 0.4; // offsets are 1/1024 V steps (~0.98 mV): "deeper" means at least this much below the level-setting point

/** A word ("0x..." string or number) -> {ratio, offsetMv} (the shared V/F word layout), or null when it is not a 32-bit word. */
export function decodeWord(w) {
  const n = typeof w === "string" ? (/^0x[0-9a-fA-F]{1,8}$/.test(w.trim()) ? parseInt(w.trim(), 16) : NaN) : w;
  if (!isNum(n) || n < 0 || n > 0xffffffff) return null;
  let raw = (n >>> 21) & 0x7ff;
  if (raw & 0x400) raw -= 0x800;
  return { ratio: n & 0xff, offsetMv: (raw * 1000) / 1024 };
}

/**
 * One unit. `ratios` = its fused points; `measured` = {ratio: vid_v} (ok points only); `words` = the unit's first CPU's words while measuring (array), or null = a stock curve
 * (offsets 0); `fused` = {ratio, v} of the CPU's 0x09 word | null. -> [{ratio, v | null, src, measuredV, offsetMv, clamped, checkMv}] in ratio order.
 */
export function deriveUnit({ ratios, measured, words, fused = null, flatV = CLAMP_FLAT_V }) {
  const rs = [...new Set(ratios)].sort((a, b) => a - b);
  if (!rs.length) return [];
  const top = rs[rs.length - 1];
  let curveMv = 0;
  const own = new Map();
  if (words) {
    const dec = words.map(decodeWord);
    curveMv = dec[0] ? dec[0].offsetMv : null;
    for (const d of dec.slice(1)) if (d && d.ratio) own.set(d.ratio, d.offsetMv);
  }
  const eff = new Map(rs.map((r) => [r, curveMv === null ? null : !words ? 0 : own.has(r) ? curveMv + own.get(r) : null]));
  const meas = (r) => (isNum(measured[r]) ? measured[r] : null);
  const trusted = new Map();
  const clamped = new Set();
  let levelV = null;
  let levelOff = 0;
  for (const r of rs) {
    const m = meas(r);
    const off = eff.get(r);
    if (m === null || off === null) continue;
    if (levelV !== null && m <= levelV + flatV && off < levelOff - OFFSET_EPS_MV) {
      clamped.add(r); // flat while deeper than the level-setting point: the clamp's signature; the level stays
      continue;
    }
    trusted.set(r, m - off / 1000);
    levelV = m;
    levelOff = off;
  }
  const derivedTop = meas(top) !== null && eff.get(top) !== null ? meas(top) - eff.get(top) / 1000 : null;
  const fusedV = fused && fused.ratio === top && isNum(fused.v) ? fused.v : null;
  const known = new Map(trusted);
  if (fusedV !== null) known.set(top, fusedV);
  const line = (r) => {
    const lo = [...known.keys()].filter((k) => k < r).sort((a, b) => b - a)[0];
    const hi = [...known.keys()].filter((k) => k > r).sort((a, b) => a - b)[0];
    if (lo === undefined || hi === undefined) return null;
    return known.get(lo) + ((known.get(hi) - known.get(lo)) * (r - lo)) / (hi - lo);
  };
  return rs.map((r) => {
    const base = { ratio: r, measuredV: meas(r), offsetMv: eff.get(r), clamped: clamped.has(r), checkMv: null };
    if (known.has(r)) {
      const isFused = r === top && fusedV !== null;
      return { ...base, v: known.get(r), src: isFused ? "fused" : "derived", checkMv: isFused && derivedTop !== null ? Math.round((derivedTop - fusedV) * 10000) / 10 || 0 : null };
    }
    const v = line(r);
    return { ...base, v, src: v === null ? "" : "interpolated" };
  });
}

/** Whether a stored curve can give a factory baseline at all: complete, and its tuning state is known (stock = offsets 0; words = the offsets it was measured with). */
export function derivable(rowOrRec) {
  const kind = rowOrRec && rowOrRec.tuning_state && rowOrRec.tuning_state.kind;
  return !!rowOrRec && rowOrRec.complete !== false && (kind === "stock" || kind === "words");
}

/**
 * A curves.get record + the tune model -> {kind: "stock" | "derived", units: {id: [point result]}, fn} or null when the record cannot be derived from (unknown tuning state).
 * `fn(unitId, ratio)` is the predict.js `base` function: {v, src, clamped, offsetMv, measuredV, checkMv} or null. Ring units are skipped (no stock ring curve).
 */
export function deriveFromRecord(rec, model) {
  if (!rec || !model || !rec.units || typeof rec.units !== "object") return null;
  const ts = rec.tuning_state || {};
  if (ts.kind !== "stock" && ts.kind !== "words") return null;
  const units = {};
  for (const id of model.order) {
    const u = model.units[id];
    const ru = rec.units[id];
    if (!u || u.kind === "R" || !ru || !Array.isArray(ru.points)) continue;
    const cpu = Array.isArray(ru.cpus) && isNum(ru.cpus[0]) ? ru.cpus[0] : u.cpu;
    let words = null;
    if (ts.kind === "words") {
      const w = ts.words && ts.words[String(cpu)];
      if (!Array.isArray(w) || !w.length) continue; // no words for this unit's CPU: its offsets are unknown, nothing is claimed
      words = w;
    }
    const measured = {};
    for (const p of ru.points) if (p && p.status === "ok" && isNum(p.ratio) && isNum(p.vid_v)) measured[p.ratio] = p.vid_v;
    units[id] = deriveUnit({ ratios: u.points.map((p) => p.ratio), measured, words, fused: u.fused });
  }
  const fn = (unitId, ratio) => {
    const p = (units[unitId] || []).find((q) => q.ratio === ratio);
    return p && isNum(p.v) ? { v: p.v, src: p.src, clamped: p.clamped, offsetMv: p.offsetMv, measuredV: p.measuredV, checkMv: p.checkMv } : null;
  };
  return { kind: ts.kind === "stock" ? "stock" : "derived", units, fn };
}

/** The top-point self-check of a derived unit: {ratio, derived (V from measured - offset), fused (V), mv (derived - fused), clamped} or null (no fused voltage / nothing measured at the top). */
export function topCheck(points, fused) {
  const t = points && points.length ? points[points.length - 1] : null;
  if (!t || !fused || fused.ratio !== t.ratio || !isNum(fused.v) || !isNum(t.measuredV) || !isNum(t.offsetMv)) return null;
  const derived = t.measuredV - t.offsetMv / 1000;
  return { ratio: t.ratio, derived, fused: fused.v, mv: Math.round((derived - fused.v) * 10000) / 10 || 0, clamped: t.clamped };
}
