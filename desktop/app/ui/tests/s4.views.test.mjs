// node --test desktop/app/ui/tests/   (R-S4: the Overview, Stress and Curves screens mounted on the fake DOM with the mock bridge — what each screen shows
// and refuses, by data-* / roles / ids, never by lx- classes. No browser, no helper, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { install, text } from "./fakedom.mjs";

const doc = install();
const { Bridge } = await import("../bridge.js");
const { createAppStore, setLink, setPreflight, setPending, setLastRead, applyHelperEvent } = await import("../store.js");
const { createMockTransport, FIXTURES } = await import("../fixtures/mock-backend.js");
const { wrapMockTransport } = await import("../fixtures/mock-backend-g218.js");
const { dashboardView } = await import("../views/dashboard.js");
const { stressView } = await import("../views/stress.js");
const { curvesView, curvesController } = await import("../views/curves.js");

const pre = FIXTURES.preflight.result;
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out: " + fn);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function rig() {
  const bridge = new Bridge(wrapMockTransport(createMockTransport({ intervalMs: 10_000 }), { stepMs: 1, seed: "recorded" }), "mock");
  const store = createAppStore();
  setLink(store, await bridge.connect());
  setPreflight(store, pre);
  const heads = [];
  const gotos = [];
  const ctx = { store, bridge, head: { set: (x) => heads.push(x) }, goto: (s, t) => gotos.push([s, t]), toast: () => {} };
  const root = doc.createElement("main");
  doc.body.append(root);
  return { bridge, store, ctx, root, heads, gotos };
}

function liveFrame(t) {
  const cores = {};
  for (const u of pre.topology.units) for (const cpu of u.cpus) {
    const leaf = (value) => ({ value, status: "ok", source: "test", unit: "" });
    cores[String(cpu)] = { mhz: leaf(5000 + cpu), busy: leaf(50), vid: leaf(1.1), ratio: leaf(50) };
  }
  return { t, values: { cores, temps: { Package: { value: 55, status: "ok", unit: "C", source: "hwmon", cpu: null } }, power: { package: { value: 120.5, status: "ok", unit: "W", source: "rapl" } }, vcore: { value: 1.2, status: "ok", unit: "V", source: "hwmon" } } };
}

test("Overview: the unit table with live columns, no tiles, no donut; heat is a bar in the Busy cell; n/a said once in the footnote", async () => {
  const { store, ctx, root, heads } = await rig();
  const v = dashboardView();
  assert.equal(v.lx, true);
  v.mount(root, ctx);
  applyHelperEvent(store, "telemetry", liveFrame(1000));
  const rows = root.querySelectorAll("#ov-units tr[data-unit]");
  assert.equal(rows.length, 12);
  const p0 = root.querySelector("#ov-units tr[data-unit=P0]");
  assert.equal(text(p0.querySelector("td[data-col=clock]")), "5.00");
  assert.ok(p0.querySelector("td[data-col=busy] [data-part=bar]"), "busy is a bar in the cell");
  assert.equal(text(p0.querySelector("td[data-col=temp]")), "n/a");
  assert.match(text(root.querySelector("#ov-units-note")), /^Temp n\/a: no per-core temperature sensor/);
  assert.equal(root.querySelectorAll("[data-series=pkg_power]").length, 1, "package power is a history plot, not a readout tile");
  assert.equal(root.querySelectorAll("circle").length, 0, "no donut");
  assert.equal(root.querySelectorAll("#ov-limits tr[data-limit]").length, 6);
  assert.match(text(root.querySelector("#ov-mbx")), /this boot/);
  assert.ok(heads.some((x) => x.end), "the window segmented sits in the work header");
  v.unmount();
  root.remove();
});

test("Overview: a limit row routes to its setting; no topology shows the teaching empty state", async () => {
  const { store, ctx, root, gotos } = await rig();
  const v = dashboardView();
  v.mount(root, ctx);
  root.querySelector("[data-goto=pl1]").click();
  assert.deepEqual(gotos.pop(), ["tune", "power"]);
  setPreflight(store, { ...pre, topology: null });
  assert.equal(root.querySelector("#ov-units-empty").hidden, false);
  assert.equal(root.querySelector("#ov-units").hidden, true);
  v.unmount();
  root.remove();
});

test("Stress: the box is always there; edits that are not applied are said before Start; no units = Start disabled with its reason", async () => {
  const { store, ctx, root } = await rig();
  const v = stressView();
  v.mount(root, ctx);
  assert.equal(root.querySelector("#st-banner").getAttribute("role"), "note");
  assert.equal(root.querySelector("#st-edits").hidden, true);
  setPending(store, 2, 1);
  assert.equal(root.querySelector("#st-edits").hidden, false);
  assert.equal(root.querySelector("#st-edits-why").dataset.why, "warn.unapplied");
  assert.match(text(root.querySelector("#st-edits-why")), /Not applied in Tune: 2 edits/);
  const start = root.querySelector("#btn-stress-start");
  assert.equal(start.disabled, false);
  assert.equal(text(start.querySelector(".lx-cost")), "5 min");
  root.querySelector("[data-quick=None]").click();
  assert.equal(start.disabled, true);
  assert.equal(root.querySelector("#st-start-why").dataset.why, "locked.no_units");
  root.querySelector("[data-quick=All]").click();
  assert.equal(start.disabled, false);
  root.querySelector("#st-dur button[data-value='900']").click();
  assert.equal(text(start.querySelector(".lx-cost")), "15 min");
  assert.match(text(root.querySelector("#st-method-line")), /Integer arithmetic/);
  root.querySelector("#st-method button[data-value=cache]").click();
  assert.match(text(root.querySelector("#st-method-line")), /caches/);
  v.unmount();
  root.remove();
});

test("Stress: a run shows the timer and what it tests, then the result in plain words with the next step; history marks the tested state", async () => {
  const { store, ctx, root } = await rig();
  setLastRead(store, "2026-11-11T19:53:03Z", [{ cpu: 0, match: true }]);
  const v = stressView();
  v.mount(root, ctx);
  root.querySelector("#btn-stress-start").click();
  await until(() => root.querySelector("#st-sum"));
  const sum = root.querySelector("#st-sum");
  assert.equal(sum.dataset.result, "clean");
  assert.match(text(sum), /No errors detected/);
  assert.match(text(sum), /run a long self-checking test before you accept/);
  assert.match(text(root.querySelector("#st-testing")), /^Tests what the CPU holds now \(read \d\d:\d\d:\d\d\) · = the accepted state/);
  assert.match(text(root.querySelector("#st-clock")), /^\d\d:\d\d$/);
  await until(() => root.querySelectorAll("#st-hist-body tr").length > 0);
  const first = root.querySelector("#st-hist-body tr");
  assert.equal(text(first.lastChild), "state not recorded");
  v.unmount();
  root.remove();
});

test("Curves: tabs in the work header; the library offers Set as baseline for a complete curve of known tuning (a tuned one as a derived baseline, G-250), else disabled with its reason", async () => {
  const { ctx, root, heads } = await rig();
  const v = curvesView();
  v.mount(root, ctx);
  const ctl = curvesController(ctx);
  await until(() => ctl.cv.loaded && ctl.cv.list.length > 0);
  const h = heads.find((x) => x.tabs);
  assert.deepEqual(h.tabs.map((t) => t.id), ["chart", "table", "library"]);
  h.onTab("library");
  ctl.cv.list = [
    { id: "s", name: "stock", tuning_state: { kind: "stock" }, complete: true, units: ["P0"], created: "2026-10-18T10:00:00Z", mode: "quick" },
    { id: "t", name: "tuned", tuning_state: { kind: "words" }, complete: true, units: ["P0"], created: "2026-10-18T11:00:00Z", mode: "quick" },
    { id: "p", name: "part", tuning_state: { kind: "stock" }, complete: false, units: ["P0"], created: "2026-10-18T12:00:00Z", mode: "quick" },
    { id: "u", name: "unknown", tuning_state: { kind: "unknown" }, complete: true, units: ["P0"], created: "2026-10-18T13:00:00Z", mode: "quick" },
  ];
  ctl.paint();
  await until(() => root.querySelector("#cv-lib-body tr[data-id=t]"));
  const btn = (id) => root.querySelector(`#cv-lib-body tr[data-id=${id}] [data-act=baseline]`);
  assert.equal(btn("s").disabled, false);
  assert.equal(btn("t").disabled, false, "a tuned curve is a derived baseline: its offsets are taken off in Tune");
  assert.match(text(btn("t")), /Set as derived baseline/);
  assert.equal(btn("p").disabled, true);
  assert.equal(btn("u").disabled, true, "offsets unknown: nothing to take off");
  assert.equal(root.querySelector("#cv-lib-body tr[data-why=u] [data-why]").dataset.why, "locked.baseline_stock");
  v.unmount();
  root.remove();
});

test("Curves: checked units are measured and drawn; Measure carries its duration and is refused with no unit", async () => {
  const { ctx, root } = await rig();
  const v = curvesView();
  v.mount(root, ctx);
  const ctl = curvesController(ctx);
  ctl.cv.view = "chart";
  ctl.paint();
  await until(() => ctl.cv.loaded);
  const m = root.querySelector("#btn-measure");
  assert.equal(m.dataset.level, "3");
  assert.equal(text(m.querySelector(".lx-cost")), "~2 min");
  root.querySelector("[data-quick=None]").click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.disabled, true);
  assert.equal(root.querySelector("#cv-measure-why").dataset.why, "locked.no_units");
  root.querySelector("[data-quick=E-clusters]").click();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([...ctl.cv.drawn], ["EC0", "EC1", "EC2", "EC3"]);
  assert.equal(text(m.querySelector(".lx-cost")), "~40 s");
  v.unmount();
  root.remove();
});
