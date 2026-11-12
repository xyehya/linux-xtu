// node --test desktop/app/ui/tests/   (G-249: the QA round-2 fixes R2-01..R2-09 on the UI side. Fake DOM; no browser, no hardware.)
// Every test unmounts what it mounted in a `finally`, so a failed assertion never leaves a timer or a view running (node exits on its own).
import test from "node:test";
import assert from "node:assert/strict";
import { rig, review } from "./g242.rig.mjs";

const { closeDrawer } = await import("../store.js");

test("R2-01: the commit sheet releases the work area in the same turn as Close (hidden, inert, focus already outside), and shows again on the next open", async () => {
  const r = await rig();
  try {
    assert.equal(r.root.hidden, true, "a parked sheet is out of the page");
    await review(r);
    assert.equal(r.root.hidden, false);
    assert.equal(r.root.inert, false);
    assert.equal(r.root.dataset.open, "true");
    const states = [];
    const screen = globalThis.document.getElementById("screen");
    screen.tabIndex = -1;
    const realFocus = screen.focus.bind(screen);
    screen.focus = () => {
      states.push(["focus", r.root.hidden, r.root.inert]);
      realFocus();
    };
    closeDrawer(r.store);
    assert.equal(r.root.dataset.open, "false");
    assert.equal(r.root.hidden, true, "no element of the sheet is left to catch a pointer event (no slide-out, no scrim)");
    assert.equal(r.root.inert, true);
    assert.equal(r.root.contains(globalThis.document.activeElement), false, "focus is not left inside the closed sheet");
    assert.deepEqual(states, [["focus", false, false]], "focus went back out while the sheet was still live, then it was hidden");
    r.store.events.dispatchEvent(new CustomEvent("tune:review"));
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.root.hidden, false, "Review shows it again");
  } finally {
    r.applyDrawer.dispose();
    r.sheet.dispose();
  }
});
