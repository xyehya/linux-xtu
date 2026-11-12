// node --test desktop/app/ui/tests/   (G-249 R2-02: PL1 / PL2 reference labels. Fake DOM; no browser, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "./fakedom.mjs";

install();
const { createPlot } = await import("../components/plot.js");

test("R2-02: reference labels of limits 25 W apart (PL4 425 / PL2 295 / PL1 270 on a 459 W axis) neither touch each other nor sit on a reference line", () => {
  const p = createPlot({ label: "Package power", width: 600, height: 200, margin: { l: 40, r: 12, t: 20, b: 30 }, x: { min: -59, max: 0 }, y: { min: 0, max: 459 } });
  try {
    p.draw({ refs: [{ y: 270, label: "PL1 270" }, { y: 295, label: "PL2 295" }, { y: 425, label: "PL4 425" }] });
    const lines = p.svg.querySelectorAll("line").filter((l) => /lx-ref/.test(l.getAttribute("class") || "")).map((l) => Number(l.getAttribute("y1")));
    assert.equal(lines.length, 3);
    const tags = p.svg.querySelectorAll("text").filter((t) => /^PL\d /.test(t.textContent)).map((t) => ({ name: t.textContent.slice(0, 3), y: Number(t.getAttribute("y")) }));
    assert.equal(tags.length, 3);
    const sorted = tags.map((t) => t.y).sort((a, b) => a - b);
    assert.ok(sorted[1] - sorted[0] >= 13 && sorted[2] - sorted[1] >= 13, `labels ${sorted.join(" / ")} touch`);
    for (const t of tags) for (const ly of lines) assert.ok(ly < t.y - 10 || ly > t.y + 1.5, `${t.name} label (baseline ${t.y}) is crossed by the line at ${ly}`);
  } finally {
    p.dispose();
  }
});
