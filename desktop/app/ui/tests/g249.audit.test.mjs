// G-249 R2-03 / R2-04: a power apply is ONE Audit row with a true read-back verdict; an apply row is named from its closing record's summary, never the plan's internal name.
// No DOM, no helper (record shapes are what ops_power.py / ops_runtime.py / ops_tune_apply.py write).
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "./fakedom.mjs";

install();
const A = await import("../views/audit.js");

const op = "gui:uid1000";
const t = (s) => `2026-11-12T11:53:${String(s).padStart(2, "0")}.000+00:00`;
const pwr = { operator: op, kind: "powercap", key: "pl1_w", plan_id: "p".repeat(64), before: 270000000, written: 265000000, revert: false };

// what the helper writes for one PL1 apply (G-249): reads and sysfs records share the "apply" purpose head; one closing result
const NEW = [
  { operator: op, seq: 1, ts: t(1), event: "msr_read", cpu: 0, msr: "0x610", purpose: "apply: power limits: read MSR 0x610" },
  { ...pwr, seq: 2, ts: t(1), event: "powercap_attempt", purpose: "apply: power limits", detail: "powercap write pl1_w: 270000000 -> 265000000" },
  { operator: op, seq: 3, ts: t(2), event: "msr_read", cpu: 0, msr: "0x610", purpose: "apply: power limits read-back: read MSR 0x610" },
  { ...pwr, seq: 4, ts: t(2), event: "readback", purpose: "apply: power limits", matches: true, detail: "the file and MSR 0x610 show the value written" },
  { operator: op, kind: "powercap", seq: 5, ts: t(2), event: "result", op: "power.apply", outcome: "ok", complete: true, plan_id: pwr.plan_id, revert: false, writes_planned: 1, writes_sent: 1, readback_total: 1, readback_mismatches: 0, summary: "PL1 270 → 265 W" },
];

// the same apply as an older helper logged it: no purpose on the sysfs records, raw read purposes, no closing record
const OLD = [
  { operator: op, seq: 1, ts: t(0), event: "msr_read", cpu: 0, msr: "0x610", purpose: "power.plan: read MSR 0x610" },
  { operator: op, seq: 2, ts: t(1), event: "msr_read", cpu: 0, msr: "0x610", purpose: "power.apply: read MSR 0x610" },
  { ...pwr, seq: 3, ts: t(1), event: "powercap_attempt", detail: "powercap write pl1_w: 270000000 -> 265000000" },
  { operator: op, seq: 4, ts: t(2), event: "msr_read", cpu: 0, msr: "0x610", purpose: "power.apply read-back: read MSR 0x610" },
  { ...pwr, seq: 5, ts: t(2), event: "readback", matches: true, detail: "the file and MSR 0x610 show the value written" },
];

test("R2-03: a power apply (plan reads aside) is ONE operation 'Power limits applied' with its summary and 'read back equal'", () => {
  const ops = A.groupAudit(NEW);
  assert.equal(ops.length, 1, ops.map((o) => o.label).join(" | "));
  const [g] = ops;
  assert.equal(g.label, "Power limits applied");
  assert.equal(g.records.length, 5);
  assert.equal(g.result, "ok");
  assert.equal(g.line, "PL1 270 → 265 W · 1 write · read back equal");
});

test("R2-03: a power restore reads 'Restore boot values'; caps and uncore have their own plain name", () => {
  const rev = A.groupAudit(NEW.map((r) => (r.event === "result" ? { ...r, revert: true } : r)));
  assert.equal(rev[0].label, "Restore boot values");
  const rt = A.groupAudit([{ operator: op, kind: "runtime", seq: 1, ts: t(1), event: "result", op: "runtime.apply", outcome: "ok", complete: true, revert: false, writes_sent: 2, readback_total: 2, readback_mismatches: 0, summary: "cap CPU 3: 5700 → 4500 MHz" }]);
  assert.equal(rt[0].label, "Caps & uncore applied");
});

test("R2-03: an older log (no closing record) still says a matched write read back equal: the powercap read-back's `matches` counts", () => {
  const rows = A.auditRows(OLD);
  const rb = rows.find((r) => r.event === "readback");
  assert.equal(rb.verdict, "verified");
  assert.equal(rb.resultKind === "error", false);
  const ops = A.groupAudit(OLD);
  const apply = ops.find((o) => o.records.some((r) => r.event === "powercap_attempt"));
  assert.match(apply.line, /read back equal/);
  assert.doesNotMatch(apply.line, /0 of 1/);
  assert.equal(apply.records.length, 4, "the reads, the attempt and the read-back are one group, not four rows");
  assert.equal(apply.label, "Power limits applied", "no raw 'Power.apply'");
  assert.equal(A.groupAudit([{ ...OLD[4], matches: false }])[0].result, "mismatch", "a `matches: false` still reads as a mismatch");
});

test("R2-04: an apply row is named from the closing record's summary, not 'Apply tune-0c362b7b'", () => {
  const close = { event: "result", op: "tune.apply", name: "tune-0c362b7b", outcome: "ok", complete: true, writes_sent: 1, readback_total: 1, readback_mismatches: 0, summary: "P0 point 8" };
  assert.equal(A.applyLabel(close), "Apply · P0 point 8");
  assert.equal(A.applyLabel({ ...close, summary: "turbo P" }), "Apply · turbo P");
  assert.equal(A.applyLabel({ ...close, summary: undefined }), "Apply (Tune)");
  assert.equal(A.applyLabel({ ...close, name: "Quick" }), "Apply Quick", "a saved profile keeps its name");
  assert.equal(A.applyLabel({ op: "restore-accepted", name: "accepted" }), "Restore accepted");
});
