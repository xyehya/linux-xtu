// G-248 item 5 (QA-11): the two read-back records of a turbo write are one Audit row. No DOM, no helper.
import test from "node:test";
import assert from "node:assert/strict";
import { install } from "./fakedom.mjs";

install();
const A = await import("../views/audit.js");

const base = { operator: "gui:uid1000", msr: "0x000001AD", expected: "0x3737373739393939", event: "readback", verified: true };
const rb0 = { ...base, seq: 11, ts: "2026-11-12T08:41:23.000+00:00", cpu: 0, readback_cpu: 0, value: "0x3737373739393939" };
const rb8 = { ...base, seq: 12, ts: "2026-11-12T08:41:23.010+00:00", cpu: 0, readback_cpu: 8, value: "0x3737373739393939" };
const write = { operator: "gui:uid1000", seq: 10, ts: "2026-11-12T08:41:22.990+00:00", event: "attempt", cpu: 0, msr: "0x000001AD", msr_kind: "write" };

test("pairReadbacks: adjacent read-backs of one MSR write on two CPUs are one pair; anything else is left alone", () => {
  assert.deepEqual(A.pairReadbacks([write, rb0, rb8]), [{ rec: write }, { rec: rb0, also: rb8 }]);
  assert.deepEqual(A.pairReadbacks([rb0, { ...rb8, readback_cpu: 0 }]).length, 2, "the same CPU twice is not a pair");
  assert.equal(A.pairReadbacks([rb0, { ...rb8, msr: "0x00000150" }]).length, 2);
  assert.equal(A.pairReadbacks([rb0, { ...rb8, operator: "cli" }]).length, 2);
  assert.equal(A.pairReadbacks([rb0, write, rb8]).length, 3, "not adjacent");
  assert.equal(A.pairReadbacks([{ event: "readback", cmd: "0x10", pending: true }, { event: "readback", cmd: "0x10", pending: true }]).length, 2, "mailbox read-backs have no readback_cpu");
  assert.deepEqual(A.pairReadbacks(null), []);
});

test("auditRow / auditRows: 'read back on CPU 0 and 8' is ONE row, verified only when both are", () => {
  const row = A.auditRow(rb0, rb8);
  assert.equal(row.detail, "read back on CPU 0 and 8");
  assert.equal(row.verdict, "verified");
  assert.equal(row.seq, "11");
  const rows = A.auditRows([write, rb0, rb8]);
  assert.equal(rows.length, 2, "the write and ONE read-back row");
  assert.equal(rows[0].detail, "read back on CPU 0 and 8", "newest first");
  assert.equal(A.auditRows([write, rb0, rb8], { filter: "writes" }).length, 2, "the read-back stays in the Changes filter");
  const bad = A.auditRow(rb0, { ...rb8, verified: false });
  assert.equal(bad.verdict, "MISMATCH");
  assert.equal(bad.resultKind, "error");
  assert.equal(bad.eventKind, "error");
  assert.equal(A.auditRow(rb0).detail, "", "a lone read-back is unchanged");
});
