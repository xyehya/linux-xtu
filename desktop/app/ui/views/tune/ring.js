// views/tune/ring.js: Tune › Ring & uncore (R-S2; desktop/DESIGN.md §9.5, assessment 03 U-24, WP-6). The ring clock range only:
//   RING CLOCK RANGE  Minimum / Maximum (uncore min/max ratio: intel_uncore_frequency package_00_die_00 {min,max}_freq_khz, runtime) — In force · New value · Driver
//                     (the driver's initial range at boot); a plain note that the NGU and D2D clocks are separate BIOS settings this tab never moves.
//   RING NOW          the live ring clock from the helper's telemetry (`values.ring` {mhz, ratio}: sysfs current_freq_khz, else MSR 0x621 [6:0]; n/a with the reason
//                     only when it cannot be read; QA-20) and a pointer to the ring's V/F offsets, which are
//                     edited only in Tune › Cores (the Ring row): no ring V/F editor here.
// Edits live in the runtime slice (lib/rtstate.js `rt.edits.uncore`) and reach the CPU only through the pending row's Review and the commit sheet
// (kind "runtime": runtime.plan {uncore: {min_ratio?, max_ratio?}}). The minimum above the maximum is refused in the field (refused.uncore_order*).
// "Restore boot caps and uncore…" puts back the ratio caps AND the ring range together (one journal, U-24), and says so.
// D-049: the window is the CPU's own (`cpu_limits.uncore_khz` = the driver's initial range); without it the fields say "Read first".
//   mount(el, ctx) / unmount();  ctx = subTabContext of views/tune.js.
import { h, clear } from "../../components/dom.js";
import { createField } from "../../components/field.js";
import { createTable, fillCell } from "../../components/table.js";
import { panel, box, kv } from "../../components/panel.js";
import { button } from "../../components/buttons.js";
import { mark } from "../../components/ann.js";
import { why, setWhy, label, createQ } from "../../components/help.js";
import { isNum } from "../../lib/format.js";
import { HINTS } from "../../lib/hints.js";
import { RING_ID } from "../../lib/units.js";
import { ensureRt, editRt, uncoreState } from "../../lib/rtstate.js";
import { normCpuLimits, uncoreWindow, READ_FIRST } from "../../lib/cpulimits.js";
import { loadRead, registerRuntimeKinds } from "./runtime-kinds.js";
import { restoreButton, rtLock } from "./rt-common.js";
import { ringNow } from "../../lib/ringclock.js";

export { ringNow }; // QA-20 (moved to lib/ringclock.js, G-250: the Cores unit table shows the same clock)

const TIMES = "×";
export const UNCORE = [
  { key: "min_ratio", hint: "uncore.min", file: "min_freq_khz" },
  { key: "max_ratio", hint: "uncore.max", file: "max_freq_khz" },
];

// ---------------------------------------------------------------- pure (node-tested)


/** Why the uncore fields are off ("" = usable). Kept for the G-217 tests and callers. */
export function uncoreDisabledReason(result, cl) {
  if (!result) return "Read the uncore state first";
  if (!result.uncore) return result.uncore_note || "this machine has no intel_uncore_frequency interface";
  if (Array.isArray(result.offline) && result.offline.length) return "CPU " + result.offline.join(", ") + " is offline: runtime writes are refused while any CPU is offline";
  if (!uncoreWindow(cl)) return READ_FIRST + " (the uncore window comes from that read)";
  return "";
}

/** The order rule of the range: min ≤ max. `cur` = {min, max} in force, `edit` = pending, `key`/`v` = the value being typed. -> null | {key, vars} of WHY. */
export function uncoreOrder(cur, edit, key, v) {
  const lo = key === "min_ratio" ? v : (edit.min_ratio ?? (cur ? cur.min : null));
  const hi = key === "max_ratio" ? v : (edit.max_ratio ?? (cur ? cur.max : null));
  if (!isNum(lo) || !isNum(hi) || lo <= hi) return null;
  return key === "min_ratio" ? { key: "refused.uncore_order", vars: { max: String(hi) } } : { key: "refused.uncore_order_max", vars: { min: String(lo) } };
}

/** Why the fields cannot take an edit now: {state, key, vars} | null (rtLock first, then the read's own answer). */
export function uncoreLock(st) {
  const l = rtLock(st, "runtime");
  if (l) return l;
  const result = st.rt.runtime.result;
  if (!result.uncore) return { state: "disabled", key: "locked.unavailable", vars: { reason: result.uncore_note || "this machine has no intel_uncore_frequency interface" } };
  if (Array.isArray(result.offline) && result.offline.length) return { state: "disabled", key: "locked.cpu_offline", vars: { cpu: result.offline.join(", ") } };
  if (!uncoreWindow(normCpuLimits(result.cpu_limits))) return { state: "disabled", key: "locked.no_read", vars: {} };
  return null;
}

// ---------------------------------------------------------------- the view
let V = null;

export function mount(el, ctx) {
  unmount();
  const { store, bridge } = ctx;
  registerRuntimeKinds();
  ensureRt(store);
  const inst = { el, store, bridge, ctx, disposers: [], rows: new Map(), winKey: undefined };
  V = inst;
  el.classList.add("lx-rt-host");
  el.dataset.view = "uncore";

  const cols = [
    { key: "lbl", label: "Limit" },
    { key: "now", label: "In force", unit: TIMES, num: true },
    { key: "f", label: "New value", field: true },
    { key: "m", label: "", mark: true },
    { key: "drv", label: "Driver", unit: TIMES, num: true, hint: "uncore.driver" },
  ];
  const table = createTable({ columns: cols, label: "Ring clock range" });
  table.setRows(UNCORE.map((u) => ({ key: u.key, cells: {} })));
  for (const u of UNCORE) {
    const tr = table.row(u.key);
    fillCell(tr.cells_.lbl, { node: h("span", {}, label(u.hint)) });
    const whyRow = h("tr", { class: "lx-why-row", hidden: true, dataset: { whyFor: u.key } }, h("td", { colspan: String(cols.length) }));
    tr.after(whyRow);
    inst.rows.set(u.key, { u, tr, whyRow, field: null });
  }
  const q = createQ("uncore.max", { colspan: cols.length });
  table.row("max_ratio").cells_.lbl.firstChild.append(q.button);
  inst.rows.get("max_ratio").whyRow.after(q.more);
  inst.table = table;
  inst.err = why(null);
  const restore = restoreButton(store, "runtime");
  inst.restore = restore;
  const ngu = box({ title: HINTS["uncore.separate"].label, body: h("p", { dataset: { hint: "uncore.separate" }, text: HINTS["uncore.separate"].line }) });
  ngu.dataset.note = "ngu-d2d";
  const lp = panel({
    title: "Ring clock range",
    meta: h("span", {}, "uncore ratio · ", h("span", { class: "lx-mono", text: "intel_uncore_frequency" })),
    end: restore.el,
    body: [table.el, h("div", { class: "lx-rt-foot" }, inst.err), ngu],
    flush: true,
    id: "unc-range",
  });
  lp.el.dataset.panel = "range";

  // RING NOW: the live ring clock from the helper's telemetry (QA-20); the V/F offsets live in Cores
  const go = button({
    level: 0,
    label: "Open Tune › Cores › Ring",
    hint: "ring.vf",
    onClick: () => {
      const tc = ctx.tune;
      if (!tc) return;
      const m = tc.state().model;
      if (m && m.units && m.units[RING_ID]) tc.setSelection([RING_ID], RING_ID);
      tc.setSubtab("cores");
    },
  });
  go.dataset.action = "open-ring-vf";
  const nowNa = h("span", { class: "lx-na", dataset: { live: "ring" }, text: "n/a" });
  const nowWhy = why(null);
  const paintNow = () => {
    const n = ringNow(store.get().telemetry.values);
    nowNa.textContent = n.text;
    nowNa.classList.toggle("lx-na", n.ratio === null);
    nowNa.dataset.value = n.ratio === null ? "" : String(n.ratio);
    setWhy(nowWhy, n.ratio === null ? "locked.unavailable" : null, { reason: n.note });
  };
  const rp = panel({
    title: "Ring now",
    body: [
      ringKv(nowNa),
      nowWhy,
      h("div", { class: "lx-unc-vf", dataset: { hint: "ring.vf" } }, h("span", { class: "lx-lbl", text: HINTS["ring.vf"].label }), go),
    ],
    id: "unc-now",
  });
  rp.el.dataset.panel = "now";
  el.append(h("div", { class: ["lx-tiles", "lx-split-side", "lx-unc"] }, lp.el, rp.el));

  inst.disposers.push(store.watch((s) => s.telemetry.values, paintNow));
  paintNow();
  inst.disposers.push(store.watch((s) => s.rt, () => paint(inst)));
  inst.disposers.push(store.watch((s) => s.tune && s.tune.read && s.tune.read.state, () => paint(inst)));
  inst.disposers.push(store.watch((s) => s.mode, () => restore.update()));
  inst.disposers.push(
    store.watch((s) => s.link.state, (state) => {
      paint(inst);
      if (state === "connected" && store.get().rt.runtime.state === "idle") void loadRead(store, bridge, "runtime");
    }),
  );
  paint(inst);
  const s = store.get();
  if (s.link.state === "connected" && s.rt.runtime.state !== "reading") void loadRead(store, bridge, "runtime"); // the journal of this boot may have changed since the last visit
}

export function unmount() {
  const inst = V;
  if (!inst) return;
  V = null;
  for (const d of inst.disposers.splice(0)) d();
  clear(inst.el);
  inst.el.classList.remove("lx-rt-host");
  delete inst.el.dataset.view;
}

function ringKv(value) {
  const dl = kv([[HINTS["ring.now"].label, value, { mono: true }]]);
  dl.dataset.hint = "ring.now";
  return dl;
}

function commit(inst, key, v) {
  if (V !== inst) return;
  editRt(inst.store, (e) => {
    const cur = uncoreState(inst.store.get().rt.runtime.result);
    const now = cur ? (key === "min_ratio" ? cur.min : cur.max) : null;
    const uncore = { ...e.uncore };
    if (now === v) delete uncore[key];
    else uncore[key] = v;
    return { ...e, uncore };
  });
}

/** (Re)create the two fields when the window changes (the field takes its window at creation). */
function placeFields(inst, win) {
  const k = JSON.stringify(win);
  if (k === inst.winKey) return;
  inst.winKey = k;
  for (const e of inst.rows.values()) {
    const { u } = e;
    const old = e.field;
    const f = createField({
      label: HINTS[u.hint].label,
      hint: u.hint,
      unit: TIMES,
      width: 3,
      decimals: 0,
      step: 1,
      bigStep: 4,
      stepper: true,
      min: win ? win.min : null,
      max: win ? win.max : null,
      source: "the driver’s initial range",
      allow: (v) => {
        const st = inst.store.get();
        return uncoreOrder(uncoreState(st.rt.runtime.result), st.rt.edits.uncore, u.key, v);
      },
      onCommit: (v) => commit(inst, u.key, v),
    });
    f.el.dataset.key = u.key;
    fillCell(e.tr.cells_.f, { node: f.el });
    clear(e.whyRow.firstChild).append(f.whyEl);
    for (const ev of ["change", "keydown", "blur", "click"]) f.el.addEventListener(ev, () => queueMicrotask(() => (e.whyRow.hidden = f.whyEl.hidden)));
    if (old) f.set(old.value());
    e.field = f;
  }
}

function paint(inst) {
  if (V !== inst) return;
  const st = inst.store.get();
  const r = st.rt.runtime;
  const result = r.result;
  const cl = normCpuLimits(result ? result.cpu_limits : null);
  const win = uncoreWindow(cl);
  placeFields(inst, win);
  const cur = uncoreState(result);
  const edit = st.rt.edits.uncore;
  const lock = uncoreLock(st);
  for (const { u, tr, whyRow, field } of inst.rows.values()) {
    const nowV = cur ? (u.key === "min_ratio" ? cur.min : cur.max) : null;
    const drv = cur ? (u.key === "min_ratio" ? cur.initialMin : cur.initialMax) : null;
    const pending = u.key in edit && edit[u.key] !== nowV;
    const c = tr.cells_;
    fillCell(c.now, isNum(nowV) ? String(nowV) : r.state === "reading" ? { text: "—", v: "none" } : { text: "n/a", na: true });
    fillCell(c.drv, isNum(drv) ? { text: String(drv), v: "base" } : { text: "—", v: "none" });
    fillCell(c.m, pending ? { node: mark() } : "");
    if (pending) tr.dataset.state = "edit";
    else tr.removeAttribute("data-state");
    if (field.state() !== "refused") field.set(pending ? edit[u.key] : nowV); // a refusal stays until the operator acts on the field
    if (lock) field.setState(lock.state);
    else field.setState(pending ? "set" : "idle");
    whyRow.hidden = field.whyEl.hidden;
  }
  setWhy(inst.err, lock && lock.state === "disabled" ? lock.key : null, lock ? lock.vars : {});
  inst.table.foot(win ? "Window " + win.min + "–" + win.max + TIMES + ": the driver’s initial range (initial_min/max_freq_khz) · " + HINTS["uncore.driver"].line : "");
  inst.restore.update();
}
