// node --test: G-247 (QA-01). WebKitGTK's AT-SPI bridge keeps one accessible object per DOM node; a node that is removed and re-created on every
// telemetry tick (or hover / focus / link change) is the prime suspect for the stale-object abort in WebCore::AccessibilityObjectAtspi.
// The rule these tests pin: a per-tick update of a component keeps the SAME nodes (elements and text nodes) when the structure is unchanged, and an
// update that changes nothing performs no structural DOM call at all (append / remove / replaceChildren / textContent reset).
import test from "node:test";
import assert from "node:assert/strict";
import { install, fire } from "./fakedom.mjs";

const doc = install();
const store_ = await import("../store.js");
const { createAppStore, setLink } = store_;
const { createTable, fillCell } = await import("../components/table.js");
const { createUnitTable } = await import("../components/unit-table.js");
const { why, setWhy } = await import("../components/help.js");
const { createContextLine } = await import("../components/context-line.js");
const { createToaster } = await import("../components/toast.js");
const { createSparkline } = await import("../components/sparkline.js");
const { annunciator, setAnn } = await import("../components/ann.js");

// ---- structural-call counter: wraps the node mutators on the fake DOM's prototype for the duration of fn
const NODE_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(doc.createElement("div")));
const METHODS = ["append", "prepend", "replaceChildren", "remove", "removeChild", "appendChild", "insertBefore", "before", "after"];
function structural(fn) {
  let n = 0;
  const saved = METHODS.map((m) => [m, NODE_PROTO[m]]);
  const tc = Object.getOwnPropertyDescriptor(NODE_PROTO, "textContent");
  for (const [m, orig] of saved) NODE_PROTO[m] = function (...a) { n += 1; return orig.apply(this, a); };
  Object.defineProperty(NODE_PROTO, "textContent", { ...tc, set(v) { n += 1; tc.set.call(this, v); } });
  try {
    fn();
  } finally {
    for (const [m, orig] of saved) NODE_PROTO[m] = orig;
    Object.defineProperty(NODE_PROTO, "textContent", tc);
  }
  return n;
}
/** Every node (elements and text) under `root`, in document order. */
const nodesOf = (root) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
};
const sameNodes = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const mount = (e) => (doc.body.append(e), e);

test("table: n/a and node cells survive a tick; values change in place", () => {
  const badge = doc.createElement("span");
  const t = createTable({ columns: [{ key: "a", label: "A" }, { key: "b", label: "B", num: true }, { key: "c", label: "C" }] });
  const rows = (b, c) => [{ key: "g", group: { label: "G" } }, { key: "r1", cells: { a: { text: "no sensor", na: true }, b, c: badge } }];
  t.setRows(rows("1.00", null));
  const before = nodesOf(t.tbody);
  assert.equal(structural(() => t.setRows(rows("1.00", null))), 0, "identical tick: no structural call");
  const n = structural(() => t.setRows(rows("1.01", null)));
  assert.equal(n, 0, "a changed number updates its text node");
  assert.ok(sameNodes(before, nodesOf(t.tbody)), "same nodes after the tick");
  assert.equal(t.row("r1").cells_.b.textContent, "1.01");
  // the n/a reason changes: the same .lx-na span gets the new text
  const span = t.row("r1").cells_.a.firstChild;
  t.setRows([{ key: "g", group: { label: "G" } }, { key: "r1", cells: { a: { text: "gone", na: true }, b: "1", c: badge } }]);
  assert.equal(t.row("r1").cells_.a.firstChild, span);
  assert.equal(span.textContent, "gone");
  // fillCell directly: a node already in the cell is not re-inserted
  const td = doc.createElement("td");
  fillCell(td, badge);
  assert.equal(structural(() => fillCell(td, badge)), 0);
});

test("unit table: setUnits with the same shape, refresh() and selection repaint keep every row, cell and text node", () => {
  const units = [
    { id: "P0", kind: "P", name: "P0", sub: "cpu 0", fav: true, cpus: [0] },
    { id: "P1", kind: "P", name: "P1", sub: "cpu 1", fav: false, cpus: [1] },
    { id: "EC0", kind: "E", name: "EC0", sub: "8–11", fav: false, cpus: [8, 9, 10, 11] },
    { id: "Ring", kind: "R", name: "Ring", sub: "", fav: false, cpus: [] },
  ];
  let clk = 5.1;
  let sensor = true;
  const edited = new Set();
  const cols = [
    { key: "clk", label: "Clock", num: true, value: () => clk.toFixed(2) },
    { key: "busy", label: "Busy", num: true, value: () => "62", bar: () => 0.62 },
    { key: "temp", label: "Temp", num: true, value: (u) => (sensor || u.id !== "P1" ? "61" : { text: "no sensor", na: true }) },
  ];
  const t = createUnitTable({ units, columns: cols, check: true, marks: (u) => edited.has(u.id) });
  mount(t.el);
  const before = nodesOf(t.table);
  assert.equal(structural(() => { t.refresh(); t.setUnits(units.map((u) => ({ ...u }))); }), 0, "unchanged tick: zero structural calls");
  clk = 5.2;
  t.refresh();
  t.setUnits(units.map((u) => ({ ...u })));
  assert.ok(sameNodes(before, nodesOf(t.table)), "a clock change updates text nodes in place");
  // n/a appears then changes its reason: one new span, then reused
  sensor = false;
  t.refresh();
  const na = t.row("P1").querySelector("td[data-col=temp]").firstChild;
  assert.equal(na.textContent, "no sensor");
  assert.equal(structural(() => t.refresh()), 0, "the n/a span is reused on the next tick");
  assert.equal(t.row("P1").querySelector("td[data-col=temp]").firstChild, na);
  // an edit mark appears (one node, by design) and goes again; the row survives
  const row = t.row("P0");
  edited.add("P0");
  t.refresh();
  assert.equal(row.dataset.state, "edit");
  assert.equal(t.row("P0"), row);
  // selection repaint is attribute-only
  t.setSelection(["P1"], "P1");
  assert.equal(structural(() => t.setSelection(["P1"], "P1")), 0);
  // a real change of shape rebuilds (that is a new unit list, not a tick)
  t.setUnits(units.slice(0, 2));
  assert.equal(t.row("EC0"), null);
});

test("why line: same key / new text keeps its <b> and text node; unchanged call writes nothing", () => {
  const w = why(null, {}, { id: "w1" });
  mount(w);
  assert.equal(w.hidden, true);
  assert.equal(w.getAttribute("aria-live"), "polite");
  setWhy(w, "refused.uncore_order", { max: 42 });
  const before = nodesOf(w);
  assert.equal(before.length, 3, "b + its text + the sentence");
  assert.equal(structural(() => setWhy(w, "refused.uncore_order", { max: 42 })), 0);
  assert.equal(structural(() => setWhy(w, "refused.uncore_order", { max: 41 })), 0, "new text, same nodes");
  assert.match(w.textContent, /\(41×\)/);
  assert.equal(structural(() => setWhy(w, "warn.large_step", { value: "−150" })), 0, "another key, same nodes");
  assert.ok(sameNodes(before, nodesOf(w)));
  assert.equal(w.dataset.kind, "warn");
  setWhy(w, null);
  assert.equal(w.hidden, true);
  assert.equal(w.textContent, "");
  assert.equal(structural(() => setWhy(w, null)), 0, "clearing a cleared line is a no-op");
  setWhy(w, "refused.uncore_order", { max: 42 });
  assert.equal(w.textContent, "RefusedThe minimum may not be above the maximum (42×).");
});

test("context line: hover / focus / link repaints rewrite text in place", () => {
  const s = createAppStore();
  setLink(s, { state: "connected" });
  const scope = doc.createElement("div");
  const ctx = doc.createElement("div");
  const a = doc.createElement("button");
  a.dataset.hint = "power.pl1";
  const b = doc.createElement("button");
  b.dataset.hint = "state.read";
  b.dataset.hintTerm = "132 req";
  scope.append(a, b, ctx);
  mount(scope);
  const line = createContextLine(ctx, s, { scope, screenKey: () => "tune.power", screenLabel: () => "Power", onTips: () => {} });
  const k = ctx.querySelector("[data-part=label]");
  const t = ctx.querySelector("[data-part=line]");
  fire(a, "pointerover");
  const before = nodesOf(k).concat(nodesOf(t));
  assert.ok(before.length >= 3);
  assert.equal(structural(() => fire(b, "pointerover")), 0, "hint with a term -> hint with a term: text only");
  assert.equal(ctx.dataset.hintShown, "state.read");
  assert.ok(sameNodes(before, nodesOf(k).concat(nodesOf(t))), "same label / term / line nodes");
  assert.equal(structural(() => { line.refresh(); setLink(s, { state: "connected", message: "x" }); }), 0, "a repaint with nothing new writes nothing structural");
  // idle (no term) drops the term span once; back to a hint brings one span back; the label and line text nodes stay
  const kText = k.firstChild;
  const tText = t.lastChild;
  fire(scope, "pointerleave");
  assert.equal(ctx.dataset.idle, "true");
  assert.equal(k.firstChild, kText);
  assert.equal(t.lastChild, tText);
  fire(a, "pointerover");
  assert.equal(k.firstChild, kText);
  assert.equal(t.lastChild, tText);
  // a reason adds the lead <b>; the next hint without one removes it; the line text node is still the same
  b.dataset.reasonKey = "locked.no_link";
  b.dataset.reasonVars = "{}";
  fire(b, "pointerover");
  assert.match(t.textContent, /^Unavailable The helper is not connected/);
  assert.equal(t.lastChild, tText);
  fire(a, "pointerover");
  assert.equal(t.firstChild.nodeType, 3, "no reason: the lead <b> is gone");
  assert.equal(t.lastChild, tText);
  a.dataset.reasonKey = "locked.no_link";
  a.dataset.reasonVars = "{}";
  fire(b, "pointerover");
  const lead2 = t.firstChild;
  assert.equal(structural(() => fire(a, "pointerover")), 0, "reason -> reason: lead and line text change in place");
  assert.ok(t.firstChild === lead2, "the lead survives a hover between two controls that both carry a reason");
  line.dispose();
});

test("toasts: a new toast leaves the others' nodes alone; only an error is an alert (the container is the one live region)", () => {
  const s = createAppStore();
  const root = doc.createElement("div");
  mount(root);
  const dispose = createToaster(root, s, { schedule: () => 1, cancel: () => {} });
  assert.equal(root.getAttribute("aria-live"), "polite");
  store_.pushToast(s, { kind: "info", text: "Read complete. 132 requests in 1.1 s" });
  const first = root.querySelector("[data-toast]");
  const before = nodesOf(first);
  store_.pushToast(s, { kind: "error", text: "Write refused." });
  assert.equal(root.querySelectorAll("[data-toast]")[0], first);
  assert.ok(sameNodes(before, nodesOf(first)));
  assert.equal(first.getAttribute("role"), null, "no nested role=status inside the polite container");
  assert.equal(root.querySelectorAll("[data-toast]")[1].getAttribute("role"), "alert");
  dispose();
});

test("sparkline and annunciator: per-tick draws are attribute / text updates on the same nodes", () => {
  const sp = createSparkline({ w: 44, h: 14, label: "PKG" });
  const path = sp.el.firstChild;
  sp.draw([1, 2, 3, 2]);
  let writes = 0;
  const orig = path.setAttribute;
  path.setAttribute = function (...a) { writes += 1; return orig.apply(this, a); };
  sp.draw([1, 2, 3, 2]);
  assert.equal(writes, 0, "the same series writes nothing");
  sp.draw([1, 2, 3, 9]);
  assert.equal(writes, 1);
  path.setAttribute = orig;
  assert.equal(sp.el.firstChild, path);
  assert.equal(structural(() => sp.draw([2, 3, 4])), 0);

  const ann = annunciator({ label: "PL1", state: "idle", pip: null, duty: null });
  setAnn(ann, { state: "lit-warn", duty: "30 %" }); // the duty text node is created once
  const kids = nodesOf(ann);
  assert.equal(structural(() => { setAnn(ann, { state: "lit-warn", duty: "31 %" }); setAnn(ann, { label: "PL1", state: "lit-fault", duty: "32 %" }); }), 0, "annunciator ticks are not structural");
  assert.ok(sameNodes(kids, nodesOf(ann)));
});
