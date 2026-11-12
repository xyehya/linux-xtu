// node --test "desktop/app/ui/tests/*.test.mjs"   (G-206: pure logic of the Dashboard, System and Audit screens and their components; no DOM, no network, no hardware)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createAppStore, applyHelperEvent, SERIES } from "../store.js";
import { FIXTURES } from "../fixtures/mock-backend.js";
import G from "../fixtures/g217/fixtures-g217.js";
import { deriveThrottle } from "../store.js";
import {
  tempsByCpu, coreReading, readingValue, unitLive, overviewRows, liveCell, liveFootnote, appendChartSample, seedChart, chartReasons, multipleSpec, MULTIPLES, agoText,
  limitsNowRows, eventLine, lastScreenLine, memModel, ageText, headSub, HISTORY_S,
} from "../views/dashboard.js";
import {
  sortChecks, checkState, mergeCpuLimits, limitRows, limitsNote, preflightSummary, countStatuses, topologyRows, fmtSigned, MINUS,
} from "../views/system.js";
import { auditRequest, auditKeep, auditRow, auditRows, auditNote, auditTime, MB_NAMES, hex } from "../views/audit.js";

const UI = fileURLToPath(new URL("..", import.meta.url));
const pre = FIXTURES.preflight.result;
const units = pre.topology.units;
const rawFrame = FIXTURES.telemetry.events.find((e) => e.event === "telemetry");

/** A telemetry `values` object with live numbers for every core (what the helper would send on a machine with MSR access). */
function liveValues() {
  const cores = {};
  units.forEach((u) =>
    u.cpus.forEach((cpu) => {
      const leaf = (value, unit) => ({ value, unit, status: "ok", source: "test" });
      cores[String(cpu)] = { name: `${u.kind}-Core ${cpu}`, mhz: leaf(cpu < 8 ? 5400 - cpu * 100 : 4400 + cpu, "MHz"), busy: leaf(cpu * 4, "%"), vid: leaf(0.9 + cpu / 100, "V"), ratio: leaf(50, "x") };
    }),
  );
  return {
    cores,
    temps: { Package: { value: 61, unit: "C", status: "ok", source: "hwmon", cpu: null }, "Core 2": { value: 70, unit: "C", status: "ok", source: "hwmon", cpu: 2 } },
    power: { package: { value: 88.2, unit: "W", status: "ok", source: "powercap" }, core: { value: null, unit: "W", status: "unavailable", reason: "no 'core' subdomain", source: "powercap" } },
    vcore: { value: 1.2, unit: "V", status: "ok", source: "hwmon" },
    dram: { read: { value: null, status: "unavailable", reason: "IMC sampling not enabled", source: "perf stat", unit: "GB/s" }, write: { value: null, status: "unavailable", reason: "IMC sampling not enabled", source: "perf stat", unit: "GB/s" } },
    limit_reasons_raw: { value: 0x10, unit: "raw", status: "ok", source: "msr 0x6B0" },
  };
}

test("overview: per-core temperature needs a sensor entry that carries its cpu", () => {
  assert.deepEqual(tempsByCpu(null), {});
  assert.deepEqual(Object.keys(tempsByCpu({ Package: { cpu: null }, a: { cpu: 3, value: 1 }, b: { cpu: "4" }, c: { cpu: "x" } })).sort(), ["3", "4"]);
  const v = liveValues();
  assert.equal(coreReading(v, 2, "temp").value, 70);
  assert.equal(coreReading(v, 3, "temp").status, "unavailable"); // no mapping for cpu 3
  assert.match(coreReading(v, 3, "temp").reason, /per-core temperature sensor/);
  assert.equal(coreReading(v, 1, "mhz").value, 5300);
  assert.equal(coreReading(null, 1, "mhz").status, "unavailable");
  assert.equal(coreReading(v, 99, "busy").status, "unavailable");
});

test("overview: readingValue keeps unavailable unavailable (no zero, no guess)", () => {
  assert.deepEqual(readingValue({ value: 0, status: "ok", source: "s" }), { value: 0, reason: null, source: "s" }); // a real 0 stays a value
  assert.equal(readingValue({ value: null, status: "unavailable", reason: "no MSR access (needs root)" }).value, null);
  assert.equal(readingValue({ value: 5, status: "unavailable", reason: "x" }).value, null);
  assert.equal(readingValue(undefined).reason, "no reading");
  assert.equal(readingValue({ value: NaN, status: "ok" }).value, null);
});

test("overview: a unit's busy is the mean of its CPUs; clock (its fastest CPU, G-252), VID and temperature the highest", () => {
  const v = liveValues();
  const ec0 = unitLive(v, [8, 9, 10, 11]);
  assert.equal(ec0.mhz, 4411);
  assert.equal(ec0.busy, (32 + 36 + 40 + 44) / 4);
  assert.equal(ec0.vid, 0.9 + 11 / 100);
  assert.equal(ec0.temp, null);
  assert.match(ec0.why.temp, /per-core temperature sensor/);
  assert.equal(unitLive(v, [2]).temp, 70);
  assert.equal(unitLive(null, [0]).why.mhz, "no telemetry yet");
});

test("overview: the unit rows come from the topology (D-036), with the factory top ratio; no topology = no rows", () => {
  const rows = overviewRows(pre.topology, rawFrame.values);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.filter((r) => r.fav).map((r) => r.id), ["P0", "P3"]);
  assert.deepEqual(rows.slice(8).map((r) => [r.id, r.sub]), [["EC0", "8–11"], ["EC1", "12–15"], ["EC2", "16–19"], ["EC3", "20–23"]]);
  assert.equal(rows[0].top, units[0].max_ratio);
  assert.ok(rows.every((r) => liveCell(r, "clock").na && liveCell(r, "busy").text === "n/a"));
  assert.equal(liveFootnote(rows), "Clock n/a: no MSR access (needs root). Busy n/a: no MSR access (needs root). VID n/a: no MSR access (needs root). Temp n/a: no per-core temperature sensor in this sample.");
  assert.equal(overviewRows(undefined, rawFrame.values).length, 0);
  assert.equal(overviewRows({ units: [] }, null).length, 0);
});

test("overview: live cells format GHz with 2 decimals, busy whole %, VID 3 decimals; the footnote says a partial gap once", () => {
  const rows = overviewRows(pre.topology, liveValues());
  const p0 = rows[0];
  assert.deepEqual(["clock", "busy", "vid", "temp"].map((k) => liveCell(p0, k).text), ["5.40", "0", "0.900", "n/a"]);
  assert.equal(liveCell(rows.find((r) => r.id === "P2"), "temp").text, "70");
  assert.equal(liveFootnote(rows), "Temp n/a for some units: no per-core temperature sensor in this sample.");
});

test("overview: seedChart turns the store's short history into timed samples; the multiples scale, floor and label the last value", () => {
  const seeded = seedChart({ pkg_power: [10, null, 30], temp: [50, 51, 52] }, 1000);
  assert.deepEqual(seeded.map((p) => p.t), [998, 999, 1000]);
  assert.deepEqual(seeded.map((p) => p.v.pkg_power), [10, null, 30]);
  assert.deepEqual(seedChart(null, 1000), []);
  const pkg = MULTIPLES.find((m) => m.key === "pkg_power");
  const spec = multipleSpec(pkg, seeded, { now: 1000, windowS: 60, refs: [{ y: 125, label: "PL1 125" }] });
  assert.equal(spec.traces.length, 2, "a gap breaks the line");
  assert.equal(spec.y.min, 0, "power has a floor at 0");
  assert.ok(spec.y.max >= 125, "the PL1 reference is inside the range");
  assert.equal(spec.labels[0].text, " 30.0 W");
  assert.deepEqual(spec.cursorXs, [998, 999, 1000]);
  assert.deepEqual([spec.x.min, spec.x.max], [940, 1000]);
  const clk = multipleSpec(MULTIPLES.find((m) => m.key === "clock"), [{ t: 5, v: { clock: 5500 } }], { now: 5, windowS: 60 });
  assert.equal(clk.labels[0].text, " 5.50 GHz");
  assert.ok(clk.y.max - clk.y.min >= 0.5, "a flat line still has a readable span");
  const none = multipleSpec(pkg, [], { now: 5, windowS: 60 });
  assert.deepEqual([none.traces.length, none.y.ticks.length, none.labels[0].text], [0, 0, "n/a"], "no data: no made-up scale, n/a in the plot");
  assert.deepEqual([0, -30, -300].map(agoText), ["now", "−30 s", "−5 min"]);
});

test("overview: LIMITS NOW in plain words — PL1 names the package power and the limit in force; n/a while unknown; the turbo cap is normal", () => {
  const mk = (word, groups) => deriveThrottle({ limit_reasons: { status: "ok", value: word }, ...(groups ? { throttle: { status: "ok", value: groups } } : {}) });
  const na = limitsNowRows(deriveThrottle(null));
  assert.ok(na.every((r) => r.words === "n/a" && r.state === "unknown"));
  const idle = limitsNowRows(mk({ raw: 0, status: [], log: [], unknown_bits: [] }));
  assert.deepEqual(idle.map((r) => r.words), ["not binding", "not binding", "not tripping", "not limiting", "not limiting", "not capping"]);
  const on = limitsNowRows(mk({ raw: 0x1400, status: ["pl1", "max_turbo_limit"], log: [], unknown_bits: [] }), { power: { pl1_w: 125, pl2_w: 250 }, pkg: 124.6 });
  const pl1 = on.find((r) => r.key === "pl1");
  assert.deepEqual([pl1.state, pl1.words, pl1.detail, pl1.goto[1]], ["lit-warn", "long-term power limit holds the clock", "package 125 W of limit 125 W", "power"]);
  const turbo = on.find((r) => r.key === "turbo");
  assert.deepEqual([turbo.state, turbo.words], ["lit-info", "turbo table caps the ratio · normal under load"]);
  assert.equal(on.find((r) => r.key === "therm").goto, null);
});

test("overview: a throttle event reads as a sentence; an unreadable record says so", () => {
  const l = eventLine({ t_on: 1792316743, t_off: 1792316755, group: "power", label: "Power limit", bits: ["pl1"], dur_ms: 12000, duty: 0.3, peak_temp_c: 71.2, peak_pkg_w: 182.4 });
  assert.equal(l.text, "Power limit held the clock for 12 s, 30 % of the time · peak 182 W, 71 °C");
  assert.match(l.when, /^\d\d:\d\d:\d\d$/);
  assert.equal(eventLine({ unparsable: "x" }).bad, true);
});

test("overview: last quick screen line (the accepted state and mailbox count are the top bar's, G-252), header subtitle", () => {
  assert.equal(lastScreenLine([], true), "none on this computer");
  assert.equal(lastScreenLine([], false), "not loaded yet");
  assert.match(lastScreenLine([{ errors: 0, stopped_by: "time", health: "clean", kind: "cpu", method: "integer", duration_s: 300, started: "2026-10-18T10:29:26Z" }], true), /^clean · CPU integer · 5 min · /);
  assert.match(lastScreenLine([{ errors: 3, kind: "cpu", method: "cache", duration_s: 60 }], true), /^3 errors · CPU cache · 1 min/);
  assert.equal(headSub({ state: "connected" }, 99, 100), "live · 1 s");
  assert.equal(headSub({ state: "connected" }, 50, 100), "waiting · last sample 50 s ago");
  assert.equal(headSub({ state: "closed" }, 99, 100), "helper not connected");
});

test("dashboard: the chart buffer takes one entry per sample time and keeps HISTORY_S seconds", () => {
  const store = createAppStore();
  let buf = [];
  const feed = (t, w) => {
    const values = liveValues();
    values.power.package.value = w;
    applyHelperEvent(store, "telemetry", { t, values });
    buf = appendChartSample(buf, store.get().telemetry);
  };
  feed(1000, 50);
  feed(1001, 60);
  feed(1001, 99); // same sample time again: ignored
  assert.deepEqual(buf.map((p) => p.v.pkg_power), [50, 60]);
  assert.equal(buf[0].v.core_power, null); // unavailable stays null in the buffer
  feed(1000 + HISTORY_S - 1, 65);
  assert.equal(buf.length, 3, "inside the window nothing is dropped");
  feed(1001 + HISTORY_S + 5, 70);
  assert.deepEqual(buf.map((p) => p.t), [1001, 1000 + HISTORY_S - 1, 1001 + HISTORY_S + 5].filter((t) => t >= 1001 + HISTORY_S + 5 - HISTORY_S), "samples older than the window are dropped");
  feed(1001 + 3 * HISTORY_S, 71);
  assert.equal(buf.length, 1);
  assert.equal(appendChartSample(buf, { t: null, samples: null }), buf);
});

test("dashboard: chartReasons collects the reason of every unavailable series", () => {
  const store = createAppStore();
  applyHelperEvent(store, "telemetry", { t: 1, values: liveValues() });
  const r = chartReasons(store.get().telemetry);
  assert.equal(r.core_power, "no 'core' subdomain");
  assert.equal(r.pkg_power, undefined);
  assert.equal(r.dram, "IMC sampling not enabled");
  assert.deepEqual(chartReasons(null), {});
});

test("dashboard: memModel is n/a with the helper's reason, or the decoded card", () => {
  assert.equal(memModel(null).available, false);
  assert.equal(memModel({ available: false, reason: "no IMC found" }).reason, "no IMC found");
  assert.equal(memModel({ available: false }).reason, "the helper gave no reason");
  const m = memModel({
    available: true, mts: 6400, gear: 2, cmd_rate: "2N", timings: { tCL: 32, tRCD: 39, tRP: 39, tRAS: 102, tRFC: 560 }, qclk_mhz: 3200.04, bclk_mhz: 100.0, max_bandwidth_mbs: 102400,
    cross_check: { agree: true }, instances_ok: 2, dimms: [{ locator: "DIMM_A1", size: "16 GB", part: "XYZ", manufacturer: "Acme", temp_c: { value: 41.2, status: "ok" } }, { locator: "DIMM_B1", temp_c: { value: null, status: "unavailable", reason: "no sensor" } }],
  });
  assert.equal(m.headline, "DDR5-6400 · Gear 2 · 2N");
  assert.equal(m.primary, "32-39-39-102");
  assert.equal(m.rows.find((r) => r[0] === "tREFI" || r[0] === "tRFC"), undefined, "G-252: tRFC / tREFI are not in the main view");
  assert.equal(m.rows.find((r) => r[0] === "Memory clock"), undefined, "G-252: 3200 MHz only restates DDR5-6400");
  assert.deepEqual(m.rows.find((r) => r[0] === "Peak bandwidth"), ["Peak bandwidth", "102.4 GB/s"]);
  assert.equal(m.dimms[0].temp, 41.2);
  assert.equal(m.dimms[1].temp, null);
  assert.equal(m.dimms[1].tempReason, "no sensor");
  assert.equal(m.summary, "2 modules");
  assert.equal(m.summaryTitle, "read from 2 controller instances");
});

test("dashboard: ageText", () => {
  assert.equal(ageText(null, 100), "no samples yet");
  assert.equal(ageText(99.5, 100), "just now");
  assert.equal(ageText(90, 100), "10 s ago");
  assert.equal(ageText(0, 300), "5 min ago");
});

// ---------------------------------------------------------------- system
test("system: sortChecks puts the worst first and is stable", () => {
  const s = sortChecks(pre.checks);
  assert.equal(s[0].name, "msr_allow_writes");
  assert.equal(s[0].status, "unknown");
  assert.equal(s.length, pre.checks.length);
  assert.deepEqual(s.slice(1).map((c) => c.name), pre.checks.filter((c) => c.status === "pass").map((c) => c.name)); // passes keep their order
  const mixed = sortChecks([{ status: "pass", name: "a" }, { status: "refuse", name: "b" }, { status: "weird", name: "c" }, null, { status: "read-only", name: "d" }]);
  assert.deepEqual(mixed.map((c) => c && c.name), ["b", "d", "a", "c", null]);
  assert.deepEqual(sortChecks(undefined), []);
});

test("system: checkState uses only the three accents", () => {
  assert.deepEqual(["pass", "unknown", "read-only", "warn", "fail", "refuse", "zzz"].map(checkState), ["ok", "warn", "warn", "warn", "error", "error", "warn"]);
});

test("system: preflightSummary explains why writes are off", () => {
  const s = preflightSummary(pre);
  assert.equal(s.mode, "write");
  assert.equal(s.writes, false);
  assert.equal(s.platform, "arl-s");
  assert.match(s.banner, /does not permit mailbox requests/);
  assert.deepEqual(s.counts, { pass: 13, unknown: 1 });
  assert.equal(preflightSummary(null), null);
  assert.equal(preflightSummary({ mode: "x" }), null);
  const ro = preflightSummary({ mode: "read-only", checks: [{ name: "lockdown", status: "read-only", reason: "integrity" }] });
  assert.match(ro.banner, /Read-only mode.*lockdown: integrity/);
  assert.equal(preflightSummary({ mode: "write", writes_allowed: true, checks: [] }).banner, "");
  assert.deepEqual(countStatuses(undefined), {});
});

test("system: the limits are the CPU's own (cpu_limits of the kept read), with the register each came from", () => {
  const last = FIXTURES.tuneLast.result;
  const cl = mergeCpuLimits(last.result.cpu_limits);
  const rows = limitRows(cl);
  const row = (what, kind) => rows.find((r) => r.what === what && r.kind === kind);
  assert.deepEqual(row("CPU max voltage", "P-cores"), { what: "CPU max voltage", kind: "P-cores", cpu: "1.625 V", source: "OC mailbox 0x28 [11:0] − 1 LSB" });
  assert.equal(row("OC ratio limit", "P-cores").cpu, "120×");
  assert.equal(row("OC ratio limit", "P-cores").source, "OC mailbox 0x01 [7:0]");
  assert.equal(row("CPU max voltage", "E-clusters").cpu, "1.355 V");
  assert.equal(row("CPU max voltage", "Ring").cpu, "1.999 V", "the ring has its own entry");
  assert.equal(row("V/F offset field", "P, E, ring").cpu, `${MINUS}1000…+999 mV`);
  assert.match(row("Package power limits", "Package").cpu, /^n\/a · Read CPU state first/, "tune.last leaves the power part null: it comes from the power read");
  assert.match(row("Ratio cap range", "All CPUs").cpu, /^n\/a · Read CPU state first/);
  assert.match(row("Uncore ratio range", "Ring").cpu, /^n\/a · Read CPU state first/);
  assert.equal(limitRows(null).length, 0);
  assert.ok(rows.every((r) => !/polic/i.test(JSON.stringify(r))), "no policy anywhere in the table");
});

test("system: the power, cpufreq and uncore limits come from the Power / Ratio caps / Ring & uncore reads when those ran", () => {
  const last = FIXTURES.tuneLast.result;
  const cl = mergeCpuLimits(last.result.cpu_limits, { power: G["power-read"].result.cpu_limits, runtime: G["runtime-read"].result.cpu_limits });
  const rows = limitRows(cl);
  assert.equal(rows.find((r) => r.what === "Package power limits").cpu, "writable, field maximum 4095.875 W");
  assert.equal(rows.find((r) => r.what === "Ratio cap range").cpu, "800–5700 MHz (24 CPUs)");
  assert.equal(rows.find((r) => r.what === "Uncore ratio range").cpu, "8×–40×");
  const locked = mergeCpuLimits(last.result.cpu_limits, { power: { ...G["power-read"].result.cpu_limits, power: { locked: true, pl_max_w: 4095.875, source: "" } } });
  assert.match(limitRows(locked).find((r) => r.what === "Package power limits").cpu, /^locked by firmware/);
});

test("system: a limit that was not read says Read CPU state first (the recorded unread shape)", () => {
  const cl = mergeCpuLimits(G["power-read-unread"].result.cpu_limits);
  const rows = limitRows(cl);
  const v = rows.find((r) => r.what === "CPU max voltage" && r.kind === "P-cores");
  assert.match(v.cpu, /^n\/a · Read CPU state first/);
  assert.match(rows.find((r) => r.what === "OC ratio limit" && r.kind === "E-clusters").cpu, /^n\/a · Read CPU state first/);
  assert.equal(mergeCpuLimits(null), null);
});

test("system: limitsNote", () => {
  assert.match(limitsNote(null, null), /read the ratios and voltages in Tune/);
  assert.match(limitsNote({ available: false }, null), /Not read yet/);
  assert.match(limitsNote({ available: true, result: {} }, null), /did not report the CPU limits/);
  const ok = limitsNote({ available: true, result: {} }, { kinds: {} });
  assert.match(ok, /limits of your CPU/);
  assert.doesNotMatch(ok, /polic/i);
});

test("system: topologyRows from preflight, favored flag and cpu ranges", () => {
  const rows = topologyRows(pre.topology);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], { id: "P0", kind: "P-core", cpus: "0", maxRatio: "57×", perf: "92", favored: true });
  assert.deepEqual(rows[8], { id: "EC0", kind: "E-cluster", cpus: "8–11", maxRatio: "49×", perf: "68", favored: false });
  assert.deepEqual(topologyRows(null), []);
});

test("system: fmtSigned uses a real minus sign", () => {
  assert.equal(fmtSigned(-35), `${MINUS}35`);
  assert.equal(fmtSigned(5), "+5");
  assert.equal(fmtSigned(0), "0");
});

// ---------------------------------------------------------------- audit
test("audit: request names follow registers.md and unknown commands show as hex", () => {
  assert.equal(auditRequest({ cmd: "0x11", p1: "0x00", p2: "0x05" }), "0x11 V/F word write (0x0, 0x5)");
  assert.equal(auditRequest({ cmd: 0x10 }), "0x10 V/F word read");
  assert.equal(auditRequest({ cmd: "0x7f", p1: "0x01" }), "0x7f (0x1, -)");
  assert.equal(auditRequest({ msr: 0x198 }), "MSR 0x198 perf status");
  assert.equal(auditRequest({ msr: "0x150", msr_kind: "write" }), "MSR 0x150 write");
  assert.equal(auditRequest({ event: "refused" }), "");
  assert.equal(MB_NAMES[0x28], "max voltage read");
  assert.equal(hex(255), "0xff");
  assert.equal(hex(null), "");
});

test("audit: the writes filter keeps writes, read-backs, refusals, errors and trips; reads drop out", () => {
  const keep = (o) => auditKeep(o, "writes");
  assert.equal(keep({ event: "result", cmd: "0x11" }), true);
  assert.equal(keep({ event: "attempt", cmd: 0x27 }), true);
  assert.equal(keep({ event: "attempt", msr: 0x150, msr_kind: "write" }), true);
  assert.equal(keep({ event: "readback", cmd: "0x10" }), true);
  for (const e of ["refused", "error", "trip"]) assert.equal(keep({ event: e }), true, e);
  assert.equal(keep({ event: "result", cmd: "0x10" }), false);
  assert.equal(keep({ event: "attempt", cmd: "0x14" }), false);
  assert.equal(auditKeep({ event: "result", cmd: "0x10" }, "all"), true);
});

test("audit: auditRow flags mismatches and non-pass results, and survives an unparsable line", () => {
  const ok = auditRow({ event: "result", cmd: "0x10", rc: 0, rc_name: "Pass", seq: 5, cpu: 0, purpose: "p", ts: "2026-10-18T08:58:27.045+00:00" });
  assert.equal(ok.resultKind, "ok");
  assert.equal(ok.detail, "p");
  assert.equal(ok.seq, "5");
  const bad = auditRow({ event: "result", rc: 3, rc_name: "UNKNOWN_0x11" });
  assert.equal(bad.resultKind, "warn");
  // G-230: rc 0x11 at the end of a V/F read walk is the expected end of the table (grey); the same rc on a write stays amber
  const end = auditRow({ event: "result", cmd: "0x10", p1: "0x02", p2: "0x0A", rc: 17, rc_name: "UNKNOWN_0x11" });
  assert.deepEqual([end.result, end.resultKind], ["end of table (0x11)", ""]);
  const badWrite = auditRow({ event: "result", cmd: "0x11", rc: 17, rc_name: "UNKNOWN_0x11" });
  assert.deepEqual([badWrite.result, badWrite.resultKind], ["UNKNOWN_0x11", "warn"]);
  assert.equal(auditRow({ event: "result", cmd: "0x10", rc: 3, rc_name: "RATIO_LIMIT" }).resultKind, "warn");
  // G-237 review f3: a re-read whose target has not landed yet says so (it is neither verified nor a mismatch)
  assert.equal(auditRow({ event: "readback", cmd: "0x10", rc: 0, pending: true, poll: 0 }).verdict, "pending (re-read 1)");
  const mm = auditRow({ event: "readback", verified: false, rc_name: "Pass" });
  assert.deepEqual([mm.verdict, mm.resultKind, mm.eventKind], ["MISMATCH", "error", "error"]);
  assert.equal(auditRow({ event: "readback", verified: true, rc_name: "Pass" }).verdict, "verified");
  const refused = auditRow({ event: "refused", reason: "policy: out of range" });
  assert.deepEqual([refused.eventKind, refused.detail], ["error", "policy: out of range"]);
  const junk = auditRow("{not json");
  assert.deepEqual([junk.event, junk.detail], ["unparsable", "{not json"]);
  assert.equal(auditRow({ event: "result", value: 12 }).result, "12");
  assert.equal(auditRow({}).cpu, "");
});

test("audit: G-235 summary records show under Writes & refusals, the detail column prefers o.detail, a run summary names its files", () => {
  const keep = (o) => auditKeep(o, "writes");
  const start = { event: "runtime_attempt", op: "vf.measure", kind: "cpufreq", file_count: 48, detail: "vf.measure: 48 cpufreq file(s) journaled; the caps and the restore follow", seq: 7 };
  const end = { event: "result", op: "vf.measure", kind: "cpufreq", file_count: 48, restored: true, outcome: "complete", detail: "vf.measure: 48 files, restored ok", seq: 8 };
  const bad = { event: "result", op: "stress.start", file_count: 4, restored: false, outcome: "error" };
  const err = { event: "error", op: "vf.measure", path: "cpu3/cpufreq/scaling_max_freq", reason: "Device busy", detail: "cpufreq write cpu3 scaling_max_freq -> 3000000 FAILED: Device busy" };
  for (const o of [start, end, bad, err, { event: "result", op: "profiles.save" }, { event: "powercap_attempt" }]) assert.equal(keep(o), true, o.event + " " + (o.op ?? ""));
  assert.equal(keep({ event: "result", cmd: "0x10" }), false, "a mailbox read result still drops out");
  const row = auditRow(end);
  assert.deepEqual([row.event, row.request, row.result, row.resultKind, row.eventKind, row.detail], ["result", "vf.measure", "complete", "ok", "", "vf.measure: 48 files, restored ok"]);
  assert.equal(auditRow(start).detail, start.detail);
  const failed = auditRow(bad);
  assert.deepEqual([failed.detail, failed.resultKind, failed.eventKind], ["stress.start: 4 files, NOT restored", "error", "error"]);
  for (const outcome of ["cancel", "cancelled"]) assert.equal(auditRow({ event: "result", op: "stress.start", restored: true, outcome }).resultKind, "warn", outcome);
  assert.equal(auditRow(err).detail, err.detail, "o.detail wins over o.reason");
  assert.equal(auditRow({ event: "refused", reason: "why" }).detail, "why", "reason is the fallback");
  assert.equal(auditRow({ event: "result", op: "curves.delete", curve_id: "x" }).request, "curves.delete");
  assert.equal(auditRows([start, end, { event: "result", cmd: "0x10", rc: 0 }], { filter: "writes" }).length, 2);
});

test("audit: auditRows on the fixture tail: newest first, filters, text search", () => {
  const recs = FIXTURES.auditTail.result.records;
  const all = auditRows(recs);
  assert.equal(all.length, 20);
  assert.deepEqual(all.map((r) => Number(r.seq)), recs.map((r) => r.seq).reverse());
  const writes = auditRows(recs, { filter: "writes" });
  assert.deepEqual(writes.map((r) => r.seq), ["316", "315", "314"]);
  assert.equal(auditRows(recs, { text: "point 5" }).length, 7); // ring point 5 (2), the baseline read (2), the write (2) and its read-back
  assert.equal(auditRows(recs, { text: "  READBACK " }).length, 1);
  assert.equal(auditRows(recs, { text: "zzz" }).length, 0);
  assert.equal(auditRows(recs, { filter: "writes", text: "attempt" }).length, 1);
  assert.deepEqual(auditRows(null), []);
});

test("audit: auditNote and auditTime", () => {
  assert.equal(auditNote(0, 0, { filter: "all", text: "" }, false), "The audit log is empty.");
  assert.equal(auditNote(20, 20, { filter: "all", text: "" }, false), "Last 20 records, newest first, local time.");
  assert.equal(auditNote(200, 3, { filter: "writes", text: "" }, true), "3 write-related of the last 200 records, newest first, local time (older records not shown).");
  assert.match(auditNote(20, 5, { filter: "all", text: "x" }, false), /^5 of the last 20 records match/);
  assert.equal(auditTime("not a date"), "not a date");
  assert.equal(auditTime(undefined), "");
  assert.notEqual(auditTime("2026-10-18T08:58:27.045+00:00"), "2026-10-18T08:58:27.045+00:00");
});

// ---------------------------------------------------------------- hygiene (PLAN §2): the screens carry no inline style/handler/innerHTML/eval
test("the G-206 sources use no innerHTML, inline style, inline handlers, eval or remote URLs", () => {
  const files = ["views/dashboard.js", "views/curves.js", "views/stress.js", "views/system.js", "views/audit.js"];
  for (const f of files) {
    const src = readFileSync(join(UI, f), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), `${f}: dangerous sink`);
    assert.ok(!/\.style\.|setAttribute\(\s*["']style["']|\bstyle:\s/.test(src.replace(/`[^`]*`/g, "")), `${f}: inline style`);
    assert.ok(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, "")), `${f}: remote URL`);
    assert.ok(!/\bon(click|input|change)\s*=/.test(src), `${f}: inline handler attribute`);
    assert.ok(!/^import .* from ["']https?:/m.test(src), `${f}: remote import`);
  }
});
