// node --test "desktop/app/ui/tests/*.test.mjs"   (G-217: the Power / Ring & uncore / Ratio caps logic: intents validated by the helper's own parsers, the CPU-limit lib, the rt state, the drawer kinds, the mock)
// The validators are src/linux_xtu/helper/ops_power.py _validate_power_plan and ops_runtime.py _validate_runtime_plan, run by /usr/bin/python3 -I with src/ on sys.path (stdlib only, no helper started,
// no socket, no hardware). Fixtures are the simulator's recordings (fixtures/g217/), `cpu_limits` included (G-226 / D-049: recorded as each read returns it).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import G from "../fixtures/g217/fixtures-g217.js";
import FIX from "../fixtures/fixtures.js";
import { Bridge } from "../bridge.js";
import { createMockTransport } from "../fixtures/mock-backend.js";
import { encodeTau } from "../fixtures/mock-backend-g217.js";
import { createAppStore } from "../store.js";
import { powerIntent, runtimeIntent, POWER_REVERT, RUNTIME_REVERT } from "../lib/intent.js";
import { normCpuLimits, capWindow, uncoreWindow, capsLine, uncoreLine, powerLine, explainRefusal, powerRead, cpuOffsetCell, modelCpuLine, READ_FIRST } from "../lib/cpulimits.js";
import { initialRt, revertReason, powerCurrent, powerDisagrees, powerDisabledReason, powerRequest, capRows, uncoreState, runtimeRequest, pendingCounts, ensureRt, editRt } from "../lib/rtstate.js";
import { ensureTune, requestReview as pendingBarReview, syncPending, setPendingAll, discardDraft } from "../views/tune.js";
import { powerView, runtimeView, POWER_KIND, RUNTIME_KIND, registerRuntimeKinds, requestReview, revertRequest, PL_NAME } from "../views/tune/runtime-kinds.js";
import { KINDS, createApplyController, planWarnings, readbackCells, partialWording, summarizeResult, settledNote } from "../views/tune/apply.js";
import { powerOrder } from "../views/tune/power.js";
import { uncoreDisabledReason } from "../views/tune/ring.js";
import { overviewRows } from "../views/dashboard.js";
import { topologyRows } from "../views/system.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT + "/src")})
from linux_xtu.helper.ops_power import _validate_power_plan
from linux_xtu.helper.ops_runtime import _validate_runtime_plan
fns = {"power.plan": _validate_power_plan, "runtime.plan": _validate_runtime_plan}
out = []
for op, args in json.load(sys.stdin):
    try:
        fns[op](args)
        out.append({"ok": True})
    except Exception as exc:  # OpError
        out.append({"ok": False, "error": getattr(exc, "message", str(exc))})
print(json.dumps(out))
`;
function helperAccepts(cases) {
  const r = spawnSync("/usr/bin/python3", ["-I", "-c", PY], { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const RT_READ = G["runtime-read"].result;
const PW_READ = G["power-read"].result;
// the recorded cpu_limits of each read (simulator): power.read fills `power`, runtime.read fills caps_khz / uncore_khz, tune.read neither
const CL = { ...structuredClone(RT_READ.cpu_limits), power: structuredClone(PW_READ.cpu_limits.power) };
const UNREAD = G["power-read-unread"].result.cpu_limits;
const TUNE_CL = FIX["tune-read"].result.cpu_limits;

// ---- intents vs the helper's parsers ----
test("intents: power and runtime intents are accepted by the helper's own parsers (top-level fields, not {intent})", () => {
  const cases = [
    ["power.plan", powerIntent({ pl1_w: 230, pl2_w: 280, tau_s: 56 }).intent],
    ["power.plan", powerIntent({ tau_s: 28.5 }).intent],
    ["power.plan", POWER_REVERT],
    ["runtime.plan", runtimeIntent({ caps: { 0: 50, 8: 23, 9: 23, 10: 23, 11: 23 }, uncore: { max_ratio: 38 } }).intent],
    ["runtime.plan", runtimeIntent({ uncore: { min_ratio: 8, max_ratio: 40 } }).intent],
    ["runtime.plan", RUNTIME_REVERT],
  ];
  const out = helperAccepts(cases);
  out.forEach((o, i) => assert.equal(o.ok, true, JSON.stringify(cases[i]) + " -> " + o.error));
});

test("intents: what the helper refuses, the builders refuse or never produce (parking too: D-048)", () => {
  assert.ok(powerIntent({ pl1_w: 250.5 }).error, "whole watts");
  assert.ok(powerIntent({ pl3_w: 5 }).error);
  assert.ok(powerIntent({ tau_s: 0 }).error);
  assert.ok(powerIntent({ pl1_w: "250" }).error);
  assert.equal(powerIntent({}).intent, null);
  assert.equal(powerIntent({ pl1_w: 250 }, { pl1_w: 250 }).intent, null, "equal to the value in force: dropped");
  assert.ok(runtimeIntent({ caps: { x: 5 } }).error);
  assert.ok(runtimeIntent({ caps: { 0: 0 } }).error);
  assert.ok(runtimeIntent({ caps: { 0: 256 } }).error);
  assert.ok(runtimeIntent({ uncore: { max_freq: 5 } }).error);
  assert.equal(runtimeIntent({}).intent, null);
  const bad = [
    ["power.plan", { power: { pl1_w: 250 }, revert: true }],
    ["power.plan", { intent: { power: { pl1_w: 250 } } }],
    ["runtime.plan", { parking: { 8: false } }],
    ["runtime.plan", { intent: { caps: { 0: 40 } } }],
  ];
  helperAccepts(bad).forEach((o, i) => assert.equal(o.ok, false, JSON.stringify(bad[i])));
  assert.ok(!("parking" in (runtimeIntent({ caps: { 0: 40 } }).intent)));
});

// ---- cpu_limits ----
test("cpulimits: the recorded shape is normalised; null stays null; lines name the CPU source, never a policy", () => {
  assert.equal(normCpuLimits(null), null);
  const cl = normCpuLimits(CL);
  assert.deepEqual(cl.offsetMv, [-1000, 999]);
  assert.equal(cl.kinds.P.maxMv, 1625);
  assert.equal(cl.kinds.ring.maxMv, 1999);
  assert.deepEqual(capWindow(cl, 0), { min: 8, max: 57, minKhz: 800000, maxKhz: 5700000 });
  assert.equal(capWindow(cl, 99), null);
  assert.deepEqual(uncoreWindow(cl), { min: 8, max: 40 });
  assert.equal(capsLine(cl, [0]), "cpufreq 800–5700 MHz (cpu0)");
  assert.match(uncoreLine(cl), /^uncore 8×–40×/);
  assert.match(powerLine(cl), /PL field maximum 4095\.875 W/);
  assert.equal(powerRead(cl), true);
  assert.match(powerLine(normCpuLimits({ power: { locked: true, pl_max_w: 100 } })), /locked by firmware/);
  const m = { cpuLimits: cl };
  for (const text of [capsLine(cl, [0]), uncoreLine(cl), powerLine(cl), modelCpuLine(m, "P", "vt"), modelCpuLine(m, "E", "offset"), cpuOffsetCell(m, "P")]) assert.doesNotMatch(text, /policy/i);
  assert.equal(cpuOffsetCell(m, "P"), "−1000…+999 · CPU");
  assert.equal(modelCpuLine(m, "E", "ratio"), "CPU limit: OC ratios up to 120× (OC ratio limit, mailbox 0x01).");
  assert.equal(modelCpuLine({ cpuLimits: null }, "P", "vt"), READ_FIRST + " (the CPU voltage ceiling, mailbox 0x28, has not been read).");
});

test("cpulimits: the per-op nulls of the real helper: tune.read has no power / cpufreq / uncore part; a null cpufreq minimum is not a number", () => {
  const tune = normCpuLimits(TUNE_CL);
  assert.equal(powerRead(tune), false);
  assert.match(powerLine(tune), new RegExp("^" + READ_FIRST));
  assert.equal(uncoreWindow(tune), null);
  assert.equal(capWindow(tune, 0), null);
  const unread = normCpuLimits(UNREAD);
  assert.equal(unread.kinds.P.maxMv, null);
  assert.equal(unread.kinds.ring.maxRatio, null);
  assert.equal(powerRead(unread), true, "power.read reads MSR 0x610 on its own");
  const nullMin = normCpuLimits({ caps_khz: { 0: [null, 5700000] } });
  assert.deepEqual(capWindow(nullMin, 0), { min: null, max: 57, minKhz: null, maxKhz: 5700000 });
  assert.equal(capsLine(nullMin, [0]), "cpufreq ?–5700 MHz (cpu0)");
  assert.equal(normCpuLimits({ caps_khz: { 0: [800000, null] } }).capsKhz[0], undefined);
  assert.equal(normCpuLimits({ power: { locked: null, pl_max_w: null } }).power.locked, null);
});

test("cpulimits: a CPU_LIMIT_UNREAD refusal says to read the CPU state; any other refusal shows the helper's own CPU rule", () => {
  assert.match(explainRefusal({ code: "REFUSED", message: "x", detail: { check: "CPU_LIMIT_UNREAD" } }), new RegExp("^" + READ_FIRST));
  assert.equal(explainRefusal({ code: "REFUSED", message: "pl1_w = 9000 W is above the field", detail: { check: "CPU_LIMIT", key: "pl1_w" } }), "pl1_w = 9000 W is above the field");
  assert.equal(explainRefusal(G["runtime-plan-range"].response.error), G["runtime-plan-range"].response.error.message);
});

// ---- the rt state ----
const readyRt = (patch = {}) => {
  const rt = initialRt();
  rt.power = { state: "ready", result: PW_READ, error: null, at: null };
  rt.runtime = { state: "ready", result: RT_READ, error: null, at: null };
  return { ...rt, ...patch };
};

test("rtstate: power edits against what power.read says (file first, MSR as fallback); equal values are dropped", () => {
  const rt = readyRt();
  assert.deepEqual(powerCurrent(PW_READ), { pl1_w: 250, pl2_w: 295, tau_s: 127.926272 });
  rt.edits.power = { pl1_w: 250, pl2_w: 280 };
  assert.deepEqual(powerRequest(rt), { intent: { power: { pl2_w: 280 } } });
  rt.edits.power = { pl1_w: 250 };
  assert.equal(powerRequest(rt).intent, null);
  assert.equal(powerDisagrees(PW_READ, "pl1_w"), false);
  assert.equal(powerDisabledReason(null), "Read the power limits first");
  assert.equal(powerDisabledReason(PW_READ), "");
  assert.match(powerDisabledReason({ ...PW_READ, locked: true }), /locked/);
});

test("rtstate: caps are per unit; an E cluster expands to its 4 CPUs; a value equal to the read is dropped", () => {
  const groups = capRows(RT_READ);
  assert.deepEqual(groups.map((g) => g.unit), ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "EC0", "EC1", "EC2", "EC3"]);
  assert.deepEqual(groups.find((g) => g.unit === "EC0").cpus, [8, 9, 10, 11]);
  assert.equal(groups[0].capRatio, 57);
  const rt = readyRt();
  rt.edits.caps = { P0: 50, EC0: 23, P1: 55 };
  const r = runtimeRequest(rt);
  assert.deepEqual(r.intent, { caps: { 0: 50, 8: 23, 9: 23, 10: 23, 11: 23 } }, "P1 is already 55x: dropped");
  assert.equal(pendingCounts(rt).caps, 2);
  rt.edits.uncore = { max_ratio: 38, min_ratio: 8 };
  assert.deepEqual(runtimeRequest(rt).intent.uncore, { max_ratio: 38 }, "min is already 8x");
  rt.edits.uncore = { min_ratio: 30, max_ratio: 20 };
  assert.match(runtimeRequest(rt).error, /above max/);
  assert.deepEqual(uncoreState(RT_READ), { min: 8, max: 40, initialMin: 8, initialMax: 40 });
});

test("rtstate: an offline CPU is read-only; its unit has no online CPU to write", () => {
  const rows = structuredClone(RT_READ);
  rows.caps[0].online = false;
  const rt = readyRt();
  rt.runtime = { state: "ready", result: rows, error: null, at: null };
  rt.edits.caps = { P0: 40 };
  assert.match(runtimeRequest(rt).error, /no online CPU/);
  assert.match(uncoreDisabledReason({ ...RT_READ, offline: [0] }, normCpuLimits(CL)), /offline/);
});

test("views: the uncore disabled reason names the missing read", () => {
  assert.match(uncoreDisabledReason(RT_READ, null), new RegExp(READ_FIRST));
  assert.equal(uncoreDisabledReason(RT_READ, normCpuLimits(CL)), "");
});

test("power: PL1 above PL2 is refused from either side (POWER_ORDER, R-S2); the drawer keeps the XTU labels", () => {
  assert.equal(powerOrder({ pl1_w: 250, pl2_w: 295 }, {}, "pl1_w", 295), null, "equal is allowed");
  assert.deepEqual(powerOrder({ pl1_w: 250, pl2_w: 295 }, {}, "pl2_w", 200), { key: "refused.power_order", vars: { long: "250", short: "200" } });
  assert.deepEqual(powerOrder({ pl1_w: 250, pl2_w: 295 }, { pl2_w: 260 }, "pl1_w", 270), { key: "refused.power_order", vars: { long: "270", short: "260" } }, "against the pending PL2");
  assert.equal(powerOrder({ pl1_w: 300, pl2_w: 250 }, {}, "tau_s", 28), null, "tau is not ordered");
  assert.deepEqual(Object.values(PL_NAME), ["Processor Core Power Limit (PL1)", "Processor Core Turbo Power Limit (PL2)", "Turbo Boost Power Time Window"]);
});

// ---- G-232: runtime result labels ----
test("G-232: a revert cap step has no ratio field: the row is derived from the kHz values, never 'undefined'", () => {
  const rv = runtimeView({ steps: [{ n: 1, domain: "caps", key: "cpu7", file: "cpu7/cpufreq/scaling_max_freq", before: 5400000, value: 5500000, expect: [5500000, 5500000] }, { n: 2, domain: "uncore", key: "max_ratio", file: "u/max_freq_khz", before: 4000000, value: 3000000 }] });
  assert.equal(rv.units[0].unit, "cpu 7");
  assert.equal(rv.units[0].lines[0], "max 54× → 55× (5500 MHz)");
  assert.equal(rv.steps[0], "write cpu7/cpufreq/scaling_max_freq = 5500000 kHz (55×)");
  assert.ok(!JSON.stringify(rv).includes("undefined"));
  const e = runtimeView({ steps: [{ n: 1, domain: "caps", key: "cpu8", file: "f", before: 4800000, value: 4600000, ratio: 46, note: "capped at 46×" }] });
  assert.equal(e.units[0].lines[0], "max 48× → 46× (4600 MHz) · capped at 46×", "the plan's own ratio and note win");
});

test("G-237: a late OC-point V target is noted on its read-back row, nothing otherwise", () => {
  assert.equal(settledNote({ unit: "P0", point: 0, match: true, polls: 2, settle_ms: 7.4 }), "settled after 2 re-reads (7 ms)");
  assert.equal(settledNote({ polls: 1 }), "settled after 1 re-read");
  for (const x of [{ polls: 0 }, { match: true }, null, "x", { polls: "2" }]) assert.equal(settledNote(x), "");
  // the row shape tune.apply returns (ops_tune._report_rows, simulator late_target_reads=2): the summary keeps the row whole and the note renders from it
  const late = { unit: "EC1", point: 0, cpu: 12, expected: "0x00048c30", actual: "0x00048c30", match: true, polls: 2, settle_ms: 7.0 };
  const first = { unit: "EC1", point: 7, cpu: 12, expected: "0x00000030", actual: "0x00000030", match: true };
  const s = summarizeResult({ complete: true, readback: [late, first] });
  assert.equal(s.allMatch, true);
  assert.deepEqual(s.readback.map(settledNote), ["settled after 2 re-reads (7 ms)", ""]);
});

test("G-232: read-back rows of the runtime / power helpers are shown by file and key, V/F rows as before", () => {
  const caps = readbackCells({ domain: "caps", key: "cpu7", expected: [5400000, 5400000], file: 5400000, match: true });
  assert.deepEqual(caps, { unit: "cpu7", point: "scaling_max_freq", cpu: 7, expected: "5400000", actual: "5400000" });
  assert.equal(readbackCells({ domain: "caps", key: "cpu8", expected: [4600000, 4650000], file: null, match: false }).expected, "4600000–4650000");
  assert.equal(readbackCells({ domain: "caps", key: "cpu8", expected: [1, 1], file: null }).actual, "not read back");
  const un = readbackCells({ domain: "uncore", key: "max_ratio", expected: [3e6, 3e6], file: 3e6 });
  assert.deepEqual([un.unit, un.point], ["uncore", "max_freq_khz"]);
  const pw = readbackCells({ key: "pl1_w", expected: [1, 1], file: 1, msr: 1 });
  assert.deepEqual([pw.unit, pw.point], ["power", "pl1_w"]);
  assert.deepEqual(readbackCells({ unit: "P0", point: 3, cpu: 0, expected: "0x1", actual: "0x2" }), { unit: "P0", point: "pt 3", cpu: 0, expected: "0x1", actual: "0x2" });
  assert.equal(readbackCells({ unit: "P0", point: 0 }).point, "OC point");
  for (const x of [{ domain: "caps", key: "cpu7", expected: [1, 1], file: 1 }, { key: "pl2_w", expected: [1, 1], file: 1 }]) assert.ok(!/pt |undefined/.test(JSON.stringify(readbackCells(x))));
  assert.equal(summarizeResult({ readback: [{ domain: "caps", key: "cpu7", match: false }], complete: false }).total, 1);
});

test("G-232: the red box of a partial runtime apply says runtime settings, not V/F words", () => {
  const vf = partialWording(false, true);
  assert.match(vf.title, /mix of old and new words/);
  assert.match(vf.text, /cold boot/);
  const rt = partialWording(true, true);
  assert.equal(rt.title, "Some runtime settings were written, some not.");
  assert.equal(rt.text, "The table shows which. Use the Restore boot button on that tab, or reboot (runtime values do not survive a reboot). The guard tripped.");
  assert.ok(!/cold boot|accepted state|old and new words/.test(rt.title + rt.text));
});

// ---- drawer kinds ----
test("kinds: power/runtime register once with planArgs = the intent itself (top-level fields) and the recorded plans give rows", () => {
  registerRuntimeKinds();
  registerRuntimeKinds();
  assert.equal(KINDS.power.planOp, "power.plan");
  assert.equal(KINDS.runtime.applyOp, "runtime.apply");
  const intent = { power: { pl1_w: 230 } };
  assert.equal(POWER_KIND.planArgs(intent), intent);
  assert.equal(RUNTIME_KIND.planArgs(intent), intent);
  const pv = powerView(G["power-plan"].response.result);
  assert.deepEqual(pv.units.map((u) => u.keys[0]), ["pl1_w", "pl2_w", "tau_s"]);
  assert.equal(pv.units[0].lines[0], "250 W → 230 W");
  assert.equal(pv.units[2].lines[0], "127.9 s → 56 s");
  const rv = runtimeView(G["runtime-plan"].response.result);
  assert.equal(rv.units[0].unit, "cpu 0");
  assert.equal(rv.units[0].lines[0], "max 57× → 50× (5000 MHz)");
  assert.equal(rv.units[1].unit, "cpu 8, 9, 10, 11", "the four CPUs of the cluster asked for the same change: one row");
  assert.match(rv.units[1].lines[0], /capped at 22/);
  assert.equal(rv.units[2].unit, "Uncore max ratio");
  assert.equal(rv.steps.length, 6);
});

test("kinds: a pending edit becomes a request; the tab's Review dispatches tune:review with detail.requests; nothing pending says so", () => {
  const store = createAppStore();
  ensureTune(store);
  ensureRt(store);
  const got = [];
  store.events.addEventListener("tune:review", (e) => got.push(e.detail));
  assert.deepEqual(requestReview(store), [], "nothing pending");
  assert.equal(store.get().toasts.at(-1).text, "Nothing to review: no pending changes.");
  store.set({ rt: readyRt() });
  editRt(store, (e) => ({ ...e, power: { pl1_w: 230 }, caps: { P0: 50 } }));
  const reqs = requestReview(store);
  // R-S3 (F-05): requests built from the edits are tracked: the sheet checks the plan against the edits up to the write
  assert.deepEqual(reqs, [{ kind: "power", intent: { power: { pl1_w: 230 } }, label: "Power limits", track: true }, { kind: "runtime", intent: { caps: { 0: 50 } }, label: "Ratio caps & uncore", track: true }]);
  assert.deepEqual(got[0].requests, reqs);
  assert.deepEqual(revertRequest("power").intent, { revert: true });
  assert.deepEqual(requestReview(store, [revertRequest("runtime")])[0].kind, "runtime");
});

// ---- the mock helper ----
async function mockBridge(query = "") {
  globalThis.location = { search: "?bridge=mock" + query };
  const t = createMockTransport({ stepMs: 1 });
  const b = new Bridge(t);
  await b.connect();
  return b;
}
const run = async (b, op, args) => {
  const first = await b.call(op, args);
  return first.ok && first.pending ? b.wait(first.id) : first;
};
/** R-S3 (D-053 item 4): the shell's native dialog for the plan (the mock answers yes), then the apply with the plan id only. */
const confirmAndApply = async (b, op, planId) => {
  const c = await b.call("app.confirm", { plans: [{ op, plan_id: planId }] });
  assert.equal(c.ok, true, JSON.stringify(c));
  return run(b, op, { plan_id: planId });
};

test("mock: power.read -> plan -> apply -> read -> revert follows the intent (recorded shapes, cpu_limits present, no policy)", async () => {
  const b = await mockBridge();
  const r0 = (await run(b, "power.read")).result;
  assert.equal(r0.boot, null);
  assert.ok(r0.cpu_limits && r0.cpu_limits.power.pl_max_w > 0);
  assert.ok(!JSON.stringify(r0).includes("policy"));
  const plan = await b.call("power.plan", { power: { pl1_w: 230, pl2_w: 280, tau_s: 56 } });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.result.steps.map((s) => [s.key, s.value]), [["pl1_w", 230e6], ["pl2_w", 280e6], ["tau_s", 56000000]]);
  assert.equal(encodeTau(56), 56);
  assert.ok(encodeTau(57) <= 57 && encodeTau(57) > 55, "rounded down onto the encodable grid");
  assert.equal(plan.result.nonce, undefined, "the shell keeps the plan's code (D-053 item 4)");
  const typed = await b.call("power.apply", { plan_id: plan.result.plan_id, typed: "CONFIRM ABCDEF" });
  assert.deepEqual([typed.error.code, typed.error.detail.writes_sent], ["BAD_REQUEST", 0], "the page never sends a code");
  assert.equal((await b.call("power.apply", { plan_id: plan.result.plan_id })).error.code, "NOT_CONFIRMED", "no apply without the dialog");
  const done = await confirmAndApply(b, "power.apply", plan.result.plan_id);
  assert.equal(done.ok, true);
  assert.ok(done.result.readback.every((x) => x.match));
  const r1 = (await run(b, "power.read")).result;
  assert.deepEqual([r1.powercap.pl1_w, r1.powercap.pl2_w, r1.msr.limit.pl1_w], [230, 280, 230]);
  assert.equal(r1.boot.pl1_w, 250);
  const rev = await b.call("power.plan", { revert: true });
  assert.equal(rev.ok, true);
  assert.equal((await confirmAndApply(b, "power.apply", rev.result.plan_id)).ok, true);
  const r2 = (await run(b, "power.read")).result;
  assert.deepEqual([r2.powercap.pl1_w, r2.boot], [250, null]);
  assert.equal((await b.call("power.plan", { revert: true })).error.detail.check, "NO_JOURNAL");
});

test("mock: refusals are CPU rules with the key; the wrapped {intent} shape is a BAD_REQUEST like the helper's", async () => {
  const b = await mockBridge();
  const high = await b.call("power.plan", { power: { pl1_w: 5000 } });
  assert.deepEqual([high.error.code, high.error.detail.check, high.error.detail.key], ["REFUSED", "CPU_LIMIT", "pl1_w"]);
  assert.doesNotMatch(high.error.message, /policy/i);
  assert.equal((await b.call("power.plan", { power: { pl1_w: 250 } })).error.detail.check, "NOTHING_TO_DO");
  assert.equal((await b.call("power.plan", { intent: { power: { pl1_w: 230 } } })).error.code, "BAD_REQUEST");
  assert.equal((await b.call("power.plan", { power: { pl1_w: 250.5 } })).error.code, "BAD_REQUEST");
  const lowPl2 = await b.call("power.plan", { power: { pl2_w: 249 } });
  assert.equal(lowPl2.ok, true, "PL2 below PL1 is a warning, not a refusal");
  assert.match(lowPl2.result.warnings[0], /^PL2_BELOW_PL1: /, "power.plan sends \"CODE: text\" strings");
  const cap = await b.call("runtime.plan", { caps: { 0: 99 } });
  assert.deepEqual([cap.error.detail.check, cap.error.detail.key], ["CPU_LIMIT", "cpu0"]);
  const unc = await b.call("runtime.plan", { uncore: { max_ratio: 45 } });
  assert.equal(unc.error.detail.check, "UNCORE_RANGE");
  assert.equal((await b.call("runtime.plan", { uncore: { min_ratio: 30, max_ratio: 20 } })).error.detail.check, "UNCORE_ORDER");
  assert.equal((await b.call("runtime.plan", { parking: { 8: false } })).error.code, "BAD_REQUEST");
  assert.equal((await b.call("runtime.plan", { intent: { caps: { 0: 40 } } })).error.code, "BAD_REQUEST");
  const mixed = await b.call("runtime.plan", { caps: { 8: 30, 9: 31 } });
  assert.equal(mixed.error.detail.check, "CLUSTER_CONFLICT");
  assert.equal((await b.call("runtime.plan", { revert: true })).error.detail.check, "NO_JOURNAL");
});

test("mock: runtime plan -> apply -> read -> revert; an E cluster is capped one bin low where the grid cannot hit the ratio and the plan says so", async () => {
  const b = await mockBridge();
  const plan = await b.call("runtime.plan", { caps: { 0: 50, 8: 23, 9: 23, 10: 23, 11: 23 }, uncore: { max_ratio: 38 } });
  assert.equal(plan.ok, true);
  assert.equal(plan.result.steps.length, 6);
  assert.match(plan.result.steps[1].note, /capped at 22/);
  assert.ok(plan.result.warnings.some((w) => /capped at 22/.test(w)));
  const done = await confirmAndApply(b, "runtime.apply", plan.result.plan_id);
  assert.equal(done.ok, true);
  assert.ok(done.result.readback.every((x) => x.match));
  const r = (await b.call("runtime.read")).result;
  const g = capRows(r);
  assert.deepEqual([g[0].capRatio, g.find((x) => x.unit === "EC0").capRatio, uncoreState(r).max], [50, 22, 38]);
  assert.equal(r.journal.caps[0], 5700000);
  const rev = await b.call("runtime.plan", { revert: true });
  assert.equal((await confirmAndApply(b, "runtime.apply", rev.result.plan_id)).ok, true);
  const after = (await b.call("runtime.read")).result;
  assert.deepEqual([capRows(after)[0].capRatio, uncoreState(after).max, after.journal], [57, 40, null]);
});

test("mock: ?cpulimits=unread -> the recorded not-read shape (null limits, source 'not read yet'); write plans say CPU_LIMIT_UNREAD; tune.read carries cpu_limits otherwise", async () => {
  let b = await mockBridge("&cpulimits=unread");
  const pw = (await run(b, "power.read")).result.cpu_limits;
  assert.deepEqual([pw.P.max_mv, pw.ring.max_ratio, pw.power.pl_max_w, pw.power.locked], [null, null, null, null]);
  assert.match(pw.P.source, /not read yet/);
  const rt = (await b.call("runtime.read")).result.cpu_limits;
  assert.deepEqual([rt.caps_khz, rt.uncore_khz], [null, null]);
  assert.equal((await b.call("power.plan", { power: { pl1_w: 230 } })).error.detail.check, "CPU_LIMIT_UNREAD");
  assert.equal((await b.call("runtime.plan", { caps: { 0: 50 } })).error.detail.check, "CPU_LIMIT_UNREAD");
  const unreadLast = (await b.call("tune.last")).result.result.cpu_limits;
  assert.equal(unreadLast.P.max_mv, null);
  assert.deepEqual(unreadLast.offset_mv, [-1000, 999], "the offset field is the encoding: always known");
  b = await mockBridge();
  const last = (await b.call("tune.last")).result.result;
  assert.deepEqual(last.cpu_limits.offset_mv, [-1000, 999]);
  assert.equal(last.cpu_limits.P.max_mv, 1625);
  assert.equal(last.cpu_limits.caps_khz, null, "tune.last has no cpufreq part: that is runtime.read's");
  const read = await run(b, "tune.read");
  assert.equal(read.result.cpu_limits.ring.max_mv, 1999);
  assert.equal((await run(b, "power.read")).result.cpu_limits.power.pl_max_w, 4095.875);
  assert.ok((await b.call("runtime.read")).result.cpu_limits.caps_khz["0"]);
});

test("drawer: plan warnings are amber rows and never block Apply; \"CODE: text\" strings and {code, text} objects both carry their code", () => {
  const w = planWarnings({
    warnings: [
      "LARGE_CHANGE: cpu 0: cap 57 -> 50 is a large single change", "PL2_BELOW_PL1: PL2 (200 W) would be below PL1 (250 W)",
      { code: "TURBO_NOT_MONOTONIC", text: "P turbo table: bucket 1 is below bucket 2" }, { code: "TURBO_BELOW_BASE", text: "a bucket is below the base ratio" },
      { code: "DEEP_WHOLE_CURVE", text: "whole-curve offset" }, { code: "POSITIVE_OFFSET", text: "positive" }, { code: "TURBO_RAISE", text: "raised" }, { code: "CLAMPED", text: "clamped" },
      "the values now in force are journaled before the first write: not a code", "an E-cluster runs one ratio: not a code either",
    ],
  });
  assert.deepEqual(w.map((x) => x.code), ["LARGE_CHANGE", "PL2_BELOW_PL1", "TURBO_NOT_MONOTONIC", "TURBO_BELOW_BASE", "DEEP_WHOLE_CURVE", "POSITIVE_OFFSET", "TURBO_RAISE", "CLAMPED", "NOTE", "NOTE"]);
  assert.ok(w.slice(0, 8).every((x) => x.cls === "warn" && x.label), "marked as warnings");
  assert.equal(w[0].text, "cpu 0: cap 57 -> 50 is a large single change", "the prefix is the badge, not repeated in the text");
  assert.equal(w[8].cls, "");
  assert.ok(planWarnings(G["runtime-plan"].response.result).some((x) => x.code === "LARGE_CHANGE"), "the simulator's own runtime plan carries LARGE_CHANGE");
});

test("controller: a power section is planned with the intent as the plan arguments and applied in sequence with the V/F section (stop on first failure)", async () => {
  const b = await mockBridge();
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  ensureTune(store);
  ensureRt(store);
  store.set({ rt: readyRt() });
  const calls = [];
  const spy = { call: (op, args) => (calls.push([op, args]), b.call(op, args)), on: (e, f) => b.on(e, f), off: (e, f) => b.off(e, f), wait: (id) => b.wait(id) };
  registerRuntimeKinds();
  const ctl = createApplyController({ store, bridge: spy });
  const state = await ctl.review([{ kind: "power", intent: { power: { pl1_w: 230 } }, label: "Power limits" }, { kind: "runtime", intent: { caps: { 0: 50 } }, label: "Caps" }]);
  const planCalls = calls.filter(([op]) => op.endsWith(".plan"));
  assert.deepEqual(planCalls.map(([op]) => op), ["power.plan", "runtime.plan"]);
  assert.deepEqual(planCalls[0][1], { power: { pl1_w: 230 } }, "the plan arguments are the intent itself, not {intent}");
  assert.deepEqual(planCalls[1][1], { caps: { 0: 50 } });
  assert.equal(state, "review");
  assert.equal(await ctl.apply(), true);
  assert.deepEqual(ctl.state().sections.map((s) => s.status), ["done", "done"]);
});

test("controller: a refused plan shows the helper's CPU rule; an unread limit says Read CPU state first (explain hook)", async () => {
  const b = await mockBridge();
  const store = createAppStore();
  store.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  ensureTune(store);
  ensureRt(store);
  registerRuntimeKinds();
  const ctl = createApplyController({ store, bridge: b });
  assert.equal(await ctl.review([{ kind: "runtime", intent: { uncore: { max_ratio: 45 } }, label: "Caps" }]), "failed");
  assert.match(ctl.state().sections[0].error.message, /outside the hardware's own uncore range 8\.\.40/);
  const b2 = await mockBridge("&cpulimits=unread");
  const store2 = createAppStore();
  store2.set({ link: { state: "connected", kind: null, message: "", fix: null } });
  ensureTune(store2);
  const ctl2 = createApplyController({ store: store2, bridge: b2 });
  await ctl2.review([{ kind: "power", intent: { power: { pl1_w: 230 } }, label: "Power" }]);
  assert.match(ctl2.state().sections[0].error.message, new RegExp("^" + READ_FIRST));
});

test("pending bar: the runtime edits are counted and one Review covers V/F + turbo + ring + power + caps; Discard drops them", () => {
  const store = createAppStore();
  ensureTune(store);
  ensureRt(store);
  store.set({ rt: readyRt() });
  const got = [];
  store.events.addEventListener("tune:review", (e) => got.push(e.detail));
  assert.deepEqual(store.get().pending, { changes: 0, units: 0 });
  editRt(store, (e) => ({ ...e, power: { pl1_w: 230, tau_s: 56 }, caps: { P0: 50, EC0: 23 }, uncore: { max_ratio: 38 } }));
  assert.deepEqual(store.get().pending, { changes: 5, units: 4 }, "2 power values (1 unit), 2 cap units, 1 uncore value (1 unit)");
  setPendingAll(store, 3, 2);
  assert.deepEqual(store.get().pending, { changes: 8, units: 6 }, "a V/F draft of 3 changes on 2 units adds up");
  syncPending(store);
  assert.deepEqual(store.get().pending, { changes: 5, units: 4 });
  const reqs = pendingBarReview(store);
  assert.deepEqual(reqs.map((r) => r.kind), ["power", "runtime"]);
  assert.deepEqual(got[0].requests, reqs, "one tune:review with the runtime requests");
  assert.equal(store.get().tune.reviewSeq, 1);
  discardDraft(store);
  assert.deepEqual(store.get().rt.edits, { power: {}, caps: {}, uncore: {} });
  assert.deepEqual(store.get().pending, { changes: 0, units: 0 });
  pendingBarReview(store);
  assert.equal(got.length, 2);
  assert.deepEqual([got[1].changes, got[1].units, got[1].requests], [0, 0, undefined], "without runtime edits the event is the old {changes, units}");
});

test("no policy anywhere: the sources of the UI carry no policy wording in their code strings", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const UI = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) {
        if (!["tests", "fixtures", "icons"].includes(n)) walk(f);
      } else if (/\.(js|html)$/.test(n)) files.push(f);
    }
  };
  walk(UI);
  files.push(join(UI, "fixtures", "mock-backend.js"), join(UI, "fixtures", "mock-backend-g217.js"), join(UI, "fixtures", "mock-backend-g218.js"));
  assert.ok(files.length > 30);
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "").replace(/\/\*.*?\*\//g, "");
      if (/polic/i.test(code) && !/POLICY_RANGE/.test(code)) hits.push(f.slice(UI.length) + ":" + (i + 1));
    });
  }
  assert.deepEqual(hits, [], "policy wording in code: " + hits.join(", "));
});

// ---- G-233: show the ratio E-cores actually run (kernel kHz is one bin high) ----
const eRow = (cpu, unit, capKhz, eff) => ({ cpu, kind: "E", unit, online: true, cpufreq: { cpuinfo_max_khz: 4900000, cap_khz: capKhz, min_khz: 800000, cap_ratio: capKhz / 1e5, cap_ratio_effective: eff, max_ratio_effective: 48, ratio_model: "measured" } });

test("G-233: capRows uses the helper's effective ratio (stock E 4900000 is 48x, a 4700000 cap is 46x), kHz stays the kernel's", () => {
  const read = { caps: [eRow(8, "EC0", 4900000, 48), eRow(9, "EC0", 4900000, 48), eRow(24, "EC3", 4700000, 46)] };
  const [ec0, ec3] = capRows(read);
  assert.equal(ec0.capRatio, 48);
  assert.equal(ec0.maxRatio, 48);
  assert.equal(ec0.capKhz, 4900000);
  assert.equal(ec3.capRatio, 46, "the cap input after an apply shows 46, not 47");
  assert.equal(ec3.mixedCap, false);
  const rt = readyRt();
  rt.runtime = { state: "ready", result: read, error: null, at: null };
  rt.edits.caps = { EC3: 46 };
  assert.equal(runtimeRequest(rt).intent, null, "46x is what runs: nothing to apply");
  // a helper without the effective fields: kHz / 100000 as before
  const old = capRows({ caps: [{ cpu: 8, kind: "E", unit: "EC0", online: true, cpufreq: { cpuinfo_max_khz: 4900000, cap_khz: 4900000 } }] });
  assert.equal(old[0].capRatio, 49);
});

test("G-233: no E label shows 49 for a stock 4900000 E-core (plan view, revert, topology, Overview units)", () => {
  const rv = runtimeView({ steps: [
    { n: 1, domain: "caps", key: "cpu8", file: "cpu8/cpufreq/scaling_max_freq", before: 4700000, value: 4900000, ratio: 48, before_ratio: 46, expect: [4850000, 4950000] },
    { n: 2, domain: "caps", key: "cpu24", file: "f", before: 4900000, value: 4700000, ratio: 46, before_ratio: 48 },
  ] });
  assert.equal(rv.units[0].lines[0], "max 46× → 48× (kernel 4900 MHz)");
  assert.equal(rv.units[1].lines[0], "max 48× → 46× (kernel 4700 MHz)");
  assert.equal(rv.steps[0], "write cpu8/cpufreq/scaling_max_freq = 4900000 kHz (48×)");
  assert.ok(!JSON.stringify(rv).includes("49×"));
  const rows = topologyRows({ units: [{ id: "EC0", kind: "E", cpus: [8, 9, 10, 11], max_ratio: 48, max_khz: 4900000, perf: 68, favored: false }, { id: "P1", kind: "P", cpus: [2], max_ratio: 55, max_khz: 5500000, perf: 88, favored: false }] });
  assert.equal(rows[0].maxRatio, "48× (kernel 4900 MHz)");
  assert.equal(rows[1].maxRatio, "55×");
  const m = overviewRows({ units: [{ id: "EC0", kind: "E", cpus: [8], favored: false, max_ratio: 48, max_khz: 4900000 }] }, null); // R-S4: the Overview unit table replaced the core map
  assert.equal(m[0].top, 48);
  assert.equal(m[0].maxKhz, 4900000);
});

// ---- G-234 ----
test("G-234: revertReason: only a read that says 'nothing journaled' turns Revert off; unread / unreadable stays usable", () => {
  const rt = initialRt();
  assert.match(revertReason(rt, "runtime"), /Not read yet/);
  assert.match(revertReason({ ...rt, power: { ...rt.power, state: "reading" } }, "power"), /Reading/);
  assert.equal(revertReason({ ...rt, runtime: { ...rt.runtime, state: "error", error: "x" } }, "runtime"), "", "the plan answers");
  const rd = (key, result) => ({ ...rt, [key]: { ...rt[key], state: "ready", result } });
  assert.match(revertReason(rd("runtime", { journal: null }), "runtime"), /Nothing to revert/);
  assert.match(revertReason(rd("runtime", { journal: { caps: {}, uncore: {}, in_flight: false } }), "runtime"), /Nothing to revert/);
  assert.equal(revertReason(rd("runtime", { journal: { caps: {}, uncore: { max_ratio: 40 } } }), "runtime"), "");
  assert.equal(revertReason(rd("runtime", { journal: { caps: { 0: 5700000 }, uncore: {} } }), "runtime"), "");
  assert.equal(revertReason(rd("runtime", { journal: null, note: "the runtime journal is unusable" }), "runtime"), "", "unreadable journal: the plan decides");
  assert.match(revertReason(rd("power", { boot: null }), "power"), /Nothing to revert/);
  assert.equal(revertReason(rd("power", { boot: { pl1_w: 250 } }), "power"), "");
});

test("G-234: a finished revert drops the pending edits of its kind even when the read-back table does not match; a forward apply keeps them then", async () => {
  const b = await mockBridge();
  const store = createAppStore();
  ensureRt(store);
  const summary = (o) => ({ complete: true, allMatch: false, ...o });
  editRt(store, (e) => ({ ...e, caps: { P0: 50 }, uncore: { max_ratio: 38 } }));
  await RUNTIME_KIND.afterApply({ store, bridge: b, section: { intent: { caps: { 0: 50 } } }, summary: summary({}) });
  assert.deepEqual(store.get().rt.edits.caps, { P0: 50 }, "a forward apply that did not match keeps the edit");
  await RUNTIME_KIND.afterApply({ store, bridge: b, section: { intent: { revert: true } }, summary: summary({ complete: false }) });
  assert.deepEqual(store.get().rt.edits.caps, { P0: 50 }, "an incomplete revert keeps it");
  await RUNTIME_KIND.afterApply({ store, bridge: b, section: { intent: { revert: true } }, summary: summary({}) });
  assert.deepEqual([store.get().rt.edits.caps, store.get().rt.edits.uncore], [{}, {}]);
  assert.equal(store.get().rt.runtime.state, "ready", "and the fields are re-read");
});

// ---- G-244: the read-only PL4 row (MSR 0x601, throttling.md section G) ----
import { pl4Display } from "../views/tune/power.js";
import { HINTS } from "../lib/hints.js";
import { LIMIT_BITS } from "../store.js";

test("G-244: pl4Display shows watts and lock state, and stays unavailable when not read", () => {
  assert.equal(HINTS["power.pl4"].term, "PL4 · MSR 0x601");
  assert.match(HINTS["power.pl4_copy"].line, /peak_power/);
  assert.match(HINTS["power.pl4_copy"].line, /not enforced/);
  assert.match(HINTS["power.pl4"].more.join(" "), /never changes it/);
  const ok = pl4Display({ pl4: { status: "ok", value: { watts: 425, locked: false, raw: 0xd48 }, unit: "W" } });
  assert.deepEqual([ok.text, ok.locked], ["425 W · unlocked", false]);
  assert.equal(pl4Display({ pl4: { status: "ok", value: { watts: 425.125, locked: true, raw: 0x80000d49 } } }).text, "425.125 W · locked");
  const na = pl4Display({ pl4: { status: "unavailable", value: null, reason: "no MSR access" } });
  assert.deepEqual([na.text, na.locked, na.note], ["n/a", null, "no MSR access"]);
  assert.equal(pl4Display(null).text, "n/a");
  assert.equal(pl4Display({}).text, "n/a");
});

test("G-244: 0x64F bit 8 is relabelled PL4 predicted-peak trip, key unchanged", () => {
  assert.equal(LIMIT_BITS[8].key, "other");
  assert.equal(LIMIT_BITS[8].label, "Other (electrical) \u2014 PL4 predicted-peak trip on ARL-S");
  assert.equal(LIMIT_BITS[8].group, "current");
});
