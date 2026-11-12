// node --test desktop/app/ui/tests/   (R-S1: Tune › Cores mounted on the small fake DOM — the unit table drives the inspector; typed offsets reach the draft through
// lib/draft.js edit*; refusals stay in the field with their reason (typed text kept, nothing in the draft); the whole-curve offset is its own layer; the OC band;
// the section locks said once; the tab list in the work header). Selectors are data-* / roles / ids, never lx- classes. No browser, no helper, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { install, key, fire, text } from "./fakedom.mjs";

const doc = install();
const { createAppStore, setUvp } = await import("../store.js");
const { createWorkHead } = await import("../components/workhead.js");
const tune = await import("../views/tune.js");
const { modelFromRead } = await import("../lib/units.js");
const FIX = (await import("../fixtures/fixtures.js")).default;
const READ = FIX["tune-read"].result;

const BRIDGE = { name: "stub", call: async () => ({ ok: false, error: { code: "X", message: "not in this test" } }), on: () => () => {}, wait: async () => ({ ok: false, error: { message: "x" } }) };
const BASE_REC = { units: { P0: { points: [8, 20, 30, 48, 53, 55, 56, 57].map((r, i) => ({ ratio: r, status: "ok", vid_v: 0.9 + i * 0.05 })) } } };

function mount(read = READ) {
  doc.body.replaceChildren();
  const store = createAppStore();
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  root.id = "screen";
  doc.body.append(headEl, root);
  const head = createWorkHead(headEl);
  const ctx = { store, bridge: BRIDGE, toast: () => {}, head, goto: () => {} };
  const view = tune.tuneView();
  view.mount(root, ctx);
  const model = modelFromRead(structuredClone(read));
  tune.patchTune(store, { model, selection: ["P0"], anchor: "P0", base: { state: "ready", fn: tune.baselineFromRecord(BASE_REC), name: "test baseline", id: "t", reason: "" } });
  const $ = (sel) => root.querySelector(sel);
  const row = (unit) => $(`[data-unit-table] tr[data-unit='${unit}']`);
  const vf = (kind = "P") => $(`[data-vf-table='${kind}']`);
  const field = (ratio, kind = "P") => vf(kind).querySelector(`tr[data-ratio='${ratio}'] input`);
  const type = (input, value) => {
    input.focus();
    input.value = value;
    key(input, "Enter");
  };
  return { store, root, headEl, view, model, $, row, vf, field, type, draft: () => store.get().tune.draft };
}

test("cores: the tab list is Cores · Frequency · Power · Ring & uncore with the persistence tag; the body is the unit table + the inspector", () => {
  const t = mount();
  const tabs = t.headEl.querySelectorAll("[role=tab]");
  assert.deepEqual(tabs.map((b) => text(b)), ["Cores", "Frequency", "Power", "Ring & uncore"]);
  assert.equal(t.headEl.querySelector("#subtab-cores").getAttribute("aria-selected"), "true");
  assert.match(text(t.headEl), /Mailbox · cold boot clears/i);
  assert.equal(t.root.dataset.legacy, "false", "Cores is built in the new design");
  assert.ok(t.$("[data-tune-cores]"));
  assert.equal(t.root.querySelectorAll("[data-unit-table] tr[data-unit]").length, 13, "8 P-cores, 4 E-clusters, the ring");
  assert.deepEqual(t.root.querySelectorAll("[data-unit-table] tr[data-group]").map((r) => r.dataset.group), ["P", "E", "R"]);
  assert.equal(t.row("P0").getAttribute("aria-selected"), "true");
  assert.equal(text(t.$("[data-part=title]")), "P0 ★");
  assert.match(text(t.$("[data-part=facts]")), /^cpu 0 · factory top 57× · max ratio 57× · no OC point · favored$/);
  assert.equal(t.vf().querySelectorAll("tr[data-ratio]").length, 8);
  assert.match(text(t.$("[data-unit-table]")), /E-clusters ?4 · 4 CPUs each, one curve/);
});

test("cores: a click on a unit row selects it; Ctrl-click adds; the inspector follows; an E-cluster is one unit of four CPUs", () => {
  const t = mount();
  fire(t.row("EC0"), "click");
  assert.deepEqual(t.store.get().tune.selection, ["EC0"]);
  assert.equal(text(t.$("[data-part=title]")), "EC0");
  assert.match(text(t.$("[data-part=facts]")), /cpus 8–11 · 4 CPUs, one ratio, one curve · factory top 46× · runs 48× \(set at boot\), no OC point/);
  assert.ok(t.vf("E"));
  fire(t.row("P0"), "click", { ctrlKey: true });
  assert.deepEqual(t.store.get().tune.selection, ["P0", "EC0"]);
  assert.ok(t.vf("P") && t.vf("E"), "P and E selected: two sections");
  fire(t.row("ring"), "click");
  assert.ok(t.vf("R"));
  assert.equal(t.$("[data-oc-band]"), null, "the ring has no OC band (D-045)");
  // Ctrl-click the only selected unit: the inspector keeps it
  fire(t.row("ring"), "click", { ctrlKey: true });
  assert.deepEqual(t.store.get().tune.selection, ["ring"]);
});

test("cores: a typed offset reaches the draft (point layer), the row and the unit row turn edited, After / Δ follow", () => {
  const t = mount();
  t.type(t.field(48), "-20");
  assert.deepEqual(t.draft().units.P0.pts, { 48: -20 });
  const tr = t.vf().querySelector("tr[data-ratio='48']");
  assert.equal(tr.dataset.state, "edit");
  assert.equal(t.field(48).closest("[data-state]").dataset.state, "set");
  assert.equal(t.row("P0").dataset.state, "edit");
  assert.equal(text(t.row("P0").querySelector("td[data-col=off]")), "−19.5", "QA-04: −20 is the raw −20 = −19.53 mV the CPU will hold");
  const cells = tr.querySelectorAll("td");
  assert.equal(text(cells[5]), "1.030");
  assert.equal(cells[5].dataset.v, "set");
  assert.equal(text(cells[6]), "−19.5");
  assert.equal(t.store.get().pending.changes, 1);
});

test("cores: a refused value stays in the field with its reason — typed text kept, the row marked, nothing in the draft; Esc restores", () => {
  const t = mount();
  const input = t.field(48);
  t.type(input, "-1200");
  const wrap = input.closest("[data-state]");
  assert.equal(wrap.dataset.state, "refused");
  assert.equal(input.value, "-1200");
  assert.deepEqual(t.draft().units, {});
  const whyRow = t.vf().querySelector("tr[data-why-for='48']");
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return flush().then(() => {
    assert.equal(whyRow.hidden, false);
    assert.match(text(whyRow), /^Refused ?−1200 is below the field’s floor of −1000 mV\. Nothing changed\.$/);
    assert.equal(t.vf().querySelector("tr[data-ratio='48']").dataset.state, "refused");
    assert.equal(input.getAttribute("aria-describedby"), whyRow.querySelector("[data-why]").id);
    // a store change elsewhere does not wipe the refusal
    t.type(t.field(20), "-5");
    assert.equal(wrap.dataset.state, "refused");
    // positive offsets are refused with their own reason (D-053 §5)
    t.type(t.field(30), "5");
    return flush().then(() => {
      assert.match(text(t.vf().querySelector("tr[data-why-for='30']")), /^Refused ?Only 0 or negative offsets are offered/);
      assert.equal(t.draft().units.P0.pts[30], undefined);
      key(input, "Escape");
      assert.equal(wrap.dataset.state, "idle");
    });
  });
});

test("cores: the whole-curve offset is its own layer and adds; a point change on the same unit is then refused in place (one offset kind per apply)", () => {
  const t = mount();
  const curve = t.$("[data-curve='P'] input");
  t.type(curve, "-10");
  assert.equal(t.draft().units.P0.curveMv, -10);
  assert.deepEqual(t.draft().units.P0.pts, {}, "the point layer is untouched");
  assert.equal(t.field(48).value, "0", "the point field shows its own layer");
  const tr = t.vf().querySelector("tr[data-ratio='48']");
  assert.equal(text(tr.querySelectorAll("td")[6]), "−9.8", "Δ: the effective offset moved by the curve (as the CPU will hold it)");
  assert.equal(text(t.row("P0").querySelector("td[data-col=off]")), "−9.8", "the unit's deepest effective offset includes the whole curve");
  t.type(t.field(48), "-20");
  assert.equal(t.field(48).closest("[data-state]").dataset.state, "refused");
  assert.deepEqual(t.draft().units.P0.pts, {});
  return new Promise((r) => setTimeout(r, 0)).then(() => assert.match(text(t.vf().querySelector("tr[data-why-for='48']")), /^Refused ?A whole-curve change and point changes on one unit/));
});

test("cores: the OC band — the voltage is locked until an OC ratio exists; a typed OC ratio adds the OC point row with its target; a ratio outside the window is refused", () => {
  const t = mount();
  fire(t.row("P1"), "click");
  const band = t.$("[data-oc-band='P']");
  const vt = band.querySelector("[data-oc='voltage'] input");
  assert.equal(vt.disabled, true);
  assert.match(text(band), /Locked ?Set an OC ratio above the factory top \(57×\) first/);
  const ratio = band.querySelector("[data-oc='ratio'] input");
  t.type(ratio, "200");
  assert.equal(ratio.closest("[data-state]").dataset.state, "refused");
  assert.match(text(band), /Refused ?200 is above the CPU’s limit of 120 ×/);
  assert.deepEqual(t.draft().units, {});
  t.type(ratio, "58");
  assert.equal(t.draft().units.P1.ratio, 58);
  assert.equal(t.draft().units.P1.vtAuto, true, "the new OC point takes the un-offset factory top voltage as its target");
  assert.equal(vt.disabled, false);
  const oc = t.vf().querySelector("tr[data-oc]");
  assert.ok(oc, "the OC point is the last row");
  assert.equal(oc.dataset.point, "9");
  assert.equal(oc.dataset.state, "edit");
  assert.match(text(band), /Capped ?OC 58× is above the turbo table \(57×\)/, "D-050: the table still caps it");
  t.type(vt, "0.5");
  assert.equal(vt.closest("[data-state]").dataset.state, "refused");
  assert.match(text(band), /Refused ?0\.500 is below the field’s floor of 0\.900 V/);
});

test("cores: locks are said once per section — UVP on disables the offset fields with one reason; a read in flight puts every field in `reading`", () => {
  const t = mount();
  setUvp(t.store, "on");
  const whys = t.$("[data-whys='P']");
  assert.match(text(whys), /Locked ?Undervolt Protection is on in the BIOS/);
  assert.equal(t.field(48).disabled, true);
  assert.equal(t.field(48).getAttribute("aria-describedby"), whys.querySelector("[data-why]").id, "every locked field is described by the one reason");
  assert.equal(t.vf().querySelectorAll("tr[data-why-for]:not([hidden])").length, 0, "no reason repeated per row");
  setUvp(t.store, "off");
  tune.patchTune(t.store, { read: { ...t.store.get().tune.read, state: "reading" } });
  assert.equal(t.field(48).closest("[data-state]").dataset.state, "reading");
  assert.equal(t.$("[data-curve='P']").dataset.state, "reading");
});

test("cores: several units selected show `mixed` where they differ; typing sets all of them", () => {
  const t = mount();
  fire(t.row("EC0"), "click");
  t.type(t.field(15, "E"), "-35");
  fire(t.row("EC3"), "click", { shiftKey: true });
  assert.deepEqual(t.store.get().tune.selection, ["EC0", "EC1", "EC2", "EC3"]);
  const f = t.field(15, "E");
  assert.equal(f.closest("[data-state]").dataset.state, "mixed");
  assert.equal(f.placeholder, "−35.2…0");
  t.type(f, "-10");
  assert.deepEqual(["EC0", "EC1", "EC2", "EC3"].map((id) => t.draft().units[id].pts[15]), [-10, -10, -10, -10]);
});

test("cores: Discard drops the units' edits; the Frequency tab id stays `turbo` and holds the one Frequency module", () => {
  const t = mount();
  t.type(t.field(48), "-20");
  const discard = t.$("[data-discard='P']");
  assert.equal(discard.hidden, false);
  discard.click();
  assert.deepEqual(t.draft().units, {});
  assert.equal(discard.hidden, true);
  tune.patchTune(t.store, { subtab: "ratios" });
  assert.equal(t.store.get().tune.subtab, "turbo");
  assert.equal(t.headEl.querySelector("#subtab-turbo").getAttribute("aria-selected"), "true");
  assert.deepEqual(t.root.querySelectorAll("[data-part]").filter((e) => e.closest("#tune-panel")).map((e) => e.dataset.part).filter((p) => p === "turbo" || p === "runtime" || p === "frequency"), ["frequency"]);
  t.view.unmount();
});

test("cores: a 1/1024 V read shows one decimal; Enter on it changes nothing; ↓ steps to the next whole mV the CPU can hold", () => {
  const r = structuredClone(READ);
  r.tune.P0.cpus[0].points.find((p) => p.ratio === 53).offset_mv = -19.53;
  const t = mount(r);
  const f = t.field(53);
  assert.equal(f.value, "−19.5");
  f.focus();
  key(f, "Enter");
  assert.deepEqual(t.draft().units, {}, "the value held is not an edit");
  assert.equal(f.value, "−19.5");
  key(f, "ArrowDown");
  assert.equal(t.draft().units.P0.pts[53], -21, "−20 is the same 1/1024 V word as −19.53: the step goes to the next one");
  assert.equal(f.value, "−21.5", "shown as the step the CPU holds");
  key(f, "ArrowUp");
  assert.deepEqual(t.draft().units, {}, "−20 is the word read: no edit left");
  assert.equal(f.value, "−19.5");
  key(f, "ArrowUp");
  assert.equal(t.draft().units.P0.pts[53], -18);
  assert.equal(f.value, "−17.6");
});
