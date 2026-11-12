// views/audit.js: Audit screen (PLAN §4.4, desktop/DESIGN.md §9.11, assessment 03 U-38): the helper's audit log tail (audit.tail), GROUPED BY OPERATION with a
// plain-language line each, newest first; an operation opens to its raw rows, a raw row opens to the record as the helper wrote it. Read-only; no mailbox traffic.
// The audit records carry no operation id (guard/audit.py), so an operation is a run of consecutive records with the same purpose prefix ("ring read", "apply"; a
// read-back counts with what it reads back) or the same `op` summary (profiles.save ...), the same operator, and no gap over OP_GAP_S (groupAudit, unit-tested).
// QA-32: the log is read in pages (audit.tail {n, before}: `before` = the previous answer's `start`, a byte offset), operations are grouped from everything loaded and
// the screen keeps loading older pages while the filter or the search has too few matches, so "Changes" and the search cover the whole log; "Load older" continues by hand.
// QA-33: an operation's begin / result summary records are one row (a measure run was two "Curve measured" rows); an apply run is named by the closing `result` record
// the helper writes for it (op, outcome, writes ...), e.g. "Restore accepted", and shows its real outcome.
// Port of web/app.js "audit tail" (MB_NAMES/MSR_NAMES/auditRequest/auditTime/auditKeep/loadAudit :5218-5266). Request names follow docs/knowledge/registers.md
// "Mailbox commands" and the plain MSRs the guard allows; anything else shows as hex. Differences: a free-text filter next to the web page's two-way
// filter, a visible verdict for read-back records (verified / MISMATCH), and the row model is pure so it is unit-tested (auditRows).
import { h, clear } from "../components/dom.js";
import { NA, fmtClock, plural } from "../components/fmt.js";
import { button, setBusy, setButton } from "../components/buttons.js";
import { panel, box, emptyState } from "../components/panel.js";
import { createSegmented } from "../components/segmented.js";
import { HINTS } from "../lib/hints.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export const AUDIT_N = 200;
/** QA-32: keep reading older pages until this many operations match (the default view fills the screen; a filter or search looks for its matches in the whole log). */
export const WANT_OPS = 12;
/** Pages read in one go (a page is up to AUDIT_N records) before the screen stops and offers "Load older". */
export const PAGES_PER_GO = 10;
export const PAGES_PER_GO_FILTERED = 60;

/** Mailbox command names (registers.md "Mailbox commands"). */
export const MB_NAMES = {
  0x01: "OC capability read",
  0x02: "per-core capability read",
  0x09: "fused top point read",
  0x10: "V/F word read",
  0x11: "V/F word write",
  0x14: "misc config read",
  0x15: "misc config write",
  0x1c: "favored ratio read",
  0x1d: "favored ratio write",
  0x26: "granular ratio read",
  0x27: "granular ratio write",
  0x28: "max voltage read",
};
/** Plain MSRs the guard allows reading (registers.md). */
export const MSR_NAMES = { 0xce: "platform info", 0x198: "perf status", 0x1ad: "P turbo ratios", 0x1ae: "P turbo core counts", 0x650: "E turbo ratios", 0x651: "E turbo core counts" };
/** Mailbox commands that change the CPU. */
export const WRITE_CMDS = [0x11, 0x15, 0x1d, 0x27];
const READ_VF_CMD = 0x10;

export const hex = (v) => (isNum(v) ? "0x" + v.toString(16) : v === undefined || v === null ? "" : String(v));

function toNum(v) {
  if (isNum(v)) return v;
  return typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : null;
}

/** "0x11 V/F word write (0x00, 0x05)" / "MSR 0x198 perf status" / "" for a record with neither. */
export function auditRequest(o) {
  const cmd = toNum(o.cmd);
  const msr = toNum(o.msr);
  if (cmd !== null) {
    const p = [o.p1, o.p2];
    const hasP = toNum(o.p1) !== null || toNum(o.p2) !== null;
    return hex(cmd) + (MB_NAMES[cmd] ? " " + MB_NAMES[cmd] : "") + (hasP ? " (" + p.map((x) => (toNum(x) !== null ? hex(toNum(x)) : "-")).join(", ") + ")" : "");
  }
  if (msr !== null) return "MSR " + hex(msr) + (MSR_NAMES[msr] ? " " + MSR_NAMES[msr] : "") + (o.msr_kind === "write" ? " write" : "");
  return "";
}

/** Local "Oct 18, 08:58:27" from an ISO timestamp; the raw value when it does not parse. */
export function auditTime(ts) {
  const d = typeof ts === "string" ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : String(ts === undefined || ts === null ? "" : ts);
}

/** "writes" keeps what changed or could have changed the CPU: write attempts and their results, read-backs, refusals, errors and trips; G-235: also the runtime / cpufreq / powercap
 *  attempts and the op-level `result` summaries (a measure or stress run, a recovered journal, a saved profile). */
/** A read-back record's verdict: the guard's say `verified`, a powercap / runtime file read-back says `matches` (G-249 R2-03: "0 of 1 read back equal" for a write that matched). true | false | null. */
export const readbackVerdict = (o) => (o.verified === true || o.matches === true ? true : o.verified === false || o.matches === false ? false : null);

export function auditKeep(o, filter) {
  if (filter === "all") return true;
  if (["refused", "error", "trip", "readback", "runtime_attempt", "powercap_attempt"].includes(o.event)) return true;
  if (o.event === "result" && typeof o.op === "string" && o.cmd === undefined && o.msr === undefined) return true; // G-235: the summary record of an op that changed cpufreq or a file (vf.measure, stress.start, profiles.save, journal.recover ...)
  const cmd = toNum(o.cmd);
  return o.msr_kind === "write" || (cmd !== null && WRITE_CMDS.includes(cmd));
}

/**
 * QA-11 (G-248): the guard reads a plain-MSR write back on two CPUs (the one it wrote on and a second one) and logs each as a `readback` record with `readback_cpu`. Oldest-first
 * records -> [{rec, also?}] where `also` is the second read-back of the same write (same msr and expected value, another CPU, the very next record): one row, not two.
 */
export function pairReadbacks(records) {
  const out = [];
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const pair = isObj(a) && isObj(b) && a.event === "readback" && b.event === "readback" && isNum(a.readback_cpu) && isNum(b.readback_cpu) && a.readback_cpu !== b.readback_cpu
      && a.msr !== undefined && a.msr === b.msr && a.expected === b.expected && a.operator === b.operator;
    out.push(pair ? { rec: a, also: b } : { rec: a });
    if (pair) i++;
  }
  return out;
}

/** One display row from a record (or from a line the helper could not parse). `also`: the second read-back of a pair (pairReadbacks). */
export function auditRow(r, also) {
  const o = isObj(r) ? r : { unparsable: String(r) };
  const rc = o.rc_name !== undefined ? o.rc_name : o.rc !== undefined ? o.rc : "";
  const rcOk = rc === 0 || rc === "Pass" || rc === "OK";
  let kind = rc === "" ? "" : rcOk ? "ok" : "warn";
  let result = String(rc === "" && o.value !== undefined ? o.value : rc);
  // G-230: a V/F read (0x10) that walks past the last point answers rc 0x11: the expected end of the table, not an error (a write or anything else with 0x11 stays amber)
  if ((rc === 17 || rc === "UNKNOWN_0x11") && toNum(o.cmd) === READ_VF_CMD) {
    result = "end of table (0x11)";
    kind = "";
  }
  let verdict = "";
  if (o.event === "readback") {
    const v = readbackVerdict(o);
    verdict = v === true ? "verified" : v === false ? "MISMATCH" : o.pending === true ? "pending (re-read " + (isNum(o.poll) ? o.poll + 1 : "?") + ")" : "";
    if (v === false) kind = "error";
  }
  const event = o.event !== undefined ? String(o.event) : o.unparsable !== undefined ? "unparsable" : "";
  // G-235: `detail` first (the summary records carry "vf.measure: 48 files, restored ok"); a run summary without one is composed from its counts
  const summary = event === "result" && typeof o.op === "string" && isNum(o.file_count) ? `${o.op}: ${o.file_count} files, ${o.restored === false ? "NOT restored" : "restored ok"}` : "";
  let detail = o.detail !== undefined && o.detail !== null ? String(o.detail) : summary || (o.reason !== undefined ? String(o.reason) : o.purpose !== undefined ? String(o.purpose) : o.unparsable !== undefined ? o.unparsable : "");
  if (rc === "" && o.value === undefined && typeof o.outcome === "string") {
    result = o.outcome;
    kind = o.restored === false || o.outcome === "error" ? "error" : o.outcome === "cancelled" || o.outcome === "cancel" ? "warn" : "ok";
  }
  if (isObj(also)) { // QA-11: both read-backs of one write are one row
    detail = `read back on CPU ${o.readback_cpu} and ${also.readback_cpu}`;
    verdict = o.verified === true && also.verified === true ? "verified" : o.verified === false || also.verified === false ? "MISMATCH" : verdict;
    if (verdict === "MISMATCH") kind = "error";
  }
  const eventKind = ["refused", "error", "trip"].includes(event) || (event === "result" && o.restored === false) ? "error" : event === "readback" ? (readbackVerdict(o) === false ? "error" : "ok") : "";
  return {
    time: auditTime(o.ts),
    timeTitle: String(o.ts ?? ""),
    seq: o.seq === undefined ? "" : String(o.seq),
    event,
    eventKind: eventKind === "ok" && isObj(also) && also.verified === false ? "error" : eventKind,
    cpu: o.cpu === undefined || o.cpu === null ? "" : String(o.cpu),
    request: auditRequest(o) || (typeof o.op === "string" ? o.op : ""),
    result,
    resultKind: kind,
    verdict,
    detail,
  };
}

/** Rows newest first, after the filter ("all" | "writes") and the free-text query (case-insensitive over every shown column). */
export function auditRows(records, { filter = "all", text = "" } = {}) {
  const q = String(text).trim().toLowerCase();
  const kept = pairReadbacks(records).reverse().filter((p) => !isObj(p.rec) || auditKeep(p.rec, filter)).map((p) => auditRow(p.rec, p.also));
  if (!q) return kept;
  return kept.filter((r) => [r.time, r.seq, r.event, r.cpu, r.request, r.result, r.verdict, r.detail].join(" ").toLowerCase().includes(q));
}

/** The line above the table: how many records, which filter, newest first, truncation. */
export function auditNote(total, shown, { filter, text }, truncated) {
  if (!total) return "The audit log is empty.";
  const scope = filter === "writes" ? `${shown} write-related of the last ${total} records` : text.trim() ? `${shown} of the last ${total} records match` : `Last ${total} records`;
  return `${scope}, newest first, local time${truncated ? " (older records not shown)." : "."}`;
}


// ---- operations (R-S5) ---------------------------------------------------------------------------------------------------------------------------------------------
/** Records further apart than this start a new operation even with the same purpose. */
export const OP_GAP_S = 5;
const REQUEST_EVENTS = ["attempt", "msr_read"];
const FILE_EVENTS = ["powercap_attempt", "runtime_attempt"];
/** Plain names of the op summary records (G-235 `result` records with `op`). */
export const OP_NAMES = {
  "profiles.save": "Profile saved",
  "profiles.accept": "Accepted state recorded",
  "profiles.fingerprint": "Fingerprint recorded",
  "vf.measure": "Curve measured",
  "stress.start": "Stress screen",
  "journal.recover": "Journal recovered",
  "curves.delete": "Curve deleted",
  "curves.update": "Curve updated",
  "tune.apply": "Apply",
  "power.apply": "Power limits applied",
  "runtime.apply": "Caps & uncore applied",
  "restore-accepted": "Restore accepted",
};
/** G-249: plain names of the raw operation heads (the guarded reads' `purpose`, "power.apply: read MSR 0x610" in older logs). */
export const PURPOSE_NAMES = {
  "power.read": "Power limits read",
  "power.plan": "Power limits planned",
  "power.apply": "Power limits applied",
  "runtime.apply": "Caps & uncore applied",
  "power plan": "Power limits planned",
  "power read": "Power limits read",
};
/** `result` records of these ops close an apply run (the helper writes one per run): they join the "apply" group of the run's own requests. */
export const APPLY_OPS = ["tune.apply", "restore-accepted", "power.apply", "runtime.apply"];

const tsOf = (o) => {
  const t = isObj(o) && typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
  return Number.isNaN(t) ? null : t / 1000;
};

/** The closing `result` record of an apply run. */
export const isApplyClose = (o) => isObj(o) && o.event === "result" && typeof o.op === "string" && APPLY_OPS.includes(o.op) && o.cmd === undefined && o.msr === undefined;
const isOpSummary = (o) => isObj(o) && typeof o.op === "string" && o.cmd === undefined && o.msr === undefined;
const isBegin = (o) => isObj(o) && FILE_EVENTS.includes(o.event);

/** The operation a record belongs to: `op:<name>` for an op summary, else the purpose before its first colon ("read-back of: apply: …" -> "apply"). */
export function opKey(o) {
  if (!isObj(o)) return "unparsable";
  if (isApplyClose(o)) return "apply";
  if (typeof o.op === "string" && o.cmd === undefined && o.msr === undefined) return "op:" + o.op;
  let p = typeof o.purpose === "string" ? o.purpose.trim() : "";
  p = p.replace(/^read-back of:\s*/i, "");
  const head = p.split(":")[0].trim().toLowerCase().replace(/\s+read-back$/, "");
  if (head) return head;
  // G-249: a powercap / runtime record of an older log has no purpose: it belongs to the apply of its kind (its reads carry the "power.apply" head too)
  if (FILE_EVENTS.includes(o.event) || (["readback", "trip", "error"].includes(o.event) && (o.kind === "powercap" || o.kind === "runtime"))) return o.kind === "runtime" ? "runtime.apply" : "power.apply";
  return typeof o.event === "string" ? "event:" + o.event : "other";
}

/** "Ring read", "Apply", "Profile saved". */
export function opLabel(key) {
  if (key.startsWith("op:")) return OP_NAMES[key.slice(3)] || key.slice(3);
  if (key.startsWith("event:")) return key.slice(6);
  if (PURPOSE_NAMES[key]) return PURPOSE_NAMES[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const isWrite = (o) => {
  const cmd = toNum(o.cmd);
  return o.event === "attempt" && (o.msr_kind === "write" || (cmd !== null && WRITE_CMDS.includes(cmd)));
};

const OUTCOME_MISMATCH = ["mismatch"];
const OUTCOME_WARN = ["cancelled", "canceled", "cancel", "partial"];

/** The plan names the helper gives an apply of loose edits ("tune-0c362b7b"): not for people. */
const internalName = (n) => /^(tune|power|runtime)-[0-9a-f]{6,}$/i.test(n);

/** The label of an apply run from its closing record (G-242: op "restore-accepted" | "tune.apply" | "power.apply" | "runtime.apply", `name` = the profile): "Restore accepted", "Apply Quick",
 *  "Apply \u00b7 P0 point 8" (G-249: the closing record's `summary`), "Power limits applied", "Restore boot values", else "Apply (Tune)" (a tune.apply writes V/F words or turbo tables: Cores or Frequency, final QA). */
export function applyLabel(c) {
  if (!isObj(c)) return "Apply";
  if (c.op === "restore-accepted") return "Restore accepted";
  if (c.op === "power.apply") return c.revert === true ? "Restore boot values" : OP_NAMES["power.apply"];
  if (c.op === "runtime.apply") return c.revert === true ? "Restore boot caps and uncore" : OP_NAMES["runtime.apply"];
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (name && !internalName(name)) return "Apply " + name;
  const summary = typeof c.summary === "string" ? c.summary.trim() : "";
  return summary ? "Apply \u00b7 " + summary : "Apply (Tune)";
}

/** The verdict and plain line of a closing `result` record (apply run or op summary). -> {result, line} or null when it says nothing about an outcome. */
export function closingSummary(c) {
  if (!isObj(c)) return null;
  const outcome = typeof c.outcome === "string" ? c.outcome.toLowerCase() : "";
  const writes = isNum(c.writes_sent) ? c.writes_sent : isNum(c.writes) ? c.writes : null;
  const differ = isNum(c.readback_mismatches) ? c.readback_mismatches : 0;
  let result = "ok";
  if (c.restored === false || ["error", "refused", "failed", "tripped", "trip"].includes(outcome)) result = "error";
  else if (differ > 0 || OUTCOME_MISMATCH.includes(outcome) || c.verified === false) result = "mismatch";
  else if (OUTCOME_WARN.includes(outcome)) result = "warn";
  const bits = [];
  if (isApplyClose(c)) {
    if (["nothing-to-do", "no-change"].includes(outcome) || (writes === 0 && result === "ok")) bits.push("0 writes, nothing to do");
    else {
      if ((c.op === "power.apply" || c.op === "runtime.apply") && typeof c.summary === "string" && c.summary) bits.push(c.summary); // the label of these names no value
      if (writes !== null) bits.push(plural(writes, "write"));
      if (result === "ok" && writes) bits.push("read back equal");
      if (differ > 0) bits.push(`${differ} read back different`);
    }
    if (result === "warn") bits.push(outcome === "partial" ? "partly applied" : "cancelled");
    if (result === "error") bits.push(outcome === "refused" ? "refused" : "failed");
    if (typeof c.detail === "string" && c.detail && result !== "ok") bits.push(c.detail);
  } else {
    const text = typeof c.detail === "string" && c.detail ? c.detail : auditRow(c).detail;
    if (text) bits.push(text);
    if (typeof c.curve_id === "string" && c.curve_id) bits.push("curve stored");
    if (result === "warn" && outcome) bits.push(outcome);
  }
  return { result, line: bits.join(" · ") };
}

/** One operation's verdict and plain line from its records. -> {result: ok|refused|error|mismatch|warn, line} */
export function opSummary(recs) {
  const objs = recs.filter(isObj);
  // QA-33: the run's closing record says how it ended
  const closing = objs.slice().reverse().find((o) => o.event === "result" && isOpSummary(o) && (isApplyClose(o) || typeof o.outcome === "string" || typeof o.detail === "string"));
  if (closing) {
    const c = closingSummary(closing);
    const requests = objs.filter((o) => REQUEST_EVENTS.includes(o.event)).length;
    const writes = objs.filter((o) => isWrite(o) || FILE_EVENTS.includes(o.event)).length;
    const refusedHere = objs.filter((o) => o.event === "refused").length;
    return { result: refusedHere ? "refused" : c.result, line: c.line || plural(recs.length, "record"), requests, writes: isNum(closing.writes_sent) ? closing.writes_sent : writes };
  }
  const requests = objs.filter((o) => REQUEST_EVENTS.includes(o.event)).length;
  const writes = objs.filter(isWrite).length;
  const files = objs.filter((o) => FILE_EVENTS.includes(o.event)).length;
  const backs = objs.filter((o) => o.event === "readback");
  const equal = backs.filter((o) => readbackVerdict(o) === true).length;
  const differ = backs.filter((o) => readbackVerdict(o) === false).length;
  const refused = objs.filter((o) => o.event === "refused").length;
  const errors = objs.filter((o) => o.event === "error" || o.event === "trip" || (o.event === "result" && o.restored === false)).length;
  const odd = objs.map(auditRow).filter((r) => r.resultKind === "warn").length;
  const bits = [];
  if (requests) bits.push(plural(requests, "request"));
  if (writes) bits.push(plural(writes, "write"));
  if (files) bits.push(plural(files, "file write"));
  if (backs.length) bits.push(differ ? `${differ} read back different` : equal === backs.length ? "read back equal" : `${equal} of ${backs.length} read back equal`);
  if (refused) bits.push(`${refused} refused`);
  if (errors) bits.push(plural(errors, "error"));
  if (!bits.length) {
    const sumRec = objs.find((o) => o.detail !== undefined || o.outcome !== undefined);
    bits.push(sumRec ? auditRow(sumRec).detail || String(sumRec.outcome) : plural(recs.length, "record"));
  }
  const result = refused ? "refused" : errors || recs.some((r) => !isObj(r)) ? "error" : differ ? "mismatch" : odd ? "warn" : "ok";
  return { result, line: bits.join(" · "), requests, writes: writes + files };
}

/**
 * Records (oldest first, as audit.tail answers) -> operations, newest first:
 * [{id, key, label, start (epoch s | null), end, took (s | null), operator, records: [raw…], result, line, requests, writes}]. `gapS`: see OP_GAP_S.
 */
export function groupAudit(records, { gapS = OP_GAP_S } = {}) {
  const groups = [];
  let cur = null;
  const open = new Map(); // op key -> the group of a run whose begin record was seen and whose closing `result` has not come (QA-33: begin + result are ONE operation)
  for (const r of Array.isArray(records) ? records : []) {
    const key = opKey(r);
    const t = tsOf(r);
    const operator = isObj(r) && typeof r.operator === "string" ? r.operator : "";
    let g = null;
    if (key.startsWith("op:")) {
      const o = open.get(key);
      if (o && o.operator === operator && !(isBegin(r) && o.begun)) g = o;
    } else if (cur && cur.key === key && cur.operator === operator && (t === null || cur.end === null || t - cur.end <= gapS)) g = cur;
    if (!g) {
      g = { key, label: opLabel(key), start: t, end: t, operator, records: [], begun: false };
      groups.push(g);
    }
    cur = g;
    g.records.push(r);
    if (t !== null) {
      g.end = g.end === null ? t : Math.max(g.end, t);
      if (g.start === null || t < g.start) g.start = t;
    }
    if (key.startsWith("op:")) {
      if (isBegin(r)) {
        g.begun = true;
        open.set(key, g);
      } else if (isObj(r) && r.event === "result") open.delete(key);
    }
  }
  return groups
    .map((g, i) => {
      const first = g.records.find(isObj);
      const s = opSummary(g.records);
      const close = g.records.find(isApplyClose);
      const { begun, ...rest } = g;
      return { ...rest, label: close ? applyLabel(g.records.slice().reverse().find(isApplyClose)) : g.label, id: first && first.seq !== undefined ? String(first.seq) : "g" + i, took: g.start !== null && g.end !== null ? g.end - g.start : null, ...s };
    })
    .reverse();
}

/** Operations after the filter ("all" | "changes": an op with any write-related record, auditKeep "writes") and the free-text query over every raw row. */
export function filterOps(ops, { filter = "all", text = "" } = {}) {
  const q = String(text).trim().toLowerCase();
  return ops.filter((g) => {
    if (filter === "changes" && !g.records.some((r) => !isObj(r) || auditKeep(r, "writes"))) return false;
    if (!q) return true;
    const hay = [g.label, g.line, ...pairReadbacks(g.records).map((p) => auditRow(p.rec, p.also)).map((r) => [r.time, r.seq, r.event, r.cpu, r.request, r.result, r.verdict, r.detail].join(" "))].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/** "1.1 s" / "12 ms" / "—". */
export function tookText(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`;
}

/** "19:53:03.012" in local time, else the raw ts. */
export function clockMs(ts) {
  const d = typeof ts === "string" ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return String(ts ?? "");
  return fmtClock(ts) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export const RESULT_WORDS = { ok: "ok", refused: "refused", error: "error", mismatch: "read back ≠", warn: "check" };
const RESULT_TONE = { ok: "ok", refused: "fault", error: "fault", mismatch: "fault", warn: "warn" };

// ---- the view -------------------------------------------------------------------------------------------------------------------------------------------------------
export function auditView() {
  const subs = [];
  return {
    id: "audit",
    lx: true,
    mount(root, ctx) {
      const { bridge, store } = ctx;
      const state = { filter: "all", text: "", records: [], ops: [], truncated: false, older: false, cursor: null, reading: false, path: "", phase: "loading", error: "", seq: 0, open: new Set(), raw: new Set() };

      // ---- header: search, filter, Refresh (reads the log file: no mailbox request)
      const search = h("input", { type: "search", class: "lx-text lx-audit-search", id: "audit-search", placeholder: "Search…", "aria-label": "Search operations", dataset: { hint: "audit.search" } });
      search.addEventListener("input", () => {
        state.text = search.value;
        draw();
        more();
      });
      const seg = createSegmented({ options: [{ value: "all", label: "All" }, { value: "changes", label: "Changes" }], value: "all", label: "Show", hint: "audit.filter", id: "audit-filter", onChange: (v) => { state.filter = v; draw(); more(); } });
      const refresh = button({ level: 1, label: "Refresh", cost: "0 req", id: "audit-refresh", attrs: { "data-audit": "refresh" }, onClick: () => load() });
      ctx.head.set({ sub: "what the helper did, from its own log", end: [search, seg.el, refresh] });

      // ---- body: one panel, the operations table
      const tbody = h("tbody", { id: "audit-body" });
      const table = h(
        "table",
        { class: "lx-tbl lx-tbl--fill lx-audit-ops", id: "audit-table", "aria-label": "Operations, newest first" },
        h("thead", {}, h("tr", {},
          h("th", { class: "lx-audit-tg", scope: "col", "aria-label": "Open" }),
          h("th", { scope: "col", text: "Time" }),
          h("th", { scope: "col", dataset: { hint: "audit.op" }, text: "Operation" }),
          h("th", { class: "lx-n", scope: "col", text: "Req" }),
          h("th", { class: "lx-n lx-wide", scope: "col", text: "Took" }),
          h("th", { scope: "col", text: "Result" }),
          h("th", { scope: "col", text: "What happened" }),
        )),
        tbody,
      );
      const foot = h("div", { class: "lx-tfoot-note", id: "audit-foot" });
      const holder = h("div", { class: "lx-audit-holder" });
      const p = panel({ title: "Operations", meta: "", body: holder, flush: true, scroll: true, id: "audit-panel" });
      root.append(h("div", { class: "lx-tiles lx-audit" }, p.el));

      const tone = (res) => h("span", { class: "lx-res", dataset: { res: RESULT_TONE[res] || "" }, text: RESULT_WORDS[res] || res });

      function rawTable(g) {
        const body = h("tbody");
        pairReadbacks(g.records).forEach(({ rec, also }, i) => {
          const r = auditRow(rec, also);
          const k = g.id + ":" + i;
          const open = state.raw.has(k);
          const tgl = h("button", { type: "button", class: "lx-btn lx-btn--l0 lx-audit-raw-b", "aria-expanded": String(open), "aria-label": "Raw record", dataset: { hint: "audit.raw", raw: k }, text: "{ }" });
          tgl.addEventListener("click", (e) => {
            e.stopPropagation();
            if (state.raw.has(k)) state.raw.delete(k);
            else state.raw.add(k);
            draw();
          });
          const res = h("td", {}, r.result ? h("span", { class: "lx-res", dataset: { res: r.resultKind === "error" ? "fault" : r.resultKind || "" }, text: r.result }) : "", r.verdict ? h("span", { class: "lx-audit-verdict", dataset: { res: r.verdict === "verified" ? "ok" : r.verdict === "MISMATCH" ? "fault" : "" }, text: (r.result ? " · " : "") + r.verdict }) : null);
          body.append(h("tr", { dataset: { rawRow: k, event: r.event } },
            h("td", { class: "lx-n", text: r.seq }),
            h("td", { class: "lx-mono", title: r.timeTitle, text: clockMs(isObj(rec) ? rec.ts : "") }),
            h("td", { dataset: { res: r.eventKind === "error" ? "fault" : "" }, class: "lx-res", text: r.event }),
            h("td", { class: "lx-n", text: r.cpu }),
            h("td", { class: "lx-mono", text: r.request }),
            res,
            h("td", { class: "lx-audit-detail", text: r.detail }),
            h("td", {}, tgl)));
          if (open) body.append(h("tr", { class: "lx-why-row", dataset: { rawOf: k } }, h("td", { colspan: 8 }, h("pre", { class: "lx-audit-json", text: JSON.stringify(also ? [rec, also] : rec, null, 1) }))));
        });
        return h("table", { class: "lx-tbl lx-tbl--compact lx-tbl--fill lx-audit-raw", "aria-label": `Requests of ${g.label}` },
          h("thead", {}, h("tr", {}, ...["#", "Time", "Event", "CPU", "Request", "Result", "Purpose / detail", ""].map((t, i) => h("th", { scope: "col", class: i === 0 || i === 3 ? "lx-n" : "", text: t })))), body);
      }

      function draw() {
        refresh.disabled = state.phase === "loading";
        if (state.phase === "loading") setBusy(refresh, "Reading…");
        else {
          setBusy(refresh, null);
          setButton(refresh, { label: "Refresh" });
        }
        clear(holder);
        clear(tbody);
        if (state.phase === "loading") {
          p.setMeta("reading the audit log…");
          holder.append(table);
          return;
        }
        if (state.phase === "error") {
          p.setMeta("unavailable");
          holder.append(h("div", { class: "lx-panel-b" }, box({ kind: "warn", title: "The audit log is unavailable", body: h("p", { text: state.error }), id: "audit-error" })));
          return;
        }
        if (!state.records.length) {
          p.setMeta("0 records");
          holder.append(emptyState({ title: HINTS["audit.empty"].label, teach: HINTS["audit.empty"].line, id: "audit-empty" }));
          return;
        }
        const ops = filterOps(state.ops, state);
        p.setMeta(`${plural(ops.length, "operation")}${ops.length !== state.ops.length ? ` of ${state.ops.length} loaded` : ""} · ${plural(state.records.length, "record")} loaded${state.older ? ", older ones available" : ""} · newest first`);
        holder.append(table, foot);
        clear(foot);
        foot.append(h("span", { text: `Local time. From the helper's audit log${state.path ? " " + state.path : ""}. Operations are grouped by purpose and time.${state.reading ? " Reading older records…" : ""}` }));
        if (state.older && !state.reading) {
          const older = button({ level: 1, label: "Load older", cost: "0 req", id: "audit-older", attrs: { "data-audit": "older" }, onClick: () => more(true) });
          foot.append(" ", older);
        }
        if (!ops.length) {
          tbody.append(h("tr", { dataset: { none: "true" } }, h("td", { colspan: 7, class: "lx-audit-none", text: "No operation matches." })));
          return;
        }
        for (const g of ops) {
          const open = state.open.has(g.id);
          const tg = h("button", { type: "button", class: "lx-btn lx-btn--l0 lx-audit-tg-b", "aria-expanded": String(open), "aria-label": `${open ? "Close" : "Open"} ${g.label}`, dataset: { hint: "audit.op" }, text: open ? "▾" : "▸" });
          const tr = h("tr", { class: "lx-click", dataset: { op: g.id, opResult: g.result }, "aria-expanded": String(open) },
            h("td", { class: "lx-audit-tg" }, tg),
            h("td", { class: "lx-mono", title: g.records.find(isObj)?.ts ?? "", text: g.start !== null ? fmtClock(g.start) : NA }),
            h("td", { class: "lx-k", text: g.label }),
            h("td", { class: "lx-n", text: String(g.requests) + (g.partial ? "+" : "") }),
            h("td", { class: "lx-n lx-wide", text: tookText(g.took) }),
            h("td", {}, tone(g.result)),
            h("td", { class: "lx-audit-line", text: g.line + (g.partial ? " · continues in older records" : "") }));
          const toggle = () => {
            if (state.open.has(g.id)) state.open.delete(g.id);
            else state.open.add(g.id);
            draw();
            const again = tbody.querySelector(`tr[data-op="${g.id}"] button`);
            if (again) again.focus();
          };
          tr.addEventListener("click", toggle);
          tg.addEventListener("click", (e) => {
            e.stopPropagation();
            toggle();
          });
          tbody.append(tr);
          if (open) tbody.append(h("tr", { class: "lx-why-row lx-audit-open", dataset: { opRows: g.id } }, h("td", { colspan: 7 }, rawTable(g))));
        }
      }

      const regroup = () => {
        state.ops = groupAudit(state.records);
        // the oldest loaded operation may have started before the first record loaded: its counts are a lower bound until the older page is read
        if (state.older && state.ops.length) state.ops[state.ops.length - 1] = { ...state.ops[state.ops.length - 1], partial: true };
      };
      const matching = () => filterOps(state.ops.filter((g) => !g.partial), state).length;
      /** Reads one page: the newest, or the one before what is loaded. */
      async function page(first) {
        const args = first || state.cursor === null ? { n: AUDIT_N } : { n: AUDIT_N, before: state.cursor };
        const res = await bridge.call("audit.tail", args);
        if (!res.ok || !isObj(res.result)) return { error: res.error && res.error.message ? res.error.message : "the helper did not answer" };
        const r = res.result;
        const recs = Array.isArray(r.records) ? r.records : [];
        state.path = typeof r.path === "string" ? r.path : state.path;
        state.truncated = r.truncated === true;
        // a helper without paging answers no `start`: there is no older page to ask for
        const paged = isNum(r.start);
        const moved = paged && (first || state.cursor === null || r.start < state.cursor);
        if (first || state.cursor === null) state.records = recs;
        else if (moved) state.records = recs.concat(state.records);
        state.older = paged && r.older === true && moved && recs.length > 0;
        state.cursor = paged ? r.start : null;
        return { added: recs.length };
      }
      /** Keeps reading older pages while too few operations match, within one go's page budget (`manual`: the user asked for more). */
      async function more(manual) {
        if (state.phase !== "done" || state.reading || !state.older) return;
        const mine = state.seq;
        const filtered = state.filter !== "all" || state.text.trim() !== "";
        const budget = filtered ? PAGES_PER_GO_FILTERED : PAGES_PER_GO;
        const want = manual ? matching() + WANT_OPS : WANT_OPS;
        state.reading = true;
        draw();
        for (let i = 0; i < budget && state.older && matching() < want; i++) {
          const got = await page(false);
          if (mine !== state.seq) return;
          if (got.error) break;
          regroup();
        }
        state.reading = false;
        draw();
      }
      async function load() {
        const mine = ++state.seq;
        state.phase = "loading";
        state.reading = false;
        draw();
        const got = await page(true);
        if (mine !== state.seq) return; // unmounted or a newer request won
        if (got.error) {
          state.phase = "error";
          state.error = got.error;
        } else {
          state.phase = "done";
          regroup();
        }
        draw();
        if (state.phase === "done") await more();
      }

      // The helper link may come up after this screen opened: load when it becomes connected.
      subs.push(store.watch((s) => s.link.state, (st) => { if (st === "connected" && state.phase !== "done") load(); }));
      subs.push(() => { state.seq = -1; });
      if (store.get().link.state !== "connected") {
        state.phase = "error";
        state.error = `the helper is not connected (${store.get().link.state.replace("_", " ")})`;
        draw();
      }
    },
    unmount() {
      subs.splice(0).forEach((u) => u());
    },
  };
}
