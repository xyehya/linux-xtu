// node --test desktop/app/ui/tests/   (G-242: the apply / plan path fixes of the 2026-11-12 QA — QA-29 outcome of an empty plan, QA-05 write counts, QA-06 footer Close,
// QA-10 write kinds, QA-12 the turbo row survives its apply, QA-14 stale tooltip / swallowed click, QA-31 Technical notes. Fake DOM, mock bridge; no browser, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { fire, text } from "./fakedom.mjs";
import { A, READ, rig, plainRig, review, until } from "./g242.rig.mjs";

const { closeDrawer } = await import("../store.js");
const { modelFromRead } = await import("../lib/units.js");
const { setBucket } = await import("../lib/draft.js");

const body = (r) => text(r.root.querySelector("#drawer-body"));

test("QA-06: after an apply the footer Close closes the sheet", async () => {
  const r = await rig();
  await review(r);
  r.root.querySelector("#apply-go").click();
  await until(() => r.store.get().apply.state === "done");
  assert.equal(text(r.root.querySelector("#apply-close")), "Close");
  r.root.querySelector("#apply-close").click();
  assert.equal(r.store.get().drawer.open, false, "the footer Close closed the sheet");
  assert.equal(r.root.inert, true);
  r.applyDrawer.dispose();
});

test("QA-06: a footer button held down is not rebuilt under the pointer (the click would be lost); the rebuild comes after the release", async () => {
  const r = await rig();
  await review(r);
  const close = r.root.querySelector("#apply-close");
  fire(close, "mousedown");
  r.store.update((s) => ({ apply: { ...s.apply, seq: s.apply.seq + 1, error: { message: "x", located: null } } })); // a structural change while the button is down
  assert.equal(r.root.querySelector("#apply-close"), close, "the footer node under the pointer is still there");
  fire(close, "mouseup");
  fire(close, "click");
  await until(() => r.root.querySelector("#apply-close") !== close, 500);
  r.applyDrawer.dispose();
});

test("QA-14: the sheet's own Close carries no native tooltip (it outlived the sheet and took the next click); a closing sheet stops catching the pointer at once", async () => {
  const r = await rig();
  const head = r.root.querySelector("#drawer-close");
  assert.equal(head.getAttribute("title"), null);
  assert.equal(head.dataset.hint, "sheet.close", "the context line says what it does");
  await review(r);
  assert.equal(r.root.inert, false);
  closeDrawer(r.store);
  assert.equal(r.root.inert, true, "inert the moment it closes: no pointer event reaches it while it slides away");
  assert.equal(r.root.querySelectorAll("[title]").length, 0, "no tooltip owner left in the closed sheet");
  r.applyDrawer.dispose();
});

test("QA-29: a done section with an empty read-back is not a mismatch; the outcome of an all-nothing run is 'Nothing to apply', not 'Read-back mismatch'", () => {
  const s = A.summarizeResult({ complete: true, readback: [], writes_sent: 0, nothing_to_do: true });
  assert.deepEqual([s.allMatch, s.mismatches.length, s.nothingToDo], [true, 0, true]);
  assert.equal(A.summarizeResult({ complete: true, readback: [], writes_sent: 2 }).allMatch, true, "a complete run is a match unless a word differs");
  assert.equal(A.summarizeResult({ complete: false, readback: [], writes_sent: 1 }).allMatch, false);
  assert.equal(A.summarizeResult({ complete: true, readback: [{ match: false }], writes_sent: 1 }).allMatch, false);
  const sec = { kind: "tune", status: "done", intent: { restore: "accepted" }, plan: { writes: 0 }, summary: s, error: null, opId: null };
  assert.equal(A.outcomeOf({ state: "failed", sections: [sec] }), null, "never classed as a mismatch");
  const o = A.outcomeOf({ state: "done", sections: [sec] });
  assert.deepEqual([o.kind, o.title, o.text], ["ok", "Nothing to apply", "The CPU held this state at the last read. Read again to check it still does."]);
});

const emptyPlan = { plan_id: "a".repeat(64), writes: 0, conditional_writes: 0, nothing_to_do: true, based_on_read_at: "2026-11-12T08:30:01Z", steps: [], before: {}, after: {}, units: [], warnings: [], expires_s: 600 };

test("QA-29: the Review of a 0-write plan says there is nothing to restore, has no Apply button, and Apply asks for no dialog and sends nothing", async () => {
  const r = await plainRig(emptyPlan);
  await review(r);
  assert.match(body(r), /The CPU held this state at the last read \(\d\d:\d\d:\d\d\)\. Read again to check it still does\./);
  assert.equal(r.root.querySelector("#apply-go"), null, "no Apply button");
  assert.equal(text(r.root.querySelector("#apply-summary")).includes("0 writes"), false);
  assert.match(text(r.root.querySelector("#apply-tag")), /nothing to do/);
  assert.equal(await r.ctl.apply(), false);
  assert.deepEqual(r.log.map((x) => x[0]), ["tune.plan"], "no app.confirm, no tune.apply");
  r.applyDrawer.dispose();
});

test("QA-29: a plan with no write that the helper says could still add one (nothing_to_do false) is not called empty", () => {
  assert.equal(A.isEmptyPlan(emptyPlan), true);
  assert.equal(A.isEmptyPlan({ ...emptyPlan, nothing_to_do: false }), false);
  assert.equal(A.isEmptyPlan({ ...emptyPlan, writes: 1 }), false);
});

test("QA-05: the count is what the plan certainly sends; the conditional per-core enable is '+1 if needed', and a finished run shows what was sent", async () => {
  assert.equal(A.planWrites({ steps: [{ kind: "write_percore_enable", conditional: true }, { kind: "write_vf_point", unit: "P0", point: 5 }] }), 1, "an old plan without the new fields: the conditional step is not a certain write");
  assert.equal(A.planConditional({ steps: [{ kind: "write_percore_enable", conditional: true }] }), 1);
  assert.equal(A.writesText(2, 1), "2 writes (+1 if needed)");
  const r = await rig();
  await review(r);
  const plan = r.store.get().apply.sections[0].plan;
  const go = r.root.querySelector("#apply-go");
  assert.match(text(go), new RegExp("^Apply " + A.planWrites(plan) + " write"));
  if (A.planConditional(plan)) { // G-252: the "+1 if needed" is said once, in the Effect line, in plain words
    assert.doesNotMatch(text(go), /if needed/);
    assert.doesNotMatch(text(r.root.querySelector("#apply-summary")), /if needed/);
    assert.match(body(r), /\(\+1 setup write if per-core voltage control is off\)\. Each write is read back\./);
  }
  go.click();
  await until(() => r.store.get().apply.state === "done");
  const sent = r.store.get().apply.sections[0].summary.writesSent;
  assert.match(text(r.root.querySelector("#apply-summary")), new RegExp("^" + sent + " writes? sent"));
  r.applyDrawer.dispose();
});

test("QA-10 / QA-12: a turbo apply is described as an MSR write, and its before/after row survives the apply with status applied", async () => {
  const model = modelFromRead(structuredClone(READ));
  const bucket = model.turbo.P.ratios.length - 1;
  const r = await rig((m, d) => setBucket(m, d, "P", bucket, m.turbo.P.ratios[bucket] - 1));
  await review(r);
  assert.match(body(r), /1 write: turbo P table\. Each write is read back\./);
  assert.doesNotMatch(body(r), /mailbox/);
  const rows = () => r.root.querySelectorAll("table.ap-diff tbody tr").map((x) => text(x));
  const before = rows();
  assert.ok(before.some((x) => /turbo P/.test(x)), before.join(" | "));
  r.root.querySelector("#apply-go").click();
  await until(() => r.store.get().apply.state === "done");
  const after = rows();
  assert.equal(after.length, before.length, "the row is still there");
  assert.ok(after.some((x) => /turbo P/.test(x) && /applied/.test(x)), after.join(" | "));
  assert.doesNotMatch(body(r), /that equal/);
  r.applyDrawer.dispose();
});

test("QA-31: the helper's engineering notes are said in plain words; its own wording sits behind a Technical disclosure", async () => {
  const warnings = [
    { code: "NOTE", text: "the 0x11 word and its 0x1D/0x27 follow-ups reproduce what XTU sent on Windows; OC words written this way have been read back as sent on Linux, but the semantics of 0x1D/0x27 stay UNVERIFIED. A V target of 0 is sent only on a word with no OC point" },
    { code: "NOTE", text: "E-core entries apply to all 4 CPUs of their cluster (XTU writes every E-core); whether one write is cluster-wide is UNVERIFIED" },
    { code: "NOTE", text: "restore applies the accepted profile qa-20261112 (complete: only the words that differ from what the CPU holds are written)" },
    { code: "NOTE", text: "this plan RAISES a ratio, V target or offset; the CPU's own limits were checked; run a stability check before relying on it" },
    { code: "TURBO_RAISE", text: "Raises the P turbo table at 8 busy cores (applies to all P-cores)." },
  ];
  const n = A.planNotes({ warnings });
  assert.deepEqual(n.notes.slice(0, 3), [
    "Ratio and voltage-target changes are sent the way Intel XTU sends them on Windows.",
    "E-core values apply to all 4 cores of a cluster.",
    "Restores the accepted state (qa-20261112). Only the words that differ are written.",
  ]);
  assert.ok(n.notes.concat(n.warnings.map((w) => w.text)).every((t) => !/UNVERIFIED|0x1D|RAISES/.test(t)), JSON.stringify(n));
  assert.equal(n.tech.length, 4, "the four rewritten notes keep the helper's wording");
  assert.ok(n.tech.some((t) => /UNVERIFIED/.test(t.detail)));
  assert.equal(n.warnings.find((w) => w.code === "TURBO_RAISE").text, "Raises the P turbo table at 8 busy cores (applies to all P-cores).", "QA-18 copy passes through");
  const r = await plainRig({ ...emptyPlan, writes: 1, nothing_to_do: false, steps: [{ n: 1, kind: "write_vf", unit: "P0", cpu: 0, point: 0 }], warnings });
  await review(r);
  const tech = r.root.querySelector("#apply-tech");
  assert.ok(tech, "a Technical disclosure");
  assert.equal(text(tech.querySelector("summary")), "Technical");
  assert.match(text(tech), /UNVERIFIED/);
  assert.doesNotMatch(text(r.root.querySelector("#apply-notes")), /UNVERIFIED/);
  r.applyDrawer.dispose();
});
