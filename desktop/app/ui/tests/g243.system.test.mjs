// G-243 (QA-35): System shows the helper's boot_restore state from the preflight, with the enable command when it is off. Fake DOM, no helper.
import test from "node:test";
import assert from "node:assert/strict";
import { install, text } from "./fakedom.mjs";
import FIX from "../fixtures/fixtures.js";

install();
const SY = await import("../views/system.js");

test("bootRestoreModel: the three states and an unknown one, with the helper's note", () => {
  const note = "Boot restore is off: linux-xtu-restore.timer is installed but disabled. To bring the accepted state back after a boot, run: sudo systemctl enable linux-xtu-restore.timer";
  assert.deepEqual(SY.bootRestoreModel({ boot_restore: { state: "disarmed", note } }), { state: "disarmed", label: "disarmed", tag: "warn", note });
  assert.equal(SY.bootRestoreModel({ boot_restore: { state: "armed", note: "x" } }).tag, "ok");
  assert.equal(SY.bootRestoreModel({ boot_restore: { state: "not_installed", note: "x" } }).label, "not installed");
  assert.equal(SY.bootRestoreModel({ boot_restore: { state: "unknown", note: "could not be read" } }).label, "unknown");
});

test("the fixture preflight carries boot_restore {state, note}, as the helper sends it", () => {
  const br = FIX.preflight.result.boot_restore;
  assert.ok(br && ["not_installed", "disarmed", "armed", "unknown"].includes(br.state));
  assert.equal(typeof br.note, "string");
});

test("the System screen shows the disarmed state with the enable command", async () => {
  const { createAppStore, setLink, setPreflight } = await import("../store.js");
  const { createWorkHead } = await import("../components/workhead.js");
  const store = createAppStore();
  setLink(store, { state: "connected", kind: null, message: "" });
  const note = "Boot restore is off. To bring the accepted state back after a boot, run: sudo systemctl enable linux-xtu-restore.timer";
  setPreflight(store, { ...FIX.preflight.result, boot_restore: { state: "disarmed", note } });
  const headEl = document.createElement("div");
  const root = document.createElement("main");
  document.body.append(headEl, root);
  const { Bridge } = await import("../bridge.js");
  const { createMockTransport } = await import("../fixtures/mock-backend.js");
  const bridge = new Bridge(createMockTransport({ intervalMs: 5, stepMs: 1, applyMode: null, profiles: null, accept: null, fingerprint: null, confirmMs: 1 }), "mock");
  const view = SY.systemView();
  view.mount(root, { store, bridge, toast: () => {}, head: createWorkHead(headEl), goto: () => {}, drawer: null });
  const boot = root.querySelector("#sys-boot");
  assert.equal(boot.hidden, false);
  assert.match(text(boot), /Boot restore:\s*disarmed/);
  assert.match(text(boot), /sudo systemctl enable linux-xtu-restore\.timer/);
  view.unmount();
});
