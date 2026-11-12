// views/profiles.js: the Profiles screen (PLAN §4.4, G-213; desktop/DESIGN.md §9.9, R-S5): the accepted state (Restore accepted…, Set the CPU state as accepted…, the
// Windows one-command apply), the saved profiles (one table, full width), the contents of the selected profile section by section, Compare (two states, by the helper),
// Load into Tune (V/F layers, OC, turbo tables, ring points, power limits, ratio caps, ring clock range), Save Tune edits as… / Save CPU state as….
// Ported from web/app.js Profiles (web/app.js:4822-5200).
//
// Ops used (all read-only or bookkeeping, no hardware from here): profiles.list, profiles.get, profiles.save {name, intent, power?, runtime?} | {name, from: "read"},
// profiles.accept {name} | {from: "read"} [+ set_aside_unreadable: true, only from the refusal notice], profiles.diff {a, b}, profiles.fingerprint, stress.list (evidence), tune.last.
// "Review…" and "Restore accepted…" open the commit sheet with a whole-state intent ({profile: name} / {restore: "accepted"}) through the "tune:review" event on store.events.
// Nothing is written to the CPU from this screen.
//
// Set as accepted…: an inline confirm with the helper's diff and the newest clean quick screen as evidence, then profiles.accept as today. R-B1 makes the helper answer a first
// accept with {confirm_required, plan_id, nonce}; the confirmation belongs to the shell (D-053 item 4), so this screen never sends the nonce: such a reply is shown as "not accepted".
//
// Contents are rendered from whatever sections the profile JSON has (profileSections): known sections get their names, an absent known section says "Not in this profile" (applying
// leaves it as the CPU has it), an unknown section is shown plainly. Values are never invented.
import { h, clear } from "../components/dom.js";
import { setLastRead } from "../store.js";
import { fmtMv, fmtV, isNum, plural, fmtLocalDateTime, DASH, MINUS, TIMES } from "../lib/format.js";
import { PROFILE_NAME_RE, buildIntent, POWER_KEYS, UNCORE_KEYS } from "../lib/intent.js";
import { RING_ID, pointAt, ringPoint, unitKind, sameMv, sameV } from "../lib/units.js";
import { ensureRt, editRt, emptyEdits, powerRequest, runtimeRequest, pendingCounts } from "../lib/rtstate.js";
import * as draftLib from "../lib/draft.js";
import { ensureTune, patchTune, createController } from "./tune.js";
import { button, setBusy, setButton, confirmInPlace } from "../components/buttons.js";
import { panel, box, emptyState } from "../components/panel.js";
import { tag } from "../components/ann.js";
import { createQ, why } from "../components/help.js";
import { fmtClock } from "../components/fmt.js";
import { HINTS } from "../lib/hints.js";
import { copyText } from "./setup.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const UNIT_ORDER = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "EC0", "EC1", "EC2", "EC3", RING_ID];
const BOOT_TIMER_CMD = "sudo systemctl enable linux-xtu-restore.timer";
const BOOT_ARM_CMD = "sudo /usr/lib/linux-xtu/linux-xtu-restore arm";
/** R2-07: ONE command that turns the boot restore fully on (enabling the timer alone leaves it disarmed; arming alone leaves the timer off). The helper's note says the same. */
export const BOOT_ENABLE_CMD = `${BOOT_TIMER_CMD} && ${BOOT_ARM_CMD}`;
/**
 * G-244 (QA-35): the Profiles line about boot restore, from the helper's optional preflight field `boot_restore` ({state: not_installed | disarmed | armed, note}, or the state as a
 * string). null when the helper sends none (say nothing). -> {state, on, text, cmd}: "Boot restore: off" unless armed ("Boot restore: on"); `cmd` = the command that turns it on, which the
 * "Enable boot restore…" button copies (G-252: the raw sudo line is not shown).
 * G-249 (R2-07): with the helper's additive `timer` / `armed` the two halves are told apart: timer on + disarmed -> only the arm command; armed + timer off -> only the enable command.
 */
export function bootRestoreLine(pre) {
  const b = isObj(pre) ? pre.boot_restore : undefined;
  const state = typeof b === "string" ? b : isObj(b) && typeof b.state === "string" ? b.state : null;
  if (!state) return null;
  if (state === "armed") return { state, on: true, text: "Boot restore: on", cmd: "" };
  const timer = isObj(b) ? b.timer : undefined;
  const armed = isObj(b) ? b.armed : undefined;
  if (timer === "enabled" && armed === "no") return { state, on: false, text: "Boot restore: timer on, not armed", cmd: BOOT_ARM_CMD };
  if (armed === "yes" && (timer === "disabled" || timer === "masked")) return { state, on: false, text: "Boot restore: armed, timer off", cmd: BOOT_TIMER_CMD };
  return { state, on: false, text: "Boot restore: off", cmd: BOOT_ENABLE_CMD };
}

export const NO_ACCEPTED_TEXT = "No accepted state yet: save a profile as accepted (Profiles)";
export const ACCEPTED_MIGRATE_HINT = "sudo python3 -I tools/linux-xtu.py accepted-migrate";
const INFO_BATCH = 6;
const INFO_MAX = 60;
const DIFF_MAX = 80;

// ---- pure helpers (node --test) ---------------------------------------------------------------------------------------------------------------------------------------------------
export const rowsOf = (c) => (isObj(c) && Array.isArray(c.rows) ? c.rows.filter(isObj) : []);

/** web/app.js:4885. "12 units · deepest −25 mV · 1 OC ratio · 1 target voltage · turbo table". */
export function summaryText(s) {
  if (!isObj(s)) return "";
  const bits = [plural(s.units, "unit")];
  if (isNum(s.deepest_offset_mv)) bits.push("deepest " + fmtMv(s.deepest_offset_mv));
  if (s.oc_ratios) bits.push(plural(s.oc_ratios, "OC ratio"));
  if (s.v_targets) bits.push(plural(s.v_targets, "target voltage"));
  if (s.turbo) bits.push("turbo table");
  return bits.join(" · ");
}

/** web/app.js:4876. The whole offset of a row, in words. */
export function offsetText(o) {
  if (!isObj(o)) return "unchanged";
  if (o.kind === "curve") return fmtMv(o.mv) + " (whole curve)";
  if (o.kind === "points" && isObj(o.mv)) return Object.keys(o.mv).sort((a, b) => a - b).map((r) => r + TIMES + " " + fmtMv(o.mv[r])).join(", ");
  return "unchanged";
}

/** web/app.js:4883. A table cell: every point when there are few, else the count and the range. */
export function offsetShort(o) {
  if (!isObj(o)) return DASH;
  if (o.kind === "curve") return fmtMv(o.mv) + " all";
  if (!isObj(o.mv)) return DASH;
  const ks = Object.keys(o.mv).sort((a, b) => a - b);
  if (ks.length <= 3) return ks.map((r) => r + TIMES + " " + fmtMv(o.mv[r])).join(", ");
  const vs = ks.map((r) => o.mv[r]);
  return ks.length + " points, " + fmtMv(Math.min(...vs)) + " to " + fmtMv(Math.max(...vs));
}

/** "complete" | "partial" | null (unknown): from the list row, else from profiles.get. */
export function kindOf(entry, info) {
  if (isObj(entry) && typeof entry.complete === "boolean") return entry.complete ? "complete" : "partial";
  if (isObj(info) && typeof info.complete === "boolean") return info.complete ? "complete" : "partial";
  return null;
}

const unitRank = (u) => UNIT_ORDER.indexOf(u);
function valueAt(o, ratio) {
  if (!isObj(o)) return null;
  if (o.kind === "curve") return o.mv;
  return isObj(o.mv) && isNum(o.mv[ratio]) ? o.mv[ratio] : null;
}
const stepText = (n) => (n > 0 ? "+" : n < 0 ? MINUS : "") + Math.abs(n) + TIMES;
const deltaMv = (a, b) => (isNum(a) && isNum(b) ? fmtMv(b - a) : DASH);

/**
 * web/app.js:5004. Rows {unit, label, a, b, fmt, delta} where two profiles' contents differ; "second minus first". A whole-curve value stands for every point of a unit the other side sets
 * point by point. `a` / `b` null = the profile does not set that value.
 */
export function compareRows(ca, cb) {
  const ra = {};
  const rb = {};
  for (const r of rowsOf(ca)) ra[r.target] = r;
  for (const r of rowsOf(cb)) rb[r.target] = r;
  const out = [];
  const units = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((u) => unitRank(u) >= 0).sort((x, y) => unitRank(x) - unitRank(y));
  for (const u of units) {
    const xa = ra[u] || {};
    const xb = rb[u] || {};
    const oa = isObj(xa.offset) ? xa.offset : null;
    const ob = isObj(xb.offset) ? xb.offset : null;
    if (oa || ob) {
      const bothCurve = (!oa || oa.kind === "curve") && (!ob || ob.kind === "curve");
      if (bothCurve) {
        const a = oa ? oa.mv : null;
        const b = ob ? ob.mv : null;
        if (a !== b) out.push({ unit: u, label: "Offset, whole curve", a, b, fmt: fmtMv, delta: deltaMv });
      } else {
        const ratios = [...new Set([oa, ob].flatMap((o) => (o && o.kind === "points" ? Object.keys(o.mv).map(Number) : [])))].sort((x, y) => x - y);
        for (const r of ratios) {
          const a = valueAt(oa, r);
          const b = valueAt(ob, r);
          if (a !== b) out.push({ unit: u, label: "Offset at " + r + TIMES, a, b, fmt: fmtMv, delta: deltaMv });
        }
      }
    }
    const va = isNum(xa.v_target_v) ? xa.v_target_v : null;
    const vb = isNum(xb.v_target_v) ? xb.v_target_v : null;
    if (va !== vb) out.push({ unit: u, label: "OC target voltage", a: va, b: vb, fmt: fmtV, delta: (a, b) => (isNum(a) && isNum(b) ? fmtMv((b - a) * 1000) : DASH) });
    const na = isNum(xa.ratio) ? xa.ratio : null;
    const nb = isNum(xb.ratio) ? xb.ratio : null;
    if (na !== nb) out.push({ unit: u, label: "OC ratio", a: na, b: nb, fmt: (x) => x + TIMES, delta: (a, b) => (isNum(a) && isNum(b) ? stepText(b - a) : DASH) });
  }
  for (const k of ["P", "E"]) {
    const ta = isObj(ca) && isObj(ca.turbo) && Array.isArray(ca.turbo[k]) ? ca.turbo[k] : null;
    const tb = isObj(cb) && isObj(cb.turbo) && Array.isArray(cb.turbo[k]) ? cb.turbo[k] : null;
    if (!ta && !tb) continue;
    for (let i = 0; i < 8; i++) {
      const a = ta ? ta[i] : null;
      const b = tb ? tb[i] : null;
      if (a !== b) out.push({ unit: k + " turbo", label: "Bucket " + i, a, b, fmt: (x) => x + TIMES, delta: (x, y) => (isNum(x) && isNum(y) ? stepText(y - x) : DASH) });
    }
  }
  return out;
}

/**
 * web/app.js:5077 (loadIntoTune), R-S5: a profile's contents -> edits over `model` (the last read). The draft keeps only what DIFFERS from the read (lib/draft.js drops equal edits),
 * so a complete profile that equals the CPU gives an empty draft. A row's two offset layers (R-B1 `layers: {curve_mv, points_mv}`) load as two layers; without `layers` the row's one
 * `offset` loads. The ring's points (`ring.points` by P2 number) load when the helper reads the ring; the runtime sections (`power`, `caps` by unit, `uncore`) become runtime edits
 * (`rtEdits`, the shape of store.rt.edits). Returns {draft, rtEdits, skipped (what the read has no such thing as), clamped (values the editor moved or refused), loaded (section keys)}.
 */
export function draftFromContents(model, contents) {
  let draft = draftLib.emptyDraft();
  const skipped = [];
  const clamped = [];
  const loaded = new Set();
  const curve = (id, mv) => {
    draft = draftLib.setCurve(model, draft, [id], mv);
    const now = draftLib.curveValue(model, draft, [id]);
    if (!(now.state === "same" && sameMv(now.value, mv))) clamped.push(id + " " + fmtMv(mv));
  };
  const points = (id, unit, mvs) => {
    for (const k of Object.keys(mvs).sort((x, y) => x - y)) {
      const ratio = Number(k);
      if (!pointAt(unit, ratio) || !isNum(mvs[k])) {
        skipped.push(id + " " + k + TIMES);
        continue;
      }
      draft = draftLib.setPoint(model, draft, [id], ratio, mvs[k]);
      const now = draftLib.pointValue(model, draft, [id], ratio);
      if (!(now.agg.state === "same" && sameMv(now.agg.value, mvs[k]))) clamped.push(id + " " + k + TIMES + " " + fmtMv(mvs[k]));
    }
  };
  for (const r of rowsOf(contents)) {
    const id = r.target;
    const unit = model.units[id];
    if (!unit || unitKind(id) === "R") {
      skipped.push(String(id));
      continue;
    }
    loaded.add("rows");
    const layers = isObj(r.layers) ? r.layers : null;
    if (layers) {
      if (isNum(layers.curve_mv)) curve(id, layers.curve_mv);
      if (isObj(layers.points_mv)) points(id, unit, layers.points_mv);
    } else {
      const o = r.offset;
      if (isObj(o) && o.kind === "curve" && isNum(o.mv)) curve(id, o.mv);
      else if (isObj(o) && o.kind === "points" && isObj(o.mv)) points(id, unit, o.mv);
    }
    if (isNum(r.ratio)) {
      draft = draftLib.setOcRatio(model, draft, [id], r.ratio);
      if (draftLib.effRatio(draft, unit) !== r.ratio) clamped.push(id + " OC ratio " + r.ratio + TIMES);
    }
    if (isNum(r.v_target_v)) {
      draft = draftLib.setVt(model, draft, [id], r.v_target_v, { snap: false });
      const v = draftLib.effVt(draft, unit);
      if (!(isNum(v) && sameV(v, r.v_target_v))) clamped.push(id + " target " + fmtV(r.v_target_v));
    }
  }
  const tu = isObj(contents) && isObj(contents.turbo) ? contents.turbo : {};
  for (const kind of ["P", "E"]) {
    const want = tu[kind];
    const cur = draftLib.turboCur(model, kind);
    if (!Array.isArray(want) || want.length !== 8 || !cur) {
      if (Array.isArray(want) && !cur) skipped.push(kind + " turbo table (not read)");
      continue;
    }
    loaded.add("turbo");
    if (!want.some((x, i) => x !== cur[i])) continue;
    for (let i = 0; i < 8; i++) draft = draftLib.setBucket(model, draft, kind, i, want[i]);
    const eff = draftLib.turboEff(model, draft, kind);
    if (want.some((x, i) => x !== eff[i])) clamped.push(kind + " turbo table");
  }
  const ring = isObj(contents) && isObj(contents.ring) && isObj(contents.ring.points) ? contents.ring.points : null;
  if (ring) {
    const unit = model.units[RING_ID];
    if (!unit || !model.features || !model.features.ring) skipped.push("ring (not read)");
    else {
      loaded.add("ring");
      for (const k of Object.keys(ring).sort((x, y) => x - y)) {
        if (!isNum(ring[k])) continue;
        const r = draftLib.editRingPoint(model, draft, Number(k), ring[k], { allowPositive: true });
        if (r.ok) draft = r.draft;
        else (ringPoint(unit, Number(k)) ? clamped : skipped).push("ring point " + k + " " + fmtMv(ring[k]));
      }
    }
  }
  const rtEdits = { power: {}, caps: {}, uncore: {} };
  const c = isObj(contents) ? contents : {};
  if (isObj(c.power)) {
    for (const k of POWER_KEYS) if (isNum(c.power[k])) rtEdits.power[k] = c.power[k];
    if (Object.keys(rtEdits.power).length) loaded.add("power");
  }
  if (isObj(c.caps)) {
    for (const [u, ratio] of Object.entries(c.caps)) {
      if (!isNum(ratio)) continue;
      if (model.units[u]) rtEdits.caps[u] = ratio;
      else skipped.push(u + " ratio cap");
    }
    if (Object.keys(rtEdits.caps).length) loaded.add("caps");
  }
  if (isObj(c.uncore)) {
    for (const k of UNCORE_KEYS) if (isNum(c.uncore[k])) rtEdits.uncore[k] = c.uncore[k];
    if (Object.keys(rtEdits.uncore).length) loaded.add("uncore");
  }
  return { draft, rtEdits, skipped, clamped, loaded: [...loaded] };
}

/** True when runtime edits hold anything (power, caps, uncore). */
export const hasRtEdits = (e) => isObj(e) && ["power", "caps", "uncore"].some((k) => isObj(e[k]) && Object.keys(e[k]).length > 0);

/**
 * The Save gate: {ok, note, intent, extra}. `taken` = names already in the library. R-S5 (R-B1 profiles.save): the Tune edits travel as they are planned — rows, turbo tables and
 * ring points in `intent`, power limits as `extra.power`, ratio caps and the uncore range as `extra.runtime` ({caps: {cpu: ratio}, uncore}). `rt` = store.rt (or null).
 */
export function saveGate({ name, taken, model, draft, rt = null }) {
  if (!name) return { ok: false, note: "Lowercase letters, digits, dot, underscore, hyphen. Up to 64.", intent: null, extra: {} };
  if (!PROFILE_NAME_RE.test(name)) return { ok: false, note: "Not allowed: use a-z, 0-9, dot, underscore, hyphen (1 to 64).", intent: null, extra: {} };
  if (taken.includes(name)) return { ok: false, note: "A profile with this name exists. Names are never reused; pick another.", intent: null, extra: {} };
  if (!model) return { ok: false, note: "Read the CPU state first (Tune): a profile is the complete state of the last read with your changes over it.", intent: null, extra: {} };
  const built = buildIntent(model, draft);
  if (built.error) return { ok: false, note: built.error, intent: null, extra: {} };
  const intent = built.intent || {};
  const rows = Array.isArray(intent.rows) ? intent.rows : [];
  const sendable = { scope: "unit", rows, ...(intent.turbo ? { turbo: intent.turbo } : {}), ...(intent.ring ? { ring: intent.ring } : {}) }; // no edits = the read as it is (web/app.js:5135)
  const extra = {};
  const parts = [];
  if (rows.length) parts.push(plural(rows.length, "changed unit"));
  if (intent.turbo) parts.push("turbo " + Object.keys(intent.turbo).join(" and "));
  if (intent.ring) parts.push("ring points");
  if (rt && isObj(rt.edits)) {
    const pw = powerRequest(rt);
    if (pw.error) return { ok: false, note: "Power edits: " + pw.error, intent: null, extra: {} };
    if (pw.intent) {
      extra.power = pw.intent.power;
      parts.push("power limits");
    }
    const run = runtimeRequest(rt);
    if (run.error) return { ok: false, note: "Ratio cap or ring clock edits: " + run.error, intent: null, extra: {} };
    if (run.intent) {
      extra.runtime = run.intent;
      if (run.intent.caps) parts.push("ratio caps");
      if (run.intent.uncore) parts.push("ring clock range");
    }
  }
  return { ok: true, note: "Will save every unit as the last read holds it" + (parts.length ? ", with " + parts.join(", ") + " from Tune over it." : " (no changes from Tune)."), intent: sendable, extra };
}

export const acceptConfirmText = (what, replaced) =>
  what + " becomes the accepted state. Restore accepted re-applies it (after a boot too, once boot restore is on) and the dashboard compares the CPU with it. " +
  (replaced.length ? "It replaces the current accepted state (" + replaced.join(", ") + ")." : "There is no accepted state yet, so nothing is replaced.") +
  " It has to be what the CPU holds now: the complete state of the last read is recorded (every unit and fused point). Nothing is written to the CPU.";

// ---- G-228: save the full state without accepting it; an accept keeps the state it replaces --------------------------------------------------------------------------------------------
export const PREVIOUS_PREFIX = "accepted-before-";
export const READ_FIRST_TEXT = "Read CPU state first";
export const isPreviousAccepted = (name) => typeof name === "string" && name.startsWith(PREVIOUS_PREFIX);

/** ["20261018-120000", n] of "accepted-before-20261018-120000[-n]", else null. */
function previousKey(name) {
  const m = /^accepted-before-(\d{8}-\d{6})(?:-(\d+))?$/.exec(String(name));
  return m ? [m[1], m[2] ? Number(m[2]) : 1] : null;
}

/** "2026-10-18 12:00:00 UTC" from a previous-accepted name, else "". */
export function previousStamp(name) {
  const k = previousKey(name);
  return k ? k[0].replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3 $4:$5:$6 UTC") : "";
}

/** The list order: the accepted state first, the saved profiles as the helper lists them, then the previous accepted states, newest first (stamp, then the -2 / -3 suffix, then created). */
export function savedOrder(list) {
  const prev = (p) => p.source !== "accepted" && isPreviousAccepted(p.name);
  const newest = (a, b) => {
    const ka = previousKey(a.name);
    const kb = previousKey(b.name);
    if (ka && kb) return ka[0] === kb[0] ? kb[1] - ka[1] : ka[0] < kb[0] ? 1 : -1;
    return String(b.created || b.name) < String(a.created || a.name) ? -1 : 1;
  };
  return [...list.filter((p) => p.source === "accepted"), ...list.filter((p) => p.source !== "accepted" && !prev(p)), ...list.filter(prev).sort(newest)];
}

/**
 * G-244 (QA-28, QA-27): the rows the list shows, in savedOrder. The accepted state and the saved profile it was made from share a name: they are ONE row, source "accepted",
 * `twin` true (tagged saved + accepted), with the saved profile's `created` as its saved time. The header count and the list meta both count these rows.
 */
export function listRows(list) {
  const saved = new Map(list.filter((p) => p.source !== "accepted").map((p) => [p.name, p]));
  const accepted = new Set(list.filter((p) => p.source === "accepted" && p.chain !== true).map((p) => p.name));
  const out = [];
  for (const p of savedOrder(list)) {
    if (p.source === "accepted") {
      const twin = p.chain !== true ? saved.get(p.name) : undefined;
      out.push(twin ? { ...p, created: twin.created ?? p.created ?? null, twin: true } : { ...p, twin: false });
    } else if (!accepted.has(p.name)) out.push({ ...p, twin: false });
  }
  return out;
}

/** The name gate of "Save current state as…": same rules as the Save card, minus the Tune edits (the helper saves the last read as it is). */
export function stateNameGate({ name, taken }) {
  if (!name) return { ok: false, note: "Lowercase letters, digits, dot, underscore, hyphen. Up to 64." };
  if (!PROFILE_NAME_RE.test(name)) return { ok: false, note: "Not allowed: use a-z, 0-9, dot, underscore, hyphen (1 to 64)." };
  if (taken.includes(name)) return { ok: false, note: "A profile with this name exists. Names are never reused; pick another." };
  return { ok: true, note: "Saves every unit as the last read holds it. It is not made the accepted state." };
}

/** "NO_READ" | "STALE_READ" when the helper refused for want of a current read, else null. */
export function readRefusal(error) {
  const c = isObj(error) && isObj(error.detail) ? error.detail.check : null;
  return c === "NO_READ" || c === "STALE_READ" ? c : null;
}

/** True when the helper refused because the accepted state cannot be read (it offers to move the whole directory aside). */
export const unreadableRefusal = (error) => isObj(error) && isObj(error.detail) && error.detail.check === "ACCEPTED_UNREADABLE";

const KIND_FMT = {
  mv: { fmt: fmtMv, delta: deltaMv },
  v: { fmt: fmtV, delta: (a, b) => (isNum(a) && isNum(b) ? fmtMv((b - a) * 1000) : DASH) },
  x: { fmt: (x) => x + TIMES, delta: (a, b) => (isNum(a) && isNum(b) ? stepText(b - a) : DASH) },
  hex: { fmt: (x) => String(x), delta: () => DASH },
};

/**
 * The rows of a profiles.diff answer in the shape renderers use ({unit, label, a, b, fmt, delta}). The helper compares the profiles themselves (every unit's OC word offset / ratio / target voltage,
 * every fused point, the ring, the turbo tables), so nothing is dropped here. `kind`: mv | v | x | hex (the ring's OC word).
 */
export function helperDiffRows(result) {
  if (!isObj(result) || !Array.isArray(result.rows)) return [];
  return result.rows.filter(isObj).map((r) => ({
    unit: String(r.unit), label: String(r.label).replace(/(\d)x$/, "$1" + TIMES), a: r.a === undefined ? null : r.a, b: r.b === undefined ? null : r.b, ...(KIND_FMT[r.kind] || KIND_FMT.hex),
  }));
}

/** [{unit, n}] in row order: how many values differ per unit (the confirm step's per-unit list). */
export function diffByUnit(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.unit === r.unit) last.n++;
    else out.push({ unit: r.unit, n: 1 });
  }
  return out;
}

export function diffSummary(rows, result = null) {
  if (!rows.length) {
    if (!isObj(result) || !Array.isArray(result.compared)) return "No differences were found.";
    const not = Array.isArray(result.not_compared) && result.not_compared.length ? " Not compared: " + result.not_compared.map((x) => x.what + " (" + x.why + ")").join("; ") + "." : "";
    return "No differences in what was compared: " + result.compared.join("; ") + "." + not;
  }
  const more = isObj(result) && isNum(result.truncated) && result.truncated > 0 ? " (" + result.truncated + " more are not listed)" : "";
  return plural(rows.length, "difference") + " in " + plural(diffByUnit(rows).length, "unit") + " from the current accepted state: " + diffByUnit(rows).map((u) => u.unit + " (" + u.n + ")").join(", ") + "." + more;
}

export const previousKeptText = (replaced) =>
  replaced.length
    ? "The current accepted state (" + replaced.join(", ") + ") is saved first as a profile (accepted-before-<date>), so it can be accepted again."
    : "There is no accepted state to keep.";

/** QA-34 (G-248): a stored UTC stamp as local time ("Nov 12 10:53"); "" when it is not a date. */
export function fmtCreated(iso) {
  return typeof iso === "string" ? fmtLocalDateTime(iso) : "";
}

const errText = (error) => (error && (error.message || error.code)) || "unknown error";

/** Open the apply drawer for a whole-state intent. The drawer plans it (no hardware) and writes only on its own Apply. */
export function reviewIntent(store, intent, label) {
  ensureTune(store);
  store.events.dispatchEvent(new CustomEvent("tune:review", { detail: { requests: [{ kind: "tune", intent, label }] } }));
}


// ---- R-S5: contents by section, compare refs, the accept reply, the Windows command (pure, node --test) ------------------------------------------------------------
const NOT_APPLICABLE = "—";
/** Sections a profile may hold, in display order (R-B1 profile schema 2). Keys the helper adds later and this list does not know are shown plainly. */
export const KNOWN_SECTIONS = [
  { key: "rows", title: "V/F and OC per unit" },
  { key: "turbo", title: "Turbo tables" },
  { key: "ring", title: "Ring V/F points" },
  { key: "power", title: "Package power limits" },
  { key: "caps", title: "Ratio caps" },
  { key: "uncore", title: "Ring clock range" },
];
/** Keys that describe the profile rather than hold a section. */
export const META_KEYS = ["complete", "version"];

const ratioText = (x) => (isNum(x) ? x + TIMES : NOT_APPLICABLE);
/** G-244 (QA-38): the time window the way Tune shows it (views/tune/power.js: one decimal). 63.963136 -> "64.0 s". */
export const tauText = (s) => (isNum(s) ? s.toFixed(1) + " s" : NOT_APPLICABLE);
const plainValue = (v) => {
  if (v === null || v === undefined) return NOT_APPLICABLE;
  if (Array.isArray(v)) return v.map(plainValue).join(" ");
  if (isObj(v)) return Object.entries(v).map(([k, x]) => k + " " + plainValue(x)).join(", ");
  return String(v);
};

export const RUNTIME_KEYS = ["power", "caps", "uncore"];
/** Why a known section is absent, in the helper's words: schema 2 (R-B1) records the runtime values it could read, so an absent one was "not captured"; older profiles never held it. */
export function absentNote(contents, key) {
  const v2 = isObj(contents) && isNum(contents.version) && contents.version >= 2;
  return (v2 && (RUNTIME_KEYS.includes(key) || key === "ring") ? "Not captured" : "Not in this profile") + " · left as the CPU has it";
}

/** A unit row's two offset layers as text: {curve, points} ("—" = the layer is not set; a whole-curve offset of 0 is not set). */
export function rowLayers(r) {
  const l = isObj(r.layers) ? r.layers : null;
  let curve = null;
  let pts = null;
  if (l) {
    curve = isNum(l.curve_mv) ? l.curve_mv : null;
    pts = isObj(l.points_mv) && Object.keys(l.points_mv).length ? l.points_mv : null;
  } else if (isObj(r.offset)) {
    if (r.offset.kind === "curve") curve = r.offset.mv;
    else if (r.offset.kind === "points") pts = r.offset.mv;
  }
  return { curve: isNum(curve) && curve !== 0 ? fmtMv(curve) : NOT_APPLICABLE, points: pts ? offsetShort({ kind: "points", mv: pts }) : NOT_APPLICABLE };
}

/**
 * The sections of a profile's contents: [{key, title, state: "set" | "absent" | "unknown", kind: "units" | "kv", rows}]. `units` rows: {unit, curve, points, ocRatio, ocV};
 * `kv` rows: [label, value, mono?]. A known section that is missing or null is "absent" (applying the profile leaves it as the CPU has it). Unknown keys come last, as they are.
 */
export function profileSections(contents) {
  const c = isObj(contents) ? contents : {};
  const out = [];
  for (const { key, title } of KNOWN_SECTIONS) {
    const v = c[key];
    const absent = v === undefined || v === null || (key === "rows" && !rowsOf(c).length) || (isObj(v) && !Object.keys(v).length);
    if (absent) {
      out.push({ key, title, state: "absent", kind: "kv", rows: [], note: absentNote(c, key) });
      continue;
    }
    if (key === "rows") {
      const urows = rowsOf(c).map((r) => ({ unit: String(r.target), ...rowLayers(r), ocRatio: ratioText(r.ratio), ocV: isNum(r.v_target_v) ? fmtV(r.v_target_v) : NOT_APPLICABLE }));
      out.push({ key, title, state: "set", kind: "units", rows: urows, hasCurve: urows.some((r) => r.curve !== NOT_APPLICABLE) }); // G-252: no "Whole curve 0 mV" column when no unit has a whole-curve offset
    } else if (key === "turbo") {
      out.push({ key, title, state: "set", kind: "kv", rows: ["P", "E"].filter((k) => Array.isArray(v[k])).map((k) => [k + "-cores", v[k].join(" ") + " " + TIMES, true]) });
    } else if (key === "ring") {
      const pts = isObj(v.points) ? Object.keys(v.points).sort((a, b) => a - b).map((n) => [n, v.points[n]]) : [];
      const rows = [];
      if (v.oc_word) rows.push(["OC word", String(v.oc_word), true]);
      rows.push(["Points", pts.length ? (pts.every(([, mv]) => mv === 0) ? `${pts.length} points, all 0 mV` : pts.map(([n, mv]) => `${n}: ${fmtMv(mv)}`).join(", ")) : NOT_APPLICABLE, true]);
      out.push({ key, title, state: "set", kind: "kv", rows });
    } else if (key === "power") {
      const rows = [];
      if (v.pl1_w !== undefined) rows.push(["Long-term limit PL1", isNum(v.pl1_w) ? v.pl1_w + " W" : NOT_APPLICABLE, true]);
      if (v.pl2_w !== undefined) rows.push(["Short-term limit PL2", isNum(v.pl2_w) ? v.pl2_w + " W" : NOT_APPLICABLE, true]);
      if (v.tau_s !== undefined) rows.push(["Time window tau", isNum(v.tau_s) ? tauText(v.tau_s) : NOT_APPLICABLE, true, isNum(v.tau_s) ? `exactly ${v.tau_s} s as the helper sent it` : ""]); // G-244 (QA-38): as Tune shows it (64.0 s); the encoded value in the tooltip
      for (const [k, x] of Object.entries(v)) if (!POWER_KEYS.includes(k)) rows.push([k, plainValue(x), true]);
      out.push({ key, title, state: "set", kind: "kv", rows });
    } else if (key === "caps") {
      out.push({ key, title, state: "set", kind: "kv", rows: [["Never above", Object.entries(v).map(([u, x]) => `${u} ${ratioText(x)}`).join(", "), true]] });
    } else if (key === "uncore") {
      const rows = [];
      if (v.min_ratio !== undefined) rows.push(["Minimum", ratioText(v.min_ratio), true]);
      if (v.max_ratio !== undefined) rows.push(["Maximum", ratioText(v.max_ratio), true]);
      for (const [k, x] of Object.entries(v)) if (!UNCORE_KEYS.includes(k)) rows.push([k, plainValue(x), true]);
      out.push({ key, title, state: "set", kind: "kv", rows });
    }
  }
  const known = new Set([...KNOWN_SECTIONS.map((s) => s.key), ...META_KEYS]);
  for (const [k, v] of Object.entries(c)) {
    if (known.has(k)) continue;
    const rows = isObj(v) ? Object.entries(v).map(([kk, x]) => [kk, plainValue(x), true]) : [[k, plainValue(v), true]];
    out.push({ key: k, title: k, state: "unknown", kind: "kv", rows });
  }
  return out;
}

/** The list table's short cells from a profiles.get answer: {units, deepest, turbo, ring, runtime}. */
export function listCells(info) {
  if (!isObj(info) || !isObj(info.contents)) return { units: NOT_APPLICABLE, deepest: NOT_APPLICABLE, turbo: NOT_APPLICABLE, ring: NOT_APPLICABLE, runtime: NOT_APPLICABLE };
  const c = info.contents;
  const s = isObj(info.summary) ? info.summary : {};
  const runtime = [isObj(c.power) && Object.keys(c.power).length ? "power" : null, isObj(c.caps) && Object.keys(c.caps).length ? "caps" : null, isObj(c.uncore) && Object.keys(c.uncore).length ? "ring clock" : null].filter(Boolean);
  const ringPts = isObj(c.ring) && isObj(c.ring.points) ? Object.keys(c.ring.points).length : 0;
  return {
    units: isNum(s.units) ? String(s.units) : String(rowsOf(c).length),
    deepest: isNum(s.deepest_offset_mv) ? fmtMv(s.deepest_offset_mv).replace(/ mV$/, "") : NOT_APPLICABLE,
    turbo: isObj(c.turbo) ? ["P", "E"].filter((k) => Array.isArray(c.turbo[k])).join(" ") || NOT_APPLICABLE : NOT_APPLICABLE,
    ring: ringPts ? String(ringPts) : NOT_APPLICABLE,
    runtime: runtime.length ? runtime.join(" · ") : isNum(c.version) && c.version >= 2 ? "not captured" : "not in profile",
  };
}

/** The compare choices: the accepted state (when there is one), the CPU now (the last read), and every saved profile. G-252: the accepted state and the saved profile it was made from are ONE state, listed once. */
export function compareRefs(list) {
  const out = [];
  const rows = listRows(list);
  if (rows.some((p) => p.source === "accepted")) out.push({ value: "accepted", label: "Accepted state" });
  out.push({ value: "read", label: "CPU now (last read)" });
  for (const n of [...new Set(rows.filter((p) => p.source !== "accepted").map((p) => p.name))]) out.push({ value: n, label: n });
  return out;
}

/** G-252: the compare reference a list row stands for: the accepted row and its saved twin are both "accepted"; any other row is its own name. */
export function refOf(list, name, source) {
  if (source === "accepted") return "accepted";
  return list.some((p) => p.source === "accepted" && p.chain !== true && p.name === name) ? "accepted" : name;
}

/** G-252: the compare choice to start from: `a` = the selected row, else the accepted state, else the newest saved profile; `b` = "CPU now", never the same as `a`. */
export function compareDefaults(list, selected = null, selectedSource = null) {
  const vals = compareRefs(list).map((r) => r.value);
  const saved = listRows(list).filter((p) => p.source !== "accepted");
  const newest = saved.slice().sort((x, y) => (String(y.created || "") < String(x.created || "") ? -1 : String(y.created || "") > String(x.created || "") ? 1 : 0))[0];
  let a = selected ? refOf(list, selected, selectedSource) : null;
  if (!a || a === "read" || !vals.includes(a)) a = vals.includes("accepted") ? "accepted" : newest ? newest.name : vals.find((v) => v !== "read") || "read";
  const b = a !== "read" ? "read" : vals.find((v) => v !== "read") || "read";
  return { a, b };
}

/**
 * What a profiles.accept reply means: {kind: "accepted", result} | {kind: "confirm", expires_s} (the helper asks for the plan-style confirmation the shell owns; nothing was
 * recorded) | {kind: "refused", error}.
 */
export const DECLINED_CODES = ["NOT_CONFIRMED", "CONFIRM_UNAVAILABLE", "BUSY"];
export function acceptOutcome(r) {
  if (r && r.ok && isObj(r.result)) {
    if (r.result.confirm_required === true) return { kind: "confirm", expires_s: isNum(r.result.expires_s) ? r.result.expires_s : null };
    return { kind: "accepted", result: r.result };
  }
  const e = r ? r.error : null;
  // R-S3: the shell shows its own dialog for profiles.accept / profiles.fingerprint; a Cancel or no dialog comes back with writes_sent 0 — nothing recorded
  if (isObj(e) && DECLINED_CODES.includes(e.code) && isObj(e.detail) && e.detail.writes_sent === 0) return { kind: "declined", error: e };
  return { kind: "refused", error: e };
}

/** "Not captured: power limits not captured: …; …" from the helper's `not_captured` (R-B1: why a runtime section is absent), or "". */
export function notCapturedText(result) {
  const n = isObj(result) && Array.isArray(result.not_captured) ? result.not_captured.filter((x) => typeof x === "string" && x) : [];
  return n.length ? "Not captured (left as the CPU has it when applied): " + n.join("; ") + "." : "";
}

export const EVIDENCE_OTHER_STATE = "Evidence is from a different state: the clean screens on record ran on other settings than the CPU holds now.";
export const EVIDENCE_NOT_RECORDED = "Evidence is not usable: the clean screens on record did not note which state they ran on (state not recorded).";
const isFp = (x) => typeof x === "string" && x.length > 0;

/**
 * G-244 (QA-23): the evidence for accepting the state the CPU holds now, from a stress.list answer. Each stored run carries `state_fingerprint` (the words the accepted state checks);
 * the answer's own `state_fingerprint` is the state now. Only a clean, full-length screen with the SAME fingerprint is evidence. -> {text, note}: `text` = the newest matching run
 * ("" when none); `note` = why not ("" when there is evidence or no clean screen at all): a different state, or runs that did not record it (older than the fingerprint).
 */
export function evidenceOf(res) {
  const ok = res && res.ok && isObj(res.result);
  const runs = ok && Array.isArray(res.result.results) ? res.result.results.filter(isObj) : [];
  const clean = runs.filter((r) => r.health === "clean" && (r.errors ?? 0) === 0 && r.stopped_by === "time");
  if (!clean.length) return { text: "", note: "" };
  const now = isFp(res.result.state_fingerprint) ? res.result.state_fingerprint : null;
  const hit = now ? clean.find((r) => r.state_fingerprint === now) : null;
  if (hit) {
    const when = typeof hit.started === "string" ? fmtLocalDateTime(hit.started) : "";
    const mins = isNum(hit.elapsed_s) ? Math.round(hit.elapsed_s / 60) : null;
    return { text: `${when}${mins !== null ? ` · ${mins} min` : ""} · ${hit.kind || "cpu"} · clean, 0 errors`, note: "" };
  }
  return { text: "", note: clean.some((r) => isFp(r.state_fingerprint)) ? EVIDENCE_OTHER_STATE : EVIDENCE_NOT_RECORDED };
}

/** The newest clean quick screen that ran on the state now, as evidence text; "" when there is none (see evidenceOf for why). */
export const evidenceText = (res) => evidenceOf(res).text;

/** Windows (tools/win/Apply-Profile.ps1, param -From DIR): the saved-profile folder is the accepted-state folder the app keeps. */
export const ACCEPTED_DIR_LINUX = "/etc/linux-xtu/accepted";
export const WINDOWS_DIR = "%ProgramData%\\linux-xtu\\accepted";
/** The PowerShell line (run elevated from the repository folder); `-From` is the script's real parameter (a folder). The script's own default is the same folder. */
export const windowsCommand = (dir = "$env:ProgramData\\linux-xtu\\accepted") => `tools\\win\\Apply-Profile.ps1 -From "${dir}"`;
export const WINDOWS_STEPS = [
  "Record the fingerprint (below) from this boot’s read.",
  `Copy ${ACCEPTED_DIR_LINUX} (installed default) to ${WINDOWS_DIR} on Windows, plus the helper's allowlist file from /etc/linux-xtu (the script needs it; the README's Windows section names it).`,
  "In an elevated PowerShell, in the repository folder, run:",
];

/** A reason line from a hint entry whose label is the lead word (lib/hints.js S5 block: *.why). */
function hintWhy(key, extra = "") {
  const x = HINTS[key];
  return h("span", { class: "lx-why", dataset: { why: key } }, h("b", { text: x.label }), x.line + (extra ? " " + extra : ""));
}

// ---- the view ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function profilesView() {
  const disposers = [];
  let alive = false;
  return {
    id: "profiles",
    lx: true,
    mount(root, ctx) {
      alive = true;
      const { store, bridge } = ctx;
      const toast = ctx.toast || (() => {});
      ensureTune(store);
      ensureRt(store);
      const tc = createController({ store, bridge, toast }); // only for loadLast(): adopts this boot's read, so Load into Tune and Save work without visiting Tune first
      const S = {
        list: [], loaded: false, error: "", info: {}, seq: 0, selected: null, busy: false,
        save: null, // null | "edits" | "state"
        ask: null, // {name, d, evidence}
        notice: null, // {kind, title, text, actions}
        cmpA: null, cmpB: null, diff: null, diffSeq: 0,
        finger: null, // {kind, text}
      };
      const connected = () => store.get().link.state === "connected";
      const infoOf = (name) => (S.info[name] && !S.info[name].error ? S.info[name] : null);
      const acceptedEntries = () => S.list.filter((p) => p.source === "accepted");
      const can = () => connected() && !S.busy;

      // ---- header: the two saves (L2)
      const saveStateBtn = button({ level: 2, label: "Save CPU state as…", hint: "profile.state", attrs: { "data-pr": "save-state" }, onClick: () => openSave("state") });
      const saveEditsBtn = button({ level: 2, label: "Save Tune edits as…", hint: "profile.save", attrs: { "data-pr": "save-edits" }, onClick: () => openSave("edits") });
      ctx.head.set({ sub: "", end: [saveStateBtn, saveEditsBtn] });

      // ---- the save form (one at a time)
      const nameInput = h("input", { type: "text", class: "lx-text lx-mono lx-pr-name", maxlength: "64", autocomplete: "off", spellcheck: "false", placeholder: "profile-name", "aria-label": "Profile name", dataset: { pr: "name" } });
      const nameNote = h("span", { class: "lx-pr-note", dataset: { pr: "name-note" }, role: "status" });
      const saveGo = button({ level: 2, label: "Save", attrs: { "data-pr": "save" }, onClick: () => doSave() });
      const saveCancel = button({ level: 0, label: "Cancel", attrs: { "data-pr": "save-cancel" }, onClick: () => closeSave() });
      const saveP = panel({ title: "Save", id: "pr-save", body: h("div", { class: "lx-pr-saverow" }, h("label", { class: "lx-pr-lbl", text: "Name" }), nameInput, saveGo, saveCancel, nameNote) });
      saveP.el.hidden = true;
      saveP.el.dataset.pr = "save-panel";
      nameInput.addEventListener("input", () => renderSaveGate());
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void doSave();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeSave();
        }
      });

      // ---- accepted state
      const restoreBtn = button({ level: 2, label: "Restore accepted…", hint: "state.restore", attrs: { "data-pr": "restore" }, onClick: () => reviewIntent(store, { restore: "accepted" }, "Restore accepted") });
      const acceptReadBtn = button({ level: 2, label: "Set CPU state as accepted…", hint: "profile.accept", attrs: { "data-pr": "accept-read" }, onClick: () => askAccept(null) });
      const accP = panel({ title: "Accepted state", id: "pr-accepted", end: [restoreBtn, acceptReadBtn], body: null });
      accP.band.el.dataset.hint = "state.accepted";
      const accBody = accP.body;
      const noticeEl = h("div", { class: "lx-pr-notice", dataset: { pr: "notice" }, hidden: true });
      const askEl = h("div", { class: "lx-pr-ask", dataset: { pr: "ask" }, hidden: true, role: "group", "aria-label": "Set as accepted" });
      askEl.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && S.ask) {
          e.preventDefault();
          e.stopPropagation();
          S.ask = null;
          renderAsk();
          acceptReadBtn.focus();
        }
      });
      const fingerBtn = button({ level: 2, label: "Record fingerprint", cost: "0 req", hint: "profile.fingerprint", attrs: { "data-pr": "fingerprint" }, onClick: () => recordFingerprint() });
      const copyBtn = button({ level: 2, label: "Copy command", hint: "profile.copy", attrs: { "data-pr": "copy-cmd" }, onClick: () => copyCmd() });
      const fingerState = h("span", { class: "lx-pr-finger", dataset: { pr: "finger-state" }, role: "status" });
      const winQ = createQ("profile.windows");
      const winEl = h("div", { class: "lx-pr-win", dataset: { pr: "windows" } },
        h("div", { class: "lx-pr-win-h" }, h("span", { class: "lx-term", text: "Apply-Profile.ps1" }), winQ.button),
        winQ.more,
        h("ol", { class: "lx-pr-steps" }, ...WINDOWS_STEPS.map((t) => h("li", { text: t }))),
        h("pre", { class: "lx-box lx-mono lx-pr-cmd", dataset: { pr: "command" }, "aria-label": "Windows command", text: windowsCommand() }),
        h("div", { class: "lx-pr-act" }, fingerBtn, copyBtn, fingerState));

      // G-252: the Windows apply steps are a disclosure, closed by default (they matter once, when the accepted state is taken to Windows)
      const winDetails = h("details", { class: "lx-notes lx-pr-windetails", dataset: { pr: "windows-details" }, open: false }, h("summary", { text: "Apply on Windows" }), winEl);
      let bootNote = ""; // the feedback of the last "Enable boot restore…" click

      // ---- the library
      const listBody = h("tbody", { dataset: { pr: "list" } });
      const listTable = h("table", { class: "lx-tbl lx-tbl--fill lx-pr-list", "aria-label": "Profiles" },
        h("thead", {}, h("tr", {},
          h("th", { scope: "col", text: "Name" }), h("th", { scope: "col", text: "Tags" }), h("th", { scope: "col", class: "lx-wide", text: "Saved" }),
          h("th", { scope: "col", class: "lx-n" }, "Deepest", h("span", { class: "lx-hu", text: "mV" })), h("th", { scope: "col", text: "Turbo" }),
          h("th", { scope: "col", text: "Runtime" }))), listBody);
      const listFoot = h("div", { class: "lx-tfoot-note", dataset: { pr: "list-note" } });
      const listHolder = h("div", {});
      const listP = panel({ title: "Profiles", id: "pr-list", flush: true, body: listHolder });

      // ---- contents of the selected profile
      const loadBtn = button({ level: 2, label: "Load into Tune", hint: "profile.load", attrs: { "data-pr": "load" }, onClick: () => loadIntoTune(S.selected) });
      const reviewBtn = button({ level: 2, label: "Review…", hint: "profile.review", attrs: { "data-pr": "review" }, onClick: () => reviewIntent(store, { profile: S.selected }, "Apply profile " + S.selected) });
      const acceptBtn = button({ level: 2, label: "Set as accepted…", hint: "profile.accept", attrs: { "data-pr": "accept" }, onClick: () => askAccept(S.selected) });
      const contP = panel({ title: "Contents", id: "pr-contents", end: [loadBtn, reviewBtn, acceptBtn], scroll: true, flush: true, body: null });
      contP.band.el.dataset.hint = "profile.section";
      const contWhy = why(null, {}, { inline: true });

      // ---- compare
      const selA = h("select", { class: "lx-select", "aria-label": "First state", dataset: { pr: "compare-a" } });
      const selB = h("select", { class: "lx-select", "aria-label": "Second state", dataset: { pr: "compare-b" } });
      selA.addEventListener("change", () => { S.cmpA = selA.value; void runDiff(); });
      selB.addEventListener("change", () => { S.cmpB = selB.value; void runDiff(); });
      const cmpP = panel({ title: "Compare", id: "pr-compare", end: [selA, h("span", { class: "lx-pr-against", text: "against" }), selB], scroll: true, flush: true, body: null });
      cmpP.band.el.dataset.hint = "profile.compare";

      const grid = h("div", { class: "lx-tiles lx-pr" },
        saveP.el,
        accP.el,
        listP.el,
        h("div", { class: "lx-pr-split" }, contP.el, cmpP.el));
      root.append(grid);

      // ---- rendering
      function renderAll() {
        if (S.selected && S.selectedSource !== "accepted" && acceptedEntries().some((p) => p.name === S.selected && p.chain !== true)) S.selectedSource = "accepted"; // one row for both (QA-28)
        renderHead();
        renderAccepted();
        renderList();
        renderContents();
        renderCompareSelects();
      }

      function renderHead() {
        ctx.head.set({ sub: S.loaded && !S.error ? plural(listRows(S.list).length, "profile") : "" });
        saveStateBtn.disabled = !can();
        saveEditsBtn.disabled = !can();
      }

      function renderAccepted() {
        clear(accBody);
        const acc = acceptedEntries();
        const st = store.get();
        restoreBtn.hidden = acc.length !== 1;
        restoreBtn.disabled = !can();
        acceptReadBtn.disabled = !can();
        fingerBtn.disabled = !can() || acc.length !== 1;
        if (!connected()) accBody.append(why("locked.no_link", {}, { inline: true }));
        if (!S.loaded) {
          accP.setMeta(connected() ? "loading…" : "—");
        } else if (S.error) {
          accP.setMeta("unavailable"); // the helper's message belongs to the list's error box, not to an empty state
        } else if (!acc.length) {
          accP.setMeta("none");
          accBody.append(emptyState({ title: HINTS["profile.noaccepted"].label, teach: HINTS["profile.noaccepted"].line, id: "pr-noaccepted" }));
        } else if (acc.length > 1 || acc.some((p) => p.chain === true)) {
          accP.setMeta(`an older chain of ${acc.length} profiles`);
          accBody.append(box({ kind: "warn", title: "Restore accepted refuses an older chain", body: h("p", {}, "Run this once to make it one profile: ", h("code", { class: "lx-mono", text: ACCEPTED_MIGRATE_HINT })) }));
        } else {
          const p = acc[0];
          const info = infoOf(p.name);
          const k = kindOf(p, info);
          const a = st.accepted || {};
          const now = a.kind === "matches" ? "matches" : a.kind === "equivalent" ? "matches (equivalent)" : a.kind === "differs" ? `differs in ${plural(a.n, "unit")}` : "not compared yet (Read)";
          accP.setMeta([h("span", { class: "lx-mono", text: p.name }), " · ", k === "partial" ? "partial (legacy)" : k || "", " · CPU now: ", h("span", { dataset: { pr: "cpu-now", state: a.kind || "unknown" }, text: now })]);
          const sum = info ? summaryText(info.summary) : S.info[p.name] ? "contents unavailable" : "reading…";
          const boot = bootRestoreLine(st.preflight);
          accBody.append(h("div", { class: "lx-pr-accline" }, h("span", { class: "lx-pr-sum", text: sum }), h("span", { class: "lx-pr-hint", text: HINTS["state.restore"].line }),
            boot ? h("span", { class: "lx-pr-boot", dataset: { pr: "boot-restore", state: boot.state }, text: boot.text }) : null));
          if (boot && boot.cmd) {
            const bootBtn = button({ level: 2, label: "Enable boot restore…", hint: "profile.bootrestore", title: "Copies the command that turns boot restore on; you run it in a terminal (it needs sudo).", attrs: { "data-pr": "boot-enable" }, onClick: () => void copyBoot(boot.cmd) });
            accBody.append(h("div", { class: "lx-pr-act lx-pr-bootrow" }, bootBtn, h("span", { class: "lx-pr-hint", dataset: { pr: "boot-note" }, role: "status", text: bootNote })));
          }
          accBody.append(winDetails);
        }
        accBody.append(askEl, noticeEl);
      }

      function rowTags(p, info) {
        const isAcc = p.source === "accepted";
        const k = kindOf(p, info);
        const out = [tag(isAcc ? "accepted" : "saved", isAcc ? "ok" : "")];
        if (isAcc && p.twin) out.push(tag("saved"));
        if (k === "complete") out.push(tag("complete"));
        if (k === "partial") out.push(tag("partial (legacy)", "warn"));
        if (!isAcc && isPreviousAccepted(p.name)) out.push(tag("previous accepted"));
        return out;
      }

      function renderList() {
        clear(listHolder);
        clear(listBody);
        if (!S.loaded) {
          listP.setMeta(connected() ? "loading…" : "—");
          return;
        }
        if (S.error) {
          listP.setMeta("unavailable");
          listHolder.append(h("div", { class: "lx-panel-b" }, box({ kind: "warn", title: "Profiles unavailable", body: h("p", { text: S.error }) })));
          return;
        }
        const ordered = listRows(S.list);
        if (!ordered.length) {
          listP.setMeta("0");
          listHolder.append(emptyState({ title: HINTS["profile.empty"].label, teach: HINTS["profile.empty"].line, action: button({ level: 2, label: "Save CPU state as…", attrs: { "data-pr": "empty-save" }, onClick: () => openSave("state"), disabled: !can() }), id: "pr-empty" }));
          return;
        }
        listP.setMeta(`${plural(ordered.length, "entry", "entries")} · click a row for its contents`);
        listHolder.append(listTable, listFoot);
        listFoot.textContent = S.list.some((p) => p.source !== "accepted" && isPreviousAccepted(p.name)) ? "Previous accepted states are kept as profiles. The app has no delete yet: remove a file from the helper’s profiles directory by hand." : "Runtime = power limits, ratio caps and ring clock range the profile holds; “not captured” / “not in profile” = left as the CPU has it.";
        for (const p of ordered) {
          const info = infoOf(p.name);
          const cells = listCells(info);
          const key = p.source + ":" + p.name;
          const tr = h("tr", { class: "lx-click", tabindex: "0", "aria-selected": String(S.selected === p.name && (p.source === "accepted") === (S.selectedSource === "accepted")), dataset: { profile: p.name, source: p.source, key } },
            h("td", { class: "lx-k lx-mono", text: p.name }),
            h("td", { class: "lx-pr-tags" }, ...rowTags(p, info)),
            h("td", { class: "lx-wide lx-mono", text: fmtCreated(p.created).replace(" UTC", "") || NOT_APPLICABLE }),
            h("td", { class: "lx-n", text: info ? cells.deepest : S.info[p.name] ? "n/a" : "…" }),
            h("td", { class: "lx-mono", text: cells.turbo }),
            h("td", { class: info && /^not /.test(cells.runtime) ? "lx-pr-absent" : "", text: info ? cells.runtime : NOT_APPLICABLE }));
          const pick = () => select(p.name, p.source);
          tr.addEventListener("click", pick);
          tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pick();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const sib = e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
              if (sib) sib.focus();
            }
          });
          listBody.append(tr);
        }
      }

      function select(name, source) {
        S.selected = name;
        S.selectedSource = source;
        S.cmpA = refOf(S.list, name, source); // the accepted row and its saved twin are one state
        renderList();
        renderContents();
        renderCompareSelects();
        void runDiff();
        const tr = listBody.querySelector(`tr[data-key="${source}:${name}"]`);
        if (tr) tr.focus();
      }

      function renderContents() {
        const body = contP.body;
        clear(body);
        const name = S.selected;
        const entry = name ? S.list.find((p) => p.name === name) : null;
        const info = name ? infoOf(name) : null;
        const isAcc = S.selectedSource === "accepted";
        loadBtn.disabled = !info || !connected();
        reviewBtn.disabled = !name || !can();
        acceptBtn.hidden = isAcc || !name;
        acceptBtn.disabled = !name || !can();
        loadBtn.hidden = !name;
        reviewBtn.hidden = !name;
        if (!name || !entry) {
          contP.setMeta("no profile selected");
          body.append(h("p", { class: "lx-pr-pad lx-pr-hint", text: S.list.length ? "Pick a profile in the list above." : "Nothing to show yet." }));
          return;
        }
        contP.setMeta([h("span", { class: "lx-mono", text: name })]); // G-252: "accepted" is said once, by the tag in the list
        if (!info) {
          body.append(h("p", { class: "lx-pr-pad lx-pr-hint", text: S.info[name] ? "Contents unavailable: " + S.info[name].error : "Reading the contents…" }));
          return;
        }
        for (const sec of profileSections(info.contents)) {
          const head = h("div", { class: "lx-pr-sec-h" }, h("span", { class: "lx-band-t", text: sec.title }), sec.state === "absent" ? h("span", { class: "lx-pr-absent", dataset: { hint: "profile.absent" }, text: sec.note }) : null, sec.state === "unknown" ? h("span", { class: "lx-pr-hint", text: "shown as the helper sent it" }) : null);
          const secEl = h("section", { class: "lx-pr-sec", dataset: { section: sec.key, sectionState: sec.state } }, head);
          if (sec.kind === "units" && sec.rows.length) {
            const tb = h("tbody");
            for (const r of sec.rows) tb.append(h("tr", { dataset: { unit: r.unit } }, h("td", { class: "lx-k", text: r.unit }), sec.hasCurve ? h("td", { class: "lx-n", text: r.curve }) : null, h("td", { class: "lx-mono lx-pr-pts", text: r.points }), h("td", { class: "lx-n", text: r.ocRatio }), h("td", { class: "lx-n", text: r.ocV })));
            secEl.append(h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", "aria-label": sec.title },
              h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Unit" }), sec.hasCurve ? h("th", { scope: "col", class: "lx-n" }, "Whole curve", h("span", { class: "lx-hu", text: "mV" })) : null, h("th", { scope: "col", text: "Points" }), h("th", { scope: "col", class: "lx-n", text: "OC ×" }), h("th", { scope: "col", class: "lx-n", text: "OC V" }))), tb));
          } else if (sec.rows.length) {
            const dl = h("dl", { class: "lx-kv lx-pr-kv" });
            for (const [k, v, mono, tip] of sec.rows) dl.append(h("dt", { text: k }), h("dd", { class: mono ? "lx-mono" : "", text: v, title: tip || undefined }));
            secEl.append(dl);
          }
          body.append(secEl);
        }
        if (kindOf(entry, info) === "partial") body.append(h("p", { class: "lx-tfoot-note", text: "Partial (legacy): saved before profiles were complete. It holds only the rows that were changed; applying it lays them over what the CPU holds." }));
      }

      function renderCompareSelects() {
        const refs = compareRefs(S.list);
        const vals = refs.map((r) => r.value);
        const def = compareDefaults(S.list); // G-252: the accepted (or newest) profile against the CPU now, never a profile against itself; a click on a row compares that row
        if (S.loaded && !S.error) { // before the list has arrived there is nothing to default to ("CPU now" alone would stick)
          if (!vals.includes(S.cmpA)) S.cmpA = def.a;
          if (!vals.includes(S.cmpB) || S.cmpB === S.cmpA) S.cmpB = S.cmpA !== "read" ? "read" : vals.find((v) => v !== "read") || S.cmpA;
        }
        for (const [sel, v] of [[selA, S.cmpA], [selB, S.cmpB]]) {
          clear(sel);
          for (const r of refs) sel.append(h("option", { value: r.value, text: r.label }));
          sel.value = v;
          sel.disabled = !connected();
        }
        renderDiff();
      }

      function renderDiff() {
        const body = cmpP.body;
        clear(body);
        const d = S.diff;
        if (!connected()) {
          cmpP.setMeta("—");
          return;
        }
        if (!S.cmpA || !S.cmpB) {
          cmpP.setMeta("—");
          return;
        }
        if (S.cmpA === S.cmpB) {
          cmpP.setMeta("pick two different states");
          return;
        }
        if (!d || d.a !== S.cmpA || d.b !== S.cmpB) {
          cmpP.setMeta("comparing…");
          return;
        }
        if (d.error) {
          cmpP.setMeta("not compared");
          body.append(h("div", { class: "lx-panel-b" }, box({ kind: "warn", title: "The helper did not compare these", body: h("p", { text: d.error }) })));
          return;
        }
        cmpP.setMeta(d.rows.length ? `${plural(d.rows.length, "difference")} in ${plural(diffByUnit(d.rows).length, "unit")}` : "no differences in what was compared");
        if (d.rows.length) {
          const tb = h("tbody");
          for (const r of d.rows.slice(0, DIFF_MAX)) {
            const cell = (x) => h("td", { class: "lx-n", dataset: x === null ? { v: "none" } : {}, text: x === null ? NOT_APPLICABLE : r.fmt(x) });
            tb.append(h("tr", {}, h("td", { class: "lx-k", text: r.unit }), h("td", { text: r.label }), cell(r.a), cell(r.b), h("td", { class: "lx-n lx-delta", text: r.delta(r.a, r.b) })));
          }
          const lab = (v) => (compareRefs(S.list).find((x) => x.value === v) || { label: v }).label;
          body.append(h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--compact", "aria-label": "Differences", dataset: { pr: "diff" } },
            h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Unit" }), h("th", { scope: "col", text: "Setting" }), h("th", { scope: "col", class: "lx-n", text: lab(d.a) }), h("th", { scope: "col", class: "lx-n", text: lab(d.b) }), h("th", { scope: "col", class: "lx-n", text: "Δ" }))), tb));
        }
        const res = d.result || {};
        const notes = [];
        if (Array.isArray(res.compared)) notes.push("Compared: " + res.compared.join("; ") + ".");
        if (Array.isArray(res.not_compared) && res.not_compared.length) notes.push("Not compared: " + res.not_compared.map((x) => x.what + " (" + x.why + ")").join("; ") + ".");
        if (d.rows.length > DIFF_MAX) notes.push(`${d.rows.length - DIFF_MAX} more not listed.`);
        if (notes.length) body.append(h("div", { class: "lx-tfoot-note", dataset: { pr: "diff-note" }, text: notes.join(" ") }));
      }

      function setNotice(next) {
        S.notice = next;
        clear(noticeEl);
        noticeEl.hidden = !next;
        if (!next) return;
        const acts = (next.actions || []).map((a) => button({ level: 2, label: a.label, attrs: { "data-pr": a.id }, onClick: () => { void a.run(); } }));
        acts.push(button({ level: 0, label: "Dismiss", attrs: { "data-pr": "notice-close" }, onClick: () => setNotice(null) }));
        noticeEl.append(box({ kind: next.kind || "", title: next.title, body: [h("p", { text: next.text || "" }), h("div", { class: "lx-pr-act" }, ...acts)] }));
      }
      const readFirst = (what) => setNotice({ kind: "warn", title: READ_FIRST_TEXT, text: what, actions: [{ id: "open-tune", label: "Open Tune", run: () => ctx.goto("tune") }] });

      // ---- save
      function openSave(mode) {
        if (!can()) return;
        S.save = mode;
        saveP.el.hidden = false;
        saveP.band.el.querySelector(".lx-band-t").textContent = mode === "state" ? "Save CPU state as" : "Save Tune edits as";
        saveP.el.dataset.mode = mode;
        renderSaveGate();
        nameInput.focus();
      }
      function closeSave() {
        const was = S.save;
        S.save = null;
        saveP.el.hidden = true;
        nameInput.value = "";
        if (saveStateBtn.isConnected) (was === "state" ? saveStateBtn : saveEditsBtn).focus();
      }
      function currentGate() {
        const taken = S.list.map((p) => p.name);
        if (S.save === "state") return stateNameGate({ name: nameInput.value, taken });
        const t = store.get().tune;
        return saveGate({ name: nameInput.value, taken, model: t && t.model, draft: t ? t.draft : draftLib.emptyDraft(), rt: store.get().rt || null });
      }
      function renderSaveGate() {
        if (!S.save) return null;
        const gate = currentGate();
        nameNote.textContent = gate.note;
        nameNote.dataset.ok = String(gate.ok);
        saveGo.disabled = !gate.ok || !can();
        return gate;
      }
      async function doSave() {
        const gate = renderSaveGate();
        if (!gate || !gate.ok || !can()) return;
        const name = nameInput.value;
        const mode = S.save;
        S.busy = true;
        setBusy(saveGo, "Saving…");
        const args = mode === "state" ? { name, from: "read" } : { name, intent: gate.intent, ...gate.extra };
        const r = await bridge.call("profiles.save", args);
        if (!alive) return;
        S.busy = false;
        setBusy(saveGo, null);
        setButton(saveGo, { label: "Save" });
        if (r.ok) {
          const nc = notCapturedText(r.result);
          if (!nc) toast("ok", `Saved "${name}". ${mode === "state" ? "It is not the accepted state." : "Nothing was written to the CPU."}`); // one announcement: the toast, or the notice when it has more to say
          setNotice(nc ? { kind: "", title: `Saved “${name}”`, text: nc } : null);
          closeSave();
          await reload();
          select(name, "saved");
          return;
        }
        if (readRefusal(r.error)) readFirst("A saved profile is what the CPU holds now, so it needs a current read. " + errText(r.error));
        else {
          const exists = isObj(r.error) && isObj(r.error.detail) && r.error.detail.check === "EXISTS";
          setNotice({ kind: "fault", title: "Not saved", text: exists ? `A profile named "${name}" already exists. Pick another name.` : errText(r.error) });
          if (exists) await reload();
        }
        renderSaveGate();
      }

      // ---- data
      async function loadInfo() {
        const seq = ++S.seq;
        const todo = S.list.map((p) => p.name).filter((n) => !S.info[n]).slice(0, INFO_MAX);
        for (let i = 0; i < todo.length; i += INFO_BATCH) {
          await Promise.all(todo.slice(i, i + INFO_BATCH).map(async (name) => {
            const r = await bridge.call("profiles.get", { name });
            S.info[name] = r.ok && isObj(r.result) && isObj(r.result.contents) && Array.isArray(r.result.contents.rows) ? r.result : { error: errText(r.error) };
          }));
          if (seq !== S.seq || !alive) return;
          renderAll();
        }
      }
      async function reload(dropInfo = false) {
        if (!connected()) return renderAll();
        if (dropInfo) S.info = {};
        const r = await bridge.call("profiles.list");
        if (!alive) return;
        S.loaded = true;
        S.error = "";
        if (r.ok && isObj(r.result) && Array.isArray(r.result.profiles)) {
          S.list = r.result.profiles.filter((p) => isObj(p) && typeof p.name === "string");
        } else {
          S.list = [];
          S.error = errText(r.error);
        }
        if (!S.selected || !S.list.some((p) => p.name === S.selected)) {
          const first = savedOrder(S.list).find((p) => p.source !== "accepted") || S.list[0];
          S.selected = first ? first.name : null;
          S.selectedSource = first ? first.source : null;
        }
        renderAll();
        void runDiff();
        flushAsk();
        await loadInfo();
      }
      async function runDiff() {
        if (!connected() || !S.cmpA || !S.cmpB || S.cmpA === S.cmpB) return renderDiff();
        const mine = ++S.diffSeq;
        const a = S.cmpA;
        const b = S.cmpB;
        renderDiff();
        const r = await bridge.call("profiles.diff", { a, b });
        if (!alive || mine !== S.diffSeq) return;
        S.diff = r.ok && isObj(r.result) && Array.isArray(r.result.rows) ? { a, b, rows: helperDiffRows(r.result), result: r.result } : { a, b, error: errText(r.error) };
        renderDiff();
      }
      async function refreshAcceptedChip() {
        const last = await bridge.call("tune.last");
        if (last.ok && last.result && last.result.available && last.result.result) {
          setLastRead(store, new Date(last.result.at * 1000).toISOString(), last.result.result.accepted_match ?? null, last.result.result.accepted_note || "");
        }
      }

      // ---- Load into Tune
      function editsInTune() {
        const t = store.get().tune;
        const n = t && t.model ? draftLib.diff(t.model, t.draft).total : 0;
        return n + pendingCounts(store.get().rt).total;
      }
      function doLoad(name) {
        const t = store.get().tune;
        const info = infoOf(name);
        if (!t.model || !info) return;
        const r = draftFromContents(t.model, info.contents);
        patchTune(store, { draft: r.draft });
        editRt(store, () => ({ ...emptyEdits(), ...r.rtEdits }));
        const d = draftLib.diff(t.model, r.draft);
        const rtN = pendingCounts(store.get().rt).total;
        const n = d.total + rtN;
        const extra = (r.skipped.length ? " Not loaded (the read has no such thing): " + r.skipped.join(", ") + "." : "") + (r.clamped.length ? " Moved or refused by the editor’s limits: " + r.clamped.join(", ") + "." : "");
        toast(r.skipped.length || r.clamped.length ? "warn" : "info", `Loaded "${name}" into Tune: ${n ? plural(n, "edit") + " against the CPU now" : "the CPU already holds these values"}.${extra} Nothing is written before Review and Apply.`);
        ctx.goto("tune");
      }
      async function loadIntoTune(name) {
        if (!name || !infoOf(name)) return;
        if (!store.get().tune.model && connected()) await tc.loadLast();
        if (!alive) return;
        if (!store.get().tune.model) return readFirst("Tune shows each value against what the CPU holds now, so it needs a read first.");
        const n = editsInTune();
        if (n > 0) {
          confirmInPlace(loadBtn, { text: `Replace ${plural(n, "edit")} in Tune?`, confirmLabel: "Replace", keepLabel: "Keep", label: "Replace the edits in Tune", onConfirm: () => doLoad(name) });
          return;
        }
        doLoad(name);
      }

      // ---- accept
      async function acceptDiff(name) {
        const acc = acceptedEntries();
        if (acc.length !== 1) return { rows: null, chain: acc.length > 1 };
        const r = await bridge.call("profiles.diff", { a: "accepted", b: name === null ? "read" : name });
        if (r.ok && isObj(r.result) && Array.isArray(r.result.rows)) return { rows: helperDiffRows(r.result), result: r.result };
        return readRefusal(r.error) ? { error: READ_FIRST_TEXT, read: errText(r.error) } : { error: errText(r.error) };
      }
      async function askAccept(name) {
        if (!can()) return;
        setNotice(null);
        S.busy = true;
        renderAll();
        const [d, ev] = await Promise.all([acceptDiff(name), bridge.call("stress.list", {})]);
        if (!alive) return;
        S.busy = false;
        if (d.error === READ_FIRST_TEXT) {
          renderAll();
          return readFirst(d.read);
        }
        const evd = evidenceOf(ev);
        S.ask = { name, d, evidence: evd.text, evidenceNote: evd.note };
        renderAll();
        renderAsk();
      }
      function renderAsk() {
        clear(askEl);
        askEl.hidden = !S.ask;
        if (!S.ask) return;
        const { name, d, evidence, evidenceNote } = S.ask;
        const replaced = acceptedEntries().map((p) => p.name);
        const what = name === null ? "The CPU state of the last read" : `“${name}”`;
        const askTitle = name === null ? "Set the CPU state of the last read as accepted?" : `Set ${what} as accepted?`;
        const yes = button({ level: 2, label: name === null ? "Accept CPU state" : `Accept ${name}`, attrs: { "data-pr": "ask-yes" }, onClick: () => { const n = S.ask.name; S.ask = null; renderAsk(); void acceptState(n); } });
        const no = button({ level: 0, label: "Keep", attrs: { "data-pr": "ask-no" }, onClick: () => { S.ask = null; renderAsk(); acceptReadBtn.focus(); } });
        const diffLine = d.error ? `The comparison is unavailable (${d.error}).` : d.rows === null ? (d.chain ? "The current accepted state is an older chain; the helper refuses to replace it until it is one profile." : "There is no accepted state to compare with.") : diffSummary(d.rows, d.result);
        const evLine = h("p", { dataset: { pr: "evidence", hint: "profile.evidence" } }, h("b", { text: "Evidence " }), evidence || (evidenceNote ? evidenceNote + " Accept only after a long, clean stress run of this state." : "No clean quick screen on record. Accept only after a long, clean stress run of this state."));
        const parts = [h("p", { text: acceptConfirmText(what, replaced) }), h("p", { text: diffLine }), evLine, h("p", { text: replaced.length > 1 ? "" : previousKeptText(replaced) })];
        if (d.rows && d.rows.length) {
          const tb = h("tbody");
          for (const r of d.rows.slice(0, 12)) tb.append(h("tr", {}, h("td", { class: "lx-k", text: r.unit }), h("td", { text: r.label }), h("td", { class: "lx-n", text: r.a === null ? NOT_APPLICABLE : r.fmt(r.a) }), h("td", { class: "lx-n", text: r.b === null ? NOT_APPLICABLE : r.fmt(r.b) })));
          parts.push(h("table", { class: "lx-tbl lx-tbl--compact", "aria-label": "Accepted now against the new state" }, h("thead", {}, h("tr", {}, ...["Unit", "Setting", "Accepted now", "New"].map((t, i) => h("th", { scope: "col", class: i > 1 ? "lx-n" : "", text: t })))), tb));
        }
        parts.push(h("div", { class: "lx-pr-act" }, yes, no));
        askEl.append(box({ kind: evidence ? "" : "warn", title: askTitle, body: parts }));
        no.focus();
      }
      async function acceptState(name, setAside = false) {
        if (!can()) return;
        S.busy = true;
        renderAll();
        setNotice(null);
        const r = await bridge.call("profiles.accept", { ...(name === null ? { from: "read" } : { name }), ...(setAside ? { set_aside_unreadable: true } : {}) });
        if (!alive) return;
        S.busy = false;
        const out = acceptOutcome(r);
        if (out.kind === "declined") {
          setNotice({ kind: "", title: "Not accepted", text: errText(out.error) });
          renderAll();
          return;
        }
        if (out.kind === "confirm") {
          noticeEl.hidden = false;
          clear(noticeEl).append(box({ kind: "warn", title: "Not accepted", body: [hintWhy("profile.confirm.why"), h("div", { class: "lx-pr-act" }, button({ level: 0, label: "Dismiss", attrs: { "data-pr": "notice-close" }, onClick: () => setNotice(null) }))] }));
          noticeEl.dataset.state = "confirm";
          renderAll();
          return;
        }
        if (out.kind === "accepted") {
          const res = out.result;
          const prev = typeof res.previous_saved_as === "string" ? res.previous_saved_as : null;
          const aside = typeof res.set_aside_as === "string" ? ` The unreadable accepted state was moved, whole, to ${res.set_aside_as} (nothing was deleted).` : "";
          const nc = notCapturedText(res); // G-244 (QA-27): the inline box is the one confirmation (it carries Undo); no toast on top of it
          setNotice({ kind: "ok", title: `Accepted “${res.name}”`, text: (prev ? `The previous accepted state is kept as ${prev}; Undo accepts it again while the CPU still holds it.` : "Nothing was replaced.") + aside + (nc ? " " + nc : ""), actions: prev ? [{ id: "undo", label: "Undo", run: () => undoAccept(prev) }] : [] });
          await reload(true);
          await refreshAcceptedChip();
          return;
        }
        const read = readRefusal(out.error);
        if (read) readFirst(errText(out.error));
        else if (unreadableRefusal(out.error)) setNotice({ kind: "warn", title: "Not accepted", text: errText(out.error), actions: [{ id: "aside", label: "Move it aside and accept", run: () => acceptState(name, true) }] });
        else setNotice({ kind: "fault", title: "Not accepted", text: errText(out.error) });
        renderAll();
      }
      async function undoAccept(prev) {
        if (!can()) return;
        S.busy = true;
        renderAll();
        const r = await bridge.call("profiles.accept", { name: prev });
        if (!alive) return;
        S.busy = false;
        const out = acceptOutcome(r);
        if (out.kind === "accepted") {
          setNotice({ kind: "ok", title: `Accepted “${prev}” again`, text: out.result.previous_saved_as ? `The state it replaced is saved as ${out.result.previous_saved_as}.` : "" });
          await reload(true);
          await refreshAcceptedChip();
          return;
        }
        if (out.kind === "confirm") setNotice({ kind: "warn", title: "Not accepted", text: HINTS["profile.confirm.why"].line });
        else if (out.kind === "declined") setNotice({ kind: "", title: "Not accepted", text: errText(out.error) });
        else if (isObj(out.error) && isObj(out.error.detail) && out.error.detail.check === "NOT_APPLIED") setNotice({ kind: "warn", title: "Not accepted", text: errText(out.error), actions: [{ id: "undo-review", label: "Review…", run: () => reviewIntent(store, { profile: prev }, "Apply profile " + prev) }] });
        else if (readRefusal(out.error)) readFirst(errText(out.error));
        else setNotice({ kind: "fault", title: "Not accepted", text: errText(out.error) });
        renderAll();
      }

      // ---- Windows
      async function recordFingerprint() {
        if (!can()) return;
        S.busy = true;
        setBusy(fingerBtn, "Recording…");
        const r = await bridge.call("profiles.fingerprint");
        if (!alive) return;
        S.busy = false;
        setBusy(fingerBtn, null);
        setButton(fingerBtn, { label: "Record fingerprint" });
        if (r.ok && isObj(r.result)) {
          const complete = String(r.result.fingerprint) === "complete";
          S.finger = { kind: complete ? "ok" : "warn", text: complete ? `Fingerprint recorded ${fmtClock(r.result.recorded)} (${r.result.cpus} CPUs). Copy the folder now.` : `Recorded, but ${r.result.fingerprint}: the Windows script will refuse it.` };
        } else if (acceptOutcome(r).kind === "declined") {
          S.finger = { kind: "", text: "Not recorded: " + errText(r.error) };
        } else {
          S.finger = { kind: "fault", text: "Not recorded: " + errText(r.error) };
          if (readRefusal(r.error)) readFirst(errText(r.error));
        }
        fingerState.textContent = S.finger.text;
        fingerState.dataset.kind = S.finger.kind;
        renderAccepted();
      }
      async function copyBoot(cmd) {
        const res = await copyText(cmd);
        if (!alive) return;
        bootNote = res === "copied" ? "Command copied. Run it in a terminal; it asks for your password (sudo)." : "Could not copy the command.";
        const note = accBody.querySelector("[data-pr=boot-note]");
        if (note) note.textContent = bootNote;
      }
      async function copyCmd() {
        const res = await copyText(windowsCommand());
        if (!alive) return;
        copyBtn.dataset.copy = res;
        fingerState.textContent = res === "copied" ? "Command copied." : "Could not copy: select the command and press Ctrl+C.";
        fingerState.dataset.kind = res === "copied" ? "" : "warn";
      }

      // ---- the commit sheet's "Set as accepted…" (R-S3, views/tune/apply.js): store.events "profiles:accept" {from: "read"} | {name}; it switches to this screen first.
      // The accept step runs here (the helper's diff, the evidence, then profiles.accept through the shell's dialog); a detail that reports a done accept only refreshes.
      let pendingAsk = null;
      const onAcceptEvent = (e) => {
        const d = isObj(e.detail) ? e.detail : {};
        if (d.accepted === true || isObj(d.result)) {
          void reload(true).then(() => refreshAcceptedChip());
          return;
        }
        const name = d.from === "read" || typeof d.name !== "string" ? null : d.name;
        if (!S.loaded) pendingAsk = { name };
        else void askAccept(name);
      };
      store.events.addEventListener("profiles:accept", onAcceptEvent);
      disposers.push(() => store.events.removeEventListener("profiles:accept", onAcceptEvent));
      const flushAsk = () => {
        if (!pendingAsk || !S.loaded || !alive) return;
        const { name } = pendingAsk;
        pendingAsk = null;
        void askAccept(name);
      };

      // ---- wiring
      renderAll();
      disposers.push(
        store.watch((s) => s.link.state, (state) => {
          if (state === "connected") {
            if (!S.loaded) void reload();
            if (!store.get().tune.model && store.get().tune.read.state === "idle") void tc.loadLast(); // this boot's read, if the helper has one (read-only)
          } else renderAll();
        }),
        store.watch((s) => s.accepted, () => renderAccepted()),
        store.watch((s) => s.preflight, () => renderAccepted()),
        store.watch((s) => s.tune.model, () => renderSaveGate()),
        store.watch((s) => s.tune.draft, () => renderSaveGate()),
        store.watch((s) => s.rt, () => renderSaveGate()),
      );
    },
    unmount() {
      alive = false;
      for (const d of disposers.splice(0)) d();
    },
  };
}
