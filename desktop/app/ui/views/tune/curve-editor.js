// views/tune/curve-editor.js: the V/F section of the Tune › Cores inspector (desktop/DESIGN.md §9.2): the "V/F POINTS" band with the whole-curve offset as its
// own field and layer, the point table (Pt · Ratio · Factory V · Offset mV · Now V · After V · Δ mV) and the V/F plot drawn by the shared plot core.
// The voltage model is lib/draft.js + lib/predict.js (R-B4): the whole-curve offset ADDS to the point offsets (curveLayerValue edits the layer, `total` is the
// effective offset); every edit goes through an edit* function that answers {ok:false, reason} instead of clamping, and a refusal is shown in place, in the
// field, with the reason from lib/hints.js WHY (components/field.js `allow`). Predictions that rest on unmeasured behaviour carry their flag (never a confident
// number). `curveRows()` and `plotModel()` are pure (node-tested); the DOM only shows them. Register facts: docs/knowledge/registers.md (V/F data word).
import { h, clear, nextId } from "../../components/dom.js";
import { createField, formatNumber } from "../../components/field.js";
import { createPlot } from "../../components/plot.js";
import { why, setWhy, createQ, label } from "../../components/help.js";
import { button, setButton } from "../../components/buttons.js";
import { isNum, fmtMvNum, TIMES } from "../../lib/format.js";
import { aggregate, sameMv, sameV, snapOffsetMv, pointAt, ringPoint, fusedTopOf } from "../../lib/units.js";
import { emptyDraft, curveLayerValue, pointValue, ringValue, editCurve, editPoint, editRingPoint, discardUnits, warnings, draftProblems } from "../../lib/draft.js";
import { predictUnit, predictedAt, ocPointPrediction, voltageDetail, NOT_MEASURED } from "../../lib/predict.js";
import { limitsFor } from "../../lib/limits.js";

export const NO_BASELINE = "no baseline curve (Curves → Measure)";
export const OC_KEY = "oc"; // key of the OC-point row (a string: the other keys are ratios or ring point numbers)
export const LARGE_STEP_MV = 50; // DESIGN §5.2: a typed step above this keeps the value and warns (warn.large_step)
const KIND_PLURAL = { P: "P-cores", E: "E-clusters", R: "ring" };

// ---- pure: locks, ranges, layers, rows --------------------------------------------------------------------------------------------------------
/** Why the offset fields of a section are locked, as a WHY template {key, vars}, or null. Said once per section, never per row. */
export function sectionLock(model, kind, uvp = "unknown") {
  if (kind === "R" && !model.features.ring) return { key: "locked.ring_unsupported", vars: {} };
  const l = limitsFor(model, kind);
  if (!l.known || !l.offset) return { key: "locked.no_read", vars: {} };
  if (uvp === "on" || model.uvp === "on") return { key: "locked.uvp", vars: {} };
  return null;
}

/** The offered offset range of a kind for the band meta ("−1000…0"): the CPU's field floor to 0, positive offsets are not offered (D-053 §5). "" = unknown. */
export function offsetRange(model, kind) {
  const w = limitsFor(model, kind).offset;
  return w ? formatNumber(w.min) + "…0" : "";
}

/** The whole-curve LAYER of a section (the band field: the P2 = 0 word's offset, R-B4), as edited or as read. The ring has no such layer (D-045). */
export function sectionCurve(model, draft, section, eff = true) {
  if (section.kind === "R") return { state: "none" };
  return curveLayerValue(model, draft, section.ids, eff);
}

const none = { state: "none" };
const firstOf = (xs) => xs.find(Boolean) || null;

/** The OC-point row of a P/E section from lib/predict.js ocPointPrediction (the adaptive target, the only mode), or null when no unit has an OC point (read or drafted). */
function ocRow(model, draft, section, base) {
  const us = section.ids.map((id) => model.units[id]).filter((u) => u && u.kind !== "R");
  const eff = new Map(us.map((u) => [u.id, ocPointPrediction(model, draft, u.id, base)]));
  const read = new Map(us.map((u) => [u.id, ocPointPrediction(model, emptyDraft(), u.id, base)]));
  const used = us.filter((u) => eff.get(u.id) || read.get(u.id));
  if (!used.length) return null;
  const point = Math.max(...used.map((u) => (u.ocPoint && isNum(u.ocPoint.point) ? u.ocPoint.point : u.points.length + 1)));
  const ratio = aggregate(used.map((u) => (eff.get(u.id) || read.get(u.id)).ratio));
  const pending = used.some((u) => {
    const a = eff.get(u.id);
    const b = read.get(u.id);
    return !a || !b || a.ratio !== b.ratio || isNum(a.target) !== isNum(b.target) || (isNum(a.target) && !sameV(a.target, b.target));
  });
  const preds = used.map((u) => eff.get(u.id)).filter(Boolean);
  // the line from the top point to the OC ratio: measured only with the top point at offset 0 (lib/predict.js voltageDetail flags the ratios in between)
  const interp = used.some((u) => {
    const p = eff.get(u.id);
    const ft = fusedTopOf(u);
    return !!p && isNum(ft) && p.ratio > ft + 1 && voltageDetail(model, draft, u.id, ft + 0.5, base).notMeasured.includes(NOT_MEASURED.interpStart);
  });
  const label = "Point " + point + " · " + (ratio.state === "same" ? ratio.value + TIMES : "mixed ratios");
  return {
    key: OC_KEY,
    oc: true,
    ratio: ratio.state === "same" ? ratio.value : null,
    point,
    label,
    ids: used.map((u) => u.id),
    shared: used.length === section.ids.length,
    agg: none, // the OC point takes no offset here: only the adaptive target is offered (D-053 §6)
    readAgg: none,
    total: none,
    readTotal: none,
    pending,
    baseV: none, // an OC point has no factory voltage
    baseSrc: "oc",
    target: aggregate(preds.map((p) => p.target), sameV),
    auto: preds.some((p) => p.auto),
    pred: aggregate(preds.map((p) => p.v), sameV),
    readback: aggregate(used.map((u) => (read.get(u.id) ? read.get(u.id).v : null)), sameV),
    clampedBy: (firstOf(preds.filter((p) => p.clampedBy)) || {}).clampedBy || null,
    notMeasured: [...new Set(preds.flatMap((p) => p.notMeasured))],
    interpNotMeasured: interp,
    ocSlot: false,
    why: "",
  };
}

/**
 * Rows of a section's table. Each: {key (ratio | ring point no | OC_KEY), ratio, point, label, ids, shared, agg (the POINT layer: what the field edits), readAgg,
 * total (effective offset = whole curve + point), readTotal, pending, baseV (factory V), baseSrc, pred (After V), readback (Now V), clampedBy, ocSlot, why}.
 * The OC-point row (P/E, last, `oc: true`) adds {target, auto, notMeasured}. Aggregates: {state none|same|mixed}; `why` = why a voltage is n/a.
 */
export function curveRows(model, draft, section, base, baseReason = NO_BASELINE) {
  const rows = [];
  if (section.kind === "R") {
    const u = model.units[section.ids[0]];
    for (const no of section.points) {
      const p = ringPoint(u, no);
      const v = ringValue(model, draft, no, true);
      const r = ringValue(model, draft, no, false);
      rows.push({
        key: no, ratio: p.ratio, point: no, label: "Point " + no + (isNum(p.ratio) ? " · " + p.ratio + TIMES : ""), ids: section.ids, shared: true,
        agg: v.agg, readAgg: r.agg, total: v.total, readTotal: r.total, pending: v.pending, baseV: none, baseSrc: "", pred: none, readback: none, clampedBy: null,
        ocSlot: p.ocSlot === true, why: "the ring has no stock V/F baseline",
      });
    }
    return rows;
  }
  const preds = Object.fromEntries(section.ids.map((id) => [id, predictUnit(model, draft, id, base)]));
  const reads = Object.fromEntries(section.ids.map((id) => [id, predictUnit(model, emptyDraft(), id, base)]));
  for (const ratio of section.ratios) {
    const v = pointValue(model, draft, section.ids, ratio, true);
    const r = pointValue(model, draft, section.ids, ratio, false);
    const ids = v.ids;
    const ps = ids.map((id) => predictedAt(preds[id], ratio)).filter(Boolean);
    const rs = ids.map((id) => predictedAt(reads[id], ratio)).filter(Boolean);
    const p0 = pointAt(model.units[ids[0]], ratio);
    rows.push({
      key: ratio,
      ratio,
      point: p0.point,
      label: "Point " + p0.point + " · " + ratio + TIMES,
      ids,
      shared: ids.length === section.ids.length,
      agg: v.agg,
      readAgg: r.agg,
      total: v.total,
      readTotal: r.total,
      pending: v.pending,
      baseV: aggregate(ps.map((p) => p.base), sameV),
      baseSrc: (ps.find((p) => p.src) || {}).src || "",
      baseTip: baseTip(ps.find((p) => p.src) || null),
      pred: aggregate(ps.map((p) => p.v), sameV),
      readback: aggregate(rs.map((p) => p.v), sameV),
      clampedBy: (firstOf(ps.filter((p) => p.clampedBy)) || {}).clampedBy || null,
      ocSlot: false,
      why: base ? "the baseline curve has no usable voltage at this ratio" : baseReason,
    });
  }
  const oc = ocRow(model, draft, section, base);
  if (oc) rows.push(oc);
  return rows;
}

/** Δ of a row in mV: After − Now from the voltages when both are known, else the change of the effective offset; null = not applicable. */
export function rowDelta(r) {
  if (r.pred.state === "same" && r.readback.state === "same") return Math.round((r.pred.value - r.readback.value) * 10000) / 10;
  if (r.total.state === "same" && r.readTotal.state === "same") return r.total.value - r.readTotal.value;
  return null;
}

/** The one-line "nearest step" note (QA-04): the CPU holds offsets in 1/1024 V steps, so the first drafted offset that is not on a step is shown as the step it becomes. "" = none. */
export function stepNote(draft, ids) {
  for (const id of ids) {
    const d = draft.units[id];
    if (!d) continue;
    for (const typed of [...(isNum(d.curveMv) ? [d.curveMv] : []), ...Object.values(d.pts)]) {
      const held = snapOffsetMv(typed);
      if (isNum(typed) && Math.abs(held - typed) >= 0.05) return "The CPU holds offsets in 1/1024 V steps: " + fmtMvNum(typed) + " mV is held as " + fmtMvNum(held) + " mV.";
    }
  }
  return "";
}

/** Display text of an offset (mV): whole, or one decimal when the CPU's 1/1024 V word is not whole (DESIGN §3.5); "" for no value. */
export const mvText = (v) => (isNum(v) ? fmtMvNum(v) : "");
/** G-250: where a factory voltage comes from, for the cell's tooltip ("" = a marked stock curve or nothing to say). */
export function baseTip(p) {
  if (!p || !p.src) return "";
  const i = p.baseInfo || {};
  const mv = (x) => (isNum(x) ? fmtMvNum(x) + " mV" : "?");
  if (p.src === "fused") return "The CPU's own fused top-point voltage (0x09)." + (isNum(i.checkMv) ? " Derived from the curve (measured − offsets) it would be " + (i.checkMv > 0 ? "+" : "") + fmtMvNum(i.checkMv) + " mV off" + (i.clamped ? " (the top point was lifted by the clamp)." : ".") : "");
  if (p.src === "derived") return "Derived: measured " + (isNum(i.measuredV) ? i.measuredV.toFixed(3) + " V" : "?") + " minus the offsets it was measured with (" + mv(i.offsetMv) + ").";
  if (p.src === "interpolated") return i.clamped ? "Interpolated between trusted points: the hardware clamp V(n) ≥ V(n−1) held this point up when it was measured, so measured − offset would be too high." : "Interpolated between neighbouring points of the baseline curve.";
  return "";
}
const vText = (a) => (a.state === "same" ? a.value.toFixed(3) : a.state === "mixed" ? a.min.toFixed(3) + "…" + a.max.toFixed(3) : null);
const mvAggText = (a) => (a.state === "same" ? mvText(a.value) : a.state === "mixed" ? mvText(a.min) + "…" + mvText(a.max) : null);

/**
 * The plot of ONE unit's rows (a multi-unit section plots its first unit and says so): {mode "volt" | "mv", x {min, max, ticks}, y {min, max, title},
 * traces, markers, cursorXs, at(ratio) -> row}. Volts when two or more points have a factory, now and after voltage; else the effective offsets in mV
 * (factory = 0). The segment from the top point to the OC point is drawn as an approximation when the prediction carries a "not measured" flag.
 */
export function plotModel(rows) {
  const fused = rows.filter((r) => !r.oc && isNum(r.ratio));
  const oc = rows.find((r) => r.oc && isNum(r.ratio)) || null;
  // volts when at least two points have a factory, a now and an after voltage (a point without one is left out of the lines, never guessed)
  const volt = fused.filter((r) => r.baseV.state === "same" && r.pred.state === "same" && r.readback.state === "same").length >= 2;
  const val = (r, which) => {
    if (volt || r.oc) {
      const a = which === "base" ? r.baseV : which === "now" ? r.readback : r.pred;
      return a.state === "same" ? a.value : null;
    }
    if (which === "base") return 0;
    const a = which === "now" ? r.readTotal : r.total;
    return a.state === "same" ? a.value : null;
  };
  const pending = rows.some((r) => r.pending);
  const pts = (which) => fused.map((r) => [r.ratio, val(r, which)]).filter((p) => isNum(p[1]));
  const traces = [{ kind: "base", pts: pts("base") }, { kind: "meas", pts: pts("now") }];
  if (pending) traces.push({ kind: "set", pts: pts("after") });
  const top = fused[fused.length - 1];
  if (volt && oc && top) {
    const approx = (oc.notMeasured || []).length > 0 || !!oc.interpNotMeasured;
    const seg = (which, kind) => {
      const a = val(top, which);
      const b = val(oc, which);
      if (isNum(a) && isNum(b)) traces.push({ kind, pts: [[top.ratio, a], [oc.ratio, b]], approx });
    };
    if (oc.readback.state === "same") seg("now", "meas");
    if (pending && oc.pred.state === "same") seg("after", "set");
  }
  const markers = [];
  for (const r of volt && oc ? [...fused, oc] : fused) {
    const y = val(r, pending ? "after" : "now") ?? val(r, "now");
    if (isNum(y)) markers.push({ x: r.ratio, y, kind: r.pending ? "set" : "meas" });
  }
  const ys = [...traces.flatMap((t) => t.pts.map((p) => p[1])), ...markers.map((m) => m.y)].filter(isNum);
  const ratios = [...fused.map((r) => r.ratio), ...(volt && oc ? [oc.ratio] : [])];
  const xmax = Math.max(10, Math.ceil((Math.max(...ratios, 1) + 1) / 10) * 10);
  let y;
  if (volt) {
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    y = { min: Math.floor((lo - 0.04) * 10) / 10, max: Math.ceil((hi + 0.02) * 10) / 10, title: "V" };
  } else {
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    y = { min: Math.min(-50, Math.floor((lo - 10) / 25) * 25), max: Math.max(10, Math.ceil((hi + 5) / 25) * 25), title: "mV" };
  }
  const ticks = [];
  for (let t = 10; t <= xmax; t += 10) ticks.push(t);
  const byRatio = new Map(rows.filter((r) => isNum(r.ratio)).map((r) => [r.ratio, r]));
  if (oc && volt) byRatio.set(oc.ratio, oc);
  return { mode: volt ? "volt" : "mv", x: { min: 0, max: xmax, ticks }, y, traces, markers, cursorXs: ratios, at: (ratio) => byRatio.get(ratio) || null, pending, approx: traces.some((t) => t.approx) };
}

/** The pinned readout of the plot at a ratio: "48×  factory 1.042  now 1.032  after 1.012 V" (volts) or the offsets in mV. */
export function readoutParts(pm, ratio) {
  const r = pm.at(ratio);
  if (!r) return [];
  if (pm.mode === "volt" || r.oc) {
    const out = [ratio + TIMES + (r.oc ? " OC" : "")];
    if (!r.oc) out.push(["factory", vText(r.baseV) ?? "n/a"]);
    out.push(["now", vText(r.readback) ?? "—"]);
    out.push(["after", vText(r.pred) ?? "—", "V"]);
    return out;
  }
  return [ratio + TIMES, ["now", mvAggText(r.readTotal) ?? "—"], ["after", mvAggText(r.total) ?? "—", "mV"]];
}

// ---- refusals as why lines --------------------------------------------------------------------------------------------------------------------
/** A WHY template's vars for display: numbers with U+2212 and the decimals of their unit (V 3, others as they are). */
export function whyVars(values = {}) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (!isNum(v)) out[k] = v;
    else if (values.unit === "V" && (k === "value" || k === "min" || k === "max")) out[k] = formatNumber(v, 3);
    else out[k] = formatNumber(v, Number.isInteger(v) ? 0 : 1);
  }
  return out;
}
export const refusalWhy = (r) => ({ key: r.reason, vars: whyVars(r.values) });

/**
 * A numeric field on components/field.js whose every commit is planned by the voltage model: `plan(v)` -> null (no change), {ok: true, draft} or a refusal
 * {ok: false, reason, values}; a refusal is shown in the field (typed text kept, nothing changes). `show(v)` formats the value the field holds (offsets: whole,
 * or one decimal for a 1/1024 V read). paint({state, value, placeholder, describedBy}) syncs it with the model only when something changed, so a refusal or
 * a warning stays until the operator acts. Returns {field, el, whyEl, input, paint(), focus()}.
 */
export function createPlannedField({ label: aria, hint, term, unit = "", width = 6, decimals = 0, step = 1, bigStep, placeholder = "", show, plan, commit, warn = null, dataset = {} }) {
  let lastKey = null;
  let lastWarn = null;
  const f = createField({
    label: aria, hint, unit, width, decimals, step, bigStep, placeholder,
    allow: (v) => {
      const r = plan(v);
      return r && r.ok === false ? refusalWhy(r) : null;
    },
    warn: warn
      ? (v, prev) => {
          const w = warn(v, prev);
          lastWarn = w ? { value: v, w } : null;
          return w;
        }
      : null,
    onCommit: (v) => {
      const r = plan(v);
      if (r && r.ok) commit(r.draft);
      fix();
    },
  });
  if (term) f.el.dataset.hintTerm = term;
  for (const [k, v] of Object.entries(dataset)) f.el.dataset[k] = v;
  const own = f.whyEl.id;
  const focused = () => f.input.ownerDocument.activeElement === f.input;
  const fix = () => {
    if (!f.refused() && f.state() !== "mixed") f.input.value = show(f.value());
  };
  // the component formats with fixed decimals; the display follows DESIGN §3.5 (whole, or one decimal) once a key or a change settles
  f.input.addEventListener("keydown", (e) => {
    if (["Enter", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Escape"].includes(e.key)) fix();
  });
  f.input.addEventListener("change", fix);
  f.input.addEventListener("blur", fix);
  const api = {
    field: f,
    el: f.el,
    whyEl: f.whyEl,
    input: f.input,
    /** state: idle | set | mixed | disabled | reading; describedBy: the id of a why line said once elsewhere (a section lock), or null for the field's own. */
    paint({ state = "idle", value = null, placeholder: ph = placeholder, describedBy = null } = {}) {
      f.input.setAttribute("aria-describedby", describedBy || own);
      const key = JSON.stringify([state, value, ph]);
      if (key === lastKey) return;
      lastKey = key;
      if (state === "mixed") {
        f.setState("mixed");
        f.input.placeholder = ph;
        return;
      }
      f.setState(state);
      f.set(value);
      f.input.placeholder = ph;
      if (!focused()) f.input.value = show(value);
      if (lastWarn && lastWarn.value === value && (state === "set" || state === "idle")) setWhy(f.whyEl, lastWarn.w.key, lastWarn.w.vars);
      lastWarn = null;
    },
    focus: () => f.input.focus(),
  };
  return api;
}

/** warn.large_step for an offset field: a typed change of more than 50 mV in one edit (a warning, not a refusal). */
export function largeStep(v, prev) {
  if (!isNum(v) || !isNum(prev) || Math.abs(v - prev) <= LARGE_STEP_MV) return null;
  return { key: "warn.large_step", vars: { value: formatNumber(v - prev, Number.isInteger(v - prev) ? 0 : 1) } };
}

/** The whole mV an offset field commits: no change when the typed value is the value held (within half a mV: the CPU word is 1/1024 V), else whole mV away from it. */
export function plannedMv(v, cur) {
  if (!isNum(v)) return v;
  if (isNum(cur) && Math.abs(v - cur) < 0.5) return null;
  if (Number.isInteger(v)) return v;
  return isNum(cur) && v > cur ? Math.ceil(v) : Math.floor(v);
}

/**
 * Plan a whole-curve edit. A unit with drafted point changes cannot also take a whole-curve change in one apply (lib/intent.js: one offset kind per unit):
 * that is refused here, in the field, before the Review would refuse it (refused.curve_and_points).
 */
export function planCurve(model, draft, ids, mv) {
  const busy = ids.filter((id) => draft.units[id] && Object.keys(draft.units[id].pts).length);
  if (busy.length) return { ok: false, reason: "refused.curve_and_points", values: { points: Object.keys(draft.units[busy[0]].pts).length }, unit: busy[0] };
  return editCurve(model, draft, ids, mv);
}
/** Plan a point edit (the point layer); refused on a unit with a drafted whole-curve change (one offset kind per unit). */
export function planPoint(model, draft, ids, ratio, mv) {
  const busy = ids.filter((id) => draft.units[id] && isNum(draft.units[id].curveMv) && pointAt(model.units[id], ratio));
  if (busy.length) return { ok: false, reason: "refused.curve_and_points", values: { points: 1 }, unit: busy[0] };
  return editPoint(model, draft, ids, ratio, mv);
}

// ---- the section (DOM) ------------------------------------------------------------------------------------------------------------------------
const cellText = (td, text, v = null) => {
  if (td.textContent !== text) td.textContent = text;
  if (v) td.dataset.v = v;
  else td.removeAttribute("data-v");
};
const naCell = (td) => {
  clear(td).append(h("span", { class: "lx-na", text: "n/a" }));
  td.dataset.v = "none";
};

/**
 * The V/F section of one kind for the selected units of that kind. `tc` = the Tune controller; `opts.title` adds the kind to the band caption when the
 * inspector shows several sections; `opts.onCursor(ratio)` is told the ratio of the focused point. Returns {el, update(), dispose(), plot, rows()}.
 */
export function createCurveSection(tc, section, { title = "", lockId = null } = {}) {
  const kind = section.kind;
  const ring = kind === "R";
  const ids = section.ids;
  const one = ids[0];
  const st = () => tc.state();
  const uvp = () => (tc.store.get().uvp || "unknown");
  const lock = () => sectionLock(st().model, kind, uvp());
  const reading = () => st().read.state === "reading";

  // band: caption · whole-curve field (P/E) · ? · end: the offered range · Discard
  const curveCur = () => {
    const a = sectionCurve(st().model, st().draft, section, true);
    return a.state === "same" ? a.value : null;
  };
  const curveField = ring
    ? null
    : createPlannedField({
        label: "Whole-curve offset", hint: "vf.curve.offset", unit: "mV", width: 5, decimals: 1, step: 1, bigStep: 10, show: mvText, dataset: { curve: kind },
        plan: (v) => {
          const mv = plannedMv(v, curveCur());
          return mv === null ? null : planCurve(st().model, st().draft, ids, mv);
        },
        commit: (draft) => tc.edit(() => draft),
        warn: largeStep,
      });
  const q = ring ? null : createQ("vf.curve.offset", { label: "About the whole-curve offset" });
  const range = h("span", { class: "lx-band-m" });
  const discard = button({ level: 0, label: "Discard", hint: "state.discard", attrs: { "data-discard": kind }, onClick: () => tc.edit((m, d) => discardUnits(d, ids)) });
  const bandEl = h(
    "div",
    { class: "lx-band" },
    h("span", { class: "lx-band-t", text: "V/F points" + (title ? " · " + title : "") }),
    ...(ring ? [h("span", { class: "lx-band-m", text: "keyed by point number" })] : [label("vf.curve.offset", { term: "" }), curveField.el, q.button]),
    h("span", { class: "lx-band-end" }, range, discard),
  );
  // the section's why lines: the lock (once), the whole-curve field's own why, its notes, the draft's plan problems
  const lockWhy = why(null, {}, { id: lockId || nextId("lock") });
  const noteWhy = why(null);
  const probWhy = why(null);
  const whys = h("div", { class: "lx-tune-whys", dataset: { whys: kind } }, lockWhy, ...(curveField ? [curveField.whyEl] : []), noteWhy, probWhy);
  if (curveField) for (const ev of ["keydown", "change", "blur"]) curveField.input.addEventListener(ev, () => queueMicrotask(() => {
    if (!curveField.whyEl.hidden) whys.hidden = false;
  }));

  // the table
  const H = (text, unit, cls, hint) => h("th", { class: cls, scope: "col", dataset: hint ? { hint } : {} }, text, unit ? h("span", { class: "lx-hu", text: unit }) : null);
  const thead = h("thead", {}, h("tr", {},
    H("Pt", "", "lx-n"),
    H("Ratio", "", "lx-n"),
    H("Factory", "V", "lx-n", "vf.factory"),
    H("Offset", "mV", "lx-n lx-f", "vf.point.offset"),
    H("Now", "V", "lx-n", "vf.now"),
    h("th", { class: "lx-n", scope: "col", dataset: { hint: "vf.after" } }, "After", h("span", { class: "lx-hu", text: "V" }), h("span", { class: "lx-clamp" })),
    H("Δ", "mV", "lx-n", "vf.delta"),
  ));
  const tbody = h("tbody");
  const table = h("table", { class: ["lx-tbl", "lx-tbl--fill"], dataset: { vfTable: kind }, "aria-label": "V/F points, " + (ring ? "ring" : ids.join(", ")) }, thead, tbody);
  const foot = h("div", { class: "lx-tfoot-note", dataset: { foot: kind } });
  const rowEls = new Map();

  function rowOf(r) {
    const cells = { pt: h("td", { class: "lx-n" }), ratio: h("td", { class: "lx-n" }), base: h("td", { class: "lx-n" }), off: h("td", { class: "lx-f" }), now: h("td", { class: "lx-n" }), after: h("td", { class: "lx-n" }), delta: h("td", { class: "lx-n" }) };
    const clampEl = h("span", { class: "lx-clamp", "aria-hidden": "true" });
    const afterText = h("span");
    cells.after.append(afterText, clampEl);
    let field = null;
    const curOf = () => {
      const row = rowsNow.find((x) => x.key === r.key);
      return row && row.agg.state === "same" ? row.agg.value : null;
    };
    if (!r.oc) {
      field = createPlannedField({
        label: (ring ? "Ring point " + r.point : "Offset at " + r.ratio + TIMES), hint: "vf.point.offset", term: isNum(r.ratio) ? r.ratio + TIMES : "pt" + r.point, unit: "", width: 6, decimals: 1, step: 1, bigStep: 10, show: mvText,
        dataset: { point: String(r.point) },
        plan: (v) => {
          const mv = plannedMv(v, curOf());
          if (mv === null) return null;
          return ring ? editRingPoint(st().model, st().draft, r.key, mv) : planPoint(st().model, st().draft, ids, r.key, mv);
        },
        commit: (draft) => tc.edit(() => draft),
        warn: largeStep,
      });
      field.input.addEventListener("focus", () => setCursor(r.ratio));
      cells.off.append(field.el);
    } else {
      cells.off.append(h("span", { class: "lx-na", text: "—" }));
      cells.off.dataset.v = "none";
    }
    const tagEl = h("span", { class: "lx-tune-ptag", hidden: true });
    cells.pt.append(tagEl, h("span", { dataset: { part: "pt" } }));
    const tr = h("tr", { dataset: { key: String(r.key), ratio: r.ratio ?? "", point: String(r.point), ...(r.oc ? { oc: "true" } : {}) } }, ...Object.values(cells));
    // the row's why line: the field's own (refusal / large step) and the point's flags (E 40×, clamp, OC not measured)
    const flag = why(null);
    const whyTd = h("td", { colspan: "7" }, ...(field ? [field.whyEl] : []), flag);
    const whyTr = h("tr", { class: "lx-why-row", dataset: { whyFor: String(r.key) }, hidden: true }, whyTd);
    const syncWhy = () => {
      const anyShown = (field && !field.whyEl.hidden) || !flag.hidden;
      whyTr.hidden = !anyShown;
      if (field && field.field.refused()) tr.dataset.state = "refused";
      else if (tr.dataset.state === "refused") tr.removeAttribute("data-state");
    };
    if (field) for (const ev of ["keydown", "change", "blur"]) field.input.addEventListener(ev, () => queueMicrotask(syncWhy));
    return { tr, whyTr, cells, afterText, clampEl, field, flag, tagEl, syncWhy };
  }

  // the plot (one unit) + legend
  const pm = { current: null };
  // plot.js reads its x / y objects on every render: the section changes their domain in place before drawing
  const X = { min: 0, max: 60, fmt: (t) => t + TIMES };
  const Y = { min: 0.6, max: 1.5, fmt: (t) => t.toFixed(1), title: "V" };
  const plot = createPlot({
    label: "V/F curve of " + (ring ? "the ring" : one) + ": x is the ratio, to scale",
    height: 220,
    margin: { l: 44, r: 16, t: 18, b: 24 },
    x: X,
    y: Y,
    readout: (x) => (pm.current ? readoutParts(pm.current, x) : []),
  });
  const legend = h("div", { class: ["lx-legend", "lx-legend--pad"], dataset: { legend: kind } });
  const plotBox = h("div", { class: "lx-plotbox", dataset: { plotBox: kind } }, plot.el);
  function setCursor(ratio) {
    if (pm.current && isNum(ratio) && pm.current.cursorXs.includes(ratio)) plot.setCursor(ratio);
  }

  const el = h("section", { class: "lx-tune-sec", dataset: { section: kind }, "aria-label": "V/F points, " + (title || KIND_PLURAL[kind]) }, bandEl, ...(q ? [q.more] : []), whys, table, foot, plotBox, legend);
  let rowsNow = [];

  function paintLegend(p, plotted) {
    clear(legend);
    const sw = (cls, text) => h("span", {}, h("i", { class: cls }), text);
    legend.append(sw("lx-sw lx-sw--base", p.mode === "volt" ? "factory" : "factory (0 mV)"), sw("lx-sw", "now"));
    if (p.pending) legend.append(sw("lx-sw lx-sw--set", "after your edits"));
    if (p.markers.some((k) => k.kind === "set")) legend.append(sw("lx-sw-mk lx-sw-mk--set", "edited point"));
    if (p.approx) legend.append(h("span", { dataset: { part: "approx" } }, h("i", { class: "lx-sw lx-sw--set lx-tune-sw-approx" }), "not measured"));
    legend.append(h("span", { text: p.mode === "volt" ? "x: ratio, to scale" : "y: effective offset, mV · x: ratio, to scale" }));
    if (plotted) legend.append(h("span", { dataset: { part: "plotted" }, text: "curve of " + plotted }));
  }

  function update() {
    const s = st();
    const model = s.model;
    const draft = s.draft;
    const base = tc.baseFn();
    const lk = lock();
    const rd = reading();
    rowsNow = curveRows(model, draft, section, base, tc.baseReason());
    // rows: rebuilt only when the set of keys changes (an OC point appears / goes); fields keep focus otherwise
    if (rowEls.size !== rowsNow.length || !rowsNow.every((r) => rowEls.has(r.key))) {
      clear(tbody);
      rowEls.clear();
      for (const r of rowsNow) {
        const row = rowOf(r);
        rowEls.set(r.key, row);
        tbody.append(row.tr, row.whyTr);
      }
    }
    // band
    if (curveField) {
      const cur = sectionCurve(model, draft, section, true);
      const was = sectionCurve(model, draft, section, false);
      const edited = cur.state !== was.state || (cur.state === "same" ? !sameMv(cur.value, was.value) : cur.state === "mixed" && (!sameMv(cur.min, was.min) || !sameMv(cur.max, was.max)));
      curveField.paint({
        state: rd ? "reading" : lk ? "disabled" : cur.state === "mixed" ? "mixed" : edited ? "set" : "idle",
        value: cur.state === "same" ? cur.value : null,
        placeholder: cur.state === "mixed" ? mvText(cur.min) + "…" + mvText(cur.max) : cur.state === "none" ? "—" : "",
        describedBy: lk && !rd ? lockWhy.id : null,
      });
    }
    range.textContent = "";
    const rg = offsetRange(model, kind);
    if (rg) range.append("offset ", h("span", { class: "lx-mono", text: rg + " mV" }));
    discard.hidden = !ids.some((id) => draft.units[id]);
    setButton(discard, { label: "Discard " + (ids.length === 1 ? (ring ? "ring" : one) : ids.length + " " + KIND_PLURAL[kind]) });
    setWhy(lockWhy, lk && !rd ? lk.key : null, lk ? lk.vars : {});
    // notes: a whole-curve offset on a unit with an OC point (not measured); plan problems of these units (one offset kind per unit)
    const curveOnOc = !ring && ids.some((id) => ((ocPointPrediction(model, draft, id, base) || {}).notMeasured || []).includes("warn.curve_with_oc"));
    setWhy(noteWhy, curveOnOc ? "warn.curve_with_oc" : null);
    const probs = draftProblems(model, draft).filter((p) => ids.includes(p.unit));
    setWhy(probWhy, probs.length ? probs[0].reason : null, probs.length ? whyVars(probs[0].values) : {});
    whys.hidden = [lockWhy, noteWhy, probWhy, ...(curveField ? [curveField.whyEl] : [])].every((w) => w.hidden);
    // rows
    const e40 = kind === "E" && warnings(model, draft).some((w) => w.code === "E40_OFFSET" && ids.includes(w.unit)); // the E 40× point, one chip (lib/draft.js warnings)
    for (const r of rowsNow) {
      const row = rowEls.get(r.key);
      const c = row.cells;
      row.tr.querySelector("[data-part=pt]").textContent = String(r.point);
      row.tagEl.hidden = !(r.oc || r.ocSlot || !r.shared);
      row.tagEl.textContent = r.oc ? "OC " : r.ocSlot ? "OC slot " : !r.shared ? r.ids.length + "/" + ids.length + " " : "";
      cellText(c.ratio, isNum(r.ratio) ? r.ratio + TIMES : "—");
      const bt = vText(r.baseV);
      if (r.oc) cellText(c.base, "—", "none");
      else if (bt === null) naCell(c.base);
      else cellText(c.base, bt, "base");
      if (r.baseTip) c.base.title = r.baseTip;
      else c.base.removeAttribute("title");
      const nt = vText(r.readback);
      if (nt === null) (r.oc ? cellText(c.now, "—", "none") : naCell(c.now));
      else cellText(c.now, nt);
      const notMeasured = r.oc && r.notMeasured && r.notMeasured.length > 0;
      const at = vText(r.pred);
      if (at === null || notMeasured) {
        c.after.dataset.v = "none";
        row.afterText.textContent = at === null ? (r.oc ? "—" : "n/a") : "not measured";
        row.afterText.className = "lx-na";
      } else {
        row.afterText.className = "";
        row.afterText.textContent = at;
        if (r.pending) c.after.dataset.v = "set";
        else c.after.removeAttribute("data-v");
      }
      row.clampEl.textContent = r.clampedBy ? "↑" : "";
      const d = rowDelta(r);
      if (d === null) cellText(c.delta, "—", "none");
      else if (sameMv(d, 0) || Math.abs(d) < 0.05) {
        cellText(c.delta, "·", "none");
      } else cellText(c.delta, mvText(d), "set");
      if (row.field) {
        row.field.paint({
          state: rd ? "reading" : lk ? "disabled" : r.agg.state === "mixed" ? "mixed" : r.pending && !sameAgg(r.agg, r.readAgg) ? "set" : "idle",
          value: r.agg.state === "same" ? r.agg.value : null,
          placeholder: r.agg.state === "mixed" ? mvText(r.agg.min) + "…" + mvText(r.agg.max) : "",
          describedBy: lk && !rd ? lockWhy.id : null,
        });
      }
      if (r.pending) row.tr.dataset.state = "edit";
      else if (row.tr.dataset.state === "edit") row.tr.removeAttribute("data-state");
      // flags: the E 40× point (one chip), the clamp of an edited point, the OC point's unmeasured parts
      let flagKey = null;
      let flagVars = {};
      if (r.pending && !r.oc && r.clampedBy && r.pred.state === "same") {
        flagKey = "warn.clamped";
        flagVars = { ratio: String(r.ratio), volts: r.pred.value.toFixed(3) };
      } else if (e40 && r.ratio === 40) flagKey = "warn.e40";
      setWhy(row.flag, flagKey, flagVars);
      row.syncWhy();
    }
    // footnote: where the Factory column comes from, n/a said once; plus the nearest-step note while an edit is held as a different number than typed (QA-04)
    const bs = tc.state().base || {};
    const bname = bs.state === "ready" ? bs.name : "";
    const step = stepNote(draft, ids);
    foot.textContent = (ring
      ? "Ring: no factory or predicted voltages (no stock ring curve); offsets only."
      : bname && bs.kind === "derived"
        ? "Factory V derived from the curve “" + bname + "” minus the offsets it was measured with (whole-curve + point); the top point is the CPU's own fused voltage, and a point the hardware clamp V(n) ≥ V(n−1) may have lifted is interpolated."
        : bname
          ? "Factory V: the top point from the CPU, the others from “" + bname + "”."
          : "Factory V: the top point from the CPU; the others n/a: " + (tc.baseReason() || NO_BASELINE) + ".") + (step ? " " + step : "");
    // the plot: the first unit of the section
    const own = ids.length > 1 ? curveRows(model, draft, ring ? section : { ...section, ids: [one], ratios: model.units[one].points.map((p) => p.ratio) }, base, tc.baseReason()) : rowsNow;
    const p = plotModel(own);
    pm.current = p;
    plot.el.dataset.mode = p.mode;
    Object.assign(X, { min: p.x.min, max: p.x.max, ticks: p.x.ticks });
    Object.assign(Y, { min: p.y.min, max: p.y.max, title: p.y.title, fmt: (t) => (p.mode === "volt" ? t.toFixed(1) : formatNumber(t)) });
    const cur = plot.cursor();
    plot.draw({ traces: p.traces, markers: p.markers, cursorXs: p.cursorXs });
    if (cur !== null && p.cursorXs.includes(cur)) plot.setCursor(cur);
    paintLegend(p, ids.length > 1 ? one : "");
  }

  return { el, update, dispose: () => plot.dispose(), plot, rows: () => rowsNow, setCursor };
}

/** Pre-R-S1 name, kept for views/tune/ring.js until the Ring & uncore tab drops its ring editor (DESIGN.md §8.1: ring V/F is edited in Cores only). */
export const createCurveEditor = (tc, section) => createCurveSection(tc, section);

const sameAgg = (a, b) => a.state === b.state && (a.state !== "same" || sameMv(a.value, b.value));
