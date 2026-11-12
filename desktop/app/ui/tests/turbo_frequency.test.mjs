// node --test desktop/app/ui/tests/turbo_frequency.test.mjs   (R-S2, G-251: Tune › Frequency — top ratio / cap / clock per unit, the computed turbo line, turbo order refused in place, set all / fill right,
// ratio caps, the D-050 note; the explainRefusal remediation of the ordering refusals). Fake DOM (tests/fakedom.mjs), recorded simulator fixtures, no helper.
import test from "node:test";
import assert from "node:assert/strict";
import { install, fire, text } from "./fakedom.mjs";
import FIX from "../fixtures/fixtures.js";
import G from "../fixtures/g217/fixtures-g217.js";
import { modelFromRead } from "../lib/units.js";
import { emptyDraft, setOcRatio, turboEff } from "../lib/draft.js";
import { createAppStore, setLink, setPreflight } from "../store.js";
import { ensureRt, setRead } from "../lib/rtstate.js";
import { explainRefusal, REMEDY } from "../lib/cpulimits.js";
import { WHY } from "../lib/hints.js";

install();
const F = await import("../views/tune/frequency.js");
const { ratioAt, unitLimits, topText, groupText, turboLine, RULE, stepPoints, countsText, setAllBuckets, fillRight, bucketCounts, mount, unmount } = F;

const READ = FIX["tune-read"].result;
const RT_READ = G["runtime-read"].result;
const model = () => modelFromRead(structuredClone(READ));

/** A mounted Frequency tab on the fixture read, a connected link, the runtime read in the slice and the draft in the store (as views/tune.js hands it). */
function host({ writes = true, draft = null } = {}) {
  const store = createAppStore();
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: writes, mode: "write", checks: writes ? [] : [{ name: "msr_allow_writes", status: "unknown", reason: "cannot read it" }] });
  const m = model();
  store.set({ tune: { model: m, draft: draft || emptyDraft(), read: { state: "ready" } } });
  ensureRt(store);
  setRead(store, "runtime", { state: "ready", result: structuredClone(RT_READ) });
  const el = document.createElement("div");
  document.body.append(el);
  const calls = [];
  const bridge = { call: async (op) => (calls.push(op), { ok: true, result: structuredClone(RT_READ) }), wait: async () => ({ ok: false, error: { code: "X" } }) };
  mount(el, { store, bridge, model: m, getDraft: () => store.get().tune.draft, setDraft: (d) => store.update((s) => ({ tune: { ...s.tune, draft: d } })) });
  return { el, store, model: m, calls, draft: () => store.get().tune.draft };
}
const bucket = (el, kind, i) => el.querySelector(`[data-panel=turbo][data-kind=${kind}] [data-bucket="${i}"]`);
const typeInto = (fieldEl, value) => {
  const input = fieldEl.querySelector("input");
  input.value = value;
  fire(input, "change");
  return input;
};
const row = (el, id) => el.querySelector(`tr[data-row=${id}]`);
const cell = (el, id, col) => text(row(el, id).querySelector(`td[data-col=${col}]`) || row(el, id).children[colIndex(el, col)]);
const colIndex = (el, col) => [...el.querySelector("[data-panel=limits] thead tr").children].findIndex((th) => th.dataset.col === col);

// ---------------------------------------------------------------- pure
test("frequency: a core runs at the lowest of its top ratio, its cap and the turbo-table entry (null values are not limits)", () => {
  assert.equal(ratioAt({ top: 57, cap: 57 }, 55), 55);
  assert.equal(ratioAt({ top: 55, cap: 57 }, 57), 55, "a core whose own top is 55 never reaches a 57 table entry");
  assert.equal(ratioAt({ top: 57, cap: 50 }, 57), 50);
  assert.equal(ratioAt({ top: 58, cap: null }, 57), 57, "an OC ratio above the table stays capped by it (D-050)");
  assert.equal(ratioAt({ top: null, cap: null }, null), null);
});

test("frequency: unitLimits — the top ratio is the unit's own ceiling (P1 55, favored P0 57, OC marked with the fused value); a cap shows only below the top", () => {
  const m = model();
  const p0 = unitLimits(m, emptyDraft(), "P0", {}, 57);
  assert.deepEqual([p0.top, p0.topOc, p0.capShown], [57, false, null], "a cap at the top holds nothing back: the field says none");
  const p1 = unitLimits(m, emptyDraft(), "P1", {}, 57);
  assert.deepEqual([p1.top, p1.capShown], [55, null], "P1 is fused to 55, not 57");
  assert.equal(unitLimits(m, emptyDraft(), "P1", {}, 50).capShown, 50, "a cap below the top is shown");
  assert.deepEqual([unitLimits(m, emptyDraft(), "P1", { P1: 57 }, 50).capShown, unitLimits(m, emptyDraft(), "P1", { P1: 57 }, 50).capEdited], [57, true], "an edit is always shown");
  const ec = unitLimits(m, emptyDraft(), "EC1", { EC1: 46 }, 49);
  assert.deepEqual([ec.top, ec.topOc, ec.topFused, ec.cap, ec.capEdited, ec.capShown], [48, true, 46, 46, true, 46], "E rows have a top ratio too (the BIOS runs 48× over a 46× fused top)");
  assert.deepEqual(topText(ec), { n: "48×", oc: true, fused: "(fused 46×)" });
  assert.deepEqual(topText(p1), { n: "55×", oc: false, fused: "" });
  const oc = unitLimits(m, setOcRatio(m, emptyDraft(), ["P1"], 58), "P1", {}, null);
  assert.deepEqual([oc.top, oc.topOc, oc.topFused, oc.topEdited], [58, true, 55, true]);
});

test("frequency: the computed turbo line groups units by what they really get (min rule) from the draft; one value for all is said once", () => {
  const m = model();
  assert.equal(turboLine(m, emptyDraft(), "P"), "1 busy: P0, P3 57× · others 55× — 8 busy: all 55×");
  assert.equal(turboLine(m, emptyDraft(), "E"), "1 busy: 48× — 16 busy: 48×");
  const d = setOcRatio(m, emptyDraft(), ["P1"], 58);
  assert.equal(turboLine(m, d, "P", { P4: 50 }), "1 busy: P0, P1, P3 57× · P4 50× · others 55× — 8 busy: P4 50× · others 55×", "the OC ratio does not lift P1 above the table; a cap lowers P4");
  const t = setAllBuckets(m, emptyDraft(), "P", 53);
  assert.equal(turboLine(m, t.draft, "P"), "1 busy: all 53× — 8 busy: all 53×", "follows the draft table");
  assert.equal(groupText([{ id: "EC0", v: 47 }, { id: "EC1", v: 46 }, { id: "EC2", v: 47 }, { id: "EC3", v: 47 }], "E"), "EC1 46× · others 47×");
});

test("frequency: the step chart uses the real busy-core axis (E buckets 1,2,3,4,6,8,12,16); counts text", () => {
  const m = model();
  assert.deepEqual(bucketCounts(m, "E"), [1, 2, 3, 4, 6, 8, 12, 16]);
  assert.deepEqual(stepPoints([57, 55, 55], [1, 2, 3]), [[1, 57], [1, 55], [2, 55], [2, 55], [3, 55]]);
  assert.equal(countsText([3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7, 8]), "4–8");
  assert.equal(countsText([4, 6], [1, 2, 3, 4, 6, 8, 12, 16]), "6, 12");
  assert.equal(countsText([7], [1, 2, 3, 4, 6, 8, 12, 16]), "16");
});

test("frequency: Set all raises bucket by bucket (never passing the one to its left) and refuses above the CPU limit; Fill right copies one bucket rightwards", () => {
  const m = model();
  const up = setAllBuckets(m, emptyDraft(), "P", 57);
  assert.equal(up.ok, true);
  assert.deepEqual(turboEff(m, up.draft, "P"), [57, 57, 57, 57, 57, 57, 57, 57]);
  const down = setAllBuckets(m, emptyDraft(), "E", 46);
  assert.deepEqual(turboEff(m, down.draft, "E"), [46, 46, 46, 46, 46, 46, 46, 46]);
  const over = setAllBuckets(m, emptyDraft(), "P", 121);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "refused.above_limit");
  const fill = fillRight(m, emptyDraft(), "P", 1);
  assert.deepEqual([fill.ok, fill.changed], [true, [2, 3, 4, 5, 6, 7]]);
  assert.deepEqual(turboEff(m, fill.draft, "P"), [57, 57, 57, 57, 57, 57, 57, 57]);
  assert.deepEqual(fillRight(m, emptyDraft(), "P", 7).changed, [], "nothing on the right of the last bucket");
});

test("refusals: TURBO_ORDER and POWER_ORDER plan refusals keep the helper's words and add what to do; others unchanged", () => {
  const t = explainRefusal({ code: "REFUSED", message: "turbo.P: bucket 4 (57x) is above bucket 3 (55x)", detail: { check: "TURBO_ORDER", table: "p", bucket: 3 } });
  assert.match(t, /^turbo\.P: bucket 4 \(57x\) is above bucket 3 \(55x\)\. /);
  assert.ok(t.endsWith(REMEDY.TURBO_ORDER));
  assert.match(t, /Tune › Frequency/);
  const p = explainRefusal({ code: "REFUSED", message: "PL1 300 W is above PL2 295 W.", detail: { check: "POWER_ORDER" } });
  assert.equal(p, "PL1 300 W is above PL2 295 W. " + REMEDY.POWER_ORDER);
  assert.equal(explainRefusal({ code: "REFUSED", message: "other", detail: { check: "CPU_LIMIT" } }), "other");
});

// ---------------------------------------------------------------- the view (fake DOM)
test("frequency view: one row per unit with Top ratio · Cap · Clock now only; the rule in one line; two turbo tables of eight fields with a computed line; caps from runtime.read", () => {
  const v = host();
  assert.equal(v.el.dataset.view, "frequency");
  assert.deepEqual([...v.el.querySelector("[data-panel=limits] thead tr").children].map((th) => text(th)), ["Unit", "Top ratio", "Cap×", "", "Clock nowGHz"]);
  assert.equal(text(v.el.querySelector("[data-panel=limits] .lx-band-m")), RULE);
  const rows = v.el.querySelectorAll("[data-panel=limits] tbody tr[data-row]");
  assert.deepEqual(rows.map((r) => r.dataset.row), ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "EC0", "EC1", "EC2", "EC3"]);
  assert.equal(cell(v.el, "P0", "top"), "57×");
  assert.equal(cell(v.el, "P1", "top"), "55×", "not 57× on every P-core");
  assert.match(cell(v.el, "EC0", "top"), /^48× OC \(fused 46×\)$/, "E rows show their ceiling, not —");
  assert.equal(cell(v.el, "P0", "clk"), "n/a", "no telemetry yet");
  assert.equal(v.el.querySelectorAll("[data-panel=turbo]").length, 2);
  assert.equal(v.el.querySelectorAll("[data-panel=turbo][data-kind=P] [data-bucket]").length, 8);
  assert.deepEqual([0, 1, 2, 7].map((i) => bucket(v.el, "P", i).querySelector("input").value), ["57", "57", "55", "55"]);
  assert.equal(text(v.el.querySelector("[data-panel=turbo][data-kind=P] [data-part=turbo-line]")), "1 busy: P0, P3 57× · others 55× — 8 busy: all 55×");
  assert.equal(text(v.el.querySelector("[data-panel=turbo][data-kind=E] [data-part=turbo-line]")), "1 busy: 48× — 16 busy: 48×");
  assert.equal(text(v.el.querySelector("[data-panel=turbo][data-kind=P] [data-part=turbo-note]")), "A ceiling by number of busy cores; no core goes above its own top ratio or cap.");
  const bandTxt = (k) => text(v.el.querySelector("[data-panel=turbo][data-kind=" + k + "] .lx-band"));
  assert.match(bandTxt("P"), /Lost at cold boot/i);
  assert.doesNotMatch(bandTxt("P") + bandTxt("E"), /0x1AD|0x650|MSR/, "register numbers are a tooltip");
  assert.match(v.el.querySelector("[data-panel=turbo][data-kind=P] .lx-band-t").getAttribute("title"), /0x1AD \/ 0x1AE/);
  assert.match(v.el.querySelector("[data-panel=turbo][data-kind=E] .lx-band-t").getAttribute("title"), /0x650 \/ 0x651/);
  assert.equal(v.el.querySelectorAll("[data-cap]").length, 12, "a cap field per P-core and per E-cluster");
  assert.equal(v.el.querySelector("[data-cap=P0] input").value, "", "a cap at the top ratio is no cap: the field is empty");
  assert.equal(v.el.querySelector("[data-cap=P0] input").placeholder, "none");
  assert.equal(v.el.querySelectorAll("[data-plot]").length, 2);
  assert.match(text(v.el.querySelector("[data-panel=limits] .lx-tfoot-note")), /^Cap range \d+–\d+×\. An E-cluster cap applies to its four CPUs\.$/);
  unmount();
  assert.equal(v.el.childNodes.length, 0);
});

test("frequency view: Clock now follows the telemetry (highest clock of the unit's CPUs); the turbo line follows the draft", () => {
  const v = host();
  const leaf = (value) => ({ value, unit: "MHz", status: "ok" });
  v.store.update((s) => ({ telemetry: { ...s.telemetry, values: { cores: { 0: { mhz: leaf(5600) }, 8: { mhz: leaf(4600) }, 9: { mhz: leaf(4700) } } } } }));
  assert.equal(cell(v.el, "P0", "clk"), "5.60");
  assert.equal(cell(v.el, "EC0", "clk"), "4.70");
  assert.equal(cell(v.el, "P1", "clk"), "n/a");
  typeInto(bucket(v.el, "P", 0), "55");
  assert.equal(text(v.el.querySelector("[data-panel=turbo][data-kind=P] [data-part=turbo-line]")), "1 busy: all 55× — 8 busy: all 55×");
  unmount();
});

test("frequency view: a bucket above its left neighbour is refused in the field with its reason, the typed text kept, the draft untouched", () => {
  const v = host();
  const f = bucket(v.el, "P", 3);
  const input = typeInto(f, "57");
  assert.equal(f.dataset.state, "refused");
  assert.equal(input.value, "57", "the typed text stays");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  const w = v.el.querySelector("[data-panel=turbo][data-kind=P] [data-why='refused.turbo_rise']");
  assert.ok(w, "the reason is shown");
  assert.match(text(w), /3 busy is 55×, so 4 busy can be at most 55×/);
  assert.equal(v.draft().turbo.P, undefined, "nothing reached the draft");
  unmount();
});

test("frequency view: lowering a bucket brings the right ones down and says so in place (never silently); the cell turns cyan", () => {
  const v = host();
  typeInto(bucket(v.el, "P", 2), "53");
  assert.deepEqual(v.draft().turbo.P, [57, 57, 53, 53, 53, 53, 53, 53]);
  const w = v.el.querySelector("[data-panel=turbo][data-kind=P] [data-why='info.turbo_followed']");
  assert.ok(w && !w.hidden);
  assert.match(text(w), /4–8 busy now 53×/);
  assert.equal(bucket(v.el, "P", 5).dataset.state, "set");
  assert.equal(bucket(v.el, "P", 0).dataset.state, "idle");
  assert.equal(v.el.querySelector("[data-panel=turbo][data-kind=P]").dataset.edited, "true");
  unmount();
});

test("frequency view: Set all and Fill right edit the draft explicitly; a refused Set all says why and changes nothing", () => {
  const v = host();
  const all = v.el.querySelector("[data-set-all=E]");
  all.querySelector("input").value = "47";
  v.el.querySelector("[data-panel=turbo][data-kind=E] [data-action=set-all]").click();
  assert.deepEqual(v.draft().turbo.E, [47, 47, 47, 47, 47, 47, 47, 47]);
  all.querySelector("input").value = "999";
  fire(all.querySelector("input"), "change");
  assert.equal(all.dataset.state, "refused");
  v.el.querySelector("[data-panel=turbo][data-kind=E] [data-action=set-all]").click();
  assert.deepEqual(v.draft().turbo.E, [47, 47, 47, 47, 47, 47, 47, 47], "unchanged");
  // Fill right from the focused bucket (2 busy): 3..8 busy take 57x
  const b1 = bucket(v.el, "P", 1).querySelector("input");
  b1.focus();
  const fill = v.el.querySelector("[data-panel=turbo][data-kind=P] [data-action=fill-right]");
  assert.match(text(fill), /Fill right from 2 busy/);
  fill.click();
  assert.deepEqual(v.draft().turbo.P, [57, 57, 57, 57, 57, 57, 57, 57]);
  unmount();
});

test("frequency view: a cap edit goes to the runtime slice, the row marks the edit and the cap binds; outside the cpufreq window it is refused", async () => {
  const v = host();
  typeInto(v.el.querySelector("[data-cap=EC1]"), "46");
  assert.deepEqual(v.store.get().rt.edits.caps, { EC1: 46 });
  assert.equal(row(v.el, "EC1").dataset.state, "edit");
  assert.equal(v.el.querySelector("[data-cap=EC1] input").value, "46", "an edited cap is shown");
  assert.equal(text(v.el.querySelector("[data-panel=turbo][data-kind=E] [data-part=turbo-line]")), "1 busy: EC1 46× · others 48× — 16 busy: EC1 46× · others 48×");
  const p0 = v.el.querySelector("[data-cap=P0]");
  typeInto(p0, "99");
  await Promise.resolve(); // the why row follows its field after the event (a microtask)
  assert.equal(p0.dataset.state, "refused");
  assert.ok(v.el.querySelector("tr[data-why-for=P0] [data-why='refused.above_limit']"));
  assert.equal(v.el.querySelector("tr[data-why-for=P0]").hidden, false);
  assert.equal(v.store.get().rt.edits.caps.P0, undefined);
  unmount();
});

test("frequency view: an OC ratio above the turbo table is an info line on the unit's row (D-050), not an error", () => {
  const m = model();
  const v = host({ draft: setOcRatio(m, emptyDraft(), ["P1"], 58) });
  const r = v.el.querySelector("tr[data-why-for=P1]");
  assert.equal(r.hidden, false);
  const w = r.querySelector("[data-why='info.oc_capped']");
  assert.ok(w);
  assert.equal(w.dataset.kind, undefined, "neutral: neither refused nor warn");
  assert.match(text(w), /OC 58× is above the turbo table \(57×\)/);
  assert.equal(v.el.querySelector("tr[data-why-for=P0]").hidden, true);
  unmount();
});

test("frequency view: Restore boot caps and uncore… names both and is gated with its reason; read-only says so", () => {
  const v = host({ writes: false });
  const b = v.el.querySelector("[data-restore=runtime]");
  assert.match(text(b), /Restore boot caps and uncore/);
  assert.equal(b.disabled, true);
  const w = document.getElementById(b.getAttribute("aria-describedby"));
  assert.equal(w.dataset.why, "locked.read_only");
  unmount();
  const ok = host();
  const b2 = ok.el.querySelector("[data-restore=runtime]");
  assert.equal(b2.disabled, true, "the recorded journal is empty: nothing to restore");
  assert.equal(document.getElementById(b2.getAttribute("aria-describedby")).dataset.why, "locked.nothing_to_restore");
  unmount();
});

test("frequency view: every reason key it can show has a WHY template", () => {
  for (const k of ["refused.turbo_rise", "info.turbo_followed", "info.oc_capped", "locked.nothing_to_restore", "locked.unavailable", "locked.cpu_offline", "refused.above_limit"]) assert.ok(WHY[k], k);
});
