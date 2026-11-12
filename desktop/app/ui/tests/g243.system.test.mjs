// G-243 (QA-35): System no longer shows the boot_restore state or its command (G-252: Profiles is the one place); it links to Profiles when the helper reports one. Fake DOM, no helper.
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

test("G-252: the System screen has no boot-restore panel; it links to Profiles (the one place for the state and the enable command), and only when the helper reports one", async () => {
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
  const gone = [];
  view.mount(root, { store, bridge, toast: () => {}, head: createWorkHead(headEl), goto: (s, t) => gone.push([s, t]), drawer: null });
  assert.equal(root.querySelector("#sys-boot"), null, "no boot-restore panel");
  assert.doesNotMatch(text(root), /sudo systemctl enable/, "the enable command is not repeated here");
  const go = root.querySelector("#sys-boot-go");
  assert.equal(go.parentNode.hidden, false, "the link is shown");
  go.click();
  assert.deepEqual(gone.pop(), ["profiles", undefined]);
  const { boot_restore: _b, ...none } = store.get().preflight;
  setPreflight(store, none);
  assert.equal(root.querySelector("#sys-boot-go").parentNode.hidden, true, "nothing to link to without the helper's field");
  view.unmount();
});
