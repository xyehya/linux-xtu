// Final live QA 2026-11-12: a cold start answered preflight BUSY (the helper's slow-op slots were taken by views loading at connect) and the session
// stayed read-only with no unit list. startUp retries a BUSY preflight; other errors are reported once, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "./fakedom.mjs";

install();
const { startUp, PREFLIGHT_BUSY_RETRY_MS } = await import("../app.js");
const { createAppStore } = await import("../store.js");

function fakeBridge(preflightAnswers) {
  const calls = [];
  return {
    calls,
    call: async (op) => {
      calls.push(op);
      if (op === "preflight") return preflightAnswers.length ? preflightAnswers.shift() : { ok: true, result: { checks: [], units: [] } };
      if (op === "tune.last") return { ok: true, result: { available: false } };
      return { ok: true, result: {} };
    },
  };
}
const busy = { ok: false, error: { code: "BUSY", message: "4 read-only operations are already running; try again" } };

test("startUp retries a BUSY preflight and the store gets it", async () => {
  const store = createAppStore();
  const toasts = [];
  const bridge = fakeBridge([busy, busy]);
  await startUp({ store, bridge, toast: (k, m) => toasts.push([k, m]), wait: async () => {} });
  assert.equal(bridge.calls.filter((o) => o === "preflight").length, 3);
  assert.ok(store.get().preflight, "preflight landed after the retries");
  assert.deepEqual(toasts.filter(([k]) => k === "error"), []);
});

test("startUp gives up after the retry list and says so once; a non-BUSY error is not retried", async () => {
  const store = createAppStore();
  const toasts = [];
  const b1 = fakeBridge(Array(PREFLIGHT_BUSY_RETRY_MS.length + 1).fill(busy));
  await startUp({ store, bridge: b1, toast: (k, m) => toasts.push([k, m]), wait: async () => {} });
  assert.equal(b1.calls.filter((o) => o === "preflight").length, PREFLIGHT_BUSY_RETRY_MS.length + 1);
  assert.equal(toasts.filter(([k]) => k === "error").length, 1);
  const b2 = fakeBridge([{ ok: false, error: { code: "REFUSED", message: "no" } }]);
  await startUp({ store: createAppStore(), bridge: b2, toast: () => {}, wait: async () => {} });
  assert.equal(b2.calls.filter((o) => o === "preflight").length, 1);
});
