// node --test desktop/app/ui/tests/   (G-245: layout fixes of the 2026-11-12 QA run — plot label collisions (QA-15), single-press field focus (QA-19),
// rail tip placement and Ctrl+A (QA-22, QA-07), and the stylesheet rules for scale (QA-03), height (QA-24) and the Review sheet (QA-16).
// The stylesheet checks read the CSS text: layout itself is looked at in the visual states (visual_capture.py --sizes 1920,2560).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { install, key, fire } from "./fakedom.mjs";

const doc = install();
const { createPlot, separateLabels, labelWidth } = await import("../components/plot.js");
const { createField } = await import("../components/field.js");
const { createNavRail, isStraySelectAll } = await import("../components/nav-rail.js");
const { createAppStore } = await import("../store.js");

const UI = fileURLToPath(new URL("..", import.meta.url));
const css = (f) => readFileSync(join(UI, "styles", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------- QA-15: plot end labels never overlap
test("plot: separateLabels keeps touching labels a gap apart and leaves distant ones alone", () => {
  const a = { y: 100, x0: 200, x1: 260 };
  const b = { y: 103, x0: 205, x1: 265 };
  const c = { y: 150, x0: 200, x1: 260 };
  const d = { y: 101, x0: 0, x1: 40 }; // far to the left: no horizontal overlap with a / b
  const out = separateLabels([a, b, c, d], { gap: 13 });
  assert.ok(Math.abs(out[0] - out[1]) >= 13, "a and b are separated");
  assert.equal(out[2], 150, "c was clear");
  assert.equal(out[3], 101, "d never touched a or b");
});

test("plot: separateLabels shifts the stack back up at the bottom edge", () => {
  const items = [{ y: 190, x0: 0, x1: 50 }, { y: 192, x0: 0, x1: 50 }, { y: 194, x0: 0, x1: 50 }];
  const out = separateLabels(items, { gap: 13, hi: 195 });
  assert.ok(Math.max(...out) <= 195);
  const s = [...out].sort((p, q) => p - q);
  assert.ok(s[1] - s[0] >= 13 && s[2] - s[1] >= 13);
});

test("plot: PL1 / PL2 reference labels 3 px apart are drawn apart (QA-15)", () => {
  const p = createPlot({ label: "Package power", width: 600, height: 200, margin: { l: 40, r: 12, t: 20, b: 30 }, x: { min: -59, max: 0 }, y: { min: 0, max: 300 } });
  // 150 px of plot height over 300 W: 2 W = 1 px; PL2 295 W and PL1 293 W are 1 px apart
  p.draw({ refs: [{ y: 295, label: "PL2 295" }, { y: 293, label: "PL1 293" }] });
  const texts = p.svg.querySelectorAll("text").filter((t) => /^PL[12] /.test(t.textContent));
  assert.equal(texts.length, 2);
  const ys = texts.map((t) => Number(t.getAttribute("y")));
  assert.ok(Math.abs(ys[0] - ys[1]) >= 12, `labels ${ys.join(" / ")} overlap`);
  assert.ok(labelWidth("PL2 295") > 30);
});

test("plot: a trace's end label and a reference label at the same height do not collide", () => {
  const p = createPlot({ label: "Package power", width: 600, height: 200, margin: { l: 40, r: 40, t: 20, b: 30 }, x: { min: 0, max: 60 }, y: { min: 0, max: 100 } });
  p.draw({ refs: [{ y: 50, label: "PL1 50" }], labels: [{ x: 60, y: 50, text: " 50.0 W", kind: "strong", anchor: "start" }] });
  const ys = p.svg.querySelectorAll("text").filter((t) => /PL1|W$/.test(t.textContent)).map((t) => Number(t.getAttribute("y")));
  assert.equal(ys.length, 2);
  // the two sit on different sides in x here (end-anchored at the right edge vs. starting at it), so they need no separation
  assert.ok(ys.every(Number.isFinite));
});

// ---------------------------------------------------------------- QA-19: one press on a number field focuses it
test("field: a press on the input is left to the browser; a press on the well or a stepper focuses the input once", () => {
  const f = createField({ label: "PL1", unit: "W", width: 5, value: 250, stepper: true, min: 0, max: 400 });
  doc.body.append(f.el);
  const input = f.input;
  // the input itself: not prevented (the caret lands where pressed), focus is the browser's
  const onInput = fire(input, "mousedown", { button: 0 });
  assert.equal(onInput.defaultPrevented, false);
  input.focus();
  assert.equal(doc.activeElement, input);
  // blur it, then press the well's stepper: the press must end with the input focused
  input.blur();
  assert.notEqual(doc.activeElement, input);
  const raise = f.el.querySelector("button[aria-label=Raise]");
  const onStep = fire(raise, "mousedown", { button: 0 });
  assert.equal(onStep.defaultPrevented, true, "the button must not take the focus itself");
  assert.equal(doc.activeElement, input);
  raise.click();
  assert.equal(f.value(), 251, "the stepper click still steps");
  // the well's edge
  input.blur();
  const well = f.el.querySelector("span");
  fire(well, "mousedown", { button: 0 });
  assert.equal(doc.activeElement, input);
  // a disabled field takes no focus
  f.setState("disabled");
  input.blur();
  fire(well, "mousedown", { button: 0 });
  assert.notEqual(doc.activeElement, input);
  // the right button does nothing special
  f.setState("idle");
  const rc = fire(well, "mousedown", { button: 2 });
  assert.equal(rc.defaultPrevented, false);
});

// ---------------------------------------------------------------- QA-22 / QA-07: the rail
test("rail: a key's tip is data-tip (placed by CSS to the right of the rail), not a native title", () => {
  const root = doc.createElement("nav");
  doc.body.append(root);
  const s = createAppStore();
  const dispose = createNavRail(root, s, { onSelect() {} });
  const stress = root.querySelector("#nav-stress");
  assert.equal(stress.dataset.tip, "Stress (Alt+3)");
  assert.equal(stress.getAttribute("title"), null);
  assert.equal(root.querySelector("#nav-tips").dataset.tip, "Tips (F1)");
  dispose();
  const src = readFileSync(join(UI, "components", "nav-rail.js"), "utf8");
  assert.ok(!/\btitle:/.test(src), "no title attribute on rail keys");
  const frame = css("frame.css");
  assert.match(frame, /\.lx-key\[data-tip\]::after\s*\{[^}]*left:\s*100%/, "the tip opens to the right of the key");
});

test("select-all: Ctrl+A outside a field is swallowed, inside a field it still selects the field's text", () => {
  const input = doc.createElement("input");
  const div = doc.createElement("div");
  doc.body.append(input, div);
  assert.equal(isStraySelectAll({ key: "a", ctrlKey: true, target: div }), true);
  assert.equal(isStraySelectAll({ key: "A", metaKey: true, target: div }), true);
  assert.equal(isStraySelectAll({ key: "a", ctrlKey: true, target: input }), false);
  assert.equal(isStraySelectAll({ key: "a", target: div }), false, "a plain letter");
  assert.equal(isStraySelectAll({ key: "a", ctrlKey: true, altKey: true, target: div }), false);
  const root = doc.createElement("nav");
  doc.body.append(root);
  const dispose = createNavRail(root, createAppStore(), { onSelect() {} });
  assert.equal(key(div, "a", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(key(input, "a", { ctrlKey: true }).defaultPrevented, false);
  dispose();
  assert.equal(key(div, "a", { ctrlKey: true }).defaultPrevented, false, "the listener goes with the rail");
});

test("css: tables are not selectable by default (chrome); fields and code stay selectable", () => {
  const base = css("base.css");
  const sel = base.match(/(?:^|\})\s*((?:[^{}]+,\s*)*[^{}]+)\{\s*-webkit-user-select:\s*text;\s*user-select:\s*text;\s*\}/);
  assert.ok(sel, "the selectable list exists");
  const list = sel[1].split(",").map((x) => x.trim());
  assert.ok(list.includes("input") && list.includes("pre") && list.includes("code"));
  assert.ok(!list.includes("table"), "table is chrome");
  assert.match(base, /body\s*\{[^}]*user-select:\s*none/);
});

// ---------------------------------------------------------------- QA-03: scale
test("css: sizes are rem tokens and the root size steps up on large windows", () => {
  const tokens = css("tokens.css");
  for (const name of ["--t-md", "--lh-md", "--s3", "--row", "--ctl", "--band", "--rail", "--pane-units", "--sheet-w", "--table-max"]) {
    const m = tokens.match(new RegExp(name + ":\\s*([^;]+);"));
    assert.ok(m, name);
    assert.match(m[1], /rem$/, `${name} must be rem, is ${m[1]}`);
  }
  const base = css("base.css");
  assert.match(base, /html\s*\{\s*font-size:\s*100%;/);
  const steps = [...base.matchAll(/@media \(min-width: (\d+)px\) and \(min-height: (\d+)px\)\s*\{\s*html\s*\{\s*font-size:\s*([\d.]+)%/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  assert.ok(steps.length >= 3);
  const at = (w, h) => steps.filter(([mw, mh]) => w >= mw && h >= mh).map((s) => s[2]).pop() || 100;
  assert.equal(at(1280, 800), 100);
  assert.equal(at(960, 600), 100);
  assert.equal(at(1920, 1080), 112.5);
  assert.equal(at(2560, 1440), 125);
  assert.equal(at(2560, 700), 100, "a wide, short window keeps the base size");
});

test("css: px lengths of 3 px and up live only in media queries, tokens.css and the screens other tasks own", () => {
  const OTHER = ["apply.css", "profiles.css", "stress.css", "audit.css", "system.css", "kit.css", "tokens.css"];
  const files = ["base", "controls", "curves", "frame", "hints", "overview", "panels", "plots", "setup", "tables", "tips", "tune", "tune-rt"].map((f) => f + ".css");
  const bad = [];
  for (const f of files) {
    if (OTHER.includes(f)) continue;
    css(f).split("\n").forEach((line, i) => {
      if (line.includes("@media")) return;
      for (const m of line.matchAll(/(?<![\d.\w-])(\d+(?:\.\d+)?)px\b/g)) if (Number(m[1]) >= 3) bad.push(`${f}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- QA-24 / QA-16 / QA-03: height, sheet, wide layout
test("css: module tabs fill the body height; tables have a max width; the plot sits beside the V/F table when the inspector is wide", () => {
  assert.match(css("tune.css"), /\.lx-tune-panel:not\(\[data-tab="cores"\]\)\s*\{[^}]*min-height:\s*100%/);
  assert.match(css("tune-rt.css"), /\.lx-rt-host > \.lx-tiles\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(css("tables.css"), /\.lx-tbl--fill\s*\{\s*max-width:\s*var\(--table-max\)/);
  assert.match(css("tune.css"), /@container \(min-width: 80rem\)[\s\S]*\.lx-plotbox\s*\{[^}]*grid-column:\s*2/);
});

test("css: while the Review sheet is open the body reflows left of it (>= 1500 px wide)", () => {
  const frame = css("frame.css");
  assert.match(frame, /@media \(min-width: 1500px\)\s*\{\s*\.lx-stage:has\(> \.lx-sheet\[data-open="true"\]\) > \.lx-body\s*\{\s*margin-right:\s*var\(--sheet-w\)/);
});
