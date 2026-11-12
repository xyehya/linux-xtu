// views/dashboard.js: the Overview screen (desktop/DESIGN.md §9.1; route id stays "dashboard"). Panels in reading order: UNITS · LIVE (the unit table with
// live Clock / Busy (bar-in-cell) / VID / Temp columns and the factory top ratio), HISTORY (four small multiples on the plot core — package power,
// highest clock, hottest sensor, Vcore — one time axis, one cursor, direct labels), LIMITS NOW (each throttle legend in plain words and where to change
// it) with the recent THROTTLE EVENTS, STATE (accepted state, last read, last quick screen, mailbox requests as one quiet line) and MEMORY.
// The six live values live only in the readout bar (V-05): nothing here repeats them as tiles. No donut (V-22), no tinted heat tiles (V-06).
// Every reading that is unavailable shows "n/a" and its reason ONCE (a table footnote or a band meta), never 0 and never a guess. Reads only:
// telemetry and throttle.tail are not mailbox traffic; mem.read runs only on its button.
import { h, clear } from "../components/dom.js";
import { fmtNum, fmtClock, NA } from "../components/fmt.js";
import { SERIES, setThrottleEvents, HISTORY_S, appendChartSample } from "../store.js";

// the history buffer lives in the store (QA-36); re-exported for callers and tests that import it from here
export { HISTORY_S, appendChartSample };
import { createUnitTable, unitsFromTopology } from "../components/unit-table.js";
import { createPlot, niceTicks } from "../components/plot.js";
import { createSegmented } from "../components/segmented.js";
import { panel, kv, emptyState, progressRule } from "../components/panel.js";
import { button, setButton } from "../components/buttons.js";
import { annunciator, setAnn } from "../components/ann.js";
import { LIMIT_ANNS, limitAnnModel, eventModel, visibleEvents, createLimits, EVENTS_POLL_MS, EVENTS_N } from "../components/throttle.js";
import { setText } from "../components/help.js";
import { EMPTY } from "../lib/hints.js";
import { powerCurrent } from "../lib/rtstate.js";
import { MINUS } from "../lib/format.js";
import { stressController, screenText, fmtLen, fmtDate } from "./stress.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export const WINDOWS = [
  { value: "60", label: "1 min", s: 60 },
  { value: "300", label: "5 min", s: 300 },
  { value: "900", label: "15 min", s: 900 },
];
export const EVENTS_SHOWN = EVENTS_N; // G-248: the events list fills the panel's height and scrolls inside it, so it shows everything the helper returned

// ---------------------------------------------------------------- live readings per unit (pure; also used by Stress)
const NO_CORE_TEMP = { value: null, status: "unavailable", reason: "no per-core temperature sensor in this sample", unit: "C" };
const NO_READING = { value: null, status: "unavailable", reason: "not reported", unit: "" };

/** Temperature readings keyed by CPU number (a sensor entry carries `cpu`); sensors without a cpu (Package, …) are not per-core. */
export function tempsByCpu(temps) {
  const out = {};
  if (!isObj(temps)) return out;
  for (const k of Object.keys(temps)) {
    const t = temps[k];
    if (!isObj(t)) continue;
    const cpu = isNum(t.cpu) ? String(t.cpu) : typeof t.cpu === "string" && /^\d+$/.test(t.cpu) ? t.cpu : null;
    if (cpu !== null) out[cpu] = t;
  }
  return out;
}

/** The raw reading of `metric` (mhz | busy | vid | ratio | temp) for `cpu` in a telemetry `values` object. */
export function coreReading(values, cpu, metric) {
  const key = String(cpu);
  if (metric === "temp") return tempsByCpu(values && values.temps)[key] || NO_CORE_TEMP;
  const core = values && isObj(values.cores) && isObj(values.cores[key]) ? values.cores[key] : null;
  const r = core ? core[metric] : null;
  return isObj(r) ? r : NO_READING;
}

/** {value: number|null, reason: string|null, source} from a reading; unavailable stays unavailable. */
export function readingValue(r) {
  if (isObj(r) && isNum(r.value) && r.status !== "unavailable") return { value: r.value, reason: null, source: r.source || "" };
  return { value: null, reason: isObj(r) && typeof r.reason === "string" && r.reason ? r.reason : "no reading", source: isObj(r) && r.source ? r.source : "" };
}

/** One unit's live values from its CPUs: clock and busy = mean, VID and temperature = highest. {mhz, busy, vid, temp, why: {metric: reason}}. */
export function unitLive(values, cpus) {
  const out = { mhz: null, busy: null, vid: null, temp: null, why: {} };
  const list = Array.isArray(cpus) ? cpus : [];
  for (const [m, agg] of [["mhz", "mean"], ["busy", "mean"], ["vid", "max"], ["temp", "max"]]) {
    const rs = list.map((c) => readingValue(coreReading(values, c, m)));
    const vs = rs.map((r) => r.value).filter(isNum);
    if (vs.length) out[m] = agg === "mean" ? vs.reduce((a, b) => a + b, 0) / vs.length : Math.max(...vs);
    else out.why[m] = values ? (rs.find((r) => r.reason) || {}).reason || "no reading" : "no telemetry yet";
  }
  return out;
}

/** The Overview's unit rows: topology units (D-036: never a made-up layout) with the factory top ratio and the live values. */
export function overviewRows(topology, values) {
  const byId = new Map((topology && Array.isArray(topology.units) ? topology.units : []).filter(isObj).map((u) => [u.id, u]));
  return unitsFromTopology(topology).map((u) => {
    const t = byId.get(u.id) || {};
    return { ...u, top: isNum(t.max_ratio) ? t.max_ratio : null, maxKhz: isNum(t.max_khz) ? t.max_khz : null, live: unitLive(values, u.cpus) };
  });
}

export const LIVE_COLS = [
  { key: "clock", label: "Clock", unit: "GHz", metric: "mhz", hint: "overview.clock" },
  { key: "busy", label: "Busy", unit: "%", metric: "busy", hint: "overview.busy" },
  { key: "vid", label: "VID", unit: "V", metric: "vid", hint: "overview.vid" },
  { key: "temp", label: "Temp", unit: "°C", metric: "temp", hint: "overview.temp" },
];

/** Cell text of a live column for one row: {text, na}. */
export function liveCell(row, key) {
  const v = row.live;
  if (key === "clock") return isNum(v.mhz) ? { text: (v.mhz / 1000).toFixed(2), na: false } : { text: NA, na: true };
  if (key === "busy") return isNum(v.busy) ? { text: Math.round(v.busy).toString(), na: false } : { text: NA, na: true };
  if (key === "vid") return isNum(v.vid) ? { text: v.vid.toFixed(3), na: false } : { text: NA, na: true };
  if (key === "temp") return isNum(v.temp) ? { text: Math.round(v.temp).toString(), na: false } : { text: NA, na: true };
  return { text: "", na: false };
}

/** The table footnote: each unavailable column with its reason, said once ("Temp n/a: no per-core temperature sensor in this sample."). */
export function liveFootnote(rows) {
  const parts = [];
  for (const c of LIVE_COLS) {
    const why = [...new Set(rows.map((r) => r.live.why[c.metric]).filter(Boolean))];
    if (!why.length) continue;
    const all = rows.every((r) => r.live.why[c.metric]);
    parts.push(`${c.label} n/a${all ? "" : " for some units"}: ${why.join("; ")}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------- history (pure)

/** A first buffer from the store's short history (one value per sample, newest last) so the plots are not empty on arrival. */
export function seedChart(history, t, intervalS = 1) {
  if (!isObj(history) || !isNum(t)) return [];
  const n = Math.max(0, ...SERIES.map((s) => (Array.isArray(history[s.key]) ? history[s.key].length : 0)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = {};
    for (const s of SERIES) {
      const arr = Array.isArray(history[s.key]) ? history[s.key] : [];
      const j = arr.length - n + i;
      v[s.key] = j >= 0 && isNum(arr[j]) ? arr[j] : null;
    }
    out.push({ t: t - (n - 1 - i) * intervalS, v });
  }
  return out;
}

/** Reasons for series that have no reading: {key: reason}. */
export function chartReasons(telemetry) {
  const out = {};
  if (!telemetry || !telemetry.samples) return out;
  for (const s of SERIES) {
    const smp = telemetry.samples[s.key];
    if (smp && smp.value === null && smp.reason) out[s.key] = smp.reason;
  }
  return out;
}

/** The four small multiples: series key, y title, display scale, digits, unit, minimum span, floor. */
export const MULTIPLES = [
  { key: "pkg_power", title: "Package W", short: "PKG", unit: "W", k: 1, digits: 1, minSpan: 20, floor: 0 },
  { key: "clock", title: "Highest clock GHz", short: "CLK", unit: "GHz", k: 0.001, digits: 2, minSpan: 0.5, floor: 0 },
  { key: "temp", title: "Hottest °C", short: "HOT", unit: "°C", k: 1, digits: 0, minSpan: 10, floor: null },
  { key: "vcore", title: "Vcore V", short: "VCORE", unit: "V", k: 1, digits: 3, minSpan: 0.05, floor: null },
];

/** "−30 s" / "−5 min" for a tick `rel` seconds before now. */
export function agoText(rel) {
  const s = Math.round(Math.abs(rel));
  if (s === 0) return "now";
  return `${MINUS}${s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`}`;
}

/**
 * One small multiple as a plot spec: {x: {min, max, ticks}, y: {min, max}, traces, refs, labels, cursorXs, last}. `buf` = appendChartSample buffer,
 * `refs` = [{y, label}] in display units (PL1/PL2 on package power). x is absolute seconds; ticks are placed at whole "seconds ago" steps.
 */
export function multipleSpec(def, buf, { now, windowS, refs = [] }) {
  const lo = now - windowS;
  const pts = buf.filter((p) => p.t >= lo && p.t <= now + 1e-6);
  const segs = [];
  let cur = [];
  for (const p of pts) {
    const v = p.v[def.key];
    if (isNum(v)) cur.push([p.t, v * def.k]);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  const ys = segs.flat().map((q) => q[1]);
  const keptRefs = refs.filter((r) => isNum(r.y));
  let ymin = ys.length ? Math.min(...ys) : 0;
  let ymax = ys.length ? Math.max(...ys) : def.minSpan;
  for (const r of keptRefs) {
    ymin = Math.min(ymin, r.y);
    ymax = Math.max(ymax, r.y);
  }
  if (ymax - ymin < def.minSpan) {
    const mid = (ymax + ymin) / 2;
    ymin = mid - def.minSpan / 2;
    ymax = mid + def.minSpan / 2;
  }
  if (def.floor !== null && ymin < def.floor) {
    ymax += def.floor - ymin;
    ymin = def.floor;
  }
  const yt = niceTicks(ymin, ymax, 3);
  const step = yt.length > 1 ? yt[1] - yt[0] : def.minSpan;
  const y = { min: Math.min(ymin, Math.floor(ymin / step) * step), max: Math.max(ymax, Math.ceil(ymax / step) * step) };
  if (def.floor !== null) y.min = Math.max(def.floor, y.min);
  y.ticks = niceTicks(y.min, y.max, 3);
  const relTicks = niceTicks(-windowS, 0, 4).filter((r) => r <= 0);
  const last = segs.length ? segs[segs.length - 1][segs[segs.length - 1].length - 1] : null;
  if (!segs.length) {
    // nothing to draw: no made-up scale, just "n/a" in the plot (the reason is said once, in the panel's footnote)
    return { x: { min: lo, max: now, ticks: relTicks.map((r) => now + r), rel: relTicks }, y: { min: 0, max: 1, ticks: [] }, traces: [], refs: [], labels: [{ x: lo + windowS / 2, y: 0.5, text: NA, kind: "dim", anchor: "middle" }], cursorXs: [], last: null };
  }
  return {
    x: { min: lo, max: now, ticks: relTicks.map((r) => now + r), rel: relTicks },
    y,
    traces: segs.map((s) => ({ kind: "meas", pts: s })),
    refs: keptRefs.map((r) => ({ y: r.y, label: r.label })),
    labels: last ? [{ x: last[0], y: last[1], text: ` ${last[1].toFixed(def.digits)} ${def.unit}`, kind: "strong", anchor: "start" }] : [],
    cursorXs: pts.map((p) => p.t),
    last,
  };
}

// ---------------------------------------------------------------- limits and events (pure)

const LIMIT_WORDS = {
  pl1: { on: "long-term power limit holds the clock", off: "not binding" },
  pl2: { on: "short-term power limit holds the clock", off: "not binding" },
  pl4: { on: "electrical peak limit trips", off: "not tripping" },
  therm: { on: "thermal limit holds the clock", off: "not limiting" },
  vr: { on: "voltage regulator thermal alert", off: "not limiting" },
  turbo: { on: "turbo table caps the ratio · normal under load", off: "not capping" },
};
export const LIMIT_GOTO = { pl1: ["tune", "power", "Tune › Power"], pl2: ["tune", "power", "Tune › Power"], pl4: ["tune", "power", "Tune › Power"], turbo: ["tune", "turbo", "Tune › Frequency"] };

/** Rows of LIMITS NOW: [{key, label, hint, state, duty, on, words, detail, goto}]. `power` = {pl1_w, pl2_w} in force (or nulls), `pkg` = package W now. */
export function limitsNowRows(throttle, { connected = true, power = null, pkg = null } = {}) {
  const ann = limitAnnModel(throttle, { connected });
  return LIMIT_ANNS.map((a, i) => {
    const m = ann[i];
    const w = LIMIT_WORDS[a.key];
    const na = !throttle || throttle.state === "na";
    let detail = "";
    if (m.on && (a.key === "pl1" || a.key === "pl2")) {
      const lim = power ? power[a.key === "pl1" ? "pl1_w" : "pl2_w"] : null;
      detail = [isNum(pkg) ? `package ${pkg.toFixed(0)} W` : "", isNum(lim) ? `limit ${lim.toFixed(0)} W` : ""].filter(Boolean).join(" of ");
    }
    return { key: a.key, label: a.label, hint: a.hint, state: m.state, duty: m.duty, on: m.on, words: na ? NA : m.on ? w.on : w.off, detail, goto: LIMIT_GOTO[a.key] || null };
  });
}

/** One throttle.jsonl record in plain words: {key, when, text, bad}. */
export function eventLine(r) {
  const m = eventModel(r);
  if (m.bad) return { key: "", when: "", text: m.text, bad: true };
  const t = isObj(r) && isNum(r.t_on) ? fmtClock(r.t_on) : NA;
  const peaks = [isNum(r.peak_pkg_w) ? `${r.peak_pkg_w.toFixed(0)} W` : "", isNum(r.peak_temp_c) ? `${r.peak_temp_c.toFixed(0)} °C` : ""].filter(Boolean).join(", ");
  const text = `${m.group} held the clock for ${m.duration}${m.duty !== NA ? `, ${m.duty} of the time` : ""}${peaks ? ` · peak ${peaks}` : ""}${m.kernel ? ` · ${m.kernel}` : ""}`;
  return { key: m.key, when: t, text, bad: false };
}

// ---------------------------------------------------------------- state (pure)

const ACCEPTED_WORDS = { matches: "matches the CPU", equivalent: "matches the CPU (after the V(n) ≥ V(n−1) rule)", unknown: "no accepted state to compare with" };
export function acceptedLine(acc) {
  if (!acc) return ACCEPTED_WORDS.unknown;
  if (acc.kind === "differs") return `differs in ${acc.n} ${acc.n === 1 ? "unit" : "units"}`;
  return ACCEPTED_WORDS[acc.kind] || ACCEPTED_WORDS.unknown;
}

/** The last quick screen as one line ("clean · CPU integer · 5 min · Oct 18 10:29"), or a reason. */
export function lastScreenLine(list, loaded) {
  if (!loaded) return "not loaded yet";
  const r = Array.isArray(list) && list.length ? list[0] : null;
  if (!r) return "none on this computer";
  const n = isNum(r.errors) ? r.errors : 0;
  const word = n > 0 ? `${n} ${n === 1 ? "error" : "errors"}` : r.stopped_by === "cancel" ? "stopped" : r.stopped_by === "error" ? "tool error" : r.health && r.health !== "clean" ? "health changed" : "clean";
  return `${word} · ${screenText(r)} · ${fmtLen(r.duration_s)} · ${fmtDate(r.started)}`;
}

/** Mailbox requests this boot as a quiet line. */
export function mbxLine(op) {
  const used = op && isNum(op.opsUsed) ? op.opsUsed : null;
  const cap = op && isNum(op.opsBudget) && op.opsBudget > 0 ? op.opsBudget : null;
  return used === null ? NA : `${used} this boot${cap === null ? "" : ` · cap ${cap}`}`;
}

/** Memory panel model from a mem.read result. -> {available:false, reason} | {available:true, headline, primary, rows:[[k,v]], dimms, summary} */
export function memModel(r) {
  if (!isObj(r)) return { available: false, reason: "the helper gave no answer" };
  if (r.available !== true) return { available: false, reason: typeof r.reason === "string" && r.reason ? r.reason : "the helper gave no reason" };
  const t = isObj(r.timings) ? r.timings : {};
  const tm = (k) => (isNum(t[k]) ? String(t[k]) : NA);
  const cc = isObj(r.cross_check) ? r.cross_check : {};
  const dimms = (Array.isArray(r.dimms) ? r.dimms : []).filter(isObj).map((d) => ({
    locator: String(d.locator ?? ""),
    desc: [d.size, d.part, d.manufacturer].filter(Boolean).join(" · "),
    temp: isObj(d.temp_c) ? (isNum(d.temp_c.value) && d.temp_c.status !== "unavailable" ? d.temp_c.value : null) : isNum(d.temp_c) ? d.temp_c : null,
    tempReason: isObj(d.temp_c) && typeof d.temp_c.reason === "string" ? d.temp_c.reason : "no reading",
  }));
  return {
    available: true,
    headline: `${isNum(r.mts) ? "DDR5-" + r.mts : "DDR5"} · Gear ${isNum(r.gear) ? r.gear : NA} · ${typeof r.cmd_rate === "string" ? r.cmd_rate : NA}`,
    primary: ["tCL", "tRCD", "tRP", "tRAS"].map(tm).join("-"),
    rows: [
      ["tRFC", tm("tRFC")],
      ["tREFI", tm("tREFI")],
      ["Memory clock", isNum(r.qclk_mhz) ? `${r.qclk_mhz.toFixed(1)} MHz` : NA],
      ["BCLK", isNum(r.bclk_mhz) ? `${r.bclk_mhz.toFixed(1)} MHz` : NA],
      ["Peak bandwidth", isNum(r.max_bandwidth_mbs) ? `${(r.max_bandwidth_mbs / 1000).toFixed(1)} GB/s` : NA],
      ["Cross-check", cc.agree === true ? "agrees" : cc.agree === false ? "disagrees" : NA],
    ],
    dimms,
    summary: `${dimms.length} ${dimms.length === 1 ? "module" : "modules"}${isNum(r.instances_ok) ? `, read from ${r.instances_ok} controller instances` : ""}`,
  };
}

/** "3 s ago" style age; null time = "no samples yet". */
export function ageText(t, nowS) {
  if (!isNum(t)) return "no samples yet";
  const d = Math.max(0, Math.round(nowS - t));
  return d < 2 ? "just now" : d < 120 ? `${d} s ago` : `${Math.round(d / 60)} min ago`;
}

/** The work header's grey subtitle: "live · 1 s" / "waiting · last sample 12 s ago" / "helper not connected". */
export function headSub(link, t, nowS) {
  if (!link || link.state !== "connected") return "helper not connected";
  const live = isNum(t) && nowS - t < 6;
  return live ? "live · 1 s" : `waiting · last sample ${ageText(t, nowS)}`;
}

// ---------------------------------------------------------------- view state kept across mounts (per store)
const PREFS = new WeakMap(); // store -> {windowS}
const MEM = new WeakMap(); // store -> memory panel state {phase, result, error}

export function dashboardView() {
  const subs = [];
  let timer = null;
  let poll = null;
  return {
    id: "dashboard",
    lx: true,
    mount(root, ctx) {
      const { store, bridge } = ctx;
      const prefs = PREFS.get(store) || { windowS: 60 };
      PREFS.set(store, prefs);
      const goto = (s, tab) => ctx.goto && ctx.goto(s, tab);

      // ---- work header: subtitle + the history window
      const win = createSegmented({ options: WINDOWS.map((w) => ({ value: w.value, label: w.label })), value: String(prefs.windowS), label: "History window", hint: "overview.window", id: "ov-window", onChange: (v) => { prefs.windowS = Number(v); drawHistory(); } });
      const setHead = () => ctx.head && ctx.head.set({ sub: headSub(store.get().link, store.get().telemetry.t, Date.now() / 1000), end: [win.el] });
      setHead();

      // ---- UNITS · LIVE
      let rows = [];
      const rowOf = new Map();
      const cols = [
        ...LIVE_COLS.map((c) => ({
          key: c.key, label: c.label, unit: c.unit, num: c.key !== "busy", hint: c.hint,
          value: (u) => {
            const cell = liveCell(rowOf.get(u.id) || { live: { why: {} } }, c.key);
            return cell.na ? { text: NA, na: true } : cell.text;
          },
          bar: c.key === "busy" ? (u) => { const r = rowOf.get(u.id); return r && isNum(r.live.busy) ? r.live.busy / 100 : null; } : undefined,
        })),
        { key: "top", label: "Curve top", unit: "×", num: true, hint: "unit.top", wide: true, value: (u) => { const r = rowOf.get(u.id); return r && isNum(r.top) ? { text: String(r.top), v: "base" } : null; } },
      ];
      const ut = createUnitTable({ columns: cols, select: "none", label: "Units, live", id: "ov-units" });
      const unitsFoot = h("div", { class: "lx-tfoot-note", id: "ov-units-note", hidden: true });
      const unitsEmpty = emptyState({ title: EMPTY["overview.notopology"].title, teach: EMPTY["overview.notopology"].teach, id: "ov-units-empty" });
      const unitsP = panel({ title: "Units · live", meta: "", id: "ov-units-panel", flush: true, body: [ut.el, unitsFoot, unitsEmpty] });
      unitsP.el.dataset.hint = "overview.units";
      let topoKey = "";
      const drawUnits = () => {
        const st = store.get();
        const topo = st.preflight ? st.preflight.topology : null;
        rows = overviewRows(topo, st.telemetry.values);
        rowOf.clear();
        for (const r of rows) rowOf.set(r.id, r);
        const key = rows.map((r) => r.id + (r.fav ? "*" : "")).join(",");
        if (key !== topoKey) {
          topoKey = key;
          ut.setUnits(rows);
        } else ut.refresh();
        ut.el.hidden = !rows.length;
        unitsEmpty.hidden = rows.length > 0;
        const note = rows.length ? liveFootnote(rows) : "";
        unitsFoot.textContent = note;
        unitsFoot.hidden = !note;
        const p = rows.filter((r) => r.kind === "P").length;
        const e = rows.filter((r) => r.kind === "E").length;
        unitsP.setMeta(rows.length ? [h("span", { class: "lx-mono", text: String(p) }), " P-cores · ", h("span", { class: "lx-mono", text: String(e) }), " E-clusters"] : "");
      };

      // ---- HISTORY: four small multiples, one time axis, one cursor
      const plots = MULTIPLES.map((def, i) => {
        const last = i === MULTIPLES.length - 1;
        const x = { min: 0, max: 1, ticks: [], fmt: () => "" };
        const y = { min: 0, max: 1, title: def.title, fmt: (t) => fmtNum(t, def.digits > 1 ? (def.key === "vcore" ? 2 : 1) : 0) };
        let spec = null;
        const plot = createPlot({
          label: `${def.title} over time`, height: last ? 104 : 82, margin: { l: 44, r: 84, t: 18, b: last ? 26 : 6 }, x, y,
          readout: (xv) => {
            const p = spec && spec.traces.flatMap((t) => t.pts).find((q) => q[0] === xv);
            return [["", agoText(xv - x.max)], p ? ["", p[1].toFixed(def.digits), def.unit] : ["", NA]];
          },
        });
        plot.el.dataset.series = def.key;
        return { def, plot, x, y, last, setSpec: (s) => (spec = s) };
      });
      // one cursor for all four: the plot core calls api.setCursor from its own handlers, so wrapping it shares the cursor
      for (const p of plots) {
        const own = p.plot.setCursor.bind(p.plot);
        p.plot.setCursor = (xv) => {
          own(xv);
          for (const q of plots) if (q !== p && q.plot.cursor() !== (xv ?? null)) q.own(xv);
        };
        p.own = own;
      }
      const histNote = h("div", { class: "lx-tfoot-note", id: "ov-hist-note", hidden: true });
      const histP = panel({ title: "History", meta: "", id: "ov-history", body: [h("div", { class: "lx-ov-mult" }, ...plots.map((p) => p.plot.el)), histNote] });
      histP.el.dataset.hint = "overview.history";
      const drawHistory = () => {
        const st = store.get();
        const buf = st.telemetry.chart || []; // filled by the store on every telemetry event, whichever screen is open
        const now = buf.length ? Math.max(buf[buf.length - 1].t, st.telemetry.t || 0) : Date.now() / 1000;
        const pw = st.rt && st.rt.power && st.rt.power.result ? powerCurrent(st.rt.power.result) : null;
        for (const p of plots) {
          const refs = p.def.key === "pkg_power" && pw ? [{ y: pw.pl1_w, label: `PL1 ${isNum(pw.pl1_w) ? pw.pl1_w.toFixed(0) : ""}` }, { y: pw.pl2_w, label: `PL2 ${isNum(pw.pl2_w) ? pw.pl2_w.toFixed(0) : ""}` }] : [];
          const s = multipleSpec(p.def, buf, { now, windowS: prefs.windowS, refs });
          p.setSpec(s);
          Object.assign(p.x, { min: s.x.min, max: s.x.max, ticks: p.last ? s.x.ticks : [], fmt: (t) => agoText(t - now) });
          Object.assign(p.y, { min: s.y.min, max: s.y.max, ticks: s.y.ticks });
          p.plot.draw({ traces: s.traces, refs: s.refs, labels: s.labels, cursorXs: s.cursorXs });
          p.plot.el.dataset.empty = s.traces.length ? "false" : "true";
        }
        const why = chartReasons(st.telemetry);
        const na = MULTIPLES.filter((d) => why[d.key]).map((d) => `${d.short} n/a: ${why[d.key]}.`);
        histNote.textContent = na.join(" ");
        histNote.hidden = !na.length;
        histP.setMeta(buf.length ? `last ${WINDOWS.find((w) => w.s === prefs.windowS).label} · ${buf.length} samples kept` : "no samples yet");
      };

      // ---- LIMITS NOW + THROTTLE EVENTS
      const limTbody = h("tbody");
      const limRows = new Map();
      // QA-40: a row opens the same "Limit reasons" popover as the bottom bar (its own instance, anchored to the row's legend; the bar's chips are not rebuilt)
      const limPop = createLimits(store, { goto, caption: false, id: "ov-lim" });
      subs.push(() => limPop.dispose());
      for (const a of LIMIT_ANNS) {
        const ann = annunciator({ label: a.label, ann: a.key, id: `ov-ann-${a.key}`, onClick: () => limPop.openAt(ann) });
        const words = h("td", { dataset: { col: "words" } });
        const go = LIMIT_GOTO[a.key] ? button({ level: 0, label: LIMIT_GOTO[a.key][2], attrs: { "data-goto": a.key }, onClick: () => goto(LIMIT_GOTO[a.key][0], LIMIT_GOTO[a.key][1]) }) : null;
        const tr = h("tr", { dataset: { limit: a.key, hint: a.hint }, on: { click: (e) => { if (!e.target.closest || !e.target.closest("button")) limPop.openAt(ann); } } }, h("td", { class: "lx-ov-ann" }, ann), words, h("td", { class: "lx-ov-go" }, go));
        limRows.set(a.key, { tr, ann, words });
        limTbody.append(tr);
      }
      const limTable = h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", id: "ov-limits", "aria-label": "Limits now" }, limTbody);
      const evBody = h("div", { id: "ov-events" });
      const evRefresh = button({ level: 1, label: "Refresh", cost: "0 req", id: "ov-events-refresh", hint: "overview.events", onClick: () => refreshEvents() });
      const evMeta = h("span", { class: "lx-band-m", id: "ov-events-meta" });
      const evBand = h("div", { class: "lx-band lx-band--top" }, h("span", { class: "lx-band-t", text: "Throttle events" }), evMeta, h("span", { class: "lx-band-end" }, evRefresh));
      const limP = panel({ title: "Limits now", meta: "", id: "ov-limits-panel", flush: true, body: [limTable, evBand, evBody] });
      limP.el.dataset.hint = "overview.limits";
      const drawLimits = () => {
        const st = store.get();
        const pw = st.rt && st.rt.power && st.rt.power.result ? powerCurrent(st.rt.power.result) : null;
        const pkg = st.telemetry.samples && st.telemetry.samples.pkg_power ? st.telemetry.samples.pkg_power.value : null;
        const thr = st.telemetry.throttle;
        for (const r of limitsNowRows(thr, { connected: st.link.state === "connected", power: pw, pkg })) {
          const e = limRows.get(r.key);
          setAnn(e.ann, { state: r.state, duty: r.duty });
          const text = r.detail ? `${r.words} · ${r.detail}` : r.words;
          if (e.words.textContent !== text) e.words.textContent = text;
          e.tr.dataset.on = r.on ? "true" : "false";
        }
        limP.setMeta(!thr || thr.state === "na" ? `n/a · ${(thr && thr.reason) || "no telemetry yet"}` : `${thr.source}${thr.windowS ? ` · last ${fmtNum(thr.windowS, 1)} s` : ""}`);
      };
      let evSig = null; // G-248 (G-247 follow-up): the table is rebuilt only when what it shows changed
      const drawEvents = () => {
        const st = store.get();
        const ev = st.throttleEvents;
        let note = "";
        if (ev.state === "loading" && !ev.records.length) note = "reading the log…";
        else if (ev.state === "error") note = `n/a · ${ev.error}`;
        const list = ev.state === "error" ? [] : visibleEvents(ev.records, st.throttleSession.resetAt, false).slice(0, EVENTS_SHOWN);
        if (!note) note = list.length ? `newest first · ${list.length} of ${ev.records.length}` : ev.state === "idle" ? "not read yet" : "none logged";
        setText(evMeta, note);
        const lines = list.map(eventLine);
        const sig = JSON.stringify(lines.map((l) => [l.key, l.when, l.text, !!l.bad]));
        if (sig === evSig) return;
        evSig = sig;
        clear(evBody);
        if (!list.length) return;
        const tb = h("tbody");
        for (const l of lines) {
          tb.append(h("tr", { dataset: { event: l.key } }, h("td", { class: "lx-n lx-ov-when", text: l.when }), h("td", { class: l.bad ? "lx-na" : "", text: l.text })));
        }
        evBody.append(h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", "aria-label": "Recent throttle events" }, tb));
      };
      let stopped = false;
      async function refreshEvents() {
        setThrottleEvents(store, { state: "loading", error: null });
        let res;
        try {
          res = await bridge.call("throttle.tail", { n: EVENTS_N });
        } catch (e) {
          res = { ok: false, error: { message: e && e.message ? e.message : String(e) } };
        }
        if (stopped) return;
        if (res && res.ok && res.result && Array.isArray(res.result.records)) setThrottleEvents(store, { state: "ok", records: res.result.records, path: res.result.path || null, truncated: !!res.result.truncated, error: null, at: Date.now() / 1000 });
        else {
          setThrottleEvents(store, { state: "error", error: (res && res.error && res.error.message) || "the helper gave no event list", records: [] });
          if (res && res.error && res.error.code === "UNKNOWN_OP" && poll) {
            clearInterval(poll); // a helper without throttle.tail will not grow one; Refresh still asks
            poll = null;
          }
        }
      }

      // ---- STATE
      const stressCtl = stressController(ctx);
      const accVal = h("span", { id: "ov-accepted" });
      const readVal = h("span", { class: "lx-mono", id: "ov-lastread" });
      const uvpVal = h("span", { id: "ov-uvp" });
      const screenVal = h("span", { id: "ov-lastscreen" });
      const mbxVal = h("span", { class: "lx-mono", id: "ov-mbx", dataset: { hint: "state.mbx" } });
      const toProfiles = button({ level: 0, label: "Profiles ›", id: "ov-to-profiles", hint: "state.accepted", onClick: () => goto("profiles") });
      const toStress = button({ level: 0, label: "Stress ›", id: "ov-to-stress", hint: "stress.screen", onClick: () => goto("stress") });
      const stateP = panel({ title: "State", id: "ov-state", body: [kv([["Accepted state", [accVal, " ", toProfiles]], ["Last read", readVal], ["Undervolt Protection", uvpVal], ["Last quick screen", [screenVal, " ", toStress]], ["Mailbox requests", mbxVal]])] });
      stateP.el.dataset.hint = "overview.state";
      const drawState = () => {
        const st = store.get();
        accVal.textContent = acceptedLine(st.accepted);
        accVal.dataset.accepted = st.accepted ? st.accepted.kind : "unknown";
        readVal.textContent = st.lastReadAt ? fmtClock(st.lastReadAt) : "not read this boot";
        uvpVal.textContent = st.uvp === "on" ? "on: negative offsets are refused" : st.uvp === "off" ? "off" : "not known yet (the first apply tells; a Read does not)";
        screenVal.textContent = lastScreenLine(stressCtl.view.list, stressCtl.view.loaded);
        mbxVal.textContent = mbxLine(st.helperOp);
      };

      // ---- MEMORY
      const memBody = h("div", { class: "lx-ov-mem", id: "mem-body" });
      const memBtn = button({ level: 1, label: "Read memory", cost: "1 req", id: "mem-read", hint: "overview.memory", onClick: () => readMemory() });
      const memRule = progressRule(0);
      memRule.hidden = true;
      const memP = panel({ title: "Memory", id: "ov-memory", end: memBtn, body: [memRule, memBody] });
      let memSig = null; // G-248: the body is rebuilt only when the memory answer changed
      const drawMem = () => {
        const m = MEM.get(store) || { phase: "idle" };
        if (m.phase === "done") {
          const sig = JSON.stringify(m.result);
          if (sig !== memSig) clear(memBody);
          memSig = sig;
        } else if (m.phase !== "loading") { // a re-read keeps what is shown until the new answer arrives
          clear(memBody);
          memSig = null;
        }
        memBtn.disabled = m.phase === "loading";
        memRule.hidden = m.phase !== "loading";
        setButton(memBtn, { label: m.phase === "loading" ? "Reading memory" : "Read memory" });
        memP.el.dataset.phase = m.phase;
        if (m.phase === "idle") memP.setMeta("not read yet");
        else if (m.phase === "loading") memP.setMeta("reading…");
        else if (m.phase === "error") memP.setMeta(`n/a · ${m.error}`);
        else {
          const mm = memModel(m.result);
          if (!mm.available) memP.setMeta(`n/a · ${mm.reason}`);
          else {
            memP.setMeta(mm.summary);
            if (memBody.childNodes.length === 0) memBody.append(
              h("div", { class: "lx-ov-mem-head" }, h("span", { class: "lx-mono lx-ov-mem-big", text: mm.headline }), h("span", { class: "lx-mono lx-dim", text: mm.primary })),
              kv(mm.rows.map(([k, v]) => [k, v, { mono: true }])),
              h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", "aria-label": "Memory modules" },
                h("thead", {}, h("tr", {}, h("th", { text: "Module" }), h("th", { text: "Part" }), h("th", { class: "lx-n" }, "Temp", h("span", { class: "lx-hu", text: "°C" })))),
                h("tbody", {}, ...mm.dimms.map((d) => h("tr", {}, h("td", { class: "lx-k", text: d.locator }), h("td", { text: d.desc }), h("td", { class: "lx-n" }, d.temp === null ? h("span", { class: "lx-na", text: NA }) : d.temp.toFixed(0)))))),
            );
          }
        }
      };
      async function readMemory() {
        MEM.set(store, { phase: "loading" });
        drawMem();
        const res = await bridge.call("mem.read", {});
        MEM.set(store, res.ok ? { phase: "done", result: res.result } : { phase: "error", error: res.error && res.error.message ? res.error.message : "the helper could not read memory" });
        if (!stopped) drawMem();
      }

      root.append(h("div", { class: "lx-tiles lx-ov", id: "ov" }, unitsP.el, histP.el, limP.el, h("div", { class: "lx-ov-side" }, stateP.el, memP.el)));

      // ---- live wiring: telemetry ticks update cells in place; panels never rebuild a focused control
      subs.push(
        store.watch((s) => s.telemetry, () => { drawUnits(); drawHistory(); drawLimits(); setHead(); }),
        store.watch((s) => s.preflight, () => drawUnits()),
        store.watch((s) => s.link.state, (state) => { if (state === "connected") refreshEvents(); }),
        store.watch((s) => s.throttleEvents, () => drawEvents()),
        store.watch((s) => s.throttleSession.resetAt, () => drawEvents()),
        store.subscribe((s, prev) => {
          if (s.helperOp !== prev.helperOp || s.accepted !== prev.accepted || s.lastReadAt !== prev.lastReadAt || s.uvp !== prev.uvp) drawState();
          if (s.link !== prev.link) { setHead(); drawLimits(); }
          if (s.rt !== prev.rt) { drawLimits(); drawHistory(); }
        }),
        stressCtl.subscribe(drawState),
        () => plots.forEach((p) => p.plot.dispose()),
      );
      drawState();
      drawMem();
      poll = setInterval(() => { if (store.get().link.state === "connected") refreshEvents(); }, EVENTS_POLL_MS);
      timer = setInterval(setHead, 1000);
      subs.push(() => { stopped = true; });
    },
    unmount() {
      subs.splice(0).forEach((u) => u());
      if (timer) clearInterval(timer);
      if (poll) clearInterval(poll);
      timer = null;
      poll = null;
    },
  };
}
