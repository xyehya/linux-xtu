// views/tune/apply.js: the commit sheet — "Review" (desktop/DESIGN.md §5.10, §9.6): plan → diff → native confirmation → writes with live progress → read-back result.
// The only path to a write. The sheet shell (components/sheet.js) owns the head and the slide; this module owns the body, the footer and the controller.
//
// FLOW. A review is a list of sections {kind, label, intent, plan, status, ...}, one per helper plan (V/F + turbo + ring, power, caps + uncore, or a whole-state
// intent from Profiles), applied in order and stopping at the first failure. A kind is an entry in KINDS: {label, planOp, applyOp, request(store) ->
// {intent}|{intent:null}|{error, located?}, afterApply, afterFailure?, view?, locate?}. The tune kind is built in; views/tune/runtime-kinds.js registers power/runtime.
//
// CONFIRMATION (D-053 item 4; assessment F-06). The webview never holds a plan's confirmation code: the shell keeps it (src-tauri/src/helper/confirm.rs). Apply
// asks the shell `app.confirm {plans: [{op, plan_id}, ...]}`, which shows ONE native dialog for every section ("Apply 3 writes to the CPU?"); only the
// operator's click there approves the plans. Then each section is sent as `*.apply {plan_id, intent}` — never a code; the shell adds it. Cancel in the dialog
// writes nothing and leaves the plan reviewable. The dialog names every value the plans write (the shell builds it from its own copy of the plans); a plan it
// cannot describe gets no dialog (CONFIRM_UNAVAILABLE, the sheet shows the reason).
//
// CORRECTNESS (assessment F-05 / R-26, WP-4). A plan is checked against what is on screen right up to the write: the tune section by the identity of the draft
// it was built from, a runtime section (power, caps, uncore) by the intent the edits give NOW (plan 200 W, retype 180 W → Apply refuses: Review again).
// The check runs before the dialog and again after it; the apply carries the intent on screen and the helper refuses a plan of other edits (PLAN_STALE
// INTENT_CHANGED) or of values that moved (STATE_CHANGED): the sheet says which, with Review again. After an apply only the keys that landed are cleared; after a non-ok result that may have written,
// the sheet says the tiles may not show what the CPU holds, re-reads the runtime values and offers Read. Read-only mode disables Apply with the reason.
//
// PROGRESS. The helper's `progress {step, of}` counts operations (writes AND their reads) while `plan.steps` lists the writes, so the per-unit status while
// running is positional (step/of over the ordered writes) and approximate; a unit is only "applied" / "read-back mismatch" once the final `readback` says so.
import { h, clear, setVar } from "../../components/dom.js";
import { button, setBusy } from "../../components/buttons.js";
import { why as whyLine, fillWhy } from "../../components/help.js";
import { openDrawer, closeDrawer, setScreen, setLastRead, setLastApply, setUvp, readOnly } from "../../store.js";
import { WHY, HINTS } from "../../lib/hints.js";
import { plural, fmtMv, fmtV, isNum, DASH, TIMES, MINUS } from "../../lib/format.js";
import { buildIntent } from "../../lib/intent.js";
import { modelFromRead, sameMv, sameV, snapOffsetMv } from "../../lib/units.js";
import { emptyDraft, discardUnits, draftProblems, rebaseDraft, isEmpty as draftIsEmpty } from "../../lib/draft.js";
import { ensureTune, patchTune, fmtSeconds } from "../tune.js";
import { fmtClock } from "../../components/fmt.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
/** G-240: the helper's `detail.check` / `stop.check` for a refused negative offset (Undervolt Protection, rc 0x13); the message is the helper's own, in words. */
export const UVP_CHECK = "UNDERVOLT_PROTECTION";
const isUvp = (error) => isObj(error) && isObj(error.detail) && error.detail.check === UVP_CHECK;
/** The shell op that shows the native confirmation (src-tauri/src/helper/ops.rs SHELL_OPS). */
export const CONFIRM_OP = "app.confirm";

// ---- pure helpers: plan -> rows -------------------------------------------------------------------------------------------------------------------
/** before/after of a plan -> Map unit -> Map point -> entry. Accepts {unit: {point: entry}}, {unit: [entries]} and [{unit, point, ...}] (web/app.js normState). */
function normState(x) {
  const out = new Map();
  const put = (unit, e, i) => {
    if (typeof unit !== "string") return;
    const at = out.get(unit) || new Map();
    out.set(unit, at);
    if (e === null) return void at.set(i, { point: i, unread: true, ratio: null, offset_mv: null, v_target_v: null, effective_v: null, clamped_by: null });
    if (!isObj(e)) return;
    const point = e.oc === true ? 0 : isNum(e.point) ? e.point : i;
    at.set(point, {
      point, unread: false, ratio: isNum(e.ratio) ? e.ratio : null, offset_mv: isNum(e.offset_mv) ? snapOffsetMv(e.offset_mv) : null, v_target_v: isNum(e.v_target_v) ? e.v_target_v : null, // QA-04 (G-248): the 1/1024 V step the CPU holds, like the editor
      effective_v: isNum(e.effective_v) ? e.effective_v : null, clamped_by: isNum(e.clamped_by) ? e.clamped_by : null,
    });
  };
  if (Array.isArray(x)) x.forEach((e, i) => isObj(e) && put(e.unit, e, i));
  else if (isObj(x)) {
    for (const [unit, v] of Object.entries(x)) {
      if (Array.isArray(v)) v.forEach((e, i) => put(unit, e, i));
      else if (isObj(v)) for (const [k, e] of Object.entries(v)) if (/^\d+$/.test(k)) put(unit, e, Number(k));
    }
  }
  return out;
}

// F-14: one definition of "same": the same raw word (lib/units.js), null equal only to null
const sameOff = (a, b) => (a === null && b === null) || sameMv(a, b);
const sameVt = (a, b) => (a === null && b === null) || sameV(a, b);

/** -> [{unit, changes, rows: [{point, b, a, changed}]}] for every unit the plan has before/after for, in plan.units order first. */
export function planRows(plan) {
  const before = normState(plan && plan.before);
  const after = normState(plan && plan.after);
  const ids = [...new Set([...(Array.isArray(plan && plan.units) ? plan.units : []), ...before.keys(), ...after.keys()])].filter((u) => before.has(u) || after.has(u));
  return ids.map((unit) => {
    const pts = [...new Set([...(before.get(unit) || new Map()).keys(), ...(after.get(unit) || new Map()).keys()])].sort((x, y) => x - y);
    const rows = pts.map((point) => {
      const b = (before.get(unit) || new Map()).get(point) || null;
      const a = (after.get(unit) || new Map()).get(point) || null;
      const changed = !b || !a || b.unread || b.ratio !== a.ratio || !sameOff(b.offset_mv, a.offset_mv) || !sameVt(b.v_target_v, a.v_target_v);
      return { point, b, a, changed };
    });
    return { unit, rows, changes: rows.filter((r) => r.changed).length };
  });
}

/** "pt 5 · 53×  0 mV → −19.5 mV" for one changed row (parts that did not change are left out). */
export function describeRow(r) {
  const x = r.a || r.b;
  const label = r.point === 0 ? "OC point" : "pt " + r.point;
  const parts = [];
  const ratio = x && isNum(x.ratio) ? " · " + x.ratio + TIMES : "";
  const arrow = (bv, av, fmt, unread, eq) => (bv === null && unread ? "unread → " + fmt(av) : eq(bv, av) || bv === null ? fmt(av) : fmt(bv) + " → " + fmt(av));
  if (r.a && r.b && r.b.ratio !== r.a.ratio && isNum(r.a.ratio)) parts.push("ratio " + (isNum(r.b.ratio) ? r.b.ratio + TIMES + " → " : "") + r.a.ratio + TIMES);
  if (r.a && (isNum(r.a.offset_mv) || (r.b && isNum(r.b.offset_mv)))) parts.push("offset " + arrow(r.b ? r.b.offset_mv : null, r.a ? r.a.offset_mv : null, fmtMv, r.b && r.b.unread, (p, q) => p === q));
  if (r.a && (isNum(r.a.v_target_v) || (r.b && isNum(r.b.v_target_v))) && (r.point === 0 || !sameVt(r.b ? r.b.v_target_v : null, r.a.v_target_v))) parts.push("target " + arrow(r.b ? r.b.v_target_v : null, r.a ? r.a.v_target_v : null, fmtV, r.b && r.b.unread, (p, q) => p === q));
  if (r.a && isNum(r.a.effective_v)) parts.push("≈ " + fmtV(r.a.effective_v) + (r.a.clamped_by !== null ? " (clamped to V(n−1))" : ""));
  return label + ratio + "  " + (parts.join(", ") || "no change");
}

/** The ordered write list straight from plan.steps (G-153 order; never re-sorted). */
export function stepRows(plan) {
  const steps = Array.isArray(plan && plan.steps) ? plan.steps.filter(isObj) : [];
  return steps.map((s, i) => {
    const kind = typeof s.kind === "string" ? s.kind : "step";
    const unit = typeof s.unit === "string" ? s.unit : s.table ? "turbo " + String(s.table).toUpperCase() : null; // the helper's plan says table "e" | "p"; the read-back rows say "E" | "P"
    let label;
    if (kind === "write_percore_enable") label = "Turn on per-core voltage offsets" + (s.conditional ? " (only if they are off)" : "");
    else if (kind === "write_vf_point") label = (unit || "unit") + " point " + s.point + (isNum(s.offset_mv) ? " offset " + fmtMv(snapOffsetMv(s.offset_mv)) : "") + (isNum(s.cpu) ? " (cpu " + s.cpu + ")" : "");
    else if (kind === "write_msr") label = (unit || "table") + " ratio table, read back on two CPUs";
    else label = kind.replace(/^write_/, "").replace(/_/g, " ") + (unit ? " " + unit : "") + (isNum(s.cpu) ? " (cpu " + s.cpu + ")" : "");
    return { n: isNum(s.n) ? s.n : i + 1, kind, unit, point: isNum(s.point) ? s.point : null, cpu: isNum(s.cpu) ? s.cpu : null, conditional: s.conditional === true, label };
  });
}

/** Unit keys in the order their first write is sent (units without a write in the step list follow, then the before/after units). */
export function unitOrder(plan) {
  const ids = [];
  for (const s of stepRows(plan)) if (s.unit && !s.conditional && !ids.includes(s.unit)) ids.push(s.unit);
  for (const u of [...(Array.isArray(plan && plan.units) ? plan.units : []), ...planRows(plan).map((r) => r.unit)]) if (typeof u === "string" && !ids.includes(u)) ids.push(u);
  return ids;
}

/** G-241: the helper (or the shell) ended this section with an error that says no write was sent (`error.detail.writes_sent === 0`). */
export const noWrites = (sec) => isObj(sec && sec.error) && isObj(sec.error.detail) && sec.error.detail.writes_sent === 0 && ["failed", "cancelled", "stale"].includes(sec.status);

/** Status words of a unit row (no pills: the word, coloured by its data-st). */
export const STATUS_TEXT = {
  queued: "queued", writing: "writing", written: "written", ok: "applied", mismatch: "read-back mismatch", unverified: "written, not read back", no_change: "no change",
  interrupted: "may be written", not_started: "not written",
};
const rbKey = (x) => (x.point === "turbo" ? "turbo " + x.unit : x.unit);

/**
 * Per-unit status. `progress` = {step, of} | null; `outcome` = null (running / not started) | {ok:true, readback:[...], complete?} | {ok:false, started?} | {ok:false, noWrites:true}.
 * G-230: "no change" = nothing was written for the unit; "written, not read back" only for a written word without a read-back.
 * Running: positional (see the header). Finished: only the read-back decides; after a failure or cancel the units already past the current step are "written, not read
 * back", the current one "may be written", the later ones "not written". `noWrites` (the helper or the shell said no write was sent) -> every unit "not written".
 */
export function unitStatuses(plan, progress, outcome) {
  const order = unitOrder(plan);
  if (outcome && outcome.ok === false && outcome.noWrites === true) return Object.fromEntries(order.map((u) => [u, "not_started"]));
  let writes = stepRows(plan).filter((s) => s.unit && !s.conditional).map((s) => s.unit);
  if (!writes.length) writes = order.slice();
  const out = {};
  for (const u of order) out[u] = "queued";
  if (outcome && outcome.ok) {
    const by = new Map();
    for (const x of (outcome.readback || []).filter(isObj)) by.set(rbKey(x), (by.get(rbKey(x)) || []).concat(x));
    for (const u of order) {
      const rb = by.get(u);
      out[u] = rb ? (rb.every((x) => x.match === true) ? "ok" : "mismatch") : !writes.includes(u) || (outcome.complete !== false && u.startsWith("turbo")) ? "no_change" : "unverified";
    }
    return out;
  }
  const step = progress && isNum(progress.step) ? progress.step : 0;
  const idx = step > 0 && writes.length ? Math.min(writes.length - 1, Math.floor(((step - 1) / Math.max(1, progress.of || 1)) * writes.length)) : -1;
  for (const u of order) {
    const at = writes.map((w, i) => (w === u ? i : -1)).filter((i) => i >= 0);
    if (!at.length && outcome) out[u] = "no_change";
    if (!at.length || idx < 0) {
      if (outcome && at.length) out[u] = outcome.started ? "interrupted" : "not_started"; // stopped before the first progress step: written only if the op had started
      continue;
    }
    const current = at.includes(idx);
    const past = at.every((i) => i < idx);
    if (outcome) out[u] = current ? "interrupted" : past ? "unverified" : "not_started";
    else out[u] = current ? "writing" : past ? "written" : "queued";
  }
  return out;
}

/**
 * The same for a kind with its own view (power / caps / uncore): one status per diff row, from the read-back rows of its keys; positional over the plan steps while
 * running. `rows` = [{unit, keys, sunit?}]; the statuses are keyed by `sunit` (else `unit`).
 */
export function keyedStatuses(rows, plan, progress, outcome, summary) {
  const out = {};
  const id = (r) => r.sunit || r.unit;
  const steps = (Array.isArray(plan && plan.steps) ? plan.steps : []).filter(isObj).map((s) => String(s.key));
  const idx = progress && isNum(progress.step) && progress.step > 0 && steps.length ? Math.min(steps.length - 1, Math.floor(((progress.step - 1) / Math.max(1, progress.of || 1)) * steps.length)) : -1;
  for (const r of rows) {
    const pos = r.keys.map((k) => steps.indexOf(String(k))).filter((i) => i >= 0);
    if (outcome && outcome.ok) {
      const rb = summary ? summary.readback.filter((x) => r.keys.map(String).includes(String(x.key))) : [];
      out[id(r)] = rb.length ? (rb.every((x) => x.match === true) ? "ok" : "mismatch") : "unverified";
    } else if (outcome && outcome.noWrites) out[id(r)] = "not_started";
    else if (outcome) out[id(r)] = idx < 0 || !pos.length ? "not_started" : pos.every((i) => i < idx) ? "unverified" : pos.includes(idx) ? "interrupted" : "not_started";
    else if (idx < 0 || !pos.length) out[id(r)] = "queued";
    else out[id(r)] = pos.every((i) => i < idx) ? "written" : pos.includes(idx) ? "writing" : "queued";
  }
  return out;
}

/** {remainingMs, text}: remaining time from the measured per-op time; null/"" before the first step. */
export function eta(elapsedMs, step, of) {
  if (!(isNum(elapsedMs) && isNum(step) && isNum(of) && step > 0 && of > 0)) return { remainingMs: null, text: "" };
  const remainingMs = Math.max(0, (elapsedMs / step) * (of - step));
  return { remainingMs, text: "~" + fmtSeconds(remainingMs) + " left" };
}

export function progressText(progress, elapsedMs) {
  if (!progress || !progress.of) return "waiting for the first step";
  const e = eta(elapsedMs, progress.step, progress.of);
  return "step " + progress.step + " of " + progress.of + " · " + fmtSeconds(elapsedMs) + " elapsed" + (e.text ? " · " + e.text : "");
}

/** The final *.apply result -> what the sheet shows. */
export function summarizeResult(result) {
  const r = isObj(result) ? result : {};
  const readback = (Array.isArray(r.readback) ? r.readback : []).filter(isObj);
  const mismatches = readback.filter((x) => x.match !== true);
  const complete = r.complete !== false;
  return {
    readback,
    total: readback.length,
    matched: readback.length - mismatches.length,
    mismatches,
    complete,
    stop: !complete ? (isObj(r.stop) ? r.stop : {}) : null,
    uvp: typeof r.uvp === "string" ? r.uvp : null,
    opsUsed: isNum(r.ops_used) ? r.ops_used : null,
    writesSent: isNum(r.writes_sent) ? r.writes_sent : null,
    cpufreq: (Array.isArray(r.cpufreq) ? r.cpufreq : []).filter((x) => isObj(x) && isNum(x.cpu) && isNum(x.before_khz) && isNum(x.after_khz)),
    residual: (Array.isArray(r.residual) ? r.residual : []).map(String),
    ringRefused: (Array.isArray(r.ring_refused) ? r.ring_refused : []).map(String),
    // G-242 (QA-29): a complete run with an empty read-back (nothing was written, nothing to compare) is not a mismatch
    allMatch: complete && mismatches.length === 0,
    nothingToDo: r.nothing_to_do === true,
  };
}

/**
 * G-232: the cells of one read-back row. V/F rows say {unit, point, cpu, expected, actual}; the power / runtime helpers say {domain?, key, expected: [lo, hi], file: value read},
 * which are shown by file and key ("cpu7" / "scaling_max_freq"), never as a V/F "pt".
 */
export function readbackCells(x) {
  if (typeof x.unit === "string") return { unit: x.point === "turbo" ? "turbo table " + x.unit : x.unit, point: x.point === 0 ? "OC point" : x.point === "turbo" ? "ratios" : "pt " + x.point, cpu: isNum(x.cpu) ? x.cpu : "", expected: x.expected ?? DASH, actual: x.actual ?? "not read back" };
  const key = String(x.key ?? "?");
  const m = /^cpu(\d+)$/.exec(key);
  const [lo, hi] = Array.isArray(x.expected) ? x.expected : [];
  const [unit, point] = x.domain === "caps" ? [key, "scaling_max_freq"] : x.domain === "uncore" ? ["uncore", key.replace("_ratio", "_freq_khz")] : ["power", key];
  return { unit, point, cpu: m ? Number(m[1]) : "", expected: isNum(lo) ? (lo === hi ? String(lo) : lo + "–" + hi) : DASH, actual: isNum(x.file) ? String(x.file) : "not read back" };
}

/** G-237: a V/F word whose V target landed late says so ("settled after 2 re-reads", `polls` / `settle_ms` of the guard's read-back record); "" when it matched on the first read or the helper sent no count. */
export function settledNote(x) {
  if (!isObj(x) || !isNum(x.polls) || x.polls < 1) return "";
  return "settled after " + plural(x.polls, "re-read") + (isNum(x.settle_ms) ? " (" + Math.round(x.settle_ms) + " ms)" : "");
}

/** G-232: the box of a partial apply: V/F words speak of the CPU's words; the runtime kinds (power / caps / uncore) of runtime settings, which a reboot restores. */
export function partialWording(runtimeKind, tripped = false) {
  const guard = tripped ? " The guard tripped." : "";
  return runtimeKind
    ? { title: "Some runtime settings were written, some not.", text: "The table shows which. Use the Restore boot button on that tab, or reboot (runtime values do not survive a reboot)." + guard }
    : { title: "The CPU holds a mix of old and new words.", text: "Do not rely on it: restore the accepted state, or cold boot. The table says which words did land." + guard };
}

export function resultHeadline(s) {
  if (!s.complete) return "Partial apply: it stopped after " + (s.writesSent !== null ? plural(s.writesSent, "write") : "some writes") + (s.stop && s.stop.reason && s.stop.check !== UVP_CHECK ? ". " + s.stop.reason : "");  // the Undervolt Protection message has its own box
  if (!s.total) return "Applied; the helper returned no read-back words";
  return s.mismatches.length ? s.mismatches.length + " of " + s.total + " words differ on read-back" : s.matched + "/" + s.total + " words read back as written";
}

/** Plan warnings are {code, text} (a bare string is a NOTE). `cls` "warn"/"bad" marks a warning; "" a note. */
const WARN_CODES = {
  CLAMPED: ["warn", "Clamped"], E40_OFFSET: ["bad", "Careful"], E_TARGET_WHEA: ["warn", "WHEA risk"], POSITIVE_OFFSET: ["warn", "Raises voltage"], NO_BASELINE: ["", ""],
  TURBO_RAISE: ["warn", "Turbo raise"], RING_NOT_RESTORED: ["warn", "Ring not written"], LARGE_CHANGE: ["warn", "Large step"], TURBO_NOT_MONOTONIC: ["warn", "Table rises"],
  TURBO_BELOW_BASE: ["warn", "Below base"], TURBO_BELOW_OC: ["warn", "Capped"], PL2_BELOW_PL1: ["warn", "Unusual"], DEEP_WHOLE_CURVE: ["warn", "Deep offset"], NOTE: ["", ""],
};
const CODED = /^([A-Z][A-Z0-9_]+): ([\s\S]+)$/;
/** Warnings are never blocking: the sheet shows them (amber) and Apply stays available. power.plan / runtime.plan send them as "CODE: text" strings, tune.plan as {code, text}. */
export function planWarnings(plan) {
  const out = [];
  for (const w of Array.isArray(plan && plan.warnings) ? plan.warnings : []) {
    const m = typeof w === "string" ? CODED.exec(w) : null;
    const coded = m && Object.prototype.hasOwnProperty.call(WARN_CODES, m[1]);
    const code = isObj(w) && typeof w.code === "string" ? w.code : coded ? m[1] : "NOTE";
    const text = isObj(w) ? w.text : coded ? m[2] : w;
    if (typeof text !== "string" || !text) continue;
    const [cls, label] = Object.prototype.hasOwnProperty.call(WARN_CODES, code) ? WARN_CODES[code] : WARN_CODES.NOTE;
    out.push({ code, text, cls, label });
  }
  return out;
}

// ---- plan notes in operator words (UX report U-31; DESIGN §5.10: no register codes in the prose) ----
/** Known helper notes -> one plain sentence, "" = shown elsewhere (the undo line) or not news. Matched on the helper's own text. */
const NOTE_WORDS = [
  [/^per-point offsets change one V\/F point/i, "The CPU keeps each point at or above the one below it, so a point can run higher than its own offset says."],
  [/stock baseline|no curve is flagged baseline/i, "No stock baseline curve: the voltage prediction uses the factory points only. Measure one in Curves."],
  [/^a reboot restores the BIOS-programmed state/i, ""],
  [/runtime (state|values): a reboot restores/i, ""],
  [/^tau is rounded down/i, "The time window is rounded down to a value the register can hold; the read-back shows exactly that value."],
  [/journaled before the first write/i, "The values in force now are saved before the first write, so Restore boot values can put them back."],
  [/an E-cluster runs one ratio/i, null], // plain already: kept, cleaned
  // G-242 (QA-31): the notes every V/F plan carries; the helper's own wording goes to the Technical disclosure (planNotes.tech)
  [/^the 0x11 word and its 0x1D\/0x27/i, "Ratio and voltage-target changes are sent the way Intel XTU sends them on Windows."],
  [/^E-core entries apply to all (\d+) CPUs of their cluster/i, (m) => "E-core values apply to all " + m[1] + " cores of a cluster."],
  [/^restore applies the accepted profile ([^\s(]+)/i, (m) => "Restores the accepted state (" + m[1] + "). Only the words that differ are written."],
  [/^restore also looks for a residual OC point/i, "Restore also checks for a leftover OC point and rewrites it when it finds one."],
  [/^no read of this boot to look at/i, "There is no read since boot to look at: read the CPU first so the restore can see a leftover OC point."],
  [/^the apply orders the writes so that no ratio/i, "The writes are ordered so that no ratio's voltage dips."],
  [/^this plan RAISES a ratio, V target or offset/i, "This plan raises a ratio or a voltage target. Run a stability check before relying on it."],
];
/** A helper sentence cleaned for an operator: register / task references and evidence tags out, arrows and minus signs typeset, first letter up, one period. */
export function plainWords(text) {
  let t = String(text || "")
    .replace(/\s*\[(COMMUNITY|MEASURED|DOC|DECOMPILED|UNVERIFIED)[^\]]*\]/g, "")
    .replace(/\s*\((?:[^()]*?\b(?:0x[0-9a-f]+|MSR|G-\d+|D-\d+|P2 = |[A-Z]{3,}_[A-Z_]+)\b[^()]*)\)/gi, "")
    .replace(/\s*->\s*/g, " → ")
    .replace(/(^|[\s(:])-(\d)/g, "$1" + MINUS + "$2")
    .replace(/\b(\d+)x\b/g, "$1" + TIMES)
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!t) return "";
  t = t[0].toUpperCase() + t.slice(1);
  return /[.?]$/.test(t) ? t : t + ".";
}

/**
 * The plan's warnings and notes in operator words: {warnings: [{lead, text, code}], notes: [text]}. Warnings (amber, always shown) keep their lead word; LARGE_CHANGE lines
 * that say the same jump are merged ("cpu 8, 9, 10, 11: cap 49× → 23×"). Notes fold away. Duplicates are dropped.
 */
export function planNotes(plan) {
  const warnings = [];
  const notes = [];
  const tech = []; // [{text, detail}]: the helper's own wording of every note shown in other words
  const large = new Map(); // "a → b" -> [subjects]
  for (const w of planWarnings(plan)) {
    if (w.code === "LARGE_CHANGE") {
      const m = /^(.*?):\s*(?:cap\s+)?(\d+)\s*->\s*(\d+)/.exec(w.text);
      if (m) {
        const k = m[2] + TIMES + " → " + m[3] + TIMES;
        large.set(k, (large.get(k) || []).concat(m[1].replace(/^cpu\s*/, "")));
        continue;
      }
    }
    const known = NOTE_WORDS.find(([re]) => re.test(w.text));
    const text = known ? (typeof known[1] === "function" ? known[1](known[0].exec(w.text)) : known[1] !== null ? known[1] : plainWords(w.text)) : plainWords(w.text);
    if (!text) continue;
    // QA-31: what the helper said, when the sheet says it differently, is kept for the Technical disclosure (evidence tags, register words and all)
    if (text !== w.text && !tech.some((x) => x.detail === w.text)) tech.push({ text, detail: w.text });
    if (w.cls) {
      if (!warnings.some((x) => x.text === text)) warnings.push({ lead: w.label || "Warning", text, code: w.code });
    } else if (!notes.includes(text)) notes.push(text);
  }
  for (const [jump, who] of large) {
    const cpus = who.every((x) => /^\d+$/.test(x)) ? "cpu " + who.join(", ") : who.join(", ");
    warnings.unshift({ lead: "Large step", text: cpus + ": " + jump + " in one step (more than 4 bins).", code: "LARGE_CHANGE" });
  }
  return { warnings, notes, tech };
}

/** G-242 (QA-05): the writes a plan certainly sends. The conditional per-core enable (`conditional: true` in the steps) is not one of them; see planConditional. */
export const planWrites = (plan) => (isNum(plan && plan.writes) ? plan.writes : stepRows(plan).filter((s) => !s.conditional).length);
/** How many more writes the plan sends only when needed (the per-core voltage enable, when the CPU has it off). */
export const planConditional = (plan) => (isNum(plan && plan.conditional_writes) ? plan.conditional_writes : stepRows(plan).filter((s) => s.conditional).length);
/** G-248: the most extra writes a restore may send when its apply finds a leftover OC point (`residual_writes_max`; not in `writes`, not in the steps). */
export const planResidual = (plan) => (isObj(plan) && isNum(plan.residual_writes_max) && plan.residual_writes_max > 0 ? plan.residual_writes_max : 0);
/** "+ up to 16 if a leftover OC point is found". */
export const residualText = (n) => "+ up to " + n + " if a leftover OC point is found";
/** "2 writes" or "2 writes (+1 if needed)"; G-248: a restore that may rewrite a leftover OC point says "(+ up to 16 if a leftover OC point is found)" too. */
export const writesText = (writes, conditional, residual = 0) => {
  const extra = [conditional ? "+" + conditional + " if needed" : "", residual ? residualText(residual) : ""].filter(Boolean);
  return plural(writes, "write") + (extra.length ? " (" + extra.join("; ") + ")" : "");
};
/** G-252: "−49.8 mV" → "−54.7 mV" as "−49.8 → −54.7 mV" (the shared unit once, at the end). */
export function arrowText(before, after) {
  const unit = (x) => { const m = /\s(\S+)$/.exec(String(x)); return m ? m[1] : ""; };
  const u = unit(after);
  const b = u && unit(before) === u ? String(before).slice(0, -(u.length + 1)) : String(before);
  return b + " → " + after;
}

/**
 * G-252: what ONE section writes, one item per write, in plain words ("P0 point 5, −49.8 → −54.7 mV"; "turbo P table"; "Package long-term limit PL1, 268 W → 270 W").
 * `view` = the kind's custom view (power / caps / uncore) when it has one. -> {items, certain, setup} or null when the step list is unusable (cut, or empty): the caller says only the count.
 */
export function writeItems(sec, view = null) {
  const plan = sec && sec.plan;
  if (!isObj(plan) || plan.steps_truncated === true) return null;
  const vr = view && Array.isArray(view.rows) ? view.rows : null;
  if (vr) {
    const items = vr.map((r) => [r.unit, r.what].filter(Boolean).join(" ") + (r.before !== undefined && r.after !== undefined ? ", " + arrowText(r.before, r.after) : ""));
    return items.length ? { items, certain: planWrites(plan), setup: planConditional(plan) } : null;
  }
  const steps = stepRows(plan);
  if (!steps.length) return null;
  const byUnit = new Map(planRows(plan).map((u) => [u.unit, u.rows]));
  const items = [];
  for (const st of steps) {
    if (st.conditional) continue;
    if (st.kind === "write_vf_point" && st.unit) {
      const row = (byUnit.get(st.unit) || []).find((r) => r.point === st.point);
      const label = st.unit + " " + (st.point === 0 ? "OC point" : "point " + st.point);
      const parts = [];
      if (row && row.a) {
        const a = row.a;
        const b = row.b && !row.b.unread ? row.b : null;
        if (b && isNum(a.ratio) && b.ratio !== a.ratio) parts.push("ratio " + arrowText(isNum(b.ratio) ? b.ratio + TIMES : DASH, a.ratio + TIMES));
        if (isNum(a.offset_mv) && !(b && sameOff(b.offset_mv, a.offset_mv))) parts.push(b && isNum(b.offset_mv) ? arrowText(fmtMv(b.offset_mv), fmtMv(a.offset_mv)) : fmtMv(a.offset_mv));
        if (isNum(a.v_target_v) && !(b && sameVt(b.v_target_v, a.v_target_v))) parts.push("target " + (b && isNum(b.v_target_v) ? arrowText(fmtV(b.v_target_v), fmtV(a.v_target_v)) : fmtV(a.v_target_v)));
      }
      items.push(parts.length ? label + ", " + parts.join(", ") : label);
    } else if (st.kind === "write_msr") items.push((st.unit || "turbo") + " table");
    else items.push(st.label);
  }
  return { items, certain: planWrites(plan), setup: planConditional(plan) };
}

/** G-252: the sheet's "Writes" text from the per-section items: "1 write: P0 point 5, −49.8 → −54.7 mV (+1 setup write if per-core voltage control is off). Each write is read back." */
export function writesLine(parts) {
  const MAX = 4;
  const setupWord = (n) => n + " setup " + (n === 1 ? "write" : "writes");
  const text = parts.map((p) => {
    if (p.certain === 0 && p.setup) return setupWord(p.setup) + ", only if per-core voltage control is off";
    let body = plural(p.certain, "write");
    if (p.items && p.items.length) body += ": " + (p.items.length > MAX ? p.items.slice(0, MAX).join("; ") + "; and " + (p.items.length - MAX) + " more (listed above)" : p.items.join("; "));
    if (p.setup) body += " (+" + setupWord(p.setup) + " if per-core voltage control is off)";
    return body;
  });
  return text.join(" · ") + ". Each write is read back.";
}

/** G-242 (QA-29): a plan that sends nothing at all: no write, and the helper does not say it could still add one (`nothing_to_do: false`, a restore's leftover OC point). */
export const isEmptyPlan = (plan) => isObj(plan) && planWrites(plan) === 0 && planConditional(plan) === 0 && planResidual(plan) === 0 && plan.nothing_to_do !== false;

// ---- the diff: one row per value a plan changes, grouped by unit in write order ----
const sign = (x, digits = 0) => (x > 0 ? "+" : x < 0 ? MINUS : "") + Math.abs(x).toFixed(digits);
const ratioTxt = (r) => (isNum(r) ? r + TIMES : DASH);
/** A mV step with the decimal the values show (−19.5, not −20). */
const mvDelta = (d) => sign(d, Math.abs(Math.round(d * 10) / 10) % 1 ? 1 : 0);

/**
 * -> [{unit, what, before, after, delta, sunit}] for a tune-shaped plan (`sunit` = the status key: the unit, or "turbo P"). A unit whose every changed point moves by the same
 * offset collapses to one row ("6 points"). Turbo rows come from the section's intent against `model` (the plan lists only the table write).
 */
export function tuneDiffRows(plan, intent, model) {
  const out = [];
  for (const u of planRows(plan)) {
    const changed = u.rows.filter((r) => r.changed);
    const offs = changed.filter((r) => r.a && r.b && !r.b.unread && r.b.ratio === r.a.ratio && sameVt(r.b.v_target_v, r.a.v_target_v));
    const uniform = offs.length >= 3 && offs.length === changed.length && offs.every((r) => sameOff(r.b.offset_mv, offs[0].b.offset_mv) && sameOff(r.a.offset_mv, offs[0].a.offset_mv));
    if (uniform) {
      const r = offs[0];
      out.push({ unit: u.unit, what: offs.length + " points, offset", before: fmtMv(r.b.offset_mv), after: fmtMv(r.a.offset_mv), delta: mvDelta(r.a.offset_mv - r.b.offset_mv), sunit: u.unit });
      continue;
    }
    for (const r of changed) {
      const x = r.a || r.b;
      const label = r.point === 0 ? "OC point" : "point " + r.point + (x && isNum(x.ratio) ? " · " + x.ratio + TIMES : "");
      const b = r.b && !r.b.unread ? r.b : null;
      const a = r.a;
      if (!a) continue;
      if (b && b.ratio !== a.ratio && isNum(a.ratio)) out.push({ unit: u.unit, what: (r.point === 0 ? "OC point" : "point " + r.point) + " ratio", before: ratioTxt(b.ratio), after: ratioTxt(a.ratio), delta: isNum(b.ratio) ? sign(a.ratio - b.ratio) : "", sunit: u.unit });
      if ((isNum(a.offset_mv) || (b && isNum(b.offset_mv))) && !(b && sameOff(b.offset_mv, a.offset_mv))) {
        out.push({ unit: u.unit, what: label + (r.a.clamped_by !== null ? " (clamped)" : ""), before: b ? fmtMv(b.offset_mv) : "unread", after: fmtMv(a.offset_mv), delta: b && isNum(b.offset_mv) && isNum(a.offset_mv) ? mvDelta(a.offset_mv - b.offset_mv) : "", sunit: u.unit });
      }
      if (isNum(a.v_target_v) && !(b && sameVt(b.v_target_v, a.v_target_v))) {
        out.push({ unit: u.unit, what: label + " target", before: b && isNum(b.v_target_v) ? fmtV(b.v_target_v) : b ? "none" : "unread", after: fmtV(a.v_target_v), delta: b && isNum(b.v_target_v) ? sign(a.v_target_v - b.v_target_v, 3) : "", sunit: u.unit });
      }
    }
  }
  const turbo = isObj(intent) && isObj(intent.turbo) ? intent.turbo : {};
  for (const kind of ["P", "E"]) {
    const want = turbo[kind];
    if (!Array.isArray(want)) continue;
    const cur = model && model.turbo && model.turbo[kind] ? model.turbo[kind] : null;
    const sunit = "turbo " + kind;
    if (!cur || !Array.isArray(cur.ratios)) {
      out.push({ unit: sunit, what: "ratio table", before: DASH, after: want.map((r) => r + TIMES).join(" "), delta: "", sunit });
      continue;
    }
    want.forEach((r, i) => {
      if (r === cur.ratios[i]) return;
      const n = Array.isArray(cur.counts) && isNum(cur.counts[i]) && cur.counts[i] > 0 ? cur.counts[i] : i + 1;
      out.push({ unit: sunit, what: n === 1 ? "1 active core" : n + " active cores", before: ratioTxt(cur.ratios[i]), after: ratioTxt(r), delta: isNum(cur.ratios[i]) ? sign(r - cur.ratios[i]) : "", sunit });
    });
  }
  // the order of the writes: units by their first write, rows of a unit together
  const order = unitOrder(plan);
  const rank = (u) => (order.includes(u) ? order.indexOf(u) : order.length);
  return out.map((r, i) => ({ r, i })).sort((p, q) => rank(p.r.sunit) - rank(q.r.sunit) || p.i - q.i).map((x) => x.r);
}

// ---- plan errors -> the field -------------------------------------------------------------------------------------------------------------------
/**
 * A plan refusal -> {unit, field, ratio, point, message, check}. `field` is "point" | "curve" | "vt" | "ratio" | "ring" | "turbo" | null (nothing to point at: the sheet says it).
 * The helper names the field in the message prefix ("P0: offset -250 mV ...", "ring point 3: ...", "turbo.P: ...") and the intent maps the quoted value back to a ratio.
 */
export function locateError(error, intent) {
  const message = String((error && (error.message || error.code)) || "");
  const check = isObj(error && error.detail) && typeof error.detail.check === "string" ? error.detail.check : null;
  const base = { unit: null, field: null, ratio: null, point: null, message, check };
  if (check === "NO_READ") return { ...base, field: null };
  let m = /^ring point (\d+):/.exec(message);
  if (m) return { ...base, unit: "ring", field: "ring", point: Number(m[1]) };
  m = /^turbo\.([PEpe]):/.exec(message);
  if (m) return { ...base, unit: "turbo " + m[1].toUpperCase(), field: "turbo" };
  m = /^(P\d+|EC\d+|ring):/.exec(message);
  if (!m) return base;
  const unit = m[1];
  const row = isObj(intent) && Array.isArray(intent.rows) ? intent.rows.find((r) => r && r.target === unit) : null;
  const o = /offset ([+-]\d+) mV/.exec(message);
  if (o) {
    const mv = Number(o[1]);
    if (row && row.offset && row.offset.kind === "points") {
      const ratio = Object.keys(row.offset.mv).find((k) => row.offset.mv[k] === mv);
      return { ...base, unit, field: ratio !== undefined ? "point" : "curve", ratio: ratio !== undefined ? Number(ratio) : null };
    }
    return { ...base, unit, field: "curve" };
  }
  if (/OC-point voltage/.test(message)) return { ...base, unit, field: "vt" };
  if (/ratio \d+ is above/.test(message)) return { ...base, unit, field: "ratio" };
  return { ...base, unit };
}

/**
 * G-227: the units model with the plan's predicted offsets (and the intent's turbo tables) laid over the words whose read-back matched (`summary.readback` rows {unit, point, match};
 * a turbo row is {unit: "P"|"E", point: "turbo"}); null when nothing changed. Pure. Only offsets and ratios are patched (this module has no word decoder): a word that read back
 * different is left as it was, and the caller says so.
 */
export function modelAfterApply(model, section, summary) {
  if (!isObj(model) || !isObj(section) || !isObj(section.plan)) return null;
  const after = normState(section.plan.after);
  const turbo = isObj(section.intent) && isObj(section.intent.turbo) ? section.intent.turbo : {};
  let next = null;
  for (const row of summary.readback) {
    if (row.match !== true) continue;
    if (row.point === "turbo") {
      if (isObj(model.turbo) && isObj(model.turbo[row.unit]) && Array.isArray(turbo[row.unit]) && turbo[row.unit].length === 8) {
        next ||= structuredClone(model);
        next.turbo[row.unit].ratios = turbo[row.unit].slice();
      }
      continue;
    }
    const entry = after.has(row.unit) ? after.get(row.unit).get(row.point) : null;
    if (!isNum(row.point) || !model.units[row.unit] || !entry || !isNum(entry.offset_mv)) continue;
    const at = (m) => {
      const u = m.units[row.unit];
      return [row.point === 0 ? u.oc : null, u.points.find((p) => p.point === row.point), u.ocPoint && u.ocPoint.point === row.point ? u.ocPoint : null].filter(Boolean);
    };
    if (!at(model).length) continue;
    next ||= structuredClone(model);
    for (const t of at(next)) t.offset_mv = entry.offset_mv;
  }
  return next;
}

/** Text of a draft problem (lib/draft.js draftProblems): the WHY template when hints.js has one, else the sentence here. */
const PROBLEM_TEXT = {
  "refused.curve_and_points": "a whole-curve change and point changes cannot go in one review (the CPU adds the two). Apply one first, then the other.",
  "refused.target_needs_oc_point": "a target voltage needs an OC point: set an OC ratio above the factory top first.",
};
export function problemText(p) {
  const body = WHY[p.reason] ? fillWhy(p.reason, p.values || {}).text : PROBLEM_TEXT[p.reason] || p.reason;
  return (p.unit ? p.unit + ": " : "") + body;
}

// ---- section kinds -------------------------------------------------------------------------------------------------------------------------------
export const KINDS = {
  tune: {
    label: "V/F points & turbo tables",
    short: "V/F & ratios",
    planOp: "tune.plan",
    applyOp: "tune.apply",
    /** -> {intent, draftRef} | {intent: null} (nothing pending) | {error, located?}. A draft that cannot be planned as it is (draftProblems) never reaches the helper. */
    request(store) {
      const t = ensureTune(store);
      if (!t.model) return { error: "Read the CPU state first: a plan is made against the words of a read." };
      const problems = draftProblems(t.model, t.draft);
      if (problems.length) return { error: problems.map(problemText).join(" "), located: problems[0].unit ? { unit: problems[0].unit, field: problems[0].reason === "refused.curve_and_points" ? "curve" : null, ratio: null, point: null, message: problemText(problems[0]), check: null } : null };
      const built = buildIntent(t.model, t.draft);
      if (built.error) return { error: built.error, located: built.unit ? { unit: built.unit, field: null, ratio: null, point: null, message: built.error, check: null } : null };
      return { intent: built.intent, draftRef: t.draft };
    },
    locate: locateError,
    rows: (sec, store) => tuneDiffRows(sec.plan, sec.intent, store.get().tune && store.get().tune.model),
    undo: "Restore accepted, or a cold boot.",
    writesWord: "mailbox",
    /**
     * After an apply: re-read tune.last (no mailbox traffic) so the unit table shows the new words. G-227: when the helper has no usable record the model is patched from the
     * plan and the matched read-back rows. Only what landed leaves the draft: a draft unchanged since the plan is cleared (all matched) or loses the written units (a
     * mismatch: the CPU's value shows); a draft edited meanwhile is re-based on the new model (entries now equal to the CPU go, the rest stay pending; F-13).
     */
    async afterApply({ store, bridge, section, summary, toast }) {
      const last = await bridge.call("tune.last");
      const rec = last.ok && isObj(last.result) && last.result.available && isObj(last.result.result) && last.result.applied_at != null ? last.result : null;
      const patch = {};
      let model = rec ? modelFromRead(rec.result) : null;
      if (model) {
        const at = isNum(rec.at) ? new Date(rec.at * 1000).toISOString() : new Date().toISOString();
        Object.assign(patch, { model, read: { ...store.get().tune.read, state: "ready", fromLast: true, at, durationMs: null, ops: rec.result.ops_done ?? null, error: null } });
        setLastRead(store, at, rec.result.accepted_match ?? null, rec.result.accepted_note || "", rec.result.uvp);
      } else if ((model = modelAfterApply(store.get().tune.model, section, summary))) {
        patch.model = model;
        if (toast) toast("warn", "The helper has no stored read to show the applied words from: the tiles follow the plan and the read-back. Re-read the CPU state to confirm.");
      }
      const draft = store.get().tune.draft;
      if (model && draft === section.draftRef) {
        // a mismatch is said by the sheet's result box (and by the end-of-run toast when the sheet is closed); the units show what the CPU holds
        patch.draft = summary.allMatch ? emptyDraft() : discardUnits(section.draftRef, summary.readback.map((x) => x.unit).filter((u) => typeof u === "string"));
      } else if (model && !draftIsEmpty(draft)) patch.draft = rebaseDraft(model, draft).draft;
      if (Object.keys(patch).length) patchTune(store, patch);
    },
  },
};

export function registerKind(name, spec) {
  if (typeof name !== "string" || !spec || typeof spec.planOp !== "string" || typeof spec.applyOp !== "string" || typeof spec.request !== "function") throw new TypeError("registerKind: {planOp, applyOp, request} required");
  KINDS[name] = { label: name, ...spec };
}

// ---- the controller (no DOM) ---------------------------------------------------------------------------------------------------------------------
export const initialApply = () => ({
  state: "idle", // idle | planning | review | confirming | applying | done | failed
  sections: [], // see makeSection
  requests: [], // what was asked (Review again re-plans from these)
  error: null, // a request-level problem (nothing to apply, no read yet, a plan refusal): {message, located}
  confirm: null, // the last native confirmation that did not approve: {code, message}
  stale: null, // after a non-ok result that may have written: {kinds: [...]} (the tiles may not show what the CPU holds)
  startedAt: null,
  seq: 0,
});

export function ensureApply(store) {
  if (!store.get().apply) store.set({ apply: initialApply() });
  return store.get().apply;
}

/** statuses: planning | review | stale (helper PLAN_STALE) | applying | done | failed | cancelled | skipped */
const makeSection = (kind, spec, req) => ({
  kind, label: req.label || spec.label, intent: req.intent, draftRef: req.draftRef, track: req.track === true, plan: null, issuedAt: null, status: "planning", opId: null, progress: null,
  result: null, summary: null, error: null, cancelling: false,
});

/** Error codes the shell or helper use for an apply that sent nothing (besides `detail.writes_sent === 0`). */
const NOTHING_SENT = ["PLAN_STALE", "CONFIRM_MISMATCH", "NOT_CONFIRMED", "CONFIRM_UNAVAILABLE", "NOT_CONNECTED", "BAD_REQUEST", "UNKNOWN_OP", "BUSY", "VERSION_MISMATCH"];

/** Writes a section sent: a number, or null when unknown (a long op that ended in an error after it started). */
export function writesSentOf(sec) {
  if (sec.status === "done") return sec.summary && sec.summary.writesSent !== null ? sec.summary.writesSent : planWrites(sec.plan);
  if (!["failed", "cancelled", "stale"].includes(sec.status) || !sec.error) return 0;
  if (isObj(sec.error.detail) && isNum(sec.error.detail.writes_sent)) return sec.error.detail.writes_sent;
  if (!sec.opId) return NOTHING_SENT.includes(sec.error.code) || !sec.plan ? 0 : null; // answered at once: refused before the op started (UVP at the first write: unknown)
  return null;
}

/**
 * createApplyController({store, bridge, toast, kinds, now, readOnlyGate}). `readOnlyGate`: "known" (default) refuses Apply when the preflight said writes are off;
 * "strict" (the sheet) also while the preflight has not answered.
 */
export function createApplyController({ store, bridge, toast = () => {}, kinds = KINDS, now = () => performance.now(), readOnlyGate = "known" }) {
  ensureTune(store);
  ensureApply(store);
  const get = () => store.get().apply;
  const patch = (p) => store.update((s) => ({ apply: { ...s.apply, ...p } }));
  const setSection = (i, p) => store.update((s) => ({ apply: { ...s.apply, sections: s.apply.sections.map((x, j) => (j === i ? { ...x, ...p } : x)) } }));
  const connected = () => store.get().link.state === "connected";
  let busy = false;

  async function planSection(i) {
    const sec = get().sections[i];
    const spec = kinds[sec.kind];
    setSection(i, { status: "planning", error: null, plan: null, opId: null, progress: null });
    const res = await bridge.call(spec.planOp, spec.planArgs ? spec.planArgs(sec.intent) : { intent: sec.intent });
    if (res.ok && isObj(res.result) && typeof res.result.plan_id === "string") {
      setSection(i, { status: "review", plan: res.result, issuedAt: now(), error: null });
      return true;
    }
    let error = res.ok ? { code: "BAD_REPLY", message: "the helper's plan had no plan_id" } : res.error;
    if (spec.explain) error = { ...error, message: spec.explain(error) };
    if (isUvp(error)) setUvp(store, "on"); // a plan refused for Undervolt Protection: the helper knows it is on
    setSection(i, { status: "failed", error: { ...error, located: spec.locate ? spec.locate(error, sec.intent) : null } });
    return false;
  }

  /** A request (a kind name, or {kind, intent, label, track?}) -> {name, spec, req}. A tracked request takes its intent from the store again (the edits on screen). */
  function build(r) {
    const name = typeof r === "string" ? r : r.kind;
    const spec = kinds[name];
    if (!spec) throw new Error("apply: unknown section kind " + name);
    if (typeof r === "string") return { name, spec, req: spec.request(store) };
    if (r.track === true) {
      const live = spec.request(store);
      return { name, spec, req: live.error ? live : { intent: live.intent, label: r.label, track: true } };
    }
    return { name, spec, req: { intent: r.intent, label: r.label } };
  }

  async function planAll(sections) {
    for (let i = 0; i < sections.length; i++) {
      if (get().sections[i].status === "done") continue;
      if (!(await planSection(i))) {
        const err = get().sections[i].error;
        patch({ state: "failed", error: { message: sections.length > 1 ? sections[i].label + ": " + err.message : err.message, located: err.located } });
        return "failed";
      }
    }
    patch({ state: "review", error: null });
    return "review";
  }

  /** requests: ["tune"] or [{kind, intent, label, track?}]. Builds the requests, plans each; the state ends "review" or "failed". */
  async function review(requests = ["tune"]) {
    if (busy) return get().state; // an apply is running: the caller just reopens the sheet
    const sections = [];
    const fail = (message, located = null) => (patch({ state: "failed", sections: [], requests, error: { message, located }, confirm: null, seq: get().seq + 1 }), "failed");
    for (const r of requests) {
      const { name, spec, req } = build(r);
      if (req.error) return fail(req.error, req.located || null);
      if (req.intent === null || req.intent === undefined) continue;
      sections.push(makeSection(name, spec, req));
    }
    if (!sections.length) return fail("Nothing to apply: the pending edits equal what the CPU holds.");
    patch({ state: "planning", sections, requests, error: null, confirm: null, stale: null, startedAt: null, seq: get().seq + 1 });
    return planAll(sections);
  }

  /**
   * Review again (after any refusal, a stale or expired plan, or edits made after the plan). Sections already applied stay applied; the others are rebuilt from
   * what is on screen now and planned again. With nothing applied yet this is a fresh review of the same requests.
   */
  async function replan() {
    if (busy) return get().state;
    const a = get();
    if (!a.sections.some((s) => s.status === "done")) return review(a.requests.length ? a.requests : ["tune"]);
    const sections = [];
    for (const sec of a.sections) {
      if (sec.status === "done") {
        sections.push(sec);
        continue;
      }
      const r = sec.kind === "tune" && sec.draftRef !== undefined ? "tune" : sec.track ? { kind: sec.kind, label: sec.label, track: true } : { kind: sec.kind, intent: sec.intent, label: sec.label };
      const { name, spec, req } = build(r);
      if (req.error) return (patch({ state: "failed", error: { message: req.error, located: req.located || null } }), "failed");
      if (req.intent === null || req.intent === undefined) continue;
      sections.push(makeSection(name, spec, req));
    }
    patch({ state: "planning", sections, error: null, confirm: null, seq: get().seq + 1 });
    return planAll(sections);
  }

  const whatOf = (s) => (s.kind === "tune" ? "the V/F edits" : s.kind === "power" ? "the power limits" : s.kind === "runtime" ? "the caps or uncore" : s.label);

  /** F-05 / R-26: has what is on screen moved away from what this section planned? */
  function outdated(sec) {
    if (sec.status === "done") return false;
    if (sec.kind === "tune" && sec.draftRef !== undefined) return store.get().tune.draft !== sec.draftRef;
    if (sec.track) {
      const live = kinds[sec.kind].request(store);
      return !!live.error || JSON.stringify(live.intent ?? null) !== JSON.stringify(sec.intent ?? null);
    }
    return false;
  }
  const expired = (sec) => sec.plan && isNum(sec.plan.expires_s) && sec.issuedAt !== null && now() - sec.issuedAt > sec.plan.expires_s * 1000;
  const writesOff = () => {
    const st = store.get();
    if (readOnlyGate === "strict") return readOnly(st);
    return !!st.preflight && readOnly(st);
  };

  /** Why Apply is disabled: null = ready, else {key?, vars?, lead, text, replan}. `replan` = Review again is the way out. */
  function gateInfo() {
    const a = get();
    if (a.state !== "review") return { lead: "Unavailable", text: a.state === "applying" || a.state === "confirming" ? "Applying." : "Nothing is planned.", replan: false };
    if (a.sections.length && a.sections.every((s) => s.status === "done" || (s.plan && isEmptyPlan(s.plan)))) return { lead: "Nothing to apply", text: nothingText0(a.sections), replan: false, nothing: true }; // G-242 (QA-29)
    return whyNot();
  }
  /** The checks of gateInfo() that do not depend on the sheet's state (also run right after the native dialog). */
  function whyNot() {
    const a = get();
    const st = store.get();
    if (!connected()) return { key: "locked.no_link", vars: {}, ...fillWhy("locked.no_link"), replan: false };
    if (writesOff()) return { key: "locked.read_only", vars: { reason: st.mode.reason || "writes are off" }, ...fillWhy("locked.read_only", { reason: st.mode.reason || "writes are off" }), replan: false };
    const changed = a.sections.filter(outdated);
    if (changed.length) {
      const what = changed.map(whatOf).join(" and ");
      return { key: "locked.stale_plan", vars: { what }, ...fillWhy("locked.stale_plan", { what }), replan: true };
    }
    if (a.sections.some(expired)) return { lead: "Expired", text: HINTS["sheet.expired"].line, replan: true };
    return null;
  }
  const gate = () => {
    const g = gateInfo();
    return g ? g.text : "";
  };
  /**
   * R-I1 (R-26, F-05): the intent the editor holds NOW, in the shape of the plan op's request (tune: the `intent` of tune.plan; a kind with `planArgs`: those args), sent
   * with the apply so the helper can refuse a plan of other edits (PLAN_STALE / INTENT_CHANGED). A section built from the edits on screen takes them again; a fixed
   * request (a profile, a revert) is its own intent. The page's own check (outdated) runs first; this one closes the gap between that check and the write.
   */
  function applyIntent(sec) {
    const spec = kinds[sec.kind];
    let intent = sec.intent;
    if ((sec.kind === "tune" && sec.draftRef !== undefined) || sec.track) {
      const live = spec.request(store);
      if (!live.error && live.intent !== null && live.intent !== undefined) intent = live.intent;
    }
    if (intent === null || intent === undefined) return undefined;
    return spec.planArgs ? spec.planArgs(intent) : intent;
  }

  async function runSection(i) {
    const sec = get().sections[i];
    const spec = kinds[sec.kind];
    const early = [];
    let id = null;
    const onProgress = (p) => {
      if (!isObj(p)) return;
      if (id === null) return void early.push(p);
      if (p.op_id !== undefined && p.op_id !== id) return;
      setSection(i, { progress: { step: p.step ?? 0, of: p.of ?? 0, opsUsed: p.ops_used ?? null } });
    };
    bridge.on("progress", onProgress);
    try {
      // D-053 item 4: the plan id (+ the editor's intent, R-I1); the shell adds the confirmation code it kept, for a plan the operator approved in its dialog
      const intent = applyIntent(sec);
      const first = await bridge.call(spec.applyOp, intent === undefined ? { plan_id: sec.plan.plan_id } : { plan_id: sec.plan.plan_id, intent });
      let res;
      if (first.ok && first.pending) {
        id = first.id;
        setSection(i, { opId: id });
        for (const p of early) onProgress(p);
        res = await bridge.wait(id);
      } else res = first;
      return res;
    } finally {
      bridge.off("progress", onProgress);
    }
  }

  /** The native dialog for every section still to apply: true when the operator approved them; otherwise the sheet goes back to review (or stale). */
  async function confirmAll() {
    const pending = get().sections.filter((s) => s.status === "review" && !isEmptyPlan(s.plan)); // a section with no write is never in the dialog (QA-29)
    patch({ state: "confirming", confirm: null });
    let res;
    try {
      res = await bridge.call(CONFIRM_OP, { plans: pending.map((s) => ({ op: kinds[s.kind].applyOp, plan_id: s.plan.plan_id })) });
    } catch (e) {
      res = { ok: false, error: { code: "BRIDGE_ERROR", message: String((e && e.message) || e) } };
    }
    if (res.ok) return true;
    const err = res.error || { code: "BRIDGE_ERROR", message: "no answer" };
    if (err.code === "PLAN_STALE") {
      store.update((s) => ({ apply: { ...s.apply, state: "failed", confirm: null, sections: s.apply.sections.map((x) => (x.status === "review" ? { ...x, status: "stale", error: { ...err, located: null } } : x)) } }));
    } else patch({ state: "review", confirm: { code: err.code, message: err.message } });
    return false;
  }

  /** Apply the planned sections in order after the native confirmation; stop at the first failure. */
  async function apply() {
    if (gateInfo() || busy) return false;
    busy = true;
    let failedAt = -1;
    try {
      if (!(await confirmAll())) return false;
      // the edits may have moved while the dialog was open (the link too): check again, never write an outdated plan
      const g = whyNot();
      if (g) {
        patch({ state: "review", confirm: { code: "OUTDATED", message: g.text } });
        return false;
      }
      patch({ state: "applying", startedAt: now(), stale: null });
      const secs = get().sections;
      for (let i = 0; i < secs.length; i++) {
        if (get().sections[i].status === "done") continue;
        if (isEmptyPlan(get().sections[i].plan)) { // G-242 (QA-29): nothing to send for this part: it is not applied, not confirmed, and the helper is not asked
          setSection(i, { status: "done", result: null, summary: summarizeResult({ complete: true, readback: [], writes_sent: 0, nothing_to_do: true }) });
          continue;
        }
        // F-05: a later section is checked again right before its write (its edits may have moved while an earlier section was writing)
        if (outdated(get().sections[i])) {
          const what = whatOf(get().sections[i]);
          setSection(i, { status: "stale", error: { code: "OUTDATED", message: "You changed " + what + " while the apply ran: this part was not written. Review again.", detail: { writes_sent: 0 }, located: null } });
          failedAt = i;
          break;
        }
        setSection(i, { status: "applying", progress: null, error: null, cancelling: false, opId: null });
        const res = await runSection(i);
        const spec = kinds[secs[i].kind];
        if (res.ok) {
          const summary = summarizeResult(res.result);
          setUvp(store, summary.uvp);
          setSection(i, { status: "done", result: res.result, summary, opId: get().sections[i].opId });
          if (!(isObj(res.result) && res.result.nothing_to_do === true)) setLastApply(store); // G-248: a sitting that wrote (whatever the read-back said) changed what the CPU holds
          try {
            if (spec.afterApply) await spec.afterApply({ store, bridge, section: get().sections[i], summary, toast });
          } catch (e) {
            toast("warn", "The apply finished but refreshing the values failed: " + (e && e.message ? e.message : e));
          }
          if (!summary.allMatch) {
            failedAt = i; // a mismatch or a partial apply also stops the sequence: do not build on a state that did not read back
            break;
          }
        } else {
          const code = res.error && res.error.code;
          if (isUvp(res.error)) setUvp(store, "on");
          setSection(i, { status: code === "CANCELLED" ? "cancelled" : code === "PLAN_STALE" ? "stale" : "failed", error: { ...res.error, located: null } });
          if (!noWrites(get().sections[i])) setLastApply(store); // G-248: it may have written: the state the CPU holds is a new one
          failedAt = i;
          break;
        }
      }
    } finally {
      busy = false;
    }
    if (failedAt >= 0) {
      store.update((s) => ({ apply: { ...s.apply, state: "failed", sections: s.apply.sections.map((x, j) => (j > failedAt && x.status === "review" ? { ...x, status: "skipped" } : x)) } }));
      await afterFailure(failedAt);
    } else patch({ state: "done" });
    return failedAt < 0;
  }

  /** A section that may have written but did not end clean: say the tiles may be out of date and refresh what can be read without the mailbox. */
  async function afterFailure(i) {
    const sec = get().sections[i];
    const sent = writesSentOf(sec);
    const clean = sec.status === "done" && sec.summary && sec.summary.complete && !sec.summary.mismatches.length;
    if (sent === 0 || clean) return;
    patch({ stale: { kinds: [sec.kind] } });
    const spec = kinds[sec.kind];
    if (sec.status !== "done" && spec.afterFailure) {
      try {
        await spec.afterFailure({ store, bridge, section: sec, toast });
      } catch (e) {
        toast("warn", "Refreshing the values after the stop failed: " + (e && e.message ? e.message : e));
      }
    }
  }

  /** Cancel the running section: takes effect between transactions, so the request in flight still completes. */
  async function cancel() {
    const i = get().sections.findIndex((s) => s.status === "applying");
    if (i < 0 || !get().sections[i].opId) return false;
    setSection(i, { cancelling: true });
    const res = await bridge.call("cancel", { op_id: get().sections[i].opId });
    if (!res.ok) setSection(i, { cancelling: false });
    return res.ok;
  }

  function reset() {
    if (busy) return;
    store.set({ apply: initialApply() });
  }

  return { review, replan, apply, cancel, reset, gate, gateInfo, outdated, isBusy: () => busy, state: get };
}

/** R-I1: the hint that says why a plan went stale — the helper's PLAN_STALE names it in `detail.check` (INTENT_CHANGED: the edits moved; STATE_CHANGED: the CPU's values moved). */
export function staleHint(error) {
  const check = isObj(error) && isObj(error.detail) ? error.detail.check : null;
  return check === "INTENT_CHANGED" ? "sheet.intent_changed" : check === "STATE_CHANGED" ? "sheet.state_changed" : "sheet.stale";
}

/** G-248: the stored read a nothing-to-do plan (or its result) rests on: the newest `based_on_read_at` over the sections, or null. */
export function basedOnRead(secs) {
  let best = null;
  for (const s of secs) {
    for (const src of [s.result, s.plan]) {
      const t = isObj(src) && typeof src.based_on_read_at === "string" ? Date.parse(src.based_on_read_at) : NaN;
      if (!Number.isNaN(t) && (best === null || t > best)) best = t;
    }
  }
  return best === null ? null : new Date(best).toISOString();
}
/** G-248: "nothing to apply" is the helper's answer from its stored read, not a fresh read of the CPU: never a bare "already matches". */
export const nothingText0 = (secs) => {
  const at = basedOnRead(secs);
  return "The CPU held this state at the last read" + (at ? " (" + fmtClock(at) + ")" : "") + ". Read again to check it still does.";
};

/**
 * The outcome of a finished run, for the sheet's result box: {kind, title, text, writes} — kind "ok" | "nothing" | "declined" | "refused" | "uvp" | "mismatch" |
 * "partial" | "stale" | "cancelled". "nothing": no write was sent by any section (the sheet says "Nothing was written").
 */
export function outcomeOf(a) {
  const secs = a.sections;
  const sent = secs.map(writesSentOf);
  const known = sent.every((n) => n !== null);
  const total = sent.reduce((n, x) => n + (x || 0), 0);
  if (a.state === "done") {
    const s = secs.map((x) => x.summary).filter(Boolean);
    const rb = s.reduce((n, x) => n + x.total, 0);
    if (!rb && !total && s.length && s.every((x) => x.nothingToDo)) return { kind: "ok", title: "Nothing to apply", text: nothingText0(secs), writes: 0 };
    return { kind: "ok", title: "Applied", text: rb ? plural(rb, "write") + " read back equal." : "Applied.", writes: total };
  }
  const bad = secs.find((x) => ["failed", "cancelled", "stale"].includes(x.status) || (x.status === "done" && x.summary && !x.summary.allMatch));
  if (!bad) return null;
  if (bad.status === "done") {
    const s = bad.summary;
    if (!s.complete) {
      const uvp = s.stop && s.stop.check === UVP_CHECK;
      return { kind: uvp ? "uvp" : "partial", title: uvp ? "Undervolt Protection is on" : "Stopped part way", text: uvp ? s.stop.reason || "" : resultHeadline(s) + ".", writes: total };
    }
    return { kind: "mismatch", title: "Read-back mismatch", text: plural(s.mismatches.length, "write") + " of " + s.total + " read back different from the plan.", writes: total };
  }
  const e = bad.error || {};
  const nothing = known && total === 0;
  if (bad.status === "stale") return { kind: "stale", title: "Plan is stale", text: (nothing ? "Nothing was written. " : "") + HINTS[staleHint(e)].line, writes: total };
  if (isUvp(e)) return { kind: "uvp", title: "Undervolt Protection is on", text: e.message || "The CPU refused a negative voltage offset.", writes: total, nothing };
  if (bad.status === "cancelled") return { kind: nothing ? "nothing" : "cancelled", title: nothing ? "Nothing was written" : "Cancelled", text: nothing ? "Cancelled before the first write." : "Cancelled between writes. The table says which writes landed.", writes: total };
  if (nothing) return { kind: "nothing", title: "Nothing was written", text: e.message || e.code || "The helper refused before the first write.", writes: 0 };
  return { kind: "refused", title: "Not applied", text: e.message || e.code || "The helper refused.", writes: total };
}

/** One request for every UI caller that must confirm a kept plan (Profiles' accept step 2): `items` = [{op, plan_id}]. -> the shell's answer. */
export function confirmPlans(bridge, items) {
  return bridge.call(CONFIRM_OP, { plans: items.map((x) => ({ op: x.op, plan_id: x.plan_id })) });
}

// ---- DOM: landing a plan error on the offending field ---------------------------------------------------------------------------------------------
const ERR_CLASS = "plan-error";

/** Remove every mark this module put in `root`. */
export function clearFieldError(root) {
  for (const n of root.querySelectorAll(".field-error-note, .plan-error-banner")) n.remove();
  for (const n of root.querySelectorAll("." + ERR_CLASS)) n.classList.remove(ERR_CLASS);
  for (const n of root.querySelectorAll("[data-plan-invalid]")) {
    n.removeAttribute("aria-invalid");
    n.removeAttribute("data-plan-invalid");
  }
}

/** Mark the field a located error names; returns the element carrying the mark (or null when only the tile/banner could be marked). */
export function landFieldError(root, located) {
  clearFieldError(root);
  if (!located || !located.unit) return null;
  const note = (text) => h("p", { class: "field-error-note", role: "alert", text });
  const tile = root.querySelector(`.tile[data-unit="${located.unit}"]`) || root.querySelector(`[data-unit="${located.unit}"]`);
  if (tile) tile.classList.add(ERR_CLASS);
  let input = null;
  let host = null;
  if (located.field === "point" && located.ratio !== null) {
    const row = root.querySelector(`.insp-section tr[data-ratio="${located.ratio}"]`);
    input = row && row.querySelector("input");
    host = row && row.querySelector(".c-off");
  } else if (located.field === "ring" && located.point !== null) {
    const row = root.querySelector(`.insp-section tr[data-ring="1"][data-key="${located.point}"]`);
    input = row && row.querySelector("input");
    host = row && row.querySelector(".c-off");
  } else if (located.field === "curve") {
    const top = root.querySelector(".insp-section .curve-top");
    input = top && top.querySelector("input");
    host = top;
  } else if (located.field === "vt" || located.field === "ratio") {
    const rows = [...root.querySelectorAll(".oc-section .oc-row")];
    const want = located.field === "vt" ? "Target voltage" : "OC ratio";
    const row = rows.find((r) => (r.querySelector(".field-label") || {}).textContent === want);
    input = row && row.querySelector("input");
    host = row;
  }
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("data-plan-invalid", "1");
    input.classList.add(ERR_CLASS);
    if (host) host.append(note(located.message));
    return input;
  }
  const panel = root.querySelector("#tune-panel");
  if (panel && !host) {
    const banner = note(located.message);
    banner.classList.add("plan-error-banner");
    panel.prepend(banner);
    return banner;
  }
  return tile;
}

// ---- DOM: the commit sheet (its CSS: styles/apply.css, linked by index.html) --------------------------------------------------------------------------

/** Head tag of the sheet state: [text, tone] (tone = lx-tag modifier), or null when there is nothing to say (a plan that is ready). */
function stateTag(a, ctl) {
  if (a.state === "planning") return ["planning", ""];
  if (a.state === "confirming") return ["confirming", "set"];
  if (a.state === "applying") return ["writing", "set"];
  if (a.state === "done") return ["applied", "ok"];
  if (a.state === "review") {
    const g = ctl.gateInfo();
    if (g && g.nothing) return ["nothing to do", ""];
    return g ? (g.replan ? [g.lead === "Expired" ? "expired" : "stale", "warn"] : ["locked", ""]) : null; // G-252: a plan that is ready says nothing; only the other states get a tag
  }
  const o = outcomeOf(a);
  if (!o) return ["not planned", "fault"];
  return { nothing: ["nothing written", ""], stale: ["stale", "warn"], mismatch: ["mismatch", "fault"], partial: ["stopped", "fault"], uvp: ["refused", "fault"], refused: ["refused", "fault"], cancelled: ["cancelled", "warn"] }[o.kind] || ["not applied", "fault"];
}

const clock = (ms) => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

/**
 * Mount the commit sheet. ctx = {store, bridge, toast, drawer} (the app's ctx; `drawer` = components/sheet.js). Returns the controller plus {dispose}.
 * `kinds`/`doc` are injectable for tests.
 */
export function createApplyDrawer({ store, bridge, toast, drawer, kinds = KINDS, doc = document }) {
  const say = toast || (() => {});
  const ctl = createApplyController({ store, bridge, toast: say, kinds, readOnlyGate: "strict" });
  const disposers = [];
  let ticker = null;
  let built = null; // structural key of what is on screen
  let live = null; // refs updated in place while applying
  let landed = null;
  let observer = null;
  let wantOpen = false; // the sheet is open because of a Review the user has not dismissed
  let needFocus = false; // focus the safe button once, when the plan is on screen
  let pressedAt = null; // a footer button is held down since this time (render() waits for the release, QA-06)
  const press = () => (pressedAt = performance.now());
  const release = () => (pressedAt = null);
  drawer.footer.addEventListener("pointerdown", press);
  drawer.footer.addEventListener("mousedown", press);
  for (const ev of ["pointerup", "mouseup", "click", "pointercancel"]) doc.addEventListener(ev, release, true);
  disposers.push(() => {
    drawer.footer.removeEventListener("pointerdown", press);
    drawer.footer.removeEventListener("mousedown", press);
    for (const ev of ["pointerup", "mouseup", "click", "pointercancel"]) doc.removeEventListener(ev, release, true);
  });

  const screenRoot = () => doc.getElementById("screen") || doc.body;

  function land(located) {
    landed = located || null;
    if (!located || !located.unit) return;
    const unit = located.unit;
    if (unit.startsWith("turbo")) patchTune(store, { subtab: "turbo" });
    else patchTune(store, { subtab: "cores", selection: [unit], anchor: unit });
    if (store.get().screen !== "tune") setScreen(store, "tune");
    const el = landFieldError(screenRoot(), located);
    if (el && el.focus && el.tagName === "INPUT") el.focus({ preventScroll: false });
  }

  function watchLanded() {
    if (typeof MutationObserver === "undefined" || observer) return;
    let queued = false;
    observer = new MutationObserver(() => {
      if (!landed || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (landed && !screenRoot().querySelector(".field-error-note")) {
          observer.disconnect();
          landFieldError(screenRoot(), landed);
          observer.observe(screenRoot(), { childList: true, subtree: true });
        }
      });
    });
    observer.observe(screenRoot(), { childList: true, subtree: true });
  }

  function dropLanded() {
    if (!landed) return;
    landed = null;
    clearFieldError(screenRoot());
  }

  // ---- the parts of the body ----
  function summaryRow(a) {
    const planned = a.sections.filter((s) => s.plan);
    const writes = planned.reduce((n, s) => n + planWrites(s.plan), 0);
    const resid = planned.reduce((n, s) => n + planResidual(s.plan), 0);
    const nothing = planned.length > 0 && a.state === "review" && !!(ctl.gateInfo() || {}).nothing;
    // G-242 (QA-05): a finished run shows what was SENT (the plan's count leaves out the conditional per-core enable, which may or may not have been needed)
    const sent = a.sections.map(writesSentOf);
    const finished = (a.state === "done" || a.state === "failed") && a.sections.some((s) => s.status === "done") && sent.every((n) => n !== null);
    const count = nothing ? "Nothing to apply" : finished ? plural(sent.reduce((n, x) => n + x, 0), "write") + " sent" : writesText(writes, 0, resid); // G-252: the "+N if needed" is in the Effect line only
    const tg = stateTag(a, ctl);
    const exp = planned.filter((s) => isNum(s.plan.expires_s) && s.issuedAt !== null).map((s) => Date.now() + s.plan.expires_s * 1000 - (performance.now() - s.issuedAt));
    return h("div", { class: "lx-sheet-sec ap-sum", id: "apply-summary" },
      h("span", { class: "ap-sum-n" }, planned.length ? h("span", { class: "lx-mono", text: count }) : a.state === "planning" ? "Planning. Nothing is written." : "No plan"), // G-252: no "V/F & ratios" subtitle
      tg ? h("span", { class: ["lx-tag", tg[1] ? "lx-tag--" + tg[1] : ""], id: "apply-tag", dataset: { state: tg[0] }, text: tg[0] }) : null,
      exp.length && ["review", "confirming"].includes(a.state) ? h("span", { class: "ap-sum-exp" }, "expires ", h("span", { class: "lx-mono", text: clock(Math.min(...exp)) })) : null);
  }

  /** The result / refusal box at the top of the body (role=alert when it reports a problem). */
  function outcomeBox(a) {
    if (a.error && !a.sections.some((s) => s.plan)) {
      const box = h("div", { class: "lx-box lx-box--fault ap-box", id: "apply-plan-error", role: "alert", dataset: { outcome: "not-planned", unit: (a.error.located && a.error.located.unit) || "" } },
        h("span", { class: "lx-box-t", text: a.error.located && a.error.located.unit ? "Not planned: " + a.error.located.unit : "Not planned" }), h("span", { text: a.error.message }));
      if (a.error.located && a.error.located.unit) box.append(h("span", { class: "ap-box-more", text: " The field is marked in the editor: change it, then Review again." }));
      box.append(h("span", { class: "ap-box-more", text: " Nothing was written." }));
      return box;
    }
    const idle = a.state === "review" ? ctl.gateInfo() : null;
    if (idle && idle.nothing) { // G-242 (QA-29): no write is planned: say so; no Apply button, no dialog
      return h("div", { class: "lx-box ap-box", id: "apply-outcome", role: "status", dataset: { outcome: "nothing-to-apply" } }, h("span", { class: "lx-box-t", text: "Nothing to apply" }), h("span", { text: idle.text }));
    }
    if (a.state === "review" && a.confirm) {
      const c = a.confirm.code;
      const [tone, title, text] = c === "OUTDATED" ? ["warn", "Changed while the dialog was open", a.confirm.message + " Nothing was written."]
        : c === "NOT_CONFIRMED" ? ["", "Nothing was written", "You did not confirm in the system dialog. The plan is kept: Apply asks again."]
        : ["warn", "No confirmation", a.confirm.message];
      return h("div", { class: ["lx-box", tone ? "lx-box--" + tone : "", "ap-box"], id: "apply-outcome", role: "status", dataset: { outcome: c === "OUTDATED" ? "outdated" : "declined" } },
        h("span", { class: "lx-box-t", text: title }), h("span", { text }));
    }
    if (!["done", "failed"].includes(a.state)) return null;
    const o = outcomeOf(a);
    if (!o) return null;
    const tone = o.kind === "ok" ? "ok" : o.kind === "nothing" ? "" : o.kind === "stale" || o.kind === "cancelled" ? "warn" : "fault";
    const box = h("div", { class: ["lx-box", tone ? "lx-box--" + tone : "", "ap-box"], id: "apply-outcome", role: o.kind === "ok" ? "status" : "alert", dataset: { outcome: o.kind } },
      h("span", { class: "lx-box-t", text: o.title }), h("span", { text: o.text }));
    if (o.kind === "nothing" || o.nothing) box.append(h("span", { class: "ap-box-more", text: o.kind === "nothing" ? " The CPU holds what it held before." : " Nothing was written." }));
    const bad = a.sections.find((x) => x.status === "done" && x.summary && !x.summary.complete);
    if (bad && o.kind === "partial") {
      const wd = partialWording(!!(kinds[bad.kind] && kinds[bad.kind].view), bad.summary.stop && bad.summary.stop.tripped === true);
      box.append(h("span", { class: "ap-box-more", text: " " + wd.title + " " + wd.text }));
    }
    if (a.stale) box.append(h("span", { class: "ap-box-more", id: "apply-stale-model", text: " " + HINTS["sheet.mix"].line }));
    return box;
  }

  function statusFor(sec, a) {
    const custom = kinds[sec.kind] && kinds[sec.kind].view ? kinds[sec.kind].view(sec.plan, store.get()) : null;
    const outcome = sec.status === "done" ? { ok: true, readback: sec.summary ? sec.summary.readback : [], complete: sec.summary ? sec.summary.complete : true }
      : noWrites(sec) || (writesSentOf(sec) === 0 && ["failed", "cancelled", "stale"].includes(sec.status)) ? { ok: false, noWrites: true }
      : ["failed", "cancelled", "stale"].includes(sec.status) ? { ok: false, started: !!sec.opId } : sec.status === "skipped" ? { ok: false, noWrites: true } : null;
    if (custom) return keyedStatuses(custom.rows, sec.plan, sec.progress, outcome, sec.summary);
    return unitStatuses(sec.plan, sec.progress, outcome);
  }

  // G-242 (QA-12): the rows of a plan are worked out once, while it is under review, and kept. After the apply the model already holds the new values (the turbo ratios the intent
  // asked for, the applied offsets), so working them out again gives "no change" and the row of what was just applied would disappear.
  const rowCache = new Map();
  function diffRowsOf(sec) {
    const spec = kinds[sec.kind] || {};
    const id = sec.plan && sec.plan.plan_id;
    if (id && rowCache.has(id)) return rowCache.get(id);
    const rows = spec.view ? spec.view(sec.plan, store.get()).rows || [] : spec.rows ? spec.rows(sec, store) : tuneDiffRows(sec.plan, sec.intent, store.get().tune && store.get().tune.model);
    if (id && (rows.length || sec.status === "review")) {
      if (rowCache.size > 8) rowCache.delete(rowCache.keys().next().value);
      rowCache.set(id, rows);
    }
    return rows;
  }

  /** The diff table: # · Unit · What · Before · After · Δ · Status, every section, rows of a unit together. */
  function diffTable(a) {
    const tbody = h("tbody");
    const cells = [];
    let n = 0;
    const multi = a.sections.filter((s) => s.plan).length > 1;
    a.sections.forEach((sec, i) => {
      if (!sec.plan) return;
      const rows = diffRowsOf(sec);
      if (multi) tbody.append(h("tr", { class: "lx-grp" }, h("th", { colspan: "7", scope: "colgroup" }, sec.label, h("span", { class: "lx-grp-n", text: plural(planWrites(sec.plan), "write") }))));
      if (!rows.length) tbody.append(h("tr", { dataset: { section: i } }, h("td", { class: "lx-n lx-dim", text: "" }), h("td", { colspan: "6", class: "lx-dim", text: planWrites(sec.plan) ? "The CPU already holds the values this plan writes (" + plural(planWrites(sec.plan), "word") + ")." : "Nothing changes." })));
      let prev = null;
      for (const r of rows) {
        n += 1;
        const st = h("td", { class: "ap-st" });
        cells.push({ cell: st, section: i, sunit: r.sunit || r.unit });
        tbody.append(h("tr", { dataset: { section: i, unit: r.sunit || r.unit } },
          h("td", { class: "lx-n lx-dim", text: n }), h("td", { class: "lx-k", text: r.unit === prev ? "" : r.unit }), h("td", { class: "ap-what", text: r.what }),
          h("td", { class: "lx-n", text: r.before }), h("td", { class: "lx-n", dataset: { v: "set" }, text: r.after }), h("td", { class: "lx-n ap-delta", text: r.delta || "" }), st));
        prev = r.unit;
      }
    });
    const table = h("table", { class: "lx-tbl lx-tbl--fill ap-diff", "aria-label": "What changes: before and after" },
      h("thead", {}, h("tr", {}, h("th", { class: "lx-n", scope: "col", text: "#" }), h("th", { scope: "col", text: "Unit" }), h("th", { scope: "col", text: "What" }),
        h("th", { class: "lx-n", scope: "col", text: "Before" }), h("th", { class: "lx-n", scope: "col", text: "After" }), h("th", { class: "lx-n", scope: "col", text: "Δ" }), h("th", { scope: "col", text: "Status" }))), tbody);
    const paint = () => {
      const st = store.get().apply;
      const by = st.sections.map((sec) => (sec.plan ? statusFor(sec, st) : {}));
      for (const c of cells) {
        const s = (by[c.section] || {})[c.sunit] || "queued";
        c.cell.textContent = STATUS_TEXT[s] || s;
        c.cell.dataset.st = s;
      }
    };
    paint();
    return { node: h("div", { class: "lx-sheet-sec ap-diff-sec" }, table), paint };
  }

  /** The read-back rows that differ (fault): Before/After/Read-back by word. */
  function mismatchTable(a) {
    const rows = a.sections.flatMap((s) => (s.summary ? s.summary.mismatches : []));
    if (!rows.length) return null;
    const t = h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact ap-rb", "aria-label": "Read-back mismatches" },
      h("thead", {}, h("tr", {}, ["Unit", "Word", "CPU", "Planned", "Read back"].map((x, i) => h("th", { scope: "col", class: i >= 2 ? "lx-n" : "", text: x })))));
    t.append(h("tbody", {}, rows.map((x) => {
      const c = readbackCells(x);
      return h("tr", { dataset: { match: "false" } }, h("td", { class: "lx-k", text: c.unit }), h("td", { text: c.point }), h("td", { class: "lx-n", text: c.cpu }), h("td", { class: "lx-n", text: c.expected }), h("td", { class: "lx-n ap-bad", text: c.actual }));
    })));
    return h("div", { class: "lx-sheet-sec" }, h("span", { class: "lx-band-t", text: "Read back different" }), t);
  }

  function effectSec(a) {
    const kv = h("dl", { class: "lx-kv ap-kv" });
    const add = (k, ...v) => kv.append(h("dt", { text: k }), h("dd", {}, ...v));
    for (const sec of a.sections) {
      const vc = sec.plan && isObj(sec.plan.vccia) && isNum(sec.plan.vccia.predicted_v) ? sec.plan.vccia : null;
      if (!vc) continue;
      const by = isObj(vc.set_by) && vc.set_by.unit ? "set by " + vc.set_by.unit + (isNum(vc.set_by.ratio) ? " at " + vc.set_by.ratio + TIMES : "") : "";
      add("Vcore, all cores busy", h("span", { class: "lx-mono", dataset: { v: "set" }, text: vc.predicted_v.toFixed(2) + " V" }),
        isNum(vc.before_v) ? h("span", { class: "lx-dim" }, " now ", h("span", { class: "lx-mono", text: vc.before_v.toFixed(2) + " V" })) : null,
        h("span", { class: "lx-dim", text: (by ? " · " + by : "") + " · a prediction" }));
    }
    const parts = a.sections.filter((s) => s.plan).map((s) => {
      const k = kinds[s.kind] || {};
      const view = k.view ? k.view(s.plan, store.get()) : null;
      return writeItems(s, view) || { items: [], certain: planWrites(s.plan), setup: planConditional(s.plan) };
    });
    if (parts.length && a.sections.some((s) => s.plan && !isEmptyPlan(s.plan))) add("Writes", writesLine(parts));
    if (a.sections.some((s) => s.plan && s.plan.words_assumed === true)) add("Assumed", h("span", { class: "ap-warn-t", text: "Some words were not read in this session: the plan assumed their values. Read first for a plan based on what the CPU holds." }));
    const undo = [...new Set(a.sections.filter((s) => s.plan).map((s) => (kinds[s.kind] && kinds[s.kind].undo) || ""))].filter(Boolean);
    if (undo.length) add("How to undo", undo.join(" "));
    return kv.children.length ? h("div", { class: "lx-sheet-sec" }, h("span", { class: "lx-band-t", text: "Effect" }), kv) : null;
  }

  function notesSec(a, finished) {
    const warnings = [];
    const notes = [];
    const tech = [];
    for (const s of a.sections) {
      if (!s.plan) continue;
      const n = planNotes(s.plan);
      for (const w of n.warnings) if (!warnings.some((x) => x.text === w.text)) warnings.push(w);
      for (const t of n.notes) if (!notes.includes(t)) notes.push(t);
      for (const t of n.tech) if (!tech.some((x) => x.detail === t.detail)) tech.push(t);
    }
    const out = [];
    if (warnings.length) {
      out.push(h("div", { class: "lx-sheet-sec ap-warns", id: "apply-warnings" },
        h("ul", { class: "ap-warn-list", "aria-label": "Plan warnings" }, warnings.map((w) => h("li", { dataset: { code: w.code } }, h("b", { text: w.lead }), " ", w.text)))));
    }
    if (notes.length) out.push(h("div", { class: "lx-sheet-sec" }, h("details", { class: "lx-notes", id: "apply-notes", open: false }, h("summary", { text: plural(notes.length, "plan note") }), h("ul", {}, notes.map((t) => h("li", { text: t }))))));
    // G-242 (QA-31): what the helper said in its own words (encodings, evidence tags) — for whoever wants it, never in the prose above
    if (tech.length) out.push(h("div", { class: "lx-sheet-sec" }, h("details", { class: "lx-notes", id: "apply-tech", open: false }, h("summary", { text: "Technical" }), h("ul", { class: "ap-tech" }, tech.map((t) => h("li", { class: "lx-dim", text: t.detail }))))));
    const steps = a.sections.filter((s) => s.plan).flatMap((s) => {
      const custom = kinds[s.kind] && kinds[s.kind].view ? kinds[s.kind].view(s.plan, store.get()) : null;
      return custom ? custom.steps.map((label) => ({ label, conditional: false })) : stepRows(s.plan);
    });
    if (steps.length) {
      out.push(h("div", { class: "lx-sheet-sec" }, h("details", { class: "lx-notes", id: "apply-order", open: false },
        h("summary", { text: "Write order (" + plural(steps.length, "step") + ")" }),
        h("ol", { class: "ap-steps" }, steps.map((s) => h("li", { class: s.conditional ? "lx-dim" : "", text: s.label }))),
        a.sections.some((s) => s.plan && s.plan.steps_truncated === true) ? h("p", { class: "lx-dim", text: "The step list is shortened to fit one message." }) : null)));
    }
    if (finished) for (const s of a.sections) if (s.summary && s.summary.ringRefused.length) out.push(h("div", { class: "lx-sheet-sec" }, h("div", { class: "lx-box lx-box--warn" }, h("span", { class: "lx-box-t", text: "Ring not written" }), h("span", { text: s.summary.ringRefused.map(plainWords).join(" ") }))));
    return out;
  }

  function footer(a) {
    const nodes = [];
    const g = a.state === "review" ? ctl.gateInfo() : null;
    const finished = a.state === "done" || a.state === "failed";
    const close = button({ level: 0, label: finished || (g && g.nothing) ? "Close" : "Close, keep plan", id: "apply-close", hint: "sheet.close", onClick: () => closeDrawer(store) });
    close.setAttribute("data-initial-focus", "");
    nodes.push(close);
    const status = h("span", { class: "lx-sheet-status", id: "apply-why", role: "status" });
    nodes.push(status);
    const writes = a.sections.reduce((n, s) => n + (s.plan && s.status !== "done" ? planWrites(s.plan) : 0), 0);
    const resid = a.sections.reduce((n, s) => n + (s.plan && s.status !== "done" ? planResidual(s.plan) : 0), 0);
    const extras = resid ? residualText(resid) : ""; // G-252: the "+N if needed" is in the Effect line only
    const go = button({ level: 4, label: "Apply " + plural(writes, "write"), cost: extras || null, id: "apply-go", hint: "state.apply", onClick: () => void ctl.apply() });
    if (a.state === "planning") {
      status.textContent = "Planning. Nothing is written.";
      return nodes;
    }
    if (a.state === "confirming") {
      status.textContent = "Answer the system dialog. Nothing is written yet.";
      setBusy(go, "Waiting for confirmation", 0);
      go.disabled = true;
      nodes.push(go);
      return nodes;
    }
    if (a.state === "applying") {
      const cancelling = a.sections.some((s) => s.cancelling);
      nodes.splice(0, 1, button({ level: 0, label: cancelling ? "Cancelling…" : "Stop after this write", id: "apply-cancel", hint: "sheet.cancel", disabled: cancelling, onClick: () => void ctl.cancel() }));
      setBusy(go, "Writing", 0);
      go.disabled = true;
      nodes.push(go);
      return nodes;
    }
    if (a.state === "review" && g && g.nothing) { // G-242 (QA-29): nothing is planned: no Apply button
      status.textContent = g.text;
      return nodes;
    }
    if (a.state === "review") {
      if (g) {
        status.append(whyLine(g.key || null, g.vars || {}, { inline: true }));
        if (!g.key) status.append(h("b", { text: g.lead }), " " + g.text);
        if (g.key === "locked.read_only") status.textContent = ""; // the sheet shell puts the read-only reason beside Apply itself
        if (g.replan) nodes.push(button({ level: 2, label: "Review again", id: "apply-replan", hint: "sheet.replan", onClick: () => void ctl.replan() }));
        go.disabled = true;
        go.setAttribute("aria-describedby", status.id);
      } else status.textContent = a.confirm ? HINTS["sheet.ready_again"].line : "Ready. A system dialog asks you to confirm.";
      nodes.push(go);
      return nodes;
    }
    // done / failed
    const o = outcomeOf(a);
    status.textContent = o ? o.title + (o.kind === "ok" ? " · " + o.text : "") : "";
    if (a.state === "done") {
      nodes.push(button({ level: 2, label: "Set as accepted…", id: "apply-accept", hint: "sheet.accept", onClick: () => openAccept() }));
      nodes.push(button({ level: 2, label: "Screen with stress", id: "apply-stress", hint: "sheet.stress", onClick: () => openStress() }));
      return nodes;
    }
    if (a.stale && a.stale.kinds.includes("tune")) {
      const ops = store.get().tune && store.get().tune.read ? store.get().tune.read.ops : null;
      nodes.push(button({ level: 1, label: "Read", cost: isNum(ops) ? ops + " req" : null, id: "apply-read", hint: "sheet.read", onClick: () => readNow() }));
    }
    if (a.requests.length || a.sections.length) nodes.push(button({ level: 2, label: "Review again", id: "apply-replan", hint: "sheet.replan", onClick: () => void ctl.replan() }));
    return nodes;
  }

  function openAccept() {
    closeDrawer(store);
    setScreen(store, "profiles");
    // views/profiles.js owns the accept step (two-step with the shell's confirmation); it may listen for this to open it at once
    store.events.dispatchEvent(new CustomEvent("profiles:accept", { detail: { from: "read" } }));
  }
  function openStress() {
    closeDrawer(store);
    setScreen(store, "stress");
  }
  function readNow() {
    // the top bar's Read: it asks before it drops edits, and it is the one place a mailbox read starts
    const btn = doc.getElementById("read-btn");
    if (btn && !btn.disabled) btn.click();
  }

  function structKey(a) {
    return [a.state, a.seq, a.error && a.error.message, a.confirm && a.confirm.code, a.stale ? 1 : 0, a.sections.map((s) => [s.status, s.plan && s.plan.plan_id, s.cancelling, s.error && s.error.code, s.summary ? 1 : 0].join(":")).join("|")].join("#");
  }

  function titleOf(a) {
    if (a.state === "applying") return "Review · writing";
    if (a.state === "done") return "Review · applied";
    if (a.state === "confirming") return "Review · confirm";
    return "Review";
  }

  function render() {
    const a = store.get().apply;
    if (a.state === "idle") return;
    const key = structKey(a);
    if (key !== built && pressedAt !== null && performance.now() - pressedAt < 1000) {
      // G-242 (QA-06): a footer button is held down: rebuilding the footer now would drop the mouseup on a node that is gone and the click with it. Wait for the release.
      setTimeout(render, 60);
      return;
    }
    if (key !== built) {
      built = key;
      const nodes = [summaryRow(a)];
      const box = outcomeBox(a);
      if (box) nodes.push(h("div", { class: "lx-sheet-sec ap-out" }, box));
      const finished = a.state === "done" || a.state === "failed";
      live = null;
      if (a.sections.some((s) => s.plan)) {
        const diff = diffTable(a);
        live = { paint: diff.paint };
        if (a.state === "applying") nodes.push(progressRule());
        nodes.push(diff.node);
        const mm = mismatchTable(a);
        if (mm) nodes.push(mm);
        const eff = effectSec(a);
        if (eff) nodes.push(eff);
        nodes.push(...notesSec(a, finished));
      }
      const had = doc.activeElement && drawer.footer.contains(doc.activeElement) ? doc.activeElement.id : "";
      drawer.setContent(nodes, footer(a));
      if (had && !drawer.focus("#" + had)) drawer.focus("#apply-close"); // a re-render must not drop the focus of the button the user is on
      // opened by the user's Review only: a sheet the user closed (Esc, Close) stays closed while the apply goes on; the end of the run is a toast then
      if (wantOpen) openDrawer(store, titleOf(a));
      else store.update((st) => ({ drawer: { ...st.drawer, title: titleOf(a) } }));
      if (wantOpen && needFocus && a.state !== "planning") {
        needFocus = false;
        drawer.focus("#apply-close"); // Enter must never be one keystroke from a write
      }
    }
    refreshProgress();
  }

  function progressRule() {
    const rule = h("div", { class: "lx-progress lx-progress--write ap-rule", id: "apply-progress", role: "progressbar", "aria-label": "Writes sent", "aria-valuemin": "0", "aria-valuemax": "1" });
    return rule;
  }

  function refreshProgress() {
    const a = store.get().apply;
    if (live && live.paint) live.paint();
    if (a.state !== "applying") return;
    const i = a.sections.findIndex((s) => s.status === "applying");
    const sec = a.sections[i];
    const elapsed = a.startedAt !== null ? performance.now() - a.startedAt : 0;
    const p = sec ? sec.progress : null;
    const before = a.sections.slice(0, Math.max(0, i)).reduce((n, s) => n + (s.plan ? planWrites(s.plan) : 0), 0);
    const all = a.sections.reduce((n, s) => n + (s.plan ? planWrites(s.plan) : 0), 0);
    const mine = sec && sec.plan ? planWrites(sec.plan) : 0;
    const frac = p && p.of ? Math.min(1, p.step / p.of) : 0;
    const done = before + Math.floor(frac * mine);
    const rule = drawer.body.querySelector("#apply-progress");
    if (rule) {
      setVar(rule, "--p", all ? (before + frac * mine) / all : 0);
      rule.setAttribute("aria-valuenow", String(all ? (before + frac * mine) / all : 0));
    }
    const go = drawer.footer.querySelector("#apply-go");
    if (go) setBusy(go, "Writing " + Math.min(all, done + (sec ? 1 : 0)) + " of " + all, all ? (before + frac * mine) / all : 0);
    const status = drawer.footer.querySelector("#apply-why");
    if (status) status.textContent = (sec ? sec.label + ": " : "") + progressText(p, elapsed);
  }

  // the Apply gate also depends on the edits (outdated plan), the link, the mode and the clock
  let lastGate = "";
  function refreshGate() {
    const a = store.get().apply;
    if (a.state !== "review") return;
    const g = ctl.gateInfo();
    const now = g ? (g.key || g.lead) + "|" + g.text : "";
    if (now === lastGate) return;
    lastGate = now;
    built = null;
    render();
  }

  // ---- events ----
  const onReview = (e) => {
    // G-213: "tune:review" may carry detail.requests (e.g. [{kind: "tune", intent: {profile: "<name>"}, label}]): the Profiles screen opens the same sheet for a whole-state
    // intent. Such a plan error is not a field of the Tune editor, so it is never landed on one.
    const requests = e && e.detail && Array.isArray(e.detail.requests) && e.detail.requests.length ? e.detail.requests : null;
    wantOpen = true;
    needFocus = true;
    queueMicrotask(async () => {
      dropLanded();
      const a = store.get().apply;
      if (ctl.isBusy() || a.state === "applying" || a.state === "confirming") {
        built = null;
        render();
        return;
      }
      patch0({ state: "planning", sections: [], error: null, confirm: null, stale: null });
      built = null;
      lastGate = "";
      render();
      const state = await ctl.review(requests || ["tune"]); // every state change renders through the store watch
      const err = store.get().apply.error;
      const fromEditor = !requests || requests.every((r) => typeof r === "string" || r.track === true);
      if (state === "failed" && err && err.located && fromEditor) land(err.located);
    });
  };
  const patch0 = (p) => store.update((s) => ({ apply: { ...s.apply, ...p } }));
  let drawerWasOpen = store.get().drawer.open;
  disposers.push(store.subscribe((st) => {
    if (drawerWasOpen && !st.drawer.open) wantOpen = false;
    drawerWasOpen = st.drawer.open;
  }));
  store.events.addEventListener("tune:review", onReview);
  disposers.push(() => store.events.removeEventListener("tune:review", onReview));
  disposers.push(store.watch((s) => s.apply, render));
  disposers.push(store.watch((s) => s.tune.draft, () => {
    if (landed) dropLanded(); // an edit answers the error
    refreshGate();
  }));
  disposers.push(store.watch((s) => s.rt && s.rt.edits, refreshGate));
  disposers.push(store.watch((s) => s.link.state, refreshGate));
  disposers.push(store.watch((s) => s.mode, refreshGate));
  // a new read answers "the tiles may not show what the CPU holds"
  disposers.push(store.watch((s) => s.tune.read && s.tune.read.at, () => {
    const a = store.get().apply;
    if (a.stale) store.update((s) => ({ apply: { ...s.apply, stale: null } }));
  }));
  ticker = setInterval(() => {
    const a = store.get().apply;
    if (a.state === "applying") refreshProgress();
    else if (a.state === "review") refreshGate();
  }, 500);
  watchLanded();

  // a finished apply with the sheet closed: say so (the window may not even be focused)
  let lastState = "idle";
  disposers.push(store.watch((s) => s.apply.state, (st) => {
    const prev = lastState;
    lastState = st;
    if (prev !== "applying" || store.get().drawer.open) return;
    const o = outcomeOf(store.get().apply);
    say(st === "done" ? "ok" : "warn", o ? o.title + ": " + o.text : st === "done" ? "Applied." : "Apply stopped: see the Review sheet.");
  }));

  return {
    controller: ctl,
    dispose() {
      for (const d of disposers.splice(0)) d();
      if (ticker) clearInterval(ticker);
      if (observer) observer.disconnect();
    },
  };
}
