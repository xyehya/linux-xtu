// G-243 (QA-20): Tune › Ring & uncore shows the live ring clock from the helper's telemetry `values.ring`; n/a only when it is not reported.
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "./fakedom.mjs";
import G from "../fixtures/g217/fixtures-g217.js";
import { createAppStore, setLink, setPreflight, applyHelperEvent } from "../store.js";
import { ensureRt, setRead } from "../lib/rtstate.js";

install();
const { mount, unmount, ringNow } = await import("../views/tune/ring.js");

const leaf = (value, unit, source = "intel_uncore_frequency/package_00_die_00/current_freq_khz") => ({ value, unit, source, status: "ok" });
const gone = (reason) => ({ value: null, unit: "", source: "msr 0x621[6:0]", status: "unavailable", reason });

test("ringNow: ratio and MHz when reported, n/a with the helper's reason when not", () => {
  assert.deepEqual(ringNow({ ring: { mhz: leaf(4100, "MHz"), ratio: leaf(41, "x") } }), { text: "41× · 4100 MHz", ratio: 41, mhz: 4100, note: "" });
  assert.equal(ringNow({ ring: { mhz: leaf(800, "MHz"), ratio: gone("x") } }).text, "8× · 800 MHz", "one leaf is enough");
  const na = ringNow({ ring: { mhz: gone("no MSR access (needs root)"), ratio: gone("no MSR access (needs root)") } });
  assert.deepEqual([na.text, na.note], ["n/a", "no MSR access (needs root)"]);
  assert.equal(ringNow({}).text, "n/a", "an older helper without the key");
  assert.equal(ringNow(null).note, "no telemetry yet");
});

test("the Ring & uncore view shows the live ring clock and follows each telemetry tick; no n/a while it is present", () => {
  const store = createAppStore();
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: true, mode: "write", checks: [] });
  ensureRt(store);
  setRead(store, "runtime", { state: "ready", result: structuredClone(G["runtime-read"].result) });
  const el = document.createElement("div");
  document.body.append(el);
  mount(el, { store, bridge: { call: async () => ({ ok: true, result: structuredClone(G["runtime-read"].result) }), wait: async () => ({ ok: false, error: { code: "X" } }) }, tune: null });
  const live = () => el.querySelector("[data-live=ring]");
  assert.equal(live().textContent, "n/a", "before the first telemetry tick");
  applyHelperEvent(store, "telemetry", { t: 1, values: { ring: { mhz: leaf(4100, "MHz"), ratio: leaf(41, "x") } } });
  assert.equal(live().textContent, "41× · 4100 MHz");
  assert.notEqual(live().textContent, "n/a");
  assert.equal(el.querySelector("[data-panel=now] .lx-why").hidden, true, "no reason line while the clock is shown");
  applyHelperEvent(store, "telemetry", { t: 2, values: { ring: { mhz: leaf(800, "MHz"), ratio: leaf(8, "x") } } });
  assert.equal(live().textContent, "8× · 800 MHz");
  applyHelperEvent(store, "telemetry", { t: 3, values: { ring: { mhz: gone("no sysfs"), ratio: gone("no sysfs") } } });
  assert.equal(live().textContent, "n/a");
  assert.equal(el.querySelector("[data-panel=now] .lx-why").hidden, false);
  unmount();
});
