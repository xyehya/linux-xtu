// G-248 item 1: the mock backend's audit.tail honours `before` and answers start / end / size / older like helper/ops.py op_audit_tail.
import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURES, AUDIT_RECORD_BYTES, auditTailPage } from "../fixtures/mock-backend.js";

const log = FIXTURES.auditTail.result;

test("audit.tail mock: the newest page carries start / end / size / older", () => {
  const all = log.records.length;
  const p = auditTailPage(log, { n: 5 });
  assert.deepEqual(p.records, log.records.slice(all - 5));
  assert.equal(p.size, all * AUDIT_RECORD_BYTES);
  assert.equal(p.end, p.size);
  assert.equal(p.start, (all - 5) * AUDIT_RECORD_BYTES);
  assert.equal(p.older, true);
  assert.equal(p.truncated, true);
});

test("audit.tail mock: `before` pages back to the start of the log, then there is nothing older", () => {
  const all = log.records.length;
  const first = auditTailPage(log, { n: 8 });
  const second = auditTailPage(log, { n: 8, before: first.start });
  assert.deepEqual(second.records, log.records.slice(all - 16, all - 8));
  assert.equal(second.end, first.start);
  assert.equal(second.older, true);
  assert.equal(second.truncated, true, "a page before another is never the whole log");
  const third = auditTailPage(log, { n: 8, before: second.start });
  assert.deepEqual(third.records, log.records.slice(0, all - 16));
  assert.equal(third.start, 0);
  assert.equal(third.older, false);
  const none = auditTailPage(log, { n: 8, before: 0 });
  assert.deepEqual(none.records, []);
  assert.equal(none.older, false);
  assert.equal(none.start, 0);
});

test("audit.tail mock: whole log in one page, before null and an offset past the end behave like the helper", () => {
  const whole = auditTailPage(log, { n: 200 });
  assert.equal(whole.records.length, log.records.length);
  assert.equal(whole.start, 0);
  assert.equal(whole.older, false);
  assert.equal(whole.truncated, false);
  assert.deepEqual(auditTailPage(log, { n: 200, before: null }), whole);
  assert.deepEqual(auditTailPage(log, { n: 200, before: 1e9 }).records, whole.records, "before past the end is clamped to the size");
});
