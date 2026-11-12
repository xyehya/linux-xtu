// views/tune/power.js: Tune › Power (R-S2; desktop/DESIGN.md §9.4, assessment 03 WP-6). Two panels:
//   PACKAGE POWER LIMITS  Long-term limit PL1 · Short-term limit PL2 · Time window tau (fields with steppers) · Peak limit PL4 (read only, MSR 0x601 in watts,
//                         locked / unlocked; the powercap peak_power copy is not enforced, throttling.md §G) — In force · New value · At boot.
//   LIVE                  package power now and over the last 60 samples against PL1 / PL2 / PL4 (reference lines), and which power limit binds now (0x64F).
// Reads power.read (powercap files + MSR 0x610 lock / 0x614 info; plain reads, never the OC mailbox). Edits live in the runtime slice (lib/rtstate.js
// `rt.edits.power`) and reach the CPU only through the pending row's Review and the commit sheet (kind "power": power.plan {pl1_w?, pl2_w?, tau_s?}).
// PL1 above PL2 is refused in the field (refused.power_order, the typed text kept); the helper refuses it at plan time too (REFUSED POWER_ORDER, whose
// remediation lib/cpulimits.js explainRefusal adds). D-049: the bounds are the CPU's own (`cpu_limits.power`: the PL field maximum and the 0x610 lock).
//   mount(el, ctx) / unmount();  ctx = subTabContext of views/tune.js ({store, bridge, ...}).
import { h, clear } from "../../components/dom.js";
import { createField } from "../../components/field.js";
import { createTable, fillCell } from "../../components/table.js";
import { panel } from "../../components/panel.js";
import { mark } from "../../components/ann.js";
import { why, setWhy, label, createQ } from "../../components/help.js";
import { createPlot, niceTicks } from "../../components/plot.js";
import { isNum } from "../../lib/format.js";
import { HINTS } from "../../lib/hints.js";
import { ensureRt, editRt, powerCurrent, powerDisagrees, powerDisabledReason } from "../../lib/rtstate.js";
import { normCpuLimits, powerRead } from "../../lib/cpulimits.js";
import { loadRead, registerRuntimeKinds } from "./runtime-kinds.js";
import { restoreButton, rtLock } from "./rt-common.js";

/** The editable limits: key of the power intent, hint key (label + expert term, DESIGN §6.5), unit, field width and decimals. */
export const FIELDS = [
  { key: "pl1_w", hint: "power.pl1", unit: "W", width: 5, decimals: 0, step: 1, big: 10 },
  { key: "pl2_w", hint: "power.pl2", unit: "W", width: 5, decimals: 0, step: 1, big: 10 },
  { key: "tau_s", hint: "power.tau", unit: "s", width: 6, decimals: 1, step: 1, big: 10 },
];
/** Live history shown: the last N telemetry samples. */
export const LIVE_SAMPLES = 60;

// ---------------------------------------------------------------- pure (node-tested)

/**
 * The order rule of the package limits: PL1 may not be above PL2 (the helper refuses it at plan time, POWER_ORDER). `cur` = in force, `edit` = pending,
 * `key`/`v` = the value being typed. -> null (fine) | {key: "refused.power_order", vars: {long, short}} (PL1, PL2 in W).
 */
export function powerOrder(cur, edit, key, v) {
  const eff = { ...(cur || {}), ...(edit || {}), [key]: v };
  const pl1 = eff.pl1_w;
  const pl2 = eff.pl2_w;
  if ((key === "pl1_w" || key === "pl2_w") && isNum(pl1) && isNum(pl2) && pl1 > pl2) return { key: "refused.power_order", vars: { long: String(pl1), short: String(pl2) } };
  return null;
}

/** The read-only PL4 row (G-244): MSR 0x601 from the live telemetry `values.pl4` ({watts, locked, raw}); unavailable stays unavailable. Nothing here changes PL4. */
export function pl4Display(values) {
  const r = values && values.pl4;
  if (!r || r.value === null || r.value === undefined || r.status === "unavailable" || !isNum(r.value.watts)) {
    return { text: "n/a", watts: null, note: (r && r.reason) || "not reported (needs the helper's MSR access)", locked: null };
  }
  const w = r.value.watts;
  return { text: (Number.isInteger(w) ? String(w) : w.toFixed(3)) + " W · " + (r.value.locked ? "locked" : "unlocked"), watts: w, note: "", locked: !!r.value.locked };
}

/** "PL1 30%" / "PL1 30% · PL2 10%" / "PL4" / "none" / "n/a" from the store's throttle model: which power limit holds the clocks down now. */
export function bindsNow(thr) {
  if (!thr || thr.state !== "ok") return "n/a";
  const out = [];
  const pct = (d) => (isNum(d) ? " " + Math.round(d * 100) + "%" : "");
  for (const b of thr.active || []) {
    if (b.key === "pl1" || b.key === "pl2") out.push(b.key.toUpperCase() + pct(b.duty));
  }
  const cur = (thr.groups || []).find((g) => g.key === "current");
  if (cur && cur.state === "yes" && (cur.bits || []).some((b) => b.key === "other")) out.push("PL4" + pct(cur.duty));
  return out.length ? out.join(" · ") : "none";
}

/** The plot's y top: the highest of the limits and the samples, with room for the labels; null-safe. */
export function liveTop(values, refs) {
  const all = values.filter(isNum).concat(refs.filter(isNum));
  return all.length ? Math.max(...all) * 1.08 : 100;
}

const fmt = (v, d) => (isNum(v) ? (d ? v.toFixed(d) : String(Math.round(v))) : null);
const withUnit = (v, unit, d = 0, kind = null) => (isNum(v) ? { node: h("span", {}, fmt(v, d), h("span", { class: "lx-rt-u", text: unit })), v: kind } : null);

// ---------------------------------------------------------------- the view
let V = null;

export function mount(el, ctx) {
  unmount();
  const { store, bridge } = ctx;
  registerRuntimeKinds();
  ensureRt(store);
  const inst = { el, store, bridge, disposers: [], fields: new Map() };
  V = inst;
  el.classList.add("lx-rt-host");
  el.dataset.view = "power";

  // PACKAGE POWER LIMITS
  const cols = [
    { key: "lbl", label: "Limit" },
    { key: "now", label: "In force", num: true },
    { key: "f", label: "New value", field: true },
    { key: "m", label: "", mark: true },
    { key: "boot", label: "At boot", num: true },
  ];
  const table = createTable({ columns: cols, label: "Package power limits" });
  table.setRows([...FIELDS.map((f) => ({ key: f.key, cells: {} })), { key: "pl4", cells: {} }]);
  for (const f of FIELDS) {
    const tr = table.row(f.key);
    fillCell(tr.cells_.lbl, { node: label(f.hint) });
    const whyRow = h("tr", { class: "lx-why-row", hidden: true, dataset: { whyFor: f.key } }, h("td", { colspan: String(cols.length) }));
    tr.after(whyRow);
    const e = { f, field: null, tr, whyRow, max: undefined };
    inst.fields.set(f.key, e);
    placeField(inst, e, null);

  }
  const pl4Tr = table.row("pl4");
  const q = createQ("power.pl4", { colspan: cols.length });
  fillCell(pl4Tr.cells_.lbl, { node: h("span", {}, label("power.pl4"), q.button) });
  pl4Tr.after(q.more);
  inst.pl4 = pl4Tr;
  inst.table = table;
  const lockMeta = h("span", { class: "lx-mono", dataset: { hint: "power.lock" } });
  const meta = lockMeta;
  const restore = restoreButton(store, "power");
  inst.restore = restore;
  inst.lockMeta = lockMeta;
  inst.err = why(null);
  const lp = panel({ title: "Package power limits", meta, end: restore.el, body: [table.el, h("div", { class: "lx-rt-foot" }, inst.err)], flush: true, id: "pwr-limits" });
  lp.el.dataset.panel = "limits";

  // LIVE
  const nowV = h("span", { class: "lx-pwr-now-v", dataset: { live: "pkg" }, text: "—" });
  const binds = h("span", { class: "lx-mono", dataset: { live: "binds" }, text: "n/a" });
  const yOpts = { min: 0, max: 100, fmt: String, title: "W" };
  const plot = createPlot({
    label: "Package power over the last " + LIVE_SAMPLES + " samples against the power limits",
    height: 200,
    margin: { l: 40, r: 12, t: 20, b: 30 },
    x: { min: -(LIVE_SAMPLES - 1), max: 0, ticks: [-45, -30, -15, 0], fmt: (t) => (t === 0 ? "now" : String(t)), title: "samples" },
    y: yOpts,
    readout: (x) => {
      const hist = liveHistory(store);
      const v = hist[hist.length - 1 + x];
      return isNum(v) ? [["PKG", v.toFixed(1), "W"]] : [["PKG", "n/a"]];
    },
  });
  inst.plot = plot;
  inst.yOpts = yOpts;
  inst.nowV = nowV;
  inst.binds = binds;
  const legend = h("div", { class: "lx-legend" }, h("span", {}, h("i", { class: "lx-sw" }), "package"), h("span", {}, h("i", { class: "lx-sw lx-sw--ref" }), "limits in force"));
  const rp = panel({
    title: "Live",
    meta: "package power",
    body: [
      h("div", { class: "lx-pwr-now", dataset: { hint: "power.live" } }, nowV, h("span", { class: "lx-pwr-now-u", text: "W" })),
      h("div", { class: "lx-pwr-line", dataset: { hint: "power.binds" } }, h("span", { class: "lx-pwr-ro", text: "Binds now " }), binds),
      plot.el,
      legend,
    ],
    id: "pwr-live",
  });
  rp.el.classList.add("lx-pwr-live");
  rp.el.dataset.panel = "live";

  el.append(h("div", { class: ["lx-tiles", "lx-split-side", "lx-pwr"] }, lp.el, rp.el));

  inst.disposers.push(store.watch((s) => s.rt, () => paint(inst)));
  inst.disposers.push(store.watch((s) => s.tune && s.tune.read && s.tune.read.state, () => paint(inst)));
  inst.disposers.push(store.watch((s) => s.mode, () => restore.update()));
  inst.disposers.push(store.watch((s) => s.telemetry, () => paintTele(inst)));
  inst.disposers.push(
    store.watch((s) => s.link.state, (state) => {
      paint(inst);
      if (state === "connected" && store.get().rt.power.state === "idle") void loadRead(store, bridge, "power");
    }),
  );
  paint(inst);
  paintTele(inst);
  const s = store.get();
  if (s.link.state === "connected" && s.rt.power.state !== "reading") void loadRead(store, bridge, "power"); // the journal of this boot may have changed since the last visit
}

export function unmount() {
  const inst = V;
  if (!inst) return;
  V = null;
  for (const d of inst.disposers.splice(0)) d();
  inst.plot.dispose();
  clear(inst.el);
  inst.el.classList.remove("lx-rt-host");
  delete inst.el.dataset.view;
}

function commit(inst, key, v) {
  if (V !== inst) return;
  editRt(inst.store, (e) => {
    const cur = powerCurrent(inst.store.get().rt.power.result)[key];
    const power = { ...e.power };
    if (isNum(cur) && Math.abs(cur - v) < 1e-9) delete power[key];
    else power[key] = v;
    return { ...e, power };
  });
}

/** Why the fields cannot be edited now: {state, key, vars} | null (said once, under the table). */
function fieldsLock(st) {
  const l = rtLock(st, "power");
  if (l) return l;
  const result = st.rt.power.result;
  if (result.locked === true) return { state: "disabled", key: "locked.power_lock", vars: {} };
  const reason = powerDisabledReason(result);
  if (reason) return { state: "disabled", key: "locked.unavailable", vars: { reason } };
  if (!powerRead(normCpuLimits(result.cpu_limits))) return { state: "disabled", key: "locked.no_read", vars: {} };
  return null;
}

function paint(inst) {
  if (V !== inst) return;
  const st = inst.store.get();
  const r = st.rt.power;
  const result = r.result;
  const cur = powerCurrent(result);
  const edit = st.rt.edits.power;
  const cl = normCpuLimits(result ? result.cpu_limits : null);
  const lock = fieldsLock(st);
  paintBounds(inst, cl);
  for (const { f, field, tr, whyRow } of inst.fields.values()) {
    const pending = f.key in edit && edit[f.key] !== cur[f.key];
    const c = tr.cells_;
    const disagree = result && powerDisagrees(result, f.key);
    const msr = result && result.msr && result.msr.limit ? result.msr.limit[f.key] : null;
    fillCell(c.now, isNum(cur[f.key]) ? { node: h("span", {}, fmt(cur[f.key], f.decimals), h("span", { class: "lx-rt-u", text: f.unit }), disagree ? h("span", { class: "lx-rt-u", text: "MSR " + fmt(msr, f.decimals) }) : null) } : r.state === "reading" ? { text: "—", v: "none" } : { text: "n/a", na: true });
    fillCell(c.boot, result && result.boot && isNum(result.boot[f.key]) ? withUnit(result.boot[f.key], f.unit, f.decimals, "base") : { text: "—", v: "none" });
    fillCell(c.m, pending ? { node: mark() } : "");
    if (pending) tr.dataset.state = "edit";
    else tr.removeAttribute("data-state");
    if (field.state() !== "refused") field.set(pending ? edit[f.key] : cur[f.key]); // a refusal stays until the operator acts on the field
    if (lock) field.setState(lock.state);
    else field.setState(pending ? "set" : "idle");
    whyRow.hidden = field.whyEl.hidden;
  }
  // band: the lock state of MSR 0x610 (short); the fields' reason once, under the table (a band end with a long why would hide the meta)
  const lockedBit = result && result.locked === true ? true : cl && cl.power ? cl.power.locked : null;
  inst.lockMeta.textContent = lockedBit === true ? "MSR 0x610 locked" : lockedBit === false ? "MSR 0x610 unlocked" : "";
  inst.lockMeta.dataset.locked = lockedBit === null ? "" : String(lockedBit);
  setWhy(inst.err, lock && lock.state === "disabled" ? lock.key : null, lock ? lock.vars : {});
  paintPl4(inst, result, cl);
  inst.restore.update();
}

/** The field window from the read: PL1/PL2 up to the PL field maximum (MSR 0x610), refused above it with that source. Rebuilt only when it changes. */
function paintBounds(inst, cl) {
  const max = cl && cl.power && isNum(cl.power.plMaxW) ? Math.floor(cl.power.plMaxW) : null;
  for (const key of ["pl1_w", "pl2_w"]) placeField(inst, inst.fields.get(key), max);
}

/** (Re)create the field of a row for a window top `max` (null = not read): the field component takes its window at creation. */
function placeField(inst, e, max) {
  if (e.max === max) return;
  e.max = max;
  const { f } = e;
  const old = e.field;
  const field = createField({
    label: HINTS[f.hint].label + " " + HINTS[f.hint].term,
    hint: f.hint,
    unit: f.unit,
    width: f.width,
    decimals: f.decimals,
    step: f.step,
    bigStep: f.big,
    stepper: true,
    min: f.key === "tau_s" ? 10 ** -f.decimals : 1,
    max,
    source: "MSR 0x610 field",
    allow: (v) => {
      const r = inst.store.get().rt;
      return powerOrder(powerCurrent(r.power.result), r.edits.power, f.key, v);
    },
    onCommit: (v) => commit(inst, f.key, v),
  });
  field.el.dataset.key = f.key;
  fillCell(e.tr.cells_.f, { node: field.el });
  clear(e.whyRow.firstChild).append(field.whyEl);
  for (const ev of ["change", "keydown", "blur", "click"]) field.el.addEventListener(ev, () => queueMicrotask(() => (e.whyRow.hidden = field.whyEl.hidden)));
  if (old) {
    field.set(old.value());
    field.setState(old.state() === "refused" ? "idle" : old.state());
  }
  e.field = field;
}

function footText(result, cl, pl4Note = "") {
  const parts = [];
  if (pl4Note) parts.push(pl4Note);
  if (cl && cl.power && isNum(cl.power.plMaxW)) parts.push("PL field max " + Math.floor(cl.power.plMaxW) + " W (MSR 0x610)");
  if (result && result.msr && result.msr.info && isNum(result.msr.info.tdp_w)) parts.push("base power " + result.msr.info.tdp_w + " W (MSR 0x614), not a ceiling");
  parts.push(HINTS["power.pl4_copy"].line);
  return parts.join(" · ");
}

/** Telemetry ticks repaint the PL4 row and the LIVE panel, never the fields. */
function paintTele(inst) {
  if (V !== inst) return;
  const result = inst.store.get().rt.power.result;
  paintPl4(inst, result, normCpuLimits(result ? result.cpu_limits : null));
  paintLive(inst);
}

function paintPl4(inst, result, cl) {
  const p4 = pl4Display(inst.store.get().telemetry.values);
  const c = inst.pl4.cells_;
  fillCell(c.now, isNum(p4.watts) ? withUnit(p4.watts, "W", Number.isInteger(p4.watts) ? 0 : 1) : { text: "n/a", na: true });
  fillCell(c.f, { node: h("span", { class: "lx-pwr-ro", dataset: { pl4: p4.locked === null ? "unknown" : p4.locked ? "locked" : "unlocked" } }, p4.locked === null ? "read only" : "read only · " + (p4.locked ? "locked" : "unlocked")) });
  inst.table.foot(footText(result, cl, p4.locked === null ? "PL4 n/a: " + p4.note : ""));
  fillCell(c.boot, { text: "—", v: "none" });
  fillCell(c.m, "");
  inst.pl4.dataset.locked = p4.locked === null ? "" : String(p4.locked);
}

function liveHistory(store) {
  const h_ = store.get().telemetry.history;
  const arr = h_ && Array.isArray(h_.pkg_power) ? h_.pkg_power : [];
  return arr.slice(-LIVE_SAMPLES);
}

/** The LIVE panel: repainted on telemetry ticks only (never the fields). */
function paintLive(inst) {
  if (V !== inst) return;
  const st = inst.store.get();
  const hist = liveHistory(inst.store);
  const last = hist.length ? hist[hist.length - 1] : null;
  inst.nowV.textContent = isNum(last) ? last.toFixed(1) : "n/a";
  inst.binds.textContent = bindsNow(st.telemetry.throttle);
  const cur = powerCurrent(st.rt.power.result);
  const pl4 = pl4Display(st.telemetry.values).watts;
  const refs = [
    { y: cur.pl1_w, label: "PL1 " + fmt(cur.pl1_w, 0) },
    { y: cur.pl2_w, label: "PL2 " + fmt(cur.pl2_w, 0) },
    { y: pl4, label: "PL4 " + fmt(pl4, 0) },
  ].filter((r) => isNum(r.y));
  const top = liveTop(hist, refs.map((r) => r.y));
  inst.yOpts.max = top;
  inst.yOpts.ticks = niceTicks(0, top, 4).filter((t) => t <= top);
  const pts = [];
  hist.forEach((v, i) => isNum(v) && pts.push([i - (hist.length - 1), v]));
  inst.plot.draw({ traces: pts.length ? [{ kind: "meas", pts }] : [], refs, cursorXs: pts.map((p) => p[0]) });
}
