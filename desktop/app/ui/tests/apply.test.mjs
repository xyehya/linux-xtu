// node --test "desktop/app/ui/tests/*.test.mjs"   (G-210 / R-S3: the commit sheet's pure helpers and its controller against the mock bridge; recorded simulator fixtures, no DOM, no hardware)
import test from "node:test";
import assert from "node:assert/strict";
import FIX from "../fixtures/fixtures.js";
import { Bridge } from "../bridge.js";
import { createMockTransport } from "../fixtures/mock-backend.js";
import { createAppStore } from "../store.js";
import { HINTS } from "../lib/hints.js";
import { modelFromRead } from "../lib/units.js";
import { emptyDraft, setPoint } from "../lib/draft.js";
import * as draftLib from "../lib/draft.js";
import { tileFace } from "../views/tune/grid.js";
import { buildIntent } from "../lib/intent.js";
import { ensureTune, patchTune } from "../views/tune.js";
import {
  planRows, describeRow, stepRows, unitOrder, unitStatuses, noWrites, STATUS_TEXT, eta, progressText, summarizeResult, resultHeadline, planWarnings, planWrites, locateError,
  createApplyController, KINDS, registerKind, planNotes, plainWords, tuneDiffRows, keyedStatuses, outcomeOf, writesSentOf, CONFIRM_OP, staleHint,
} from "../views/tune/apply.js";

const PLAN = FIX["tune-plan"].response.result;
const APPLY = FIX["tune-apply"].response.result;
const READ = FIX["tune-read"].result;

// ---- plan -> rows ----
test("planRows/describeRow: the recorded plan is one changed P0 point, before 0 mV -> after -19.5 mV", () => {
  const rows = planRows(PLAN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit, "P0");
  assert.equal(rows[0].changes, 1);
  assert.deepEqual([rows[0].rows[0].point, rows[0].rows[0].changed], [5, true]);
  const text = describeRow(rows[0].rows[0]);
  assert.match(text, /^pt 5 · 53×/);
  assert.match(text, /0 mV → −19\.5 mV/);
});

test("planRows: unchanged points are marked unchanged; arrays, unread (null) and OC entries are accepted", () => {
  const plan = {
    units: ["EC0"],
    before: { EC0: [{ oc: true, ratio: 48, v_target_v: 0, offset_mv: 0 }, { ratio: 20, offset_mv: 0 }, null] },
    after: { EC0: [{ oc: true, ratio: 50, v_target_v: 1.1, offset_mv: 0 }, { ratio: 20, offset_mv: 0 }, { ratio: 30, offset_mv: -10 }] },
  };
  const [u] = planRows(plan);
  assert.deepEqual(u.rows.map((r) => [r.point, r.changed]), [[0, true], [1, false], [2, true]]);
  assert.match(describeRow(u.rows[0]), /^OC point · 50×/);
  assert.match(describeRow(u.rows[0]), /ratio 48× → 50×/);
  assert.match(describeRow(u.rows[2]), /offset unread → −9\.8 mV/); // G-248 (QA-04): −10 mV is not a 1/1024 V step; the review shows the step the CPU holds (−10 → raw −10 = −9.77 mV)
  assert.deepEqual(planRows({ before: {}, after: {} }), []);
});

test("stepRows keeps the helper's order and labels each kind; unitOrder follows the first write", () => {
  const rows = stepRows(PLAN);
  assert.deepEqual(rows.map((s) => [s.n, s.kind, s.conditional]), [[1, "write_percore_enable", true], [2, "write_vf_point", false]]);
  assert.match(rows[0].label, /only if they are off/);
  assert.match(rows[1].label, /^P0 point 5 offset −19\.5 mV \(cpu 0\)$/);
  const plan = { steps: [{ kind: "write_vf_point", unit: "EC1", point: 2, cpu: 9 }, { kind: "write_vf_point", unit: "P3", point: 1, cpu: 3 }, { kind: "write_msr", table: "P", n: 3 }, { kind: "write_vf_point", unit: "EC1", point: 3 }], units: ["P3", "EC1", "P9"] };
  assert.deepEqual(unitOrder(plan), ["EC1", "P3", "turbo P", "P9"]);
  assert.equal(planWrites(PLAN), 1);
  assert.equal(planWrites({ steps: [{}, {}, {}] }), 3);
});

test("planWarnings: D-050 TURBO_BELOW_OC is an amber warning with its own label (not a NOTE)", () => {
  const [w] = planWarnings({ warnings: [{ code: "TURBO_BELOW_OC", text: "P0 OC ratio 58x is above the P turbo table" }] });
  assert.deepEqual([w.code, w.cls, w.label], ["TURBO_BELOW_OC", "warn", "Capped"]);
});

test("planWarnings: codes decide the class, bare strings are NOTEs, empty ones are dropped", () => {
  const w = planWarnings({ warnings: [{ code: "E40_OFFSET", text: "a" }, { code: "NO_BASELINE", text: "b" }, "plain", { code: "ZZZ", text: "c" }, { code: "NOTE", text: "" }, 5] });
  assert.deepEqual(w.map((x) => [x.code, x.cls]), [["E40_OFFSET", "bad"], ["NO_BASELINE", ""], ["NOTE", ""], ["ZZZ", ""]], "no baseline is a note: the prediction says what it uses");
  assert.equal(planWarnings(PLAN).length, PLAN.warnings.length);
});

// ---- progress -> unit status ----
const plan3 = { steps: [{ kind: "write_percore_enable", conditional: true }, { kind: "write_vf_point", unit: "P0", point: 1 }, { kind: "write_vf_point", unit: "P0", point: 2 }, { kind: "write_vf_point", unit: "EC0", point: 1 }, { kind: "write_vf_point", unit: "EC1", point: 1 }] };

test("unitStatuses while running is positional over the ordered writes", () => {
  const at = (step, of = 8) => unitStatuses(plan3, { step, of }, null);
  assert.deepEqual(at(0), { P0: "queued", EC0: "queued", EC1: "queued" });
  assert.deepEqual(at(1), { P0: "writing", EC0: "queued", EC1: "queued" });
  assert.deepEqual(at(5), { P0: "written", EC0: "writing", EC1: "queued" });
  assert.deepEqual(at(8), { P0: "written", EC0: "written", EC1: "writing" });
  assert.deepEqual(unitStatuses(plan3, null, null), { P0: "queued", EC0: "queued", EC1: "queued" });
});

test("unitStatuses at the end comes from the read-back only; after a stop the current unit is interrupted", () => {
  const rb = [{ unit: "P0", point: 1, match: true }, { unit: "P0", point: 2, match: true }, { unit: "EC0", point: 1, match: false }];
  assert.deepEqual(unitStatuses(plan3, { step: 8, of: 8 }, { ok: true, readback: rb }), { P0: "ok", EC0: "mismatch", EC1: "unverified" });
  assert.deepEqual(unitStatuses(plan3, { step: 5, of: 8 }, { ok: false }), { P0: "unverified", EC0: "interrupted", EC1: "not_started" });
  const turbo = { steps: [{ kind: "write_msr", table: "E" }] };
  assert.deepEqual(unitStatuses(turbo, null, { ok: true, readback: [{ unit: "E", point: "turbo", match: true }] }), { "turbo E": "ok" });
});

test("G-241: an apply refused before any write leaves every unit 'not written', never 'not read back' / 'interrupted'", () => {
  const none = { P0: "not_started", EC0: "not_started", EC1: "not_started" };
  for (const p of [null, { step: 1, of: 8 }, { step: 5, of: 8 }, { step: 8, of: 8 }]) assert.deepEqual(unitStatuses(plan3, p, { ok: false, noWrites: true }), none);
  assert.equal(STATUS_TEXT.not_started, "not written");
  const err = (detail, status = "failed") => ({ status, error: { code: "REFUSED", message: "PlanError: x. Nothing was written.", detail } });
  assert.equal(noWrites(err({ writes_sent: 0, check: "PLAN_ERROR" })), true);
  assert.equal(noWrites(err({ ops_done: 3 })), false); // no statement about writes: the old positional statuses stay
  assert.equal(noWrites(err({ writes_sent: 2 })), false);
  assert.equal(noWrites({ status: "applying", error: null }), false);
});

test("G-230: units with nothing written show no change, not 'not read back'", () => {
  // P1 / P2 are in plan.units but have no write step; a turbo table equal to the CPU's is listed by the helper (table "e") but never written, so it has no read-back row
  const plan = { units: ["P0", "P1", "P2"], steps: [{ kind: "write_vf_point", unit: "P0", point: 5 }, { kind: "write_msr", table: "e" }, { kind: "write_msr", table: "p" }] };
  const rb = [{ unit: "P0", point: 5, match: true }, { unit: "P", point: "turbo", match: true }];
  assert.deepEqual(unitStatuses(plan, { step: 3, of: 3 }, { ok: true, readback: rb, complete: true }), { P0: "ok", P1: "no_change", P2: "no_change", "turbo E": "no_change", "turbo P": "ok" });
  assert.equal(STATUS_TEXT.no_change, "no change");
  // a written V/F word with no read-back is still amber
  assert.equal(unitStatuses(plan, null, { ok: true, readback: [], complete: true }).P0, "unverified");
  // a partial result does not claim "no change" for a listed turbo table
  assert.equal(unitStatuses(plan, null, { ok: true, readback: rb, complete: false })["turbo E"], "unverified");
  // after a stop the unwritten units are no change too
  assert.equal(unitStatuses(plan, { step: 1, of: 3 }, { ok: false }).P1, "no_change");
});

test("eta uses the measured per-op time; nothing before the first step", () => {
  assert.deepEqual(eta(1000, 0, 10), { remainingMs: null, text: "" });
  assert.equal(eta(2000, 4, 10).remainingMs, 3000);
  assert.equal(eta(2000, 4, 10).text, "~3.0 s left");
  assert.equal(eta(100, 10, 10).remainingMs, 0);
  assert.match(progressText({ step: 3, of: 6 }, 1500), /^step 3 of 6 · 1\.5 s elapsed · ~1\.5 s left$/);
  assert.equal(progressText(null, 0), "waiting for the first step");
});

// ---- result ----
test("summarizeResult/resultHeadline: all matched, mismatch, partial", () => {
  const ok = summarizeResult(APPLY);
  assert.deepEqual([ok.total, ok.matched, ok.allMatch, ok.complete, ok.opsUsed], [1, 1, true, true, 4]);
  assert.equal(resultHeadline(ok), "1/1 words read back as written");
  const bad = summarizeResult({ ...APPLY, readback: [...APPLY.readback, { ...APPLY.readback[0], match: false, actual: "0x1" }] });
  assert.equal(bad.mismatches.length, 1);
  assert.equal(bad.allMatch, false);
  assert.equal(resultHeadline(bad), "1 of 2 words differ on read-back");
  const part = summarizeResult({ ...APPLY, complete: false, stop: { reason: "guard tripped", tripped: true }, writes_sent: 3 });
  assert.equal(part.allMatch, false);
  assert.match(resultHeadline(part), /^Partial apply: it stopped after 3 writes\. guard tripped/);
  const extras = summarizeResult({ ...APPLY, cpufreq: [{ cpu: 0, before_khz: 5, after_khz: 6 }, { cpu: "x" }], residual: ["P0"], ring_refused: ["why"] });
  assert.deepEqual([extras.cpufreq.length, extras.residual, extras.ringRefused], [1, ["P0"], ["why"]]);
  assert.equal(summarizeResult(null).total, 0);
});

// ---- plan errors -> field ----
test("locateError: the message prefix names the unit, the intent maps the value back to the ratio", () => {
  const intent = { rows: [{ target: "P0", offset: { kind: "points", mv: { 48: -250, 53: -20 } } }, { target: "EC1", offset: { kind: "curve", mv: -300 } }] };
  const msg = "P0: offset -250 mV (raw -256) is outside the policy window -150.0..+150.0 mV (policy x). Nothing was sent.";
  assert.deepEqual(locateError({ code: "REFUSED", message: msg, detail: { check: "POLICY_RANGE" } }, intent), { unit: "P0", field: "point", ratio: 48, point: null, message: msg, check: "POLICY_RANGE" });
  assert.equal(locateError({ message: "EC1: offset -300 mV (raw x) is outside" }, intent).field, "curve");
  assert.equal(locateError({ message: "P0: OC-point voltage 1300 mV is above the CPU limit" }, intent).field, "vt");
  assert.equal(locateError({ message: "P0: ratio 60 is above the policy ratio ceiling" }, intent).field, "ratio");
  assert.deepEqual(locateError({ message: "ring point 3: offset +200 mV (raw 1) is outside" }, intent).point, 3);
  assert.equal(locateError({ message: "ring point 3: offset +200 mV" }, intent).unit, "ring");
  assert.deepEqual(locateError({ message: "turbo.P: ratio 60 is above x" }, intent).unit, "turbo P");
  // R-S3: the TURBO_ORDER branch is gone (the helper no longer raises it; a rising table is refused in the editor and at plan with a "turbo.P:" message)
  const order = locateError({ code: "REFUSED", message: "TURBO bucket", detail: { check: "TURBO_ORDER", table: "p", bucket: 3 } }, intent);
  assert.deepEqual([order.unit, order.field], [null, null]);
  assert.equal(locateError({ message: "something else", detail: { check: "NO_READ" } }, intent).unit, null);
  assert.equal(locateError({ message: "P0: weird" }, intent).field, null);
});

// ---- R-S3: plan notes in operator words ----
test("plan notes: no register codes, task ids or evidence tags in the prose; known helper notes become one plain sentence; the undo line is not a note", () => {
  const n = planNotes(PLAN);
  assert.deepEqual(n.warnings, [], "the recorded plan has notes only");
  assert.equal(n.notes.length, 2, "the reboot note is the How to undo line, not a note: " + JSON.stringify(n.notes));
  assert.match(n.notes[0], /^The CPU keeps each point at or above the one below/);
  assert.match(n.notes[1], /^No stock baseline curve/);
  for (const t of n.notes) assert.doesNotMatch(t, /0x[0-9a-f]|[A-Z]{3,}_[A-Z]|G-\d|XTU|P2 =/, t);
  assert.equal(plainWords("an offset on the E-cluster 40x point has been reported to destabilise the cluster [COMMUNITY]"), "An offset on the E-cluster 40× point has been reported to destabilise the cluster.");
  assert.equal(plainWords("P0 OC ratio 58x is above the P turbo table (MSR 0x1AD): raise it"), "P0 OC ratio 58× is above the P turbo table: raise it.");
  assert.equal(plainWords("cap 57 -> 50 is large"), "Cap 57 → 50 is large.");
  // LARGE_CHANGE lines that say the same jump merge into one warning
  const rt = planNotes({ warnings: ["LARGE_CHANGE: cpu 8: cap 49 -> 23 is a large single change (more than 4 bins); the kernel accepts it", "LARGE_CHANGE: cpu 9: cap 49 -> 23 is a large single change (more than 4 bins); the kernel accepts it", "these are runtime values: a reboot restores the firmware / kernel defaults"] });
  assert.deepEqual(rt.warnings, [{ lead: "Large step", text: "cpu 8, 9: 49× → 23× in one step (more than 4 bins).", code: "LARGE_CHANGE" }]);
  assert.deepEqual(rt.notes, []);
});

test("the diff: one row per changed value, grouped by unit in write order; a uniform whole-unit change is one row; turbo rows from the intent", () => {
  const rows = tuneDiffRows(PLAN, {}, null);
  assert.deepEqual(rows.map((r) => [r.unit, r.what, r.before, r.after, r.delta]), [["P0", "point 5 · 53×", "0 mV", "−19.5 mV", "−19.5"]], "Δ keeps the decimal the values show");
  const plan = {
    units: ["EC0"], steps: [{ kind: "write_vf_point", unit: "EC0" }],
    before: { EC0: [{ oc: true, ratio: 48, v_target_v: 1.15, offset_mv: 0 }] }, after: { EC0: [{ oc: true, ratio: 50, v_target_v: 1.2, offset_mv: 0 }] },
  };
  assert.deepEqual(tuneDiffRows(plan, {}, null).map((r) => [r.what, r.before, r.after, r.delta]), [["OC point ratio", "48×", "50×", "+2"], ["OC point target", "1.150 V", "1.200 V", "+0.050"]]);
  const curve = { units: ["P1"], before: { P1: [1, 2, 3, 4].map((p) => ({ point: p, ratio: 10 * p, offset_mv: 0 })) }, after: { P1: [1, 2, 3, 4].map((p) => ({ point: p, ratio: 10 * p, offset_mv: -30 })) } };
  assert.deepEqual(tuneDiffRows(curve, {}, null).map((r) => [r.unit, r.what, r.delta]), [["P1", "4 points, offset", "−30.3"]]);
  const model = { turbo: { P: { ratios: [57, 57, 55, 55, 55, 55, 55, 55], counts: [1, 2, 3, 4, 5, 6, 7, 8] } } };
  const t = tuneDiffRows({ steps: [{ kind: "write_msr", table: "p" }] }, { turbo: { P: [57, 57, 54, 54, 55, 55, 55, 55] } }, model);
  assert.deepEqual(t.map((r) => [r.unit, r.what, r.before, r.after, r.sunit]), [["turbo P", "3 active cores", "55×", "54×", "turbo P"], ["turbo P", "4 active cores", "55×", "54×", "turbo P"]]);
});

test("keyed statuses (power / caps / uncore rows): positional while writing, from the read-back at the end, 'not written' when nothing was sent", () => {
  const plan = { steps: [{ key: "pl1_w" }, { key: "pl2_w" }] };
  const rows = [{ unit: "Package", keys: ["pl1_w"], sunit: "a" }, { unit: "Package", keys: ["pl2_w"], sunit: "b" }];
  assert.deepEqual(keyedStatuses(rows, plan, { step: 1, of: 4 }, null), { a: "writing", b: "queued" });
  assert.deepEqual(keyedStatuses(rows, plan, { step: 4, of: 4 }, null), { a: "written", b: "writing" });
  const summary = { readback: [{ key: "pl1_w", match: true }, { key: "pl2_w", match: false }] };
  assert.deepEqual(keyedStatuses(rows, plan, null, { ok: true }, summary), { a: "ok", b: "mismatch" });
  assert.deepEqual(keyedStatuses(rows, plan, { step: 3, of: 4 }, { ok: false }), { a: "unverified", b: "interrupted" });
  assert.deepEqual(keyedStatuses(rows, plan, null, { ok: false, noWrites: true }), { a: "not_started", b: "not_started" });
  assert.equal(STATUS_TEXT.ok, "applied");
  assert.equal(STATUS_TEXT.mismatch, "read-back mismatch");
});

test("outcome: 'Nothing was written' only when every section says so; unknown writes are never called nothing", () => {
  const plan = { plan_id: "x", writes: 2, steps: [] };
  const sec = (status, error, extra = {}) => ({ status, error, plan, opId: null, summary: null, ...extra });
  const nothing = outcomeOf({ state: "failed", sections: [sec("failed", { code: "REFUSED", message: "no", detail: { writes_sent: 0 } }), sec("skipped", null)] });
  assert.deepEqual([nothing.kind, nothing.title], ["nothing", "Nothing was written"]);
  const stale = outcomeOf({ state: "failed", sections: [sec("stale", { code: "PLAN_STALE", message: "gone" })] });
  assert.equal(stale.kind, "stale");
  assert.match(stale.text, /^Nothing was written\./);
  const lost = sec("failed", { code: "LINK_LOST", message: "lost" }, { opId: "d9" });
  assert.equal(writesSentOf(lost), null, "a long op that ended in an error may have written");
  assert.equal(outcomeOf({ state: "failed", sections: [lost] }).kind, "refused");
  const uvp = sec("failed", { code: "REFUSED", message: "The CPU refused a negative voltage offset: Undervolt Protection is enabled in the BIOS.", detail: { check: "UNDERVOLT_PROTECTION" } });
  assert.equal(outcomeOf({ state: "failed", sections: [uvp] }).kind, "uvp");
  const mm = sec("done", null, { summary: summarizeResult({ ...APPLY, readback: [{ ...APPLY.readback[0], match: false }] }) });
  assert.equal(outcomeOf({ state: "failed", sections: [mm] }).kind, "mismatch");
  const ok = sec("done", null, { summary: summarizeResult(APPLY) });
  assert.deepEqual([outcomeOf({ state: "done", sections: [ok] }).kind, outcomeOf({ state: "done", sections: [ok] }).text], ["ok", "1 write read back equal."]);
});

// ---- the controller, against the mock bridge ----
const FAST = { intervalMs: 5, stepMs: 1, applyMode: null };
async function rig(opts = {}, mutate = (m, d) => setPoint(m, d, ["P0"], 53, -20)) {
  const bridge = new Bridge(createMockTransport({ ...FAST, ...opts }), "mock");
  await bridge.connect();
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  ensureTune(store);
  const model = modelFromRead(structuredClone(READ));
  patchTune(store, { model, draft: mutate(model, emptyDraft()) });
  const toasts = [];
  const ctl = createApplyController({ store, bridge, toast: (k, t) => toasts.push([k, t]) });
  return { bridge, store, ctl, toasts, model };
}

test("controller: review plans the draft, Apply asks the shell's dialog then sends the plan id and the intent on screen (never a code), progress fills the section, the draft clears and tiles re-read", async () => {
  const { bridge, store, ctl } = await rig();
  const sent = [];
  const call = bridge.call.bind(bridge);
  bridge.call = (op, args) => (sent.push([op, args]), call(op, args));
  assert.equal(await ctl.review(["tune"]), "review");
  const a = store.get().apply;
  assert.equal(a.state, "review");
  assert.equal(a.sections.length, 1);
  assert.deepEqual(sent[0], ["tune.plan", { intent: buildIntent(store.get().tune.model, store.get().tune.draft).intent }]);
  const plan = a.sections[0].plan;
  assert.equal(ctl.gate(), "");
  const steps = [];
  store.subscribe((s) => s.apply.sections[0] && s.apply.sections[0].progress && steps.push(s.apply.sections[0].progress.step));
  assert.equal(plan.nonce, undefined, "the webview never holds the plan's code");
  assert.equal(await ctl.apply(), true);
  const ops = sent.map((x) => x[0]);
  assert.ok(ops.indexOf(CONFIRM_OP) >= 0 && ops.indexOf(CONFIRM_OP) < ops.indexOf("tune.apply"), "the native dialog comes first: " + ops);
  assert.deepEqual(sent.find((x) => x[0] === CONFIRM_OP)[1], { plans: [{ op: "tune.apply", plan_id: plan.plan_id }] });
  assert.deepEqual(sent.find((x) => x[0] === "tune.apply")[1], { plan_id: plan.plan_id, intent: sent[0][1].intent }, "the plan id and the intent on screen (R-I1), no typed confirmation from the page");
  assert.ok(steps.length >= 3 && steps.includes(plan.ops_needed), "progress events reached the section: " + steps);
  const done = store.get().apply;
  assert.equal(done.state, "done");
  assert.equal(done.sections[0].status, "done");
  assert.equal(done.sections[0].summary.allMatch, true);
  assert.deepEqual(store.get().tune.draft, emptyDraft(), "a clean apply clears the draft");
  assert.equal(store.get().pending.changes, 0);
  assert.ok(sent.some((x) => x[0] === "tune.last"), "tune.last is re-read after the apply");
  assert.equal(store.get().tune.read.fromLast, true);
});

// G-227: the operator's report: after Apply the tiles/inspector kept the OLD offsets until "Read CPU state". The mock's tune.last now follows the applied words (as the helper's does).
const offAt = (model, id, ratio) => model.units[id].points.find((p) => p.ratio === ratio).offset_mv;
test("controller: after Apply the model, tile faces and pending count hold the applied offsets (x57 on P0, x55 on P1), no re-read", async () => {
  const { store, ctl, model } = await rig({}, (m, d) => setPoint(m, setPoint(m, d, ["P0"], 57, -20), ["P1"], 55, -15));
  assert.equal(offAt(model, "P0", 57), 0);
  assert.equal(await ctl.review(["tune"]), "review");
  assert.equal(await ctl.apply(), true);
  const t = store.get().tune;
  assert.ok(Math.abs(offAt(t.model, "P0", 57) + 20) < 0.5, "P0 x57 reads back -20 mV: " + offAt(t.model, "P0", 57));
  assert.ok(Math.abs(offAt(t.model, "P1", 55) + 15) < 0.5, "P1 x55 reads back -15 mV: " + offAt(t.model, "P1", 55));
  assert.equal(offAt(t.model, "P2", 55), 0, "an untouched unit is unchanged");
  assert.equal(store.get().pending.changes, 0);
  assert.ok(Math.abs(tileFace(t.model, t.draft, "P0", []).deepest + 20) < 0.5, "the tile's deepest offset follows the model");
});

test("controller: a CPU read-back that differs from the plan (clamped) shows the CPU's value and drops the applied draft entries", async () => {
  const { store, ctl } = await rig({ applyMode: "mismatch" }, (m, d) => setPoint(m, setPoint(m, d, ["P0"], 57, -20), ["P1"], 55, -15));
  assert.equal(await ctl.review(["tune"]), "review");
  await ctl.apply();
  const a = store.get().apply;
  assert.equal(a.sections[0].summary.allMatch, false);
  const t = store.get().tune;
  assert.ok(Math.abs(offAt(t.model, "P0", 57) + 20) < 0.5 && Math.abs(offAt(t.model, "P1", 55) + 15) < 0.5, "the model holds what the helper read back");
  assert.equal(draftLib.isEmpty(t.draft), true, "applied entries are not kept as pending edits over the CPU's value");
});

// the live bug: the helper had no usable tune.last (nothing stored for this boot, an error, or a record that predates the apply): the draft was cleared, the old model stayed
const NO_LAST = {
  unavailable: () => ({ id: "x", ok: true, result: { available: false } }),
  error: () => ({ id: "x", ok: false, error: { code: "BUSY", message: "the helper is busy" } }),
  "predates the apply": (r) => ({ ...r, result: { ...r.result, applied_at: null } }),
};
for (const [name, answer] of Object.entries(NO_LAST)) {
  test(`controller: tune.last ${name} -> the model follows the plan and the matched read-back, the draft clears, the user is told`, async () => {
    const { store, ctl, bridge, toasts } = await rig({}, (m, d) => setPoint(m, setPoint(m, d, ["P0"], 57, -20), ["P1"], 55, -15));
    const call = bridge.call.bind(bridge);
    bridge.call = async (op, args) => (op === "tune.last" ? answer(await call(op, args)) : call(op, args));
    assert.equal(await ctl.review(["tune"]), "review");
    assert.equal(await ctl.apply(), true);
    const t = store.get().tune;
    assert.ok(Math.abs(offAt(t.model, "P0", 57) + 20) < 0.5, "P0 x57: " + offAt(t.model, "P0", 57));
    assert.ok(Math.abs(offAt(t.model, "P1", 55) + 15) < 0.5, "P1 x55: " + offAt(t.model, "P1", 55));
    assert.equal(offAt(t.model, "P2", 55), 0);
    assert.equal(draftLib.isEmpty(t.draft), true);
    assert.equal(store.get().pending.changes, 0);
    assert.ok(toasts.some(([k, text]) => k === "warn" && /no stored read/.test(text)), "the user is told the tiles follow the plan: " + JSON.stringify(toasts));
  });
}

test("controller: tune.last unavailable + a turbo-table apply -> the model's turbo ratios follow the intent", async () => {
  const { store, ctl, bridge, model } = await rig({}, (m, d) => d);
  const bucket = (model.turbo.P.ratios.length - 1);
  const want = model.turbo.P.ratios.slice();
  want[bucket] -= 1;
  const call = bridge.call.bind(bridge);
  bridge.call = async (op, args) => (op === "tune.last" ? NO_LAST.unavailable() : call(op, args));
  const { setBucket } = draftLib;
  patchTune(store, { draft: setBucket(model, emptyDraft(), "P", bucket, want[bucket]) });
  assert.equal(await ctl.review(["tune"]), "review");
  assert.equal(await ctl.apply(), true);
  assert.deepEqual(store.get().tune.model.turbo.P.ratios, want);
  assert.equal(store.get().pending.changes, 0);
});

test("controller: a plan refusal fails the review, names the unit/ratio, and nothing is applied", async () => {
  const { store, ctl, bridge } = await rig({}, (m, d) => setPoint(m, d, ["P0"], 48, -180));
  assert.equal(await ctl.review(["tune"]), "failed");
  const a = store.get().apply;
  assert.equal(a.state, "failed");
  assert.match(a.error.message, /^P0: offset -180 mV/);
  assert.deepEqual([a.error.located.unit, a.error.located.field, a.error.located.ratio], ["P0", "point", 48]);
  assert.equal(await ctl.apply(), false);
  assert.equal((await bridge.call("tune.apply", { plan_id: "0".repeat(64) })).error.code, "PLAN_STALE", "the shell holds no plan: nothing can be applied");
});

test("controller: nothing pending and no read are request-level errors", async () => {
  const { store, ctl } = await rig({}, (m, d) => d);
  assert.equal(await ctl.review(["tune"]), "failed");
  assert.match(store.get().apply.error.message, /Nothing to apply/);
  const s2 = createAppStore();
  const ctl2 = createApplyController({ store: s2, bridge: new Bridge(createMockTransport(FAST), "mock") });
  assert.equal(await ctl2.review(["tune"]), "failed");
  assert.match(s2.get().apply.error.message, /Read the CPU state first/);
});

test("controller: mismatch result is shown, the written unit's draft entries give way to the CPU's words (G-227) and the sequence stops", async () => {
  const { store, ctl } = await rig({ applyMode: "mismatch" });
  await ctl.review(["tune"]);
  assert.equal(await ctl.apply(), false);
  const s = store.get().apply.sections[0];
  assert.equal(s.status, "done");
  assert.equal(s.summary.mismatches.length, 1);
  assert.equal(store.get().apply.state, "failed");
  assert.equal(store.get().tune.draft.units.P0, undefined, "the draft would otherwise show the wanted value over the CPU's read-back");
});

test("controller: PLAN_STALE marks the section stale; replan issues a fresh plan that applies", async () => {
  const { store, ctl } = await rig({ applyMode: "stale" });
  await ctl.review(["tune"]);
  const first = store.get().apply.sections[0].plan.plan_id;
  assert.equal(await ctl.apply(), false);
  assert.equal(store.get().apply.sections[0].status, "stale");
  assert.equal(store.get().apply.sections[0].error.code, "PLAN_STALE");
  assert.equal(await ctl.replan(), "review");
  const second = store.get().apply.sections[0].plan.plan_id;
  assert.notEqual(second, first);
  assert.equal(await ctl.apply(), true);
  assert.equal(store.get().apply.state, "done");
});

test("controller: an edit after the plan makes the plan outdated (Apply gated until Re-plan)", async () => {
  const { store, ctl, model } = await rig();
  await ctl.review(["tune"]);
  assert.equal(ctl.gate(), "");
  patchTune(store, { draft: setPoint(model, store.get().tune.draft, ["P0"], 53, -25) });
  assert.match(ctl.gate(), /You changed the V\/F edits after this review\. Review again\./);
  assert.equal(ctl.gateInfo().replan, true);
  assert.equal(await ctl.apply(), false);
  store.set({ link: { state: "busy", kind: null, message: "", fix: null } });
  assert.match(ctl.gate(), /Review again|not connected/);
});

test("controller: Cancel sends {op_id} to the helper and the section ends cancelled", async () => {
  const { store, ctl, bridge } = await rig({ stepMs: 15 });
  const sent = [];
  const call = bridge.call.bind(bridge);
  bridge.call = (op, args) => (sent.push([op, args]), call(op, args));
  await ctl.review(["tune"]);
  const run = ctl.apply();
  for (let i = 0; i < 200 && !store.get().apply.sections[0].opId; i++) await new Promise((r) => setTimeout(r, 5)); // the dialog answers first
  assert.equal(store.get().apply.state, "applying");
  assert.equal(ctl.isBusy(), true);
  assert.equal(await ctl.cancel(), true);
  assert.equal(await run, false);
  const cancel = sent.find((x) => x[0] === "cancel");
  assert.equal(cancel[1].op_id, store.get().apply.sections[0].opId);
  assert.equal(store.get().apply.sections[0].status, "cancelled");
  assert.equal(store.get().apply.sections[0].error.code, "CANCELLED");
  assert.equal(ctl.isBusy(), false);
});

test("controller: one native dialog covers every section; sections apply in order with their plan id and intent; a failure skips the rest", async () => {
  const log = [];
  const fakeKind = (name, failApply) => ({
    label: name, planOp: name + ".plan", applyOp: name + ".apply",
    request: () => ({ intent: { from: name } }),
  });
  const kinds = { a: fakeKind("a"), b: fakeKind("b"), c: fakeKind("c") };
  const bridge = {
    on() {}, off() {},
    async call(op, args) {
      log.push([op, args]);
      if (op === "app.confirm") return { ok: true, result: { confirmed: true, plans: args.plans.length, writes: 3 } };
      const [name, what] = op.split(".");
      if (what === "plan") return { ok: true, result: { plan_id: "id-" + name, nonce: "N" + name.toUpperCase(), writes: 1, steps: [] } };
      if (name === "b") return { ok: false, error: { code: "REFUSED", message: "b refused" } };
      return { ok: true, result: { complete: true, readback: [{ unit: "U", point: 1, match: true }] } };
    },
    wait: async () => ({ ok: true, result: {} }),
  };
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  const ctl = createApplyController({ store, bridge, kinds });
  assert.equal(await ctl.review(["a", "b", "c"]), "review");
  assert.deepEqual(store.get().apply.sections.map((s) => s.kind), ["a", "b", "c"]);
  assert.equal(await ctl.apply(), false);
  assert.deepEqual(log.filter((x) => x[0] === "app.confirm").map((x) => x[1]), [{ plans: [{ op: "a.apply", plan_id: "id-a" }, { op: "b.apply", plan_id: "id-b" }, { op: "c.apply", plan_id: "id-c" }] }], "one dialog for all three");
  assert.deepEqual(log.filter((x) => x[0].endsWith(".apply")).map((x) => [x[0], x[1]]), [["a.apply", { plan_id: "id-a", intent: { from: "a" } }], ["b.apply", { plan_id: "id-b", intent: { from: "b" } }]]);
  assert.deepEqual(store.get().apply.sections.map((s) => s.status), ["done", "failed", "skipped"]);
  assert.equal(store.get().apply.state, "failed");
});

test("registerKind validates and a registered kind can be reviewed", async () => {
  assert.throws(() => registerKind("x", {}), TypeError);
  registerKind("zz", { planOp: "zz.plan", applyOp: "zz.apply", request: () => ({ intent: { a: 1 } }) });
  assert.equal(KINDS.zz.label, "zz");
  delete KINDS.zz;
});

// ================================================================ R-S3: apply-flow correctness (assessment F-05 / R-26, WP-4) and the shell's confirmation
import { registerRuntimeKinds, requestReview as runtimeReview, loadRead, revertRequest } from "../views/tune/runtime-kinds.js";
import { ensureRt, editRt, editsAfterApply } from "../lib/rtstate.js";
import { setPreflight } from "../store.js";

function spy(bridge) {
  const sent = [];
  const call = bridge.call.bind(bridge);
  bridge.call = (op, args) => (sent.push([op, args]), call(op, args));
  return sent;
}
async function rtRig(opts = {}) {
  const r = await rig(opts, (m, d) => d); // no V/F edits: the review is power / caps / uncore only
  registerRuntimeKinds();
  ensureRt(r.store);
  await loadRead(r.store, r.bridge, "power");
  await loadRead(r.store, r.bridge, "runtime");
  return r;
}
/** What the tabs' Review button asks for (runtime-kinds.js requestReview: tracked requests from the edits). */
function tabRequests(store) {
  let got = null;
  const on = (e) => (got = e.detail.requests);
  store.events.addEventListener("tune:review", on);
  runtimeReview(store);
  store.events.removeEventListener("tune:review", on);
  return got;
}
const until = async (cond, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
};

test("F-05 / R-26: plan PL1 200 W, retype 180 W while the sheet is open -> Apply refuses and nothing is written; Review again plans 180 W and applies 180 W", async () => {
  const { store, ctl, bridge } = await rtRig();
  const sent = spy(bridge);
  editRt(store, (e) => ({ ...e, power: { pl1_w: 200 } }));
  const requests = tabRequests(store);
  assert.deepEqual(requests, [{ kind: "power", intent: { power: { pl1_w: 200 } }, label: "Power limits", track: true }]);
  assert.equal(await ctl.review(requests), "review");
  assert.equal(ctl.gate(), "");
  editRt(store, (e) => ({ ...e, power: { pl1_w: 180 } }));
  const g = ctl.gateInfo();
  assert.deepEqual([g.key, g.replan], ["locked.stale_plan", true]);
  assert.equal(g.text, "You changed the power limits after this review. Review again.");
  assert.equal(await ctl.apply(), false);
  assert.ok(!sent.some(([op]) => op === "app.confirm" || op === "power.apply"), "no dialog, no write: " + sent.map((x) => x[0]));
  editRt(store, (e) => ({ ...e, power: { pl1_w: 200 } }));
  assert.equal(ctl.gate(), "", "back to what was planned: the plan is good again");
  editRt(store, (e) => ({ ...e, power: { pl1_w: 180 } }));
  assert.equal(await ctl.replan(), "review");
  assert.deepEqual(ctl.state().sections[0].intent, { power: { pl1_w: 180 } }, "Review again takes the edits on screen");
  assert.equal(await ctl.apply(), true);
  assert.equal(store.get().rt.power.result.powercap.pl1_w, 180, "180 W, never 200 W");
  assert.deepEqual(store.get().rt.edits.power, {}, "the applied edit leaves");
});

test("F-05: an edit made while the system dialog is open is caught when it closes; nothing is written", async () => {
  const { store, ctl, bridge } = await rtRig({ confirmMs: 60 });
  const sent = spy(bridge);
  editRt(store, (e) => ({ ...e, caps: { P0: 50 } }));
  assert.equal(await ctl.review(tabRequests(store)), "review");
  const run = ctl.apply();
  await until(() => ctl.state().state === "confirming");
  editRt(store, (e) => ({ ...e, caps: { P0: 48 } }));
  assert.equal(await run, false);
  const a = ctl.state();
  assert.deepEqual([a.state, a.confirm.code], ["review", "OUTDATED"]);
  assert.ok(sent.some(([op]) => op === "app.confirm") && !sent.some(([op]) => op === "runtime.apply"), "confirmed, but not written");
});

test("WP-4: only the keys that landed leave the edits; an edit that moved or did not read back stays pending; a finished revert clears its kind", () => {
  const edits = { power: { pl1_w: 200, pl2_w: 280 }, caps: { P0: 50, EC0: 22 }, uncore: { max_ratio: 38 } };
  const ok = { complete: true, allMatch: true, readback: [] };
  assert.deepEqual(editsAfterApply(edits, "power", { power: { pl1_w: 200 } }, ok).power, { pl2_w: 280 }, "pl2 was not in the plan");
  assert.deepEqual(editsAfterApply({ ...edits, power: { pl1_w: 190 } }, "power", { power: { pl1_w: 200 } }, ok).power, { pl1_w: 190 }, "retyped during the apply: stays");
  const half = { complete: true, allMatch: false, readback: [{ key: "pl1_w", match: true }, { key: "pl2_w", match: false }] };
  assert.deepEqual(editsAfterApply(edits, "power", { power: { pl1_w: 200, pl2_w: 280 } }, half).power, { pl2_w: 280 }, "the one that read back different stays");
  const rt = { caps: [0, 8, 9, 10, 11].map((cpu) => ({ unit: cpu ? "EC0" : "P0", kind: cpu ? "E" : "P", cpu, online: true, cpufreq: { cap_khz: 5e6 } })) };
  const rb = [0, 8, 9, 10].map((c) => ({ key: "cpu" + c, match: true })).concat({ key: "cpu11", match: false }, { key: "max_ratio", match: true });
  const after = editsAfterApply(edits, "runtime", { caps: { 0: 50, 8: 22, 9: 22, 10: 22, 11: 22 }, uncore: { max_ratio: 38 } }, { complete: true, allMatch: false, readback: rb }, rt);
  assert.deepEqual([after.caps, after.uncore], [{ EC0: 22 }, {}], "EC0 stays: cpu 11 did not read back");
  assert.equal(editsAfterApply(edits, "power", { power: { pl1_w: 1 } }, { complete: true, allMatch: false }), edits, "nothing landed: the same object");
  assert.deepEqual(editsAfterApply(edits, "runtime", { revert: true }, { complete: true }), { ...edits, caps: {}, uncore: {} });
  assert.equal(editsAfterApply(edits, "runtime", { revert: true }, { complete: false }), edits);
});

test("nothing written: Cancel in the system dialog sends no apply, keeps the plan reviewable and says so", async () => {
  const { store, ctl, bridge } = await rig({ confirm: "no" });
  const sent = spy(bridge);
  assert.equal(await ctl.review(["tune"]), "review");
  assert.equal(await ctl.apply(), false);
  const a = store.get().apply;
  assert.deepEqual([a.state, a.confirm.code, a.sections[0].status], ["review", "NOT_CONFIRMED", "review"]);
  assert.match(a.confirm.message, /Nothing was written/);
  assert.ok(!sent.some(([op]) => op === "tune.apply"));
  assert.equal(ctl.gate(), "", "Apply stays available: the next click asks again");
});

test("nothing written: an apply refused before its first write (writes_sent 0) shows every unit 'not written' and no stale-model warning", async () => {
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  const kinds = { k: { label: "K", planOp: "k.plan", applyOp: "k.apply", request: () => ({ intent: { a: 1 } }) } };
  const bridge = {
    on() {}, off() {},
    async call(op) {
      if (op === "k.plan") return { ok: true, result: { plan_id: "p".repeat(64), writes: 2, units: ["P0"], steps: [{ kind: "write_vf_point", unit: "P0" }] } };
      if (op === "app.confirm") return { ok: true, result: { confirmed: true } };
      return { ok: false, error: { code: "REFUSED", message: "PlanError: the guard refused. Nothing was written.", detail: { writes_sent: 0, check: "PLAN_ERROR" } } };
    },
  };
  const ctl = createApplyController({ store, bridge, kinds });
  await ctl.review(["k"]);
  assert.equal(await ctl.apply(), false);
  const a = store.get().apply;
  assert.deepEqual([outcomeOf(a).kind, outcomeOf(a).title, a.stale], ["nothing", "Nothing was written", null]);
  assert.deepEqual(unitStatuses(a.sections[0].plan, null, { ok: false, noWrites: true }), { P0: "not_started" });
});

test("after a stop that may have written: the sheet marks the values stale and the kind re-reads what is in force", async () => {
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  const reread = [];
  const kinds = { k: { label: "K", planOp: "k.plan", applyOp: "k.apply", request: () => ({ intent: { a: 1 } }), afterFailure: async ({ section }) => reread.push(section.kind) } };
  const bridge = {
    on() {}, off() {},
    async call(op) {
      if (op === "k.plan") return { ok: true, result: { plan_id: "p".repeat(64), writes: 2, steps: [] } };
      if (op === "app.confirm") return { ok: true, result: { confirmed: true } };
      return { ok: true, pending: true, id: "d7" };
    },
    wait: async () => ({ id: "d7", ok: false, error: { code: "LINK_LOST", message: "the helper connection was lost while this operation was running" } }),
  };
  const ctl = createApplyController({ store, bridge, kinds });
  await ctl.review(["k"]);
  assert.equal(await ctl.apply(), false);
  assert.deepEqual(store.get().apply.stale, { kinds: ["k"] });
  assert.deepEqual(reread, ["k"]);
  assert.equal(outcomeOf(store.get().apply).kind, "refused", "never 'nothing written' when it may have written");
});

test("read-only mode: Apply is refused with the reason and no dialog is asked; the sheet also refuses while the preflight has not answered", async () => {
  const { store, ctl, bridge } = await rig();
  const sent = spy(bridge);
  await ctl.review(["tune"]);
  assert.equal(ctl.gate(), "", "no preflight in this rig: the controller's default gate is the known mode");
  setPreflight(store, { writes_allowed: false, checks: [{ name: "msr_allow_writes", status: "fail" }] });
  const g = ctl.gateInfo();
  assert.equal(g.key, "locked.read_only");
  assert.match(g.text, /^Read-only mode: /);
  assert.equal(await ctl.apply(), false);
  assert.ok(!sent.some(([op]) => op === "app.confirm" || op === "tune.apply"));
  setPreflight(store, { writes_allowed: true, checks: [] });
  assert.equal(ctl.gate(), "");
  // the sheet's controller (createApplyDrawer) is strict: a preflight that has not answered counts as writes off
  store.set({ preflight: null, mode: { writes: false, label: "mode unknown", reason: "preflight not read yet" } });
  assert.equal(ctl.gate(), "", "known mode: no preflight, no verdict here (the helper still refuses)");
  const strict = createApplyController({ store, bridge, readOnlyGate: "strict" });
  assert.equal(strict.gateInfo().key, "locked.read_only");
  assert.match(strict.gate(), /preflight not read yet/);
});

test("a draft the helper would refuse as a whole (whole-curve + point changes on one unit) is stopped before the plan, on its unit", async () => {
  const { store, ctl, bridge } = await rig({}, (m, d) => d);
  const sent = spy(bridge);
  patchTune(store, { draft: { units: { P0: { curveMv: -10, pts: { 53: -20 } } }, turbo: {} } });
  assert.equal(await ctl.review(["tune"]), "failed");
  const a = store.get().apply;
  assert.equal(a.error.located.unit, "P0");
  assert.match(a.error.message, /^P0: A whole-curve change and point changes on one unit cannot go in one apply/);
  assert.ok(!sent.some(([op]) => op === "tune.plan"), "never reached the helper");
});

test("F-05: in a V/F + power review, retyping PL1 while the V/F part writes stops the sequence before the power write", async () => {
  const { store, ctl, bridge } = await rtRig({ stepMs: 4 });
  const sent = spy(bridge);
  patchTune(store, { draft: setPoint(store.get().tune.model, emptyDraft(), ["P0"], 53, -20) });
  editRt(store, (e) => ({ ...e, power: { pl1_w: 200 } }));
  const requests = tabRequests(store);
  assert.deepEqual(requests.map((r) => (typeof r === "string" ? r : r.kind)), ["tune", "power"]);
  assert.equal(await ctl.review(requests), "review", JSON.stringify(ctl.state().error));
  const run = ctl.apply();
  await until(() => ctl.state().sections[0].status === "applying");
  editRt(store, (e) => ({ ...e, power: { pl1_w: 180 } }));
  assert.equal(await run, false);
  const a = ctl.state();
  assert.deepEqual(a.sections.map((s) => s.status), ["done", "stale"]);
  assert.match(a.sections[1].error.message, /^You changed the power limits while the apply ran/);
  assert.ok(!sent.some(([op]) => op === "power.apply"), "200 W was never written");
  assert.equal(store.get().rt.power.result.powercap.pl1_w, 250);
  assert.deepEqual(store.get().rt.edits.power, { pl1_w: 180 }, "the new edit stays pending");
});

// ================================================================ R-I1: every apply carries the intent on screen; the helper's stale refusals end in Review again
test("R-I1: power and caps / uncore applies carry the edits on screen as their intent (the plan request's shape), a revert its own", async () => {
  const { store, ctl, bridge } = await rtRig();
  const sent = spy(bridge);
  editRt(store, (e) => ({ ...e, power: { pl1_w: 200 }, caps: { P0: 50 } }));
  assert.equal(await ctl.review(tabRequests(store)), "review");
  assert.equal(await ctl.apply(), true);
  const applies = sent.filter(([op]) => op.endsWith(".apply")).map(([op, a]) => [op, a.intent]);
  assert.deepEqual(applies, [["power.apply", { power: { pl1_w: 200 } }], ["runtime.apply", { caps: { 0: 50 } }]]);
  const plans = sent.filter(([op]) => op.endsWith(".plan")).map(([op, a]) => [op, a]);
  assert.deepEqual(plans.map(([, a]) => a), applies.map(([, i]) => i), "the apply's intent is the plan's request");
  sent.length = 0;
  assert.equal(await ctl.review([revertRequest("power")]), "review");
  assert.equal(await ctl.apply(), true);
  assert.deepEqual(sent.find(([op]) => op === "power.apply")[1].intent, { revert: true }, "a fixed request is its own intent");
});

test("R-I1: the helper refuses a plan of other edits (PLAN_STALE INTENT_CHANGED): nothing written, the sheet says why and Review again plans what is on screen", async () => {
  const { store, ctl, bridge } = await rig();
  // an edit that lands between the page's own check and the helper's compare (a race the page cannot see): the apply carries the newer edit
  const call = bridge.call.bind(bridge);
  bridge.call = (op, args) => call(op, op === "tune.apply" ? { ...args, intent: buildIntent(store.get().tune.model, setPoint(store.get().tune.model, emptyDraft(), ["P0"], 53, -25)).intent } : args);
  assert.equal(await ctl.review(["tune"]), "review");
  assert.equal(await ctl.apply(), false);
  const sec = store.get().apply.sections[0];
  assert.deepEqual([sec.status, sec.error.code, sec.error.detail.check, sec.error.detail.writes_sent], ["stale", "PLAN_STALE", "INTENT_CHANGED", 0]);
  const o = outcomeOf(store.get().apply);
  assert.equal(o.kind, "stale");
  assert.equal(o.text, "Nothing was written. " + HINTS["sheet.intent_changed"].line);
  assert.equal(store.get().apply.stale, null, "nothing written: no stale-model warning");
  bridge.call = call;
  assert.equal(await ctl.replan(), "review", "Review again");
  assert.equal(await ctl.apply(), true);
});

test("R-I1: staleHint names the helper's reason (INTENT_CHANGED, STATE_CHANGED) and falls back to the plain stale line", () => {
  assert.equal(staleHint({ code: "PLAN_STALE", detail: { check: "INTENT_CHANGED" } }), "sheet.intent_changed");
  assert.equal(staleHint({ code: "PLAN_STALE", detail: { check: "STATE_CHANGED", writes_sent: 0 } }), "sheet.state_changed");
  assert.equal(staleHint({ code: "PLAN_STALE" }), "sheet.stale");
  assert.equal(staleHint(null), "sheet.stale");
  for (const k of ["sheet.intent_changed", "sheet.state_changed"]) assert.match(HINTS[k].line, /Review again\.$/);
  const a = { state: "failed", sections: [{ kind: "tune", status: "stale", plan: { writes: 2 }, error: { code: "PLAN_STALE", message: "x", detail: { check: "STATE_CHANGED", writes_sent: 0 } } }] };
  assert.equal(outcomeOf(a).text, "Nothing was written. " + HINTS["sheet.state_changed"].line);
});
