// G-248 items 9-12 (UI): stable DOM for plot / readout / topbar / dashboard (the G-247 rule: an update that changes nothing performs no structural DOM call and keeps the
// same nodes), the UVP popover wording, local time in Profiles and Stress, and snapOffsetMv against the helper's encoder. Fake DOM; no browser, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { install, text } from "./fakedom.mjs";

const doc = install();
const { createAppStore, setLink, setPreflight, setThrottleEvents, setUvp, setPref } = await import("../store.js");
const { createPlot, reconcile } = await import("../components/plot.js");
const { createReadout } = await import("../components/readout.js");
const { createTopBar, UVP_UNKNOWN_WORD } = await import("../components/topbar.js");
const { Bridge } = await import("../bridge.js");
const { createMockTransport, FIXTURES } = await import("../fixtures/mock-backend.js");
const { wrapMockTransport } = await import("../fixtures/mock-backend-g218.js");
const { dashboardView } = await import("../views/dashboard.js");
const { snapOffsetMv } = await import("../lib/units.js");
const { fmtLocalDateTime } = await import("../lib/format.js");
const ST = await import("../views/stress.js");
const PR = await import("../views/profiles.js");
const tune = await import("../views/tune.js");
const draftLib = await import("../lib/draft.js");
const { modelFromRead } = await import("../lib/units.js");

const pre = FIXTURES.preflight.result;

// ---- structural-call counter (same idea as g247.stable_dom.test.mjs): node mutators, textContent resets and attribute writes
const NODE_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(doc.createElement("div")));
const EL_PROTO = Object.getPrototypeOf(doc.createElement("div"));
const METHODS = ["append", "prepend", "replaceChildren", "remove", "removeChild", "appendChild", "insertBefore", "before", "after"];
/** DOM writes on nodes that are in the document (building a detached node to compare with is not a write). */
function writes(fn) {
  let n = 0;
  const saved = METHODS.map((m) => [m, NODE_PROTO[m]]);
  const attrs = ["setAttribute", "removeAttribute"].map((m) => [m, EL_PROTO[m]]);
  const tc = Object.getOwnPropertyDescriptor(NODE_PROTO, "textContent");
  for (const [m, orig] of saved) NODE_PROTO[m] = function (...a) { if (this.isConnected) n += 1; return orig.apply(this, a); };
  for (const [m, orig] of attrs) EL_PROTO[m] = function (...a) { if (this.isConnected) n += 1; return orig.apply(this, a); };
  Object.defineProperty(NODE_PROTO, "textContent", { ...tc, set(v) { if (this.isConnected) n += 1; tc.set.call(this, v); } });
  try {
    fn();
  } finally {
    for (const [m, orig] of saved) NODE_PROTO[m] = orig;
    for (const [m, orig] of attrs) EL_PROTO[m] = orig;
    Object.defineProperty(NODE_PROTO, "textContent", tc);
  }
  return n;
}
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
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 4));
  }
};

// ---------------------------------------------------------------- item 9: plot
const spec = (k = 1) => ({
  traces: [{ kind: "meas", pts: [[0, 10 * k], [30, 20 * k], [60, 15 * k]] }, { kind: "set", pts: [[0, 5], [60, 8 * k]] }],
  refs: [{ y: 25, label: "PL1 25" }],
  markers: [{ x: 30, y: 20 * k, kind: "meas", shape: "sq" }],
  labels: [{ x: 60, y: 15 * k, text: ` ${15 * k} W`, kind: "strong" }],
});
const mkPlot = (extra = {}) => createPlot({ label: "Package power", width: 600, height: 200, margin: { l: 40, r: 40, t: 20, b: 30 }, x: { min: 0, max: 60 }, y: { min: 0, max: 100 }, ...extra });

test("plot: a redraw updates the same SVG nodes in place; an identical redraw writes nothing", () => {
  const p = mkPlot();
  doc.body.append(p.el);
  p.draw(spec(1));
  const before = nodesOf(p.svg);
  assert.ok(before.length > 20);
  assert.equal(writes(() => p.draw(spec(1))), 0, "identical data: no structural call, no attribute write");
  assert.ok(sameNodes(before, nodesOf(p.svg)));
  p.draw(spec(2)); // new numbers, same structure
  assert.ok(sameNodes(before, nodesOf(p.svg)), "same nodes after the data moved");
  assert.ok(p.svg.querySelectorAll("text").some((t) => t.textContent === " 30 W"), "the label text followed the data");
  const poly = p.svg.querySelector("polyline");
  assert.notEqual(poly.getAttribute("points"), null);
  p.draw({ ...spec(2), refs: [] }); // structure changes: fewer nodes, still correct
  assert.equal(p.svg.querySelectorAll("text").filter((t) => /PL1/.test(t.textContent)).length, 0);
  p.dispose();
  p.el.remove();
});

test("plot: the cursor and its readout box are updated in place too", () => {
  const p = mkPlot({ readout: (x) => [["t", String(x)], ["", "20", "W"]] });
  doc.body.append(p.el);
  p.draw(spec(1));
  p.setCursor(30);
  const ro = p.el.querySelector(".lx-plot-ro");
  const kids = nodesOf(ro);
  assert.equal(ro.hidden, false);
  assert.equal(writes(() => p.setCursor(30)), 0, "the same cursor again: nothing is written");
  p.setCursor(0);
  assert.equal(ro.hidden, false);
  assert.ok(kids.length > 0);
  p.setCursor(null);
  assert.equal(ro.hidden, true);
  p.dispose();
  p.el.remove();
});

test("plot: the SVG is aria-hidden when a live readout names its values; without a readout it stays an image with its label", () => {
  const named = mkPlot({ readout: () => [["", "1"]] });
  assert.equal(named.svg.getAttribute("aria-hidden"), "true");
  assert.equal(named.svg.getAttribute("role"), null);
  assert.equal(named.el.getAttribute("aria-label"), "Package power", "the container carries the label");
  const plain = mkPlot();
  assert.equal(plain.svg.getAttribute("aria-hidden"), null);
  assert.equal(plain.svg.getAttribute("role"), "img");
  assert.equal(plain.svg.getAttribute("aria-label"), "Package power");
  named.dispose();
  plain.dispose();
});

test("reconcile: keeps nodes of the same tag, swaps a different tag, drops the surplus, appends the missing", () => {
  const host = doc.createElement("div");
  const mk = (tag, t) => { const e = doc.createElement(tag); e.append(t); return e; };
  host.append(mk("span", "a"), mk("b", "b"), mk("i", "c"));
  const [s0, b0] = [...host.childNodes];
  reconcile(host, [mk("span", "A"), mk("b", "B")]);
  assert.equal(host.childNodes.length, 2);
  assert.equal(host.childNodes[0], s0);
  assert.equal(host.childNodes[1], b0);
  assert.equal(text(host), "AB");
  reconcile(host, [mk("span", "A"), mk("u", "U"), mk("p", "P")]);
  assert.equal(host.childNodes[0], s0);
  assert.notEqual(host.childNodes[1], b0, "a different tag is replaced");
  assert.equal(text(host), "AUP");
});

// ---------------------------------------------------------------- item 9: readout and topbar
const connectedStore = () => {
  const store = createAppStore();
  setLink(store, { state: "connected" });
  setPreflight(store, pre);
  return store;
};
const tick = (store, value) => store.update((s) => ({ telemetry: { ...s.telemetry, samples: { ...s.telemetry.samples, pkg_power: { value, status: "ok", unit: "W" } } } }));

test("readout: a tick that moves nothing writes nothing; a changed value changes its text node only", () => {
  const store = connectedStore();
  const root = doc.createElement("div");
  doc.body.append(root);
  const ro = createReadout(root, store, {});
  tick(store, 120.5);
  const before = nodesOf(root);
  assert.equal(writes(() => tick(store, 120.5)), 0, "same sample: no DOM write at all");
  assert.equal(writes(() => setPref(store, "readout", store.get().prefs.readout)), 0);
  tick(store, 121.5);
  assert.ok(sameNodes(before, nodesOf(root)), "same nodes");
  assert.equal(text(root.querySelector("#ro-pkg_power [data-part=value]")), "121.5");
  setPref(store, "readout", "expanded");
  assert.equal(root.querySelector("#ro-pkg_power").getAttribute("aria-expanded"), "true", "aria-expanded follows the preference, written on change");
  assert.equal(root.dataset.expanded, "true");
  ro.dispose();
  root.remove();
});

test("topbar: the UVP popover says 'not known yet — the first apply tells (a Read does not)'; it follows the state in place", () => {
  assert.equal(UVP_UNKNOWN_WORD, "not known yet — the first apply tells (a Read does not)");
  const store = connectedStore();
  const root = doc.createElement("header");
  doc.body.append(root);
  const bar = createTopBar(root, store, { read() {}, restore() {}, goto() {}, draftEdits: () => 0 });
  root.querySelector("#ann-uvp").click();
  const pop = doc.querySelector("#top-pop");
  assert.ok(text(pop).includes(UVP_UNKNOWN_WORD), text(pop));
  const dd = pop.querySelector("dd");
  setUvp(store, "off");
  assert.equal(pop.querySelector("dd"), dd, "the value node survives");
  assert.equal(text(dd), "off");
  bar.dispose();
  root.remove();
});

test("topbar: a store change that alters nothing visible writes nothing", () => {
  const store = connectedStore();
  const root = doc.createElement("header");
  doc.body.append(root);
  const bar = createTopBar(root, store, { read() {}, restore() {}, goto() {}, draftEdits: () => 0 });
  const cells = ["#accepted-value", "#last-read", "#ops-used"].map((sel) => root.querySelector(sel));
  const texts = cells.map((c) => c.firstChild);
  store.update((s) => ({ helperOp: { ...s.helperOp } }));
  assert.deepEqual(cells.map((c) => c.firstChild), texts, "the text nodes are the same ones (setText writes only a changed value)");
  store.update((s) => ({ helperOp: { ...s.helperOp, opsUsed: 7, opsBudget: 400 } }));
  assert.equal(root.querySelector("#ops-used").firstChild, texts[2], "a new value goes into the same text node");
  assert.equal(text(root.querySelector("#ops-used")), "7");
  bar.dispose();
  root.remove();
});

// ---------------------------------------------------------------- item 9: dashboard
async function dashRig(t) {
  const bridge = new Bridge(wrapMockTransport(createMockTransport({ intervalMs: 10_000 }), { stepMs: 1, seed: "recorded" }), "mock");
  const store = createAppStore();
  setLink(store, await bridge.connect());
  setPreflight(store, pre);
  const root = doc.createElement("main");
  doc.body.append(root);
  const v = dashboardView();
  v.mount(root, { store, bridge, head: { set: () => {} }, goto: () => {}, toast: () => {} });
  t.after(() => { v.unmount(); root.remove(); }); // a failed assertion must not leave the view's timers running (they keep node alive)
  await until(() => store.get().throttleEvents.state !== "loading" && store.get().throttleEvents.state !== "idle");
  return { store, root, v, bridge };
}
const rec = (n) => ({ t_on: 1_700_000_000 + n * 100, t_off: 1_700_000_050 + n * 100, duration_s: 40, groups: { thermal: 0.8 }, peak_pkg_w: 250, peak_temp_c: 95 });

test("Overview: the throttle events table is rebuilt only when the events changed", async (t) => {
  const { store, root } = await dashRig(t);
  setThrottleEvents(store, { state: "ok", records: [rec(1), rec(2)], error: null });
  const table = root.querySelector("#ov-events table");
  assert.ok(table, "the events table");
  const before = nodesOf(root.querySelector("#ov-events"));
  assert.equal(writes(() => setThrottleEvents(store, { state: "ok", records: [rec(1), rec(2)], error: null })), 0, "the same events again: nothing is written");
  assert.equal(root.querySelector("#ov-events table"), table);
  assert.ok(sameNodes(before, nodesOf(root.querySelector("#ov-events"))));
  setThrottleEvents(store, { state: "ok", records: [rec(1), rec(2), rec(3)], error: null });
  assert.equal(root.querySelectorAll("#ov-events tr[data-event]").length, 3, "a new event is shown");
});

test("Overview: all fetched events are listed (the panel scrolls), not the first six", async (t) => {
  const { store, root } = await dashRig(t);
  setThrottleEvents(store, { state: "ok", records: Array.from({ length: 20 }, (_, i) => rec(i)), error: null });
  assert.equal(root.querySelectorAll("#ov-events tr[data-event]").length, 20);
});

test("Overview: the memory body is rebuilt only when the answer changed", async (t) => {
  const { root, bridge } = await dashRig(t);
  const answer = { available: true, mts: 6400, gear: 2, cmd_rate: "2N", timings: { tCL: 32, tRCD: 39, tRP: 39, tRAS: 102, tRFC: 700, tREFI: 8000 }, qclk_mhz: 3200, bclk_mhz: 100, max_bandwidth_mbs: 102400, cross_check: { agree: true }, instances_ok: 2,
    dimms: [{ locator: "DIMM_A1", size: "16 GB", part: "X", manufacturer: "Y", temp_c: 41 }] };
  const call = bridge.call.bind(bridge);
  bridge.call = async (op, args) => (op === "mem.read" ? { ok: true, result: JSON.parse(JSON.stringify(answer)) } : call(op, args));
  root.querySelector("#mem-read").click();
  await until(() => root.querySelector("#mem-body table"));
  const table = root.querySelector("#mem-body table");
  const before = nodesOf(root.querySelector("#mem-body"));
  root.querySelector("#mem-read").click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(root.querySelector("#ov-memory").dataset.phase, "done");
  assert.equal(root.querySelector("#mem-body table"), table, "the same answer: the same table");
  assert.ok(sameNodes(before, nodesOf(root.querySelector("#mem-body"))));
});

// ---------------------------------------------------------------- item 11: local time
test("local time: Profiles' Saved/started times and Stress dates use fmtLocalDateTime", () => {
  const iso = "2026-11-12T08:49:00Z";
  assert.equal(PR.fmtCreated(iso), fmtLocalDateTime(iso));
  assert.match(PR.fmtCreated(iso), /^Nov 12 \d\d:\d\d$/);
  assert.equal(PR.fmtCreated(null), "");
  assert.equal(ST.fmtDate(iso), fmtLocalDateTime(iso));
  assert.equal(ST.fmtDate(Date.parse(iso) / 1000), fmtLocalDateTime(iso), "epoch seconds too");
  assert.equal(ST.fmtDate("nope"), "n/a");
  const prev = process.env.TZ;
  try {
    process.env.TZ = "Etc/GMT-2"; // UTC+2
    assert.equal(PR.fmtCreated("2026-11-12T22:30:00Z"), "Nov 13 00:30", "local, across midnight");
    assert.equal(ST.fmtDate("2026-11-12T22:30:00Z"), "Nov 13 00:30");
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
  const src = readFileSync(fileURLToPath(new URL("../views/profiles.js", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /slice\(0, 16\)\.replace\("T"/, "no UTC stamp cut left in profiles.js");
});

// ---------------------------------------------------------------- item 12: QA-04
test("snapOffsetMv equals the helper's rounding for every whole mV in -250..+50 (golden table from VfWord.mv_to_offset_raw)", () => {
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./offset-golden.json", import.meta.url)), "utf8")).raw;
  const keys = Object.keys(golden);
  assert.equal(keys.length, 301);
  for (const k of keys) {
    const mv = Number(k);
    assert.equal(snapOffsetMv(mv), golden[k] / 1.024, `${mv} mV -> raw ${golden[k]}`);
  }
});

test("pending row 'to' is the step the CPU will hold, like the editor", () => {
  const store = createAppStore();
  tune.ensureTune(store);
  const model = modelFromRead(structuredClone(FIXTURES.tuneRead.result));
  tune.patchTune(store, { model });
  const d = draftLib.setPoint(model, store.get().tune.draft, ["P0"], 48, -70);
  tune.patchTune(store, { draft: d });
  const item = store.get().pendingItems[0];
  assert.equal(item.to, "−70.3");
  const c = draftLib.setCurve ? draftLib.setCurve(model, draftLib.emptyDraft(), ["P1"], -70) : null;
  if (c) {
    const items = tune.pendingItems(model, c, null);
    assert.equal(items[0].to, "−70.3");
  }
});
