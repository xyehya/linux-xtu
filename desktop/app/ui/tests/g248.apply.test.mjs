// G-248 (UI side of the integration follow-ups): items 4 (lastApplyAt), 13 (nothing to do names its read), 14 (residual writes in the sheet).
// Fake DOM, mock bridge; no browser, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { text } from "./fakedom.mjs";
import { A, rig, plainRig, review, until } from "./g242.rig.mjs";

const ST = await import("../views/stress.js");

const emptyPlan = { plan_id: "a".repeat(64), writes: 0, conditional_writes: 0, nothing_to_do: true, based_on_read_at: "2026-11-12T08:30:01Z", steps: [], before: {}, after: {}, units: [], warnings: [], expires_s: 600 };

test("item 4: an apply result sets store.lastApplyAt, and Stress's label follows it (one name)", async () => {
  const r = await rig();
  assert.equal(r.store.get().lastApplyAt, null);
  assert.equal("lastChangeAt" in r.store.get(), false, "one name only");
  await review(r);
  r.root.querySelector("#apply-go").click();
  await until(() => r.store.get().apply.state === "done");
  const at = r.store.get().lastApplyAt;
  assert.ok(at && Date.now() - Date.parse(at) < 5000, "set when the result arrived");
  const read = "2000-01-01T00:00:00Z";
  const model = ST.testedModel({ ...r.store.get(), lastReadAt: read, pending: { changes: 0 } });
  assert.equal(model.stateWhat, "last change", "Stress calls the apply the last change, newer than the read");
  assert.equal(model.stateAt, new Date(at).toISOString());
  r.applyDrawer.dispose();
});

test("item 4: a plan with nothing to do does not count as a change", async () => {
  const r = await plainRig(emptyPlan);
  await review(r);
  assert.equal(await r.ctl.apply(), false);
  assert.equal(r.store.get().lastApplyAt, null);
  r.applyDrawer.dispose();
});

test("item 13: the review and the result of a 0-write plan name the read they rest on, never a bare 'already matches'", async () => {
  const r = await plainRig(emptyPlan);
  await review(r);
  const body = text(r.root.querySelector("#drawer-body"));
  const clock = (iso) => new Date(iso).toTimeString().slice(0, 8);
  assert.ok(body.includes(`The CPU held this state at the last read (${clock(emptyPlan.based_on_read_at)}). Read again to check it still does.`), body);
  assert.doesNotMatch(body, /already matches/i);
  r.applyDrawer.dispose();
  // the result of the apply says the same, from the result's own time when it has one
  const secs = [{ intent: { restore: "accepted" }, plan: emptyPlan, result: { based_on_read_at: "2026-11-12T09:00:00Z" } }];
  assert.ok(A.nothingText0(secs).includes(`(${clock("2026-11-12T09:00:00Z")})`), "the newest time wins");
  assert.equal(A.nothingText0([{ intent: {}, plan: { writes: 0 } }]), "The CPU held this state at the last read. Read again to check it still does.");
});

test("item 14: a plan that may rewrite a leftover OC point is not empty, and the button and summary say 'up to N'", async () => {
  const withResidual = { ...emptyPlan, nothing_to_do: false, residual_writes_max: 16 };
  assert.equal(A.isEmptyPlan({ ...emptyPlan, residual_writes_max: 16 }), false, "never empty with residual writes, whatever nothing_to_do says");
  assert.equal(A.isEmptyPlan(emptyPlan), true);
  assert.equal(A.planResidual(withResidual), 16);
  assert.equal(A.planResidual({ writes: 1 }), 0);
  assert.equal(A.writesText(2, 1, 16), "2 writes (+1 if needed; + up to 16 if a leftover OC point is found)");
  assert.equal(A.writesText(0, 0, 16), "0 writes (+ up to 16 if a leftover OC point is found)");
  assert.equal(A.writesText(2, 0), "2 writes");
  const r = await plainRig(withResidual);
  await review(r);
  const go = r.root.querySelector("#apply-go");
  assert.ok(go, "Apply is offered");
  assert.match(text(go), /Apply 0 writes/);
  assert.match(text(go), /\+ up to 16 if a leftover OC point is found/);
  assert.match(text(r.root.querySelector("#apply-summary")), /\+ up to 16 if a leftover OC point is found/);
  r.applyDrawer.dispose();
});
