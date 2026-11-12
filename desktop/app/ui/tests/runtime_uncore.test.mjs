// node --test desktop/app/ui/tests/runtime_uncore.test.mjs   (R-S2: Tune › Ring & uncore — the ring clock range only, min ≤ max refused in place, the
// NGU/D2D note, no ring V/F editor (a pointer to Cores instead), the caps-and-uncore restore label; the deprecated Ratio caps tab's label). Fake DOM, recorded fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { install, fire, text } from "./fakedom.mjs";
import G from "../fixtures/g217/fixtures-g217.js";
import { createAppStore, setLink, setPreflight } from "../store.js";
import { ensureRt, setRead } from "../lib/rtstate.js";
import { HINTS } from "../lib/hints.js";

install();
const R = await import("../views/tune/ring.js");
const { mount, unmount, uncoreOrder, uncoreLock } = R;
const { RESTORE_LABEL, restoreGate } = await import("../views/tune/rt-common.js");
const RT = G["runtime-read"].result;

function host({ result = RT, tune = null, state = "ready" } = {}) {
  const store = createAppStore();
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: true, mode: "write", checks: [] });
  ensureRt(store);
  setRead(store, "runtime", { state, result: result ? structuredClone(result) : null });
  const el = document.createElement("div");
  document.body.append(el);
  const bridge = { call: async () => ({ ok: true, result: structuredClone(result || RT) }), wait: async () => ({ ok: false, error: { code: "X" } }) };
  mount(el, { store, bridge, tune });
  return { el, store };
}
const field = (el, key) => el.querySelector(`[data-key=${key}]`);
const typeInto = (f, v) => {
  const i = f.querySelector("input");
  i.value = v;
  fire(i, "change");
  return i;
};

test("uncore: the order rule refuses from either side with its own reason; equal is fine", () => {
  const cur = { min: 8, max: 40 };
  assert.equal(uncoreOrder(cur, {}, "min_ratio", 40), null);
  assert.deepEqual(uncoreOrder(cur, {}, "min_ratio", 41), { key: "refused.uncore_order", vars: { max: "40" } });
  assert.deepEqual(uncoreOrder(cur, { min_ratio: 20 }, "max_ratio", 19), { key: "refused.uncore_order_max", vars: { min: "20" } });
  assert.equal(uncoreOrder(null, {}, "max_ratio", 30), null, "nothing read: nothing to compare");
});

test("uncore: the tab holds the ring clock range only — two fields, no V/F editor, the NGU/D2D note, a pointer to Cores › Ring", () => {
  const calls = [];
  const tune = { state: () => ({ model: { units: { ring: {} } } }), setSelection: (ids) => calls.push(["sel", ids]), setSubtab: (id) => calls.push(["tab", id]) };
  const v = host({ tune });
  assert.equal(v.el.dataset.view, "uncore");
  assert.deepEqual(v.el.querySelectorAll("[data-panel=range] input").length, 2);
  assert.equal(field(v.el, "min_ratio").querySelector("input").value, "8");
  assert.equal(field(v.el, "max_ratio").querySelector("input").value, "40");
  assert.deepEqual(v.el.querySelectorAll("[data-panel=range] .lx-lbl").map((n) => n.textContent), ["Ring clock, minimum", "Ring clock, maximum"]);
  assert.equal(v.el.querySelectorAll(".curve-editor, [data-section=ring-vf]").length, 0, "no ring V/F editor");
  const note = v.el.querySelector("[data-note=ngu-d2d]");
  assert.match(text(note), /NGU and D2D/);
  assert.match(text(note), /changes neither NGU nor D2D/);
  assert.doesNotMatch(text(v.el.querySelector("[data-panel=range]")), /NGU (ratio|clock),? (minimum|maximum)/, "the range never claims NGU");
  v.el.querySelector("[data-action=open-ring-vf]").click();
  assert.deepEqual(calls, [["sel", ["ring"]], ["tab", "cores"]]);
  assert.equal(v.el.querySelector("[data-live=ring]").textContent, "n/a", "no live ring clock source yet: n/a, said once");
  unmount();
});

test("uncore: a minimum above the maximum is refused in the field (typed text kept), a valid edit lands in the runtime slice", async () => {
  const v = host();
  typeInto(field(v.el, "max_ratio"), "20");
  assert.deepEqual(v.store.get().rt.edits.uncore, { max_ratio: 20 });
  assert.equal(v.el.querySelector("tr[data-row=max_ratio]").dataset.state, "edit");
  const i = typeInto(field(v.el, "min_ratio"), "30");
  await Promise.resolve();
  assert.equal(field(v.el, "min_ratio").dataset.state, "refused");
  assert.equal(i.value, "30");
  const w = v.el.querySelector("tr[data-why-for=min_ratio] [data-why='refused.uncore_order']");
  assert.match(text(w), /may not be above the maximum \(20×\)/);
  assert.deepEqual(v.store.get().rt.edits.uncore, { max_ratio: 20 }, "the refused minimum is not an edit");
  typeInto(field(v.el, "max_ratio"), "50");
  assert.equal(field(v.el, "max_ratio").dataset.state, "refused", "above the driver's initial range");
  unmount();
});

test("uncore: no interface / offline / reading lock the fields with one reason", () => {
  const s = createAppStore();
  ensureRt(s);
  assert.equal(uncoreLock(s.get()).state, "reading");
  setRead(s, "runtime", { state: "ready", result: { ...RT, uncore: null, uncore_note: "no intel_uncore_frequency" } });
  assert.deepEqual(uncoreLock(s.get()), { state: "disabled", key: "locked.unavailable", vars: { reason: "no intel_uncore_frequency" } });
  setRead(s, "runtime", { state: "ready", result: { ...RT, offline: [3] } });
  assert.deepEqual(uncoreLock(s.get()), { state: "disabled", key: "locked.cpu_offline", vars: { cpu: "3" } });
  const v = host({ result: { ...RT, offline: [3] } });
  assert.equal(field(v.el, "min_ratio").dataset.state, "disabled");
  assert.ok(v.el.querySelector("[data-panel=range] [data-why='locked.cpu_offline']"));
  unmount();
});

test("restore: the runtime restore says caps AND uncore (one journal, U-24); the power one does not; the gate names the reason", () => {
  assert.equal(RESTORE_LABEL.runtime, "Restore boot caps and uncore…");
  assert.equal(RESTORE_LABEL.power, "Restore boot values…");
  assert.match(HINTS["rt.restore_runtime"].line, /ratio caps and the ring range/);
  const v = host();
  const b = v.el.querySelector("[data-restore=runtime]");
  assert.equal(text(b), RESTORE_LABEL.runtime);
  assert.deepEqual(restoreGate(v.store.get(), "runtime"), { key: "locked.nothing_to_restore", vars: { what: "ratio cap or ring range" } });
  setRead(v.store, "runtime", { state: "ready", result: { ...RT, journal: { caps: { 0: 5700000 }, uncore: {} } } });
  assert.equal(restoreGate(v.store.get(), "runtime"), null);
  assert.equal(b.disabled, false);
  unmount();
});
