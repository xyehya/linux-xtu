// components/unit-table.js: THE unit table (desktop/DESIGN.md §5.13; replaces the Tune tile grid and the dashboard core map as screens adopt it).
// One `.lx-tbl` with groups P-CORES / E-CLUSTERS / RING, multi-select (click, Ctrl/Cmd-click toggles, Shift-click selects the range from the anchor;
// ↑/↓ move, Shift+↑/↓ extend, Space toggles, Ctrl+A all of the focused kind), an optional `.lx-check` column (where selection is the point: Curves,
// Stress), optional live columns chosen per screen, and the pending-mark column (Tune). E-clusters show their CPU range. Never tiles, never a rainbow.
// Live columns update cell text in place (refresh()): rows never rebuild, values never move.
import { h, clear, setVar } from "./dom.js";
import { fillCell } from "./table.js";

export const GROUPS = [
  { kind: "P", label: "P-cores" },
  { kind: "E", label: "E-clusters" },
  { kind: "R", label: "Ring" },
];

const range = (cpus) => (Array.isArray(cpus) && cpus.length > 1 ? `${cpus[0]}–${cpus[cpus.length - 1]}` : Array.isArray(cpus) && cpus.length === 1 ? `cpu ${cpus[0]}` : "");

/** Rows from the units model of a read (lib/units.js modelFromRead): [{id, kind, name, sub, fav}]. `favored` = ids to star (lib/units favoredIds). */
export function unitsFromModel(model, favored = []) {
  if (!model || !Array.isArray(model.order)) return [];
  return model.order.map((id) => {
    const u = model.units[id];
    return { id, kind: u.kind, name: u.kind === "R" ? "Ring" : id, sub: u.kind === "R" ? "" : range(u.cpus), fav: favored.includes(id), cpus: u.cpus || [] };
  });
}

/** Rows from preflight.topology.units (live, D-036): [{id, kind, name, sub, fav, cpus}]; the ring is not a topology unit. */
export function unitsFromTopology(topology) {
  const list = topology && Array.isArray(topology.units) ? topology.units : [];
  return list
    .filter((u) => u && typeof u.id === "string" && (u.kind === "P" || u.kind === "E"))
    .map((u) => ({ id: u.id, kind: u.kind, name: u.id, sub: range(u.cpus), fav: u.favored === true, cpus: Array.isArray(u.cpus) ? u.cpus : [] }));
}

/** The selection after a click: single, Ctrl toggle, Shift range from `anchor` (in display order). Pure. -> {ids, anchor} */
export function clickSelect(order, current, anchor, id, { ctrl = false, shift = false } = {}) {
  if (shift && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { ids: ctrl ? [...new Set([...current, ...span])] : span, anchor };
  }
  if (ctrl) {
    const ids = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    return { ids: order.filter((x) => ids.includes(x)), anchor: id };
  }
  return { ids: [id], anchor: id };
}

/**
 * createUnitTable({units, columns, select, check, marks, label, id, onSelect, dense}) -> {el, table, setUnits(units), setSelection(ids, anchor),
 * selection(), refresh(), focus(), dispose()}.
 *   units    [{id, kind: "P"|"E"|"R", name, sub, fav}] (unitsFromModel / unitsFromTopology)
 *   columns  [{key, label, unit, num, wide, hint, value(unit) -> cell value (table.js cellValue), bar(unit) -> 0..1 | null}]
 *   select   "multi" (default) | "single" | "none"
 *   check    true: a checkbox column (Curves, Stress); clicking a row then toggles it
 *   marks(unit) -> true when the unit holds an edit (Tune): the 14 px mark column and the row's cyan edge
 *   onSelect(ids, anchor) — after every user change of the selection
 */
export function createUnitTable({ units = [], columns = [], select = "multi", check = false, marks = null, label = "Units", id, onSelect, dense = true, groups = true } = {}) {
  const cols = [...columns];
  const head = h("tr", {}, check ? h("th", { class: "lx-m", scope: "col" }, h("span", { class: "lx-vh", text: "Selected" })) : null, h("th", { scope: "col", text: "Unit" }),
    ...cols.map((c) => h("th", { class: [c.num ? "lx-n" : "", c.wide ? "lx-wide" : ""], scope: "col", dataset: { col: c.key, ...(c.hint ? { hint: c.hint } : {}) } }, c.label, c.unit ? h("span", { class: "lx-hu", text: c.unit }) : null)),
    marks ? h("th", { class: "lx-m", scope: "col" }, h("span", { class: "lx-vh", text: "Edited" })) : null);
  const tbody = h("tbody");
  const table = h("table", { class: ["lx-tbl", "lx-tbl--fill", dense ? "lx-tbl--dense" : ""], role: "grid", "aria-label": label, "aria-multiselectable": select === "multi" ? "true" : undefined, id, dataset: { unitTable: "true" } }, h("thead", {}, head), tbody);
  let list = [];
  let sel = [];
  let anchor = null;
  let focusId = null;
  const rows = new Map(); // id -> {tr, cells: {key: td}, box, markTd}
  const colspan = cols.length + 1 + (check ? 1 : 0) + (marks ? 1 : 0);
  const order = () => list.map((u) => u.id);

  const emit = () => {
    if (onSelect) onSelect(sel.slice(), anchor);
  };
  const setSel = (ids, anc, user = true) => {
    if (select === "none") return;
    sel = select === "single" ? ids.slice(-1) : ids.slice();
    anchor = anc ?? sel[0] ?? null;
    paintSel();
    if (user) emit();
  };
  const paintSel = () => {
    for (const [uid, r] of rows) {
      const on = sel.includes(uid);
      // Write an attribute only when it changes: every write is an AT-SPI notification on a live accessible object (G-247).
      if (select !== "none" && r.tr.getAttribute("aria-selected") !== String(on)) r.tr.setAttribute("aria-selected", String(on));
      if (r.box && r.box.checked !== on) r.box.checked = on;
      const ti = uid === (focusId ?? anchor ?? list[0]?.id) ? 0 : -1;
      if (r.tr.tabIndex !== ti) r.tr.tabIndex = ti;
    }
  };
  const fillRow = (u) => {
    const r = rows.get(u.id);
    for (const c of cols) {
      const td = r.cells[c.key];
      const bar = c.bar ? c.bar(u) : null;
      if (bar !== null && bar !== undefined) {
        const val = c.value ? c.value(u) : "";
        let b = td.querySelector("[data-part=bar]");
        if (!b) {
          clear(td).append((b = h("span", { class: "lx-bar", "aria-hidden": "true", dataset: { part: "bar" } })), h("span", { class: "lx-mono", dataset: { part: "value" } }));
        }
        setVar(b, "--p", Math.max(0, Math.min(1, bar)));
        const t = td.querySelector("[data-part=value]");
        const text = typeof val === "object" && val !== null ? val.text ?? "" : String(val ?? "");
        if (t.textContent !== text) t.textContent = text;
      } else fillCell(td, c.value ? c.value(u) : undefined);
    }
    if (marks) {
      const on = !!marks(u);
      if (on) {
        if (r.tr.dataset.state !== "edit") r.tr.dataset.state = "edit";
      } else if (r.tr.getAttribute("data-state") !== null) r.tr.removeAttribute("data-state");
      const has = r.markTd.querySelector(".lx-mark");
      if (on && !has) r.markTd.append(h("span", { class: "lx-mark", role: "img", "aria-label": "holds an edit" }));
      if (!on && has) has.remove();
    }
  };
  let shape = null; // what build() made: unit ids, kinds, names, subs, stars; setUnits() with the same shape updates in place (rows never rebuild)
  const shapeOf = () => JSON.stringify(list.map((u) => [u.id, u.kind, u.name, u.sub, !!u.fav, (u.cpus || []).length]));
  const build = () => {
    shape = shapeOf();
    clear(tbody);
    rows.clear();
    for (const g of GROUPS) {
      const mine = list.filter((u) => u.kind === g.kind);
      if (!mine.length) continue;
      if (groups) {
        const n = g.kind === "P" ? String(mine.length) : g.kind === "E" ? `${mine.length} · ${mine[0].cpus && mine[0].cpus.length ? mine[0].cpus.length + " CPUs each, one curve" : ""}` : "";
        tbody.append(h("tr", { class: "lx-grp", dataset: { group: g.kind } }, h("th", { colspan, scope: "rowgroup" }, g.label, n ? h("span", { class: "lx-grp-n", text: n }) : null)));
      }
      for (const u of mine) {
        const cells = {};
        const box = check ? h("input", { class: "lx-check", type: "checkbox", tabindex: "-1", "aria-label": `Select ${u.name}` }) : null;
        const key = h("td", { class: "lx-k" }, u.name, u.fav ? h("span", { class: "lx-fav", role: "img", "aria-label": "favored", text: " ★" }) : null, u.sub ? h("span", { class: "lx-sub", text: u.sub }) : null);
        const tds = cols.map((c) => (cells[c.key] = h("td", { class: [c.num ? "lx-n" : "", c.wide ? "lx-wide" : ""], dataset: { col: c.key } })));
        const markTd = marks ? h("td", { class: "lx-m" }) : null;
        const tr = h("tr", { class: select === "none" ? "" : "lx-click", dataset: { unit: u.id, kind: u.kind } }, check ? h("td", { class: "lx-m" }, box) : null, key, ...tds, markTd);
        rows.set(u.id, { tr, cells, box, markTd });
        tbody.append(tr);
        tr.addEventListener("click", (e) => {
          if (select === "none") return;
          focusId = u.id;
          if (check || e.target === box) {
            const ids = sel.includes(u.id) ? sel.filter((x) => x !== u.id) : order().filter((x) => x === u.id || sel.includes(x));
            setSel(ids, u.id);
          } else {
            const r = clickSelect(order(), sel, anchor, u.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
            setSel(r.ids, r.anchor);
          }
          tr.focus();
        });
        fillRow(u);
      }
    }
    paintSel();
  };

  tbody.addEventListener("keydown", (e) => {
    if (select === "none") return;
    const ids = order();
    const own = e.target && e.target.closest ? e.target.closest("tr[data-unit]") : null;
    const at = ids.indexOf(own ? own.dataset.unit : focusId ?? anchor ?? ids[0]);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const j = Math.max(0, Math.min(ids.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
      focusId = ids[j];
      if (check) paintSel();
      else if (e.shiftKey && select === "multi") setSel(clickSelect(ids, sel, anchor, ids[j], { shift: true }).ids, anchor);
      else setSel([ids[j]], ids[j]);
      rows.get(ids[j]).tr.focus();
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const cur = ids[at];
      if (!cur) return;
      const next = select === "multi" ? (sel.includes(cur) ? sel.filter((x) => x !== cur) : ids.filter((x) => x === cur || sel.includes(x))) : [cur];
      setSel(next, cur);
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey) && select === "multi") {
      e.preventDefault();
      const kind = (list.find((u) => u.id === ids[at]) || {}).kind;
      setSel(list.filter((u) => u.kind === kind).map((u) => u.id), ids[at]);
    }
  });

  const api = {
    el: table,
    table,
    setUnits(next) {
      list = Array.isArray(next) ? next.slice() : [];
      sel = sel.filter((x) => order().includes(x));
      if (anchor && !order().includes(anchor)) anchor = sel[0] || null;
      if (shape !== null && shape === shapeOf()) {
        for (const u of list) fillRow(u);
        paintSel();
        return;
      }
      build();
    },
    /** Programmatic selection (no onSelect). */
    setSelection(ids, anc) {
      sel = order().filter((x) => (ids || []).includes(x));
      anchor = anc ?? sel[0] ?? null;
      focusId = anchor;
      paintSel();
    },
    selection: () => sel.slice(),
    anchor: () => anchor,
    /** Re-read every live cell and mark from the columns' value functions; rows and focus stay. */
    refresh() {
      for (const u of list) if (rows.has(u.id)) fillRow(u);
    },
    focus() {
      const r = rows.get(focusId ?? anchor ?? list[0]?.id);
      if (r) r.tr.focus();
    },
    row: (uid) => (rows.get(uid) || {}).tr || null,
    dispose() {},
  };
  api.setUnits(units);
  return api;
}
