// node --test desktop/app/ui/tests/   (R-C3: the shared lx- components on a small fake DOM — field refusals and keys, buttons and inline confirm,
// segmented, tabs, annunciators, table, unit table, plot core, sparkline, help (why lines, "?" expander), popover placement, the Escape stack.
// Selectors are data-* / roles / ids, never lx- classes. No browser, no helper, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { install, key, fire, text } from "./fakedom.mjs";

const doc = install();
const { judge, parseNumber, formatNumber, stepValue, createField } = await import("../components/field.js");
const { button, setBusy, setButton, confirmInPlace } = await import("../components/buttons.js");
const { createSegmented } = await import("../components/segmented.js");
const { createTabs } = await import("../components/tabs.js");
const { annunciator, setAnn, tag } = await import("../components/ann.js");
const { createTable, cellValue } = await import("../components/table.js");
const { createUnitTable, unitsFromModel, unitsFromTopology, clickSelect } = await import("../components/unit-table.js");
const { createPlot, niceTicks, scale, nearestStop } = await import("../components/plot.js");
const { createSparkline, sparkD } = await import("../components/sparkline.js");
const { fillWhy, why, setWhy, createQ, setTipsOpener, markReason, reasonOf, label } = await import("../components/help.js");
const { placePopover, createPopover } = await import("../components/popover.js");
const { pushLayer, closeTopLayer, layerCount } = await import("../components/layers.js");
const { panel, box, emptyState, kv, progressRule } = await import("../components/panel.js");
const { modelFromRead, favoredIds } = await import("../lib/units.js");
const FIX = (await import("../fixtures/fixtures.js")).default;
const PRE = (await import("../fixtures/fixtures.js")).default.preflight.result;

const mount = (el) => (doc.body.append(el), el);

// ---------------------------------------------------------------- field (§5.2; U-11 / F-12: refuse, never clamp silently)
test("field: parse and format use the real minus sign and refuse junk", () => {
  assert.equal(parseNumber("-20"), -20);
  assert.equal(parseNumber("−19.5"), -19.5);
  assert.equal(parseNumber(" 1,25 "), 1.25);
  assert.equal(parseNumber(""), null);
  assert.ok(Number.isNaN(parseNumber("12x")));
  assert.equal(formatNumber(-20), "−20");
  assert.equal(formatNumber(-0.0001, 1), "0.0");
  assert.equal(formatNumber(1.2, 3), "1.200");
});

test("field: judge refuses outside the window with the limit and its source, and lets the caller refuse more", () => {
  const w = { min: -1000, max: 0, unit: "mV", source: "0x28" };
  assert.deepEqual(judge("-20", w), { ok: true, value: -20 });
  assert.deepEqual(judge("-5000", w).why, { key: "refused.below_floor", vars: { value: "−5000", min: "−1000", unit: "mV" } });
  assert.deepEqual(judge("15", w).why, { key: "refused.above_limit", vars: { value: "15", max: "0", unit: "mV", source: "0x28" } });
  assert.equal(judge("abc", w).why.key, "refused.not_a_number");
  assert.equal(judge("-5", { ...w, allow: (v) => (v > -10 ? { key: "refused.positive_offset", vars: {} } : null) }).why.key, "refused.positive_offset");
  assert.deepEqual(judge("-19.53", { ...w, decimals: 1 }), { ok: true, value: -19.5 });
});

test("field: a typed -5000 is refused in place — text kept, reason shown, nothing committed", () => {
  const commits = [];
  const f = createField({ label: "Offset at 48×", hint: "vf.point.offset", unit: "mV", width: 6, value: 0, min: -1000, max: 0, onCommit: (v) => commits.push(v) });
  mount(f.el);
  mount(f.whyEl);
  f.input.focus();
  f.input.value = "-5000";
  key(f.input, "Enter");
  assert.equal(f.el.dataset.state, "refused");
  assert.equal(f.input.getAttribute("aria-invalid"), "true");
  assert.equal(f.input.value, "-5000", "the typed text is kept");
  assert.equal(text(f.whyEl), "Refused−5000 is below the field’s floor of −1000 mV. Nothing changed.");
  assert.equal(f.whyEl.dataset.kind, "refused");
  assert.equal(f.input.getAttribute("aria-describedby"), f.whyEl.id);
  assert.deepEqual(commits, []);
  assert.equal(f.value(), 0);
  // Esc restores the value it had on focus and clears the refusal
  const esc = key(f.input, "Escape");
  assert.ok(esc.defaultPrevented);
  assert.equal(f.input.value, "0");
  assert.equal(f.el.dataset.state, "idle");
  assert.equal(f.whyEl.hidden, true);
  // a legal value commits
  f.input.value = "−20";
  key(f.input, "Enter");
  assert.deepEqual(commits, [-20]);
  assert.equal(f.input.value, "−20");
});

test("field: ↑/↓ step, Shift and PageUp/PageDown step ten, stepping stops at the bound; a warning does not refuse", () => {
  const commits = [];
  const f = createField({ label: "PL1", unit: "W", width: 5, value: 250, min: 1, max: 255, stepper: true, onCommit: (v) => commits.push(v), warn: (v, prev) => (Math.abs(v - prev) > 5 ? { key: "warn.pl2_below_pl1", vars: {} } : null) });
  mount(f.el);
  key(f.input, "ArrowDown");
  key(f.input, "ArrowDown", { shiftKey: true });
  key(f.input, "PageUp");
  key(f.input, "PageUp");
  assert.deepEqual(commits, [249, 239, 249, 255]);
  assert.equal(f.whyEl.dataset.kind, "warn", "a large step warns but commits");
  assert.equal(stepValue(-995, -10, { min: -1000, max: 0 }), -1000);
  const [lower, raise] = f.el.querySelectorAll("button");
  assert.equal(lower.getAttribute("aria-label"), "Lower");
  assert.equal(raise.getAttribute("tabindex"), "-1", "steppers stay off the Tab order; keys step");
  fire(lower, "click");
  assert.equal(commits.at(-1), 254);
});

test("field: reading and disabled lock the input with their why line; mixed empties it with the range as placeholder", () => {
  const f = createField({ label: "Whole curve", unit: "mV", value: -10, min: -1000, max: 0, placeholder: "−20…0" });
  f.setState("reading", "locked.reading");
  assert.equal(f.el.dataset.state, "reading");
  assert.ok(f.input.disabled);
  assert.equal(text(f.whyEl), "ReadingEdits wait until the read finishes.");
  f.setState("mixed");
  assert.equal(f.input.value, "");
  assert.equal(f.input.placeholder, "−20…0");
  assert.ok(!f.input.disabled);
  assert.throws(() => f.setState("refused"));
});

// ---------------------------------------------------------------- buttons (§5.1)
test("buttons: the ladder, the cost tag, busy with a progress fraction", () => {
  const b = button({ level: 1, label: "Read", cost: "132 req", id: "rb", hint: "state.read" });
  assert.equal(b.dataset.level, "1");
  assert.equal(b.dataset.hint, "state.read");
  assert.equal(text(b), "Read132 req");
  setBusy(b, "Reading 46 / 132", 46 / 132);
  assert.equal(b.getAttribute("aria-busy"), "true");
  assert.equal(b.style.getPropertyValue("--p"), String(46 / 132));
  setBusy(b, null);
  assert.equal(b.getAttribute("aria-busy"), null);
  setButton(b, { cost: null });
  assert.equal(b.children[1].hidden, true);
  assert.throws(() => button({ level: 5 }));
  assert.equal(button({ level: 4, label: "Apply 2 writes" }).dataset.level, "4");
});

test("buttons: the inline confirm replaces the control; Keep and Esc keep, the answer runs after the control is back", () => {
  const host = mount(doc.createElement("div"));
  const ctl = button({ label: "Discard all" });
  host.append(ctl);
  let done = "";
  let c = confirmInPlace(ctl, { text: "Discard all 5 edits?", confirmLabel: "Discard", keepLabel: "Keep", onConfirm: () => (done = "yes"), onKeep: () => (done = "keep") });
  assert.equal(ctl.hidden, true);
  assert.equal(host.querySelector("[data-confirm=open]"), c.el);
  assert.equal(doc.activeElement, c.no, "focus starts on the safe answer");
  key(c.el, "Escape");
  assert.equal(done, "keep");
  assert.equal(ctl.hidden, false);
  assert.equal(host.querySelector("[data-confirm=open]"), null);
  assert.equal(layerCount(), 0);
  c = confirmInPlace(ctl, { text: "Discard all 5 edits?", confirmLabel: "Discard", onConfirm: () => (done = "yes") });
  c.yes.click();
  assert.equal(done, "yes");
  assert.equal(layerCount(), 0);
});

// ---------------------------------------------------------------- segmented, tabs (§5.3, §5.4)
test("segmented: one pressed, arrows move and select, disabled options are skipped", () => {
  const seen = [];
  const s = createSegmented({ options: [{ value: "1", label: "1 min" }, { value: "5", label: "5 min" }, { value: "15", label: "15 min", disabled: true }], value: "1", label: "Window", onChange: (v) => seen.push(v) });
  mount(s.el);
  const pressed = () => s.el.querySelectorAll("[aria-pressed=true]").map((b) => b.dataset.value);
  assert.deepEqual(pressed(), ["1"]);
  key(s.el, "ArrowRight");
  key(s.el, "ArrowRight");
  assert.deepEqual(seen, ["5", "1"], "15 is disabled, so the second step wraps to 1");
  assert.throws(() => createSegmented({ options: [{ value: 1, label: "a" }] }));
});

test("tabs: roving tabindex, arrows select, the edit mark follows the data, ids keep their prefix", () => {
  const sel = [];
  const t = createTabs({ tabs: [{ id: "cores", label: "Cores", edited: true }, { id: "power", label: "Power" }], selected: "cores", idPrefix: "subtab-", onSelect: (id) => sel.push(id) });
  mount(t.el);
  const cores = t.el.querySelector("#subtab-cores");
  assert.equal(cores.getAttribute("aria-selected"), "true");
  assert.equal(cores.dataset.edited, "true");
  assert.equal(t.el.querySelector("#subtab-power").tabIndex, -1);
  key(t.el, "ArrowRight");
  assert.deepEqual(sel, ["power"]);
  t.update({ tabs: [{ id: "cores", label: "Cores" }, { id: "power", label: "Power", edited: true }], selected: "power" });
  assert.equal(t.el.querySelector("#subtab-cores"), cores, "same ids: updated in place");
  assert.equal(cores.dataset.edited, undefined);
  assert.equal(t.el.querySelector("#subtab-power").getAttribute("aria-selected"), "true");
});

// ---------------------------------------------------------------- annunciators, tags (§5.5–§5.6)
test("annunciator: states, pip and duty change in place; a tag is static", () => {
  const a = annunciator({ label: "PL1", ann: "pl1", hint: "ann.pl1", onClick: () => {} });
  assert.equal(a.tagName, "BUTTON");
  assert.equal(a.getAttribute("aria-expanded"), "false");
  setAnn(a, { state: "lit-warn", duty: "30%" });
  assert.equal(a.dataset.state, "lit-warn");
  assert.equal(text(a), "PL130%");
  setAnn(a, { state: "idle", duty: null });
  assert.equal(a.dataset.state, undefined);
  const h = annunciator({ label: "Helper", pip: "ok" });
  assert.equal(h.tagName, "SPAN");
  assert.equal(h.querySelector("[data-pip]").dataset.pip, "ok");
  setAnn(h, { pip: "off" });
  assert.equal(h.querySelector("[data-pip]"), null, "off = a hollow pip");
  assert.throws(() => setAnn(a, { state: "green" }));
  assert.equal(tag("Mailbox · cold boot clears", "persist").dataset.tag, "persist");
});

// ---------------------------------------------------------------- table (§5.8)
test("table: units in the header, numeric columns, value grammar on cells, group rows, rows update in place", () => {
  const t = createTable({ columns: [{ key: "pt", label: "Pt", num: true }, { key: "f", label: "Factory", unit: "V", num: true }, { key: "o", label: "Offset", unit: "mV", num: true }], foot: "Offset field −1000…0 mV" });
  t.setRows([{ key: "g", group: { label: "P-cores", n: 8 } }, { key: "1", cells: { pt: 1, f: { text: "0.693", v: "base" }, o: { text: "−20", v: "set" } }, state: "edit" }, { key: "2", cells: { pt: 2, f: null, o: { text: "n/a", na: true } } }]);
  const th = t.table.querySelectorAll("th[data-col]");
  assert.deepEqual(th.map((x) => text(x)), ["Pt", "FactoryV", "OffsetmV"]);
  const r1 = t.row("1");
  assert.equal(r1.dataset.state, "edit");
  assert.equal(r1.querySelectorAll("td")[2].dataset.v, "set");
  assert.equal(t.row("2").querySelectorAll("td")[1].dataset.v, "none");
  assert.equal(text(t.row("2").querySelectorAll("td")[1]), "—");
  assert.equal(text(t.row("2").querySelectorAll("td")[2]), "n/a");
  t.setRows([{ key: "g", group: { label: "P-cores", n: 8 } }, { key: "1", cells: { pt: 1, f: { text: "0.693", v: "base" }, o: { text: "0" } } }, { key: "2", cells: { pt: 2, f: null, o: "1" } }]);
  assert.equal(t.row("1"), r1, "same keys: the row element survives");
  assert.equal(r1.dataset.state, undefined);
  assert.deepEqual(cellValue(3), { text: "3", v: null, na: false, node: null });
});

// ---------------------------------------------------------------- unit table (§5.13)
const MODEL = modelFromRead(FIX["tune-read"].result);

test("unit table: rows from the read model and from the topology; P / E / ring groups; E-clusters show their CPU range", () => {
  const units = unitsFromModel(MODEL, favoredIds(MODEL));
  assert.deepEqual(units.map((u) => u.kind).join(""), "PPPPPPPPEEEER");
  const ec0 = units.find((u) => u.id === "EC0");
  assert.equal(ec0.sub, "8–11");
  assert.equal(units.find((u) => u.id === "P0").sub, "cpu 0");
  const topo = unitsFromTopology(PRE.topology);
  assert.ok(topo.length >= 12 && topo.every((u) => u.kind !== "R"));
  assert.equal(topo.find((u) => u.id === "P0").fav, true);
  const t = createUnitTable({ units, columns: [{ key: "top", label: "Top", unit: "×", num: true, value: (u) => ({ text: u.id === "Ring" ? "39" : "57", v: "base" }) }] });
  assert.deepEqual(t.table.querySelectorAll("tr[data-group]").map((r) => r.dataset.group), ["P", "E", "R"]);
  assert.equal(t.table.getAttribute("aria-multiselectable"), "true");
  assert.equal(t.row("EC0").querySelector("td[data-col=top]").dataset.v, "base");
});

test("unit table: click, Ctrl-click and Shift-click; ↑/↓ move; Space toggles; Ctrl+A takes the focused kind", () => {
  assert.deepEqual(clickSelect(["a", "b", "c", "d"], ["a"], "a", "c", { shift: true }), { ids: ["a", "b", "c"], anchor: "a" });
  assert.deepEqual(clickSelect(["a", "b", "c"], ["a", "c"], "a", "c", { ctrl: true }), { ids: ["a"], anchor: "c" });
  const seen = [];
  const t = createUnitTable({ units: unitsFromModel(MODEL), onSelect: (ids) => seen.push(ids.join(",")) });
  mount(t.el);
  fire(t.row("P1"), "click");
  fire(t.row("P3"), "click", { ctrlKey: true });
  fire(t.row("P5"), "click", { shiftKey: true });
  fire(t.row("P1"), "click", { shiftKey: true, ctrlKey: true });
  assert.deepEqual(seen, ["P1", "P1,P3", "P3,P4,P5", "P3,P4,P5,P1,P2"], "Shift: the range from the last clicked row; Ctrl+Shift adds it");
  assert.equal(t.row("P2").getAttribute("aria-selected"), "true");
  key(t.row("P5"), "ArrowDown");
  assert.deepEqual(t.selection(), ["P6"]);
  assert.equal(doc.activeElement, t.row("P6"));
  key(t.row("P6"), " ");
  assert.deepEqual(t.selection(), []);
  key(t.row("P6"), "a", { ctrlKey: true });
  assert.deepEqual(t.selection(), ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
});

test("unit table: the check column toggles membership; marks give the edit edge; live columns refresh in place", () => {
  let clock = 5.5;
  const edited = new Set(["P0"]);
  const t = createUnitTable({ units: unitsFromModel(MODEL), check: true, marks: (u) => edited.has(u.id), columns: [{ key: "clk", label: "Clock", unit: "GHz", num: true, value: () => clock.toFixed(2) }, { key: "busy", label: "Busy", value: () => "62", bar: () => 0.62 }] });
  mount(t.el);
  fire(t.row("EC1"), "click");
  fire(t.row("EC2"), "click");
  assert.deepEqual(t.selection(), ["EC1", "EC2"]);
  assert.equal(t.row("EC1").querySelector("input").checked, true);
  assert.equal(t.row("P0").dataset.state, "edit");
  const cell = t.row("P0").querySelector("td[data-col=clk]");
  clock = 4.25;
  edited.clear();
  t.refresh();
  assert.equal(t.row("P0").querySelector("td[data-col=clk]"), cell, "the cell survives a refresh");
  assert.equal(text(cell), "4.25");
  assert.equal(t.row("P0").dataset.state, undefined);
  assert.equal(t.row("P0").querySelector("[data-col=busy] [data-part=bar]").style.getPropertyValue("--p"), "0.62");
});

// ---------------------------------------------------------------- plot core + sparkline (§5.14)
test("plot: nice ticks without float dust, a real x scale, traces and markers, a pinned readout the keyboard can move", () => {
  assert.deepEqual(niceTicks(0.6, 1.5, 4), [0.6, 0.8, 1, 1.2, 1.4]);
  assert.deepEqual(niceTicks(0, 60, 6), [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(scale(0, 60, 44, 586)(30), 315);
  assert.equal(nearestStop([8, 20, 48, 57], 50), 48);
  const p = createPlot({ label: "V/F curve", width: 640, x: { min: 0, max: 60, fmt: (t) => `${t}×` }, y: { min: 0.6, max: 1.5, fmt: (t) => t.toFixed(1), title: "V" }, readout: (x) => [[`${x}×`, ""], ["now", "1.032"]] });
  p.draw({ traces: [{ kind: "base", pts: [[8, 0.69], [48, 1.04]] }, { kind: "set", pts: [[8, 0.69], [48, 1.02]] }], markers: [{ x: 8, y: 0.69, kind: "meas" }, { x: 48, y: 1.02, kind: "set" }, { x: 57, y: 1.43, kind: "solid", shape: "dia" }], refs: [{ y: 1.4, label: "TjMax" }] });
  assert.equal(p.svg.getAttribute("viewBox"), "0 0 640 220");
  assert.equal(p.svg.querySelectorAll("polyline").length, 2);
  assert.equal(p.svg.querySelectorAll("rect").length, 2);
  assert.equal(p.svg.querySelectorAll("path").length, 1, "the diamond: a value read from the CPU");
  assert.equal(p.el.querySelector("[aria-live]").hidden, true);
  key(p.svg, "ArrowRight");
  assert.equal(p.cursor(), 8);
  key(p.svg, "End");
  assert.equal(p.cursor(), 57);
  assert.equal(p.svg.querySelectorAll("[data-part=cursor]").length, 1);
  assert.equal(text(p.el.querySelector("[aria-live]")), "57× now 1.032");
});

test("sparkline: gaps break the line, no data draws nothing", () => {
  assert.equal(sparkD([], 44, 14), "");
  assert.equal(sparkD([1, null, 3], 44, 14).split("M").length - 1, 2);
  const s = createSparkline();
  assert.equal(s.el.getAttribute("aria-hidden"), "true");
  s.draw([1, 2, 3]);
  assert.equal(s.el.dataset.empty, "false");
  assert.equal(createSparkline({ label: "PKG, last 60 s" }).el.getAttribute("role"), "img");
});

// ---------------------------------------------------------------- help: why lines, reasons, "?" (§6)
test("help: WHY templates fill their names, unknown keys throw, an empty why line is hidden", () => {
  assert.deepEqual(fillWhy("locked.read_only", { reason: "msr_allow_writes: unknown" }), { lead: "Locked", text: "Read-only mode: msr_allow_writes: unknown. See System › Preflight.", kind: "locked" });
  assert.equal(fillWhy("warn.large_step", { value: "−150" }).kind, "warn");
  assert.throws(() => fillWhy("refused.nope"));
  const w = why(null);
  assert.equal(w.hidden, true);
  setWhy(w, "refused.uncore_order", { max: 42 });
  assert.equal(w.dataset.kind, "refused");
  assert.equal(text(w), "RefusedThe minimum may not be above the maximum (42×).");
  const b = button({ label: "Restore accepted…" });
  markReason(b, "locked.no_link");
  assert.equal(reasonOf(b).lead, "Unavailable");
  markReason(b, null, {}, { text: "no 'core' subdomain" });
  assert.deepEqual(reasonOf(b), { lead: "n/a", text: "no 'core' subdomain", kind: "locked" });
  markReason(b, null);
  assert.equal(reasonOf(b), null);
  assert.equal(text(label("power.pl1")), "Long-term limitPL1");
});

test("help: the ? expander opens in place, one per panel, Esc collapses and refocuses, More in Tips calls the opener", () => {
  const p = panel({ title: "Power" });
  mount(p.el);
  const a = createQ("power.pl1");
  const b = createQ("power.pl2");
  p.body.append(a.button, a.more, b.button, b.more);
  a.button.click();
  assert.equal(a.button.getAttribute("aria-expanded"), "true");
  assert.equal(a.more.hidden, false);
  assert.equal(a.button.getAttribute("aria-controls"), a.more.id);
  b.button.click();
  assert.equal(a.more.hidden, true, "opening another closes the first");
  assert.equal(b.more.hidden, false);
  key(b.more, "Escape");
  assert.equal(b.more.hidden, true);
  assert.equal(doc.activeElement, b.button);
  let opened = null;
  setTipsOpener((id) => (opened = id));
  b.button.click();
  const link = b.more.querySelector("[data-tip]");
  assert.match(text(link), /^More in Tips › /);
  link.click();
  assert.equal(opened, "power");
  b.close();
  const row = createQ("vf.point.offset", { colspan: 7 });
  assert.equal(row.more.tagName, "TR");
  assert.equal(row.more.querySelector("td").getAttribute("colspan"), "7");
  assert.equal(layerCount(), 0);
});

// ---------------------------------------------------------------- popover + layers (§5.11; F-10, F-11)
test("popover: below and left-aligned by default, flips above at the foot, right-aligns, stays inside the window", () => {
  const view = { width: 960, height: 600 };
  assert.deepEqual(placePopover({ left: 100, right: 160, top: 20, bottom: 40 }, { width: 300, height: 200 }, view), { x: 100, y: 44, place: "below" });
  assert.deepEqual(placePopover({ left: 700, right: 740, top: 576, bottom: 594 }, { width: 420, height: 320 }, view, { align: "right", place: "above" }), { x: 320, y: 252, place: "above" });
  assert.deepEqual(placePopover({ left: 900, right: 950, top: 576, bottom: 594 }, { width: 420, height: 320 }, view), { x: 532, y: 252, place: "above" });
});

test("popover: Esc closes and gives focus back to the trigger; a click outside closes; the Escape stack closes the newest first", () => {
  const trig = mount(button({ label: "PL1" }));
  const pop = createPopover({ label: "Limit reasons" });
  const inner = button({ label: "Reset indicators" });
  pop.el.append(inner);
  pop.open(trig);
  assert.equal(pop.isOpen(), true);
  assert.equal(trig.getAttribute("aria-expanded"), "true");
  assert.equal(doc.activeElement, inner, "focus on the first control");
  key(inner, "Escape");
  assert.equal(pop.isOpen(), false);
  assert.equal(doc.activeElement, trig);
  pop.open(trig);
  fire(doc.body, "pointerdown");
  assert.equal(pop.isOpen(), false);
  const order = [];
  pushLayer(() => order.push("sheet-ish"));
  pop.open(trig);
  assert.equal(closeTopLayer(), true);
  assert.equal(pop.isOpen(), false, "the popover opened last closes first");
  closeTopLayer();
  assert.deepEqual(order, ["sheet-ish"]);
  assert.equal(closeTopLayer(), false);
});

// ---------------------------------------------------------------- panels (§5.9, §5.12)
test("panel, box, kv, empty state, progress rule", () => {
  const p = panel({ title: "Limits", meta: "read from this CPU", body: kv([["PL1", "250 W", { mono: true }]]) });
  assert.equal(p.el.getAttribute("aria-label"), "Limits");
  p.setMeta("Reading 46 / 132");
  assert.match(text(p.el), /Reading 46 \/ 132/);
  assert.equal(box({ kind: "fault", title: "Refused" }).getAttribute("role"), "alert");
  assert.throws(() => box({ kind: "red" }));
  const e = emptyState({ title: "No read yet", teach: "Tune edits a copy.", action: button({ level: 1, label: "Read" }), cost: "About 1 s." });
  assert.equal(e.dataset.empty, "true");
  assert.equal(progressRule(0.5).getAttribute("aria-valuenow"), "50");
});
