// views/tune/grid.js: the UNITS pane of Tune › Cores (desktop/DESIGN.md §5.13, §9.2): the shared unit table (components/unit-table.js) with groups P-CORES /
// E-CLUSTERS (one unit of four CPUs: one ratio, one curve) / RING, multi-select (click, Ctrl/Shift-click, ↑/↓, Space, Ctrl+A), columns Top × and OC ×
// (≥ 1180 px only), Offset mV (the deepest EFFECTIVE offset: whole curve + point) and the live Clock GHz, and the pending-mark column. It replaces the tile
// grid of G-208. `unitFace()` / `liveFace()` are pure (node-tested); cells update in place, rows never rebuild while the read stays.
import { h } from "../../components/dom.js";
import { panel } from "../../components/panel.js";
import { createUnitTable, unitsFromModel } from "../../components/unit-table.js";
import { HINTS } from "../../lib/hints.js";
import { isNum } from "../../lib/format.js";
import { favoredIds, fusedTopOf, sameMv, aboveTop } from "../../lib/units.js";
import { effPointMv, readPointMv, effRatio, curRatio, diff } from "../../lib/draft.js";
import { ocShown } from "./oc.js";
import { mvText } from "./curve-editor.js";
import { ringNow } from "../../lib/ringclock.js";

const leafNum = (l) => (l && typeof l === "object" && l.status !== "unavailable" && typeof l.value === "number" && Number.isFinite(l.value) ? l.value : null);

/** Live numbers of a unit from a telemetry `values` object: highest clock of its CPUs, hottest per-core temperature if reported, highest VID. Null = n/a. */
export function liveFace(unit, values) {
  const cores = (values && values.cores) || {};
  const pick = (f) => {
    const xs = (unit.cpus || []).map((c) => leafNum(cores[String(c)] && cores[String(c)][f])).filter(isNum);
    return xs.length ? Math.max(...xs) : null;
  };
  const temps = (values && values.temps) || {};
  const tv = (unit.cpus || []).map((c) => leafNum(temps["Core " + c] || temps["cpu" + c] || temps["CPU " + c])).filter(isNum);
  return { mhz: pick("mhz"), temp: tv.length ? Math.max(...tv) : null, vid: pick("vid") };
}

/**
 * One unit's row values: {top (factory top ratio; the ring's highest point), oc ({ratio, edited, boot}: an OC ratio above stock, or the ratio the BIOS set above the
 * fused top), deepest (the lowest EFFECTIVE offset, whole curve + point, mV), deepestRead, edited (the unit holds edits)}.
 */
export function unitFace(model, draft, id, edits = null) {
  const u = model.units[id];
  const offs = u.points.map((p) => effPointMv(draft, u, p)).filter(isNum);
  const reads = u.points.map((p) => (u.kind === "R" ? p.offset_mv : readPointMv(u, p))).filter(isNum);
  const edited = edits ? (edits[id] || 0) > 0 : !!draft.units[id];
  if (u.kind === "R") {
    const rs = u.points.filter((p) => !p.ocSlot).map((p) => p.ratio).filter(isNum);
    return { id, kind: "R", top: rs.length ? Math.max(...rs) : null, oc: { ratio: null, edited: false, boot: false }, deepest: offs.length ? Math.min(...offs) : null, deepestRead: reads.length ? Math.min(...reads) : null, edited };
  }
  const r = effRatio(draft, u);
  const shown = ocShown(u, r);
  const ab = shown === null ? aboveTop(model, u, r) : null;
  return {
    id,
    kind: u.kind,
    top: fusedTopOf(u),
    oc: { ratio: shown ?? (ab ? ab.max : null), edited: !!(draft.units[id] && draft.units[id].ratio !== undefined && draft.units[id].ratio !== curRatio(u)), boot: !!ab },
    deepest: offs.length ? Math.min(...offs) : null,
    deepestRead: reads.length ? Math.min(...reads) : null,
    edited,
  };
}
/** Pre-R-S1 name of unitFace (apply.test.mjs reads `.deepest`). */
export const tileFace = (model, draft, id) => unitFace(model, draft, id);

/** The UNITS pane. `tc` = the Tune controller. Returns {el, table, update(), dispose()}. */
export function createUnitPane(tc) {
  let built = null;
  let faces = new Map();
  let fractional = false;
  const live = () => tc.store.get().telemetry.values;
  const face = (u) => faces.get(u.id) || null;
  const pad = (text) => (fractional && !/[.]/.test(text) ? text + "  " : text); // DESIGN §3.5: whole values padded so decimals align
  const columns = [
    { key: "top", label: "Curve top", unit: "×", num: true, wide: true, hint: "unit.top", value: (u) => (face(u) && isNum(face(u).top) ? { text: String(face(u).top), v: "base" } : null) },
    {
      key: "oc", label: "OC", unit: "×", num: true, wide: true, hint: "oc.ratio",
      value: (u) => {
        const f = face(u);
        return f && isNum(f.oc.ratio) ? { text: String(f.oc.ratio), v: f.oc.edited ? "set" : null } : null;
      },
    },
    {
      key: "off", label: "Offset", unit: "mV", num: true, hint: "unit.offset",
      value: (u) => {
        const f = face(u);
        if (!f || !isNum(f.deepest)) return { text: "n/a", na: true };
        const changed = !(isNum(f.deepestRead) && sameMv(f.deepest, f.deepestRead));
        return { text: pad(mvText(f.deepest)), v: f.edited && changed ? "set" : null };
      },
    },
    {
      key: "clk", label: "Clock", unit: "GHz", num: true, hint: "unit.clock",
      value: (u) => {
        const unit = tc.state().model && tc.state().model.units[u.id];
        if (!unit) return { text: "n/a", na: true };
        if (unit.kind === "R") {
          const rn = ringNow(live()); // G-250: the ring's live clock (telemetry values.ring, G-243); n/a only when the helper does not report it
          return isNum(rn.mhz) ? (rn.mhz / 1000).toFixed(2) : { text: "n/a", na: true };
        }
        const lf = liveFace(unit, live());
        return isNum(lf.mhz) ? (lf.mhz / 1000).toFixed(2) : { text: "n/a", na: true };
      },
    },
  ];
  const table = createUnitTable({
    columns,
    label: "Units",
    id: "tune-units",
    marks: (u) => !!(face(u) && face(u).edited),
    onSelect: (ids, anchor) => {
      if (!ids.length) {
        // a unit stays selected: the inspector always shows one
        const s = tc.state();
        table.setSelection(s.selection, s.anchor);
        return;
      }
      tc.setSelection(ids, anchor);
    },
  });
  const off = HINTS["unit.offset"];
  const foot = h("div", { class: "lx-tfoot-note", dataset: { foot: "units" }, text: off.label + " = " + off.line.charAt(0).toLowerCase() + off.line.slice(1) });
  const p = panel({ title: "Units", meta: "Ctrl/Shift-click selects several", body: [table.el, foot], flush: true, scroll: true, label: "Units" });
  p.el.dataset.pane = "units";

  function recompute() {
    const s = tc.state();
    const edits = diff(s.model, s.draft).perUnit;
    faces = new Map(s.model.order.map((id) => [id, unitFace(s.model, s.draft, id, edits)]));
    fractional = [...faces.values()].some((f) => isNum(f.deepest) && /[.]/.test(mvText(f.deepest)));
  }

  function update() {
    const s = tc.state();
    if (!s.model) return;
    recompute();
    if (built !== s.model) {
      built = s.model;
      table.setUnits(unitsFromModel(s.model, favoredIds(s.model)));
    }
    table.setSelection(s.selection, s.anchor);
    table.refresh();
  }

  const offTune = tc.store.watch((st) => st.tune, () => update());
  const offTel = tc.store.watch((st) => st.telemetry.values, () => built && table.refresh());
  return { el: p.el, table, update, dispose: () => (offTune(), offTel()) };
}

