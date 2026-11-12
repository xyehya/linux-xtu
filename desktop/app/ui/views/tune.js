// views/tune.js: the Tune screen (desktop/DESIGN.md §8.1, §9.2–§9.5): the tab list Cores · Frequency · Power · Ring & uncore in the frame's work header, the
// Cores tab (unit table + inspector: views/tune/grid.js, inspector.js, curve-editor.js, oc.js) and the module tabs, the Tune slice of the store and its controller.
//
// State lives in the app store, slice `tune`, so the draft survives leaving the screen and the pending row / the commit sheet / other tabs all see the same thing:
//   { model (lib/units.js, or null before the first read), draft (lib/draft.js), selection [unit ids, never empty once read], anchor, subtab,
//     read {state idle|reading|ready|error, step, of, startedAt, durationMs, ops, at, error, fromLast},
//     base {state none|loading|ready, kind "stock" (a marked stock baseline) | "derived" (factory V = a measured curve minus the offsets it was measured with, G-250) | "",
//           fn (unitId, ratio) -> {v, src, ...} | null, name, id, marked (the library's baseline), units (derived per-point results), reason}, reviewSeq }
// Every change of `model` or `draft` re-counts the pending row (store.pending = {changes, units} from lib/draft.js diff()). A new model with no draft given re-diffs the
// kept draft against it (lib/draft.js rebaseDraft: edits the CPU now holds, or that no longer apply, are dropped); the top bar's Read drops the edits, as its confirm says.
//
// TAB CONTRACT (shared with the Frequency / Power / Ring & uncore builders): a tab module exports `mount(el, ctx)` and `unmount()`, and may export `lx = true` when it is
// built in the new design (the work body then drops the legacy padding). ctx =
//   { store, bridge, toast, goto,
//     draft:  { get() -> draft, set(next), edit((model, draft) -> next draft), discard(), lib (lib/draft.js) },
//     units:  lib/units.js,   limits: lib/limits.js,
//     model:  the units model at mount time (null before the first read; the tab is remounted when a new read replaces it), getModel() for the live value,
//     tune:   the controller (state(), setSelection(), setSubtab(), readCpu(), ...) }
// Tab ids are kept from before the redesign so deep links, Tips (GOTO_TAB) and the context line (app.js TAB_SCREEN) keep working: "turbo" is the Frequency tab.
//
// app.js integration: `VIEWS.tune = tuneView`; the pending row's Discard calls `discardDraft(store)` and Review calls `requestReview(store)`, which bumps `tune.reviewSeq`
// and dispatches "tune:review" ({detail: {changes, units}}) on `store.events`; the commit sheet (views/tune/apply.js) listens to it.
import { h, clear } from "../components/dom.js";
import { setPending, setLastRead, pushToast } from "../store.js";
import * as unitsLib from "../lib/units.js";
import * as draftLib from "../lib/draft.js";
import * as limitsLib from "../lib/limits.js";
import { deriveFromRecord, derivable } from "../lib/factory.js";
import { fmtMvNum } from "../lib/format.js";
import { pendingCounts, discardRt, powerCurrent, capRows, uncoreState } from "../lib/rtstate.js";
import { emptyState } from "../components/panel.js";
import { button } from "../components/buttons.js";
import { tag } from "../components/ann.js";
import { EMPTY } from "../lib/hints.js";
import { requestReview as requestRuntimeReview } from "./tune/runtime-kinds.js";
import { createUnitPane } from "./tune/grid.js";
import { createInspector } from "./tune/inspector.js";

/** The Tune tabs (DESIGN.md §8.1). "turbo" is the id of Frequency (turbo tables + ratio caps), kept for deep links, Tips and the context line. */
export const SUBTABS = [
  { id: "cores", label: "Cores" },
  { id: "turbo", label: "Frequency" },
  { id: "power", label: "Power" },
  { id: "ring", label: "Ring & uncore" },
];
/** Old tab ids that now live in another tab. */
export const SUBTAB_ALIASES = { ratios: "turbo", frequency: "turbo", uncore: "ring" };
export const tabId = (id) => (SUBTABS.some((t) => t.id === id) ? id : SUBTAB_ALIASES[id] || "cores");
/**
 * The tabs that are modules (`mount(el, ctx)` / `unmount()`): one or more parts stacked in the tab, each saying whether it needs a tune.read first (the runtime
 * parts read power.read / runtime.read themselves, G-217).
 * Frequency = ./tune/frequency.js (R-S2): turbo tables and ratio caps in one view.
 */
export const SUBTAB_MODULES = {
  turbo: [{ path: "./tune/frequency.js", needsRead: true }],
  power: [{ path: "./tune/power.js", needsRead: false }],
  ring: [{ path: "./tune/ring.js", needsRead: false }],
};
export const NO_BASELINE_REASON = "no baseline curve (Curves → Measure)";
/** What clears each tab's values (DESIGN.md §5.5 persistence tags); Frequency mixes mailbox, MSR and runtime values, so its tags sit per column (null here). */
export const PERSIST = { cores: "Lost at cold boot", turbo: null, power: "Runtime \u00b7 reboot clears", ring: "Runtime \u00b7 reboot clears" };

// ---- the store slice ----------------------------------------------------------------------------------------------------------------------
export const initialTune = () => ({
  model: null,
  draft: draftLib.emptyDraft(),
  selection: [],
  anchor: null,
  subtab: "cores",
  read: { state: "idle", step: 0, of: 0, startedAt: null, durationMs: null, ops: null, at: null, error: null, fromLast: false },
  base: { state: "none", kind: "", fn: null, name: "", id: null, marked: false, units: null, reason: "baseline not loaded yet" },
  reviewSeq: 0,
});

const watched = new WeakSet();

export function ensureTune(store) {
  if (!store.events) store.events = new EventTarget(); // the "tune:review" channel (see requestReview)
  if (!store.get().tune) store.set({ tune: initialTune() });
  if (!watched.has(store) && typeof store.watch === "function") {
    watched.add(store);
    store.watch((s) => s.rt, () => syncPending(store)); // the runtime edits (power, ratio caps, uncore) are part of the same pending bar
  }
  return store.get().tune;
}

/**
 * Write the pending bar: the V/F + turbo + ring draft counts {changes, units} plus the pending runtime edits (power / ratio caps / uncore, lib/rtstate.js; the runtime tabs show
 * "N runtime, M V/F" with M = pending.changes - pendingCounts(rt).total).
 */
export function setPendingAll(store, changes, units) {
  const rt = store.get().rt;
  const c = rt ? pendingCounts(rt) : { power: 0, caps: 0, uncore: 0, total: 0 };
  const t = store.get().tune;
  setPending(store, changes + c.total, units + (c.power ? 1 : 0) + c.caps + (c.uncore ? 1 : 0), pendingItems(t && t.model, t && t.draft, rt));
}

/** Re-count the pending bar from the slice: {changes, units} of diff(model, draft), plus the runtime edits. */
export function syncPending(store) {
  const t = store.get().tune;
  if (!t || !t.model) return setPendingAll(store, 0, 0);
  const d = draftLib.diff(t.model, t.draft);
  return setPendingAll(store, d.total, d.unitCount);
}

const vText = (v) => (Number.isFinite(v) ? v.toFixed(3) : "\u2014");
const ratioText = (r) => (Number.isFinite(r) && r > 0 ? String(r) : "none");

/**
 * The pending row's list: the edits in display order, each {unit, what, from, to, u} with display strings ("P0" "pt4 48×" "0" "−20" "mV").
 * V/F / OC / turbo from diff(model, draft), then power, ratio caps and uncore from the runtime slice (values equal to the read are not edits).
 */
export function pendingItems(model, draft, rt) {
  const out = [];
  if (model && draft) {
    for (const it of draftLib.diff(model, draft).items) {
      if (it.field === "bucket") {
        out.push({ unit: `Turbo ${it.unit.slice(6)}`, what: `${it.key + 1} busy`, from: String(it.from), to: String(it.to), u: "\u00d7" });
        continue;
      }
      const unit = model.units[it.unit];
      const who = unit && unit.kind === "R" ? "Ring" : it.unit;
      if (it.field === "point") {
        const pt = unitsLib.pointAt(unit, it.key);
        out.push({ unit: who, what: `pt${pt ? pt.point : "?"} ${it.key}\u00d7`, from: fmtMvNum(it.from), to: fmtMvNum(unitsLib.snapOffsetMv(it.to)), u: "mV" }); // QA-04 (G-248): "to" is the step the CPU will hold, as the editor shows it
      } else if (it.field === "ring-point") out.push({ unit: who, what: `pt${it.key}`, from: fmtMvNum(it.from), to: fmtMvNum(unitsLib.snapOffsetMv(it.to)), u: "mV" });
      else if (it.field === "curve") out.push({ unit: who, what: "whole curve", from: Number.isFinite(it.from) ? fmtMvNum(it.from) : null, to: fmtMvNum(unitsLib.snapOffsetMv(it.to)), u: "mV" });
      else if (it.field === "ratio") out.push({ unit: who, what: "OC ratio", from: ratioText(it.from), to: ratioText(it.to), u: "\u00d7" });
      else if (it.field === "vt") out.push({ unit: who, what: "OC voltage", from: vText(it.from), to: vText(it.to), u: "V" });
    }
  }
  if (rt && rt.edits) {
    const cur = powerCurrent(rt.power && rt.power.result) || {};
    const P = [["pl1_w", "PL1", "W"], ["pl2_w", "PL2", "W"], ["tau_s", "tau", "s"]];
    for (const [k, what, u] of P) {
      const v = rt.edits.power ? rt.edits.power[k] : undefined;
      if (Number.isFinite(v) && v !== cur[k]) out.push({ unit: "Power", what, from: Number.isFinite(cur[k]) ? String(cur[k]) : null, to: String(v), u });
    }
    const caps = capRows(rt.runtime && rt.runtime.result);
    for (const [unit, ratio] of Object.entries(rt.edits.caps || {})) {
      const g = caps.find((r) => r.unit === unit);
      if (g && g.capRatio === ratio && !g.mixedCap) continue;
      out.push({ unit, what: "cap", from: g && Number.isFinite(g.capRatio) ? String(g.capRatio) : null, to: String(ratio), u: "\u00d7" });
    }
    const un = uncoreState(rt.runtime && rt.runtime.result);
    for (const [k, what] of [["min_ratio", "ring min"], ["max_ratio", "ring max"]]) {
      const v = rt.edits.uncore ? rt.edits.uncore[k] : undefined;
      const now = un ? (k === "min_ratio" ? un.min : un.max) : null;
      if (Number.isFinite(v) && v !== now) out.push({ unit: "Uncore", what, from: Number.isFinite(now) ? String(now) : null, to: String(v), u: "\u00d7" });
    }
  }
  return out;
}

/** How many V/F + turbo edits a Read would drop (the runtime edits survive a Read). */
export function draftEdits(store) {
  const t = store.get().tune;
  return t && t.model ? draftLib.diff(t.model, t.draft).total : 0;
}

/** Which Tune tabs hold edits (the work header's marks): V/F, OC and ring offsets -> Cores; turbo buckets and ratio caps -> Frequency; power; uncore -> Ring & uncore. */
export function tabEdits(st) {
  const t = st.tune;
  const out = { cores: false, turbo: false, power: false, ring: false };
  if (t && t.model) {
    for (const it of draftLib.diff(t.model, t.draft).items) {
      if (it.field === "bucket") out.turbo = true;
      else out.cores = true;
    }
  }
  const e = st.rt && st.rt.edits;
  if (e) {
    const c = pendingCounts(st.rt);
    out.power = c.power > 0;
    out.turbo = out.turbo || c.caps > 0;
    out.ring = c.uncore > 0;
  }
  return out;
}

const hasRuntimeEdits = (rt) => !!rt && ["power", "caps", "uncore"].some((k) => rt.edits && Object.keys(rt.edits[k] || {}).length > 0);

/**
 * Patch the Tune slice. A new model without a draft re-diffs the kept draft against it (lib/draft.js rebaseDraft): after an apply refresh or a re-read the edits the CPU
 * now holds, and those on units / points the new read lacks, leave the draft; the rest stay edits. `subtab` takes the old ids (ratios -> Frequency).
 */
export function patchTune(store, patch) {
  ensureTune(store);
  store.update((s) => {
    const next = { ...s.tune, ...patch };
    if ("subtab" in patch) next.subtab = tabId(patch.subtab);
    if ("model" in patch && !("draft" in patch) && patch.model && patch.model !== s.tune.model && !draftLib.isEmpty(s.tune.draft)) next.draft = draftLib.rebaseDraft(patch.model, s.tune.draft).draft;
    return { tune: next };
  });
  if ("draft" in patch || "model" in patch) syncPending(store);
}

export function discardDraft(store) {
  ensureTune(store);
  if (hasRuntimeEdits(store.get().rt)) discardRt(store);
  patchTune(store, { draft: draftLib.emptyDraft() });
}

/**
 * The pending bar's "Review & Apply": counts a request in the slice and fires "tune:review" on store.events. With pending runtime edits (power, ratio caps, uncore) one drawer covers
 * everything: the V/F + turbo + ring draft first, then power, then the caps / uncore (views/tune/runtime-kinds.js builds those requests).
 */
export function requestReview(store) {
  const t = ensureTune(store);
  if (hasRuntimeEdits(store.get().rt)) {
    patchTune(store, { reviewSeq: t.reviewSeq + 1 });
    return requestRuntimeReview(store);
  }
  const d = t.model ? draftLib.diff(t.model, t.draft) : { total: 0, unitCount: 0 };
  patchTune(store, { reviewSeq: t.reviewSeq + 1 });
  store.events.dispatchEvent(new CustomEvent("tune:review", { detail: { changes: d.total, units: d.unitCount } }));
}

// ---- the baseline curve -> predict.js `base` ---------------------------------------------------------------------------------------------------
/**
 * A stored curve record (curves.get) -> `(unitId, ratio) => {v, src} | null` for lib/predict.js. A measured point (status ok) gives its VID; an interpolated one is marked so;
 * a ratio between two measured points is the straight line between them (web/app.js:2783, G-133); nothing is extrapolated. null = no voltage known (the predictor falls back to
 * the fused top point only at the top ratio).
 */
export function baselineFromRecord(rec) {
  const pointsOf = (unitId) => {
    const u = rec && rec.units && typeof rec.units === "object" ? rec.units[unitId] : null;
    return u && Array.isArray(u.points) ? u.points.filter((p) => p && Number.isFinite(p.ratio) && Number.isFinite(p.vid_v) && (p.status === "ok" || p.status === "interpolated")) : [];
  };
  return (unitId, ratio) => {
    const ps = pointsOf(unitId);
    const exact = ps.find((p) => p.ratio === ratio);
    if (exact) return { v: exact.vid_v, src: exact.status === "interpolated" ? "interpolated" : "baseline" };
    const ok = ps.filter((p) => p.status === "ok");
    const lo = ok.filter((p) => p.ratio < ratio).sort((a, b) => b.ratio - a.ratio)[0];
    const hi = ok.filter((p) => p.ratio > ratio).sort((a, b) => a.ratio - b.ratio)[0];
    if (!lo || !hi) return null;
    const v = lo.vid_v + ((hi.vid_v - lo.vid_v) * (ratio - lo.ratio)) / (hi.ratio - lo.ratio);
    return { v: Math.min(Math.max(v, Math.min(lo.vid_v, hi.vid_v)), Math.max(lo.vid_v, hi.vid_v)), src: "interpolated" };
  };
}

/**
 * G-250: which stored curves can give Tune's factory voltages, best first. The library's marked baseline wins (a stock one is used as measured, a tuned one is derived from);
 * with none marked, the newest complete curve of this CPU (it holds every P / E unit of the read, its tuning state is known), any boot. `[]` = none.
 */
export function baselineCandidates(list, model) {
  const rows = Array.isArray(list) ? list.filter((c) => c && typeof c.id === "string") : [];
  const marked = rows.find((c) => c.baseline === true);
  if (marked) return [marked];
  const need = model ? model.order.filter((id) => model.units[id] && model.units[id].kind !== "R") : [];
  return rows
    .filter((c) => derivable(c) && need.every((id) => Array.isArray(c.units) && c.units.includes(id)))
    .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
}

/** The baseline slice for a fetched record: a marked stock curve is used as measured (src "baseline"); anything else is derived (src fused / derived / interpolated). null = cannot. */
export function baselineFromCurve(rec, row, model) {
  const name = (rec && rec.name) || row.id;
  const kind = rec && rec.tuning_state && rec.tuning_state.kind;
  if (row.baseline === true && kind !== "words") return { state: "ready", kind: "stock", fn: baselineFromRecord(rec), name, id: row.id, marked: true, units: null, reason: "" };
  const d = deriveFromRecord(rec, model);
  if (!d) return null;
  return { state: "ready", kind: "derived", fn: d.fn, name, id: row.id, marked: row.baseline === true, units: d.units, reason: "" };
}

async function fetchCurve(bridge, id) {
  const first = await bridge.call("curves.get", { id });
  if (!first.ok) return { error: first.error.message };
  let rec = first.result;
  // a record too big for one line comes back with omitted_units; fetch the rest a few units at a time
  for (let tries = 0; tries < 6 && Array.isArray(rec.omitted_units) && rec.omitted_units.length; tries++) {
    const want = rec.omitted_units.slice(0, 4);
    const more = await bridge.call("curves.get", { id, units: want });
    if (!more.ok) break;
    rec = { ...rec, units: { ...rec.units, ...more.result.units }, omitted_units: rec.omitted_units.filter((u) => !want.includes(u) || !more.result.units[u]) };
  }
  return { rec };
}

export const fmtSeconds = (ms) => (ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s");

// ---- the controller ----------------------------------------------------------------------------------------------------------------------
export function createController({ store, bridge, toast }) {
  ensureTune(store);
  const state = () => store.get().tune;
  const say = (kind, text) => (toast ? toast(kind, text) : pushToast(store, { kind, text }));

  /** A read becomes the model. `drop`: the operator chose "Read and drop" (the top bar asks first), else the kept draft is re-diffed (patchTune -> rebaseDraft). */
  function adopt(result, extra, { drop = false } = {}) {
    const model = unitsLib.modelFromRead(result);
    if (!model) return null;
    const kept = state().selection.filter((id) => model.units[id]); // a re-read keeps the selection (the inspector does not jump)
    const first = model.order.find((id) => model.units[id].kind === "P") || model.order[0];
    const selection = kept.length ? kept : first ? [first] : [];
    patchTune(store, { model, ...(drop ? { draft: draftLib.emptyDraft() } : {}), selection, anchor: selection.includes(state().anchor) ? state().anchor : selection[0] || null, ...extra });
    void tc.loadBaseline();
    return model;
  }

  const tc = {
    store,
    bridge,
    state,
    model: () => state().model,
    draft: () => state().draft,
    baseFn: () => (state().base.state === "ready" ? state().base.fn : null),
    baseReason: () => state().base.reason,
    edit(fn) {
      const s = state();
      if (!s.model) return;
      const next = fn(s.model, s.draft);
      if (next !== s.draft) patchTune(store, { draft: next });
    },
    setSelection: (ids, anchor) => ids.length && patchTune(store, { selection: ids.slice(), anchor: anchor ?? ids[0] }),
    setSubtab: (id) => (SUBTABS.some((t) => t.id === id) || SUBTAB_ALIASES[id]) && patchTune(store, { subtab: id }),

    /** The read of this boot, if the helper has one (tune.last: read-only, no mailbox traffic). */
    async loadLast() {
      const r = await bridge.call("tune.last");
      if (!r.ok || !r.result || !r.result.available || !r.result.result || state().model) return false;
      const at = new Date(r.result.at * 1000).toISOString();
      const model = adopt(r.result.result, { read: { ...state().read, state: "ready", fromLast: true, at, durationMs: null, ops: r.result.result.ops_done ?? null, error: null } });
      return !!model;
    },

    /** tune.read with live progress; the measured duration is shown next to the button. Never automatic. */
    async readCpu() {
      if (state().read.state === "reading") return;
      const startedAt = performance.now();
      patchTune(store, { read: { ...state().read, state: "reading", step: 0, of: 0, startedAt, error: null, fromLast: false } });
      const off = bridge.on("progress", (p) => {
        if (state().read.state !== "reading" || !p) return;
        patchTune(store, { read: { ...state().read, step: p.step ?? state().read.step, of: p.of ?? state().read.of } });
      });
      let res;
      try {
        const first = await bridge.call("tune.read");
        res = first.ok && first.pending ? await bridge.wait(first.id) : first;
      } finally {
        off();
      }
      const durationMs = performance.now() - startedAt;
      if (!res.ok) {
        patchTune(store, { read: { ...state().read, state: "error", durationMs, error: res.error.message || res.error.code } });
        say("error", "Read CPU state failed: " + (res.error.message || res.error.code));
        return;
      }
      const hadDraft = !draftLib.isEmpty(state().draft);
      const at = res.result.read_at || new Date().toISOString();
      const model = adopt(res.result, { read: { state: "ready", step: state().read.step, of: state().read.of, startedAt: null, durationMs, ops: res.result.ops_done ?? null, at, error: null, fromLast: false } }, { drop: true });
      if (!model) {
        patchTune(store, { read: { ...state().read, state: "error", durationMs, error: "the read held no units" } });
        say("error", "Read CPU state: the helper's answer held no units.");
        return;
      }
      setLastRead(store, at, res.result.accepted_match ?? null, res.result.accepted_note || "", res.result.uvp);
      say("ok", "Read CPU state in " + fmtSeconds(durationMs) + (hadDraft ? "; the pending edits were dropped (they were made against the previous read)." : "."));
    },

    async loadBaseline() {
      const none = (reason, id = null) => patchTune(store, { base: { state: "none", kind: "", fn: null, name: "", id, marked: false, units: null, reason } });
      patchTune(store, { base: { state: "loading", kind: "", fn: null, name: "", id: null, marked: false, units: null, reason: "the baseline curve is loading" } });
      const list = await bridge.call("curves.list");
      if (!list.ok) return none("stored curves unavailable: " + list.error.message);
      const rows = baselineCandidates(list.result.curves || [], state().model);
      if (!rows.length) return none(NO_BASELINE_REASON);
      let why = "";
      for (const row of rows.slice(0, 4)) {
        const got = await fetchCurve(bridge, row.id);
        if (!got.rec) {
          why = "the baseline curve could not be loaded: " + got.error;
          if (row.baseline === true) return none(why, row.id);
          continue;
        }
        const base = baselineFromCurve(got.rec, row, state().model);
        if (base) return patchTune(store, { base });
        why = "the curve “" + (got.rec.name || row.id) + "” was measured in an unknown tuning state: its offsets cannot be taken off";
        if (row.baseline === true) return none(why, row.id);
      }
      return none(why || NO_BASELINE_REASON);
    },
  };
  return tc;
}

/** The context handed to a sub-tab module (see the contract in the header). */
export function subTabContext(tc, ctx) {
  const { store } = tc;
  return {
    store,
    bridge: tc.bridge,
    toast: ctx.toast,
    goto: ctx.goto,
    draft: {
      get: () => tc.state().draft,
      set: (next) => patchTune(store, { draft: next }),
      edit: (fn) => tc.edit(fn),
      discard: () => discardDraft(store),
      lib: draftLib,
    },
    getDraft: () => tc.state().draft, // the turbo tab (G-209) reads/writes the shared draft through these accessors
    setDraft: (next) => patchTune(store, { draft: next }),
    units: unitsLib,
    limits: limitsLib,
    model: tc.state().model, // the units model at mount time (a new read remounts the sub-tab); getModel() for the live value
    getModel: () => tc.state().model,
    tune: tc,
  };
}

// ---- the view -----------------------------------------------------------------------------------------------------------------------------
/** The Cores tab: the units pane and the inspector side by side (`.lx-split`: 360 px pane, 288 px below 1180 px; the inspector scrolls inside its panel). */
function coresTab(tc, ctx) {
  let pane = null;
  let insp = null;
  return {
    mount(el) {
      pane = createUnitPane(tc);
      insp = createInspector(tc, { onFrequency: () => tc.setSubtab("turbo") });
      el.append(h("div", { class: ["lx-tiles", "lx-split", "lx-tune-cores"], dataset: { tuneCores: "true" } }, pane.el, insp.el));
      pane.update();
      insp.update();
    },
    unmount() {
      if (pane) pane.dispose();
      if (insp) insp.dispose();
      pane = insp = null;
    },
  };
}

/** The teaching empty state of a tab that needs a read (DESIGN.md §5.12): what is missing, one sentence, Read with its cost. */
function noReadPanel(tc, store) {
  const e = EMPTY["tune.noread"];
  const reading = tc.state().read.state === "reading";
  const read = button({ level: 1, label: "Read", id: "tune-read", hint: "state.read", disabled: reading || store.get().link.state !== "connected", onClick: () => tc.readCpu() });
  return h("section", { class: "lx-panel", dataset: { empty: "tune" } }, emptyState({ title: e.title, teach: e.teach, action: read, cost: e.cost }));
}

export function tuneView() {
  const disposers = [];
  let sub = null; // {id, model, empty, unmount()}
  return {
    id: "tune",
    lx: true,
    mount(root, ctx) {
      const tc = createController(ctx);
      const { store } = tc;
      const panel = h("div", { class: "lx-tune-panel", role: "tabpanel", id: "tune-panel" });
      root.append(panel);

      // the frame's work header: tabs with their edit marks, the persistence tag of the active tab
      const paintHead = () => {
        const st = store.get();
        const marks = tabEdits(st);
        if (!ctx.head) return;
        const persist = PERSIST[tabId(st.tune.subtab)];
        ctx.head.set({
          tabs: SUBTABS.map((t) => ({ id: t.id, label: t.label, edited: marks[t.id] })),
          selected: tabId(st.tune.subtab),
          idPrefix: "subtab-",
          controls: "tune-panel",
          label: "Tune sections",
          onTab: (id) => tc.setSubtab(id),
          end: persist ? tag(persist, "persist") : [],
        });
      };

      function unmountSub() {
        if (sub) sub.unmount();
        sub = null;
        clear(panel);
      }

      function renderSub() {
        const t = store.get().tune;
        const id = tabId(t.subtab);
        paintHead();
        panel.setAttribute("aria-labelledby", "subtab-" + id);
        if (sub && sub.id === id && sub.model === t.model) return;
        unmountSub();
        panel.dataset.tab = id;
        if (id === "cores") {
          root.dataset.legacy = "false";
          if (!t.model) {
            panel.append(noReadPanel(tc, store));
            sub = { id, model: t.model, empty: true, unmount() {} };
            return;
          }
          const tab = coresTab(tc, ctx);
          tab.mount(panel);
          sub = { id, model: t.model, unmount: () => tab.unmount() };
          return;
        }
        // module tabs: each part mounts into its own block; a part that needs a read shows the empty state until there is one
        const parts = SUBTAB_MODULES[id] || [];
        const mine = { id, model: t.model, empty: !t.model && parts.some((x) => x.needsRead), unmounts: [], unmount() {
          for (const u of this.unmounts) u();
        } };
        sub = mine;
        root.dataset.legacy = "true"; // until every part says lx (the old modules keep the screen padding)
        const flags = [];
        parts.forEach((spec, i) => {
          const host = h("div", { class: "lx-tune-part", dataset: { part: spec.path.replace(/^.*\/|\.js$/g, "") } });
          panel.append(host);
          if (spec.needsRead && !t.model) {
            host.append(noReadPanel(tc, store));
            flags[i] = true;
            return;
          }
          const note = h("p", { class: "lx-teach", text: "Loading…" });
          host.append(note);
          import(spec.path).then(
            (mod) => {
              if (sub !== mine) return;
              clear(host);
              mod.mount(host, subTabContext(tc, ctx));
              mine.unmounts.push(() => mod.unmount());
              flags[i] = mod.lx === true;
              if (parts.every((_, j) => flags[j] === true)) root.dataset.legacy = "false";
            },
            () => {
              if (sub !== mine) return;
              note.textContent = (SUBTABS.find((x) => x.id === id) || { label: id }).label + " could not be loaded.";
            },
          );
        });
      }

      disposers.push(
        store.watch(
          (s) => s.link.state,
          (state) => {
            if (state === "connected" && !tc.model() && tc.state().read.state === "idle") void tc.loadLast(); // the read of this boot, if there is one (read-only, no mailbox traffic)
          },
        ),
      );
      disposers.push(store.watch((s) => s.tune.subtab, renderSub));
      disposers.push(store.watch((s) => s.tune.model, renderSub));
      disposers.push(store.watch((s) => s.tune.read.state, () => sub && sub.empty && renderSubForce())); // the empty state's Read button follows the read
      disposers.push(store.watch((s) => s.pending, () => paintHead()));
      function renderSubForce() {
        unmountSub();
        renderSub();
      }
    },
    unmount() {
      for (const d of disposers.splice(0)) d();
      if (sub) sub.unmount();
      sub = null;
    },
  };
}
