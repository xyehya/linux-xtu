// components/table.js: the data table (desktop/DESIGN.md §5.8). One table for every grid of values: header 26 px with the unit after the label,
// numeric columns right-aligned mono, 24 px rows, group caption rows, cell states through attributes (data-v = meas | base | set | none, .lx-na), row
// states (aria-selected, data-state = edit | refused). Limits, sources and n/a reasons are said once in the footnote, never per row.
import { h, clear } from "./dom.js";

export const VARIANTS = ["fill", "dense", "compact", "kv"];
export const VALUE_KINDS = ["meas", "base", "set", "none"];

/** One cell value -> {text, v, na, node}: a string/number is measured text; {text, v, na} as given; null -> "—" (not applicable). */
export function cellValue(x) {
  if (x === null || x === undefined) return { text: "—", v: "none", na: false, node: null };
  if (typeof x === "string" || typeof x === "number") return { text: String(x), v: null, na: false, node: null };
  if (typeof Node !== "undefined" && x instanceof Node) return { text: "", v: null, na: false, node: x };
  return { text: x.text ?? "", v: VALUE_KINDS.includes(x.v) ? x.v : null, na: !!x.na, node: x.node ?? null };
}

/** Fill a <td> from a cell value (in place; the element survives). */
export function fillCell(td, x) {
  const c = cellValue(x);
  if (c.v) {
    if (td.dataset.v !== c.v) td.dataset.v = c.v;
  } else if (td.getAttribute("data-v") !== null) td.removeAttribute("data-v");
  if (c.node) {
    // A node that is already the cell's only child stays put (no remove + re-insert: AT-SPI holds an accessible object per node, G-247).
    if (!(td.childNodes.length === 1 && td.firstChild === c.node)) clear(td).append(c.node);
  } else if (c.na) {
    const text = c.text || "n/a";
    const only = td.childNodes.length === 1 ? td.firstChild : null;
    if (only && only.nodeType === 1 && only.classList.contains("lx-na")) {
      if (only.textContent !== text) only.textContent = text; // the n/a span survives every tick
    } else clear(td).append(h("span", { class: "lx-na", text }));
  } else if (td.childNodes.length === 1 && td.firstChild.nodeType === 3) {
    if (td.firstChild.data !== c.text) td.firstChild.data = c.text;
  } else {
    clear(td).append(c.text);
  }
  return td;
}

/**
 * createTable({columns, variant, label, foot, id}) -> {el (wrapper), table, tbody, setRows(rows), row(key), foot(text)}.
 *   columns: [{key, label, unit, num, field, mark, wide, hint, cls}] — `num` right-aligns + mono; `field` aligns the header to a field's edge;
 *            `mark` is the 14 px pending-mark column; `wide` hides below 1180 px.
 *   rows:    [{key, group: {label, n}} | {key, cells: {colKey: value}, state, selected, attrs}]
 */
export function createTable({ columns, variant = ["fill"], label, foot = "", id } = {}) {
  const vs = [].concat(variant);
  for (const v of vs) if (!VARIANTS.includes(v)) throw new Error(`table: variant "${v}"`);
  const colCls = (c) => [c.num ? "lx-n" : "", c.field ? "lx-f" : "", c.mark ? "lx-m" : "", c.wide ? "lx-wide" : "", c.cls || ""];
  const head = h("tr", {}, ...columns.map((c) => h("th", { class: colCls(c), scope: "col", dataset: { col: c.key, ...(c.hint ? { hint: c.hint } : {}) } }, c.label ?? "", c.unit ? h("span", { class: "lx-hu", text: c.unit }) : null)));
  const tbody = h("tbody");
  const table = h("table", { class: ["lx-tbl", ...vs.map((v) => `lx-tbl--${v}`)], "aria-label": label, id }, h("thead", {}, head), tbody);
  const footEl = h("div", { class: "lx-tfoot-note", hidden: !foot, text: foot });
  const el = h("div", { class: "lx-tbl-wrap" }, table, footEl);
  const rows = new Map();

  const paintRow = (tr, r) => {
    if (r.selected === undefined) {
      if (tr.getAttribute("aria-selected") !== null) tr.removeAttribute("aria-selected");
    } else if (tr.getAttribute("aria-selected") !== String(!!r.selected)) tr.setAttribute("aria-selected", String(!!r.selected));
    if (r.state) {
      if (tr.dataset.state !== r.state) tr.dataset.state = r.state;
    } else if (tr.getAttribute("data-state") !== null) tr.removeAttribute("data-state");
    for (const c of columns) fillCell(tr.cells_[c.key], r.cells ? r.cells[c.key] : undefined);
  };

  return {
    el,
    table,
    tbody,
    /** Replace the rows. Rows with the same keys in the same order are updated in place (focus and scroll survive). */
    setRows(list) {
      const same = list.length === rows.size && list.every((r, i) => [...rows.keys()][i] === r.key);
      if (!same) {
        clear(tbody);
        rows.clear();
        for (const r of list) {
          let tr;
          if (r.group) {
            tr = h("tr", { class: "lx-grp", dataset: { group: r.key } }, h("th", { colspan: columns.length, scope: "rowgroup" }, r.group.label, r.group.n !== undefined && r.group.n !== "" ? h("span", { class: "lx-grp-n", text: String(r.group.n) }) : null));
          } else {
            tr = h("tr", { dataset: { row: r.key }, ...(r.attrs || {}) });
            tr.cells_ = {};
            for (const c of columns) {
              const td = h("td", { class: colCls(c) });
              tr.cells_[c.key] = td;
              tr.append(td);
            }
          }
          rows.set(r.key, { tr, r });
          tbody.append(tr);
        }
      }
      for (const r of list) {
        const e = rows.get(r.key);
        e.r = r;
        if (!r.group) paintRow(e.tr, r);
      }
    },
    row: (key) => (rows.get(key) || {}).tr || null,
    foot(text) {
      footEl.textContent = text || "";
      footEl.hidden = !text;
    },
  };
}
