// views/tune/inspector.js: the inspector of Tune › Cores (desktop/DESIGN.md §9.2): the heading (`.lx-ihead`: the unit and one grey line of facts with the
// values in mono) and, per kind of unit selected, a V/F section (curve-editor.js: whole-curve band, point table, plot) and, for P-cores and E-clusters, the OC
// POINT band (oc.js). P and E selected together are two sections (their points differ); the ring is its own section without an OC band (D-045). Sections are
// built when the selection or the read changes and only refreshed afterwards, so a field keeps its focus and its refusal while the draft changes.
import { h, clear } from "../../components/dom.js";
import { aggregate, sections, fusedTopOf, stockMaxOf, unitLabel, favoredIds, aboveTop, ocClass } from "../../lib/units.js";
import { effRatio } from "../../lib/draft.js";
import { isNum, TIMES } from "../../lib/format.js";
import { createCurveSection } from "./curve-editor.js";
import { createOcBand } from "./oc.js";

const KIND_PLURAL = { P: "P-cores", E: "E-clusters", R: "Ring" };

/** The heading of a selection: "P0" / "EC0" / "Ring" for one unit; "P0, P3" for up to four; "6 P-cores + 2 E-clusters" for more. */
export function selectionTitle(model, ids) {
  const live = ids.filter((id) => model.units[id]);
  if (!live.length) return "Nothing selected";
  const name = (id) => (model.units[id].kind === "R" ? "Ring" : id);
  if (live.length <= 4) return live.map(name).join(", ");
  const parts = [];
  for (const kind of ["P", "E", "R"]) {
    const n = live.filter((id) => model.units[id].kind === kind).length;
    if (!n) continue;
    const total = model.order.filter((id) => model.units[id].kind === kind).length;
    parts.push(kind === "R" ? "Ring" : (n === total ? "all " + n : String(n)) + " " + (n === 1 ? (kind === "P" ? "P-core" : "E-cluster") : KIND_PLURAL[kind]));
  }
  return parts.join(" + ");
}

/**
 * The facts line of a selection as parts: [text | {b: value}] joined with " · " (DESIGN §5.9 `.lx-ihead`): cpu, factory top, max ratio, OC state, favored for
 * one P-core; the CPU range, one ratio one curve, factory top and the boot ratio for an E-cluster; the point count for the ring; the unit list for several.
 */
export function selectionFacts(model, draft, ids) {
  const live = ids.filter((id) => model.units[id]);
  if (!live.length) return [];
  const fav = favoredIds(model);
  if (live.length > 1) {
    const us = live.map((id) => model.units[id]).filter((u) => u.kind !== "R");
    const ft = aggregate(us.map(fusedTopOf));
    const out = [[{ b: String(live.length) }, " units"]];
    if (ft.state === "same") out.push(["factory top ", { b: ft.value + TIMES }]);
    else if (ft.state === "mixed") out.push(["factory top ", { b: ft.min + "–" + ft.max + TIMES }]);
    return out;
  }
  const u = model.units[live[0]];
  if (u.kind === "R") return [["cache and ring fabric"], [{ b: String(u.points.length) }, " points, by number"], ["OC word never written"]];
  const out = [];
  const r = effRatio(draft, u);
  const cls = ocClass(u, r);
  const ab = aboveTop(model, u, r);
  const ocFact = cls === "oc" ? ["OC point ", { b: r + TIMES }] : cls === "middle" ? ["OC ratio ", { b: r + TIMES }, " on a factory point"] : ab ? ["runs ", { b: ab.max + TIMES }, " (set at boot), no OC point"] : ["no OC point"];
  if (u.kind === "P") {
    out.push(["cpu ", { b: String(u.cpu) }]);
    if (isNum(fusedTopOf(u))) out.push(["factory top ", { b: fusedTopOf(u) + TIMES }]);
    if (isNum(stockMaxOf(u))) out.push(["max ratio ", { b: (isNum(u.favored) ? u.favored : stockMaxOf(u)) + TIMES }]);
    out.push(ocFact);
    if (fav.includes(u.id)) out.push(["favored"]);
  } else {
    out.push(["cpus ", { b: u.cpus[0] + "–" + u.cpus[u.cpus.length - 1] }]);
    out.push([{ b: String(u.cpus.length) }, " CPUs, one ratio, one curve"]);
    if (isNum(fusedTopOf(u))) out.push(["factory top ", { b: fusedTopOf(u) + TIMES }]);
    out.push(ocFact);
  }
  return out;
}

/** Plain text of facts parts (tests, aria). */
export const factsText = (facts) => facts.map((p) => p.map((x) => (typeof x === "string" ? x : x.b)).join("")).join(" · ");

/** The inspector panel. `tc` = the Tune controller; `onFrequency()` opens Tune › Frequency. Returns {el, update(), dispose()}. */
export function createInspector(tc, { onFrequency = null } = {}) {
  const title = h("span", { class: "lx-ihead-t", dataset: { part: "title" } });
  const facts = h("span", { class: "lx-ihead-f", dataset: { part: "facts" } });
  const head = h("div", { class: "lx-ihead" }, title, facts);
  const body = h("div", { class: ["lx-panel-b", "lx-panel-b--flush", "lx-panel-b--scroll"], dataset: { part: "inspector-body" } });
  const el = h("section", { class: "lx-panel", dataset: { pane: "inspector" }, "aria-label": "Inspector" }, head, body);
  let sig = null;
  let builtFor = null;
  let parts = []; // [{section, vf, oc}]

  function rebuild(model, ids) {
    for (const p of parts) {
      p.vf.dispose();
      if (p.oc) p.oc.dispose();
    }
    parts = [];
    clear(body);
    const secs = sections(model, ids);
    for (const section of secs) {
      const vf = createCurveSection(tc, section, { title: secs.length > 1 ? KIND_PLURAL[section.kind] : "" });
      const oc = section.kind === "R" ? null : createOcBand(tc, section, { onFrequency });
      body.append(vf.el);
      if (oc) body.append(oc.el);
      parts.push({ section, vf, oc });
    }
  }

  function update() {
    const s = tc.state();
    const model = s.model;
    if (!model) return;
    const ids = s.selection.filter((id) => model.units[id]);
    const key = ids.join(",");
    if (builtFor !== model || sig !== key) {
      builtFor = model;
      sig = key;
      rebuild(model, ids);
    }
    const fav = favoredIds(model);
    clear(title).append(selectionTitle(model, ids));
    if (ids.length === 1 && fav.includes(ids[0])) title.append(" ", h("span", { class: "lx-fav", "aria-label": "favored", text: "★" }));
    title.setAttribute("aria-label", ids.length === 1 ? unitLabel(ids[0]) : selectionTitle(model, ids));
    clear(facts);
    selectionFacts(model, s.draft, ids).forEach((p, i) => {
      if (i) facts.append(" · ");
      for (const x of p) facts.append(typeof x === "string" ? x : h("b", { text: x.b }));
    });
    for (const p of parts) {
      p.vf.update();
      if (p.oc) p.oc.update();
    }
  }

  const offs = [tc.store.watch((st) => st.tune, () => update()), tc.store.watch((st) => st.uvp, () => update())];
  return { el, update, dispose: () => offs.forEach((f) => f()), parts: () => parts };
}
