// node --test desktop/app/ui/tests/power_view.test.mjs   (R-S2: Tune › Power on the lx- components — field names, PL1 > PL2 refused in place, the CPU's
// own field bound, the lock, the read-only PL4 row with its powercap note, the live panel). Fake DOM, recorded simulator fixtures (power.read), no helper.
import test from "node:test";
import assert from "node:assert/strict";
import { install, fire, text } from "./fakedom.mjs";
import G from "../fixtures/g217/fixtures-g217.js";
import { createAppStore, setLink, setPreflight, applyHelperEvent } from "../store.js";
import { ensureRt, setRead } from "../lib/rtstate.js";
import { HINTS } from "../lib/hints.js";

install();
const P = await import("../views/tune/power.js");
const { mount, unmount, bindsNow, liveTop, FIELDS } = P;
const PW = G["power-read"].result;

function host({ result = PW, writes = true, values = null } = {}) {
  const store = createAppStore();
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: writes, mode: "write", checks: [] });
  ensureRt(store);
  setRead(store, "power", { state: "ready", result: structuredClone(result) });
  if (values) applyHelperEvent(store, "telemetry", { t: 1, values });
  const el = document.createElement("div");
  document.body.append(el);
  const bridge = { call: async () => ({ ok: true, result: structuredClone(result) }), wait: async () => ({ ok: false, error: { code: "X" } }) };
  mount(el, { store, bridge });
  return { el, store };
}
const field = (el, key) => el.querySelector(`[data-key=${key}]`);
const typeInto = (f, v) => {
  const i = f.querySelector("input");
  i.value = v;
  fire(i, "change");
  return i;
};

test("power: plain labels with the expert term second (DESIGN §6.5), steppers on the three fields, PL4 read only", () => {
  const v = host();
  assert.equal(v.el.dataset.view, "power");
  const labels = v.el.querySelectorAll("[data-panel=limits] .lx-lbl").map((n) => n.textContent);
  assert.deepEqual(labels, ["Long-term limit", "Short-term limit", "Time window", "Peak limit"]);
  const terms = v.el.querySelectorAll("[data-panel=limits] .lx-term").map((n) => n.textContent);
  assert.deepEqual(terms, ["PL1", "PL2", "tau", "PL4 · MSR 0x601"]);
  for (const f of FIELDS) {
    const el = field(v.el, f.key);
    assert.equal(el.querySelectorAll(".lx-step").length, 2, f.key + " has − / +");
    assert.equal(el.dataset.hint, f.hint);
  }
  assert.equal(field(v.el, "pl1_w").querySelector("input").value, "250");
  assert.equal(field(v.el, "tau_s").querySelector("input").value, "127.9");
  const pl4 = v.el.querySelector("tr[data-row=pl4]");
  assert.equal(pl4.querySelectorAll("input").length, 0, "PL4 has no field");
  assert.match(text(pl4), /read only/);
  unmount();
});

test("power: PL1 above PL2 is refused in the field with its reason (POWER_ORDER), the typed text kept, nothing pending", async () => {
  const v = host();
  const i = typeInto(field(v.el, "pl1_w"), "300");
  await Promise.resolve();
  assert.equal(field(v.el, "pl1_w").dataset.state, "refused");
  assert.equal(i.value, "300");
  const row = v.el.querySelector("tr[data-why-for=pl1_w]");
  assert.equal(row.hidden, false);
  const w = row.querySelector("[data-why='refused.power_order']");
  assert.match(text(w), /PL1 may not be above PL2: this makes PL1 300 W and PL2 295 W/);
  assert.deepEqual(v.store.get().rt.edits.power, {});
  // the other side: PL2 below PL1
  typeInto(field(v.el, "pl2_w"), "200");
  assert.equal(field(v.el, "pl2_w").dataset.state, "refused");
  assert.deepEqual(v.store.get().rt.edits.power, {});
  unmount();
});

test("power: a valid edit goes to the runtime slice and marks the row; above the PL field maximum (MSR 0x610) it is refused with that source", () => {
  const v = host();
  typeInto(field(v.el, "pl1_w"), "200");
  assert.deepEqual(v.store.get().rt.edits.power, { pl1_w: 200 });
  assert.equal(v.el.querySelector("tr[data-row=pl1_w]").dataset.state, "edit");
  assert.equal(field(v.el, "pl1_w").dataset.state, "set");
  typeInto(field(v.el, "pl2_w"), "5000");
  const w = v.el.querySelector("tr[data-why-for=pl2_w] [data-why='refused.above_limit']");
  assert.match(text(w), /4095 W \(MSR 0x610 field\)/);
  unmount();
});

test("power: the register lock disables every field, says why once and shows the lock in the band; a power.read without its bounds says Read first", () => {
  const v = host({ result: { ...PW, locked: true } });
  for (const f of FIELDS) assert.equal(field(v.el, f.key).dataset.state, "disabled");
  assert.ok(v.el.querySelector("[data-panel=limits] [data-why='locked.power_lock']"), "the reason, once");
  assert.equal(v.el.querySelector("[data-panel=limits] .lx-band [data-locked]").textContent, "MSR 0x610 locked");
  unmount();
  const u = host({ result: { ...PW, cpu_limits: { ...PW.cpu_limits, power: { locked: null, pl_max_w: null, source: "not read" } } } });
  assert.equal(field(u.el, "pl1_w").dataset.state, "disabled");
  assert.ok(u.el.querySelector("[data-why='locked.no_read']"));
  unmount();
});

test("power: the PL4 row shows MSR 0x601 in watts with its lock state; the footnote says the powercap copy is not enforced", () => {
  const v = host({ values: { pl4: { status: "ok", value: { watts: 425, locked: false, raw: 0xd48 }, unit: "W" } } });
  const pl4 = v.el.querySelector("tr[data-row=pl4]");
  assert.match(text(pl4), /425\s*W/);
  assert.equal(pl4.querySelector("[data-pl4]").dataset.pl4, "unlocked");
  assert.match(text(v.el.querySelector("[data-panel=limits] .lx-tfoot-note")), new RegExp(HINTS["power.pl4_copy"].line.replace(/[.()]/g, "\\$&")));
  assert.match(text(v.el.querySelector("[data-panel=limits] .lx-tfoot-note")), /PL field max 4095 W/);
  unmount();
});

test("power: Restore boot values… is gated (nothing journaled in the recorded read) with its reason", () => {
  const v = host();
  const b = v.el.querySelector("[data-restore=power]");
  assert.equal(text(b), "Restore boot values…");
  assert.equal(b.disabled, true);
  assert.equal(document.getElementById(b.getAttribute("aria-describedby")).dataset.why, "locked.nothing_to_restore");
  unmount();
});

test("power: live panel — binds now from the 0x64F model, the y range covers the limits", () => {
  assert.equal(bindsNow(null), "n/a");
  assert.equal(bindsNow({ state: "ok", active: [], groups: [] }), "none");
  assert.equal(bindsNow({ state: "ok", active: [{ key: "pl1", duty: 0.3 }, { key: "pl2", duty: 0.1 }], groups: [] }), "PL1 30% · PL2 10%");
  assert.equal(bindsNow({ state: "ok", active: [], groups: [{ key: "current", state: "yes", duty: 1, bits: [{ key: "other" }] }] }), "PL4 100%");
  assert.ok(liveTop([55, null, 80], [250, 295, 425]) > 425);
  assert.equal(liveTop([], []), 100);
  const v = host();
  assert.ok(v.el.querySelector("[data-panel=live] [data-plot]"));
  assert.equal(v.el.querySelector("[data-live=binds]").textContent, "n/a");
  unmount();
});
