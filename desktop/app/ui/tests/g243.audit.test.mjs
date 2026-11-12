// G-243 (QA-32, QA-33): the Audit screen reads the whole log in pages, counts an operation from all its records, names runs by their closing record.
// A fake bridge answers audit.tail {n, before} over an in-memory log (the byte offset is the record index here). No helper, no hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { install, fire, text } from "./fakedom.mjs";

const doc = install();
const { createAppStore, setLink } = await import("../store.js");
const { createWorkHead } = await import("../components/workhead.js");
const A = await import("../views/audit.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

let clock = Date.parse("2026-11-12T08:00:00Z");
const iso = () => new Date((clock += 1000)).toISOString();
const rec = (o) => ({ ts: iso(), seq: 0, operator: "gui:uid1000", ...o });
const read = (purpose) => rec({ event: "msr_read", cpu: 0, cmd: "0x10", purpose });
const write = (purpose) => rec({ event: "attempt", cpu: 0, cmd: "0x11", p1: "0x00", p2: "0x04", purpose });

/** 1000 records: an old V/F write at index ~100, then runs of reads, the newest operation an apply with 300 requests that does not fit one page. */
function makeLog() {
  clock = Date.parse("2026-11-12T08:00:00Z");
  const out = [];
  const gap = () => (clock += 30000);
  for (let run = 0; run < 70; run++) {
    gap();
    const kind = run === 6 ? "apply" : "ring read";
    for (let i = 0; i < 10; i++) out.push(kind === "apply" && i === 5 ? write("apply: write V/F point 4") : read(`${kind}: point ${i}`));
  }
  gap();
  for (let i = 0; i < 300; i++) out.push(read(`apply: read V/F point ${i}`)); // the newest operation: 300 requests, more than one page of 200
  out.forEach((r, i) => { r.seq = i; });
  return out;
}

function fakeBridge(log, { paging = true } = {}) {
  const calls = [];
  return {
    calls,
    async call(op, args = {}) {
      calls.push({ op, args });
      if (op !== "audit.tail") return { ok: false, error: { message: "no" } };
      const n = args.n ?? 20;
      const end = args.before === undefined ? log.length : Math.min(args.before, log.length);
      const start = Math.max(0, end - n);
      const records = log.slice(start, end);
      return { ok: true, result: { path: "/audit.jsonl", records, truncated: start > 0, ...(paging ? { start, end, size: log.length, older: start > 0 } : {}) } };
    },
  };
}

async function mount(log, opts) {
  const bridge = fakeBridge(log, opts);
  const store = createAppStore();
  setLink(store, { state: "connected", kind: null, message: "" });
  const headEl = doc.createElement("div");
  const root = doc.createElement("main");
  doc.body.append(headEl, root);
  const view = A.auditView();
  view.mount(root, { store, bridge, toast: () => {}, head: createWorkHead(headEl), goto: () => {}, drawer: null });
  if (!opts || opts.filter !== "changes") $(headEl, "#audit-filter [data-value=all]").click(); // G-252: the screen starts on Changes; these tests are about the whole log
  return { bridge, root, headEl, view };
}

test("QA-32: the newest operation is counted whole, however many pages it spans", async () => {
  const log = makeLog();
  const m = await mount(log);
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length >= 2), true);
  const first = $$(m.root, "tr[data-op]")[0];
  assert.equal(first.querySelector(".lx-k").textContent, "Apply");
  assert.equal(first.dataset.op, "700", "the operation starts at record 700, before the first page (800..999)");
  assert.match(text(first), /300/, "300 requests, not the 200 of one page");
  assert.ok(m.bridge.calls.filter((c) => c.op === "audit.tail").length >= 2);
  assert.equal(m.bridge.calls[0].args.before, undefined);
  assert.equal(typeof m.bridge.calls[1].args.before, "number");
  m.view.unmount();
});

test("QA-32: older operations are reachable by paging (Load older); every record is read once", async () => {
  const log = makeLog();
  const m = await mount(log);
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length >= 12 && !$(m.root, "#audit-foot").textContent.includes("Reading")), true);
  const before = $$(m.root, "tr[data-op]").length;
  const older = $(m.root, "#audit-older");
  assert.ok(older, "older records are available");
  older.click();
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length > before), true);
  const cursors = m.bridge.calls.map((c) => c.args.before).filter((b) => b !== undefined);
  assert.deepEqual(cursors, [...new Set(cursors)].sort((a, b) => b - a), "each page asks strictly further back");
  m.view.unmount();
});

test("QA-32: Changes finds a write 900 records back in the whole log", async () => {
  const log = makeLog(); // the only write sits at index 65 of 1000+ (≈ 900+ records back)
  assert.ok(log.length - log.findIndex((r) => r.cmd === "0x11") > 900);
  const m = await mount(log);
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length >= 2), true);
  $(m.headEl, "#audit-filter [data-value=changes]").click();
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length === 1 && $$(m.root, "tr[data-op]")[0].querySelector(".lx-k").textContent === "Apply"), true);
  const row = $$(m.root, "tr[data-op]")[0];
  assert.equal(row.dataset.op, String(log.findIndex((r) => r.cmd === "0x11") - 5), "the old apply, not the newest one");
  // search also reads on until it finds
  $(m.headEl, "#audit-filter [data-value=all]").click();
  const search = $(m.headEl, "#audit-search");
  search.value = "point 4";
  fire(search, "input");
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length >= 1), true);
  m.view.unmount();
});

test("QA-32: a helper without paging still shows the newest page, no Load older", async () => {
  const log = makeLog();
  const m = await mount(log, { paging: false });
  assert.equal(await until(() => $$(m.root, "tr[data-op]").length >= 1), true);
  await sleep(30);
  assert.equal($("#audit-older" && m.root, "#audit-older"), null);
  assert.equal(m.bridge.calls.length, 1);
  m.view.unmount();
});

test("QA-33: a measure run's begin and result records are ONE 'Curve measured' row", () => {
  const recs = [
    rec({ event: "runtime_attempt", op: "vf.measure", domain: "runtime", file_count: 2 }),
    read("vf.measure: sample"),
    rec({ event: "result", op: "vf.measure", file_count: 2, restored: true, outcome: "complete", curve_id: "c1", detail: "vf.measure: 2 files, restored ok" }),
  ];
  const ops = A.groupAudit(recs);
  const measured = ops.filter((g) => g.label === "Curve measured");
  assert.equal(measured.length, 1, "no second 'Curve measured' row");
  assert.equal(measured[0].records.length, 2);
  assert.equal(measured[0].result, "ok");
  assert.match(measured[0].line, /2 files, restored ok/);
  assert.match(measured[0].line, /curve stored/);
  // an unfinished run followed by a new one are two operations
  const two = A.groupAudit([rec({ event: "runtime_attempt", op: "vf.measure" }), rec({ event: "runtime_attempt", op: "vf.measure" })]);
  assert.equal(two.length, 2);
});

test("QA-33: an apply run is named by its closing record and shows the real outcome", () => {
  const run = (close) => [write("apply: write V/F point 4"), rec({ event: "readback", purpose: "read-back of: apply: write V/F point 4", verified: true }), ...(close ? [rec({ event: "result", ...close })] : [])];
  const restored = A.groupAudit([...run(null).slice(0, 0), read("apply: read V/F point 1"), rec({ event: "result", op: "restore-accepted", name: "qa", outcome: "nothing-to-do", writes_planned: 0, writes_sent: 0 })]);
  assert.equal(restored.length, 1, "the closing record joins the run's own records");
  assert.equal(restored[0].label, "Restore accepted");
  assert.equal(restored[0].result, "ok");
  assert.match(restored[0].line, /0 writes, nothing to do/);

  const mismatch = A.groupAudit(run({ op: "tune.apply", name: "Quick", outcome: "mismatch", writes_sent: 1, complete: true, readback_total: 1, readback_mismatches: 1 }));
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].label, "Apply Quick");
  assert.equal(mismatch[0].result, "mismatch");
  assert.match(mismatch[0].line, /1 write.*1 read back different/);

  const refused = A.groupAudit([rec({ event: "result", op: "tune.apply", name: "", outcome: "refused", code: "REFUSED", detail: "the policy refused" })]);
  assert.equal(refused[0].result, "error");
  assert.match(refused[0].line, /the policy refused/);

  // without a closing record (older helper): the previous behaviour, "Apply" from the purpose, verdict from the read-backs
  const old = A.groupAudit(run(null));
  assert.equal(old[0].label, "Apply");
  assert.equal(old[0].result, "ok");
  assert.match(old[0].line, /read back equal/);
});
