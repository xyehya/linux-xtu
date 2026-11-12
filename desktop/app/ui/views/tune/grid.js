// views/tune/grid.js: the UNITS pane of Tune › Cores (desktop/DESIGN.md §5.13, §9.2): the shared unit table (components/unit-table.js) with groups P-CORES /
// E-CLUSTERS (one unit of four CPUs: one ratio, one curve) / RING, multi-select (click, Ctrl/Shift-click, ↑/↓, Space, Ctrl+A), columns Top × (the unit's own ceiling:
// its OC ratio, else its fused max ratio; ≥ 1180 px only) and Offset mV (the deepest EFFECTIVE offset: whole curve + point), and the pending-mark column. Live clocks are on
// Overview. It replaces the tile grid of G-208. `unitFace()` is pure (node-tested); cells update in place, rows never rebuild while the read stays.
import { h } from "../../components/dom.js";
import { panel } from "../../components/panel.js";
import { createUnitTable, unitsFromModel } from "../../components/unit-table.js";
import { HINTS } from "../../lib/hints.js";
import { isNum } from "../../lib/format.js";
import { favoredIds, sameMv, topRatio } from "../../lib/units.js";
import { effPointMv, readPointMv, effRatio, curRatio, diff } from "../../lib/draft.js";
import { mvText } from "./curve-editor.js";

/**
 * One unit's row values: {top (the unit's own top ratio, lib/units.js topRatio), topOc (it is an OC / boot-set ratio), topFused (the fused max ratio beside an OC top), topEdited (the OC ratio
 * is a draft edit), deepest (the lowest EFFECTIVE offset, whole curve + point, mV), deepestRead, edited (the unit holds edits)}.
 */
export function unitFace(model, draft, id, edits = null) {
  const u = model.units[id];
  const offs = u.points.map((p) => effPointMv(draft, u, p)).filter(isNum);
  const reads = u.points.map((p) => (u.kind === "R" ? p.offset_mv : readPointMv(u, p))).filter(isNum);
  const edited = edits ? (edits[id] || 0) > 0 : !!draft.units[id];
  const t = topRatio(model, u, u.kind === "R" ? null : effRatio(draft, u));
  return {
    id,
    kind: u.kind,
    top: t ? t.ratio : null,
    topOc: !!(t && t.oc),
    topFused: t ? t.fused : null,
    topEdited: !!(u.kind !== "R" && draft.units[id] && draft.units[id].ratio !== undefined && draft.units[id].ratio !== curRatio(u)),
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
  const topNodes = new Map();
  const face = (u) => faces.get(u.id) || null;
  const pad = (text) => (fractional && !/[.]/.test(text) ? text + "  " : text); // DESIGN §3.5: whole values padded so decimals align
  const columns = [
    {
      key: "top", label: "Top", unit: "×", num: true, wide: true, hint: "unit.topratio",
      value: (u) => {
        const f = face(u);
        if (!f || !isNum(f.top)) return null;
        if (!f.topOc) return { text: String(f.top), v: "base" };
        let n = topNodes.get(u.id);
        if (!n || n.top !== f.top) topNodes.set(u.id, (n = { top: f.top, node: h("span", {}, String(f.top), h("span", { class: "lx-sub", text: " OC" })) })); // one node per value: the cell is not rebuilt on every refresh
        return { node: n.node, v: f.topEdited ? "set" : null };
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
  return { el: p.el, table, update, dispose: () => offTune() };
}

