// node --test desktop/app/ui/tests/   (G-244, QA 2026-11-12: Profiles + Stress. Evidence only for the state that ran (QA-23), the Stress state time (QA-21), no helper message in the
// empty state (QA-25), header count and one announcement (QA-27), one row for the accepted state and its saved twin (QA-28), tau like Tune (QA-38), the boot-restore line (QA-35),
// and the layout rules (QA-24). Fake DOM + the mock bridge; no browser, no helper, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { install, text } from "./fakedom.mjs";

const doc = install();
const FIX = (await import("../fixtures/fixtures.js")).default;
const { Bridge } = await import("../bridge.js");
const { createMockTransport } = await import("../fixtures/mock-backend.js");
const { createAppStore, setLink, setPreflight, setLastRead } = await import("../store.js");
const { createWorkHead } = await import("../components/workhead.js");
const P = await import("../views/profiles.js");
const ST = await import("../views/stress.js");
const { fmtLocalDateTime: fl } = await import("../lib/format.js"); // G-248 (QA-34): evidence and saved times are local

const UI = fileURLToPath(new URL("..", import.meta.url));
const FAST = { intervalMs: 5, stepMs: 1, applyMode: null, profiles: null, accept: null, fingerprint: null, confirmMs: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

/** A mounted view on the mock bridge; `override(op, args)` may answer an op itself (return undefined to let the mock answer). */
async function mountView(view, { override = null, preflight = null, ...opts } = {}) {
  const bridge = new Bridge(createMockTransport({ ...FAST, ...opts }), "mock");
  const calls = [];
  const call = bridge.call.bind(bridge);
  bridge.call = async (op, args = {}) => {
    calls.push({ op, args });
    const o = override ? override(op, args) : undefined;
    return o !== undefined ? o : call(op, args);
  };
  const store = createAppStore();
  setLink(store, await bridge.connect());
  const pre = await call("preflight");
  if (pre.ok) setPreflight(store, preflight ? preflight(pre.result) : pre.result);
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const toasts = [];
  const ctx = { store, bridge, toast: (kind, t) => toasts.push({ kind, t }), head: createWorkHead(headEl), goto: () => {}, drawer: null };
  view.mount(root, ctx);
  return { root, headEl, store, bridge, ctx, calls, toasts, view };
}

const SAVED = FIX["profiles-saved-list"].result.profiles;
const ok = (result) => ({ ok: true, result });

// ---------------------------------------------------------------- QA-28 / QA-27: the list model
test("listRows: the accepted state and the saved profile it was made from are ONE row, tagged both, with the saved time", () => {
  const list = [
    { name: "qa-1", source: "accepted", created: null, complete: true },
    { name: "qa-1", source: "saved", created: "2026-11-12T08:49:11Z", complete: true },
    { name: "other", source: "saved", created: "2026-11-11T08:00:00Z", complete: true },
    { name: "accepted-before-20261101-100000", source: "saved", created: "2026-11-01T10:00:00Z", complete: true },
  ];
  const rows = P.listRows(list);
  assert.deepEqual(rows.map((r) => [r.name, r.source, r.twin]), [["qa-1", "accepted", true], ["other", "saved", false], ["accepted-before-20261101-100000", "saved", false]]);
  assert.equal(rows[0].created, "2026-11-12T08:49:11Z", "the accepted row carries the saved time");
  // an accepted state with no saved twin stays one row, no saved time
  const solo = P.listRows([{ name: "read-1", source: "accepted", created: null, complete: true }]);
  assert.deepEqual(solo.map((r) => [r.name, r.twin, r.created]), [["read-1", false, null]]);
  // an older chain lists its members and merges nothing
  assert.equal(P.listRows([{ name: "a", source: "accepted", chain: true }, { name: "a", source: "saved", created: "x" }]).length, 2);
});

test("Profiles list: a saved + accepted profile of one name is one row; the header count equals the rows; tags follow the name", async () => {
  const list = { profiles: [{ name: "qa-20261112", source: "accepted", created: null, complete: true }, { name: "qa-20261112", source: "saved", created: "2026-11-12T08:49:11Z", complete: true }, ...SAVED.filter((p) => p.name !== "qa-20261112")], accepted: true };
  const m = await mountView(P.profilesView(), { override: (op) => (op === "profiles.list" ? ok(list) : undefined) });
  const n = list.profiles.length - 1;
  assert.equal(await until(() => $$(m.root, "[data-pr=list] tr[data-profile]").length === n), true);
  const rows = $$(m.root, "[data-pr=list] tr[data-profile]");
  assert.equal(rows.filter((r) => r.dataset.profile === "qa-20261112").length, 1, "one row for the name");
  const row = rows.find((r) => r.dataset.profile === "qa-20261112");
  assert.equal(row.dataset.source, "accepted");
  const tds = $$(row, "td");
  assert.match(text(tds[1]), /accepted/);
  assert.match(text(tds[1]), /saved/, "the tags sit next to the name");
  assert.match(text(tds[2]), /^Nov 12 \d\d:\d\d$/, "the saved time is shown, in local time (G-248: no UTC stamp)");
  assert.equal(text($(m.headEl, ".lx-head-sub")), `${n} profiles`);
  assert.match(text($(m.root, "#pr-list")), new RegExp(`${n} entries`));
  m.view.unmount();
});

test("Profiles header count follows the list after an Accept; one confirmation (the inline box), no toast on top", async () => {
  const m = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => $$(m.root, "[data-pr=list] tr[data-profile]").length > 0 && !$(m.root, "[data-pr=accept-read]").disabled), true);
  const before = $$(m.root, "[data-pr=list] tr[data-profile]").length;
  assert.equal(text($(m.headEl, ".lx-head-sub")), `${before} profiles`);
  $(m.root, "[data-pr=accept-read]").click();
  assert.equal(await until(() => !!$(m.root, "[data-pr=ask-yes]")), true);
  $(m.root, "[data-pr=ask-yes]").click();
  assert.equal(await until(() => /Accepted/.test(text($(m.root, "[data-pr=notice]")))), true);
  assert.equal(await until(() => m.calls.filter((c) => c.op === "profiles.list").length >= 2), true);
  await until(() => false, 60);
  const rows = $$(m.root, "[data-pr=list] tr[data-profile]").length;
  const sub = text($(m.headEl, ".lx-head-sub"));
  assert.equal(sub, `${rows} ${rows === 1 ? "profile" : "profiles"}`, "the header says what the list shows");
  assert.match(text($(m.root, "#pr-list")), new RegExp(`${rows} ${rows === 1 ? "entry" : "entries"}`));
  assert.deepEqual(m.toasts.filter((t) => /Accepted/.test(t.t)), [], "the accepted result is announced once");
  m.view.unmount();
});

// ---------------------------------------------------------------- QA-25
test("Profiles: the empty accepted state is the app's own copy; the helper's message text is nowhere on the screen", async () => {
  const RAW = "No accepted state yet: save a profile as accepted (Profiles). RAWHELPERTEXT";
  const m = await mountView(P.profilesView(), { override: (op) => (op === "profiles.list" ? ok({ profiles: [], accepted: false, note: RAW }) : undefined) });
  assert.equal(await until(() => !!$(m.root, "#pr-noaccepted") && !!$(m.root, "#pr-empty")), true);
  assert.doesNotMatch(text(m.root), /RAWHELPERTEXT|Helper:/);
  assert.match(text($(m.root, "#pr-noaccepted")), /No accepted state yet/);
  m.view.unmount();
});

// ---------------------------------------------------------------- QA-38
test("tau is formatted like Tune (64.0 s); the exact value is the tooltip", async () => {
  assert.equal(P.tauText(63.963136), "64.0 s");
  assert.equal(P.tauText(28), "28.0 s");
  const sec = P.profileSections({ version: 2, power: { pl1_w: 250, pl2_w: 250, tau_s: 63.963136 } }).find((x) => x.key === "power");
  const tau = sec.rows.find((r) => r[0] === "Time window tau");
  assert.equal(tau[1], "64.0 s");
  assert.match(tau[3], /63\.963136/);
});

// ---------------------------------------------------------------- QA-35
test("bootRestoreLine: nothing when the helper sends no field; 'off' with the enable command when not armed; 'on' when armed", () => {
  assert.equal(P.bootRestoreLine(null), null);
  assert.equal(P.bootRestoreLine({ checks: [] }), null);
  for (const state of ["disarmed", "not_installed"]) {
    const l = P.bootRestoreLine({ boot_restore: { state, note: "n" } });
    assert.equal(l.on, false);
    assert.equal(l.text + l.cmd, "Boot restore: off \u2014 sudo systemctl enable linux-xtu-restore.timer && sudo /usr/lib/linux-xtu/linux-xtu-restore arm", "R2-07: one command that enables AND arms");
  }
  assert.equal(P.bootRestoreLine({ boot_restore: { state: "armed" } }).text, "Boot restore: on");
  assert.equal(P.bootRestoreLine({ boot_restore: "disarmed" }).on, false);
});

test("Profiles accepted panel shows the boot-restore line from the preflight; says nothing without the field", async () => {
  const none = await mountView(P.profilesView(), { profiles: "accepted" });
  assert.equal(await until(() => /state|unit/.test(text($(none.root, "#pr-accepted"))) && !!$(none.root, "[data-pr=cpu-now]")), true);
  const { boot_restore: _br, ...noBoot } = none.store.get().preflight; // the fixture carries boot_restore (G-243): drop it to check the "absent" case
  setPreflight(none.store, noBoot);
  assert.equal(await until(() => $(none.root, "[data-pr=boot-restore]") === null), true);
  setPreflight(none.store, { ...none.store.get().preflight, boot_restore: { state: "disarmed", note: "timer installed, not enabled" } });
  assert.equal(await until(() => !!$(none.root, "[data-pr=boot-restore]")), true);
  assert.equal(text($(none.root, "[data-pr=boot-restore]")), "Boot restore: off \u2014 sudo systemctl enable linux-xtu-restore.timer && sudo /usr/lib/linux-xtu/linux-xtu-restore arm");
  setPreflight(none.store, { ...none.store.get().preflight, boot_restore: { state: "armed" } });
  assert.equal(await until(() => text($(none.root, "[data-pr=boot-restore]")) === "Boot restore: on"), true);
  none.view.unmount();
});

// ---------------------------------------------------------------- QA-23
test("evidenceOf: only a clean full-length screen that ran on the state now is evidence; another state and old records say why", () => {
  const clean = (fp, started = "2026-11-12T09:00:00Z") => ({ started, health: "clean", errors: 0, stopped_by: "time", elapsed_s: 60, kind: "cpu", ...(fp === undefined ? {} : { state_fingerprint: fp }) });
  const res = (now, ...results) => ({ ok: true, result: { state_fingerprint: now, results } });
  assert.equal(P.evidenceOf(res("aaaa", clean("aaaa"))).text, `${fl("2026-11-12T09:00:00Z")} · 1 min · cpu · clean, 0 errors`);
  assert.equal(P.evidenceOf(res("aaaa", clean("bbbb"), clean("aaaa", "2026-11-10T09:00:00Z"))).text, `${fl("2026-11-10T09:00:00Z")} · 1 min · cpu · clean, 0 errors`, "the newest run ON THIS STATE");
  assert.deepEqual(P.evidenceOf(res("aaaa", clean("bbbb"))), { text: "", note: P.EVIDENCE_OTHER_STATE });
  assert.match(P.EVIDENCE_OTHER_STATE, /^Evidence is from a different state/);
  assert.deepEqual(P.evidenceOf(res("aaaa", clean(undefined))), { text: "", note: P.EVIDENCE_NOT_RECORDED });
  assert.deepEqual(P.evidenceOf(res(null, clean("aaaa"))), { text: "", note: P.EVIDENCE_OTHER_STATE }, "no read now: nothing matches");
  assert.deepEqual(P.evidenceOf(res("aaaa", { ...clean("aaaa"), errors: 2 })), { text: "", note: "" }, "no clean screen at all");
});

test("Accept shows the evidence of the same state, and 'Evidence is from a different state' otherwise", async () => {
  const run = (fp) => ({ id: "20261112T090000Z-aaaa", kind: "cpu", started: "2026-11-12T09:00:00Z", health: "clean", errors: 0, stopped_by: "time", elapsed_s: 60, state_fingerprint: fp });
  for (const [runFp, want] of [["same", /1 min · cpu · clean, 0 errors/], ["other", /Evidence is from a different state/]]) {
    const m = await mountView(P.profilesView(), { profiles: "accepted", override: (op) => (op === "stress.list" ? ok({ results: [run(runFp)], state_fingerprint: "same" }) : undefined) });
    assert.equal(await until(() => !$(m.root, "[data-pr=accept-read]").disabled && $$(m.root, "tr[data-profile]").length > 0), true);
    $(m.root, "[data-pr=accept-read]").click();
    assert.equal(await until(() => !!$(m.root, "[data-pr=evidence]")), true);
    assert.match(text($(m.root, "[data-pr=evidence]")), want, runFp);
    m.view.unmount();
  }
});

// ---------------------------------------------------------------- Stress: QA-23 text, QA-21 time
test("testedText: the fingerprint is shown short, marked when it is the state now; records without it say 'state not recorded'", () => {
  assert.equal(ST.testedText({}), "state not recorded");
  assert.equal(ST.testedText({ state_fingerprint: "0123456789abcdef" }), "state 01234567");
  assert.equal(ST.testedText({ state_fingerprint: "0123456789abcdef" }, "0123456789abcdef"), "state 01234567 \u00b7 the state now");
  assert.equal(ST.testedText({ state_fingerprint: "0123456789abcdef" }, "ffff"), "state 01234567 \u00b7 changed since");
  assert.equal(ST.testedText({ state_fingerprint: null }), "state unknown (no read yet)");
});

test("Stress 'what the CPU holds now' uses the newer of the last read and the last change, and says which", () => {
  const base = { pending: { changes: 0 }, accepted: null };
  const fc = (iso) => new Date(iso).toTimeString().slice(0, 8);
  const read = "2026-11-12T10:34:09Z";
  const change = "2026-11-12T10:46:02Z";
  assert.equal(ST.testedModel({ ...base, lastReadAt: read }).line, `what the CPU holds now (read ${fc(read)})`);
  // an apply after the read: the older read time is NOT shown
  const afterApply = ST.testedModel({ ...base, lastReadAt: read }, { changedAt: change });
  assert.equal(afterApply.line, `what the CPU holds now (last change ${fc(change)})`);
  assert.doesNotMatch(afterApply.line, new RegExp(fc(read)));
  // the store's own apply time works too; a read after the change wins again
  assert.equal(ST.testedModel({ ...base, lastReadAt: read, lastApplyAt: change }).line, `what the CPU holds now (last change ${fc(change)})`);
  assert.equal(ST.testedModel({ ...base, lastReadAt: "2026-11-12T10:50:00Z" }, { changedAt: change }).line, `what the CPU holds now (read ${fc("2026-11-12T10:50:00Z")})`);
  // a change but no read this boot
  assert.equal(ST.testedModel(base, { changedAt: change }).line, `what the CPU holds now (last change ${fc(change)})`);
  assert.equal(ST.testedModel(base).line, "what the CPU holds now (not read this boot)");
});

test("Stress controller: the helper applying is a change of state; the label follows it, and a stress.list carries the state now", async () => {
  const handlers = {};
  const bridge = {
    on: (ev, fn) => (handlers[ev] = fn),
    wait: () => new Promise(() => {}),
    call: async (op) => (op === "stress.list" ? ok({ results: [{ id: "x", kind: "cpu", state_fingerprint: "fp1" }], state_fingerprint: "fp1" }) : op === "tune.last" ? ok({ available: true, applied_at: Date.now() / 1000 - 600, result: {} }) : { ok: false, error: { code: "X", message: "x" } }),
  };
  const store = createAppStore();
  setLastRead(store, new Date(Date.now() - 3600_000).toISOString(), null);
  setPreflight(store, { checks: [] });
  const ctl = ST.createStressController({ bridge, store });
  assert.match(ctl.tested(store.get()).line, /\(read \d\d:\d\d:\d\d\)/);
  await ctl.loadChange();
  assert.match(ctl.tested(store.get()).line, /\(last change \d\d:\d\d:\d\d\)/, "tune.last's applied_at is newer than the read");
  await ctl.loadList();
  assert.equal(ctl.view.stateNow, "fp1");
  // a later apply seen as a helper state event moves the time on
  const before = ctl.view.changedAt;
  await sleep(5);
  handlers.state({ op_id: "a1", state: "applying" });
  assert.ok(Date.parse(ctl.view.changedAt) > Date.parse(before));
  const t = ctl.view.changedAt;
  await sleep(5);
  handlers.state({ op_id: "a2", state: "planning" });
  assert.equal(ctl.view.changedAt, t, "planning is not a change");
});

test("Stress controller (final QA): after an app restart a power apply in the audit log still counts as the last change; a 0-write close does not", async () => {
  const tuneAt = Date.now() / 1000 - 3000;
  const powerAt = new Date(Date.now() - 600_000).toISOString();
  const later0 = new Date(Date.now() - 60_000).toISOString();
  const recs = [
    { event: "result", op: "tune.apply", ts: new Date(tuneAt * 1000).toISOString(), writes_sent: 1 },
    { event: "result", op: "power.apply", ts: powerAt, writes_sent: 1 },
    { event: "result", op: "restore-accepted", ts: later0, writes_sent: 0, outcome: "nothing-to-do" },
    { event: "result", cpu: 0, cmd: "0x10", ts: later0 },
  ];
  const bridge = {
    on: () => {},
    wait: () => new Promise(() => {}),
    call: async (op) => (op === "tune.last" ? ok({ available: true, applied_at: tuneAt, result: {} }) : op === "audit.tail" ? ok({ records: recs }) : { ok: false, error: { code: "X", message: "x" } }),
  };
  const store = createAppStore();
  setLastRead(store, new Date(Date.now() - 7200_000).toISOString(), null);
  setPreflight(store, { checks: [] });
  const ctl = ST.createStressController({ bridge, store });
  await ctl.loadChange();
  assert.equal(ctl.view.changedAt, new Date(Date.parse(powerAt)).toISOString(), "the power apply is newer than the tune apply; the 0-write restore is not a change");
});

// ---------------------------------------------------------------- QA-24: layout rules in the stylesheets
test("Profiles and Stress fill the window height; their panels scroll inside only when the content overflows", () => {
  const pr = readFileSync(UI + "styles/profiles.css", "utf8");
  const st = readFileSync(UI + "styles/stress.css", "utf8");
  assert.match(pr, /\.lx-pr\s*\{[^}]*height:\s*100%/);
  assert.match(pr, /\.lx-pr\s*\{[^}]*flex-direction:\s*column/);
  assert.match(pr, /\.lx-pr-split\s*\{[^}]*flex:\s*1 1/);
  assert.doesNotMatch(pr, /\.lx-pr-split > \.lx-panel\s*\{[^}]*max-height/, "no fixed cap that cuts the panels off mid-screen");
  assert.match(st, /\.lx-st\s*\{[^}]*height:\s*100%/);
  assert.match(st, /minmax\(11\.25rem,\s*1fr\)/); // G-248: 180 px as rem
});
