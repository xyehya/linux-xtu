// views/tune/runtime-kinds.js: the "power" and "runtime" section kinds of the apply drawer (views/tune/apply.js registerKind) and the helper reads they share (G-217).
//
// WHAT THE DRAWER TAKES FROM A KIND (views/tune/apply.js hooks): power.plan / runtime.plan take their fields at the top level (ops_power.py _validate_power_plan, ops_runtime.py
// _validate_runtime_plan; the Rust allowlist rejects {intent: ...}), so a kind carries
//   planArgs(intent) -> the args of the plan call (default {intent}),   explain(error) -> the refusal text,   view(plan) -> {units: [{unit, keys, lines}], steps: [text]} (a plan that is not tune-shaped).
//
// The tabs and the pending bar (views/tune.js requestReview) build their requests with requestReview(): one sheet, V/F + turbo + ring section first (when there is a Tune draft), then power,
// then runtime (caps + uncore); applied in that order, stop on first failure. Plan warnings (LARGE_CHANGE, PL2_BELOW_PL1, ...) are amber rows and never block Apply.
// R-S3 (F-05 / R-26): a request built from the edits is `track: true`: the sheet compares its plan with the intent the edits give NOW and refuses Apply when they moved
// (plan 200 W, retype 180 W → Review again, never 200 W). After an apply only the keys that landed leave the edits (lib/rtstate.js editsAfterApply); after a stop that
// may have written, the values in force are read again.
import { registerKind, KINDS } from "./apply.js";
import { ensureTune } from "../tune.js";
import { pushToast } from "../../store.js";
import { isEmpty as draftIsEmpty } from "../../lib/draft.js";
import { isNum } from "../../lib/format.js";
import { ensureRt, setRead, editRt, patchRt, powerRequest, runtimeRequest, emptyEdits, editsAfterApply, capRows } from "../../lib/rtstate.js";
import { explainRefusal } from "../../lib/cpulimits.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// ---- reads (shared by the tabs and by afterApply) -------------------------------------------------------------------------------------------------
/** power.read / runtime.read into the slice. power.read is a long op (guarded MSR reads): {id} + a result event. Plain MSR / sysfs reads, never the OC mailbox. */
export async function loadRead(store, bridge, key) {
  const op = key === "power" ? "power.read" : "runtime.read";
  setRead(store, key, { state: "reading", error: null });
  let res;
  try {
    const first = await bridge.call(op);
    res = first.ok && first.pending ? await bridge.wait(first.id) : first;
  } catch (e) {
    res = { ok: false, error: { code: "BRIDGE", message: String((e && e.message) || e) } };
  }
  if (!res.ok) {
    setRead(store, key, { state: "error", error: res.error.message || res.error.code });
    return null;
  }
  setRead(store, key, { state: "ready", result: res.result, error: null, at: new Date().toISOString() });
  return res.result;
}

// ---- display of a plan that is not tune-shaped ----------------------------------------------------------------------------------------------------
export const PL_NAME = { pl1_w: "Processor Core Power Limit (PL1)", pl2_w: "Processor Core Turbo Power Limit (PL2)", tau_s: "Turbo Boost Power Time Window" };
const watts = (uw) => (isNum(uw) ? Math.round(uw / 1e4) / 100 + " W" : "?");
const secs = (us) => (isNum(us) ? Math.round(us / 1e5) / 10 + " s" : "?");
const khzRatio = (khz) => (isNum(khz) ? Math.round(khz / 1e5) + "×" : "?");
const khzMhz = (khz) => (isNum(khz) ? Math.round(khz / 1e3) + " MHz" : "?");
/** G-232 / G-233: the ratio a cap step gives (the plan's own: the helper's model of what the core runs; a revert step has it too), else the file value in kHz / 100000 for a helper that sends none. */
const capRatio = (s) => (isNum(s.ratio) ? s.ratio + "×" : khzRatio(s.value));
/** G-233: the file value in MHz, labelled "kernel" when it is not ratio x 100 MHz (an E-core: kernel 4900 MHz is 48x). */
const capMhz = (s) => (isNum(s.value) && isNum(s.ratio) && s.value !== s.ratio * 1e5 ? "kernel " : "") + khzMhz(s.value);
/** G-233: the ratio the cap in force ran at (`before_ratio`; an E-core's kHz / 100000 would show one too many). */
const capWas = (s) => (isNum(s.before_ratio) ? s.before_ratio + "×" : khzRatio(s.before));

const MINUS = "−";
const signed = (x, digits = 0) => (!isNum(x) ? "" : (x > 0 ? "+" : x < 0 ? MINUS : "") + Math.abs(x).toFixed(digits));
/** The commit sheet's words for a power key (DESIGN.md §5.10: "long-term limit · PL1"). */
export const PL_WHAT = { pl1_w: "long-term limit · PL1", pl2_w: "short-term limit · PL2", tau_s: "time window · tau" };

/**
 * power.plan result -> {units: [{unit, keys, lines}], steps: [text], rows: [{unit, what, before, after, delta, keys}]}: one row per key the plan writes, the steps in the
 * order the helper sends them; `rows` are the commit sheet's diff rows.
 */
export function powerView(plan) {
  const steps = (Array.isArray(plan && plan.steps) ? plan.steps : []).filter(isObj);
  const fmt = (key, v) => (key === "tau_s" ? secs(v) : watts(v));
  return {
    units: steps.map((s) => ({ unit: PL_NAME[s.key] || String(s.key), keys: [s.key], lines: [fmt(s.key, s.before) + " → " + fmt(s.key, s.value)] })),
    steps: steps.map((s) => "write " + (PL_NAME[s.key] || s.key) + " = " + fmt(s.key, s.value) + " (powercap " + s.file + "), then read back the file and MSR 0x610"),
    rows: steps.map((s) => ({
      unit: "Package", what: PL_WHAT[s.key] || String(s.key), before: fmt(s.key, s.before), after: fmt(s.key, s.value), keys: [s.key], sunit: "power:" + s.key,
      delta: isNum(s.before) && isNum(s.value) ? (s.key === "tau_s" ? signed((s.value - s.before) / 1e6, 1) : signed(Math.round((s.value - s.before) / 1e4) / 100)) : "",
    })),
  };
}

/** The unit a group of CPUs is (a whole P-core or E-cluster of the last runtime.read), else "cpu 8, 9". */
function unitOfCpus(cpus, result) {
  const rows = capRows(result);
  const nums = cpus.map((k) => Number(String(k).replace(/^cpu/, ""))).sort((a, b) => a - b);
  const whole = rows.find((r) => r.online.length && r.online.length === nums.length && r.online.every((c) => nums.includes(c)));
  return whole ? whole.unit : "cpu " + nums.join(", ");
}

/**
 * runtime.plan result -> the same shape: CPUs asking for the same change are one row ("cpu 8, 9, 10, 11"); the plan's own note ("capped at 22×") is shown, never predicted
 * here. `st` (optional, the app state) names a group of CPUs by its unit in the sheet's rows (EC0 = cpu 8–11 of the last runtime.read).
 */
export function runtimeView(plan, st = null) {
  const steps = (Array.isArray(plan && plan.steps) ? plan.steps : []).filter(isObj);
  const groups = [];
  for (const s of steps) {
    if (s.domain === "caps") {
      const sig = [s.before, s.value, s.note || ""].join("|");
      const g = groups.find((x) => x.sig === sig && x.domain === "caps");
      if (g) g.keys.push(s.key);
      else groups.push({ domain: "caps", sig, keys: [s.key], step: s });
    } else groups.push({ domain: s.domain, sig: String(s.key), keys: [s.key], step: s });
  }
  const units = groups.map((g) => {
    const s = g.step;
    if (g.domain === "caps") return { unit: "cpu " + g.keys.map((k) => String(k).replace(/^cpu/, "")).join(", "), keys: g.keys, lines: ["max " + capWas(s) + " → " + capRatio(s) + " (" + capMhz(s) + ")" + (s.note ? " · " + s.note : "")] };
    return { unit: "Uncore " + String(s.key).replace("_ratio", "") + " ratio", keys: g.keys, lines: [khzRatio(s.before) + " → " + khzRatio(s.value)] };
  });
  const result = st && st.rt && st.rt.runtime ? st.rt.runtime.result : null;
  const ratioOf = (khz) => (isNum(khz) ? Math.round(khz / 1e5) : null);
  const rows = groups.map((g) => {
    const s = g.step;
    if (g.domain === "caps") {
      const was = isNum(s.before_ratio) ? s.before_ratio : ratioOf(s.before);
      const to = isNum(s.ratio) ? s.ratio : ratioOf(s.value);
      return { unit: unitOfCpus(g.keys, result), what: "max ratio cap" + (s.note ? " (capped)" : ""), before: capWas(s), after: capRatio(s), delta: isNum(was) && isNum(to) ? signed(to - was) : "", keys: g.keys, sunit: "caps:" + g.keys.join(",") };
    }
    const k = String(s.key).replace("_ratio", "");
    return { unit: "Uncore", what: k + " ratio", before: khzRatio(s.before), after: khzRatio(s.value), delta: isNum(s.before) && isNum(s.value) ? signed(ratioOf(s.value) - ratioOf(s.before)) : "", keys: g.keys, sunit: "uncore:" + s.key };
  });
  return {
    units,
    steps: steps.map((s) => (s.domain === "caps" ? "write " + s.file + " = " + s.value + " kHz (" + capRatio(s) + ")" : "write " + s.file + " = " + s.value + " kHz") + (s.note ? " · " + s.note : "")),
    rows,
  };
}

const locateRefusal = (error) => ({ unit: null, field: null, ratio: null, point: null, key: isObj(error && error.detail) && typeof error.detail.key === "string" ? error.detail.key : null, message: explainRefusal(error), check: isObj(error && error.detail) ? error.detail.check || null : null });

function requestOf(build) {
  return (store) => {
    const r = build(ensureRt(store));
    return r.error ? { error: r.error } : { intent: r.intent };
  };
}

/**
 * After an apply: only what landed leaves the edits (lib/rtstate.js editsAfterApply; G-234: a finished revert clears its kind), then the values in force are read
 * again (plain sysfs / MSR reads, never the OC mailbox).
 */
function afterOf(key) {
  return async ({ store, bridge, section, summary }) => {
    const rt = ensureRt(store);
    editRt(store, (e) => editsAfterApply(e, key, section && section.intent, summary, rt.runtime.result));
    await loadRead(store, bridge, key);
  };
}

/** After a stop that may have written (cancelled, refused mid-way, link lost): the edits stay, the values in force are read again so the tab shows them. */
const afterFailureOf = (key) => async ({ store, bridge }) => {
  await loadRead(store, bridge, key);
};

export const POWER_KIND = {
  label: "Power limits (runtime)",
  short: "power limits",
  undo: "Power limits: Restore boot values (Tune › Power), or a reboot.",
  writesWord: "powercap",
  planOp: "power.plan",
  applyOp: "power.apply",
  planArgs: (intent) => intent,
  request: requestOf(powerRequest),
  locate: locateRefusal,
  explain: explainRefusal,
  view: powerView,
  afterApply: afterOf("power"),
  afterFailure: afterFailureOf("power"),
};
export const RUNTIME_KIND = {
  label: "Ratio caps & uncore (runtime)",
  short: "caps & uncore",
  undo: "Caps and uncore: Restore boot caps and uncore (Tune › Frequency or Ring & uncore), or a reboot.",
  writesWord: "sysfs",
  planOp: "runtime.plan",
  applyOp: "runtime.apply",
  planArgs: (intent) => intent,
  request: requestOf(runtimeRequest),
  locate: locateRefusal,
  explain: explainRefusal,
  view: runtimeView,
  afterApply: afterOf("runtime"),
  afterFailure: afterFailureOf("runtime"),
};

/** Idempotent: put the two kinds into the drawer's registry. */
export function registerRuntimeKinds() {
  if (!KINDS.power) registerKind("power", POWER_KIND);
  if (!KINDS.runtime) registerKind("runtime", RUNTIME_KIND);
}

// ---- the tabs' Review button ------------------------------------------------------------------------------------------------------------------------
/**
 * Open the apply drawer for the pending runtime edits (+ the Tune V/F draft, when there is one). `only` = [{kind, intent, label}] replaces the edits (a revert).
 * -> the requests it dispatched ([] = nothing to review: a toast says so).
 */
export function requestReview(store, only = null) {
  registerRuntimeKinds();
  const t = ensureTune(store);
  const rt = ensureRt(store);
  let requests;
  if (only) requests = only;
  else {
    requests = [];
    if (t.model && !draftIsEmpty(t.draft)) requests.push("tune");
    const p = powerRequest(rt);
    const r = runtimeRequest(rt);
    for (const [kind, req, label] of [["power", p, "Power limits"], ["runtime", r, "Ratio caps & uncore"]]) {
      if (req.error) {
        pushToast(store, { kind: "warn", text: label + ": " + req.error });
        return [];
      }
      if (req.intent) requests.push({ kind, intent: req.intent, label, track: true }); // F-05: the sheet checks the plan against the edits up to the write
    }
  }
  if (!requests.length) {
    pushToast(store, { kind: "info", text: "Nothing to review: no pending changes." });
    return [];
  }
  if (!store.events) store.events = new EventTarget();
  store.events.dispatchEvent(new CustomEvent("tune:review", { detail: { requests } }));
  return requests;
}

/** A revert request: the helper puts back the values it journaled before the first write of this boot. */
export const revertRequest = (kind) => ({ kind, intent: { revert: true }, label: kind === "power" ? "Power limits: revert to the values of the boot" : "Ratio caps & uncore: revert to the values of the boot" });

export { patchRt, emptyEdits };
