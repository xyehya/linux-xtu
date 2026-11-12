// node --test desktop/app/ui/tests/   (C13 CSS lint, desktop/DESIGN.md §12: values live in tokens.css only; CSS is loaded only from index.html; one stylesheet
// owns each class. Standard library only; reads files, runs nothing.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, extname } from "node:path";

const UI = fileURLToPath(new URL("..", import.meta.url));
const STYLES = join(UI, "styles");
const read = (p) => readFileSync(p, "utf8");
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")); // keeps line numbers
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const sheets = readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort();
/** The design-system reference page links its own stylesheet (kit.css): not part of the app. */
const KIT_ONLY = ["kit.css"];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return ["tests", "fixtures", "fonts"].includes(f) ? [] : walk(p);
    return [p];
  });
}
const SOURCES = walk(UI).filter((p) => [".js", ".html"].includes(extname(p)));

/** Top-level rules of a stylesheet (at-rule blocks are entered): [{selectors: [..], body, line}]. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const head = m[1].trim();
    if (!head || head.startsWith("@")) continue;
    out.push({ selectors: head.replace(/^@[^{]*\{/, "").split(",").map((s) => s.trim()).filter(Boolean), body: m[2], line: lineOf(css, m.index + m[0].indexOf(head)) });
  }
  return out;
}

test("css: no hex / rgb / hsl colour literal and no px font size outside tokens.css", () => {
  const bad = [];
  for (const f of sheets.filter((x) => x !== "tokens.css")) {
    const css = noComments(read(join(STYLES, f)));
    for (const r of rules(css)) {
      for (const decl of r.body.split(";")) {
        const [prop, ...rest] = decl.split(":");
        const value = rest.join(":");
        if (!prop || !value) continue;
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)) bad.push(`${f}:${r.line} ${prop.trim()}: ${value.trim()}`);
        if (/^\s*font(-size)?\s*$/.test(prop) && /\d(\.\d+)?px\b/.test(value)) bad.push(`${f}:${r.line} ${prop.trim()}: ${value.trim()} (px font size)`);
      }
    }
  }
  assert.deepEqual(bad, [], "use a token from styles/tokens.css");
});

test("ui sources: no colour literal or px font size in JS / HTML (styles carry them, through tokens)", () => {
  const bad = [];
  for (const p of SOURCES) {
    if (p.endsWith("kit.html")) continue; // the reference page shows the token values as text
    const src = read(p);
    for (const m of src.matchAll(/["'`]#[0-9a-fA-F]{3,8}["'`]|font-size\s*:\s*\d+px/g)) bad.push(`${relative(UI, p)}:${lineOf(src, m.index)} ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("no runtime style injection: no installStyles, constructed sheets, injected <link>/<style> or inline style= in the UI sources", () => {
  const bad = [];
  for (const p of SOURCES) {
    const src = read(p);
    const rel = relative(UI, p);
    for (const [re, what] of [
      [/\binstallStyles\b/, "installStyles"],
      [/adoptedStyleSheets|new\s+(?:\w+\.)*CSSStyleSheet\b|\binsertRule\(/, "constructed stylesheet"],
      [/createElement\(\s*["'](?:link|style)["']\s*\)/, "injected <link>/<style>"],
      [/\brel\s*=\s*["']stylesheet["']/, "stylesheet link outside index.html"],
      [/\.style\.(?!setProperty\()/, "inline style property"],
      [/<style[\s>]|\sstyle\s*=\s*["']/, "inline <style> / style attribute"],
    ]) {
      if (rel === "index.html" && what === "stylesheet link outside index.html") continue;
      if (rel === "kit.html" && what === "stylesheet link outside index.html") continue;
      if (re.test(src)) bad.push(`${rel}: ${what}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("index.html links stylesheets that exist, and every styles/*.css is linked (kit.css by kit.html)", () => {
  const linked = (html) => [...read(join(UI, html)).matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map((m) => m[1]);
  const app = linked("index.html");
  for (const href of app) assert.ok(existsSync(join(UI, href)), `index.html links ${href}, which does not exist`);
  assert.equal(new Set(app).size, app.length, "a stylesheet is linked twice");
  for (const f of sheets) {
    if (KIT_ONLY.includes(f)) assert.ok(linked("kit.html").includes(`styles/${f}`), `${f} is linked by kit.html`);
    else assert.ok(app.includes(`styles/${f}`), `styles/${f} is not linked from index.html`);
  }
  assert.ok(!app.includes("styles/kit.css"), "the kit's own stylesheet stays out of the app");
});

test("one stylesheet owns each class: a class is defined (a selector that is the class alone, with its states) in one file only", () => {
  // `.x`, `.x:hover`, `.x[data-state]`, `.x::before`, `button.x` define .x; `.panel .x` / `.x > .y` only use it in a context.
  const owner = new Map(); // class -> Set(file)
  for (const f of sheets) {
    const css = noComments(read(join(STYLES, f)));
    for (const r of rules(css)) {
      for (const sel of r.selectors) {
        if (/[\s>+~]/.test(sel.replace(/\[[^\]]*\]|\([^)]*\)/g, ""))) continue; // a context selector
        const m = /^[a-z]*\.((?:[_a-zA-Z][\w-]*))/.exec(sel);
        if (!m) continue;
        if (!owner.has(m[1])) owner.set(m[1], new Set());
        owner.get(m[1]).add(f);
      }
    }
  }
  const twice = [...owner].filter(([, files]) => files.size > 1).map(([c, files]) => `.${c}: ${[...files].join(", ")}`);
  assert.deepEqual(twice, []);
});

test("tokens.css: no temporary alias block, and every custom property a stylesheet reads is defined (or set by code)", () => {
  const tokens = read(join(STYLES, "tokens.css"));
  assert.doesNotMatch(tokens, /ALIAS BLOCK/);
  const defined = new Set();
  const used = new Map();
  for (const f of sheets) {
    const css = noComments(read(join(STYLES, f)));
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) if (!used.has(m[1])) used.set(m[1], f);
  }
  const setByCode = new Set();
  for (const p of SOURCES) for (const m of read(p).matchAll(/(?:setProperty|setVar)\(\s*(?:[\w.]+\s*,\s*)?["'`](--[\w-]+)/g)) setByCode.add(m[1]);
  const missing = [...used].filter(([v]) => !defined.has(v) && !setByCode.has(v)).map(([v, f]) => `${v} (${f})`);
  assert.deepEqual(missing, []);
});
