// node --test desktop/app/ui/tests/   (R-C3: the frame of desktop/DESIGN.md §4 on a small fake DOM — UI prefs and the read-only / reading gates in the
// store, the top bar (annunciators, ACCEPTED, Read with confirm-and-drop), the pending row (items, Discard all confirm, Review gate), the context line
// (data-hint, reasons, idle line, Hints on / Quiet), the readout bar (values, expand), the LIMITS popover (built once, focus survives a tick: F-10),
// the commit sheet shell (initial focus, Tab trap, Esc, focus return), the rail, the Tips screen, Tune's pending items and tab marks, app routing.
// Selectors are ids / data-* / roles, never lx- classes. No browser, no helper, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { install, key, fire, text } from "./fakedom.mjs";

const doc = install();
const store_ = await import("../store.js");
const {
  createAppStore, loadPrefs, setPref, cleanPrefs, PREFS_KEY, LEGACY_PREFS_KEY, migrateLegacyPrefs, reviewGate, editLock, readOnly, setPreflight, setLink, setPending, applyHelperEvent, openDrawer,
  closeDrawer, openTipsAt, setLastRead, setScreen,
} = store_;
const { createTopBar, writesAnn, helperPip, uvpAnn, acceptedText, readButtonModel, APP_NAME } = await import("../components/topbar.js");
const { createPendingBar, itemParts } = await import("../components/pending-bar.js");
const { createContextLine, describe } = await import("../components/context-line.js");
const { createReadout, readoutValue, READOUTS } = await import("../components/readout.js");
const { createLimits, limitAnnModel, LIMIT_ANNS } = await import("../components/throttle.js");
const { createSheet } = await import("../components/sheet.js");
const { createNavRail, SCREENS } = await import("../components/nav-rail.js");
const { createWorkHead } = await import("../components/workhead.js");
const { createToaster, toastParts } = await import("../components/toast.js");
const { layerCount } = await import("../components/layers.js");
const { tipsView, parseInline, renderBlock, SCREEN_TIP, GOTO_TAB } = await import("../views/tips.js");
const tune = await import("../views/tune.js");
const { routeFromHash, screenKey, keyAction } = await import("../app.js");
const { modelFromRead } = await import("../lib/units.js");
const draftLib = await import("../lib/draft.js");
const { TIPS } = await import("../lib/tips.js");
const { HINTS, SCREEN } = await import("../lib/hints.js");
const FIX = (await import("../fixtures/fixtures.js")).default;

const el = (tag = "div", id) => {
  const e = doc.createElement(tag);
  if (id) e.id = id;
  doc.body.append(e);
  return e;
};
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const connected = (store, writes = true) => {
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: writes, mode: "write", checks: writes ? [] : [{ name: "msr_allow_writes", status: "unknown", reason: "cannot read it" }] });
  return store;
};
const READ = FIX["tune-read"].result;

// ---------------------------------------------------------------- store: prefs and gates
test("prefs: defaults, persisted per key, unknown keys and values refused, a broken store falls back to defaults", () => {
  const s = createAppStore();
  assert.deepEqual(s.get().prefs, { hints: "on", readout: "line" });
  const mem = memStorage();
  assert.equal(setPref(s, "hints", "quiet", mem), true);
  assert.equal(setPref(s, "hints", "loud", mem), false);
  assert.equal(setPref(s, "colour", "red", mem), false);
  assert.deepEqual(JSON.parse(mem.getItem(PREFS_KEY)), { hints: "quiet", readout: "line" });
  const s2 = createAppStore();
  loadPrefs(s2, mem);
  assert.equal(s2.get().prefs.hints, "quiet");
  mem.setItem(PREFS_KEY, "{not json");
  loadPrefs(s2, mem);
  assert.deepEqual(s2.get().prefs, { hints: "on", readout: "line" });
  assert.deepEqual(cleanPrefs({ hints: "quiet", readout: "huge", x: 1 }), { hints: "quiet", readout: "line" });
  loadPrefs(s2, null);
  assert.equal(s2.get().prefs.hints, "on");
});

test("prefs: the key of the earlier name moves to the new one once, at start, and never over a newer value (D-054)", () => {
  const m = new Map();
  const mem = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  m.set(LEGACY_PREFS_KEY, JSON.stringify({ hints: "quiet", readout: "expanded" }));
  const s = createAppStore();
  loadPrefs(s, mem);
  assert.deepEqual(s.get().prefs, { hints: "quiet", readout: "expanded" });
  assert.equal(m.has(LEGACY_PREFS_KEY), false, "the old key is removed");
  assert.equal(migrateLegacyPrefs(mem), false, "once");
  m.set(LEGACY_PREFS_KEY, JSON.stringify({ hints: "on" }));
  assert.equal(migrateLegacyPrefs(mem), true);
  assert.deepEqual(JSON.parse(m.get(PREFS_KEY)), { hints: "quiet", readout: "expanded" }, "an existing new value wins");
  const plain = { getItem: () => { throw new Error("denied"); } };
  assert.equal(migrateLegacyPrefs(plain), false);
  assert.equal(migrateLegacyPrefs(null), false);
});

test("gates: Review needs the link, no read in flight and writes allowed; editors lock only while a read runs", () => {
  const s = createAppStore();
  assert.equal(reviewGate(s.get()).key, "locked.no_link");
  connected(s, false);
  assert.equal(readOnly(s.get()), true);
  assert.deepEqual(reviewGate(s.get()), { key: "locked.read_only", vars: { reason: "msr_allow_writes: cannot read it" } });
  connected(s, true);
  assert.equal(reviewGate(s.get()), null);
  tune.ensureTune(s);
  tune.patchTune(s, { read: { ...s.get().tune.read, state: "reading" } });
  assert.equal(reviewGate(s.get()).key, "locked.reading");
  assert.deepEqual(editLock(s.get()), { key: "locked.reading", vars: {} });
  tune.patchTune(s, { read: { ...s.get().tune.read, state: "ready" } });
  assert.equal(editLock(s.get()), null);
});

// ---------------------------------------------------------------- top bar
test("top bar models: HELPER pip, WRITES / READ-ONLY, UVP, ACCEPTED, the Read button's label and cost", () => {
  assert.deepEqual(["connected", "busy", "connecting", "not_installed", "error"].map((state) => helperPip({ state })), ["ok", "warn", "off", "fault", "fault"]);
  assert.deepEqual(writesAnn({ writes: true }, {}), { label: "Writes", state: "idle", pip: "ok" });
  assert.deepEqual(writesAnn({ writes: false }, { writes_allowed: false }), { label: "Read-only", state: "lit-warn", pip: null });
  assert.deepEqual(writesAnn({ writes: false }, null), { label: "Writes", state: "unknown", pip: "off" });
  assert.equal(uvpAnn("on").state, "lit-warn");
  assert.equal(acceptedText({ kind: "equivalent" }), "matches");
  assert.deepEqual(readButtonModel({ state: "reading", step: 46, of: 132 }), { label: "Reading 46 / 132", cost: null, busy: true, p: 46 / 132 });
  assert.deepEqual(readButtonModel({ state: "ready", ops: 153 }), { label: "Read", cost: "153 req", busy: false, p: 0 });
  assert.equal(readButtonModel(null).cost, null);
  assert.deepEqual(APP_NAME, { os: "linux", tool: "xtu", full: "Linux XTU" }, "the name of D-054");
});

test("top bar: Read asks before dropping edits; Restore accepted only while the CPU differs, and gated with its reason", () => {
  const s = connected(createAppStore(), false);
  const calls = [];
  let edits = 2;
  const root = el("header", "top");
  const bar = createTopBar(root, s, { read: () => calls.push("read"), restore: () => calls.push("restore"), goto: (x) => calls.push("goto:" + x), draftEdits: () => edits });
  const read = root.querySelector("#read-btn");
  const restore = root.querySelector("#restore-accepted");
  assert.equal(root.querySelector("#ann-writes").dataset.state, "lit-warn");
  assert.equal(text(root.querySelector("#ann-writes")), "Read-only");
  assert.equal(restore.hidden, true);
  setLastRead(s, "2026-11-11T19:53:03Z", [{ cpu: 0, match: false }, { cpu: 1, match: false }]);
  assert.equal(text(root.querySelector("#accepted-value")), "differs · 2");
  assert.equal(restore.hidden, false);
  assert.equal(restore.getAttribute("aria-disabled"), "true", "read-only: Restore accepted cannot plan writes");
  assert.equal(restore.dataset.reasonKey, "locked.read_only");
  restore.click();
  assert.deepEqual(calls, []);
  read.click();
  const confirm = root.querySelector("[data-confirm=open]");
  assert.match(text(confirm), /^Read drops 2 edits\./);
  assert.equal(read.hidden, true);
  key(confirm, "Escape");
  assert.deepEqual(calls, [], "Esc keeps the edits");
  read.click();
  root.querySelector("[data-confirm=yes]").click();
  assert.deepEqual(calls, ["read"]);
  edits = 0;
  read.click();
  assert.deepEqual(calls, ["read", "read"], "no edits: no question");
  root.querySelector("#accepted-value").click();
  assert.equal(calls.at(-1), "goto:profiles");
  connected(s, true);
  restore.click();
  assert.equal(calls.at(-1), "restore");
  bar.dispose();
});

test("top bar: each annunciator opens its popover; the WRITES one links to System › Preflight", () => {
  const s = connected(createAppStore(), false);
  const seen = [];
  const root = el("header");
  const bar = createTopBar(root, s, { read() {}, restore() {}, goto: (x) => seen.push(x), draftEdits: () => 0 });
  const writes = root.querySelector("#ann-writes");
  writes.click();
  const pop = doc.getElementById("top-pop");
  assert.equal(pop.hidden, false);
  assert.equal(pop.dataset.pop, "writes");
  assert.match(text(pop), /msr_allow_writes: cannot read it/);
  pop.querySelector("button").click();
  assert.deepEqual(seen, ["system"]);
  assert.equal(pop.hidden, true);
  bar.dispose();
  assert.equal(layerCount(), 0);
});

// ---------------------------------------------------------------- pending row
test("pending row: hidden without edits and while the sheet is open; count, first edits in mono, the rest counted", () => {
  const s = connected(createAppStore());
  const root = el("div", "pending-bar");
  const done = [];
  const row = createPendingBar(root, s, { onDiscard: () => done.push("discard"), onReview: () => done.push("review") });
  assert.equal(root.hidden, true);
  setPending(s, 3, 2, [{ unit: "P0", what: "pt4 48×", from: "0", to: "−20", u: "mV" }, { unit: "Power", what: "PL1", from: "250", to: "200", u: "W" }]);
  assert.equal(root.hidden, false);
  assert.equal(text(root.querySelector("#pending-text")), "3 edits");
  assert.equal(text(root.querySelector("#pending-list")), "P0 pt4 48× 0→−20 mV|Power PL1 250→200 W|+1 more");
  assert.equal(text(root.querySelector("#pending-review")), "Review 3 edits…");
  openDrawer(s, "Review");
  assert.equal(root.hidden, true);
  closeDrawer(s);
  assert.equal(root.hidden, false);
  assert.deepEqual(itemParts({ unit: "EC0", what: "cap", from: null, to: "47", u: "×" }), { lead: "EC0 cap", from: null, to: "47", u: "×" });
  row.dispose();
});

test("pending row: Review is gated with its why line (read-only); Discard all asks when more than one edit", () => {
  const s = connected(createAppStore(), false);
  const root = el("div");
  const done = [];
  const row = createPendingBar(root, s, { onDiscard: () => done.push("discard"), onReview: () => done.push("review") });
  setPending(s, 2, 1, []);
  const review = root.querySelector("#pending-review");
  assert.equal(review.getAttribute("aria-disabled"), "true");
  assert.match(text(root.querySelector("#pending-why")), /^LockedRead-only mode: msr_allow_writes/);
  assert.equal(review.getAttribute("aria-describedby"), "pending-why");
  assert.equal(row.review(), false, "Ctrl+Enter respects the gate");
  review.click();
  assert.deepEqual(done, []);
  connected(s, true);
  assert.equal(root.querySelector("#pending-why").hidden, true);
  assert.equal(row.review(), true);
  root.querySelector("#pending-discard").click();
  assert.match(text(root.querySelector("[data-confirm=open]")), /^Discard all 2 edits\?/);
  root.querySelector("[data-confirm=yes]").click();
  assert.deepEqual(done, ["review", "discard"]);
  setPending(s, 1, 1, []);
  root.querySelector("#pending-discard").click();
  assert.deepEqual(done, ["review", "discard", "discard"], "one edit: no question");
  row.dispose();
});

// ---------------------------------------------------------------- context line + quiet
test("context line: focus wins over hover, a reason replaces the hint, idle shows the screen's line; Quiet is a persisted pref", () => {
  const s = connected(createAppStore());
  const scope = el("div", "app");
  const ctxEl = doc.createElement("div");
  const a = doc.createElement("button");
  a.dataset.hint = "power.pl1";
  const b = doc.createElement("button");
  b.dataset.hint = "state.read";
  b.dataset.hintTerm = "132 req";
  scope.append(a, b, ctxEl);
  const opened = [];
  const line = createContextLine(ctxEl, s, { scope, screenKey: () => "tune.power", screenLabel: () => "Power", onTips: (id) => opened.push(id) });
  assert.equal(ctxEl.dataset.idle, "true");
  assert.equal(text(ctxEl.querySelector("[data-part=line]")), SCREEN["tune.power"]);
  a.focus();
  assert.equal(ctxEl.dataset.hintShown, "power.pl1");
  assert.match(text(ctxEl), new RegExp(`^${HINTS["power.pl1"].label}PL1`));
  fire(b, "pointerover");
  assert.equal(ctxEl.dataset.hintShown, "power.pl1", "focus wins over hover");
  a.blur();
  assert.equal(ctxEl.dataset.hintShown, "state.read", "focus gone: the hovered control speaks");
  fire(scope, "pointerleave");
  assert.equal(ctxEl.dataset.idle, "true", "nothing focused or hovered: the idle line");
  fire(b, "pointerover");
  assert.equal(ctxEl.dataset.hintShown, "state.read");
  assert.match(text(ctxEl), /^Read132 req/);
  b.dataset.reasonKey = "locked.no_link";
  b.dataset.reasonVars = "{}";
  fire(a, "pointerover");
  fire(b, "pointerover");
  assert.match(text(ctxEl.querySelector("[data-part=line]")), /^Unavailable The helper is not connected/);
  doc.getElementById("ctx-tips").click();
  assert.deepEqual(opened, [null]);
  const quiet = ctxEl.querySelector("#hints-mode [data-value=quiet]");
  quiet.click();
  assert.equal(s.get().prefs.hints, "quiet");
  assert.deepEqual(describe(a).tip, "power");
  line.dispose();
});

// ---------------------------------------------------------------- readout bar + LIMITS
test("readout: six values, disconnected '—', n/a with the helper's reason; a value toggles the expanded bar", () => {
  assert.deepEqual(READOUTS.map((r) => r.k), ["PKG", "CLK", "HOT", "VCORE", "CORE", "DRAM"]);
  const clk = READOUTS[1];
  assert.deepEqual(readoutValue(clk, { value: 5500 }), { text: "5.50", na: false, unit: "GHz", reason: null });
  assert.deepEqual(readoutValue(clk, { value: null, reason: "no msr" }), { text: "n/a", na: true, unit: "", reason: "no msr" });
  assert.equal(readoutValue(clk, { value: 5500 }, { connected: false }).text, "—");
  const s = connected(createAppStore());
  applyHelperEvent(s, "telemetry", { t: 1, values: { power: { package: { value: 55.24, status: "ok", unit: "W", source: "powercap" } } } });
  const root = el("footer", "readout");
  const r = createReadout(root, s, { goto: () => {} });
  assert.equal(text(root.querySelector("#ro-pkg_power")), "PKG55.2W");
  assert.equal(root.querySelector("#ro-core_power").dataset.reason, "not reported");
  root.querySelector("#ro-clock").click();
  assert.equal(s.get().prefs.readout, "expanded");
  assert.equal(root.dataset.expanded, "true");
  assert.equal(root.querySelector("#ro-clock").getAttribute("aria-expanded"), "true");
  setLink(s, { state: "error", kind: "closed" });
  assert.equal(text(root.querySelector("#ro-pkg_power")), "PKG—W");
  assert.equal(root.querySelector("#limits-pl1").dataset.state, undefined, "disconnected: dark");
  r.dispose();
});

const grp = (label, active, duty, bits) => ({ label, active, duty, bits });
const tick = (t, pl1) => ({
  t,
  values: {
    throttle: {
      status: "ok", source: "msr 0x64F status bits, oversampled",
      value: { samples: 10, failed: 0, window_s: 1.0, or_word: 0, bit_duty: pl1 ? { pl1, max_turbo_limit: 1.0 } : { max_turbo_limit: 1.0 }, info_bits: [], unknown_bits: [],
        groups: { power: grp("Power limit", !!pl1, pl1, pl1 ? ["pl1"] : []), current: grp("Current", false, 0, []), thermal: grp("Thermal", false, 0, []), vr_thermal: grp("VR", false, 0, []), max_turbo: grp("Max turbo", true, 1, ["max_turbo_limit"]) } },
    },
  },
});

test("LIMITS: PL1/PL2 by bit with their duty, PL4/THERM/VR/TURBO by group; n/a dashed while connected, dark while not", () => {
  const s = createAppStore();
  applyHelperEvent(s, "telemetry", tick(1, 0.3));
  const m = limitAnnModel(s.get().telemetry.throttle);
  assert.deepEqual(m.map((x) => [x.key, x.state, x.duty]), [["pl1", "lit-warn", "30%"], ["pl2", "idle", null], ["pl4", "idle", null], ["therm", "idle", null], ["vr", "idle", null], ["turbo", "lit-info", "100%"]]);
  assert.ok(limitAnnModel(null).every((x) => x.state === "unknown"));
  assert.ok(limitAnnModel(null, { connected: false }).every((x) => x.state === "idle"));
  assert.deepEqual(LIMIT_ANNS.map((a) => a.hint), ["ann.pl1", "ann.pl2", "ann.pl4", "ann.therm", "ann.vr", "ann.turbo"]);
});

test("LIMITS popover (F-10): built once, a telemetry tick updates it in place, the focused control survives, Esc returns focus", () => {
  const s = connected(createAppStore());
  applyHelperEvent(s, "telemetry", tick(1, 0.3));
  const seen = [];
  const lim = createLimits(s, { goto: (a, b) => seen.push(`${a}/${b}`), id: "lt" });
  doc.body.append(lim.el);
  const pl1 = lim.anns.get("pl1");
  pl1.click();
  const pop = doc.getElementById("lt-pop");
  assert.equal(pop.hidden, false);
  const reset = doc.getElementById("lt-reset");
  reset.focus();
  const nowCell = pop.querySelector("tr[data-limit=pl1] [data-col=now]");
  assert.equal(text(nowCell), "30%");
  applyHelperEvent(s, "telemetry", tick(2, 0.5));
  applyHelperEvent(s, "telemetry", tick(3, 0.7));
  assert.equal(doc.getElementById("lt-reset"), reset, "the button is never rebuilt");
  assert.equal(doc.activeElement, reset, "focus stays on it");
  assert.equal(pop.querySelector("tr[data-limit=pl1] [data-col=now]"), nowCell);
  assert.equal(text(nowCell), "70%");
  assert.equal(pl1.dataset.state, "lit-warn");
  assert.equal(text(pl1), "PL170%");
  key(reset, "Escape");
  assert.equal(pop.hidden, true);
  assert.equal(doc.activeElement, pl1);
  pl1.click();
  doc.getElementById("lt-to-power").click();
  assert.deepEqual(seen, ["tune/power"]);
  lim.dispose();
});

// ---------------------------------------------------------------- commit sheet shell
test("sheet: opens with focus on 'Close, keep plan' (never Apply), Tab stays inside, Esc closes and focus returns to the opener", () => {
  const s = createAppStore();
  const opener = el("button", "pending-review-x");
  const root = el("section", "drawer");
  const sheet = createSheet(root, s, { doc });
  const close = doc.createElement("button");
  close.id = "apply-close";
  const go = doc.createElement("button");
  go.id = "apply-go";
  sheet.setContent(doc.createElement("p"), [close, go]);
  assert.equal(root.dataset.open, "false");
  assert.equal(root.inert, true);
  opener.focus();
  openDrawer(s, "Review");
  assert.equal(root.dataset.open, "true");
  assert.equal(root.inert, false);
  assert.equal(text(root.querySelector("#drawer-title")), "Review");
  assert.equal(doc.activeElement, close, "initial focus: the safe button");
  go.focus();
  const tab = key(go, "Tab");
  assert.ok(tab.defaultPrevented);
  assert.equal(doc.activeElement, doc.getElementById("drawer-close"), "Tab from the last control wraps to the first");
  key(doc.getElementById("drawer-close"), "Tab", { shiftKey: true });
  assert.equal(doc.activeElement, go, "Shift+Tab from the first wraps to the last");
  key(go, "Escape");
  assert.equal(s.get().drawer.open, false);
  assert.equal(doc.activeElement, opener, "focus returns to what opened it");
  sheet.dispose();
});

test("sheet: in read-only mode the plan's Apply is aria-disabled, its click does nothing and the reason sits beside it", () => {
  const s = connected(createAppStore(), false);
  const root = el("section");
  const gate = (st) => (readOnly(st) ? { key: "locked.read_only", vars: { reason: st.mode.reason } } : null);
  const sheet = createSheet(root, s, { doc, gate });
  let applied = 0;
  const go = doc.createElement("button");
  go.id = "apply-go";
  go.addEventListener("click", () => applied++);
  sheet.setContent(doc.createElement("p"), [go]);
  assert.equal(go.getAttribute("aria-disabled"), "true");
  assert.equal(go.dataset.hint, "state.apply");
  assert.match(text(doc.getElementById("apply-gate-why")), /^LockedRead-only mode: msr_allow_writes/);
  go.click();
  assert.equal(applied, 0);
  connected(s, true);
  assert.equal(go.getAttribute("aria-disabled"), null);
  assert.equal(doc.getElementById("apply-gate-why").hidden, true);
  go.click();
  assert.equal(applied, 1);
  sheet.dispose();
});

// ---------------------------------------------------------------- rail, work head, toasts
test("rail: the new screen map in groups, Tips at the foot, no active key during Setup, the Tune mark with edits", () => {
  assert.deepEqual(SCREENS.map((x) => x.label), ["Overview", "Tune", "Stress", "Curves", "Profiles", "Audit", "System", "Tips"]);
  const s = createAppStore();
  let setup = false;
  const root = el("nav", "nav-rail");
  createNavRail(root, s, { onSelect: (id) => setScreen(s, id), isSetup: () => setup });
  assert.equal(root.querySelectorAll("[aria-current=page]").map((a) => a.dataset.screen).join(), "dashboard");
  assert.equal(text(root.querySelector("#nav-tips")), "TipsF1");
  root.querySelector("#nav-tips").click();
  assert.equal(s.get().screen, "tips");
  setPending(s, 2, 1, []);
  assert.equal(root.querySelector("#nav-tune [data-mark]").hidden, false);
  setup = true;
  setLink(s, { state: "not_installed" });
  assert.equal(root.querySelectorAll("[aria-current=page]").length, 0);
});

test("work head: title, tabs updated in place, a subtitle without tabs, the frame's lock slot", () => {
  const head = createWorkHead(el("div", "work-head"));
  head.reset("Tune");
  const picked = [];
  head.set({ tabs: [{ id: "cores", label: "Cores", edited: true }, { id: "power", label: "Power" }], selected: "cores", idPrefix: "subtab-", onTab: (id) => picked.push(id) });
  const cores = doc.getElementById("subtab-cores");
  head.set({ tabs: [{ id: "cores", label: "Cores" }, { id: "power", label: "Power", edited: true }], selected: "power" });
  assert.equal(doc.getElementById("subtab-cores"), cores);
  doc.getElementById("subtab-cores").click();
  assert.deepEqual(picked, ["cores"]);
  head.reset("Tips");
  assert.equal(doc.getElementById("subtab-cores"), null);
  head.set({ sub: "about 10 min" });
  assert.equal(head.title(), "Tips");
});

test("toasts: at most three shown, warn and error stay, a sentence splits into title and body", () => {
  const s = createAppStore();
  const root = el("div", "toasts");
  const timers = [];
  const dispose = createToaster(root, s, { schedule: (fn, ms) => (timers.push(ms), timers.length), cancel: () => {} });
  for (const [kind, text_] of [["ok", "Read complete. 132 requests in 1.1 s"], ["warn", "w1"], ["error", "e1"], ["info", "i1"]]) store_.pushToast(s, { kind, text: text_ });
  assert.equal(root.querySelectorAll("[data-toast]").length, 3);
  assert.deepEqual(root.querySelectorAll("[data-toast]").map((t) => t.dataset.kind), ["warn", "error", "info"]);
  assert.deepEqual(timers, [4000, 4000], "only ok / info expire");
  assert.deepEqual(toastParts({ text: "Read complete. 132 requests in 1.1 s" }), { title: "Read complete", body: "132 requests in 1.1 s" });
  assert.deepEqual(toastParts({ text: "short" }), { title: "short", body: "" });
  dispose();
});

// ---------------------------------------------------------------- Tips
test("tips: inline marks become spans, never markup; figures are plot-core SVG; every section has its anchor and Open link", () => {
  assert.deepEqual(parseInline("**Read** then [set]edit[/set] and [write]Apply[/write]."), [
    { text: "Read", mark: "strong" }, { text: " then ", mark: null }, { text: "edit", mark: "set" }, { text: " and ", mark: null }, { text: "Apply", mark: "write" }, { text: ".", mark: null },
  ]);
  assert.deepEqual(parseInline("a [set]b"), [{ text: "a [set]b", mark: null }]);
  for (const s of TIPS.sections) for (const b of s.blocks.filter((x) => x.figure)) {
    const fig = renderBlock(b);
    assert.equal(fig.dataset.fig, b.figure.kind);
    assert.ok(fig.querySelector("svg").querySelectorAll("polyline").length >= 1, b.figure.kind);
  }
  const s = createAppStore();
  const root = el("main", "screen");
  const gone = [];
  const ends = [];
  const v = tipsView();
  v.mount(root, { store: s, goto: (a, b) => gone.push(`${a}${b ? "/" + b : ""}`), head: { set: (o) => ends.push(o) } });
  assert.equal(root.querySelectorAll("section[data-tip]").length, TIPS.sections.length);
  assert.equal(root.querySelectorAll("[data-tip-link]").length, TIPS.sections.length);
  root.querySelector("#tip-ratios [data-goto]").click();
  root.querySelector("#tip-start [data-goto]").click();
  assert.deepEqual(gone, [`tune/${GOTO_TAB.frequency}`, "dashboard"]);
  assert.ok(ends[0].end.length === 2, "the Hints on / Quiet control sits in the header (the way back from Quiet)");
  openTipsAt(s, "power");
  assert.equal(doc.activeElement, root.querySelector("#tip-power-h"), "F1 / More in Tips focus the section heading");
  assert.equal(root.querySelector("[data-tip-link=power]").getAttribute("aria-current"), "true");
  v.unmount();
  for (const id of Object.values(SCREEN_TIP)) assert.ok(id === null || TIPS.sections.some((x) => x.id === id), id);
});

// ---------------------------------------------------------------- Tune: pending items, tab marks, Read count
test("tune: the pending row's items and the tab marks come from the draft and the runtime edits", () => {
  const s = createAppStore();
  tune.ensureTune(s);
  const model = modelFromRead(READ);
  tune.patchTune(s, { model });
  let d = draftLib.setPoint(model, s.get().tune.draft, ["P0"], 48, -20);
  d = draftLib.setBucket(model, d, "P", 7, model.turbo.P.ratios[7] - 1);
  tune.patchTune(s, { draft: d });
  const items = s.get().pendingItems;
  assert.equal(items[0].unit, "P0");
  assert.match(items[0].what, /^pt\d+ 48×$/);
  assert.deepEqual([items[0].from, items[0].to, items[0].u], ["0", "−19.5", "mV"]); // G-248 (QA-04): the step the CPU holds, like the editor
  assert.equal(items[1].unit, "Turbo P");
  assert.equal(tune.draftEdits(s), 2);
  assert.deepEqual(tune.tabEdits(s.get()), { cores: true, turbo: true, power: false, ring: false }); // R-S1: ratio caps live in Frequency (tab id "turbo")
  assert.equal(s.get().pending.changes, 2);
  assert.ok(Object.keys(tune.PERSIST).every((k) => tune.SUBTABS.some((t) => t.id === k)));
});

// ---------------------------------------------------------------- app routing and keys
test("app: hash routes (Tips sections included), the idle-line key per screen and Tune tab, the global keys", () => {
  assert.deepEqual(routeFromHash("#/tips/power"), { screen: "tips", sub: "power" });
  assert.deepEqual(routeFromHash("#/tune"), { screen: "tune", sub: null });
  assert.equal(routeFromHash("#/nope"), null);
  const st = createAppStore().get();
  assert.equal(screenKey(st), "overview");
  assert.equal(screenKey({ ...st, screen: "tune", tune: { subtab: "ratios" } }), "tune.frequency");
  assert.equal(screenKey({ ...st, screen: "tune", tune: { subtab: "ring" } }), "tune.uncore");
  assert.equal(screenKey(st, true), "setup");
  for (const k of ["overview", "tune.cores", "tune.frequency", "tune.power", "tune.uncore", "setup", "tips"]) assert.ok(SCREEN[k], k);
  assert.equal(keyAction({ key: "F1" }), "tips");
  assert.equal(keyAction({ key: "Enter", ctrlKey: true }), "review");
  assert.equal(keyAction({ key: "Enter" }), null);
  assert.equal(keyAction({ key: "Escape" }), "escape");
});
