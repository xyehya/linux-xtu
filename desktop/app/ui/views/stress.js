// views/stress.js: the Stress screen (desktop/DESIGN.md §9.8, D-019): a quick screen for an unstable setting, never an acceptance gate. Ops: stress.start /
// stress.stop / stress.list. Layout: SETUP (what will be tested — the state the CPU holds now, and a visible warning when Tune holds edits that are not
// applied — the load, its kind and length with each preset said in plain words, the ratio hold, Start stress L3 with its duration) · UNITS TO LOAD (the
// unit table with checkboxes and live Clock / Busy) · LIVE (one mono timer readout + progress rule, errors / hottest / peak power, package power and
// temperature over the run on the plot core, then the result stated plainly with what to do next) · EARLIER SCREENS (the history, result words, the state
// tested where it was recorded). The run state lives in a controller keyed by the bridge, so a result that arrives while another screen is open is kept.
// Also home of what views/curves.js and the Overview share: unitModel / favMark / cpuSub / unitTitle / quickSets / gateWhy / opGate / errText / fmtDate.
import { h, clear } from "../components/dom.js";
import { fmtNum, fmtClock, NA } from "../components/fmt.js";
import { createUnitTable, unitsFromTopology } from "../components/unit-table.js";
import { createSegmented } from "../components/segmented.js";
import { createPlot, niceTicks } from "../components/plot.js";
import { createField } from "../components/field.js";
import { panel, kv, box, emptyState, progressRule, setProgress } from "../components/panel.js";
import { button, setButton } from "../components/buttons.js";
import { tag } from "../components/ann.js";
import { why, setWhy, openTips } from "../components/help.js";
import { isApplyClose } from "./audit.js";
import { HINTS, EMPTY } from "../lib/hints.js";
import { isNum, TIMES, fmtLocalDateTime } from "../lib/format.js";
import { unitKind, unitLabel } from "../lib/units.js";
import { coreReading, readingValue, unitLive } from "./dashboard.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const setInert = (el, on) => (on ? el.setAttribute("inert", "") : el.removeAttribute("inert"));

/** The quick-screen box (D-019): always shown on the setup panel. */
export const BANNER_HEAD = "A quick screen, not an acceptance test";
export const BANNER_TEXT = HINTS["stress.screen"].line;

export const DURATIONS = [
  { value: 60, label: "1 min" },
  { value: 300, label: "5 min" },
  { value: 900, label: "15 min" },
  { value: 3600, label: "60 min" },
  { value: "custom", label: "Custom" },
];
export const METHODS = [
  { value: "integer", label: "Integer", hint: "stress.kind.integer" },
  { value: "vector-math", label: "Vector math", hint: "stress.kind.vector" },
  { value: "cache", label: "Cache", hint: "stress.kind.cache" },
];
export const METHOD_WORDS = { integer: "integer", "vector-math": "vector math", cache: "cache" };
export const MEM_MB = [1024, 2048, 4096, 8192, 16384, 32768];
export const DUR_MIN = 30;
export const DUR_MAX = 3600;
export const CAP_MIN = 8;
export const CAP_MAX = 60;

// ---------------------------------------------------------------- units (shared with Curves)

/** preflight.topology -> {ids (topology order), byId, favoredSource}; empty when the topology is not known (nothing is invented, D-036). */
export function unitModel(preflight) {
  const list = preflight && isObj(preflight.topology) && Array.isArray(preflight.topology.units) ? preflight.topology.units : [];
  const byId = {};
  const ids = [];
  for (const u of list) {
    if (!isObj(u) || !isStr(u.id) || byId[u.id]) continue;
    byId[u.id] = { id: u.id, kind: u.kind === "E" ? "E" : "P", cpus: Array.isArray(u.cpus) ? u.cpus.filter(isNum) : [], favored: u.favored === true, maxRatio: isNum(u.max_ratio) ? u.max_ratio : null };
    ids.push(u.id);
  }
  return { ids, byId, favoredSource: preflight && isObj(preflight.topology) && isStr(preflight.topology.favored_source) ? preflight.topology.favored_source : "" };
}
export const idsOfKind = (m, kind) => m.ids.filter((u) => unitKind(u) === kind);
export const favoredIds = (m) => m.ids.filter((u) => m.byId[u].favored);
export const favMark = (m, u) => (m.byId[u] && m.byId[u].favored ? " ★" : "");
export function cpuSub(m, u) {
  const c = m.byId[u] ? m.byId[u].cpus : [];
  return !c.length ? "" : c.length === 1 ? `CPU ${c[0]}` : `CPUs ${c[0]}–${c[c.length - 1]}`;
}
export function unitTitle(m, u) {
  const info = m.byId[u];
  return `${unitLabel(u)}${cpuSub(m, u) ? " · " + cpuSub(m, u) : ""}${info && info.favored ? ` · favored core${m.favoredSource ? " (" + m.favoredSource + ")" : ""}` : ""}${info && info.maxRatio ? ` · max ${info.maxRatio}${TIMES}` : ""}`;
}
/** The quick sets beside a unit table: [label, ids]. */
export function quickSets(m) {
  return [["All", m.ids], ["P-cores", idsOfKind(m, "P")], ["E-clusters", idsOfKind(m, "E")], ["None", []]];
}

/** Why a long operation cannot start now, as a WHY template {key, vars}, or null. `busy` = this screen's own run; `what` names it. */
export function gateWhy({ link, preflight, helperOp }, busy = false, what = "An operation") {
  if (!link || link.state !== "connected") return { key: "locked.no_link", vars: {} };
  if (preflight && preflight.mode === "refuse") return { key: "locked.preflight_refused", vars: {} };
  if (busy) return { key: "locked.busy", vars: { op: what } };
  if (helperOp && helperOp.state && helperOp.state !== "idle" && helperOp.state !== "disconnected") return { key: "locked.busy", vars: { op: `The helper is ${helperOp.state}; it` } };
  return null;
}

/** A unit table quick-set row: L0 buttons that select All / P-cores / E-clusters / None. */
const QUICK_SHORT = { All: "All", "P-cores": "P", "E-clusters": "E", None: "None" };
export function quickButtons(m, onPick, prefix) {
  return quickSets(m).map(([name, ids]) => button({ level: 0, label: QUICK_SHORT[name] || name, attrs: { "data-quick": name, "aria-label": `Select ${name === "None" ? "no units" : name === "All" ? "all units" : `the ${name}`}` }, id: `${prefix}-quick-${name.toLowerCase().replace(/[^a-z]/g, "")}`, onClick: () => onPick(ids) }));
}

const atMs = (x) => {
  const t = typeof x === "number" ? x * 1000 : typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * G-244 (QA-21): when the state the CPU holds was last established -- the newer of the last read and the last change (an apply or restore reads back what it wrote). Candidates:
 * `st.lastReadAt` (a read), `st.lastApplyAt` (the store's apply / restore result time, when the store keeps one) and `extra.changedAt` (what this screen's controller saw).
 * -> {at (ISO | null), what: "read" | "last change" | null}. A change at the same second as the read counts as the change.
 */
export function stateTime(st, extra = {}) {
  const read = st && st.lastReadAt ? atMs(st.lastReadAt) : null;
  let change = null;
  for (const c of [st && st.lastApplyAt, extra && extra.changedAt]) {
    const t = c ? atMs(c) : null;
    if (t !== null && (change === null || t > change)) change = t;
  }
  if (change !== null && (read === null || change >= read)) return { at: new Date(change).toISOString(), what: "last change" };
  if (read !== null) return { at: new Date(read).toISOString(), what: "read" };
  return { at: null, what: null };
}

/** What a run tests: the state the CPU holds now and the edits that are NOT part of it. Pure. -> {readAt, stateAt, accepted, edits, line} */
export function testedModel(st, extra = {}) {
  const edits = st && st.pending ? st.pending.changes | 0 : 0;
  const when = stateTime(st, extra);
  const readAt = when.at ? fmtClock(when.at) : null;
  const accepted = st && st.accepted ? st.accepted.kind : "unknown";
  const acc = st && st.accepted ? st.accepted : null;
  const accWords = !acc ? "" : acc.kind === "matches" || acc.kind === "equivalent" ? "= the accepted state" : acc.kind === "differs" ? `differs from the accepted state (${acc.n} ${acc.n === 1 ? "unit" : "units"})` : "";
  const parts = [readAt ? `what the CPU holds now (${when.what} ${readAt})` : "what the CPU holds now (not read this boot)", accWords];
  return { readAt, stateAt: when.at, stateWhat: when.what, accepted, edits, line: parts.filter(Boolean).join(" · ") };
}

// ---------------------------------------------------------------- pure rules (unit-tested)

export function fmtLen(s) {
  if (!isNum(s)) return NA;
  const t = Math.round(s);
  if (t >= 60 && t % 60 === 0) return `${t / 60} min`;
  if (t < 60) return `${t} s`;
  return mmss(t);
}
export function mmss(s) {
  const t = Math.max(0, Math.round(isNum(s) ? s : 0));
  const m = Math.floor(t / 60);
  const r = t % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}
/** "Nov 5 14:03" in the local zone (lib/format.js fmtLocalDateTime, the one date format of the UI: QA-34); "n/a" for anything that is not a date. */
export function fmtDate(x) {
  return fmtLocalDateTime(x) || NA;
}
const clampInt = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(x) || lo)));

export function initialStress() {
  return { kind: "cpu", method: "integer", dur: 300, custom: false, customS: 300, cap: null, memMb: null, sel: null };
}
export const stressDuration = (st) => (st.custom ? clampInt(st.customS, DUR_MIN, DUR_MAX) : st.dur);
export const selectedUnits = (st, ids) => (st.sel ? ids.filter((u) => st.sel.has(u)) : ids.slice());

/** The stress.start arguments (ops.rs stress_start): kind, duration_s 30..3600, method, units (omitted when every unit is loaded), ratio_cap 8..60, memory_mb. */
export function stressArgs(st, ids) {
  const args = { kind: st.kind, duration_s: stressDuration(st) };
  if (st.kind === "cpu") {
    args.method = st.method;
    const units = selectedUnits(st, ids);
    if (units.length < ids.length) args.units = units;
  } else if (st.memMb !== null) args.memory_mb = st.memMb;
  if (st.cap !== null) args.ratio_cap = st.cap;
  return args;
}

/** Why an op cannot start now ("" = it can). Mirrors the web's idleGate without the SSE/heartbeat parts (the bridge is the link). */
export function opGate({ link, preflight, helperOp }, busy = false) {
  if (!link || link.state !== "connected") return `The helper is not connected (${String((link && link.state) || "unknown").replace(/_/g, " ")}).`;
  if (preflight && preflight.mode === "refuse") return "Preflight refused this system. See System.";
  if (busy) return "A helper operation is running.";
  if (helperOp && helperOp.state && helperOp.state !== "idle") return `The helper is ${helperOp.state}.`;
  return "";
}

export function estimateText(st, ids, { running, stopping, gate }) {
  const none = st.kind === "cpu" && selectedUnits(st, ids).length === 0;
  if (running) return stopping ? "Stopping. The tool is ended and the cpufreq limits are put back." : "Running. Stop ends it early; the result is kept either way.";
  if (gate) return gate;
  if (!ids.length && st.kind === "cpu") return "The CPU topology is not known yet (preflight).";
  if (none) return "Select at least one unit.";
  const n = selectedUnits(st, ids).length;
  const what =
    st.kind === "cpu"
      ? `${METHOD_WORDS[st.method]} load on ${n === ids.length ? `all ${ids.length} units` : `${n} ${n === 1 ? "unit" : "units"}`}`
      : `memory test of ${st.memMb === null ? "3/4 of free memory" : st.memMb / 1024 + " GB"} on all CPUs`;
  return `Ready: ${what} for ${fmtLen(stressDuration(st))}${st.cap === null ? "" : `, capped at ${st.cap}${TIMES}`}. It raises power and heat for that time.`;
}

/** Words of a result. "No errors detected in N min" at most: nothing here says a setting is proven stable. */
export function stSummary(r) {
  const n = isNum(r.errors) ? r.errors : 0;
  const ran = fmtLen(Math.round(isNum(r.elapsed_s) ? r.elapsed_s : 0));
  if (r.stopped_by === "cancel") return `Stopped after ${ran} of ${fmtLen(r.duration_s)}. ${n === 0 ? "No errors detected in that time." : `${n} ${n === 1 ? "error" : "errors"} detected.`}`;
  if (n > 0) return `${n} ${n === 1 ? "error" : "errors"} detected in ${ran}. Treat this setting as unstable.`;
  if (r.stopped_by === "error") return `The screen ended with a tool error after ${ran}. See the lines below.`;
  if (r.health === "delta") return `No errors detected in ${ran}, but the machine health check changed. See below.`;
  return `No errors detected in ${ran}.`;
}

/** {bad, pills:[{text, tone: ok|warn|bad|neutral, title?}]} of a stress.start result. */
export function resultFlags(r) {
  const n = isNum(r.errors) ? r.errors : 0;
  const mce = isNum(r.mce_new) ? r.mce_new : 0;
  const bad = n > 0 || r.stopped_by === "error" || r.health === "delta" || mce > 0;
  const pills = [
    { text: r.stopped_by === "time" ? "ran to the end" : r.stopped_by === "cancel" ? "stopped by you" : "tool error", tone: r.stopped_by === "error" ? "bad" : "neutral" },
    { text: r.health === "clean" ? "health clean" : "health changed", tone: r.health === "clean" ? "ok" : "bad" },
  ];
  if (mce > 0) pills.push({ text: `${mce} new machine-check ${mce === 1 ? "event" : "events"}`, tone: "bad" });
  const ach = isObj(r.achieved) ? Object.values(r.achieved).filter(isObj) : [];
  if (r.cap_valid === true && ach.some((a) => a.cap_held === false)) {
    pills.push({ text: "cap held within one ratio", tone: "warn", title: "Every loaded unit ran within one ratio of the cap, but not all exactly at it. See the units below." });
  } else if (r.cap_valid === true) pills.push({ text: "cap held", tone: "ok", title: "Every loaded unit ran within one ratio of the cap." });
  else if (r.cap_valid === false) pills.push({ text: "cap not held", tone: "bad", title: "A loaded unit ran more than one ratio away from the cap, so the screen did not test the capped ratio." });
  return { bad, pills };
}

/** What a unit's achieved-clock tile says (web renderStressResult). */
export function achievedText(a) {
  const sub = !isNum(a.ratio_mode)
    ? "ratio n/a"
    : a.cap_held === false && isNum(a.cap_ratio)
      ? `ran ${a.ratio_mode}${TIMES} (cap ${a.cap_ratio}${TIMES})`
      : a.cap_held === true
        ? `cap held at ${a.cap_ratio}${TIMES}`
        : `${a.ratio_mode}${TIMES} mostly`;
  return { sub, mhz: isNum(a.mhz_mean) ? `${a.mhz_mean.toFixed(0)} MHz` : NA };
}

export function screenText(r) {
  if (r.kind === "memory") {
    const mb = isNum(r.memory_mb) ? ` ${r.memory_mb >= 1024 ? (r.memory_mb / 1024).toFixed(r.memory_mb % 1024 ? 1 : 0) + " GB" : r.memory_mb + " MB"}` : "";
    return `Memory${mb}${isNum(r.ratio_cap) ? `, cap ${r.ratio_cap}${TIMES}` : ""}`;
  }
  return `CPU ${METHOD_WORDS[r.method] || "load"}${isNum(r.ratio_cap) ? `, cap ${r.ratio_cap}${TIMES}` : ""}`;
}
export function unitsText(r, ids) {
  if (r.kind === "memory") return "all CPUs";
  const u = Array.isArray(r.units) ? r.units.filter(isStr) : [];
  return !u.length || (ids.length && u.length >= ids.length) ? (ids.length ? `all ${ids.length}` : "all") : u.join(" ");
}

/** A stress.list row as display cells. */
export function historyRow(r, ids = []) {
  const n = isNum(r.errors) ? r.errors : 0;
  const mce = isNum(r.mce_new) ? r.mce_new : 0;
  return {
    id: r.id,
    started: fmtDate(r.started),
    screen: screenText(r),
    units: unitsText(r, ids),
    ran: mmss(isNum(r.elapsed_s) ? r.elapsed_s : 0),
    asked: `asked for ${fmtLen(isNum(r.duration_s) ? r.duration_s : 0)}`,
    ended: { text: r.stopped_by === "time" ? "full length" : r.stopped_by === "cancel" ? "stopped" : "tool error", tone: r.stopped_by === "error" ? "bad" : "neutral" },
    errors: n,
    health: { text: r.health === "clean" ? "clean" : "changed", tone: r.health === "clean" ? "ok" : "bad" },
    mce: mce > 0 ? `${mce} MCE` : "",
    temp: isNum(r.max_temp_c) ? `${r.max_temp_c.toFixed(0)} °C` : NA,
    power: isNum(r.max_pkg_w) ? `${r.max_pkg_w.toFixed(0)} W` : NA,
  };
}

/** Mean clock of a unit's CPUs in a telemetry `values` object: {value|null, text}. */
export function unitMhz(values, cpus) {
  const vs = cpus.map((c) => readingValue(coreReading(values, c, "mhz")).value).filter(isNum);
  return vs.length ? { value: vs.reduce((a, b) => a + b, 0) / vs.length, text: `${Math.round(vs.reduce((a, b) => a + b, 0) / vs.length)} MHz` } : { value: null, text: NA };
}

/** Fraction done (0..1) of a run or result, for the progress rule under the timer. */
export function runFraction(elapsed, of) {
  return isNum(of) && of > 0 && isNum(elapsed) ? Math.min(1, Math.max(0, elapsed / of)) : 0;
}

/** Which result this is, for its box and its next step: "clean" | "errors" | "stopped" | "tool" | "health". */
export function resultKind(r) {
  if (!isObj(r)) return null;
  const n = isNum(r.errors) ? r.errors : 0;
  const mce = isNum(r.mce_new) ? r.mce_new : 0;
  if (n > 0) return "errors";
  if (r.stopped_by === "error") return "tool";
  if (r.health === "delta" || mce > 0) return "health";
  if (r.stopped_by === "cancel") return "stopped";
  return "clean";
}
export const RESULT_BOX = { clean: "ok", errors: "fault", tool: "warn", health: "fault", stopped: "" };

/** The result word of a history row: {text, kind: ok | fault | dim}. */
export function resultWord(r) {
  const k = resultKind(r);
  if (k === "errors") return { text: "errors", kind: "fault" };
  if (k === "health") return { text: "health changed", kind: "fault" };
  if (k === "tool") return { text: "tool error", kind: "fault" };
  if (k === "stopped") return { text: "stopped", kind: "dim" };
  return { text: "clean", kind: "ok" };
}

export const NOT_RECORDED = "state not recorded";
/**
 * The state a stored run tested (G-244, QA-23; G-252 words): the helper stores `state_fingerprint` with each run (the words the accepted state checks). `now` = the fingerprint of the
 * state the CPU holds now (stress.list's `state_fingerprint`); `accepted` = true when that state is the accepted one. A run on the state now says "accepted state" (when the CPU holds
 * the accepted state) or "the state now"; a run on any other state says "another state". The hash is in testedTitle (a tooltip), not in the cell. A record without the key is older
 * than the fingerprint: "state not recorded". A null fingerprint: the run began before any read this boot.
 */
export function testedText(r, now = undefined, accepted = false) {
  if (!isObj(r)) return NOT_RECORDED;
  const fp = r.state_fingerprint;
  if (isStr(fp) && fp) {
    if (!isStr(now) || !now) return "state recorded";
    return now === fp ? (accepted ? "accepted state" : "the state now") : "another state";
  }
  if (fp === null) return "state unknown (no read yet)";
  const t = r.tuning_state ?? r.state_tested ?? null;
  if (isStr(t)) return t;
  if (isObj(t)) return [t.kind, t.name || t.hash || t.id].filter(isStr).join(" · ") || "recorded";
  return NOT_RECORDED;
}
/** The tooltip of a "State tested" cell: the short fingerprint ("state 3fa9c2d1"), "" for a record without one. */
export const testedTitle = (r) => (isObj(r) && isStr(r.state_fingerprint) && r.state_fingerprint ? `state ${r.state_fingerprint.slice(0, 8)}` : "");

/** "04:37" — the timer's mm:ss, zero-padded minutes (one large readout per screen). */
export function timerText(s) {
  const t = Math.max(0, Math.floor(isNum(s) ? s : 0));
  const m = Math.floor(t / 60);
  const r = t % 60;
  return `${m < 10 ? "0" : ""}${m}:${r < 10 ? "0" : ""}${r}`;
}

/** Append one live sample of a run: [{s (elapsed), pkg, temp}], one per elapsed second at most. */
export function appendRunSample(buf, elapsed, telemetry) {
  if (!isNum(elapsed) || !telemetry || !telemetry.samples) return buf;
  if (buf.length && elapsed - buf[buf.length - 1].s < 0.5) return buf;
  const pick = (k) => (telemetry.samples[k] && isNum(telemetry.samples[k].value) ? telemetry.samples[k].value : null);
  return [...buf, { s: elapsed, pkg: pick("pkg_power"), temp: pick("temp") }];
}

/** Peaks of a run's samples: {pkg, temp} (null when none). */
export function runPeaks(buf) {
  const max = (k) => {
    const v = buf.map((p) => p[k]).filter(isNum);
    return v.length ? Math.max(...v) : null;
  };
  return { pkg: max("pkg"), temp: max("temp") };
}

export function errText(err) {
  if (!isObj(err)) return "no answer from the helper";
  const d = isObj(err.detail) && isStr(err.detail.state) ? ` (${err.detail.state})` : "";
  return `${err.message || err.code || "failed"}${d}`;
}

// ---------------------------------------------------------------- controller (no DOM; one per bridge, so state survives a screen change)

const controllers = new WeakMap();

/** The run state and the three ops of the screen. `ctx` = {bridge, store}. paint callbacks are added with `subscribe`. */
export function stressController(ctx) {
  const cached = controllers.get(ctx.bridge);
  if (cached) return cached;
  const c = createStressController(ctx);
  controllers.set(ctx.bridge, c);
  return c;
}

export function createStressController({ bridge, store }) {
  const st = initialStress();
  const view = { run: null, result: null, list: [], loaded: false, listProblem: "", status: "", submitting: false, stopping: false, done: new Set(), samples: [], tested: null, stateNow: null, changedAt: null };
  const tested = (s) => testedModel(s, { changedAt: view.changedAt });
  const painters = new Set();
  const paint = () => painters.forEach((fn) => fn());
  const ids = () => unitModel(store.get().preflight).ids;

  function watchRun(id) {
    bridge.wait(id).then((fin) => onResult(fin));
  }

  // What the helper said each op is doing (`state` / `heartbeat` carry {op_id, state}): a run begun elsewhere is adopted only when it is a stress run, never a read or an apply.
  const opState = new Map();
  function noteState(p) {
    if (!isObj(p) || !isStr(p.op_id) || !isStr(p.state)) return;
    opState.set(p.op_id, p.state);
    if (opState.size > 32) opState.delete(opState.keys().next().value);
    // G-244 (QA-21): the helper writing (applying / capped) is a change of the state the CPU holds; the time of the last such event is the last change (an apply reads back what it wrote)
    if (p.state === "applying" || p.state === "capped") {
      view.changedAt = new Date().toISOString();
      paint();
    }
  }

  function onProgress(p) {
    if (!isObj(p) || !(isNum(p.elapsed_s) || isNum(p.of_s)) || p.step !== undefined) return; // stress progress only (a measurement carries `step`)
    if (!view.run) {
      if (!isStr(p.op_id) || view.done.has(p.op_id) || opState.get(p.op_id) !== "stressing") return;
      view.run = { id: p.op_id, kind: "cpu", of: 0, elapsed: 0, errors: 0, units: ids(), adopted: true }; // adopted after a reload: the settings are not known
      view.samples = [];
      view.tested = null;
      watchRun(p.op_id);
    }
    if (p.op_id && view.run.id && p.op_id !== view.run.id) return;
    if (isNum(p.elapsed_s)) view.run.elapsed = p.elapsed_s;
    if (isNum(p.of_s)) view.run.of = p.of_s;
    if (isNum(p.errors)) view.run.errors = p.errors;
    view.samples = appendRunSample(view.samples, view.run.elapsed, store.get().telemetry);
    paint();
  }

  function onResult(fin) {
    if (fin && isStr(fin.id)) view.done.add(fin.id);
    view.run = null;
    view.stopping = false;
    if (fin && fin.ok === true && isObj(fin.result)) {
      view.result = fin.result;
      view.status = "";
    } else {
      view.result = null;
      view.status = `Failed: ${errText(fin && fin.error)}`;
    }
    paint();
    loadList();
  }

  async function start() {
    const s = store.get();
    const all = ids();
    if (view.run || view.submitting || opGate(s, false) || (st.kind === "cpu" && selectedUnits(st, all).length === 0)) return false;
    const args = stressArgs(st, all);
    view.submitting = true;
    view.status = "Submitting…";
    paint();
    const first = await bridge.call("stress.start", args);
    view.submitting = false;
    if (!first.ok) {
      view.status = `Not started: ${errText(first.error)}`;
      paint();
      return false;
    }
    view.run = { id: first.id, kind: st.kind, of: args.duration_s, elapsed: 0, errors: 0, units: st.kind === "cpu" ? selectedUnits(st, all) : all };
    view.samples = appendRunSample([], 0, store.get().telemetry);
    view.tested = tested(s);
    view.result = null;
    view.status = `Started ${fmtClock(Date.now() / 1000)}.`; // G-249 (R2-05): the time, never the helper's operation id
    paint();
    if (first.pending) watchRun(first.id);
    else onResult(first);
    return true;
  }

  async function stop() {
    if (!view.run || view.stopping) return false;
    view.stopping = true;
    paint();
    const res = await bridge.call("stress.stop", {});
    if (!res.ok) {
      view.stopping = false;
      view.status = `Stop not accepted: ${errText(res.error)}`;
    } else view.status = "Stop requested. The result arrives in a moment.";
    paint();
    return res.ok;
  }

  async function loadList() {
    const res = await bridge.call("stress.list", {});
    if (res.ok && isObj(res.result) && Array.isArray(res.result.results)) {
      view.list = res.result.results.filter(isObj);
      view.stateNow = isStr(res.result.state_fingerprint) ? res.result.state_fingerprint : null;
      view.loaded = true;
      view.listProblem = "";
    } else view.listProblem = `Stored screens unavailable: ${errText(res.error)}`;
    paint();
  }

  // G-244 (QA-21): the helper keeps the time of the last apply with this boot's stored read (tune.last, read-only): a change made before this screen existed still counts
  // Final QA 2026-11-12: after an app restart tune.last knows V/F / turbo / ring applies only; the newest apply-closing record in the helper's audit
  // log (power, caps / uncore, tune, restore accepted; a file read, 0 requests) keeps power changes too, so the label agrees before and after a restart
  async function loadChange() {
    // audit.tail is one of the helper's few slow-op slots (with preflight and throttle.tail): wait until the start-up preflight is in, so this read
    // cannot crowd it out (final QA 2026-11-12: a cold start answered preflight BUSY and stayed read-only)
    const res = await bridge.call("tune.last", {});
    const ready = store.get().preflight ? true : await new Promise((resolve) => {
      let stop = null;
      const timer = setTimeout(() => { if (stop) stop(); resolve(false); }, 10_000); // no preflight within 10 s: leave the audit part out
      stop = store.watch((s) => s.preflight, (p) => { if (p) { clearTimeout(timer); if (stop) stop(); resolve(true); } });
    });
    const aud = ready ? await bridge.call("audit.tail", { n: 200 }) : null;
    const at = res && res.ok && isObj(res.result) && res.result.available ? res.result.applied_at : null;
    const t = isNum(at) ? atMs(at) : null;
    const newer = (x) => x !== null && (view.changedAt === null || x > Date.parse(view.changedAt));
    let changed = false;
    if (newer(t)) { view.changedAt = new Date(t).toISOString(); changed = true; }
    const recs = aud && aud.ok && isObj(aud.result) && Array.isArray(aud.result.records) ? aud.result.records : [];
    const close = recs.filter((r) => isApplyClose(r) && r.writes_sent !== 0).pop();
    const ct = close && typeof close.ts === "string" ? Date.parse(close.ts) : NaN;
    if (Number.isFinite(ct) && newer(ct)) { view.changedAt = new Date(ct).toISOString(); changed = true; }
    if (changed) paint();
  }

  bridge.on("state", noteState);
  bridge.on("heartbeat", noteState);
  bridge.on("progress", onProgress);
  store.watch((s) => s.link.state, (state) => {
    if (state === "connected" && !view.loaded) {
      loadList();
      void loadChange(); // tune.last at once; the audit-log part only once preflight has answered (loadChange), so it never takes a start-up slot
    }
  });

  return {
    st,
    view,
    ids,
    start,
    stop,
    loadList,
    loadChange,
    tested,
    subscribe(fn) {
      painters.add(fn);
      return () => painters.delete(fn);
    },
    gate: () => opGate(store.get(), view.submitting || !!view.run),
  };
}


// ---------------------------------------------------------------- view

const RUN_PLOTS = [
  { key: "pkg", title: "Package W", unit: "W", digits: 0, minSpan: 20, floor: 0 },
  { key: "temp", title: "Hottest °C", unit: "°C", digits: 0, minSpan: 10, floor: null },
];

/** A run plot spec over elapsed seconds 0..of: {x, y, traces, labels, cursorXs}. Pure. */
export function runPlotSpec(def, buf, of) {
  const pts = buf.filter((p) => isNum(p[def.key])).map((p) => [p.s, p[def.key]]);
  const ys = pts.map((p) => p[1]);
  let lo = ys.length ? Math.min(...ys) : 0;
  let hi = ys.length ? Math.max(...ys) : def.minSpan;
  if (hi - lo < def.minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - def.minSpan / 2;
    hi = mid + def.minSpan / 2;
  }
  if (def.floor !== null && lo < def.floor) {
    hi += def.floor - lo;
    lo = def.floor;
  }
  const yt = niceTicks(lo, hi, 3);
  const step = yt.length > 1 ? yt[1] - yt[0] : def.minSpan;
  const y = { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step };
  if (def.floor !== null) y.min = Math.max(def.floor, y.min);
  const xmax = Math.max(isNum(of) && of > 0 ? of : 60, pts.length ? pts[pts.length - 1][0] : 0);
  const last = pts.length ? pts[pts.length - 1] : null;
  return {
    x: { min: 0, max: xmax, ticks: niceTicks(0, xmax, 5) },
    y: { ...y, ticks: niceTicks(y.min, y.max, 3) },
    traces: pts.length ? [{ kind: "meas", pts }] : [],
    labels: last ? [{ x: last[0], y: last[1], text: ` ${last[1].toFixed(def.digits)} ${def.unit}`, kind: "strong" }] : [],
    cursorXs: pts.map((p) => p[0]),
  };
}

export function stressView() {
  const subs = [];
  return {
    id: "stress",
    lx: true,
    mount(root, ctx) {
      const { store } = ctx;
      const ctl = stressController(ctx);
      const { st, view } = ctl;
      const goto = (s, tab) => ctx.goto && ctx.goto(s, tab);
      let model = unitModel(store.get().preflight);
      let ids = model.ids;
      if (ctx.head) ctx.head.set({ sub: "quick screens · stress-ng and stressapptest" });

      // ---- SETUP
      const banner = box({ kind: "warn", title: BANNER_HEAD, body: BANNER_TEXT, id: "st-banner" });
      banner.setAttribute("role", "note");
      banner.dataset.hint = "stress.screen";
      const testedVal = h("span", { id: "st-tested" });
      const editsWhy = why(null, {}, { id: "st-edits-why" });
      const toTune = button({ level: 0, label: "Open Tune ›", id: "st-to-tune", onClick: () => goto("tune") });
      const editsRow = h("div", { class: "lx-st-edits", id: "st-edits" }, editsWhy, toTune);
      const tested = h("div", { class: "lx-st-tested", dataset: { hint: "stress.tested" } }, kv([["Tests", testedVal]]), editsRow);

      const kindSeg = createSegmented({ options: [{ value: "cpu", label: "CPU" }, { value: "memory", label: "Memory" }], value: st.kind, label: "Load", hint: "stress.load", id: "st-kind", onChange: (k) => { st.kind = k; render(); } });
      const methodSeg = createSegmented({ options: METHODS.map((m) => ({ value: m.value, label: m.label, hint: m.hint })), value: st.method, label: "Kind of load", id: "st-method", onChange: (m) => { st.method = m; render(); } });
      const methodLine = h("span", { class: "lx-st-explain", id: "st-method-line" });
      const durSeg = createSegmented({ options: DURATIONS.map((d) => ({ value: d.value, label: d.label })), value: st.custom ? "custom" : st.dur, label: "Length", hint: "stress.length", id: "st-dur", onChange: (v) => { if (v === "custom") st.custom = true; else { st.custom = false; st.dur = v; } render(); } });
      const custom = createField({ label: "Custom length", hint: "stress.length", unit: "s", width: 6, value: st.customS, min: DUR_MIN, max: DUR_MAX, source: "the helper’s range", step: 30, bigStep: 300, id: "st-dur-custom", onCommit: (v) => { st.custom = true; st.customS = v; custom.set(v); render(); } });
      const memSel = h("select", { class: "lx-select", id: "st-mem", "aria-label": "Memory to test", dataset: { hint: "stress.memory" } }, h("option", { value: "", text: "Automatic · ¾ of free" }), ...MEM_MB.map((mb) => h("option", { value: String(mb), text: `${mb / 1024} GB` })));
      memSel.addEventListener("change", () => { st.memMb = memSel.value === "" ? null : Number(memSel.value); render(); });
      const capSel = h("select", { class: "lx-select", id: "st-cap", "aria-label": "Hold at ratio", dataset: { hint: "stress.cap" } }, h("option", { value: "", text: "No hold" }));
      for (let r = CAP_MAX; r >= CAP_MIN; r--) capSel.append(h("option", { value: String(r), text: `${r}${TIMES}` }));
      capSel.addEventListener("change", () => { st.cap = capSel.value === "" ? null : Number(capSel.value); render(); });
      const row = (label, hint, ...kids) => h("div", { class: "lx-st-row", dataset: { hint } }, h("span", { class: "lx-lbl", text: label }), h("div", { class: "lx-st-ctl" }, ...kids));
      const rMethod = row("Kind", "stress.kind.integer", methodSeg.el, methodLine);
      const rMem = row("Memory", "stress.memory", memSel);
      const rCustom = row("", "stress.length", custom.el, custom.whyEl);
      const rCap = row("Hold at ratio", "stress.cap", capSel);
      const startBtn = button({ level: 3, label: "Start stress", cost: "5 min", id: "btn-stress-start", hint: "stress.start", onClick: () => ctl.start() });
      const stopBtn = button({ level: 2, label: "Stop", id: "btn-stress-stop", hint: "stress.stop", onClick: () => ctl.stop() });
      const startWhy = why(null, {}, { id: "st-start-why" });
      const status = h("p", { class: "lx-st-status", id: "st-status", role: "status" });
      const setupP = panel({
        title: "Setup", id: "st-setup",
        body: [banner, tested, h("div", { class: "lx-st-form" }, row("Load", "stress.load", kindSeg.el), rMethod, rMem, row("Length", "stress.length", durSeg.el), rCustom, rCap), h("div", { class: "lx-st-go" }, startBtn, stopBtn), startWhy, status],
      });

      // ---- UNITS TO LOAD
      const live = new Map();
      const cols = [
        { key: "clock", label: "Clock", unit: "GHz", num: true, hint: "overview.clock", value: (u) => { const l = live.get(u.id); return l && isNum(l.mhz) ? (l.mhz / 1000).toFixed(2) : { text: NA, na: true }; } },
        { key: "busy", label: "Busy", unit: "%", hint: "overview.busy", bar: (u) => { const l = live.get(u.id); return l && isNum(l.busy) ? l.busy / 100 : null; }, value: (u) => { const l = live.get(u.id); return l && isNum(l.busy) ? Math.round(l.busy).toString() : { text: NA, na: true }; } },
      ];
      const ut = createUnitTable({ columns: cols, check: true, label: "Units to load", id: "st-units", onSelect: (sel) => { st.sel = new Set(sel); render(); } });
      const quick = h("span", { class: "lx-st-quick" });
      const unitsNote = h("div", { class: "lx-tfoot-note", id: "st-units-note", hidden: true });
      const unitsP = panel({ title: "Units to load", meta: "", end: quick, id: "st-units-panel", flush: true, body: [ut.el, unitsNote] });
      unitsP.el.dataset.hint = "stress.units";

      // ---- LIVE
      const timer = h("span", { class: "lx-st-timer", id: "st-clock", text: "00:00", dataset: { hint: "stress.timer" } });
      const ofEl = h("span", { class: "lx-st-of", id: "st-of" });
      const rule = progressRule(0);
      rule.id = "st-progress";
      const errV = h("span", { class: "lx-mono", id: "st-errors" });
      const hotV = h("span", { class: "lx-mono", id: "st-hot" });
      const pkgV = h("span", { class: "lx-mono", id: "st-pkg" });
      const stats = h("div", { class: "lx-st-stats" }, h("span", { dataset: { hint: "stress.errors" } }, "Errors ", errV), h("span", {}, "Hottest ", hotV), h("span", {}, "Peak package ", pkgV));
      const testingLine = h("div", { class: "lx-st-testing", id: "st-testing" });
      const plots = RUN_PLOTS.map((def, i) => {
        const x = { min: 0, max: 60, ticks: [], fmt: (t) => mmss(t) };
        const y = { min: 0, max: 1, title: def.title };
        let spec = null;
        const plot = createPlot({ label: `${def.title} during the run`, height: i === RUN_PLOTS.length - 1 ? 112 : 92, margin: { l: 44, r: 72, t: 18, b: i === RUN_PLOTS.length - 1 ? 26 : 8 }, x, y, readout: (xv) => { const p = spec && spec.traces.length ? spec.traces[0].pts.find((q) => q[0] === xv) : null; return [["", mmss(xv)], ["", p ? p[1].toFixed(def.digits) : NA, def.unit]]; } });
        plot.el.dataset.series = def.key;
        return { def, plot, x, y, last: i === RUN_PLOTS.length - 1, setSpec: (s) => (spec = s) };
      });
      const liveBody = h("div", { class: "lx-st-live", id: "st-live-body" }, h("div", { class: "lx-st-clock" }, timer, ofEl), rule, stats, testingLine, h("div", { class: "lx-st-plots" }, ...plots.map((p) => p.plot.el)));
      const result = h("div", { class: "lx-st-result", id: "st-result", hidden: true, "aria-live": "polite" });
      const idle = emptyState({ title: EMPTY["stress.idle"].title, teach: EMPTY["stress.idle"].teach, id: "st-idle" });
      const liveP = panel({ title: "Live", meta: "", id: "st-live", body: [idle, liveBody, result] });

      // ---- EARLIER SCREENS
      const histCols = [["started", "Started"], ["screen", "Screen"], ["units", "Units"], ["ran", "Ran", true], ["errors", "Errors", true], ["result", "Result"], ["hot", "Hottest", true, "°C"], ["peak", "Peak", true, "W"], ["tested", "State tested"]];
      const histBody = h("tbody", { id: "st-hist-body" });
      const histTable = h("table", { class: "lx-tbl lx-tbl--fill", id: "st-hist", "aria-label": "Earlier screens, newest first" }, h("thead", {}, h("tr", {}, ...histCols.map(([k, l, n, u]) => h("th", { class: n ? "lx-n" : "", scope: "col", dataset: { col: k } }, l, u ? h("span", { class: "lx-hu", text: u }) : null)))), histBody);
      const histEmpty = emptyState({ title: EMPTY["stress.history"].title, teach: EMPTY["stress.history"].teach, id: "st-hist-empty" });
      const refresh = button({ level: 1, label: "Refresh", cost: "0 req", id: "btn-stress-refresh", hint: "stress.history", onClick: () => ctl.loadList() });
      const histP = panel({ title: "Earlier screens", meta: "", end: refresh, id: "st-history-card", flush: true, scroll: true, body: [histTable, histEmpty] });

      root.append(h("div", { class: "lx-tiles lx-st", id: "st" }, setupP.el, unitsP.el, liveP.el, histP.el));

      // ---- painting
      let topoKey = "";
      const syncTopology = () => {
        const next = unitModel(store.get().preflight);
        const key = next.ids.join(",") + "|" + favoredIds(next).join(",");
        if (key === topoKey) return;
        topoKey = key;
        model = next;
        ids = next.ids;
        ut.setUnits(unitsFromTopology(store.get().preflight ? store.get().preflight.topology : null));
        clear(quick).append(...quickButtons(model, (sel) => { if (view.run) return; st.sel = new Set(sel); render(); }, "st"));
      };
      let memNote = "";
      const paintUnitsNote = (cpu) => {
        memNote = cpu ? "" : "Memory test: it loads all CPUs; the table only shows them.";
        paintLiveCells();
      };
      const paintLiveCells = () => {
        const s = store.get();
        live.clear();
        for (const u of ids) live.set(u, unitLive(s.telemetry.values, model.byId[u].cpus));
        ut.refresh();
        const whyClock = [...new Set([...live.values()].map((l) => l.why.mhz).filter(Boolean))];
        unitsNote.textContent = [memNote, whyClock.length && ids.length ? `Clock and busy n/a: ${whyClock.join("; ")}.` : ""].filter(Boolean).join(" ");
        unitsNote.hidden = !unitsNote.textContent;
      };

      function renderLive() {
        const run = view.run;
        const running = !!run;
        const r = view.result;
        const of_ = running && isNum(run.of) && run.of > 0 ? run.of : r ? r.duration_s : stressDuration(st);
        const elapsed = running ? run.elapsed : r ? r.elapsed_s : 0;
        const errs = running ? run.errors : r ? r.errors : null;
        idle.hidden = running || !!r;
        liveBody.hidden = !running && !r;
        liveP.el.dataset.phase = running ? (view.stopping ? "stopping" : "running") : r ? "result" : "idle";
        liveP.setMeta(running ? `${view.stopping ? "stopping" : "running"} · ${screenText({ kind: run.kind, method: st.method, ratio_cap: st.cap })}` : r ? `ended ${fmtDate(r.ended || r.started)}` : "not running");
        timer.textContent = timerText(elapsed);
        ofEl.textContent = ` of ${timerText(of_)}`;
        setProgress(rule, runFraction(elapsed, of_));
        errV.textContent = isNum(errs) ? String(errs) : NA;
        errV.dataset.result = isNum(errs) && errs > 0 ? "fault" : "";
        const peaks = runPeaks(view.samples);
        const hot = r && isNum(r.max_temp_c) ? r.max_temp_c : peaks.temp;
        const pk = r && isNum(r.max_pkg_w) ? r.max_pkg_w : peaks.pkg;
        hotV.textContent = isNum(hot) ? `${hot.toFixed(0)} °C` : NA;
        pkgV.textContent = isNum(pk) ? `${pk.toFixed(0)} W` : NA;
        testingLine.textContent = !view.tested && running ? "Tested state not known (the run was started elsewhere)" : ""; // G-252: what is tested is said once, in Setup
        for (const p of plots) {
          const spec = runPlotSpec(p.def, view.samples, of_);
          p.setSpec(spec);
          Object.assign(p.x, { min: spec.x.min, max: spec.x.max, ticks: p.last ? spec.x.ticks : [] });
          Object.assign(p.y, { min: spec.y.min, max: spec.y.max, ticks: spec.y.ticks });
          p.plot.draw({ traces: spec.traces, labels: spec.labels, cursorXs: spec.cursorXs });
        }
        paintLiveCells();
        renderResult();
      }

      let resultFor = null;
      function renderResult() {
        const r = view.run ? null : view.result;
        result.hidden = !r;
        if (r === resultFor) return;
        resultFor = r;
        if (!r) return clear(result);
        const k = resultKind(r);
        const next = HINTS[`stress.result.${k}`];
        const flags = resultFlags(r);
        const nodes = [box({ kind: RESULT_BOX[k], title: stSummary(r), body: next.line, id: "st-sum" })];
        nodes[0].dataset.result = k;
        if (next.tip) nodes.push(h("div", { class: "lx-st-next" }, button({ level: 0, label: "Open Tips ›", id: "st-result-tips", onClick: () => openTips(next.tip) })));
        nodes.push(h("div", { class: "lx-st-tags" }, ...flags.pills.map((p) => tag(p.text, p.tone === "bad" ? "fault" : p.tone === "ok" ? "ok" : p.tone === "warn" ? "warn" : ""))));
        const ach = isObj(r.achieved) ? r.achieved : {};
        const done = Object.keys(ach).filter((u) => isObj(ach[u])).sort((a, b) => (ids.indexOf(a) < 0 ? 99 : ids.indexOf(a)) - (ids.indexOf(b) < 0 ? 99 : ids.indexOf(b)));
        if (done.length) {
          nodes.push(h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", id: "st-achieved", "aria-label": "Clock each unit held" },
            h("thead", {}, h("tr", {}, h("th", { text: "Unit held" }), h("th", { class: "lx-n" }, "Ratio", h("span", { class: "lx-hu", text: "×" })), h("th", { class: "lx-n" }, "Mean clock", h("span", { class: "lx-hu", text: "GHz" })), h("th", { text: "Hold" }))),
            h("tbody", {}, ...done.map((u) => {
              const a = ach[u];
              return h("tr", { dataset: { unit: u } }, h("td", { class: "lx-k", text: u + favMark(model, u) }), h("td", { class: "lx-n", text: isNum(a.ratio_mode) ? String(a.ratio_mode) : NA }), h("td", { class: "lx-n", text: isNum(a.mhz_mean) ? (a.mhz_mean / 1000).toFixed(2) : NA }), h("td", { text: a.cap_held === true ? "held" : a.cap_held === false ? `ran ${a.ratio_mode}${TIMES}, hold ${a.cap_ratio}${TIMES}` : "no hold" }));
            }))));
        }
        const lines = Array.isArray(r.error_lines) ? r.error_lines.filter(isStr) : [];
        if (lines.length) nodes.push(h("ul", { class: "lx-st-lines" }, ...lines.map((x) => h("li", { class: "lx-mono", text: x }))));
        nodes.push(h("div", { class: "lx-tfoot-note", text: isStr(r.id) ? `Stored as ${r.id}.` : "This result could not be stored on the machine." }));
        clear(result).append(...nodes);
      }

      let histSig = "";
      const accNowFlag = () => { const a = store.get().accepted; return !!a && (a.kind === "matches" || a.kind === "equivalent"); }; // the state now is the accepted one
      function renderHistory() {
        const rows = view.list.map((r) => ({ r, row: historyRow(r, ids), word: resultWord(r) }));
        histP.setMeta(view.listProblem ? view.listProblem : !view.loaded ? "loading…" : `${rows.length} stored · newest first`);
        histTable.hidden = rows.length === 0;
        histEmpty.hidden = rows.length > 0 || !view.loaded;
        const accNow = accNowFlag();
        const sig = JSON.stringify(rows.map((x) => [x.row, testedText(x.r, view.stateNow, accNow)]));
        if (sig === histSig) return;
        histSig = sig;
        clear(histBody).append(...rows.map(({ r, row, word }) => h("tr", { dataset: { id: row.id || "" } },
          h("td", { class: "lx-mono", text: row.started }), h("td", { text: row.screen }), h("td", { text: row.units }),
          h("td", { class: "lx-n", text: row.ran }),
          h("td", { class: "lx-n", dataset: { result: row.errors > 0 ? "fault" : "" }, text: String(row.errors) }),
          h("td", { dataset: { result: word.kind } }, word.text, row.mce ? ` · ${row.mce}` : ""),
          h("td", { class: "lx-n", text: isNum(r.max_temp_c) ? r.max_temp_c.toFixed(0) : NA }), h("td", { class: "lx-n", text: isNum(r.max_pkg_w) ? r.max_pkg_w.toFixed(0) : NA }),
          h("td", { class: [NOT_RECORDED, "state unknown (no read yet)"].includes(testedText(r)) || testedText(r, view.stateNow, accNow) === "another state" ? "lx-dim" : "", title: testedTitle(r) || undefined, dataset: { tested: isStr(r.state_fingerprint) ? (r.state_fingerprint === view.stateNow ? "now" : "other") : "none" }, text: testedText(r, view.stateNow, accNow) }))));
      }

      function render() {
        syncTopology();
        const s = store.get();
        const running = !!view.run;
        const cpu = st.kind === "cpu";
        kindSeg.set(st.kind);
        methodSeg.set(st.method);
        durSeg.set(st.custom ? "custom" : st.dur);
        const m = METHODS.find((x) => x.value === st.method) || METHODS[0];
        methodLine.textContent = HINTS[m.hint].line;
        rMethod.dataset.hint = m.hint;
        rMethod.hidden = !cpu;
        rMem.hidden = cpu;
        rCustom.hidden = !st.custom;
        for (const seg of [kindSeg, methodSeg, durSeg]) for (const b of seg.el.querySelectorAll("button")) b.disabled = running;
        memSel.disabled = running;
        capSel.disabled = running;
        custom.input.disabled = running;
        memSel.value = st.memMb === null ? "" : String(st.memMb);
        capSel.value = st.cap === null ? "" : String(st.cap);
        // what is tested
        const t = ctl.tested(s);
        testedVal.textContent = t.line;
        setWhy(editsWhy, t.edits ? "warn.unapplied" : null, { n: `${t.edits} ${t.edits === 1 ? "edit" : "edits"}` });
        editsRow.hidden = !t.edits;
        tested.dataset.edits = String(t.edits);
        // units
        const sel = running ? view.run.units : selectedUnits(st, ids);
        ut.setSelection(sel);
        setInert(unitsP.body, running || !cpu);
        unitsP.el.dataset.disabled = running || !cpu ? "true" : "false";
        unitsP.setMeta("");
        paintUnitsNote(cpu);
        for (const b of quick.querySelectorAll("button")) b.disabled = running || !cpu;
        // start
        const gate = gateWhy(s, view.submitting || running, "A stress screen");
        const none = cpu && (!ids.length || selectedUnits(st, ids).length === 0);
        const w = running ? null : gate || (none ? { key: "locked.no_units", vars: {} } : null);
        startBtn.disabled = running || !!w;
        startBtn.hidden = running;
        stopBtn.hidden = !running;
        stopBtn.disabled = view.stopping;
        setButton(startBtn, { cost: fmtLen(stressDuration(st)) });
        setButton(stopBtn, { label: view.stopping ? "Stopping" : "Stop" });
        setWhy(startWhy, w ? w.key : null, w ? w.vars : {});
        if (w) startBtn.setAttribute("aria-describedby", startWhy.id);
        else startBtn.removeAttribute("aria-describedby");
        status.textContent = view.status;
        renderLive();
        renderHistory();
      }

      subs.push(ctl.subscribe(render));
      let lastGate = JSON.stringify(gateWhy(store.get(), false));
      subs.push(store.subscribe((s, prev) => {
        const g = JSON.stringify(gateWhy(s, false));
        if (s.link !== prev.link || s.preflight !== prev.preflight || g !== lastGate || s.pending !== prev.pending || s.accepted !== prev.accepted || s.lastReadAt !== prev.lastReadAt || s.lastApplyAt !== prev.lastApplyAt) {
          lastGate = g;
          render();
        } else if (s.telemetry !== prev.telemetry) renderLive();
      }));
      subs.push(() => plots.forEach((p) => p.plot.dispose()));
      render();
      if (store.get().link.state === "connected") {
        ctl.loadList();
        void ctl.loadChange();
      }
    },
    unmount() {
      subs.splice(0).forEach((u) => u());
    },
  };
}
