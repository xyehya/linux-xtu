// G-248 items 6 and 7 (stylesheet text): a closed sheet takes no pointer events; apply / profiles / stress / audit / system size in rem, not px.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const UI = fileURLToPath(new URL("..", import.meta.url));
const css = (f) => readFileSync(join(UI, "styles", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("item 6: a closed Review sheet is out of the pointer's way (QA-06 / QA-14)", () => {
  const panels = css("panels.css");
  const m = panels.match(/\.lx-sheet\[data-open="false"\]\s*\{([^}]*)\}/);
  assert.ok(m, "the closed-sheet rule exists");
  assert.match(m[1], /pointer-events:\s*none/);
  const open = panels.match(/\.lx-sheet\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(open, /pointer-events:\s*none/, "the open sheet still takes clicks");
});

test("item 7: no px length in apply / profiles / stress / audit / system outside a media query's breakpoint", () => {
  for (const f of ["apply.css", "profiles.css", "stress.css", "audit.css", "system.css"]) {
    const bad = css(f).split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => /\d(\.\d+)?px\b/.test(line) && !/@media/.test(line));
    assert.deepEqual(bad.map(([n, l]) => `${f}:${n} ${l.trim()}`), []);
  }
});
