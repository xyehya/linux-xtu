// node --test desktop/app/ui/tests/g251.test.mjs   (G-251: Tune screens say each thing once, in plain words — the shared top ratio, the hints of the Tune screens without register
// numbers, every hint key a Tune view names exists. The per-screen behaviour is tested beside each screen: turbo_frequency, tune_cores, power_view, runtime_uncore.)
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import FIX from "../fixtures/fixtures.js";
import { modelFromRead, topRatio } from "../lib/units.js";
import { emptyDraft, setOcRatio, effRatio } from "../lib/draft.js";
import { HINTS } from "../lib/hints.js";

const model = () => modelFromRead(structuredClone(FIX["tune-read"].result));

test("topRatio: the OC ratio if set, else the fused max ratio of the unit (P favored 57, other P 55, E 46); the ring's highest point", () => {
  const m = model();
  const top = (id, d = emptyDraft()) => topRatio(m, m.units[id], id === "ring" ? null : effRatio(d, m.units[id]));
  assert.deepEqual(top("P0"), { ratio: 57, oc: false, fused: null, boot: false });
  assert.equal(top("P1").ratio, 55, "P1 is not favored: 55, not the curve top 57");
  assert.deepEqual(top("EC0"), { ratio: 48, oc: true, fused: 46, boot: true }, "a ratio the BIOS set above the fused top is an OC top, with the fused value beside it");
  assert.deepEqual(top("P1", setOcRatio(m, emptyDraft(), ["P1"], 58)), { ratio: 58, oc: true, fused: 55, boot: false });
  assert.deepEqual(top("P1", setOcRatio(m, emptyDraft(), ["P1"], 56)), { ratio: 56, oc: true, fused: 55, boot: false }, "above the stock max, on a fused point");
  assert.deepEqual(top("ring"), { ratio: 39, oc: false, fused: null, boot: false });
  assert.equal(topRatio(m, null), null);
});

const TUNE_KEYS = ["unit.topratio", "unit.top", "unit.offset", "unit.clock", "freq.effective", "freq.cap", "turbo.bucket", "turbo.set_all", "turbo.fill_right", "oc.ratio", "oc.voltage",
  "power.pl1", "power.pl2", "power.tau", "power.lock", "power.pl4_copy", "power.binds", "uncore.driver", "uncore.separate", "uncore.min", "uncore.max"];

test("hints of the Tune screens: no register numbers in label or line (they stay in src); the retired per-column hints are gone; the rule hint says the rule", () => {
  for (const k of TUNE_KEYS) {
    const h = HINTS[k];
    assert.ok(h, k + " exists");
    assert.doesNotMatch(h.label + " " + h.line, /0x[0-9a-f]+|\bMSR\b/i, k + ": no register numbers in label or line");
  }
  for (const k of ["freq.maxratio", "freq.oc", "freq.turbo_one", "freq.turbo_all", "freq.binds", "power.live"]) assert.equal(HINTS[k], undefined, k + " is retired");
  assert.equal(HINTS["unit.topratio"].label, "Top ratio");
  assert.match(HINTS["unit.topratio"].line, /OC ratio.*fused maximum/);
  assert.match(HINTS["freq.effective"].line, /lowest of the core’s top ratio, its ratio cap and the turbo-table entry/);
  assert.equal(HINTS["uncore.driver"].label, "At boot", "Ring says At boot like Power");
  assert.equal(HINTS["uncore.separate"].line, "Changes the ring clock only; NGU and D2D clocks are set in the BIOS.");
  assert.equal(HINTS["power.lock"].label, "Locked by the BIOS");
});

test("every hint key a Tune view or lib names exists in HINTS (no dangling data-hint after the G-251 clean-up)", () => {
  const dir = new URL("../views/tune/", import.meta.url);
  const used = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/hint: "([a-z0-9_.]+)"|HINTS\["([a-z0-9_.]+)"\]/g)) used.add(m[1] || m[2]);
  }
  assert.ok(used.size > 10);
  for (const k of used) assert.ok(HINTS[k], "HINTS has " + k);
});
