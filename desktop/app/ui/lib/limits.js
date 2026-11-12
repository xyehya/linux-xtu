// limits.js: the limits of a tune.read result with their sources (G-207, rebuilt on `cpu_limits` in G-217 / D-049).
//
// The only limits are the CPU's own, as the helper reports them in `cpu_limits` (lib/cpulimits.js): the max voltage (OC mailbox 0x28), the OC ratio limit (0x01), the 11-bit offset field.
// A limit the read did not carry is `null` and the control that needs it says "Read CPU state first": a positive offset, a raise of a ratio or a target voltage is disabled with that reason,
// a negative offset stays editable (it cannot exceed any ceiling). Nothing here is invented; there is no operator policy in the GUI.
import { isNum } from "./format.js";
import { READ_FIRST } from "./cpulimits.js";

/** Grid of the UI controls (not hardware limits): mV step of the offset field, V floor and step of the adaptive target (5 mV grid, PLAN §4.2). */
export const GRID = { offsetStep: 5, vtMin: 0.9, vtStep: 0.005 };
export const NO_LIMITS = "The helper did not report the CPU limits (update the helper), so the controls are disabled.";

const SRC = { offset: "CPU (11-bit V/F offset field)", vt: "CPU max voltage (mailbox 0x28)", ratio: "CPU OC ratio limit (mailbox 0x01)" };

/**
 * Everything the editors need to know about the limits of one kind ("P" | "E" | "R"; the ring has its own entry in `cpu_limits`).
 *   known  the read carried `cpu_limits` with the offset field range (false on a helper without them -> editors disabled with NO_LIMITS)
 *   read   the kind's voltage ceiling (0x28) was read: positive offsets and target voltages are allowed
 *   offset {min, max, source, positive: reason | null} | null    the window; `max` is 0 until the ceiling is read
 *   vt {max, source} | null, ratio {max, source} | null           null until read; `vtWhy` / `ratioWhy` say what to do (READ_FIRST)
 */
export function limitsFor(model, kind) {
  const cl = model ? model.cpuLimits : null;
  const k = cl && cl.kinds ? cl.kinds[kind === "R" ? "ring" : kind] || null : null;
  const out = { kind, known: false, read: false, offset: null, vt: null, ratio: null, cpu: k, vtWhy: null, ratioWhy: null, note: null };
  if (!cl || !cl.offsetMv) return out;
  out.known = true;
  const vRead = !!k && isNum(k.maxMv);
  out.read = vRead;
  out.offset = { min: cl.offsetMv[0], max: vRead ? cl.offsetMv[1] : Math.min(cl.offsetMv[1], 0), source: SRC.offset, positive: vRead ? null : READ_FIRST + ": positive offsets need the CPU voltage ceiling (mailbox 0x28)" };
  if (vRead) out.vt = { max: k.maxMv / 1000, source: SRC.vt };
  else out.vtWhy = READ_FIRST + ": the CPU voltage ceiling (mailbox 0x28) has not been read";
  if (k && isNum(k.maxRatio)) out.ratio = { max: k.maxRatio, source: SRC.ratio };
  else out.ratioWhy = READ_FIRST + ": the OC ratio limit (mailbox 0x01) has not been read";
  return out;
}

/** The offset window {min,max,source,positive} of a kind, or null (control disabled). */
export function offsetWindow(model, kind) {
  return limitsFor(model, kind).offset;
}

/**
 * DEPRECATED (R-B4): `mv` rounded to a whole mV and clamped into the window; null when the kind has no window. Kept for old callers only: the editors use
 * checkOffset, which refuses an out-of-window value with a reason instead of moving it (D-053 item 5: "out-of-range typed values refused with the reason").
 */
export function clampOffset(model, kind, mv) {
  const w = offsetWindow(model, kind);
  if (!w || !isNum(mv)) return null;
  return Math.min(Math.max(Math.round(mv), w.min), w.max);
}

// ---- refusals (R-B4) -------------------------------------------------------------------------------------------------------------------------
// Every edit of lib/draft.js answers {ok: true, draft} or a refusal {ok: false, reason, values}: `reason` is a key of WHY in lib/hints.js (the stepper shows its text with `values` filled
// in), never a silently moved number. A few reasons have no WHY entry yet; they are listed in MISSING_HINT_KEYS so a view can fall back to a generic line.
export const REASON = Object.freeze({
  notNumber: "refused.not_a_number",
  belowFloor: "refused.below_floor",
  aboveLimit: "refused.above_limit",
  positive: "refused.positive_offset",
  turboRise: "refused.turbo_rise",
  noRead: "locked.no_read",
  uvp: "locked.uvp",
  curveAndPoints: "refused.curve_and_points",
  ocModeNotOffered: "refused.oc_mode_not_offered",
  targetNeedsOcPoint: "refused.target_needs_oc_point",
  noSuchPoint: "refused.no_such_point",
  ringUnsupported: "locked.ring_unsupported",
});
export const MISSING_HINT_KEYS = Object.freeze([]); // R-S1 added the last five to lib/hints.js WHY

/** A refusal: `values` fill the placeholders of the WHY text ({value}, {min}, {max}, {unit}, {source}, {prev}, {prevRatio}, {n}). */
export const refusal = (reason, values = {}, extra = {}) => ({ ok: false, reason, values, ...extra });

/**
 * An offset typed for a kind -> {ok: true, mv (whole mV)} or a refusal. Order: no window (limits not reported) · not a number · below the field floor · positive (D-053 item 5:
 * positive point/ring offsets are not offered; `allowPositive` exists only for the deprecated set* wrappers) · above the window (the ceiling is unread: locked.no_read).
 * `uvp` true: Undervolt Protection is known to be on, a negative value is refused (locked.uvp, G-240).
 */
export function checkOffset(model, kind, mv, { allowPositive = false, uvp = false } = {}) {
  const w = offsetWindow(model, kind);
  if (!w) return refusal(REASON.noRead);
  if (!isNum(mv)) return refusal(REASON.notNumber, { value: String(mv) });
  const v = Math.round(mv);
  if (v < w.min) return refusal(REASON.belowFloor, { value: v, min: w.min, unit: "mV" });
  if (v > 0 && !allowPositive) return refusal(REASON.positive, { value: v });
  if (v > w.max) return w.positive ? refusal(REASON.noRead, { value: v }) : refusal(REASON.aboveLimit, { value: v, max: w.max, unit: "mV", source: w.source });
  if (v < 0 && uvp) return refusal(REASON.uvp, { value: v });
  return { ok: true, mv: v };
}

/** An adaptive OC-point target (V) -> {ok: true, v} or a refusal: the ceiling is the CPU's 0x28 limit, the floor the control grid's start (GRID.vtMin). */
export function checkVt(model, kind, volts) {
  const w = vtWindow(model, kind);
  if (!w) return refusal(REASON.noRead);
  if (!isNum(volts)) return refusal(REASON.notNumber, { value: String(volts) });
  if (volts < w.min - 1e-9) return refusal(REASON.belowFloor, { value: volts, min: w.min, unit: "V" });
  if (volts > w.max + 1e-9) return refusal(REASON.aboveLimit, { value: volts, max: w.max, unit: "V", source: w.source });
  return { ok: true, v: volts };
}

/** The adaptive-target grid {min,max,step,source} of a kind, or null until the CPU voltage ceiling is read. */
export function vtWindow(model, kind) {
  const v = limitsFor(model, kind).vt;
  return v ? { min: GRID.vtMin, max: v.max, step: GRID.vtStep, source: v.source } : null;
}

/** Snap a voltage onto the 5 mV grid from the floor (D-035: the plan never sends a zero target). */
export function snapGrid(v) {
  return Math.round(GRID.vtMin * 1000 + Math.round((v - GRID.vtMin) / GRID.vtStep) * GRID.vtStep * 1000) / 1000;
}
