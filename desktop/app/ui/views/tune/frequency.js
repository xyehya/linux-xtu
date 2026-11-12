// views/tune/frequency.js: Tune › Frequency (R-S2; desktop/DESIGN.md §9.3, assessment 03 U-20/U-21/U-22, WP-6). One view for everything that limits a unit's ratio:
//   RATIO LIMITS   one row per P-core / E-cluster: Max× (0x1C, mailbox) · OC× · Turbo 1 busy× · Turbo all× (MSR tables) · Cap× (cpufreq, runtime; the one field here)
//                  → Runs up to (1 busy, all busy) = the lowest of them, and the limit that binds named. An OC ratio above the table stays capped by it (D-050):
//                  an info line on the unit's row, never an error.
//   TURBO TABLE · P-CORES / E-CORES   the eight buckets as fields (ratio per busy-core count), Set all / Fill right, a step chart on a real busy-core axis.
// Turbo buckets edit the shared Tune draft through lib/draft.js editBucket: the table may only fall as more cores are busy; a value above the bucket to its left
// is refused in the field with its reason (refused.turbo_rise), the typed text kept, nothing changed. Lowering a bucket brings the buckets on its right down with
// it (that is the lib's rule) and the view says which ones followed (info.turbo_followed) — never silently (U-22). The helper refuses a rising table at plan time
// (REFUSED TURBO_ORDER {table, bucket}); lib/cpulimits.js explainRefusal adds what to do.
// Ratio caps edit the runtime slice (lib/rtstate.js `rt.edits.caps`, per unit; an E-cluster's cap applies to all four CPUs) and are planned by runtime.plan.
// Nothing here writes hardware: every edit reaches the CPU only through the pending row's Review and the commit sheet's Apply.
//
// The view-module shape of views/tune/turbo.js (which it replaces, with views/tune/runtime.js): mount(el, ctx) / unmount().
//   ctx = subTabContext of views/tune.js: {store, bridge, getDraft, setDraft, model, getModel?, tune?}. getDraft/setDraft are required together; without them the
//   draft lives in store.tune.draft. The model is ctx.getModel() / ctx.model / store.tune.model (a new tune.read remounts the tab). The runtime read (caps) is
//   done on mount (runtime.read: plain sysfs reads, no mailbox traffic).
import { h, clear } from "../../components/dom.js";
import { createField } from "../../components/field.js";
import { createTable, fillCell } from "../../components/table.js";
import { panel } from "../../components/panel.js";
import { button } from "../../components/buttons.js";
import { tag, mark, fav } from "../../components/ann.js";
import { why, setWhy } from "../../components/help.js";
import { createPlot } from "../../components/plot.js";
import * as D from "../../lib/draft.js";
import { stockMaxOf, ocClass, favoredIds } from "../../lib/units.js";
import { limitsFor } from "../../lib/limits.js";
import { isNum } from "../../lib/format.js";
import { normCpuLimits, unitCapWindow } from "../../lib/cpulimits.js";
import { ensureRt, editRt, capRows } from "../../lib/rtstate.js";
import { ocAboveTable } from "./oc.js";
import { loadRead, registerRuntimeKinds } from "./runtime-kinds.js";
import { restoreButton, rtLock, whyOf } from "./rt-common.js";
import { editLock } from "../../store.js";

export const KINDS = ["P", "E"];
export const BUCKETS = 8;
const KIND_TITLE = { P: "P-cores", E: "E-cores" };
const TIMES = "×";

// ---------------------------------------------------------------- pure (node-tested)

/** Busy-core count of each bucket: the read's counts (0x1AE / 0x651), else 1..8. */
export function bucketCounts(model, kind) {
  const t = model && model.turbo ? model.turbo[kind] : null;
  const c = t && Array.isArray(t.counts) && t.counts.length === BUCKETS && t.counts.every(isNum) ? t.counts : null;
  return c ? c.slice() : Array.from({ length: BUCKETS }, (_, i) => i + 1);
}

/**
 * The ratio a unit runs up to, from its limits: {ceiling (null = none), ceilingName, t1, tall, cap (null = none)} -> {one, all, binds}.
 * one / all = the lowest limit with one / every core busy; binds = the limit that sets `one`, bindsAll = the one that sets `all` ("turbo table" | ceilingName | "ratio cap"). A tie goes to the
 * table, then the unit's own ceiling: a cap only binds when it is strictly lower (a cap at the maximum holds nothing back). null values are not limits.
 */
export function runsUpTo({ ceiling = null, ceilingName = "max ratio", t1 = null, tall = null, cap = null } = {}) {
  const pick = (t) => {
    const c = [
      ["turbo table", t],
      [ceilingName, ceiling],
      ["ratio cap", cap],
    ].filter(([, v]) => isNum(v));
    if (!c.length) return { v: null, by: null };
    let best = c[0];
    for (const x of c) if (x[1] < best[1]) best = x;
    return { v: best[1], by: best[0] };
  };
  const one = pick(t1);
  const all = pick(tall);
  return { one: one.v, all: all.v, binds: one.by, bindsAll: all.by };
}

/** The Binds cell (QA-09): which limit holds the unit with one busy core and which with every core busy; one word when they are the same limit. */
export function bindsText(L) {
  if (!L.binds && !L.bindsAll) return "—";
  if (!L.bindsAll || L.bindsAll === L.binds) return L.binds || "—";
  return (L.binds || "—") + " · all busy: " + L.bindsAll;
}

/**
 * One unit's row of the RATIO LIMITS table from the model, the draft and the runtime caps. Pure.
 * -> {id, kind, cpus, max, oc, ocEdited, t1, tall, t1Edited, tallEdited, cap, capRead, capEdited, one, all, binds}
 *   max: a P-core's 0x1C ratio capped at its factory top (stockMaxOf); E-clusters have no per-cluster max ratio (null).
 *   oc:  the (drafted) OC ratio when it raises the unit above its stock max, else null.
 *   cap: the cap edited, else the one in force (scaling_max_freq); a tie with the table or the unit's ceiling binds to those (runsUpTo).
 */
export function unitLimits(model, draft, id, caps = {}, capRead = null) {
  const u = model.units[id];
  const kind = u.kind;
  const t = D.turboEff(model, draft, kind);
  const read = D.turboCur(model, kind);
  const r = D.effRatio(draft, u);
  const cls = ocClass(u, r);
  const oc = cls === "oc" || cls === "middle" ? r : null;
  const max = kind === "P" ? stockMaxOf(u) : null;
  const ceiling = kind === "P" ? (isNum(max) ? Math.max(max, oc ?? 0) : oc) : null;
  // the cap in force is scaling_max_freq: it is a limit even at the kernel's default (whether cpufreq's maximum follows an OC ratio is not measured)
  const cap = isNum(caps[id]) ? caps[id] : isNum(capRead) ? capRead : null;
  const lim = runsUpTo({ ceiling, ceilingName: isNum(oc) && (!isNum(max) || oc > max) ? "OC ratio" : "max ratio", t1: t ? t[0] : null, tall: t ? t[t.length - 1] : null, cap });
  return {
    id,
    kind,
    cpus: u.cpus,
    max,
    oc,
    ocEdited: !!(draft.units[id] && draft.units[id].ratio !== undefined),
    t1: t ? t[0] : null,
    tall: t ? t[t.length - 1] : null,
    t1Edited: !!(t && read && t[0] !== read[0]),
    tallEdited: !!(t && read && t[t.length - 1] !== read[read.length - 1]),
    cap,
    capRead: isNum(capRead) ? capRead : null,
    capEdited: isNum(caps[id]) && caps[id] !== capRead,
    ...lim,
  };
}

/**
 * The step chart's points of a table on a real busy-core axis: bucket i holds for busy counts (c[i-1], c[i]], so the line drops right after c[i-1].
 * -> [[x, y], …] (a polyline) for `ratios` over `counts`.
 */
export function stepPoints(ratios, counts) {
  const pts = [[counts[0], ratios[0]]];
  for (let i = 1; i < ratios.length; i++) pts.push([counts[i - 1], ratios[i]], [counts[i], ratios[i]]);
  return pts;
}

/** "3–8" / "4, 6" / "8": the busy counts of the buckets in `idx`, for the followed-line. */
export function countsText(idx, counts) {
  const cs = idx.map((i) => counts[i]);
  if (!cs.length) return "";
  const run = idx.every((x, k) => k === 0 || x === idx[k - 1] + 1);
  return cs.length === 1 ? String(cs[0]) : run ? cs[0] + "–" + cs[cs.length - 1] : cs.join(", ");
}

/**
 * Set every bucket of a kind to `value` through editBucket (in order, so a raise never passes the bucket to its left). -> {ok, draft} | refusal (the first one).
 */
export function setAllBuckets(model, draft, kind, value) {
  const n = (D.turboCur(model, kind) || []).length;
  let d = draft;
  for (let i = 0; i < n; i++) {
    if (D.turboEff(model, d, kind)[i] === value) continue;
    const r = D.editBucket(model, d, kind, i, value);
    if (!r.ok) return r;
    d = r.draft;
  }
  return { ok: true, draft: d };
}

/** Copy bucket i's ratio to every bucket on its right. -> {ok, draft, changed: [indices]} | refusal. */
export function fillRight(model, draft, kind, i) {
  const eff = D.turboEff(model, draft, kind);
  if (!eff || i < 0 || i >= eff.length) return { ok: false, reason: "refused.no_such_point", values: { bucket: i } };
  let d = draft;
  const changed = [];
  for (let j = i + 1; j < eff.length; j++) {
    if (D.turboEff(model, d, kind)[j] === eff[i]) continue;
    const r = D.editBucket(model, d, kind, j, eff[i]);
    if (!r.ok) return r;
    d = r.draft;
    changed.push(j);
  }
  return { ok: true, draft: d, changed };
}

// ---------------------------------------------------------------- the view

let V = null;

function api(ctx) {
  const store = ctx.store || null;
  const st = () => (store ? store.get() : {});
  if (typeof ctx.getDraft === "function" && typeof ctx.setDraft !== "function") throw new TypeError("frequency.mount: ctx.getDraft needs ctx.setDraft (the shared draft belongs to the host)");
  let local = D.emptyDraft();
  return {
    store,
    model: () => (typeof ctx.getModel === "function" ? ctx.getModel() : null) || ctx.model || (st().tune ? st().tune.model : null),
    draft: () => (typeof ctx.getDraft === "function" ? ctx.getDraft() : null) || (st().tune ? st().tune.draft : null) || local,
    setDraft(next) {
      if (typeof ctx.setDraft === "function") ctx.setDraft(next);
      else if (store && st().tune) store.update((s) => ({ tune: { ...s.tune, draft: next } }));
      else local = next;
    },
  };
}

const RATIO_COLS = [
  { key: "unit", label: "Unit" },
  { key: "max", label: "Max", unit: TIMES, num: true, hint: "freq.maxratio" },
  { key: "oc", label: "OC", unit: TIMES, num: true, hint: "freq.oc" },
  { key: "t1", label: "Turbo 1 busy", unit: TIMES, num: true, hint: "freq.turbo_one" },
  { key: "tall", label: "Turbo all", unit: TIMES, num: true, hint: "freq.turbo_all" },
  { key: "cap", label: "Cap", unit: TIMES, field: true, hint: "freq.cap" },
  { key: "m", label: "", mark: true },
  { key: "one", label: "Runs up to · 1 busy", unit: TIMES, num: true, hint: "freq.effective" },
  { key: "all", label: "all busy", unit: TIMES, num: true, hint: "freq.effective" },
  { key: "binds", label: "Binds", hint: "freq.binds", cls: "lx-freq-binds" },
];

export function mount(el, ctx = {}) {
  unmount();
  const A = api(ctx);
  const { store } = A;
  const bridge = ctx.bridge || null;
  const model = A.model();
  const inst = { el, ctx, A, store, model, disposers: [], caps: new Map(), capKey: "", kinds: {}, rows: new Map() };
  V = inst;
  el.classList.add("lx-rt-host", "lx-freq-host");
  el.dataset.view = "frequency";
  if (store) {
    registerRuntimeKinds();
    ensureRt(store);
  }
  if (!model || !model.turbo) {
    el.append(h("div", { class: "lx-panel lx-rt-none", dataset: { empty: "true" } }, h("p", { class: "lx-teach", text: model ? "This read carries no turbo tables, so the ratio limits cannot be shown." : "No read yet: Read in the top bar first." })));
    return;
  }
  build(inst);
  paint(inst);
  if (store) {
    inst.disposers.push(store.watch((s) => s.tune && s.tune.draft, () => paint(inst)));
    inst.disposers.push(store.watch((s) => s.rt, () => paint(inst)));
    inst.disposers.push(store.watch((s) => (editLock(s) ? editLock(s).key : null), () => paint(inst)));
    inst.disposers.push(store.watch((s) => s.mode, () => paint(inst)));
    inst.disposers.push(store.watch((s) => s.link && s.link.state, (state) => {
      paint(inst);
      if (state === "connected" && store.get().rt.runtime.state === "idle" && bridge) void loadRead(store, bridge, "runtime");
    }));
    const s = store.get();
    if (bridge && s.link && s.link.state === "connected" && s.rt.runtime.state !== "reading") void loadRead(store, bridge, "runtime");
  }
}

export function unmount() {
  const inst = V;
  if (!inst) return;
  V = null;
  for (const d of inst.disposers.splice(0)) d();
  for (const k of Object.values(inst.kinds)) if (k.plot) k.plot.dispose();
  clear(inst.el);
  inst.el.classList.remove("lx-rt-host", "lx-freq-host");
  delete inst.el.dataset.view;
}

// ---- build ------------------------------------------------------------------------------------------------------------------------------------
function build(inst) {
  const { el, model } = inst;
  clear(el);
  const restore = inst.store ? restoreButton(inst.store, "runtime") : null;
  inst.restore = restore;

  // RATIO LIMITS
  const table = createTable({ columns: RATIO_COLS, variant: ["fill"], label: "Ratio limits per unit" });
  const rows = [];
  for (const kind of KINDS) {
    const ids = model.order.filter((id) => model.units[id] && model.units[id].kind === kind);
    if (!ids.length) continue;
    rows.push({ key: "g-" + kind, group: { label: kind === "P" ? "P-cores" : "E-clusters", n: kind === "P" ? ids.length : ids.length + " · 4 CPUs each, one cap" } });
    for (const id of ids) rows.push({ key: id, cells: {} });
  }
  table.setRows(rows);
  const favs = favoredIds(model);
  for (const r of rows) {
    if (r.group) continue;
    const tr = table.row(r.key);
    const u = model.units[r.key];
    tr.dataset.kind = u.kind;
    tr.cells_.unit.classList.add("lx-k");
    fillCell(tr.cells_.unit, { node: h("span", {}, u.id, favs.includes(u.id) ? [" ", fav()] : null, h("span", { class: "lx-sub", text: u.kind === "E" ? u.cpus[0] + "–" + u.cpus[u.cpus.length - 1] : "cpu " + u.cpu })) });
    const info = why(null);
    const whyRow = h("tr", { class: "lx-why-row", hidden: true, dataset: { whyFor: r.key } }, h("td", { colspan: String(RATIO_COLS.length) }, info));
    tr.after(whyRow);
    inst.rows.set(r.key, { tr, info, whyRow, capWhy: null });
  }
  inst.table = table;
  inst.limitsWhy = why(null);
  const foot = h("div", { class: "lx-rt-foot" }, inst.limitsWhy);
  const lp = panel({
    title: "Ratio limits",
    meta: h("span", {}, "max, OC ", h("span", { class: "lx-mono", text: "mailbox" }), " · turbo ", h("span", { class: "lx-mono", text: "MSR" }), " · cap ", h("span", { class: "lx-mono", text: "runtime" })),
    end: restore ? restore.el : null,
    body: [table.el, foot],
    flush: true,
    id: "freq-limits",
  });
  lp.el.classList.add("lx-freq-limits");
  lp.el.dataset.panel = "limits";

  const grid = h("div", { class: ["lx-tiles", "lx-freq"] }, lp.el);
  for (const kind of KINDS) grid.append(buildKind(inst, kind));
  el.append(grid);
}

function buildKind(inst, kind) {
  const { model } = inst;
  const counts = bucketCounts(model, kind);
  const lim = limitsFor(model, kind);
  const head = h("tr", {}, h("th", { scope: "row", class: "lx-k", text: "Busy" }), ...counts.map((c) => h("th", { scope: "col", class: "lx-n", text: String(c) })));
  const valRow = h("tr", {}, h("th", { scope: "row", class: "lx-k" }, TIMES));
  const fields = [];
  const whys = h("div", { class: "lx-freq-whys" });
  for (let i = 0; i < BUCKETS; i++) {
    const f = createField({
      label: counts[i] + " busy, " + KIND_TITLE[kind] + " turbo ratio",
      hint: "turbo.bucket",
      width: 3,
      decimals: 0,
      max: lim.ratio && i === 0 ? lim.ratio.max : null,
      source: lim.ratio ? lim.ratio.source : "",
      unit: "",
      allow: (v) => {
        const r = D.editBucket(model, inst.A.draft(), kind, i, v);
        return r.ok ? null : whyOf(r);
      },
      onCommit: (v) => commitBucket(inst, kind, i, v),
    });
    f.el.dataset.bucket = String(i);
    f.el.dataset.kind = kind;
    f.input.addEventListener("focus", () => {
      inst.kinds[kind].sel = i;
      paintTools(inst, kind);
    });
    fields.push(f);
    whys.append(f.whyEl);
    valRow.append(h("td", { class: "lx-f" }, f.el));
  }
  const tbl = h("table", { class: ["lx-tbl", "lx-freq-buckets"], "aria-label": KIND_TITLE[kind] + " turbo table: ratio by busy cores" }, h("thead", {}, head), h("tbody", {}, valRow));
  const followed = why(null);
  whys.append(followed);

  // Set all / Fill right
  const allField = createField({ label: "Set every " + KIND_TITLE[kind] + " bucket to", hint: "turbo.set_all", width: 3, decimals: 0, max: lim.ratio ? lim.ratio.max : null, source: lim.ratio ? lim.ratio.source : "" });
  allField.el.dataset.setAll = kind;
  const setAllBtn = button({ level: 2, label: "Set all", hint: "turbo.set_all", onClick: () => doSetAll(inst, kind) });
  setAllBtn.dataset.action = "set-all";
  allField.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSetAll(inst, kind);
  });
  const fillBtn = button({ level: 2, label: "Fill right", hint: "turbo.fill_right", onClick: () => doFill(inst, kind) });
  fillBtn.dataset.action = "fill-right";
  const tools = h("div", { class: "lx-freq-tools" }, h("span", { class: "lx-lbl", text: "Set all to" }), allField.el, setAllBtn, h("span", { class: "lx-freq-gap" }), fillBtn);
  whys.append(allField.whyEl);

  const yOpts = { min: 0, max: 1, fmt: (v) => v + TIMES };
  const plot = createPlot({
    label: KIND_TITLE[kind] + " turbo table, ratio by busy cores",
    height: 140,
    margin: { l: 40, r: 14, t: 14, b: 34 },
    x: { min: counts[0], max: counts[BUCKETS - 1], ticks: counts, fmt: String, title: "busy cores" },
    y: yOpts,
    readout: (x) => {
      const i = counts.indexOf(x);
      if (i < 0) return [];
      const eff = D.turboEff(model, inst.A.draft(), kind);
      const cur = D.turboCur(model, kind);
      return eff[i] === cur[i] ? [[x + " busy", eff[i] + TIMES]] : [[x + " busy", cur[i] + TIMES], ["→", eff[i] + TIMES]];
    },
  });
  const lp = panel({
    title: "Turbo table · " + KIND_TITLE[kind],
    meta: h("span", { class: "lx-mono", text: kind === "P" ? "0x1AD / 0x1AE" : "0x650 / 0x651" }),
    end: tag("MSR · cold boot clears", "persist"),
    body: [h("div", { class: "lx-freq-tbl" }, tbl), whys, tools, plot.el],
    id: "freq-turbo-" + kind,
  });
  lp.el.classList.add("lx-freq-turbo");
  lp.el.dataset.panel = "turbo";
  lp.el.dataset.kind = kind;
  inst.kinds[kind] = { panel: lp, fields, followed, allField, setAllBtn, fillBtn, plot, yOpts, counts, sel: 0, plotKey: "" };
  return lp.el;
}

// ---- edits ------------------------------------------------------------------------------------------------------------------------------------
function commitBucket(inst, kind, i, v) {
  if (V !== inst) return;
  const r = D.editBucket(inst.model, inst.A.draft(), kind, i, v);
  if (!r.ok) return; // the field's allow() said why already
  inst.A.setDraft(r.draft);
  const k = inst.kinds[kind];
  if (r.moved && r.moved.length) setWhy(k.followed, "info.turbo_followed", { list: countsText(r.moved, k.counts), value: v });
  else setWhy(k.followed, null);
  if (!inst.store) paint(inst);
}

function doSetAll(inst, kind) {
  const k = inst.kinds[kind];
  if (k.allField.state() === "refused") return;
  const v = Number(k.allField.input.value.replace("−", "-"));
  if (!Number.isInteger(v)) {
    setWhy(k.allField.whyEl, "refused.not_a_number", { value: k.allField.input.value });
    return;
  }
  const r = setAllBuckets(inst.model, inst.A.draft(), kind, v);
  if (!r.ok) {
    const w = whyOf(r);
    setWhy(k.allField.whyEl, w.key, w.vars);
    k.allField.el.dataset.state = "refused";
    return;
  }
  setWhy(k.allField.whyEl, null);
  k.allField.el.dataset.state = "idle";
  setWhy(k.followed, null);
  inst.A.setDraft(r.draft);
  if (!inst.store) paint(inst);
}

function doFill(inst, kind) {
  const k = inst.kinds[kind];
  const r = fillRight(inst.model, inst.A.draft(), kind, k.sel);
  if (!r.ok) {
    const w = whyOf(r);
    setWhy(k.allField.whyEl, w.key, w.vars);
    return;
  }
  setWhy(k.followed, null);
  if (r.changed.length) inst.A.setDraft(r.draft);
  if (!inst.store) paint(inst);
}

function capCommit(inst, id, v) {
  if (!inst.store) return;
  editRt(inst.store, (e) => {
    const g = capRows(inst.store.get().rt.runtime.result).find((x) => x.unit === id);
    const caps = { ...e.caps };
    if (g && g.capRatio === v && !g.mixedCap) delete caps[id];
    else caps[id] = v;
    return { ...e, caps };
  });
}

// ---- paint ------------------------------------------------------------------------------------------------------------------------------------
function paint(inst) {
  if (V !== inst || !inst.model || !inst.model.turbo) return;
  const st = inst.store ? inst.store.get() : null;
  const draft = inst.A.draft();
  const rt = st && st.rt ? st.rt : null;
  const result = rt ? rt.runtime.result : null;
  const groups = capRows(result);
  const edits = rt ? rt.edits.caps : {};
  const cl = normCpuLimits(result ? result.cpu_limits : null);
  const lock = st ? rtLock(st, "runtime") : { state: "disabled", key: "locked.no_link", vars: {} };
  const tuneLock = st ? editLock(st) : null;
  paintCaps(inst, groups, cl);
  const capsRead = Object.fromEntries(groups.map((g) => [g.unit, g.capRatio]));
  const over = {};
  for (const kind of KINDS) {
    const o = ocAboveTable(inst.model, draft, kind);
    if (o) for (const u of o.units) over[u.id] = { oc: u.ratio, table: o.top };
  }
  let colWhy = lock && lock.state === "disabled" ? lock : null;
  if (!colWhy && result && groups.length && !groups.some((g) => unitCapWindow(cl, g.cpus))) colWhy = { key: "locked.no_read", vars: {} };
  for (const [id, row] of inst.rows) {
    const L = unitLimits(inst.model, draft, id, edits, capsRead[id]);
    const c = row.tr.cells_;
    const v = (x, edited) => (isNum(x) ? { text: String(x), v: edited ? "set" : null } : null);
    fillCell(c.max, v(L.max, false));
    fillCell(c.oc, v(L.oc, L.ocEdited));
    fillCell(c.t1, v(L.t1, L.t1Edited));
    fillCell(c.tall, v(L.tall, L.tallEdited));
    fillCell(c.one, isNum(L.one) ? { text: String(L.one), v: L.ocEdited || L.t1Edited || L.capEdited ? "set" : null } : { text: "n/a", na: true });
    fillCell(c.all, isNum(L.all) ? { text: String(L.all), v: L.ocEdited || L.tallEdited || L.capEdited ? "set" : null } : { text: "n/a", na: true });
    fillCell(c.binds, bindsText(L));
    const edited = L.ocEdited || L.t1Edited || L.tallEdited || L.capEdited;
    fillCell(c.m, L.capEdited ? { node: mark() } : "");
    if (L.capEdited) row.tr.dataset.state = "edit";
    else row.tr.removeAttribute("data-state");
    row.tr.dataset.binds = L.binds || "";
    row.tr.dataset.bindsAll = L.bindsAll || "";
    row.tr.dataset.edited = String(edited);
    // the cap field of this unit
    const capF = inst.caps.get(id);
    const g = groups.find((x) => x.unit === id);
    if (capF) {
      fillCellNode(c.cap, capF.f.el);
      if (capF.f.state() !== "refused") capF.f.set(isNum(edits[id]) ? edits[id] : g ? g.capRatio : null); // a refusal stays until the operator acts on the field
      if (tuneLock) capF.f.setState("reading");
      else if (lock) capF.f.setState(lock.state);
      else if (g && !g.online.length) capF.f.setState("disabled", "locked.cpu_offline", { cpu: g.cpus.join(", ") });
      else if (!capF.win) capF.f.setState("disabled");
      else capF.f.setState(L.capEdited ? "set" : "idle");
    } else fillCell(c.cap, lock && lock.state === "reading" ? { text: "—", v: "none" } : { text: "n/a", na: true });
    // D-050: an OC ratio above the table is capped by it (info, not an error)
    const o = over[id];
    setWhy(row.info, o ? "info.oc_capped" : null, o || {});
    syncWhyRow(inst, id);
  }
  if (!colWhy && result && Array.isArray(result.offline) && result.offline.length) colWhy = { key: "locked.cpu_offline", vars: { cpu: result.offline.join(", ") } };
  setWhy(inst.limitsWhy, colWhy ? colWhy.key : null, colWhy ? colWhy.vars : {});
  inst.table.foot(footText(cl, groups));
  for (const kind of KINDS) paintKind(inst, kind, draft, tuneLock);
  if (inst.restore) inst.restore.update();
}

/** Put a field node into a cell once (re-appending would drop focus). */
function fillCellNode(td, node) {
  if (td.firstChild === node && td.childNodes.length === 1) return false;
  fillCell(td, { node });
  return true;
}

function footText(cl, groups) {
  const ws = groups.map((g) => unitCapWindow(cl, g.cpus, g.maxRatio)).filter(Boolean);
  if (!ws.length) return "Cap: cpufreq maximum per unit; an E-cluster’s cap applies to its four CPUs.";
  const lo = ws.map((w) => w.min).filter(isNum);
  return "Cap window " + (lo.length ? Math.min(...lo) : "?") + "–" + Math.max(...ws.map((w) => w.max)) + TIMES + " (cpufreq range of each unit) · an E-cluster’s cap applies to its four CPUs.";
}

/** (Re)build the cap fields when the units or their windows change (a new runtime read). */
function paintCaps(inst, groups, cl) {
  const key = groups.map((g) => g.unit + ":" + g.cpus.join(",") + ":" + JSON.stringify(unitCapWindow(cl, g.cpus, g.maxRatio))).join("|");
  if (key === inst.capKey) return;
  inst.capKey = key;
  inst.caps.clear();
  for (const [id, row] of inst.rows) {
    const g = groups.find((x) => x.unit === id);
    if (!g) {
      row.capWhy = null;
      continue;
    }
    const win = unitCapWindow(cl, g.online.length ? g.online : g.cpus, g.maxRatio);
    const f = createField({ label: "Ratio cap of " + id, hint: "freq.cap", width: 3, decimals: 0, min: win ? win.min : null, max: win ? win.max : null, source: win ? win.source : "", onCommit: (v) => capCommit(inst, id, v) });
    f.el.dataset.cap = id;
    const info = row.whyRow.firstChild;
    if (row.capWhy && row.capWhy.parentNode) row.capWhy.remove();
    info.append(f.whyEl);
    row.capWhy = f.whyEl;
    for (const ev of ["change", "keydown", "blur"]) f.input.addEventListener(ev, () => queueMicrotask(() => syncWhyRow(inst, id)));
    inst.caps.set(id, { f, win });
  }
}

function syncWhyRow(inst, id) {
  const row = inst.rows.get(id);
  if (!row) return;
  row.whyRow.hidden = row.info.hidden && (!row.capWhy || row.capWhy.hidden);
}

function paintKind(inst, kind, draft, tuneLock) {
  const k = inst.kinds[kind];
  const cur = D.turboCur(inst.model, kind);
  const eff = D.turboEff(inst.model, draft, kind);
  let dirty = 0;
  k.fields.forEach((f, i) => {
    if (f.state() !== "refused") f.set(eff[i]); // a refusal stays until the operator acts on the field
    const changed = eff[i] !== cur[i];
    if (changed) dirty++;
    if (tuneLock) f.setState("reading", tuneLock.key, tuneLock.vars);
    else f.setState(changed ? "set" : "idle");
  });
  k.panel.el.dataset.edited = String(dirty > 0);
  k.fillBtn.disabled = !!tuneLock || k.sel >= BUCKETS - 1;
  k.setAllBtn.disabled = !!tuneLock;
  if (tuneLock) k.allField.setState("reading");
  else if (k.allField.state() !== "refused") k.allField.setState("idle");
  paintTools(inst, kind);
  // the step chart: read (white) and, when edited, your table (cyan) on a real busy-core axis
  const pkey = cur.join(",") + "|" + eff.join(",");
  if (pkey === k.plotKey) return;
  k.plotKey = pkey;
  const all = cur.concat(eff);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const traces = [{ kind: "meas", pts: stepPoints(cur, k.counts) }];
  if (dirty) traces.push({ kind: "set", pts: stepPoints(eff, k.counts) });
  const markers = eff.map((r, i) => ({ x: k.counts[i], y: r, kind: r !== cur[i] ? "set" : "meas" }));
  // y follows the tables (−2 / +1 so a flat table sits off the axis): the plot core reads its y options at every render
  k.yOpts.min = lo - 2;
  k.yOpts.max = hi + 1;
  k.yOpts.ticks = undefined;
  k.plot.draw({ traces, markers, cursorXs: k.counts });
}

function paintTools(inst, kind) {
  const k = inst.kinds[kind];
  const label = "Fill right from " + k.counts[k.sel] + " busy";
  const t = k.fillBtn.querySelector(".lx-btn-t");
  if (t) t.textContent = label;
  k.fillBtn.disabled = k.sel >= BUCKETS - 1 || !!(inst.store && editLock(inst.store.get()));
}
