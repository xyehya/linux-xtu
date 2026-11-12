// node --test desktop/app/ui/tests/   (G-252: every screen says each thing once — Overview, Review sheet, Profiles, Stress, Audit, System, Curves. One test per approved change; each
// failed before the change. Fake DOM, mock bridge; no browser, no helper, no hardware. The confirmation dialog's words are held by confirm.rs and contract.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { install, text } from "./fakedom.mjs";

const doc = install();
const { Bridge } = await import("../bridge.js");
const { createAppStore, setLink, setPreflight, applyHelperEvent, setThrottleEvents } = await import("../store.js");
const { createMockTransport, FIXTURES: MOCK_FIX } = await import("../fixtures/mock-backend.js");
const { wrapMockTransport } = await import("../fixtures/mock-backend-g218.js");
const { createWorkHead } = await import("../components/workhead.js");
const { modelFromRead } = await import("../lib/units.js");
const { HINTS } = await import("../lib/hints.js");
const D = await import("../views/dashboard.js");
const P = await import("../views/profiles.js");
const ST = await import("../views/stress.js");
const AU = await import("../views/audit.js");
const SY = await import("../views/system.js");
const CV = await import("../views/curves.js");
const { A, READ, rig: applyRig, review } = await import("./g242.rig.mjs");

const pre = MOCK_FIX.preflight.result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

async function dashRig() {
  const bridge = new Bridge(wrapMockTransport(createMockTransport({ intervalMs: 10_000 }), { stepMs: 1, seed: "recorded" }), "mock");
  const store = createAppStore();
  setLink(store, await bridge.connect());
  setPreflight(store, pre);
  const gotos = [];
  const ctx = { store, bridge, head: { set: () => {} }, goto: (s, t) => gotos.push([s, t]), toast: () => {} };
  const root = doc.createElement("main");
  doc.body.append(root);
  return { bridge, store, ctx, root, gotos };
}

const FAST = { intervalMs: 5, stepMs: 1, applyMode: null, profiles: null, accept: null, fingerprint: null, confirmMs: 1 };
async function mountView(view, opts = {}) {
  const bridge = new Bridge(createMockTransport({ ...FAST, ...opts }), "mock");
  const store = createAppStore();
  setLink(store, await bridge.connect());
  const p = await bridge.call("preflight");
  if (p.ok) setPreflight(store, p.result);
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const gotos = [];
  const ctx = { store, bridge, toast: () => {}, head: createWorkHead(headEl), goto: (s, t) => gotos.push([s, t]), drawer: null };
  view.mount(root, ctx);
  return { root, headEl, store, bridge, ctx, view, gotos };
}

// ================================================================ Overview
test("item 1: the Overview State panel is gone: nothing the top bar already says (accepted, last read, Undervolt Protection, mailbox) is repeated; the last quick screen is one footer line of the units", async () => {
  const { ctx, root, gotos } = await dashRig();
  const v = D.dashboardView();
  v.mount(root, ctx);
  for (const id of ["#ov-accepted", "#ov-lastread", "#ov-uvp", "#ov-mbx", "#ov-to-profiles"]) assert.equal($(root, id), null, id);
  assert.doesNotMatch(text($(root, "#ov")), /Undervolt Protection|Mailbox requests|Accepted state|Last read/);
  const foot = $(root, "#ov-units-panel #ov-state");
  assert.ok(foot, "the quick-screen line sits in the units panel");
  assert.match(text(foot), /^Last quick screen: /);
  $(root, "#ov-to-stress").click();
  assert.deepEqual(gotos.pop(), ["stress", undefined]);
  v.unmount();
  root.remove();
});

test("item 2: identical consecutive throttle events are one line with a count, the time span and the peaks; a single event keeps its full line", () => {
  const ev = (t, group, label, w, c) => ({ t_on: t, t_off: t + 1, group, label, dur_ms: 1000, duty: 0.09, peak_pkg_w: w, peak_temp_c: c, bits: [] });
  // newest first, as the list shows them
  const list = [
    ev(1_700_005_000, "current", "Current / PL4 (electrical)", 114, 70),
    ev(1_700_004_000, "current", "Current / PL4 (electrical)", 108, 60),
    ev(1_700_003_000, "power", "Power limit", 96, 41),
    ev(1_700_002_000, "power", "Power limit", 64, 40),
    ev(1_700_001_000, "power", "Power limit", 86, 68),
    ev(1_700_000_000, "current", "Current / PL4 (electrical)", 79, 38),
  ];
  const lines = D.eventLines(list);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.n), [2, 3, 1]);
  assert.match(lines[0].text, /^Current \/ PL4 \(electrical\) held the clock · ×2 · \d\d:\d\d:\d\d–\d\d:\d\d:\d\d · peak 114 W, 70 °C \(max\)$/);
  assert.match(lines[1].text, /^Power limit held the clock · ×3 · \d\d:\d\d:\d\d–\d\d:\d\d:\d\d · peak 96 W, 68 °C \(max\)$/);
  assert.match(lines[2].text, /^Current \/ PL4 \(electrical\) held the clock for 1\.0 s, 9 % of the time · peak 79 W, 38 °C$/, "a lone event keeps its sentence");
  assert.deepEqual(D.eventLines([{ unparsable: "x" }, { unparsable: "y" }]).map((l) => l.bad), [true, true], "unreadable lines never merge");
});

test("item 2 (view): the events table shows the collapsed lines", async () => {
  const { store, ctx, root } = await dashRig();
  const v = D.dashboardView();
  v.mount(root, ctx);
  const rec = (n) => ({ t_on: 1_700_000_000 + n * 100, t_off: 1_700_000_050 + n * 100, group: "power", label: "Power limit", dur_ms: 1000, duty: 0.1, peak_pkg_w: 90 + n, peak_temp_c: 60 });
  setThrottleEvents(store, { state: "ok", records: [rec(1), rec(2), rec(3)], error: null });
  assert.equal($$(root, "#ov-events tr[data-event]").length, 1);
  assert.match(text($(root, "#ov-events")), /Power limit held the clock · ×3 · .* · peak 93 W, 60 °C \(max\)/);
  v.unmount();
  root.remove();
});

test("item 3: the units table's 'Top ×' is the core's own top ratio: its OC ratio if set, else its fused maximum (P0/P3 57, others 55, E 47 OC)", () => {
  const model = modelFromRead(structuredClone(READ));
  const topo = { units: [
    { id: "P0", kind: "P", cpus: [0], favored: true, max_ratio: 57 }, { id: "P1", kind: "P", cpus: [1], max_ratio: 57 },
    { id: "EC0", kind: "E", cpus: [8, 9, 10, 11], max_ratio: 46 },
  ] };
  // a model where P1's favored ratio is 55 and EC0 has an OC ratio 47
  model.units.P0 = { ...model.units.P0, favored: 57, fused: { ratio: 57 } };
  model.units.P1 = { ...model.units.P1, favored: 55, fused: { ratio: 57 } };
  model.units.EC0 = { ...model.units.EC0, oc: { ratio: 47, v_target_v: 1.097, offset_mv: 0, word: "" } };
  const rows = D.overviewRows(topo, null, model);
  assert.deepEqual(rows.map((r) => [r.id, r.top]), [["P0", 57], ["P1", 55], ["EC0", 47]]);
  assert.equal(D.overviewRows(topo, null).find((r) => r.id === "P1").top, 57, "without a Tune read the kernel's max ratio stands in");
  assert.deepEqual(D.unitTop(null, null), null);
  assert.deepEqual(D.unitTop({ kind: "P", oc: { ratio: 58 }, favored: 57, fused: { ratio: 57 }, points: [] }, 55), { ratio: 58, oc: true });
});

test("item 3 (view): the column is headed 'Top ×' and the panel meta no longer repeats the group header counts", async () => {
  const { ctx, root } = await dashRig();
  const v = D.dashboardView();
  v.mount(root, ctx);
  const th = $(root, "#ov-units th[data-col=top]");
  assert.match(text(th), /^Top\s*×$/);
  assert.equal(text($(root, "#ov-units-panel .lx-band-m")), "", "no '8 P-cores · 4 E-clusters' next to a 'P-CORES 8' header");
  v.unmount();
  root.remove();
});

test("item 4: the Limits now meta says 'last 1 s'; the register is a tooltip", async () => {
  const { store, ctx, root } = await dashRig();
  const v = D.dashboardView();
  v.mount(root, ctx);
  const word = (raw) => ({ value: { raw, status: [], log: [], unknown_bits: [] }, status: "ok", unit: "", source: "msr 0x64F" });
  applyHelperEvent(store, "telemetry", { t: 1, values: { cores: {}, throttle: { word: word(0), window: { samples: 10, window_s: 1, duty: {}, bit_duty: {}, source: "msr 0x64F status bits, oversampled" } } } });
  const meta = text($(root, "#ov-limits-panel .lx-band-m"));
  assert.doesNotMatch(meta, /msr|0x64F|oversampled/);
  assert.match(meta, /^last 1 s$|^n\/a/, meta);
  v.unmount();
  root.remove();
});

test("item 5: Memory drops tRFC / tREFI and a clock that only restates the rate; the controller count is a tooltip", () => {
  const r = { available: true, mts: 7200, gear: 2, cmd_rate: "2T", timings: { tCL: 36, tRCD: 44, tRP: 44, tRAS: 96, tRFC: 574, tREFI: 32767 }, qclk_mhz: 3600, bclk_mhz: 100, max_bandwidth_mbs: 115200, cross_check: { agree: true }, instances_ok: 6, dimms: [{ locator: "A1" }, { locator: "B1" }] };
  const m = D.memModel(r);
  assert.deepEqual(m.rows.map((x) => x[0]), ["BCLK", "Peak bandwidth", "Cross-check"]);
  assert.equal(m.headline, "DDR5-7200 · Gear 2 · 2T");
  assert.equal(m.primary, "36-44-44-96");
  assert.equal(m.summary, "2 modules");
  assert.equal(m.summaryTitle, "read from 6 controller instances");
  assert.deepEqual(D.memModel({ ...r, mts: 6400, qclk_mhz: 3000 }).rows.map((x) => x[0]), ["Memory clock", "BCLK", "Peak bandwidth", "Cross-check"], "a clock that says more than the rate stays");
});

test("item 6: one meaning for the unit clock: the fastest CPU of the unit, in the code and in both hints", () => {
  const leaf = (v) => ({ value: v, status: "ok", unit: "MHz" });
  const live = D.unitLive({ cores: { 8: { mhz: leaf(4000) }, 9: { mhz: leaf(4600) }, 10: { mhz: leaf(4200) } } }, [8, 9, 10]);
  assert.equal(live.mhz, 4600);
  assert.match(HINTS["overview.clock"].line, /fastest/);
  assert.match(HINTS["unit.clock"].line, /fastest/);
  assert.doesNotMatch(HINTS["overview.clock"].line, /[Mm]ean/);
});

// ================================================================ Review sheet
test("item 7: the Effect 'Writes' line is plain words; the subtitle and the 'plan ready' tag are gone; the button says 'Apply N write(s)' without the +1", async () => {
  const r = await applyRig();
  await review(r);
  const body = text($(r.root, "#drawer-body"));
  const plan = r.store.get().apply.sections[0].plan;
  assert.match(body, /\n?Writes\s*1 write: P0 point 5, [−+]?[\d.]+ → [−+]?[\d.]+ mV/);
  if (A.planConditional(plan)) assert.match(body, /\(\+1 setup write if per-core voltage control is off\)\. Each write is read back\./);
  assert.match(body, /How to undo\s*Restore accepted, or a cold boot\./);
  assert.doesNotMatch(body, /V\/F & ratios|each one sent alone|mailbox write/);
  assert.equal($(r.root, "#apply-tag"), null, "no tag for a plan that is ready");
  const go = text($(r.root, "#apply-go"));
  assert.match(go, /^Apply 1 write/);
  assert.doesNotMatch(go, /if needed/);
  r.applyDrawer.dispose();
});

test("item 7: other states keep their tag (confirming)", async () => {
  const r = await applyRig();
  await review(r);
  r.store.update((s) => ({ apply: { ...s.apply, state: "confirming" } }));
  assert.equal(text($(r.root, "#apply-tag")), "confirming");
  r.applyDrawer.dispose();
});

test("item 7 (pure): writeItems / writesLine say what is written in words", () => {
  assert.equal(A.arrowText("−49.8 mV", "−54.7 mV"), "−49.8 → −54.7 mV");
  assert.equal(A.arrowText("55×", "58×"), "55× → 58×");
  const plan = { writes: 2, conditional_writes: 1, steps: [
    { kind: "write_percore_enable", conditional: true }, { kind: "write_vf_point", unit: "P0", point: 5 }, { kind: "write_msr", table: "p" },
  ], before: { P0: { 5: { ratio: 53, offset_mv: -49.8 } } }, after: { P0: { 5: { ratio: 53, offset_mv: -54.7 } } }, units: ["P0"] };
  const w = A.writeItems({ plan });
  assert.equal(w.items[0], "P0 point 5, −49.8 → −54.7 mV");
  assert.equal(w.items[1], "turbo P table");
  assert.equal(A.writesLine([{ items: ["P0 point 5, −49.8 → −54.7 mV"], certain: 1, setup: 1 }]), "1 write: P0 point 5, −49.8 → −54.7 mV (+1 setup write if per-core voltage control is off). Each write is read back.");
  assert.equal(A.writesLine([{ items: [], certain: 0, setup: 1 }]), "1 setup write, only if per-core voltage control is off. Each write is read back.");
  const many = A.writesLine([{ items: ["a", "b", "c", "d", "e", "f"], certain: 6, setup: 0 }]);
  assert.match(many, /^6 writes: a; b; c; d; and 2 more \(listed above\)\./);
  assert.equal(A.writeItems({ plan: { ...plan, steps_truncated: true } }), null, "a cut step list says only the count");
});

// ================================================================ Profiles
test("item 9: 'Apply on Windows' is a disclosure, closed by default", async () => {
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => !!$(m.root, "[data-pr=windows-details]")), true);
  const d = $(m.root, "[data-pr=windows-details]");
  assert.ok(!d.open && !d.hasAttribute("open"), "closed");
  assert.equal(text($(d, "summary")), "Apply on Windows");
  assert.ok($(d, "[data-pr=windows]"), "the steps are inside it");
  m.view.unmount();
});

test("item 10: boot restore is a state word and a button that copies the command, not the raw sudo line", async () => {
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => !!$(m.root, "[data-pr=boot-enable]")), true);
  assert.equal(text($(m.root, "[data-pr=boot-restore]")), "Boot restore: off");
  assert.doesNotMatch(text($(m.root, "#pr-accepted")), /sudo/);
  const btn = $(m.root, "[data-pr=boot-enable]");
  assert.equal(text(btn), "Enable boot restore…");
  assert.equal(P.bootRestoreLine({ boot_restore: { state: "disarmed" } }).cmd, P.BOOT_ENABLE_CMD, "the button copies the one command");
  btn.click();
  assert.equal(await until(() => /copied|Could not copy/.test(text($(m.root, "[data-pr=boot-note]")))), true);
  m.view.unmount();
});

test("item 11: Contents omit 'Whole curve 0 mV'; the list has no Units or Ring pts columns; 'accepted' is the tag, not repeated in the Contents header", async () => {
  const zero = P.profileSections({ rows: [{ target: "P0", layers: { curve_mv: 0, points_mv: { 53: -20 } } }, { target: "P1", layers: { curve_mv: 0, points_mv: {} } }] });
  const u = zero.find((s) => s.key === "rows");
  assert.equal(u.hasCurve, false);
  assert.equal(u.rows[0].curve, "—");
  const some = P.profileSections({ rows: [{ target: "P0", layers: { curve_mv: -10, points_mv: {} } }, { target: "P1", layers: { curve_mv: 0 } }] }).find((s) => s.key === "rows");
  assert.equal(some.hasCurve, true);
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => !!$(m.root, "#pr-contents [data-section=rows] table")), true);
  assert.doesNotMatch(text($(m.root, "#pr-contents [data-section=rows] thead")), /Whole curve/);
  const heads = $$(m.root, "#pr-list thead th").map((t) => text(t));
  assert.deepEqual(heads, ["Name", "Tags", "Saved", "DeepestmV", "Turbo", "Runtime"]);
  assert.doesNotMatch(text($(m.root, "#pr-contents .lx-band-m")), /accepted/);
  assert.ok($$(m.root, "#pr-list .lx-tag").some((t) => text(t) === "accepted"), "the tag says it once");
  m.view.unmount();
});

test("item 12: Compare starts on the accepted (or newest) profile against 'CPU now', never a profile against itself", async () => {
  const list = [{ name: "q1", source: "accepted" }, { name: "q1", source: "saved", created: "2026-11-12T10:00:00Z" }, { name: "b", source: "saved", created: "2026-11-11T10:00:00Z" }];
  assert.deepEqual(P.compareDefaults(list), { a: "accepted", b: "read" });
  assert.deepEqual(P.compareDefaults(list, "q1", "saved"), { a: "accepted", b: "read" }, "the saved twin of the accepted state is the accepted state");
  assert.deepEqual(P.compareDefaults(list, "b", "saved"), { a: "b", b: "read" });
  assert.deepEqual(P.compareDefaults([{ name: "old", source: "saved", created: "2026-01-01T00:00:00Z" }, { name: "new", source: "saved", created: "2026-02-01T00:00:00Z" }]), { a: "new", b: "read" }, "no accepted state: the newest profile");
  assert.equal(P.refOf(list, "q1", "saved"), "accepted");
  assert.deepEqual(P.compareRefs(list).map((r) => r.value), ["accepted", "read", "b"], "the twin is not offered twice");
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => !!$(m.root, "[data-pr=compare-a]") && $(m.root, "[data-pr=compare-a]").value !== ""), true);
  const a = $(m.root, "[data-pr=compare-a]").value;
  const b = $(m.root, "[data-pr=compare-b]").value;
  assert.equal(a, "accepted");
  assert.equal(b, "read");
  assert.notEqual(a, b);
  m.view.unmount();
});

// ================================================================ Stress
test("item 13: what a run tests is said once, in Setup; Live does not repeat it", async () => {
  const m = await mountView(ST.stressView());
  assert.match(text($(m.root, "#st-tested")), /what the CPU holds now/);
  assert.equal(text($(m.root, "#st-testing")), "");
  m.view.unmount();
});

test("item 14: 'State tested' says accepted state / the state now / another state; the hash is a tooltip", () => {
  const r = { state_fingerprint: "8370e84b11112222" };
  assert.equal(ST.testedText(r, "8370e84b11112222", true), "accepted state");
  assert.equal(ST.testedText(r, "8370e84b11112222", false), "the state now");
  assert.equal(ST.testedText(r, "ffffffffffffffff", false), "another state");
  assert.doesNotMatch(ST.testedText(r, "8370e84b11112222", true), /8370e84b/);
  assert.equal(ST.testedTitle(r), "state 8370e84b");
});

test("item 14 (view): the history cell carries the hash as its tooltip", async () => {
  const m = await mountView(ST.stressView());
  const fp = "8370e84b11112222";
  await sleep(20);
  m.bridge.call = async (op) => (op === "stress.list" ? { ok: true, result: { state_fingerprint: fp, results: [{ id: "r1", started: "2026-11-12T10:47:00Z", kind: "cpu", method: "integer", duration_s: 60, elapsed_s: 60, errors: 0, health: "clean", stopped_by: "time", max_temp_c: 60, max_pkg_w: 100, units: "all", state_fingerprint: fp }, { id: "r2", started: "2026-11-12T09:47:00Z", kind: "cpu", method: "integer", duration_s: 60, elapsed_s: 60, errors: 0, health: "clean", stopped_by: "time", state_fingerprint: "00000000aaaa" }] } } : { ok: false, error: { message: "n/a" } });
  m.ctx.goto = () => {};
  const refresh = $(m.root, "#btn-stress-refresh");
  refresh.click();
  assert.equal(await until(() => $$(m.root, "#st-hist-body tr").length === 2), true);
  const cells = $$(m.root, "#st-hist-body tr").map((tr) => tr.lastChild);
  assert.deepEqual(cells.map((c) => text(c)), ["the state now", "another state"]);
  assert.equal(cells[0].getAttribute("title"), "state 8370e84b");
  m.view.unmount();
});

// ================================================================ Audit
test("item 15: Audit starts on Changes, has no Took column, and keeps 'N records loaded' and the log path in the footer's tooltip", async () => {
  const m = await mountView(AU.auditView());
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length > 0 || /operation|No operation/.test(text($(m.root, "#audit-panel .lx-band-m")))), true);
  assert.equal($(m.headEl, "#audit-filter [data-value=changes]").getAttribute("aria-pressed"), "true");
  assert.doesNotMatch(text($(m.root, "#audit-table thead")), /Took/);
  assert.doesNotMatch(text($(m.root, "#audit-panel .lx-band-m")), /records loaded/);
  const foot = $(m.root, "#audit-foot span");
  assert.ok(foot, "the footer line");
  assert.doesNotMatch(text(foot), /audit\.jsonl|records loaded/);
  assert.match(foot.getAttribute("title"), /\d+ records? loaded/);
  m.view.unmount();
});

// ================================================================ System
test("item 16: System repeats nothing of the top bar (link, mailbox count, last read), has no Hints switch, no boot-restore panel; it links to Profiles", async () => {
  const m = await mountView(SY.systemView());
  assert.equal(await until(() => /App version/.test(text($(m.root, "#sys-helper")))), true);
  assert.doesNotMatch(text($(m.root, "#sys-helper")), /Link|Helper state|Mailbox requests|Last read|Last telemetry/);
  assert.equal($(m.root, "#sys-hints"), null);
  assert.equal($(m.root, "#sys-boot"), null);
  const go = $(m.root, "#sys-boot-go");
  assert.equal(go.parentNode.hidden, false, "the pre-flight carries boot_restore, so the link shows");
  go.click();
  assert.deepEqual(m.gotos.pop(), ["profiles", undefined]);
  m.view.unmount();
});

// ================================================================ Curves
test("item 17: the chart's X axis is the ratio (×); the cursor readout leads with it; the notes are separate short lines and VID is behind a ?", async () => {
  assert.deepEqual(CV.readoutParts({ ymode: "v", series: [{ key: "a", unit: "P0", pts: [{ mhz: 5600, v: 1.3 }] }] }, 5600)[0], ["", "56× · 5600 MHz"]);
  const m = await mountView(CV.curvesView());
  const ctl = CV.curvesController(m.ctx);
  assert.equal(await until(() => ctl.cv.loaded && ctl.cv.list.length > 0 && !!ctl.primaryRec()), true);
  ctl.paint();
  await sleep(20);
  const chart = $(m.root, "#cv-chart");
  assert.match(text(chart), /Ratio ×/);
  assert.doesNotMatch(text(chart), /MHz · ratio|ratio = MHz/);
  assert.ok($(m.root, "#cv-base-note"), "the baseline line");
  assert.doesNotMatch(text($(m.root, "#cv-base-note")), /Requested voltage \(VID\)/);
  assert.ok($(m.root, "#cv-note-row .lx-q"), "VID is behind a ? expander");
  assert.match(HINTS["curves.vid"].line, /Requested voltage|requested|asks for/i);
  const parts = $$(m.root, "#cv-unreach .lx-tfoot-note").map((t) => text(t));
  for (const t of parts) assert.doesNotMatch(t, / · .* · /, "one thing per line");
  m.view.unmount();
});
