// views/curves.js: the Curves screen (desktop/DESIGN.md §9.7): measure V/F curves (vf.measure quick | dense, cancel), keep them (curves.list/get/update/delete)
// and compare them. Work header tabs Chart | Table | Library. Left: MEASURE — the unit table with checkboxes (the checked units are measured AND drawn), the
// resolution, a name, Measure (L3, its duration on the label). Right: the chart on the plot core (x MHz to scale, requested volts or Δ mV; P-cores and
// E-clusters on their channel ramps with direct labels at the line ends; the compared curve dashed grey; diamonds = the fused top point read from the CPU;
// the curve's kind — baseline / stock / tuned / partial / live — said as tags), the table of volts per ratio, or the library. Live points during Measure
// come from the helper's `vf.point` event (wired in the bridge). "Set as baseline" is offered only for complete stock curves (R-36); otherwise it is
// disabled with its reason. Ops: vf.measure, cancel, curves.list, curves.get, curves.update, curves.delete, tune.last (no mailbox traffic).
import { h, clear } from "../components/dom.js";
import { NA } from "../components/fmt.js";
import { createUnitTable, unitsFromTopology } from "../components/unit-table.js";
import { createSegmented } from "../components/segmented.js";
import { createPlot, niceTicks } from "../components/plot.js";
import { panel, box, emptyState, progressRule, setProgress } from "../components/panel.js";
import { button, setButton, confirmInPlace } from "../components/buttons.js";
import { tag } from "../components/ann.js";
import { why, setWhy } from "../components/help.js";
import { EMPTY } from "../lib/hints.js";
import { isNum, fmtMv, MINUS, TIMES, fmtLocalDateTime, fmtLocalStamp } from "../lib/format.js";
import { modelFromRead } from "../lib/units.js";
import { deriveFromRecord, topCheck } from "../lib/factory.js";
import { unitModel, favMark, unitTitle, favoredIds, idsOfKind, opGate, gateWhy, quickButtons, errText, fmtDate } from "./stress.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const setInert = (el, on) => (on ? el.setAttribute("inert", "") : el.removeAttribute("inert"));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const TURBO_OFF_NOTE = "Turbo is off (power-saver profile?): ratios above base cannot be reached — switch to Balanced or Performance";
export const MEASURE_SECONDS = { quick: 120, dense: 600 }; // for the 12 reference units (SPEC-v3 §3): the estimate scales per unit
export const MEASURE_REF_UNITS = 12;
export const MIN_SPAN_V = 0.05; // the voltage axis never spans less than 50 mV (a flat curve is not a cliff)

// ---------------------------------------------------------------- reasons and wording

/** Why a V/F point could not be measured (contract 9 addendum). `p` (optional) is the point record: cap_granularity names the ratios the caps did run (`neighbours`). */
export function reasonText(reason, p) {
  if (reason === "max_turbo") return "the point exists but this core's max turbo ratio is lower, so it never runs here";
  if (reason === "cap_granularity" || reason === "cpufreq_granularity") {
    const n = isObj(p) && Array.isArray(p.neighbours) ? p.neighbours.filter(isNum) : [];
    const at = isObj(p) && isNum(p.ratio) ? `${p.ratio}${TIMES}` : "this ratio";
    if (reason === "cpufreq_granularity") return "cpufreq caps cannot pin this ratio (the cap lands on a neighbour)";
    return `Linux cannot cap this core to exactly ${at} (frequency rounding)${n.length === 2 ? `; the nearest are ${n[0]}${TIMES} and ${n[1]}${TIMES}` : n.length === 1 ? `; the nearest is ${n[0]}${TIMES}` : ""}`;
  }
  if (reason === "active_cores") return "reachable only with few active cores, and the measurement loads the whole unit";
  if (reason === "turbo_off") return "turbo is off (power-saver profile?): ratios above base cannot be reached; switch to Balanced or Performance";
  if (reason === "user_cap") return "your own scaling_max_freq cap is below this ratio, so it was not attempted";
  return "not reachable on this core";
}

/** A point whose voltage is estimated: the straight line between the measured V/F points `from`. */
export function interpText(p) {
  const f = isObj(p) && Array.isArray(p.from) ? p.from.filter(isNum) : [];
  if (isObj(p) && p.exact === true) return `exact: both neighbours equal${f.length === 2 ? ` (${f[0]}${TIMES} and ${f[1]}${TIMES})` : ""}`;
  return `interpolated${f.length === 2 ? ` between ${f[0]}${TIMES} and ${f[1]}${TIMES}` : ""}`;
}

/** The tuning state recorded with a curve: "words" (read this boot), "stock" (every offset 0) or "unknown". */
export function tuningWords(kind) {
  return kind === "words" ? "Tuning at the time: read from the CPU" : kind === "stock" ? "Tuning at the time: stock = fused table as applied (every offset 0)" : "Tuning state unknown (no Read this boot)";
}
export function tuningKind(c) {
  const t = isObj(c) ? c.tuning_state : null;
  if (isObj(t) && isStr(t.kind)) return t.kind;
  if (isStr(t)) return t;
  return isObj(c) && isStr(c.tuning_state_kind) ? c.tuning_state_kind : "unknown";
}
export function unitCount(c) {
  return Array.isArray(c.units) ? c.units.length : isObj(c.units) ? Object.keys(c.units).length : 0;
}
// QA-34: a curve measured without a name is called "Quick 2026-11-12 08:53" (older helpers stamped UTC there). The UI rebuilds that name from the stored UTC
// `created` in local time, and a label for it reads "Quick · Nov 12 10:53" (no second "quick").
const DEFAULT_NAME = /^(Quick|Dense) \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
/** The name the UI shows for a curve: its own name, except a default "Mode date" name, which is shown in local time. */
export function curveName(c) {
  const name = c.name || c.id;
  const m = DEFAULT_NAME.exec(String(name));
  return m && fmtLocalStamp(c.created) ? `${m[1]} ${fmtLocalStamp(c.created)}` : name;
}
export function curveTitle(c) {
  const m = DEFAULT_NAME.exec(String(c.name || ""));
  if (m && fmtLocalDateTime(c.created)) return `${m[1]} · ${fmtLocalDateTime(c.created)}`;
  return `${c.name || c.id} · ${fmtLocalDateTime(c.created) || fmtDate(c.created)} · ${c.mode || "?"}`;
}

// ---------------------------------------------------------------- records

// G-118: a measured point carries fused_point (1-based int, or "oc") when its ratio is one of the unit's fused V/F points; the key is absent for the ratios in between.
export const isFusedPoint = (x) => x === "oc" || (isNum(x) && x >= 1);
export const fusedLabel = (x) => (x === "oc" ? "OC point" : `fused point ${x}`);

/** Measured points of one unit: [{ratio, mhz, v, vmin, vmax, kept, total, status, from, exact, fused}] sorted by frequency; unmeasured / unreachable ones are left out. */
export function recPoints(rec, unit) {
  const u = isObj(rec) && isObj(rec.units) ? rec.units[unit] : null;
  const pts = isObj(u) && Array.isArray(u.points) ? u.points : [];
  return pts
    .filter((p) => isObj(p) && p.status !== "mismatch" && p.status !== "unreachable" && isNum(p.vid_v) && isNum(p.ratio))
    .map((p) => ({ ratio: p.ratio, mhz: isNum(p.mhz) ? p.mhz : p.ratio * 100, v: p.vid_v, vmin: p.vid_min, vmax: p.vid_max, kept: p.kept, total: p.total, status: p.status, from: p.from, exact: p.exact, fused: isFusedPoint(p.fused_point) ? p.fused_point : null }))
    .sort((a, b) => a.mhz - b.mhz);
}
/** G-132 item 8: the chart plots the unit's V/F points only (the fused points and the OC point). A record without any fused_point (an older curve) draws every measured ratio. */
export function recChartPoints(rec, unit) {
  const all = recPoints(rec, unit);
  return all.some((q) => isFusedPoint(q.fused)) ? all.filter((q) => isFusedPoint(q.fused)) : all;
}
export function recAllPoints(rec, unit) {
  const u = isObj(rec) && isObj(rec.units) ? rec.units[unit] : null;
  return isObj(u) && Array.isArray(u.points) ? u.points.filter(isObj) : [];
}
export const sumPoints = (rec) => (isObj(rec) && isObj(rec.units) ? Object.values(rec.units).reduce((n, u) => n + (isObj(u) && Array.isArray(u.points) ? u.points.length : 0), 0) : 0);

/** {v, exact} at `mhz` on points sorted by frequency (a straight line between neighbours; exact within 50 MHz of a point), null outside the measured range. */
export function interpAt(pts, mhz) {
  if (!pts.length || mhz < pts[0].mhz - 1e-6 || mhz > pts[pts.length - 1].mhz + 1e-6) return null;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].mhz - mhz) < 50) return { v: pts[i].v, exact: true };
    if (pts[i].mhz > mhz && i > 0) {
      const a = pts[i - 1];
      const b = pts[i];
      return { v: a.v + ((b.v - a.v) * (mhz - a.mhz)) / (b.mhz - a.mhz), exact: false };
    }
  }
  return null;
}

export const baselineId = (list) => {
  const b = list.find((c) => c.baseline === true);
  return b ? b.id : null;
};
/** The curve shown first (G-123): the newest baseline, else the newest complete curve of every unit, else the newest (the list is newest first). */
export function defaultCurveId(list, ids) {
  const b = baselineId(list);
  if (b) return b;
  const all = list.find((c) => c.complete !== false && Array.isArray(c.units) && ids.length > 0 && ids.every((u) => c.units.includes(u)));
  if (all) return all.id;
  return list.length ? list[0].id : null;
}

// ---- not measured / interpolated captions ----

export function notMeasuredLong(kind, max, p) {
  if (kind === "max_turbo") return `above this core's max ratio${max === null ? "" : ` ${max}${TIMES}`}`;
  if (kind === "mismatch") return "the core ran at another ratio than the target, so no voltage was kept";
  return reasonText(kind, p);
}
export function notMeasuredShort(kind, max) {
  if (kind === "max_turbo") return `above core max${max === null ? "" : ` ${max}${TIMES}`}`;
  if (kind === "cpufreq_granularity" || kind === "cap_granularity") return "cpufreq cannot pin this ratio";
  if (kind === "turbo_off") return "turbo is off";
  if (kind === "user_cap") return "above your cpufreq cap";
  if (kind === "active_cores") return "needs few active cores";
  if (kind === "mismatch") return "did not settle at the target";
  return "not reachable";
}
/** "P1, P2, P4–P7": consecutive units of one kind (three or more) collapse to a range. */
export function unitRanges(units) {
  const parts = [];
  const num = (u) => parseInt(u.replace(/^[A-Z]+/, ""), 10);
  const pre = (u) => u.replace(/[0-9]+$/, "");
  for (let i = 0; i < units.length; ) {
    let j = i;
    while (j + 1 < units.length && pre(units[j + 1]) === pre(units[i]) && num(units[j + 1]) === num(units[j]) + 1) j++;
    if (j - i >= 2) parts.push(`${units[i]}–${units[j]}`);
    else for (let k = i; k <= j; k++) parts.push(units[k]);
    i = j + 1;
  }
  return parts.join(", ");
}
/** "56–57×", "23, 29×" */
export function ratiosText(ratios) {
  const rs = [...new Set(ratios)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < rs.length; ) {
    let j = i;
    while (j + 1 < rs.length && rs[j + 1] === rs[j] + 1) j++;
    parts.push(j > i ? `${rs[i]}–${rs[j]}` : String(rs[i]));
    i = j + 1;
  }
  return `${parts.join(", ")}${TIMES}`;
}

/** Points that exist but were not reached (unreachable) or did not settle (mismatch), for the units drawn: [{unit, ratio, mhz, kind, max, title}]. Never drawn inside the plot. */
export function unmeasuredOf(rec, drawn, ids) {
  const out = [];
  if (!isObj(rec)) return out;
  for (const u of ids) {
    if (!drawn.has(u)) continue;
    const pts = recAllPoints(rec, u);
    const okRatios = pts.filter((p) => p.status === "ok" && isNum(p.ratio)).map((p) => p.ratio);
    const vfOnly = pts.some((p) => isFusedPoint(p.fused_point)); // G-132: only V/F points that have no value at all; in-between ratios live in the Table view
    for (const p of pts) {
      if (!isNum(p.ratio) || (p.status !== "unreachable" && p.status !== "mismatch")) continue;
      if (vfOnly && !isFusedPoint(p.fused_point)) continue;
      const below = okRatios.filter((r) => r < p.ratio);
      const kind = p.status === "mismatch" ? "mismatch" : isStr(p.reason) ? p.reason : "other";
      const max = below.length ? Math.max(...below) : null;
      out.push({ unit: u, ratio: p.ratio, mhz: isNum(p.mhz) ? p.mhz : p.ratio * 100, kind, max, title: `${u} ${p.ratio}${TIMES}: ${notMeasuredLong(kind, max, p)}` });
    }
  }
  return out;
}
/** The caption line: the not-measured points grouped by reason, then by the units sharing the same ratios. */
export function notMeasuredCaption(list, ids) {
  const byWhy = new Map();
  for (const m of list) {
    const why = notMeasuredShort(m.kind, m.max);
    if (!byWhy.has(why)) byWhy.set(why, new Map());
    const units = byWhy.get(why);
    if (!units.has(m.unit)) units.set(m.unit, []);
    units.get(m.unit).push(m.ratio);
  }
  const groups = [];
  for (const [why, units] of byWhy) {
    const bySig = new Map();
    for (const u of ids) {
      if (!units.has(u)) continue;
      const sig = ratiosText(units.get(u));
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(u);
    }
    for (const [sig, us] of bySig) groups.push({ first: ids.indexOf(us[0]), text: `${unitRanges(us)} at ${sig} (${why})` });
  }
  groups.sort((a, b) => a.first - b.first);
  return groups.length ? `not measured: ${groups.map((g) => g.text).join(" · ")}` : "";
}
/** G-132: V/F points drawn as hollow markers because no cap could run them: their voltage is the straight line between the measured V/F points beside them. */
export function interpolatedCaption(rec, drawn, ids) {
  const bySig = new Map();
  for (const u of ids) {
    if (!drawn.has(u)) continue;
    const rs = recAllPoints(rec, u).filter((p) => p.status === "interpolated" && isNum(p.ratio)).map((p) => p.ratio);
    if (!rs.length) continue;
    const sig = ratiosText(rs);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(u);
  }
  return bySig.size ? `interpolated (hollow markers): ${[...bySig].map(([sig, us]) => `${unitRanges(us)} at ${sig}`).join(" · ")}` : "";
}

/** On the baseline, the fused top point (0x09) as a diamond at its voltage. `fusedOf(unit)` -> {ratio, v} | null (from the kept tune read). */
export function curvePins(rec, { drawn, ids, baseline, fusedOf }) {
  const pins = [];
  if (!isObj(rec) || rec.id !== baseline) return pins;
  for (const u of ids) {
    if (!drawn.has(u)) continue;
    const meas = recPoints(rec, u);
    const f = fusedOf(u);
    if (f && meas.length) {
      const top = meas.find((q) => q.ratio === f.ratio);
      pins.push({ unit: u, kind: "fused", mhz: f.ratio * 100, v: f.v, title: `${u} fused top point (cmd 0x09): ${f.v.toFixed(4)} V at ${f.ratio}${TIMES}${top ? `; measured ${top.v.toFixed(4)} V (${fmtMv((top.v - f.v) * 1000)}).` : "; not measured on this curve."}` });
    }
  }
  return pins;
}

/**
 * The chart model: {series: [{key, unit, label, pts: [{mhz, v, fused?, interp?}], dash?, live?, fav?}], markers, band, ymode, empty, pins?, unmeasured?}.
 * s = {a (primary record | null), b (compare record | null), loaded, listLen, drawn, delta, band, live (bool), liveHead, ids, baseline, fusedOf, favored (Set)}
 */
export function curvesModel(s) {
  const { a, b, drawn, ids } = s;
  const model = { series: [], markers: [], band: null, ymode: s.delta ? "mv" : "v", empty: null };
  if (!a) {
    model.empty = !s.loaded ? "Loading stored curves." : s.listLen ? "Loading the selected curve." : "No curve yet. Measure on the left; the chart fills as each point arrives.";
    return model;
  }
  if (s.delta && !b) {
    model.empty = "Choose a curve under Compare to see the difference.";
    return model;
  }
  for (const u of ids) {
    if (!drawn.has(u)) continue;
    const pa = recChartPoints(a, u);
    const label = u + (s.favored && s.favored.has(u) ? " ★" : "");
    const fav = !!s.favored && s.favored.has(u);
    if (s.delta) {
      const pb = recChartPoints(b, u);
      const pts = pa.map((p) => {
        const at = interpAt(pb, p.mhz);
        return at ? { mhz: p.mhz, v: (p.v - at.v) * 1000 } : null;
      }).filter(Boolean);
      if (pts.length) model.series.push({ key: u, unit: u, label, pts, fav });
    } else {
      if (pa.length) model.series.push({ key: u, unit: u, label, fav, pts: pa.map((p) => ({ mhz: p.mhz, v: p.v, fused: p.fused, interp: p.status === "interpolated" ? p : null })), live: s.live === true && s.liveHead === u });
      if (b) {
        const pb = recChartPoints(b, u);
        if (pb.length) model.series.push({ key: `${u}:cmp`, unit: u, label: `${u} (compare)`, pts: pb.map((p) => ({ mhz: p.mhz, v: p.v })), dash: true });
      }
    }
  }
  if (s.band) {
    const solid = model.series.filter((x) => !x.dash);
    const xs = [...new Set(solid.flatMap((x) => x.pts.map((p) => p.mhz)))].sort((x, y) => x - y);
    const band = [];
    for (const x of xs) {
      const vs = solid.map((x2) => interpAt(x2.pts, x)).filter(Boolean).map((r) => r.v);
      if (vs.length > 1) band.push({ mhz: x, lo: Math.min(...vs), hi: Math.max(...vs) });
    }
    model.band = band.length > 1 ? band : null;
  }
  if (!model.series.length) model.empty = drawn.size ? "No measured points for the units drawn." : "No units drawn. Check units in the table on the left.";
  else if (!s.delta) {
    model.pins = curvePins(a, { drawn, ids, baseline: s.baseline, fusedOf: s.fusedOf });
    model.unmeasured = unmeasuredOf(a, drawn, ids);
  }
  return model;
}

/** The notes under the chart: {base, stock: {show, text, title}, unreach}. */
export function curveNotes({ a, list, live, baseline, drawn, ids, wordsRead, topChecks = [] }) {
  const isBase = !!a && a.id === baseline && !live;
  const baseRow = baseline ? list.find((c) => c.id === baseline) || null : null;
  const derivedBase = !!baseRow && tuningKind(baseRow) === "words";
  let base;
  if (isBase && derivedBase) {
    base = "Derived baseline: a tuned curve. Tune's Factory V is this curve minus the offsets it was measured with (whole-curve + point), the top point from the CPU's fused voltage; a point the hardware clamp lifted is interpolated.";
  } else if (isBase) {
    base = `Stock baseline: this curve is the fused V/F table as applied (offsets 0). ${wordsRead ? "Diamonds mark the top-point voltage read from the CPU (cmd 0x09); they should sit on the curve where it reaches that ratio." : "Read (top bar) to draw the top-point voltage from the CPU (cmd 0x09) and cross-check it."}`;
  } else if (baseline && a) base = derivedBase ? `Derived baseline: ${baseRow.name}. Tune takes the offsets it was measured with off its voltages.` : `Stock baseline: ${(baseRow || {}).name}. Predictions in Tune are made on it.`;
  else base = "No curve is marked as the stock baseline yet. Tune derives its Factory V from the newest complete curve minus the offsets it was measured with; mark one in the Library to choose.";
  const isStock = !!a && !live && tuningKind(a) === "stock";
  const checks = (topChecks || []).filter((t) => t && isNum(t.mv));
  return {
    base,
    check: checks.length ? "Top point check (derived − fused 0x09): " + checks.map((t) => `${t.unit} ${t.mv > 0 ? "+" : t.mv < 0 ? MINUS : ""}${Math.abs(t.mv).toFixed(1)} mV${t.clamped ? " (lifted by the clamp)" : ""}`).join(" · ") + "." : "",
    stock: { show: isStock, text: "stock = fused table as applied", title: "Measured with every offset at 0: the voltages are the CPU's fused V/F table as the CPU applies it." },
    unreach: a ? [notMeasuredCaption(unmeasuredOf(a, drawn, ids), ids), interpolatedCaption(a, drawn, ids)].filter(Boolean).join(" · ") : "",
  };
}

// ---------------------------------------------------------------- presets, library, table, measuring

/** The "Units drawn" presets; the Favored one exists only when the topology marks some (not all) P-cores favored. */
export function presets(m) {
  const list = [{ value: "all", label: "All", units: m.ids }, { value: "P", label: "P-cores", units: idsOfKind(m, "P") }, { value: "E", label: "E-clusters", units: idsOfKind(m, "E") }];
  const fav = favoredIds(m);
  if (fav.length && fav.length < idsOfKind(m, "P").length) list.push({ value: "fav", label: "Favored ★", units: fav, title: `The favored P-cores: ${fav.join(", ")}${m.favoredSource ? ` (${m.favoredSource})` : ""}` });
  return list;
}
export function presetOf(list, set) {
  for (const p of list) if (p.units.length === set.size && p.units.every((u) => set.has(u))) return p.value;
  return "";
}

export function measureEstimate(mode, n) {
  const secs = (MEASURE_SECONDS[mode] * n) / MEASURE_REF_UNITS;
  return `${mode === "quick" ? "Quick" : "Dense"}, ${n} ${n === 1 ? "unit" : "units"}, about ${secs < 90 ? `${Math.round(secs)} s` : `${Math.round(secs / 60)} min`}`;
}
/** The vf.measure arguments (ops.rs vf_measure): mode, units (omitted when every unit is measured), name (trimmed, 1..64, omitted when empty). */
export function measureArgs(cv, ids) {
  const args = { mode: cv.mode };
  const sel = cv.sel ? ids.filter((u) => cv.sel.has(u)) : ids.slice();
  if (sel.length < ids.length) args.units = sel;
  const name = String(cv.name || "").trim().slice(0, 64);
  if (name) args.name = name;
  return args;
}
export function measureText(cv, ids, { running, gate }) {
  const n = (cv.sel ? ids.filter((u) => cv.sel.has(u)) : ids).length;
  if (running) return "Measuring. Each unit is capped one ratio at a time and loaded; limits are restored when it ends or is cancelled.";
  if (gate) return gate;
  if (!ids.length) return "The CPU topology is not known yet (preflight).";
  if (n === 0) return "Select at least one unit.";
  return `Ready: ${measureEstimate(cv.mode, n)}. Raises the load on the selected cores for that time.`;
}
/** "Measuring P0 · point 1 of 8" for a vf.measure progress event (the status line while it runs); null before the first progress event. */
export function measuringText(ev) {
  if (!isObj(ev) || !isNum(ev.step) || !isNum(ev.of) || ev.of <= 0) return null;
  return `Measuring ${isStr(ev.unit) && ev.unit ? `${ev.unit} · ` : ""}point ${Math.min(Math.max(ev.step, 1), ev.of)} of ${ev.of}`;
}
/** The progress line of a vf.measure progress event, or null. */
export function progressText(ev) {
  if (!isObj(ev) || !isNum(ev.step) || !isNum(ev.of) || ev.of <= 0) return null;
  const bits = [];
  if (isStr(ev.unit)) bits.push(ev.unit);
  if (isNum(ev.ratio)) bits.push(`${ev.ratio}${TIMES}`);
  bits.push(`point ${ev.step} of ${ev.of}`);
  if (isNum(ev.eta_s)) bits.push(`about ${ev.eta_s < 90 ? `${Math.round(ev.eta_s)} s` : `${Math.round(ev.eta_s / 60)} min`} left`);
  return { step: Math.min(ev.step, ev.of), of: ev.of, text: bits.join(" · ") };
}

/** A curves.list row as library cells. */
export function libraryRow(c, { primary = null } = {}) {
  const kind = tuningKind(c);
  return {
    id: c.id,
    current: c.id === primary,
    name: curveName(c),
    baseline: c.baseline === true,
    partial: c.complete === false,
    created: fmtLocalDateTime(c.created) || fmtDate(c.created),
    mode: c.mode || NA,
    tuning: { text: kind === "words" ? "tuned" : kind, tone: kind === "stock" ? "ok" : kind === "words" ? "pending" : "neutral", title: tuningWords(kind) },
    units: unitCount(c),
  };
}

const bucket = (f, n) => clamp(Math.floor(f * n), 0, n - 1);

/**
 * The Table view: {ratios, rows: [{unit, cells: [{kind: "none" | "na" | "val", text, cls, title}]}], note, canDelta, delta, empty}.
 * `a` = shown record, `base` = the baseline record, `delta` = show mV difference to the baseline.
 */
export function tableModel(a, base, { delta, ids, live = false, primaryIsBaseline = false }) {
  const canDelta = Boolean(base) && a !== null && (live || !primaryIsBaseline);
  const useDelta = delta && canDelta;
  if (!a) return { ratios: [], rows: [], note: "", canDelta, delta: useDelta, empty: "n/a: no curve selected yet." };
  const ratios = [...new Set(ids.flatMap((u) => recAllPoints(a, u).map((p) => p.ratio)).filter(isNum))].sort((x, y) => x - y);
  const val = (u, p) => {
    if ((p.status !== "ok" && p.status !== "interpolated") || !isNum(p.vid_v)) return null;
    const guess = p.status === "interpolated" && p.exact !== true; // an estimated point is marked "~" (an exact one is not)
    if (!useDelta) return { v: p.vid_v, est: guess };
    const at = interpAt(recPoints(base, u), isNum(p.mhz) ? p.mhz : p.ratio * 100);
    return at ? { v: (p.vid_v - at.v) * 1000, est: !at.exact || guess } : null;
  };
  let lo = Infinity;
  let hi = -Infinity;
  let big = 0;
  for (const u of ids) for (const p of recAllPoints(a, u)) {
    const x = val(u, p);
    if (x) {
      lo = Math.min(lo, x.v);
      hi = Math.max(hi, x.v);
      big = Math.max(big, Math.abs(x.v));
    }
  }
  const rows = ids.filter((u) => isObj(a.units) && isObj(a.units[u])).map((u) => {
    const byRatio = {};
    for (const p of recAllPoints(a, u)) byRatio[p.ratio] = p;
    const cells = ratios.map((r) => {
      const p = byRatio[r];
      if (!p) return { kind: "none", text: "—", cls: "vt-none", title: "" };
      const x = val(u, p);
      if (!x) {
        const why = p.status === "unreachable" ? "unreachable" : p.status === "mismatch" ? "mismatch" : useDelta ? "no baseline value" : NA;
        return { kind: "na", text: p.status === "ok" ? NA : "—", cls: "vt-na", title: `${u} at ${r}${TIMES}: ${why}${p.status === "unreachable" ? `: ${reasonText(p.reason, p)}${isStr(p.reason) ? ` (${p.reason})` : ""}` : ""}` };
      }
      let cls;
      let text;
      if (useDelta) {
        text = (x.v > 0 ? "+" : x.v < 0 ? MINUS : "") + Math.abs(x.v).toFixed(0);
        const f = big > 0 ? x.v / big : 0;
        cls = `vt dv-${f < 0 ? "m" : "p"}${bucket(Math.abs(f), 4)}`;
      } else {
        text = x.v.toFixed(3);
        cls = `vt hv-${bucket(hi > lo ? (x.v - lo) / (hi - lo) : 0.5, 10)}`;
      }
      const kept = isNum(p.kept) && isNum(p.total) ? `, ${p.kept} of ${p.total} samples at target` : "";
      const range = isNum(p.vid_min) && isNum(p.vid_max) ? `, range ${p.vid_min.toFixed(3)} to ${p.vid_max.toFixed(3)} V` : "";
      const interp = p.status === "interpolated" ? `, ${interpText(p)}` : "";
      return { kind: "val", text: text + (x.est ? "~" : ""), cls, title: `${u} at ${r}${TIMES} (${isNum(p.mhz) ? p.mhz.toFixed(0) : r * 100} MHz): ${p.vid_v.toFixed(3)} V${range}${kept}${interp}` };
    });
    return { unit: u, cells };
  });
  return { ratios, rows, canDelta, delta: useDelta, note: useDelta ? `mV difference to the baseline curve (${base ? base.name : ""}). Negative means lower voltage.` : "Volts requested by the core at each ratio. ~ marks an interpolated value; — a ratio this unit has no point at.", empty: "" };
}

// ---------------------------------------------------------------- cursor readout (pure)

/** The tooltip rows at `mhz`: every drawn series with a value there, highest first. -> [{s, v, exact}] */
export function tipRows(model, mhz) {
  const rows = [];
  for (const s of model.series) {
    const at = interpAt(s.pts, mhz);
    if (at) rows.push({ s, v: at.v, exact: at.exact });
  }
  return rows.sort((a, b) => b.v - a.v);
}
export const tipValue = (model, v) => (model.ymode === "mv" ? fmtMv(v) : `${v.toFixed(3)} V`);

// ---------------------------------------------------------------- controller (no DOM; one per bridge)

/** A large record comes back within the helper's 64 KiB line with omitted_units: [unit, ...]; the rest is fetched with curves.get {id, units} and merged. */
export async function mergeOmitted(bridge, rec) {
  for (let round = 0; round < 12 && isObj(rec) && Array.isArray(rec.omitted_units) && rec.omitted_units.length; round++) {
    const want = rec.omitted_units.filter(isStr);
    const res = await bridge.call("curves.get", { id: rec.id, units: want });
    if (!(res.ok && isObj(res.result) && isObj(res.result.units))) break;
    if (!isObj(rec.units)) rec.units = {};
    Object.assign(rec.units, res.result.units);
    const still = Array.isArray(res.result.omitted_units) ? res.result.omitted_units.filter((u) => want.includes(u) && !(u in res.result.units)) : [];
    rec.omitted_units = still;
    if (still.length === want.length) break; // no progress: stop asking
  }
  return rec;
}

const controllers = new WeakMap();
export function curvesController(ctx) {
  const cached = controllers.get(ctx.bridge);
  if (cached) return cached;
  const c = createCurvesController(ctx);
  controllers.set(ctx.bridge, c);
  return c;
}

export function createCurvesController({ bridge, store }) {
  const cv = {
    noTurbo: false,
    list: [], // curves.list rows, newest first
    cache: {}, // id -> full record (curves.get)
    loaded: false,
    primary: null, // id shown in the chart / table
    compare: null, // id drawn dashed (or subtracted in difference mode)
    view: "chart", // chart | table | library
    drawn: null, // Set of unit ids drawn; null = every unit
    delta: false,
    band: false,
    mode: "quick",
    sel: null, // Set of unit ids to measure; null = every unit
    name: "",
    live: null, // the record being filled by a running vf.measure
    liveHead: null,
    tableDelta: false,
    renaming: null,
    renameText: null, // what has been typed into the rename box (null = untouched)
    confirmDelete: null,
    words: null, // modelFromRead of the kept tune read (fused top points), or null
  };
  const view = { run: null, status: "", problems: [], progress: null, submitting: false, cancelling: false, done: new Set(), listProblem: "" };
  const painters = new Set();
  const paint = () => painters.forEach((fn) => fn());
  const ids = () => unitModel(store.get().preflight).ids;
  const drawnSet = () => cv.drawn || new Set(ids());
  const unitsOf = (rec) => (rec && isObj(rec.units) ? Object.keys(rec.units) : []);

  const primaryRec = () => cv.live || (cv.primary ? cv.cache[cv.primary] : null) || null;
  const compareRec = () => (cv.compare ? cv.cache[cv.compare] || null : null);
  const fusedOf = (u) => (cv.words && cv.words.units[u] && cv.words.units[u].fused ? cv.words.units[u].fused : null);

  function model() {
    const m = unitModel(store.get().preflight);
    return curvesModel({
      a: primaryRec(), b: compareRec(), loaded: cv.loaded, listLen: cv.list.length, drawn: drawnSet(), delta: cv.delta, band: cv.band, live: cv.live !== null, liveHead: cv.liveHead,
      ids: m.ids, baseline: baselineId(cv.list), fusedOf, favored: new Set(favoredIds(m)),
    });
  }

  /** G-250: per drawn unit, derived top-point voltage (measured - offsets) minus the CPU's fused 0x09 voltage, for the shown curve; [] without a kept read or an underivable curve. */
  function topChecks(rec) {
    if (!rec || cv.live || !cv.words) return [];
    const d = deriveFromRecord(rec, cv.words);
    if (!d) return [];
    const drawn = drawnSet();
    return Object.entries(d.units)
      .filter(([unit]) => drawn.has(unit))
      .map(([unit, pts]) => {
        const t = topCheck(pts, fusedOf(unit));
        return t ? { unit, mv: t.mv, clamped: t.clamped } : null;
      })
      .filter(Boolean);
  }

  async function ensureRecord(id) {
    if (!id) return null;
    if (cv.cache[id]) return cv.cache[id];
    const res = await bridge.call("curves.get", { id });
    if (res.ok && isObj(res.result)) {
      cv.cache[id] = await mergeOmitted(bridge, res.result);
      return cv.cache[id];
    }
    return null;
  }

  async function loadCurves(selectNewest = false) {
    const res = await bridge.call("curves.list", {});
    if (!(res.ok && isObj(res.result) && Array.isArray(res.result.curves))) {
      cv.list = [];
      cv.loaded = true;
      view.listProblem = `Stored curves unavailable: ${errText(res.error)}`;
      paint();
      return;
    }
    view.listProblem = "";
    cv.list = res.result.curves.filter(isObj);
    cv.loaded = true;
    cv.noTurbo = res.result.no_turbo === true; // G-132: the power-saver profile turns turbo off; a run cannot reach ratios above base
    const have = new Set(cv.list.map((c) => c.id));
    for (const k of Object.keys(cv.cache)) if (!have.has(k)) delete cv.cache[k];
    if (cv.compare && !have.has(cv.compare)) {
      cv.compare = null;
      cv.delta = false;
    }
    if (selectNewest) cv.primary = cv.list.length ? cv.list[0].id : null; // a measurement just ended: show it
    else if (!cv.primary || !have.has(cv.primary)) cv.primary = defaultCurveId(cv.list, ids());
    paint();
    await Promise.all([cv.primary, cv.compare, baselineId(cv.list)].filter(Boolean).map(ensureRecord));
    paint();
  }

  /** The kept tune read, for the baseline's fused top points. tune.last is a read with no mailbox traffic. */
  async function loadWords() {
    const res = await bridge.call("tune.last", {});
    if (res.ok && isObj(res.result) && res.result.available === true) cv.words = modelFromRead(res.result.result);
    paint();
  }

  const watching = new Set();
  function watch(id) {
    if (watching.has(id)) return;
    watching.add(id);
    bridge.wait(id).then(onResult);
  }

  function adopt(id) {
    if (!isStr(id) || view.done.has(id)) return false;
    view.run = { id };
    watch(id);
    cv.live = { id: "live", name: "Measuring", mode: "?", units: {}, live: true };
    cv.liveHead = null;
    cv.view = "chart";
    return true;
  }

  function onVfPoint(ev) {
    if (!isObj(ev)) return;
    if (!view.run && !adopt(ev.op_id)) return;
    if (view.run.id !== ev.op_id) return;
    if (!cv.live) cv.live = { id: "live", name: "Measuring", mode: "?", units: {}, live: true };
    const known = ids();
    if (!isStr(ev.unit) || !known.includes(ev.unit) || !isNum(ev.ratio)) return;
    const u = cv.live.units[ev.unit] || (cv.live.units[ev.unit] = { points: [] });
    if (ev.retry === true) {
      const i = u.points.findIndex((q) => q.ratio === ev.ratio);
      if (i >= 0) u.points.splice(i, 1); // G-118: a retry replaces the first attempt
    }
    u.points.push({ ratio: ev.ratio, mhz: isNum(ev.mhz) ? ev.mhz : ev.ratio * 100, vid_v: isNum(ev.vid_v) ? ev.vid_v : null, status: isStr(ev.status) ? ev.status : "ok" });
    if (ev.status === "ok") cv.liveHead = ev.unit;
    paint();
  }

  // What the helper said each op is doing (`state` / `heartbeat` carry {op_id, state}): tune.read and tune.apply also report `step`/`of` progress, so a run begun elsewhere
  // is adopted from its progress only when the helper called it "measuring".
  const opState = new Map();
  function noteState(ev) {
    if (!isObj(ev) || !isStr(ev.op_id) || !isStr(ev.state)) return;
    opState.set(ev.op_id, ev.state);
    if (opState.size > 32) opState.delete(opState.keys().next().value);
  }

  function onProgress(ev) {
    if (!isObj(ev) || ev.step === undefined) return; // a measurement's progress carries `step`/`of` (a stress run's `elapsed_s`)
    if (!view.run && (opState.get(ev.op_id) !== "measuring" || !adopt(ev.op_id))) return;
    if (view.run.id !== ev.op_id) return;
    const p = progressText(ev);
    if (p) {
      view.progress = { ...p, line: measuringText(ev) };
      paint();
    }
  }

  async function onResult(fin) {
    if (fin && isStr(fin.id)) {
      view.done.add(fin.id);
      watching.delete(fin.id);
    }
    view.run = null;
    view.cancelling = false;
    cv.live = null;
    cv.liveHead = null;
    const err = fin && isObj(fin.error) ? fin.error : null;
    const problemsOf = (x) => [...new Set((Array.isArray(x) ? x : []).filter(isStr))];
    if (fin && fin.ok === true && isObj(fin.result)) {
      const rec = isObj(fin.result.record) ? fin.result.record : null;
      const id = isStr(fin.result.curve_id) ? fin.result.curve_id : rec && isStr(rec.id) ? rec.id : null;
      if (rec && id) {
        if (!rec.id) rec.id = id;
        cv.cache[id] = await mergeOmitted(bridge, rec);
      }
      cv.primary = id;
      const problems = problemsOf(fin.result.problems);
      view.problems = problems;
      view.status = `Measured ${rec ? sumPoints(cv.cache[id] || rec) : 0} points. Stored as "${rec && rec.name ? rec.name : id}". ${rec && isObj(rec.tuning_state) ? `${tuningWords(rec.tuning_state.kind)}. ` : ""}${problems.length ? `${problems.length} ${problems.length === 1 ? "note" : "notes"} — see below` : ""}`.trim();
      await loadCurves(false);
      return;
    }
    if (err && isObj(err.detail) && Array.isArray(err.detail.problems)) view.problems = problemsOf(err.detail.problems); // a failed or cancelled run: its notes too
    const cid = err && isObj(err.detail) && isStr(err.detail.curve_id) ? err.detail.curve_id : null;
    if (err && err.code === "CANCELLED") {
      view.status = "Cancelled. The points measured so far were kept as a partial curve; CPU limits are restored.";
      if (cid) {
        cv.primary = cid;
        await loadCurves(false);
      } else await loadCurves(true);
    } else {
      view.status = `Failed: ${errText(err)}${cid ? " The partial curve was kept." : ""}`;
      if (cid) {
        cv.primary = cid;
        await loadCurves(false);
      } else paint();
    }
  }

  async function startMeasure() {
    const all = ids();
    const sel = cv.sel ? all.filter((u) => cv.sel.has(u)) : all;
    if (view.run || view.submitting || opGate(store.get(), false) || sel.length === 0) return false;
    const args = measureArgs(cv, all);
    view.submitting = true;
    view.problems = [];
    view.progress = null;
    view.status = "Submitting…";
    paint();
    const first = await bridge.call("vf.measure", args);
    view.submitting = false;
    if (!first.ok) {
      view.status = `Not started: ${errText(first.error)}`;
      paint();
      return false;
    }
    if (!view.run) view.run = { id: first.id }; // events may have arrived (and adopted the run) before the answer did
    cv.live = { ...(cv.live || { units: {} }), id: "live", name: args.name || "Measuring", mode: args.mode, live: true };
    cv.liveHead = cv.liveHead || null;
    cv.view = "chart";
    view.progress = view.progress || { step: 0, of: 1, text: "starting" };
    view.status = "Measuring. The chart fills as each point arrives."; // never the internal operation id (QA-37)
    paint();
    if (first.pending) watch(first.id);
    else await onResult(first);
    return true;
  }

  async function cancel() {
    if (!view.run || view.cancelling) return false;
    view.cancelling = true;
    paint();
    const res = await bridge.call("cancel", { op_id: view.run.id });
    if (!res.ok) {
      view.cancelling = false;
      view.status = `Cancel not accepted: ${errText(res.error)}`;
    } else view.status = "Cancel requested. The points measured so far are kept as a partial curve.";
    paint();
    return res.ok;
  }

  async function select(id) {
    if (!id || id === "live") return;
    cv.primary = id;
    if (cv.compare === id) {
      cv.compare = null;
      cv.delta = false;
    }
    paint();
    await ensureRecord(id);
    paint();
  }
  async function setCompare(id) {
    cv.compare = id || null;
    if (!cv.compare) cv.delta = false;
    paint();
    await ensureRecord(cv.compare);
    paint();
  }
  async function rename(id, name) {
    const n = String(name || "").trim();
    if (!n) {
      view.status = "A name cannot be empty.";
      paint();
      return false;
    }
    const res = await bridge.call("curves.update", { id, name: n.slice(0, 64) });
    cv.renaming = null;
    cv.renameText = null;
    view.status = res.ok ? "Renamed." : `Rename failed: ${errText(res.error)}`;
    delete cv.cache[id]; // the stored record carries the name
    await loadCurves(false);
    return res.ok;
  }
  async function toggleBaseline(c) {
    const res = await bridge.call("curves.update", { id: c.id, baseline: c.baseline !== true });
    view.status = res.ok ? (c.baseline === true ? "Baseline cleared." : (tuningKind(c) === "words" ? `"${c.name || c.id}" is now the baseline (derived: its offsets are taken off).` : `"${c.name || c.id}" is now the stock baseline.`)) : `Failed: ${errText(res.error)}`;
    await loadCurves(false);
    return res.ok;
  }
  async function remove(c) {
    const res = await bridge.call("curves.delete", { id: c.id });
    cv.confirmDelete = null;
    view.status = res.ok ? "Deleted." : `Delete failed: ${errText(res.error)}`;
    if (cv.primary === c.id) cv.primary = null;
    await loadCurves(false);
    return res.ok;
  }
  /** The JSON text of a stored curve (every unit merged in), or null. */
  async function recordJson(c) {
    const rec = await ensureRecord(c.id);
    return rec ? JSON.stringify(rec, null, 2) : null;
  }

  bridge.on("vf.point", onVfPoint);
  bridge.on("state", noteState);
  bridge.on("heartbeat", noteState);
  bridge.on("progress", onProgress);
  store.watch((s) => s.link.state, (state) => {
    if (state === "connected" && !cv.loaded) {
      loadCurves(false);
      loadWords();
    }
  });

  return {
    cv,
    view,
    ids,
    drawnSet,
    model,
    primaryRec,
    compareRec,
    fusedOf,
    topChecks,
    loadCurves,
    loadWords,
    ensureRecord,
    startMeasure,
    cancel,
    select,
    setCompare,
    rename,
    toggleBaseline,
    remove,
    recordJson,
    unitsOf,
    subscribe(fn) {
      painters.add(fn);
      return () => painters.delete(fn);
    },
    paint,
    gate: () => opGate(store.get(), view.submitting || !!view.run),
  };
}

/** R-36 / G-250: a complete curve whose tuning state is known may be the baseline: a stock one as measured, a tuned one as a DERIVED baseline (Tune subtracts the offsets it was measured with). */
export const baselineAllowed = (c) => isObj(c) && (tuningKind(c) === "stock" || tuningKind(c) === "words") && c.complete !== false;

// ---------------------------------------------------------------- plot spec (pure)

/** The channel ramp step of a unit: "p0"…"p7", "e0"…"e3" (DESIGN.md §3.1: two lightness ramps for 12-unit plots). */
export function rampOf(unit) {
  const m = /^(P|EC)(\d+)$/.exec(String(unit));
  if (!m) return "p1";
  return m[1] === "P" ? `p${Math.min(7, Number(m[2]))}` : `e${Math.min(3, Number(m[2]))}`;
}

/** Spread the direct labels so they never overlap: ys in px (top-down), minimum gap `gap`. Keeps the order; returns new ys. Pure. */
export function spreadLabels(ys, gap = 13, lo = -Infinity, hi = Infinity) {
  const idx = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = idx.map(([y]) => y);
  for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < gap) out[i] = out[i - 1] + gap;
  if (out.length && out[out.length - 1] > hi) {
    out[out.length - 1] = hi;
    for (let i = out.length - 2; i >= 0; i--) if (out[i + 1] - out[i] < gap) out[i] = out[i + 1] - gap;
  }
  if (out.length && out[0] < lo) {
    out[0] = lo;
    for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < gap) out[i] = out[i - 1] + gap;
  }
  const res = new Array(ys.length);
  idx.forEach(([, i], k) => (res[i] = out[k]));
  return res;
}

/**
 * The chart model (curvesModel) as a plot-core spec at a plot height: {x, y, traces, ramps (class per trace), markers, labels, cursorXs, empty}.
 * Primary series: channel kind p / e + the unit's ramp step; compared series: factory-dashed grey; spread: the lowest and highest unit as dotted fg3.
 */
const LIVE_LABEL_GAP = "\u00a0\u00a0\u00a0\u00a0"; // the live series' marker sits on its last point: keep the label clear of it (QA-37)
export function chartSpec(model, { height = 360, margin = { t: 18, b: 34 } } = {}) {
  if (model.empty || !model.series.length) return { empty: model.empty || "Nothing to draw yet.", traces: [], ramps: [], markers: [], labels: [], cursorXs: [], x: { min: 0, max: 1000 }, y: { min: 0, max: 1 } };
  const mv = model.ymode === "mv";
  const all = model.series.flatMap((s) => s.pts);
  const pins = Array.isArray(model.pins) ? model.pins : [];
  const xs = [...all.map((p) => p.mhz), ...pins.map((p) => p.mhz)];
  const xlo = Math.floor((Math.min(...xs) - 50) / 500) * 500;
  const xhi = Math.max(Math.ceil((Math.max(...xs) + 50) / 500) * 500, xlo + 1000);
  let ys = all.map((p) => p.v).concat(pins.map((p) => p.v));
  if (model.band) ys = ys.concat(model.band.flatMap((b) => [b.lo, b.hi]));
  let ylo = Math.min(...ys);
  let yhi = Math.max(...ys);
  if (mv) {
    ylo = Math.min(ylo, 0);
    yhi = Math.max(yhi, 0);
  }
  const span = mv ? 4 : MIN_SPAN_V;
  if (yhi - ylo < span) {
    const m = (yhi + ylo) / 2;
    ylo = m - span / 2;
    yhi = m + span / 2;
  }
  const t0 = niceTicks(ylo, yhi, 5);
  const step = t0.length > 1 ? t0[1] - t0[0] : span;
  const y = { min: Math.floor(ylo / step + 1e-9) * step, max: Math.ceil(yhi / step - 1e-9) * step };
  if (y.max - y.min < step) y.max += step;
  y.ticks = niceTicks(y.min, y.max, 5);
  const x = { min: xlo, max: xhi, ticks: niceTicks(xlo, xhi, 6) };
  const traces = [];
  const ramps = [];
  const markers = [];
  const ends = [];
  for (const s of model.series) {
    if (!s.pts.length) continue;
    const pts = s.pts.map((p) => [p.mhz, p.v]);
    if (s.dash) {
      traces.push({ kind: "base", pts });
      ramps.push(null);
      continue;
    }
    const kind = /^EC/.test(s.unit) ? "e" : "p";
    traces.push({ kind, pts });
    ramps.push(rampOf(s.unit));
    for (const p of s.pts) if (p.interp) markers.push({ x: p.mhz, y: p.v, kind: "base", shape: "sq" });
    if (s.live) for (const p of s.pts) markers.push({ x: p.mhz, y: p.v, kind: "meas", shape: "sq" });
    const last = s.pts[s.pts.length - 1];
    ends.push({ unit: s.unit, text: s.label, x: last.mhz, y: last.v, ramp: rampOf(s.unit), live: !!s.live });
  }
  if (model.band) {
    traces.push({ kind: "base", pts: model.band.map((b) => [b.mhz, b.lo]), approx: true }, { kind: "base", pts: model.band.map((b) => [b.mhz, b.hi]), approx: true });
    ramps.push(null, null);
  }
  for (const p of pins) markers.push({ x: p.mhz, y: p.v, kind: "meas", shape: "dia" });
  // direct labels: at each line end, spread in px so none overlap, converted back to data space
  const plotH = height - margin.t - margin.b;
  const toPx = (v) => margin.t + ((y.max - v) / (y.max - y.min)) * plotH;
  const toV = (px) => y.max - ((px - margin.t) / plotH) * (y.max - y.min);
  const groups = new Map();
  for (const e of ends) {
    const k = Math.round(e.x / 300);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const labels = [];
  for (const g of groups.values()) {
    const spread = spreadLabels(g.map((e) => toPx(e.y)), 12, margin.t, margin.t + plotH);
    g.forEach((e, i) => labels.push({ x: e.x, y: toV(spread[i]), text: `${e.live ? LIVE_LABEL_GAP : " "}${e.text}`, kind: e.ramp, anchor: "start", unit: e.unit }));
  }
  const cursorXs = [...new Set(all.map((p) => p.mhz))].sort((a, b) => a - b);
  return { empty: null, x, y, traces, ramps, markers, labels, cursorXs };
}

/** The pinned readout at a cursor frequency: "5600 MHz · 56×" then the highest and lowest units there (all of them when four or fewer). */
export function readoutParts(model, mhz) {
  const rows = tipRows(model, mhz).filter((r) => !r.s.dash);
  const fmt = (r) => (model.ymode === "mv" ? fmtMv(r.v) : r.v.toFixed(3)) + (r.exact ? "" : "~");
  const head = ["", `${Math.round(mhz)} MHz · ${Math.round(mhz / 100)}${TIMES}`];
  if (!rows.length) return [head];
  const pick = rows.length <= 4 ? rows : [rows[0], rows[rows.length - 1]];
  const out = [head, ...pick.map((r, i) => [rows.length > 4 ? (i === 0 ? `max ${r.s.unit}` : `min ${r.s.unit}`) : r.s.unit, fmt(r), model.ymode === "mv" ? "" : "V"])];
  if (rows.length > 4) out.push(["", `${rows.length} units`]);
  return out;
}

// ---------------------------------------------------------------- view

/** Copy `text` to the clipboard (the shipped webview has no download handler). Resolves true when it worked. */
export async function copyText(text, nav = globalThis.navigator) {
  try {
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* falls through */
  }
  return false;
}
export const exportName = (c) => `linux-xtu-curve-${String(c.id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

export const TABS = [
  { id: "chart", label: "Chart", hint: "curves.curve" },
  { id: "table", label: "Table", hint: "curves.table" },
  { id: "library", label: "Library", hint: "curves.library" },
];
/** The chart's height from the window's: 440 px at 1280×800, 240 px at the 960×600 minimum, so the panel fits without scrolling. */
export const plotHeight = (innerH) => Math.max(240, Math.min(460, Math.round((Number(innerH) || 800) - 360)));
const PLOT_M = { l: 52, r: 72, t: 18, b: 34 };

export function curvesView() {
  const subs = [];
  return {
    id: "curves",
    lx: true,
    mount(root, ctx) {
      const { store } = ctx;
      const ctl = curvesController(ctx);
      const { cv, view } = ctl;
      const PLOT_H = plotHeight(globalThis.innerHeight);
      let m = unitModel(store.get().preflight);
      let ids = m.ids;
      const setHead = () => ctx.head && ctx.head.set({ tabs: TABS, selected: cv.view, onTab: (id) => { cv.view = id; render(); }, idPrefix: "cv-tab-", controls: "cv-main", label: "Curve views" });
      setHead();

      // ---- MEASURE
      const pointsOf = (u) => recChartPoints(ctl.primaryRec(), u);
      const cols = [
        { key: "pts", label: "Pts", num: true, value: (u) => { const p = pointsOf(u.id); return p.length ? String(p.length) : null; } },
        { key: "topv", label: "Top", unit: "V", num: true, value: (u) => { const p = pointsOf(u.id); return p.length ? p[p.length - 1].v.toFixed(3) : null; } },
      ];
      const ut = createUnitTable({ columns: cols, check: true, label: "Units to measure and draw", id: "cv-units", onSelect: (sel) => { cv.sel = new Set(sel); cv.drawn = new Set(sel); render(); } });
      const quick = h("span", { class: "lx-cv-quick" });
      const modeSeg = createSegmented({ options: [{ value: "quick", label: "Quick", hint: "curves.quick" }, { value: "dense", label: "Dense", hint: "curves.dense" }], value: cv.mode, label: "Resolution", id: "cv-mode", onChange: (v) => { cv.mode = v; render(); } });
      const nameInput = h("input", { type: "text", class: "lx-text lx-mono", id: "cv-name", maxlength: 64, placeholder: "optional, e.g. stock", autocomplete: "off", spellcheck: "false", "aria-label": "Name", dataset: { hint: "curves.name" } });
      nameInput.value = cv.name;
      nameInput.addEventListener("input", () => { cv.name = nameInput.value; });
      const measureBtn = button({ level: 3, label: "Measure", cost: "~2 min", id: "btn-measure", hint: "curves.measure", onClick: () => ctl.startMeasure() });
      const cancelBtn = button({ level: 2, label: "Cancel", id: "btn-measure-cancel", hint: "curves.cancel", onClick: () => ctl.cancel() });
      const measureWhy = why(null, {}, { id: "cv-measure-why" });
      const rule = progressRule(0);
      rule.id = "cv-bar";
      const progress = h("span", { class: "lx-cv-progress lx-mono", id: "cv-progress" });
      const run = h("div", { class: "lx-cv-run", id: "cv-run", hidden: true }, rule, progress);
      const turbo = box({ kind: "warn", title: "Turbo is off", body: TURBO_OFF_NOTE, id: "cv-turbo-note" });
      turbo.hidden = true;
      const status = h("p", { class: "lx-cv-status", id: "cv-status", role: "status" });
      const problems = h("ul", { class: "lx-cv-lines", id: "cv-problems", hidden: true });
      const row = (label, hint, ...kids) => h("div", { class: "lx-cv-row", dataset: { hint } }, h("span", { class: "lx-lbl", text: label }), h("div", { class: "lx-cv-ctl" }, ...kids));
      const form = h("div", { class: "lx-cv-form" }, h("div", { class: "lx-cv-fields" }, row("Resolution", "curves.quick", modeSeg.el), row("Name", "curves.name", nameInput)), h("div", { class: "lx-cv-go" }, measureBtn, cancelBtn), measureWhy, run, turbo, status, problems);
      const measureP = panel({ title: "Measure", meta: "", end: quick, id: "cv-measure", flush: true, body: [h("div", { class: "lx-cv-units" }, ut.el), form] });
      measureP.el.dataset.hint = "curves.select";

      // ---- CHART
      const primarySel = h("select", { class: "lx-select", id: "cv-primary", "aria-label": "Curve", dataset: { hint: "curves.curve" } });
      primarySel.addEventListener("change", () => ctl.select(primarySel.value));
      const compareSel = h("select", { class: "lx-select", id: "cv-compare", "aria-label": "Compare with", dataset: { hint: "curves.compare" } });
      compareSel.addEventListener("change", () => ctl.setCompare(compareSel.value));
      const ySeg = createSegmented({ options: [{ value: "v", label: "Volts" }, { value: "mv", label: "Δ mV", hint: "curves.delta" }], value: cv.delta ? "mv" : "v", label: "Chart values", id: "cv-ymode", onChange: (v) => { cv.delta = v === "mv" && !!cv.compare; render(); } });
      const spread = h("input", { type: "checkbox", class: "lx-check", id: "cv-band" });
      spread.addEventListener("change", () => { cv.band = spread.checked; render(); });
      const spreadLbl = h("label", { class: "lx-cv-check", dataset: { hint: "curves.spread" } }, spread, h("span", { text: "Spread" }));
      const tags = h("span", { class: "lx-cv-tags", id: "cv-tags" });
      const tools = h("div", { class: "lx-cv-tools" }, primarySel, tags, h("span", { class: "lx-spacer" }), h("span", { class: "lx-lbl", text: "Compare" }), compareSel, ySeg.el, spreadLbl);
      let model = null;
      const plotX = { min: 0, max: 1, title: "MHz · ratio = MHz / 100" };
      const plotY = { min: 0, max: 1, title: "V" };
      const plot = createPlot({ label: "Measured V/F curves: requested volts against frequency", height: PLOT_H, margin: PLOT_M, x: plotX, y: plotY, readout: (xv) => (model ? readoutParts(model, xv) : []) });
      plot.el.id = "cv-chart";
      let ramps = [];
      const decorate = () => {
        const lines = plot.svg.querySelectorAll("polyline.lx-tr");
        lines.forEach((pl, i) => { if (ramps[i]) pl.classList.add(`lx-cv-c-${ramps[i]}`); });
      };
      if (typeof MutationObserver === "function") {
        const mo = new MutationObserver(decorate); // the plot core redraws its SVG on resize and cursor moves: the ramp classes follow every redraw
        mo.observe(plot.svg, { childList: true });
        subs.push(() => mo.disconnect());
      }
      const chartEmpty = h("div", { class: "lx-cv-empty", id: "cv-chart-empty" });
      const legend = h("div", { class: "lx-legend lx-legend--pad", id: "cv-legend" });
      const chartNote = h("div", { class: "lx-tfoot-note", id: "cv-base-note" });
      const unreach = h("div", { class: "lx-tfoot-note", id: "cv-unreach" });
      const chartP = panel({ title: "Curve", meta: "", id: "cv-chart-panel", body: [tools, h("div", { class: "lx-plotbox" }, plot.el, chartEmpty), legend, chartNote, unreach] });

      // ---- TABLE
      const tSeg = createSegmented({ options: [{ value: "v", label: "Volts" }, { value: "delta", label: "Δ vs baseline mV" }], value: "v", label: "Table values", id: "cv-table-mode", onChange: (v) => { cv.tableDelta = v === "delta"; render(); } });
      const tWhy = why(null, {}, { id: "cv-table-why", inline: true });
      const thead = h("thead");
      const tbody = h("tbody");
      const tableNote = h("div", { class: "lx-tfoot-note", id: "cv-table-note" });
      const tableP = panel({ title: "Volts per ratio", meta: "", end: tSeg.el, id: "cv-table-wrap", flush: true, scroll: true, body: [h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--dense", id: "cv-table" }, thead, tbody), tableNote] });

      // ---- LIBRARY
      const libBody = h("tbody", { id: "cv-lib-body" });
      const libTable = h("table", { class: "lx-tbl lx-tbl--fill", id: "cv-lib", "aria-label": "Stored curves" }, h("thead", {}, h("tr", {}, ...[["Name"], ["Measured"], ["Mode", false, true], ["Tuning"], ["Units", true, true], [""]].map(([t, n, w]) => h("th", { class: [n ? "lx-n" : "", w ? "lx-wide" : ""], scope: "col", text: t })))), libBody);
      const libEmpty = emptyState({ title: EMPTY["curves.none"].title, teach: EMPTY["curves.none"].teach, cost: EMPTY["curves.none"].cost, id: "cv-lib-empty" });
      const libP = panel({ title: "Stored curves", meta: "", id: "cv-lib-wrap", flush: true, scroll: true, body: [libTable, libEmpty] });

      const main = h("div", { class: "lx-cv-main", id: "cv-main", role: "tabpanel" }, chartP.el, tableP.el, libP.el);
      root.append(h("div", { class: "lx-tiles lx-cv", id: "cv" }, measureP.el, main));

      // ---- painting
      let topoKey = "";
      function syncTopology() {
        const next = unitModel(store.get().preflight);
        const key = next.ids.join(",") + "|" + favoredIds(next).join(",");
        if (key === topoKey) return;
        topoKey = key;
        m = next;
        ids = next.ids;
        ut.setUnits(unitsFromTopology(store.get().preflight ? store.get().preflight.topology : null));
        clear(quick).append(...quickButtons(m, (sel) => { if (view.run) return; cv.sel = new Set(sel); cv.drawn = new Set(sel); render(); }, "cv"));
      }
      let selectKey = "";
      function renderSelects() {
        const opts = [];
        if (cv.live) opts.push({ v: "live", t: "Live measurement" });
        for (const c of cv.list) opts.push({ v: c.id, t: curveTitle(c) + (c.baseline ? " · baseline" : "") });
        if (!opts.length) opts.push({ v: "", t: "No stored curves" });
        const others = cv.list.filter((c) => c.id !== cv.primary);
        const key = JSON.stringify([opts, others.map((c) => [c.id, curveTitle(c)])]);
        if (key !== selectKey) { // rebuilt only when the list changed: a repaint must not close an open drop-down
          selectKey = key;
          clear(primarySel).append(...opts.map((o) => h("option", { value: o.v, text: o.t })));
          clear(compareSel).append(h("option", { value: "", text: "none" }), ...others.map((c) => h("option", { value: c.id, text: curveTitle(c) + (c.baseline ? " · baseline" : "") })));
        }
        primarySel.value = cv.live ? "live" : cv.primary || "";
        primarySel.disabled = !cv.list.length && !cv.live;
        compareSel.value = cv.compare && others.some((c) => c.id === cv.compare) ? cv.compare : "";
        compareSel.disabled = others.length === 0 || cv.live !== null;
      }
      function curveTags(a) {
        const out = [];
        if (!a) return out;
        if (cv.live) return [tag("live · measuring", "set")];
        if (a.id === baselineId(cv.list)) out.push(tag(tuningKind(a) === "words" ? "baseline · derived" : "baseline", "ok"));
        const k = tuningKind(a);
        out.push(tag(k === "stock" ? "stock · offsets 0" : k === "words" ? "tuned" : "tuning unknown", k === "stock" ? "" : "warn"));
        if (a.complete === false) out.push(tag("partial", "warn"));
        return out;
      }
      function renderChart() {
        renderSelects();
        const a = ctl.primaryRec();
        clear(tags).append(...curveTags(a));
        ySeg.set(cv.delta ? "mv" : "v");
        ySeg.setDisabled("mv", !cv.compare);
        spread.checked = cv.band;
        model = ctl.model();
        const spec = chartSpec(model, { height: PLOT_H, margin: PLOT_M });
        plot.el.hidden = !!spec.empty;
        chartEmpty.hidden = !spec.empty;
        if (spec.empty) {
          clear(chartEmpty).append(cv.loaded && !cv.list.length && !cv.live
            ? emptyState({ title: EMPTY["curves.none"].title, teach: EMPTY["curves.none"].teach, cost: EMPTY["curves.none"].cost })
            : h("p", { class: "lx-cv-status", text: spec.empty }));
        } else {
          ramps = spec.ramps;
          plot.el.dataset.ymode = model.ymode;
          Object.assign(plotX, spec.x, { fmt: (t) => String(Math.round(t)) });
          Object.assign(plotY, spec.y, { title: model.ymode === "mv" ? "Δ mV" : "V", fmt: (t) => (model.ymode === "mv" ? (t > 0 ? "+" : t < 0 ? MINUS : "") + Math.abs(t).toFixed(0) : t.toFixed(2)) });
          plot.draw({ traces: spec.traces, markers: spec.markers, labels: spec.labels, cursorXs: spec.cursorXs });
          decorate();
        }
        const cmp = ctl.compareRec();
        clear(legend).append(...[
          h("span", {}, h("span", { class: "lx-sw lx-sw--p" }), "P-cores"), h("span", {}, h("span", { class: "lx-sw lx-sw--e" }), "E-clusters"),
          cmp && !cv.delta ? h("span", {}, h("span", { class: "lx-sw lx-sw--base" }), `compared: ${curveName(cmp)}`) : null,
          cv.band ? h("span", {}, h("span", { class: "lx-sw lx-sw--base" }), "spread (lowest, highest)") : null,
          model.pins && model.pins.length ? h("span", {}, h("span", { class: "lx-cv-dia", "aria-hidden": "true", text: "◆" }), "top point read from the CPU") : null,
          spec.markers.some((mk) => mk.kind === "base") ? h("span", {}, h("span", { class: "lx-sw-mk lx-cv-mk-base" }), "interpolated") : null,
          cv.live ? h("span", {}, h("span", { class: "lx-sw-mk" }), "point measured now") : null,
        ].filter(Boolean));
        const notes = curveNotes({ a, list: cv.list, live: cv.live !== null, baseline: baselineId(cv.list), drawn: ctl.drawnSet(), ids, wordsRead: !!cv.words, topChecks: ctl.topChecks(a) });
        chartNote.textContent = `${notes.base}${notes.check ? " " + notes.check : ""} Requested voltage (VID): no sensor reports the voltage that reaches a core.`;
        unreach.textContent = notes.unreach;
        legend.hidden = !!spec.empty;
        chartNote.hidden = !!spec.empty;
        unreach.hidden = !!spec.empty || !notes.unreach;
        chartP.setMeta(a ? (cv.live ? "measuring" : curveTitle(a)) : "");
      }
      function renderTable() {
        const a = ctl.primaryRec();
        const baseRec = baselineId(cv.list) ? cv.cache[baselineId(cv.list)] || null : null;
        const tm = tableModel(a, baseRec, { delta: cv.tableDelta, ids, live: cv.live !== null, primaryIsBaseline: cv.primary === baselineId(cv.list) });
        if (cv.tableDelta && !tm.canDelta) cv.tableDelta = false;
        tSeg.set(tm.delta ? "delta" : "v");
        tSeg.setDisabled("delta", !tm.canDelta);
        tableP.setMeta(a ? `${curveName(a)}${cv.live ? " · measuring" : ""}` : "");
        if (!a) {
          clear(thead);
          clear(tbody).append(h("tr", {}, h("td", { class: "lx-na", text: tm.empty })));
          tableNote.textContent = "";
          return;
        }
        clear(thead).append(h("tr", {}, h("th", { scope: "col", text: "Unit" }), ...tm.ratios.map((r) => h("th", { scope: "col", class: "lx-n", text: `${r}${TIMES}` }))));
        clear(tbody).append(...tm.rows.map((row) => h("tr", { dataset: { unit: row.unit } }, h("td", { class: "lx-k", text: row.unit + favMark(m, row.unit) }), ...row.cells.map((c) => h("td", { class: "lx-n", dataset: { v: c.kind === "val" ? "meas" : "none" }, title: c.title || undefined }, c.kind === "na" ? h("span", { class: "lx-na", text: c.text }) : c.text)))));
        tableNote.textContent = `${tm.note}${tm.canDelta ? "" : baseRec ? "" : " Δ needs a stock baseline: set one in the Library."}`;
      }
      function renderLibrary() {
        libEmpty.hidden = cv.list.length > 0 || !cv.loaded;
        libTable.hidden = cv.list.length === 0;
        libP.setMeta(cv.loaded ? `${cv.list.length} stored · newest first` : "loading…");
        clear(libBody).append(...cv.list.map((c) => {
          const r = libraryRow(c, { primary: cv.primary });
          const nameCell = h("td", { class: "lx-k", title: c.id });
          if (cv.renaming === c.id) {
            const inp = h("input", { type: "text", class: "lx-text lx-mono", maxlength: 64, "aria-label": `New name for ${r.name}` });
            inp.value = cv.renameText === null ? c.name || "" : cv.renameText;
            inp.addEventListener("input", () => { cv.renameText = inp.value; });
            const commit = () => ctl.rename(c.id, inp.value);
            const stop = () => { cv.renaming = null; cv.renameText = null; render(); };
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") stop(); });
            nameCell.append(inp, " ", button({ level: 2, label: "Save name", attrs: { "data-act": "save" }, onClick: commit }), button({ level: 0, label: "Keep", attrs: { "data-act": "keep-name" }, onClick: stop }));
            setTimeout(() => inp.focus(), 0);
          } else {
            nameCell.append(r.name);
            if (r.baseline) nameCell.append(" ", tag(c.baseline === true && tuningKind(c) === "words" ? "baseline · derived" : "baseline", "ok"));
            if (r.partial) nameCell.append(" ", tag("partial", "warn"));
          }
          const actBox = h("div", { class: "lx-cv-actbox" });
          const act = h("td", { class: "lx-cv-act" }, actBox);
          const btn = (level, label, act_, fn, extra = {}) => { const b = button({ level, label, attrs: { "data-act": act_ }, onClick: fn, ...extra }); actBox.append(b); return b; };
          btn(0, "View", "view", () => { cv.view = "chart"; ctl.select(c.id); render(); });
          btn(0, "Compare", "compare", () => { if (c.id !== cv.primary) { cv.view = "chart"; ctl.setCompare(c.id); render(); } }, { disabled: c.id === cv.primary });
          const allowed = baselineAllowed(c);
          const bb = btn(2, c.baseline === true ? "Clear baseline" : tuningKind(c) === "words" ? "Set as derived baseline" : "Set as baseline", "baseline", () => ctl.toggleBaseline(c), { disabled: c.baseline !== true && !allowed, hint: "curves.baseline" });
          btn(0, "Rename", "rename", () => { cv.renaming = c.id; cv.renameText = null; render(); });
          btn(0, "Export", "export", async () => {
            const text = await ctl.recordJson(c);
            if (!text) view.status = "Could not load the curve to export it.";
            else if (await copyText(text)) view.status = `Copied ${exportName(c)} (${text.length} characters of JSON) to the clipboard.`;
            else {
              const url = URL.createObjectURL(new Blob([text], { type: "application/json" })); // no clipboard here: a download instead
              const a = h("a", { href: url, download: exportName(c) });
              document.body.append(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 2000);
              view.status = `Download of ${exportName(c)} started.`;
            }
            ctl.paint();
          });
          const del = btn(0, "Delete", "delete", () => confirmInPlace(del, { text: `Delete “${r.name}”? This cannot be undone.`, confirmLabel: "Delete curve", keepLabel: "Keep", onConfirm: () => ctl.remove(c), label: "Delete curve" }));
          const trs = [h("tr", { dataset: { id: c.id, current: r.current ? "true" : "false" }, "aria-selected": r.current ? "true" : "false" },
            nameCell, h("td", { class: "lx-mono", text: r.created }), h("td", { class: "lx-wide", text: r.mode }), h("td", { title: r.tuning.title, text: r.tuning.text }), h("td", { class: "lx-n lx-wide", text: String(r.units) }), act)];
          if (c.baseline !== true && !allowed) {
            const w = why("locked.baseline_stock");
            bb.setAttribute("aria-describedby", w.id);
            trs.push(h("tr", { class: "lx-why-row", dataset: { why: c.id } }, h("td", { colspan: 6 }, w)));
          }
          return trs;
        }).flat());
      }
      function render() {
        syncTopology();
        setHead();
        const running = !!view.run;
        const sel = cv.sel ? ids.filter((u) => cv.sel.has(u)) : ids.slice();
        ut.setSelection(sel);
        ut.refresh();
        measureP.setMeta(`${sel.length} / ${ids.length}`);
        setInert(measureP.body.querySelector("table"), running);
        for (const b of quick.querySelectorAll("button")) b.disabled = running;
        modeSeg.set(cv.mode);
        for (const b of modeSeg.el.querySelectorAll("button")) b.disabled = running;
        nameInput.disabled = running;
        const gate = gateWhy(store.get(), view.submitting || running, "A measurement");
        const w = running ? null : gate || (!sel.length ? { key: "locked.no_units", vars: {} } : null);
        measureBtn.hidden = running;
        cancelBtn.hidden = !running;
        measureBtn.disabled = !!w;
        cancelBtn.disabled = view.cancelling;
        setButton(measureBtn, { cost: estimateCost(cv.mode, sel.length) });
        setButton(cancelBtn, { label: view.cancelling ? "Cancelling" : "Cancel" });
        setWhy(measureWhy, w ? w.key : null, w ? w.vars : {});
        turbo.hidden = !cv.noTurbo;
        run.hidden = !running;
        if (view.progress) {
          setProgress(rule, view.progress.of ? view.progress.step / view.progress.of : 0);
          progress.textContent = view.progress.text;
        }
        status.textContent = view.listProblem || (running && view.progress && view.progress.line ? `${view.progress.line}. The chart fills as each point arrives.` : view.status);
        problems.hidden = view.problems.length === 0;
        clear(problems).append(...view.problems.map((x) => h("li", { text: x })));
        chartP.el.hidden = cv.view !== "chart";
        tableP.el.hidden = cv.view !== "table";
        libP.el.hidden = cv.view !== "library";
        main.setAttribute("aria-labelledby", `cv-tab-${cv.view}`);
        if (cv.view === "chart") renderChart();
        else if (cv.view === "table") renderTable();
        else renderLibrary();
      }
      // vf.point events arrive many times a second on a dense run: repaint at most once per frame
      let queued = false;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
      const paintSoon = () => {
        if (queued) return;
        queued = true;
        raf(() => {
          queued = false;
          if (root.isConnected !== false) render();
        });
      };
      subs.push(() => plot.dispose());
      subs.push(ctl.subscribe(paintSoon));
      let lastGate = JSON.stringify(gateWhy(store.get(), false));
      subs.push(store.subscribe((s, prev) => {
        const g = JSON.stringify(gateWhy(s, false));
        if (s.link !== prev.link || s.preflight !== prev.preflight || g !== lastGate) {
          lastGate = g;
          paintSoon();
        }
      }));
      render();
      if (store.get().link.state === "connected") {
        if (!cv.loaded) ctl.loadCurves(false);
        if (!cv.words) ctl.loadWords();
      }
    },
    unmount() {
      subs.splice(0).forEach((u) => u());
    },
  };
}

/** The Measure button's cost tag: "~2 min" for the selected units. */
export function estimateCost(mode, n) {
  if (!(n > 0)) return ""; // no unit checked, nothing to measure, no estimate (QA-37)
  const secs = (MEASURE_SECONDS[mode] * n) / MEASURE_REF_UNITS;
  return secs < 90 ? `~${Math.round(secs)} s` : `~${Math.round(secs / 60)} min`;
}
