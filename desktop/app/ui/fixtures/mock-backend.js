// fixtures/mock-backend.js: the `mock` transport of bridge.js. Replays the JSON fixtures recorded from the simulator helper
// (gen_fixtures.py; see README.md). Same transport interface as the Tauri backend: connect, status, call, listen (+ close, and the test seam dropLink).
// R-A4: connect/status/call answer in the shell's own shapes (shellLayer at the bottom; tests/contract.test.mjs holds them to tests/contract-samples.json).
// Short ops answer with the recorded response; long ops (tune.read, tune.apply) answer {id}, replay the recorded state/progress events on a timer
// and finish with a `result` event, exactly as PLAN §3.1 describes the real link.
// Loaded lazily by bridge.js only for ?bridge=mock, so the AppImage never parses it. The data comes from fixtures.js (the *.json files bundled as one ES
// module by gen_fixtures.py): Chrome checks JSON module imports and fetch() against connect-src, which the strict CSP restricts to ipc:, whereas a JS
// module is governed by script-src 'self'. So the mock runs under the exact CSP of tauri.conf.json.

import F from "./fixtures.js";

export const FIXTURES = {
  preflight: F["preflight"], telemetryStart: F["telemetry-start"], telemetryStop: F["telemetry-stop"], telemetry: F["telemetry-events"], tuneRead: F["tune-read"],
  tuneReadEvents: F["tune-read-events"], tunePlan: F["tune-plan"], tuneApply: F["tune-apply"], tuneApplyEvents: F["tune-apply-events"], profilesList: F["profiles-list"],
  auditTail: F["audit-tail"], tuneLast: F["tune-last"],
  // G-213: recorded from the simulator by gen_profiles_fixtures.py (saved profiles, their contents, the refusals); the accepted state is INVENTED below
  // (one entry per recorded file: shell.test.mjs checks the count)
  profilesSaveP0: F["profiles-save-sim-p0-undervolt"], profilesSaveELight: F["profiles-save-sim-e-light"], profilesSaveExists: F["profiles-save-exists"],
  profilesGetP0: F["profiles-get-sim-p0-undervolt"], profilesGetELight: F["profiles-get-sim-e-light"], profilesSavedList: F["profiles-saved-list"],
  profilesAcceptUnavailable: F["profiles-accept-unavailable"], profilesFingerprintUnavailable: F["profiles-fingerprint-unavailable"],
};
const {
  preflight, telemetryStart, telemetryStop, telemetry, tuneRead, tuneReadEvents, tunePlan, tuneApply, tuneApplyEvents, profilesList, auditTail, tuneLast,
  profilesGetP0, profilesGetELight, profilesSavedList, profilesAcceptUnavailable, profilesFingerprintUnavailable,
} = FIXTURES;
const profilesGet = [profilesGetP0, profilesGetELight];

const clone = (x) => JSON.parse(JSON.stringify(x));

// R-B4 (STATE backlog "mock still shows E 49x"): the recorded preflight predates G-233. Its topology `max_ratio` is the kernel's cpuinfo_max_freq / 100000, which is one bin high on an
// E-core (4900 MHz = 48x [MEASURED lnx 2026-10-12]); the helper now answers the ratio the cores really run plus `max_khz` and `ratio_model` (topology/live.py LiveUnit, controls/caps.py
// effective_ratio). The mock answers that shape; the JSON stays as recorded (FIXTURES.preflight). G233_MODEL = the kHz the helper's measured model covers -> the ratio it gives.
const G233_MODEL = { E: { 4900000: 48 }, P: { 5500000: 55, 5700000: 57 } };
/**
 * The helper's preflight answer. R-I1: with the version block of ops.py `version_info` (`helper: {version, protocol, ops_hash, ops}`) and, when the client declared
 * itself, its echo with `protocol_ok`. INVENTED versions (the recorded preflight predates R-B3): `helperMode` "version" = a helper of another protocol (`?helper=version`),
 * "ops" = one that serves another op set (`?helper=ops`); anything else speaks this app's protocol and serves its op set.
 */
function currentPreflight(helperMode = "ok", client = null) {
  const r = clone(preflight.result);
  for (const u of (r.topology && r.topology.units) || []) {
    if (typeof u.max_ratio !== "number" || "max_khz" in u) continue;
    const khz = u.max_ratio * 100000;
    const got = (G233_MODEL[u.kind] || {})[khz];
    Object.assign(u, { max_ratio: got ?? u.max_ratio, max_khz: khz, ratio_model: got === undefined ? "unmeasured" : "measured" });
  }
  const helper = helperMode === "version" ? { version: "0.3.0", protocol: APP.protocol + 1, ops_hash: APP.ops_hash, ops: APP.ops }
    : helperMode === "ops" ? { version: "0.2.1", protocol: APP.protocol, ops_hash: "0".repeat(64), ops: APP.ops + 1 }
    : { version: APP.version, protocol: APP.protocol, ops_hash: APP.ops_hash, ops: APP.ops };
  r.helper = helper;
  if (client && typeof client === "object") {
    const echo = Object.fromEntries(["name", "version", "protocol"].filter((k) => client[k] != null).map((k) => [k, client[k]]));
    r.client = { ...echo, protocol_ok: client.protocol == null || client.protocol === helper.protocol };
  }
  return r;
}
const ok = (id, result) => ({ id, ok: true, result });
const fail = (id, code, message, detail) => ({ id, ok: false, error: detail ? { code, message, detail } : { code, message } });

/** G-248: audit.tail paging like helper/ops.py op_audit_tail. The fixture's records are the whole log, each record taking AUDIT_RECORD_BYTES "bytes"; the answer
 *  carries `start` / `end` (offsets of the records returned), `size` and `older` (bytes before `start`). `before` is the previous answer's `start`. */
export const AUDIT_RECORD_BYTES = 400;
export function auditTailPage(result, args = {}) {
  const all = result.records;
  const n = args.n === undefined ? 20 : args.n;
  const size = all.length * AUDIT_RECORD_BYTES;
  const limit = args.before === undefined || args.before === null ? size : Math.min(args.before, size);
  const upto = Math.floor(limit / AUDIT_RECORD_BYTES); // a page ends on a whole record
  const from = Math.max(0, upto - n);
  const start = upto > from ? from * AUDIT_RECORD_BYTES : limit;
  const end = upto > from ? Math.min(upto * AUDIT_RECORD_BYTES, size) : limit;
  const truncated = from > 0 || (args.before !== undefined && args.before !== null);
  return { ...result, records: all.slice(from, upto), truncated, start, end, size, older: start > 0 };
}

// ---- the shell's link contract (tests/contract-samples.json, generated by src-tauri/tests/contract_samples.rs; contract.test.mjs checks every value below) ----
export const HELPER_SOCKET = "/run/linux-xtu/helper.sock";
/** `?helper=<mode>` -> the shell's `last_error` ({kind, message}) for that failed connect, word for word. */
export const LINK_FAILURES = {
  busy: { kind: "busy", message: "another client is connected to the helper (another linux-xtu GUI?). Close it, then start this one again." },
  not_installed: { kind: "missing", message: `the helper is not installed or not started: ${HELPER_SOCKET} does not exist. Run: sudo bash install.sh (it enables linux-xtu-helper.socket)` },
  not_allowed: { kind: "not_allowed", message: "the helper refused this user: not in the allowlist (/etc/linux-xtu/helper.toml). Run: sudo bash install.sh --add-user YOURNAME" },
  error: { kind: "closed", message: "the helper closed the connection right away (it may have refused to start). See: journalctl -u linux-xtu-helper -n 30" },
};
/** Rust `ConnectError::not_connected` / `ConnectError::lost(reason)`. */
export const NOT_CONNECTED = { kind: "not_connected", message: "not connected to the helper yet; nothing was sent" };
export const lostError = (reason) => ({ kind: "closed", message: `the connection to the helper was lost (${reason}); an operation in flight was reported lost and not replayed. Retry reconnects.` });
/** Rust link.rs fail_all: the `result` of a long op in flight when the link ends. */
const LINK_LOST_RESULT = "the helper connection was lost while this operation was running; its outcome is unknown and it was not replayed";
/** Rust link.rs DETAIL_SCALARS / DETAIL_LISTS / DETAIL_STR_MAX: what of an error's `detail` reaches the webview. */
export const DETAIL_ALLOW = { scalars: ["state", "check", "curve_id", "key", "writes_sent"], lists: { problems: 10 }, str_max: 500 };

// INVENTED, not from any hardware and not from the simulator: with `motion` on, the telemetry leaves that the unprivileged simulator reports as
// "unavailable" get a deterministic waveform so sparklines and tiles can be seen moving. DRAM and core power stay unavailable on purpose (n/a path).
function invent(values, tick) {
  const v = clone(values);
  const put = (leaf, value) => {
    leaf.value = Math.round(value * 1000) / 1000;
    leaf.status = "ok";
    delete leaf.reason;
  };
  for (const [cpu, core] of Object.entries(v.cores || {})) {
    const n = Number(cpu);
    const busy = 50 + 45 * Math.sin(tick * 0.7 + n * 0.9);
    const ratio = Math.round((n < 8 ? 55 : 46) - 3 * (1 - busy / 100));
    put(core.busy, busy);
    put(core.ratio, ratio);
    put(core.mhz, ratio * 100);
    put(core.vid, 0.95 + 0.0035 * busy);
  }
  if (v.temps && v.temps.Package) put(v.temps.Package, 48 + 10 * Math.sin(tick * 0.5));
  if (v.power && v.power.package) put(v.power.package, 85 + 30 * Math.sin(tick * 0.6));
  if (v.vcore) put(v.vcore, 1.15 + 0.05 * Math.sin(tick * 0.4));
  if (v.limit_reasons_raw) put(v.limit_reasons_raw, tick % 8 === 5 ? 0x10 : 0);
  return v;
}

// INVENTED, not from any hardware and not from the simulator (the simulator's curve store is empty): a stock-baseline curve for the Tune predictions (G-208).
// Per unit a straight ramp that ends at the fused top voltage of the recorded read (0.0105 V per ratio step), `status: "ok"` on every read point. It is what
// `curves.list` / `curves.get` answer in the mock; `?bridge=mock&baseline=none` answers an empty library (the "no baseline curve" path).
function inventedBaseline() {
  const units = {};
  for (const u of tuneRead.result.units) {
    const cpu = u.cpus[0];
    const top = tuneRead.result.fused[String(cpu.cpu)];
    const ratios = cpu.points.map((p) => p.ratio);
    const topRatio = top ? top.ratio : Math.max(...ratios);
    const topV = top ? top.v : 1.1;
    units[u.id] = { points: ratios.map((r) => ({ ratio: r, status: "ok", vid_v: Math.round((topV - (topRatio - r) * 0.0105) * 10000) / 10000 })) };
  }
  return { id: "mock-baseline", name: "Mock stock baseline (invented)", baseline: true, created: "2026-01-01T00:00:00Z", units };
}
const noBaselineParam = () => new URLSearchParams(globalThis.location?.search ?? "").get("baseline") === "none";

// INVENTED, not from any hardware and not from the simulator (G-210): the mock plans from the intent so the apply drawer has something to show. It is the recorded plan
// (warnings, ops left, expiry) with `steps` / `before` / `after` / `units` derived from the intent rows and the recorded read, in the helper's step order (the conditional
// per-core enable first, then one write per point). Knobs (query string, like `baseline=none`): `apply=mismatch` (the last read-back word differs), `apply=stale` (the first
// tune.apply answers PLAN_STALE and the plan is forgotten), `step=<ms>` (gap between replayed progress events; a slow apply for the cancel test).
const searchParam = (name) => new URLSearchParams(globalThis.location?.search ?? "").get(name);
const stepParam = () => {
  const n = Number(searchParam("step"));
  return Number.isFinite(n) && n >= 1 ? n : null;
};
// G-240: `?uvp=on` makes the mock BIOS have Undervolt Protection on: the first tune.apply with a negative offset is refused (REFUSED, check UNDERVOLT_PROTECTION, the helper's message), the mock
// then reports uvp "on" in tune.read / tune.last / tune.plan, and a later negative-offset plan is refused at the plan like the helper's. `?uvp=off` reports "off" from the start; default "unknown".
export const UVP_MESSAGE = "The CPU refused a negative voltage offset: Undervolt Protection is enabled in the BIOS (Intel's default). Disable 'Undervolt Protection' in the BIOS and reboot to undervolt. Only negative offsets are refused; OC ratios and turbo ratios are not affected.";
const negativeOffsets = (intent) => {
  const out = [];
  for (const ch of (Array.isArray(intent && intent.rows) ? intent.rows : []).map(changesOf).filter(Boolean)) {
    if (ch.curve !== null && ch.curve < 0) out.push([ch.target, ch.curve]);
    for (const mv of Object.values(ch.points)) if (mv < 0) out.push([ch.target, mv]);
  }
  return out;
};
// ---- the CPU the mock holds, and the voltage model it plans with (R-B4: tests/golden/voltage_cases.json is the reference; golden_voltage.test.mjs runs every case here) ----
// What the mock CPU holds: per unit the WHOLE-CURVE layer (the P2 = 0 word's offset), the OC word's ratio / target, every fused point's own offset, the ring points and the turbo tables.
// The layers are never merged: the CPU adds them [MEASURED lnx 2026-10-11/12, platform-arl-s.md §3]. A plan writes what the helper writes (controls/planner.py): a whole-curve row is the
// P2 = 0 word (ratio and target kept, the XTU fill on a cold word, target 0 without an OC point), a points row one point word each, both on EVERY CPU of the unit (an E cluster: four).
const MOCK_FLOOR_MV = -150; // INVENTED: a mock CPU limit tighter than the CPU's offset field (-1000..+999), so a refusal is reachable from the UI (apply tests rely on it)
const MOCK_CEIL_MV = 150;
/** mV -> the signed 11-bit raw, XTU/ThrottleStop rounding on the magnitude (registers.md "V/F data word"). */
const rawOf = (mv) => (mv < 0 ? -1 : 1) * Math.floor((Math.abs(mv) * 1024 + 512) / 1000 + 1e-9);
const mvOfRaw = (raw) => Math.round((raw / 1.024) * 1000) / 1000;
const asRead = (mv) => mvOfRaw(rawOf(mv)); // a typed mV as the helper decodes it back from the word
const vRaw = (v) => Math.round(v * 1024);
const vOfRaw = (raw) => Math.round((raw / 1024) * 10000) / 10000;
const hex = (w) => "0x" + (w >>> 0).toString(16).padStart(8, "0");
/** The 0x11 data word: ratio [7:0] | target [19:8] | offset [31:21] (mode [20] = 0, adaptive). */
const vfWord = (ratio, targetRaw, offsetMv) => (((rawOf(offsetMv) & 0x7ff) << 21) | ((targetRaw & 0xfff) << 8) | (ratio & 0xff)) >>> 0;
const wordOf = (mv, ratio) => hex(vfWord(ratio, 0, mv));
const readUnit = (id) => tuneRead.result.units.find((u) => u.id === id) || null;
const signed = (n) => (n >= 0 ? "+" : "-") + Math.abs(n);
const outside = (mv) => mv < MOCK_FLOOR_MV || mv > MOCK_CEIL_MV;
const WINDOW = `${MOCK_FLOOR_MV}.0..+${MOCK_CEIL_MV}.0 mV`;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const TABLE_MSR = { P: "0x1AD", E: "0x650" };
const kindOfUnit = (id) => (String(id).startsWith("EC") ? "E" : "P");
const cpusOf = (id) => {
  const u = readUnit(id);
  return u ? (Array.isArray(u.cluster_cpus) && u.cluster_cpus.length ? u.cluster_cpus.slice() : u.cpus.map((c) => c.cpu)) : [];
};
const fusedOf = (id) => {
  const u = readUnit(id);
  const f = u ? tuneRead.result.fused[String(u.cpus[0].cpu)] : null;
  return f ? { ratio: f.ratio, raw: (parseInt(f.word, 16) >> 8) & 0xfff, v: f.v } : null;
};
/** 0x1C[7:0] of a unit: a P-core's favored ratio (turbo.favored), an E cluster's the E table's top bucket (the recording has no E 0x1C word; on the reference chip they agree, 48). */
const ownMaxOf = (id) => {
  const u = readUnit(id);
  if (!u) return null;
  if (kindOfUnit(id) === "P") return tuneRead.result.turbo.favored[String(u.cpus[0].cpu)] ?? null;
  return Math.max(...tuneRead.result.tables.e);
};
const pointsOfUnit = (id) => (readUnit(id) ? readUnit(id).cpus[0].points : []);
const pointByRatio = (id, ratio) => pointsOfUnit(id).find((p) => p.ratio === Number(ratio)) || null;
const cpuLimit = (kind) => (tuneRead.result.cpu_limits || {})[kind] || {};

/** A change set per unit (the helper's resolved profile, before words): {target, curve: mV | null, points: {ratio: mV}, ratio: int | null, vt: V | null}. */
function changesOf(row) {
  if (!isObj(row)) return null;
  const o = row.offset;
  return {
    target: row.target,
    curve: isNum(row.curve) ? row.curve : isObj(o) && o.kind === "curve" ? o.mv : null,
    points: isObj(row.points) ? { ...row.points } : isObj(o) && o.kind === "points" ? { ...o.mv } : {},
    ratio: isNum(row.ratio) ? row.ratio : null,
    vt: isNum(row.v_target_v) ? row.v_target_v : null,
  };
}

/** What the mock CPU holds at the start: the recorded read, with `cpuState` ({unit: {oc: {ratio, v_target_v, offset_mv}, points_mv: {ratio: mV}}}, golden `read`) laid over it. */
function initialHeld(cpuState = null) {
  const units = {};
  const curve = {};
  const oc = {};
  for (const u of readUnits()) {
    const c = u.cpus[0];
    units[u.id] = Object.fromEntries(c.points.map((p) => [p.point, p.offset_mv]));
    curve[u.id] = c.oc && isNum(c.oc.offset_mv) ? c.oc.offset_mv : 0;
    oc[u.id] = { ratio: c.oc && c.oc.ratio ? c.oc.ratio : 0, targetRaw: c.oc && c.oc.v_target_raw ? c.oc.v_target_raw : 0 };
  }
  for (const [id, s] of Object.entries(isObj(cpuState) ? cpuState : {})) {
    if (!units[id]) continue;
    if (isObj(s.oc)) {
      if (isNum(s.oc.offset_mv)) curve[id] = asRead(s.oc.offset_mv);
      if (isNum(s.oc.ratio)) oc[id].ratio = s.oc.ratio;
      if (s.oc.v_target_v !== undefined) oc[id].targetRaw = isNum(s.oc.v_target_v) ? vRaw(s.oc.v_target_v) : 0;
    }
    for (const [r, mv] of Object.entries(s.points_mv || {})) {
      const p = pointByRatio(id, r);
      if (p) units[id][p.point] = asRead(mv);
    }
  }
  const ring = Object.fromEntries(((tuneRead.result.ring && tuneRead.result.ring.points) || []).map((p) => [p.point, p.offset_mv]));
  return { units, curve, oc, ring, turbo: { P: tuneRead.result.tables.p.slice(), E: tuneRead.result.tables.e.slice() } };
}
const copyHeld = (held) => ({
  units: Object.fromEntries(Object.entries(held.units).map(([k, v]) => [k, { ...v }])),
  curve: { ...held.curve },
  oc: Object.fromEntries(Object.entries(held.oc).map(([k, v]) => [k, { ...v }])),
  ring: { ...held.ring },
  turbo: { P: held.turbo.P.slice(), E: held.turbo.E.slice() },
});

/**
 * The P2 = 0 words a change set makes the helper send for one unit, from the word it holds (controls/planner.py current_word / xtu_word / kept_word / _vf_words):
 * -> [{word, stage}] (two words when ratio and target rise together on an existing OC point: voltage first; fall together: frequency first), or {error} (G-124: raising both from
 * no OC point while 0x1C[7:0] is above the fused top). Empty when the change set does not touch the P2 = 0 word.
 */
function ocWords(held, ch) {
  if (ch.curve === null && ch.ratio === null && ch.vt === null) return [];
  const f = fusedOf(ch.target);
  const top = f ? f.ratio : null;
  const setsOc = ch.ratio !== null || ch.vt !== null;
  const h = held.oc[ch.target];
  const own = ownMaxOf(ch.target) || 0;
  const fill = h.ratio || (setsOc || top === null ? own : Math.min(own, top));
  const cur = { ratio: fill, targetRaw: h.targetRaw || (f ? f.raw : 0), offset: held.curve[ch.target] || 0 };
  const hasOc = (r) => top === null || r > top;
  const goal = { ratio: ch.ratio ?? cur.ratio, targetRaw: ch.vt !== null ? vRaw(ch.vt) : cur.targetRaw, offset: ch.curve !== null ? ch.curve : cur.offset };
  if (!hasOc(goal.ratio)) goal.targetRaw = 0; // kept_word: no OC point, no target (G-124)
  const w = (x) => vfWord(x.ratio, x.targetRaw, x.offset);
  if (goal.targetRaw === 0) return [{ word: w(goal), stage: "" }];
  const dR = goal.ratio - cur.ratio;
  const dV = goal.targetRaw - cur.targetRaw;
  if (dR > 0 && dV > 0) {
    if (!hasOc(cur.ratio)) {
      if (own <= top) return [{ word: w(goal), stage: "creates the OC point (ratio + voltage in one word; the ratio is usable only after 0x1D)" }];
      return { error: `${ch.target}: raising the OC ratio and its voltage together needs the voltage first, but at ratio ${cur.ratio} (no OC point) the hardware drops the V target (G-124: a word without an OC point always keeps target 0), so the voltage-first word cannot be verified; raise the ratio alone first (the OC point appears at the current V target), then the voltage in a second profile` };
    }
    return [{ word: w({ ...cur, targetRaw: goal.targetRaw }), stage: "1/2 voltage first" }, { word: w(goal), stage: "2/2 full word" }];
  }
  if (dR < 0 && dV < 0) return [{ word: w({ ...cur, ratio: goal.ratio }), stage: "1/2 frequency first" }, { word: w(goal), stage: "2/2 full word" }];
  return [{ word: w(goal), stage: "" }];
}

/** The helper's own refusals of an intent's shape and range (ops_tune.py canonical_intent / _check_range, guard turbo_order_problem), word for word: {code, message, detail?} | null. */
function helperRefusal(intent) {
  const bad = (message, detail) => ({ code: "BAD_REQUEST", message, ...(detail ? { detail } : {}) });
  const refused = (message, check, key) => ({ code: "REFUSED", message, detail: { check, ...(key ? { key } : {}) } });
  const mvOk = (v, what) => {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return `${what} must be a whole number of millivolts`;
    if (v < -1000 || v > 999) return `${what} ${v} mV is outside the V/F word's -1000..999 mV`;
    return null;
  };
  const rows = Array.isArray(intent.rows) ? intent.rows : [];
  const targets = [];
  for (const row of rows) {
    if (!isObj(row)) return bad("each row must be an object");
    const o = row.offset;
    if (isObj(o) && o.kind === "curve") {
      const e = mvOk(o.mv, "offset.mv");
      if (e) return bad(e);
    } else if (isObj(o) && o.kind === "points") {
      for (const [k, v] of Object.entries(o.mv || {})) {
        const e = mvOk(v, `offset.mv[${k}]`);
        if (e) return bad(e);
      }
    }
    if (o || row.ratio !== null || row.v_target_v !== null) targets.push(row.target);
  }
  if (new Set(targets).size !== targets.length) return bad("a target appears in two rows");
  if (rows.length && !targets.length && !intent.turbo && !intent.ring) return bad("the intent changes nothing (every row is empty)", { check: "NOTHING_TO_DO" });
  for (const row of rows) {
    if (!readUnit(row.target)) continue;
    const kind = kindOfUnit(row.target);
    const lim = cpuLimit(kind);
    if (isNum(row.v_target_v) && isNum(lim.max_mv)) {
      const capRaw = Math.floor((lim.max_mv * 1024) / 1000);
      if (vRaw(Math.round(row.v_target_v * 1000) / 1000) > capRaw) {
        return refused(`${row.target}: OC-point voltage ${Math.round(row.v_target_v * 1000)} mV is above CPU limit ${Math.floor((capRaw * 1000) / 1024)} mV (cmd 0x28 [11:0] - 1 LSB of a ${kind} CPU, XTU's rule, registers.md). Nothing was sent.`, "POLICY_RANGE");
      }
    }
    if (isNum(row.ratio) && isNum(lim.max_ratio) && row.ratio > lim.max_ratio) {
      return refused(`${row.target}: ratio ${row.ratio} is above CPU limit ${lim.max_ratio}x (cmd 0x01 [7:0] fused max OC ratio of a ${kind} CPU, registers.md). Nothing was sent.`, "POLICY_RANGE");
    }
    if (isObj(row.offset) && row.offset.kind === "points") {
      const top = fusedOf(row.target) ? fusedOf(row.target).ratio : Infinity;
      const have = pointsOfUnit(row.target).filter((p) => p.ratio <= top).map((p) => p.ratio);
      const missing = Object.keys(row.offset.mv).filter((r) => !have.includes(Number(r)));
      if (missing.length) return bad(`${row.target} has no V/F point at ratio ${missing.join(", ")} (points of the last read: ${have.slice().sort((a, b) => a - b).join(", ")})`);
      // D-053 item 5 (ops_tune.py _positive_raise_check): a raised positive point offset on a row without a ratio / voltage has no fused 0x09 read in the apply, refused at plan
      if (row.ratio === null && row.v_target_v === null) {
        const up = Object.entries(row.offset.mv).find(([r, mv]) => mv > 0 && mv > ((pointByRatio(row.target, r) || {}).offset_mv || 0));
        if (up) {
          return refused(`${row.target}: offset +${up[1]} mV on the ${up[0]}x point raises a voltage the helper cannot bound yet: the apply cannot read this unit's fused 0x09 voltage (the base of every point; it is read only for a unit the plan also gives a whole-curve, ratio or voltage row) and its whole V/F point table, so the result cannot be bounded by the CPU's voltage limit and the guard would refuse the write (CPU_LIMIT_UNREAD). Use 0 or a negative offset (D-053 item 5). Nothing was sent.`, "POSITIVE_OFFSET_UNPROVEN", `${row.target}.points.${up[0]}`);
        }
      }
    }
  }
  // D-053 item 5: a turbo table may not rise with the active-core count, refused at plan (text of guard/policy.py turbo_order_problem; the helper's plan-time refusal is WP-2)
  for (const [k, t] of Object.entries(intent.turbo || {})) {
    if (!Array.isArray(t)) continue;
    for (let i = 0; i + 1 < t.length; i++) {
      if (t[i + 1] > t[i]) return refused(`turbo.${k}: bucket ${i + 1} (${t[i + 1]}x) is above bucket ${i} (${t[i]}x): a ratio table may not rise with the active-core count. Nothing was sent.`, "TURBO_ORDER", `turbo.${k}`);
    }
  }
  return null;
}

/** A CPU-limit refusal message (D-049: the CPU's own limits are the only bound) for the first offset of the change sets outside the INVENTED mock CPU limit, else null. */
function mockRefusal(intent) {
  for (const ch of (intent.rows || []).map(changesOf).filter(Boolean)) {
    for (const mv of [...(ch.curve !== null ? [ch.curve] : []), ...Object.values(ch.points)]) {
      if (outside(mv)) {
        return `${ch.target}: offset ${signed(mv)} mV (raw ${rawOf(mv)}) is outside the CPU limit ${WINDOW} (mock CPU limit; the field encoding allows -1000..999 mV). Nothing was sent.`;
      }
    }
  }
  for (const [no, mv] of Object.entries((intent.ring && intent.ring.points) || {})) {
    if (outside(mv)) return `ring point ${no}: offset ${signed(mv)} mV (raw ${rawOf(mv)}) is outside the CPU limit ${WINDOW} (mock CPU limit). Nothing was sent.`;
  }
  return null;
}

/** D-050, as the helper plans it (ops_tune._oc_below_table_warnings): an OC ratio above the top bucket of its kind's table (the intent's own table, else the one read) is planned
 *  as asked, no table is derived, and a TURBO_BELOW_OC warning says so. */
function turboBelowOc(intent) {
  const out = [];
  for (const row of intent.rows || []) {
    if (!isNum(row.ratio)) continue;
    const kind = kindOfUnit(row.target);
    const table = (intent.turbo && intent.turbo[kind]) || tuneRead.result.tables[kind.toLowerCase()];
    if (table && row.ratio > Math.max(...table)) {
      out.push({ code: "TURBO_BELOW_OC", text: `${row.target} OC ratio ${row.ratio}x is above the ${kind} turbo table (${table.map((b) => b + "x").join(", ")}): the core runs at most the table's bucket for the active-core count until you raise it on the Turbo ratios tab (MSR ${TABLE_MSR[kind]})` });
    }
  }
  return out;
}

/**
 * intent (or the internal change sets of a profile) -> {steps, before, after, units, writes, words: [{unit, cpu, point, word, stage}]} | {error}; `writes` 0 = nothing to synthesize
 * from (the caller answers the recorded plan). Order as the helper lists it (ops_tune._predicted_steps): the conditional per-core enable, the point writes, the per-core triples
 * (0x11 [+ 0x1D + 0x27 when a ratio is set]), the ring points, the turbo tables. `before` / `after` hold the P2 = 0 word as point "0" (its offset = the whole-curve layer) and the points written.
 */
function synthPlan(intent, held) {
  const steps = [{ conditional: true, kind: "write_percore_enable", n: 1 }];
  const before = {};
  const after = {};
  const units = [];
  const words = [];
  const pointSteps = [];
  const coreSteps = [];
  const touch = (u) => units.includes(u) || units.push(u);
  for (const ch of (intent.rows || []).map(changesOf).filter((c) => c && readUnit(c.target))) {
    const id = ch.target;
    const cpus = cpusOf(id);
    for (const [ratio, mv] of Object.entries(ch.points)) {
      const p = pointByRatio(id, ratio);
      if (!p) continue;
      (before[id] ||= {})[p.point] = { clamped_by: null, effective_v: null, offset_mv: held.units[id][p.point], ratio: p.ratio, v_target_v: null };
      (after[id] ||= {})[p.point] = { clamped_by: null, effective_v: null, offset_mv: asRead(mv), ratio: p.ratio, v_target_v: null };
      touch(id);
      for (const cpu of cpus) {
        pointSteps.push({ cpu, kind: "write_vf_point", offset_mv: mv, point: p.point, unit: id });
        words.push({ unit: id, cpu, point: p.point, word: hex(vfWord(p.ratio, 0, mv)), stage: "" });
      }
    }
    const ow = ocWords(held, ch);
    if (!Array.isArray(ow)) return ow;
    if (!ow.length) continue;
    const last = ow[ow.length - 1].word;
    const h = held.oc[id];
    (before[id] ||= {})["0"] = { clamped_by: null, effective_v: null, offset_mv: held.curve[id] || 0, ratio: h.ratio || null, v_target_v: h.targetRaw ? vOfRaw(h.targetRaw) : null };
    (after[id] ||= {})["0"] = { clamped_by: null, effective_v: null, offset_mv: mvOfRaw(((last >>> 21) & 0x400 ? ((last >>> 21) & 0x7ff) - 0x800 : (last >>> 21) & 0x7ff)), ratio: last & 0xff, v_target_v: (last >>> 8) & 0xfff ? vOfRaw((last >>> 8) & 0xfff) : null };
    touch(id);
    for (const cpu of cpus) {
      coreSteps.push({ cpu, kind: "write_vf", point: 0, unit: id });
      if (ch.ratio !== null) coreSteps.push({ cpu, kind: "write_favored", point: 0, unit: id }, { cpu, kind: "write_granular", point: 0, unit: id });
      for (const x of ow) words.push({ unit: id, cpu, point: 0, word: hex(x.word), stage: x.stage });
    }
  }
  const ringSteps = [];
  for (const [no, mv] of Object.entries((intent.ring && intent.ring.points) || {})) {
    (before.ring ||= {})[no] = { clamped_by: null, effective_v: null, offset_mv: held.ring[no] ?? 0, ratio: null, v_target_v: null };
    (after.ring ||= {})[no] = { clamped_by: null, effective_v: null, offset_mv: asRead(mv), ratio: null, v_target_v: null };
    touch("ring");
    ringSteps.push({ cpu: 0, kind: "write_ring_point", offset_mv: mv, point: Number(no), unit: "ring" });
    const rp = ((tuneRead.result.ring && tuneRead.result.ring.points) || []).find((p) => p.point === Number(no));
    words.push({ unit: "ring", cpu: 0, point: Number(no), word: hex(vfWord(rp ? rp.ratio : 0, 0, mv)), stage: "" });
  }
  if (pointSteps.length + coreSteps.length === 0) steps.pop();
  for (const s of [...pointSteps, ...coreSteps, ...ringSteps]) steps.push({ ...s, n: steps.length + 1 });
  for (const kind of Object.keys(intent.turbo || {})) {
    steps.push({ kind: "write_msr", n: steps.length + 1, table: kind, unit: "turbo " + kind });
    units.push("turbo " + kind);
  }
  return { steps, before, after, units, words, writes: steps.filter((s) => !s.conditional).length };
}

// ---- profiles (G-213) ---------------------------------------------------------------------------------------------------------------------------------
// RECORDED from the simulator (gen_profiles_fixtures.py): the two saved profiles (profiles.get contents), the profiles.list answer, the EXISTS refusal, and the NO_ACCEPTED_DIR refusals of
// profiles.accept / profiles.fingerprint. INVENTED here (the unprivileged simulator keeps no accepted state): a working profiles.accept / profiles.fingerprint, the accepted entry of
// profiles.list / profiles.get, a profiles.save of any new name, "the words the CPU holds" (the recorded read, plus every plan applied in this mock session) and the plans of
// {profile} / {restore: "accepted"} intents (the writes that take what is held to the profile's state, in the order of synthPlan). Knobs (query string): `profiles=none` (empty library),
// `profiles=accepted` (an accepted state equal to the recorded read exists from the start), `accept=unavailable` (accept / fingerprint answer the recorded refusal),
// `fingerprint=incomplete` (the fingerprint note says what the simulator would: no CPU identity).
const PROFILE_NAME_RE = /^[a-z0-9._-]{1,64}$/;
function readUnits() {
  return tuneRead.result.units.filter((u) => u.cpus && u.cpus[0] && Array.isArray(u.cpus[0].points));
}
const topOf = (id) => (fusedOf(id) ? fusedOf(id).ratio : null);
const ocRow = (held, id) => {
  const h = held.oc[id];
  const top = topOf(id);
  return h.ratio && top !== null && h.ratio > top ? { ratio: h.ratio, v_target_v: h.targetRaw ? vOfRaw(h.targetRaw) : null } : { ratio: null, v_target_v: null };
};

/** The profile schema this mock saves (helper profiles/schema.py SCHEMA_VERSION). */
export const PROFILE_SCHEMA = 2;
/** The ring's OC word as a profile records it (helper profiles/contents.py: `0x%08X`), from the recorded read; null when the read has none. */
function ringOcWord() {
  const w = tuneRead.result.ring && tuneRead.result.ring.oc ? tuneRead.result.ring.oc.word : null;
  return typeof w === "string" && /^0x[0-9a-fA-F]+$/.test(w) ? "0x" + (parseInt(w, 16) >>> 0).toString(16).toUpperCase().padStart(8, "0") : null;
}
/** helper profiles/contents.py _offset_of: the one intent offset a unit's two layers can be planned as, or null when both hold a value. */
function offsetOfLayers(curve, points, complete) {
  const moved = Object.values(points).some((x) => x !== 0);
  if (!Object.keys(points).length || (complete && !moved)) return curve === null ? null : { kind: "curve", mv: curve };
  if (curve === null || (complete && curve === 0)) return { kind: "points", mv: { ...points } };
  return null;
}
/** A row's two offset layers {curve: mV | null, points: {ratio: mV}}: its `layers` (R-B1), else derived from its one offset (a row recorded before R-B1); a whole-curve row of a
 *  complete profile means "every point 0" (G-148). */
function layersOf(row, complete) {
  if (isObj(row.layers)) return { curve: isNum(row.layers.curve_mv) ? row.layers.curve_mv : null, points: isObj(row.layers.points_mv) ? { ...row.layers.points_mv } : {} };
  const o = row.offset;
  if (isObj(o) && o.kind === "curve") return { curve: o.mv, points: complete ? Object.fromEntries(pointsOfUnit(row.target).map((p) => [String(p.ratio), 0])) : {} };
  if (isObj(o) && o.kind === "points") return { curve: complete ? 0 : null, points: { ...o.mv } };
  return { curve: null, points: {} };
}
/** A recorded profiles.get contents (recorded before R-B1, schema 1) in today's shape: rows with `layers`, the schema-2 keys present and null (not in the profile). INVENTED shape
 *  upgrade, the values are the recorded ones. */
function upgradeContents(c) {
  const complete = c.complete === true;
  const rows = c.rows.map((r) => {
    const l = layersOf(r, complete);
    return { ...r, layers: { curve_mv: l.curve, points_mv: l.points } };
  });
  return { ring: null, power: null, caps: null, uncore: null, version: 1, ...c, rows };
}

/** A complete profile's contents (profiles.get shape, helper profiles/contents.py profile_contents) from held words: per unit both offset layers (`layers`; the CPU adds them) and
 *  the one intent offset they can be planned as; the OC ratio / target only when the unit has an OC point; both turbo tables; the ring (OC word + every point); the runtime
 *  sections null here (the G-217 layer fills power / caps / uncore: it holds those values). */
function contentsOfHeld(held) {
  const rows = readUnits().map((u) => {
    const points = Object.fromEntries(pointsOfUnit(u.id).map((p) => [String(p.ratio), held.units[u.id][p.point]]));
    const curve = held.curve[u.id] || 0;
    return { target: u.id, offset: offsetOfLayers(curve, points, true), ...ocRow(held, u.id), layers: { curve_mv: curve, points_mv: points } };
  });
  const ring = Object.keys(held.ring).length ? { oc_word: ringOcWord(), points: Object.fromEntries(Object.entries(held.ring).map(([k, mv]) => [String(k), mv])) } : null;
  return { rows, turbo: { E: held.turbo.E.slice(), P: held.turbo.P.slice() }, complete: true, ring, power: null, caps: null, uncore: null, version: PROFILE_SCHEMA };
}

const DIFF_UNITS = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "EC0", "EC1", "EC2", "EC3", "ring", "P turbo", "E turbo"];

/** G-228: the settings a profile's contents hold, as profiles.diff counts them: [{unit, order, label, kind, value}]: the OC word (whole-curve offset, OC ratio, target) and every point's own offset. */
function diffFacts(contents) {
  const out = [];
  for (const row of contents.rows) {
    const l = layersOf(row, contents.complete === true);
    if (l.curve !== null) out.push({ unit: row.target, order: 0, label: "OC word: whole-curve offset", kind: "mv", value: l.curve });
    for (const p of pointsOfUnit(row.target)) {
      const value = String(p.ratio) in l.points ? l.points[String(p.ratio)] : null;
      if (value !== null) out.push({ unit: row.target, order: 10 + p.point, label: `Offset at ${p.ratio}x`, kind: "mv", value });
    }
    out.push({ unit: row.target, order: 1, label: "OC ratio", kind: "x", value: row.ratio });
    out.push({ unit: row.target, order: 2, label: "OC target voltage", kind: "v", value: row.v_target_v });
  }
  for (const k of ["P", "E"]) if (contents.turbo && Array.isArray(contents.turbo[k])) contents.turbo[k].forEach((value, i) => out.push({ unit: k + " turbo", order: i, label: "Bucket " + i, kind: "x", value }));
  return out;
}

/** helper profiles/contents.py summarize: `deepest_offset_mv` is the deepest EFFECTIVE offset (whole curve + point) of a row whose two layers both hold a value. */
function summarize(contents) {
  let deepest = null;
  let points = 0;
  for (const r of contents.rows) {
    const off = r.offset;
    const layers = isObj(r.layers) ? r.layers : {};
    let low = null;
    if (off) {
      const values = off.kind === "curve" ? [off.mv] : Object.values(off.mv);
      if (off.kind === "points") points += values.length;
      low = Math.min(...values);
    } else if (isNum(layers.curve_mv) || (isObj(layers.points_mv) && Object.keys(layers.points_mv).length)) {
      const pts = Object.values(layers.points_mv || {});
      points += pts.length;
      low = (layers.curve_mv || 0) + (pts.length ? Math.min(...pts) : 0);
    }
    if (low !== null) deepest = deepest === null ? low : Math.min(deepest, low);
  }
  return {
    units: contents.rows.length, points, deepest_offset_mv: deepest, oc_ratios: contents.rows.filter((r) => r.ratio !== null).length,
    v_targets: contents.rows.filter((r) => r.v_target_v !== null).length, turbo: !!contents.turbo, complete: contents.complete === true,
  };
}

/** Held words with the change sets of an intent (rows, or the internal change sets of a profile) and its turbo / ring laid over them: each layer where the helper writes it.
 *  `asWords`: what the CPU holds after an apply (each mV decoded back from its raw, as a read shows it); without it the typed mV a saved profile keeps. */
function heldAfter(held, intent, { asWords = false } = {}) {
  const next = copyHeld(held);
  const keep = (mv) => (asWords ? asRead(mv) : mv);
  for (const ch of ((intent && intent.rows) || []).map(changesOf).filter((c) => c && next.units[c.target])) {
    for (const [r, mv] of Object.entries(ch.points)) {
      const p = pointByRatio(ch.target, r);
      if (p) next.units[ch.target][p.point] = keep(mv);
    }
    const ow = ocWords(held, ch);
    if (Array.isArray(ow) && ow.length) {
      const w = ow[ow.length - 1].word;
      const off = (w >>> 21) & 0x7ff;
      next.curve[ch.target] = ch.curve !== null && !asWords ? ch.curve : mvOfRaw(off & 0x400 ? off - 0x800 : off);
      next.oc[ch.target] = { ratio: w & 0xff, targetRaw: (w >>> 8) & 0xfff };
    }
  }
  for (const [no, mv] of Object.entries((intent && intent.ring && intent.ring.points) || {})) next.ring[no] = keep(mv);
  for (const k of Object.keys((intent && intent.turbo) || {})) next.turbo[k] = intent.turbo[k].slice();
  return next;
}

/** The change sets that take held words to a profile's contents, only what differs (the helper writes only what differs from the CPU). A whole-curve row of a complete profile means
 *  "every point 0, this whole-curve offset" (G-148): both layers, which a profile apply may write in one plan (an intent could not). */
function intentToReach(contents, held) {
  const rows = [];
  for (const row of contents.rows) {
    if (!held.units[row.target]) continue;
    const ch = { target: row.target, curve: null, points: {}, ratio: null, v_target_v: null };
    const l = layersOf(row, contents.complete === true); // both layers: a profile apply may write the whole curve and the points in one plan
    if (l.curve !== null && !sameRaw(l.curve, held.curve[row.target] || 0)) ch.curve = l.curve;
    for (const p of pointsOfUnit(row.target)) {
      const want = String(p.ratio) in l.points ? l.points[String(p.ratio)] : null;
      if (want !== null && !sameRaw(want, held.units[row.target][p.point])) ch.points[String(p.ratio)] = want;
    }
    const now = ocRow(held, row.target);
    if (isNum(row.ratio) && row.ratio !== now.ratio) ch.ratio = row.ratio;
    if (isNum(row.v_target_v) && !(isNum(now.v_target_v) && vRaw(now.v_target_v) === vRaw(row.v_target_v))) ch.v_target_v = row.v_target_v;
    if (ch.curve !== null || Object.keys(ch.points).length || ch.ratio !== null || ch.v_target_v !== null) rows.push(ch);
  }
  const intent = {};
  if (rows.length) Object.assign(intent, { scope: "unit", rows });
  const turbo = {};
  for (const k of ["P", "E"]) if (contents.turbo && Array.isArray(contents.turbo[k]) && contents.turbo[k].some((x, i) => x !== held.turbo[k][i])) turbo[k] = contents.turbo[k].slice();
  if (Object.keys(turbo).length) intent.turbo = turbo;
  const ring = {};
  for (const [no, mv] of Object.entries((contents.ring && contents.ring.points) || {})) if (no in held.ring && isNum(mv) && !sameRaw(mv, held.ring[no])) ring[no] = mv;
  if (Object.keys(ring).length) intent.ring = { points: ring };
  return intent;
}
const sameRaw = (a, b) => isNum(a) && isNum(b) && rawOf(a) === rawOf(b);

/** "" when the contents equal the held words, else the first difference. */
function heldDifference(contents, held) {
  const intent = intentToReach(contents, held);
  if (intent.rows && intent.rows.length) {
    const r = intent.rows[0];
    if (r.curve !== null) return `${r.target} whole-curve offset: the profile has ${r.curve} mV`;
    const pt = Object.entries(r.points)[0];
    if (pt) return `${r.target} at ${pt[0]}x the profile has ${pt[1]} mV`;
    return `${r.target} OC word differs`;
  }
  if (intent.turbo) return "the " + Object.keys(intent.turbo)[0] + " turbo table differs";
  return intent.ring ? `ring point ${Object.keys(intent.ring.points)[0]} differs` : "";
}

/** G-227 / R-B4: a tune.read / tune.last result (cloned) with the held state laid over it, like the helper's read of the words: the OC word (raw and decoded copy, with the OC point after
 *  the table when its ratio is above the fused top), every point, the ring points and the turbo tables. */
function overlayHeld(result, held) {
  const putPoint = (p, mv) => Object.assign(p, { offset_mv: mv, ...(typeof p.offset_raw === "number" ? { offset_raw: rawOf(mv) } : {}), ...(typeof p.word === "string" && typeof p.ratio === "number" ? { word: wordOf(mv, p.ratio) } : {}) });
  for (const u of result.units || []) {
    const mvs = held.units[u.id];
    if (!mvs) continue;
    const h = held.oc[u.id];
    const top = topOf(u.id);
    for (const cpu of u.cpus) {
      cpu.points = cpu.points.filter((p) => !(top !== null && p.ratio > top)); // the OC point is re-derived below
      for (const p of cpu.points) if (p.point in mvs) putPoint(p, mvs[p.point]);
      if (isObj(cpu.oc)) {
        const curve = held.curve[u.id] || 0;
        Object.assign(cpu.oc, { ratio: h.ratio, offset_mv: curve, offset_raw: rawOf(curve), v_target_raw: h.targetRaw, v_target_v: h.targetRaw ? vOfRaw(h.targetRaw) : 0.0, word: hex(vfWord(h.ratio, h.targetRaw, curve)) });
      }
      if (top !== null && h.ratio > top) cpu.points.push({ offset_mv: 0, offset_raw: 0, point: cpu.points.length + 1, ratio: h.ratio, static: false, v_target_raw: 0, v_target_v: 0.0, word: hex(h.ratio) });
    }
  }
  for (const [id, t] of Object.entries(result.tune || {})) {
    const mvs = held.units[id];
    if (!mvs) continue;
    const h = held.oc[id];
    const top = topOf(id);
    for (const cpu of t.cpus) {
      cpu.points = cpu.points.filter((p) => p.point === 0 || !(top !== null && p.ratio > top));
      for (const p of cpu.points) {
        if (p.point === 0) Object.assign(p, { offset_mv: held.curve[id] || 0, ratio: h.ratio || null, v_target_v: h.targetRaw ? vOfRaw(h.targetRaw) : null });
        else if (p.point in mvs) p.offset_mv = mvs[p.point];
      }
      if (top !== null && h.ratio > top) cpu.points.push({ mode: "adaptive", offset_mv: 0, point: cpu.points.length, point_label: "point " + cpu.points.length, ratio: h.ratio, v_target_v: null, oc_point: true });
    }
  }
  if (result.ring && Array.isArray(result.ring.points)) for (const p of result.ring.points) if (p.point in held.ring) putPoint(p, held.ring[p.point]);
  if (result.tables) Object.assign(result.tables, { p: held.turbo.P.slice(), e: held.turbo.E.slice() });
  if (result.turbo && result.turbo.P && result.turbo.E) {
    result.turbo.P.ratios = held.turbo.P.slice();
    result.turbo.E.ratios = held.turbo.E.slice();
  }
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** options: intervalMs (telemetry period, default 1000), stepMs (gap between replayed progress events, default 12; `?step=<ms>`), motion (see invent), helper ('ok' | key of LINK_FAILURES), now,
 *  baseline (curves.* answer the invented baseline; default on, `?baseline=none` turns it off), applyMode ('mismatch' | 'stale' | null; `?apply=`; see synthPlan above). */
function createBaseMockTransport({ intervalMs = 1000, stepMs = stepParam() ?? 12, motion = false, helper = "ok", now = () => Date.now(), baseline = !noBaselineParam(), applyMode = searchParam("apply"), profiles = searchParam("profiles"), accept = searchParam("accept"), fingerprint = searchParam("fingerprint"), read = searchParam("read"), diff = searchParam("diff"), uvp = searchParam("uvp"), cpuState = null } = {}) {
  const listeners = new Map(); // event -> Set(cb)
  const timers = new Set();
  // internal link state {state: "connecting" | "connected" | "down", error: {kind, message} | null}; the layers (g217/g218) read `.state` from status()
  let link = { state: "connecting", error: null };
  let mode = helper; // what the next connect gets ('ok' | key of LINK_FAILURES); dropLink(reason, {next}) changes it
  let seq = 0;
  let telemetryTimer = null;
  let tick = 0;
  let busyOp = null;
  let running = null; // the replay of the long op in flight ({id, cancelled, done, sent})
  // G-213 profiles state (see the block above createMockTransport)
  const profilesMode = profiles;
  const acceptUnavailable = accept === "unavailable";
  const readStale = read === "stale"; // `?read=stale`: profiles.save {from: "read"} / profiles.accept refuse STALE_READ until a tune.read is answered (G-228)
  let readFresh = !readStale;
  let unreadable = accept === "unreadable"; // `?accept=unreadable`: the accepted state cannot be read: profiles.accept refuses ACCEPTED_UNREADABLE until set_aside_unreadable is given (G-228)
  const diffExtras = diff === "extras"; // `?diff=extras`: the state of the last read differs from the accepted one ONLY in a unit's OC-word offset and a ring point (profiles.diff rows, no point change)
  let held = initialHeld(cpuState); // the words the mock CPU holds (R-B4: `cpuState` = a golden case's `read`, test seam)
  const uvpBios = uvp === "on"; // the mock BIOS has Undervolt Protection on (G-240)
  let uvpSeen = uvp === "off" ? "off" : "unknown"; // what the mock helper reports for this boot
  let appliedHere = false; // a tune.apply finished in this mock session: tune.last then answers the held words, as the helper's does after an apply (G-227)
  const saved = new Map(); // name -> {created, contents}
  if (profilesMode !== "none") for (const g of profilesGet) saved.set(g.result.name, { created: g.result.created, contents: upgradeContents(clone(g.result.contents)) });
  let accepted = profilesMode === "accepted" && !unreadable ? { name: "read-20261018-120000", contents: contentsOfHeld(held) } : null;
  const planIntents = new Map(); // plan_id -> the intent it was made from (what an apply puts into `held`)
  const planWords = new Map(); // plan_id -> the 0x11 words it writes [{unit, cpu, point, word, stage}] (what the apply reads back)

  const emit = (event, payload) => {
    for (const cb of [...(listeners.get(event) || [])]) cb(payload);
  };
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    if (t.unref) t.unref();
    timers.add(t);
    return t;
  };
  const connected = () => link.state === "connected";

  function startTelemetry(id) {
    if (telemetryTimer) clearInterval(telemetryTimer);
    const frames = telemetry.events.filter((e) => e.event === "telemetry");
    const beats = telemetry.events.filter((e) => e.event === "heartbeat");
    telemetryTimer = setInterval(() => {
      const i = tick++;
      const src = frames[i % frames.length];
      const values = motion ? invent(src.values, i) : clone(src.values);
      values.ts = now() / 1000;
      emit("telemetry", { op_id: id, t: now() / 1000, values });
      if (i % 2 === 0 && beats.length) emit("heartbeat", { ...clone(beats[(i / 2) % beats.length | 0]), op_id: busyOp });
    }, intervalMs);
    if (telemetryTimer.unref) telemetryTimer.unref();
  }

  /** Replay recorded state/progress events for a long op, then the final `result`. Resolves nothing; the caller already answered {id}. */
  function replayLong(id, events, finalResponse) {
    busyOp = id;
    const run = { id, cancelled: false, done: false, sent: 0 };
    running = run;
    const finish = (response) => {
      if (run.done) return;
      run.done = true;
      busyOp = null;
      running = null;
      emit("state", { op_id: id, state: "idle" });
      emit("result", response);
    };
    // `cancel` takes effect at the next boundary between events, like the helper's between-transactions check (G-210)
    const cancelled = () => finish(fail(id, "CANCELLED", `cancelled between transactions after ${run.sent} progress step(s); the requests already sent are in the audit log`));
    let delay = 0;
    for (const ev of events) {
      const { event, ...payload } = ev;
      delay += stepMs;
      later(() => {
        if (run.done) return;
        if (run.cancelled) return cancelled();
        if (event === "progress") run.sent++;
        emit(event, { ...payload, op_id: id });
      }, delay);
    }
    later(() => (run.cancelled ? cancelled() : finish(finalResponse)), delay + stepMs);
  }

  // ---- plans (G-210): the recorded one plus the ones synthesized from an intent; a plan is single use and `apply=stale` forgets them all once ----
  const plans = new Map(); // plan_id -> plan result
  let planSeq = 0;
  let staleFired = false;
  let recordedGone = false; // the recorded plan was applied or forgotten: the next plan of an empty intent gets a fresh id
  const nonceOf = (n) => "M" + n.toString(8).padStart(5, "0").replace(/\d/g, (d) => String(Number(d) + 2));
  function issuePlan(intent, { whole = false } = {}) {
    const synth = synthPlan(intent, held);
    const recorded = tunePlan.response.result;
    if (!synth.writes && !recordedGone && !whole) {
      if (!plans.has(recorded.plan_id)) plans.set(recorded.plan_id, clone(recorded)); // the recorded one-point plan
      planIntents.set(recorded.plan_id, tunePlan.request.args.intent);
      return plans.get(recorded.plan_id);
    }
    const n = ++planSeq;
    const plan = clone(recorded);
    plan.plan_id = String(n).padStart(8, "0") + "c0ffee".repeat(10).slice(0, 56);
    plan.nonce = nonceOf(n);
    plan.name = "tune-mock" + n;
    if (synth.writes) {
      const conditional = synth.steps.filter((s) => s.conditional).length;
      const writes = synth.steps.length - conditional;
      Object.assign(plan, { steps: synth.steps, before: synth.before, after: synth.after, units: synth.units, writes, conditional_writes: conditional, nothing_to_do: false, reads: 2, ops_needed: (writes + conditional) * 2 + 2, rounds: 1 });
      // INVENTED prediction (the recorded plan has none): P0 sets the maximum
      plan.vccia = { predicted_v: 1.28, label: "prediction, not a measurement", set_by: { unit: "P0", ratio: 57 }, active_cores: "all", margin_v: 0.05, before_v: 1.29 };
      const mvs = [...synth.steps.map((s) => s.offset_mv), ...(intent.rows || []).map(changesOf).filter(Boolean).map((c) => c.curve)].filter((x) => typeof x === "number");
      plan.warnings.unshift(...turboBelowOc(intent));
      if (mvs.some((x) => x > 0)) plan.warnings.unshift({ code: "POSITIVE_OFFSET", text: "a positive offset raises the voltage of the point: more heat, not more stability headroom" });
      if ((intent.rows || []).map(changesOf).some((c) => c && c.target.startsWith("EC") && "40" in c.points)) plan.warnings.unshift({ code: "E40_OFFSET", text: "an offset on the E-cluster 40x point has been reported to destabilise the cluster [COMMUNITY]" });
    } else if (whole) {
      // a profile that equals what the CPU holds: nothing to write
      Object.assign(plan, { steps: [], before: {}, after: {}, units: [], writes: 0, conditional_writes: 0, residual_writes_max: 0, based_on_read_at: isoSeconds(now()), nothing_to_do: true, reads: 0, ops_needed: 0, rounds: 0, warnings: [] });
    }
    plans.set(plan.plan_id, plan);
    planIntents.set(plan.plan_id, intent);
    planWords.set(plan.plan_id, synth.words || []);
    return plan;
  }

  // {profile: name} / {restore: "accepted"}: the plan of the writes that take the held words to the profile's contents
  function planWholeState(intent) {
    let contents;
    if (intent.restore !== undefined) {
      if (!accepted) return { error: { code: "REFUSED", message: "there is no usable accepted state yet (save a profile as accepted on the Profiles tab). Nothing was sent.", detail: { check: "NO_ACCEPTED_STATE" } } };
      contents = accepted.contents;
    } else if (accepted && accepted.name === intent.profile) contents = accepted.contents;
    else if (saved.has(intent.profile)) contents = saved.get(intent.profile).contents;
    else return { error: { code: "BAD_REQUEST", message: `no such profile: ${intent.profile}`, detail: { check: "PROFILE_NOT_FOUND" } } };
    const target = intentToReach(contents, held);
    const refused = mockRefusal(target);
    if (refused) return { error: { code: "REFUSED", message: refused, detail: { check: "POLICY_RANGE" } } };
    const synth = synthPlan(target, held);
    if (synth.error) return { error: { code: "BAD_REQUEST", message: synth.error } };
    return { plan: issuePlan(target, { whole: true }) };
  }

  const acceptedMatch = () => {
    if (!accepted) return null;
    return [{ cpu: 0, match: heldDifference(accepted.contents, held) === "", diffs: [] }];
  };
  const getResult = (name) => {
    if (accepted && accepted.name === name) return { name, source: "accepted", created: null, complete: true, contents: clone(accepted.contents), summary: summarize(accepted.contents) };
    const rec = saved.get(name);
    if (!rec) return null;
    return { name, source: "saved", created: rec.created, complete: rec.contents.complete === true, contents: clone(rec.contents), summary: summarize(rec.contents) };
  };
  /** The final response and progress events of an apply of `plan` (the recorded ones for the recorded plan). */
  function applyOutcome(id, plan) {
    if (plan.plan_id === tunePlan.response.result.plan_id) return { events: tuneApplyEvents, response: ok(id, clone(tuneApply.response.result)) };
    const done = plan.steps.filter((s) => !s.conditional);
    // R-B4: every 0x11 word the plan writes is read back (both words of a voltage-first / frequency-first pair), then the turbo tables
    const readback = (planWords.get(plan.plan_id) || []).map((w) => ({ actual: w.word.toLowerCase(), cpu: w.cpu, expected: w.word.toLowerCase(), match: true, point: w.point, unit: w.unit }));
    // R-I1: a table write reads back the plan's 8 bucket ratios, bucket 0 in bits 7:0 (guard/policy.py turbo_bytes); the shell folds it into the tables it knows
    const packed = (r) => "0x" + r.slice().reverse().map((x) => x.toString(16).padStart(2, "0")).join("");
    for (const s of done.filter((x) => x.kind === "write_msr")) {
      const table = ((planIntents.get(plan.plan_id) || {}).turbo || {})[String(s.table).toUpperCase()];
      const word = Array.isArray(table) && table.length === 8 ? packed(table) : "0x" + (0x3a3a3a3a).toString(16);
      readback.push({ actual: word, cpu: 0, expected: word, match: true, point: "turbo", unit: s.table });
    }
    if (applyMode === "mismatch" && readback.length) {
      const last = readback[readback.length - 1];
      last.match = false;
      last.actual = "0x" + ((parseInt(last.expected, 16) ^ 0x20) >>> 0).toString(16).padStart(8, "0");
    }
    const result = {
      ...clone(tuneApply.response.result),
      plan_id: plan.plan_id,
      readback,
      steps: done.map((s) => ({ cpu: s.cpu ?? 0, kind: s.kind, n: s.n, point: s.point ?? "turbo", status: "ok", unit: s.unit })),
      ops_used: plan.ops_needed,
      writes_sent: done.length,
    };
    const events = [{ event: "state", state: "applying" }];
    for (let step = 1; step <= plan.ops_needed; step++) events.push({ event: "progress", of: plan.ops_needed, ops_budget: 100000, ops_used: 152 + step, step });
    return { events, response: ok(id, result) };
  }

  return {
    /** Internal (the outer layer turns it into the shell's Status JSON): a live link stays; otherwise one attempt with the current mode. */
    async connect() {
      if (connected()) return link;
      const fail_ = LINK_FAILURES[mode];
      link = fail_ ? { state: "down", error: { ...fail_ } } : { state: "connected", error: null };
      return link;
    },
    async status() {
      return link;
    },
    /** Test seam: the helper goes away (restart, crash). Its telemetry and the long op it was replaying end with the connection, as the real helper's do;
     *  `next` is what the next connect finds ('ok' by default: socket activation starts a new helper). */
    dropLink(reason = "eof", { next = "ok" } = {}) {
      if (telemetryTimer) clearInterval(telemetryTimer);
      telemetryTimer = null;
      if (running) running.done = true;
      running = null;
      busyOp = null;
      link = { state: "down", error: lostError(reason) };
      mode = next;
    },
    async call(op, args = {}) {
      const id = `m${++seq}`;
      if (!connected()) return fail(id, "NOT_CONNECTED", "the mock helper is not connected");
      switch (op) {
        case "preflight":
          return ok(id, currentPreflight(mode, args && args.client));
        case "telemetry.start":
          startTelemetry(id);
          return ok(id, { ...clone(telemetryStart.result), op_id: id, interval_s: intervalMs / 1000 });
        case "telemetry.stop":
          if (telemetryTimer) clearInterval(telemetryTimer);
          telemetryTimer = null;
          return ok(id, { ...clone(telemetryStop.result) });
        case "tune.last": {
          const r = clone(tuneLast.result);
          if (r.available) r.result.uvp = uvpSeen;
          if (r.available) r.at = now() / 1000 - 60; // pretend the recorded read happened a minute ago
          if (r.available && appliedHere && searchParam("last") === "gone") return ok(id, { available: false }); // `?last=gone`: the helper kept no record of the apply (the page must still show the applied words)
          if (r.available && (appliedHere || cpuState)) overlayHeld(r.result, held);
          if (r.available && accepted) Object.assign(r.result, { accepted_match: acceptedMatch(), accepted_note: null }); // G-213: redone against the (invented) accepted state
          return ok(id, r);
        }
        case "curves.list":
          return ok(id, { curves: baseline ? [{ id: "mock-baseline", name: "Mock stock baseline (invented)", baseline: true, created: "2026-01-01T00:00:00Z" }] : [], no_turbo: false });
        case "curves.get":
          if (!baseline || args.id !== "mock-baseline") return fail(id, "NOT_FOUND", "no such curve in the mock");
          return ok(id, inventedBaseline());
        case "profiles.list": {
          const entries = [...saved].map(([name, rec]) => ({ name, source: "saved", created: rec.created, complete: true }));
          const result = { profiles: [...(accepted ? [{ name: accepted.name, source: "accepted", created: null, complete: true }] : []), ...entries], accepted: !!accepted };
          if (!accepted) result.note = profilesSavedList.result.note;
          return ok(id, result);
        }
        case "profiles.get": {
          if (typeof args.name !== "string" || !PROFILE_NAME_RE.test(args.name)) return fail(id, "BAD_REQUEST", "'name' must be 1..64 characters of a-z 0-9 . _ -");
          const got = getResult(args.name);
          return got ? ok(id, got) : fail(id, "BAD_REQUEST", `no profile named '${args.name}'`, { check: "PROFILE_NOT_FOUND" });
        }
        case "profiles.save": {
          // helper ops_profiles.py op_profiles_save (R-B1): the read with the editor's edits laid over it — rows, turbo tables and ring points in `intent`; the power limits
          // (`power`) and the ratio caps / uncore range (`runtime`) are checked and recorded by the G-217 layer, which holds those values — or the read as it is (`from: "read"`)
          if (typeof args.name !== "string" || !PROFILE_NAME_RE.test(args.name)) return fail(id, "BAD_REQUEST", "'name' must be 1..64 characters of a-z 0-9 . _ -");
          const edits = ["intent", "power", "runtime"].filter((k) => args[k] !== undefined);
          let intent = null;
          if (args.from !== undefined) { // G-228: the complete state of the last read, no rows, never accepted
            if (edits.length) return fail(id, "BAD_REQUEST", "give the editor's edits ('intent', 'power', 'runtime') or 'from': 'read' (the state of the last read), not both");
            if (args.from !== "read") return fail(id, "BAD_REQUEST", "'from' must be 'read'");
          } else {
            if (!edits.length) return fail(id, "BAD_REQUEST", "profiles.save needs the editor's edits ('intent', and / or 'power', 'runtime'; an empty intent saves the read as it is) or 'from': 'read'");
            if (args.intent !== undefined) {
              intent = args.intent;
              if (!isObj(intent)) return fail(id, "BAD_REQUEST", "'intent' must be an object");
              if (["profile", "reset", "restore"].some((k) => k in intent)) return fail(id, "BAD_REQUEST", "'intent' of profiles.save is the editor's edits: {scope, rows[, turbo][, ring]} (not a profile, reset or restore)");
              const shape = helperRefusal(intent); // the same range checks as a plan
              if (shape && !(shape.detail && shape.detail.check === "NOTHING_TO_DO")) return fail(id, shape.code, shape.message, shape.detail);
              if (shape) intent = null; // rows that change nothing save the read as it is
              const refused = intent && mockRefusal(intent);
              if (refused) return fail(id, "REFUSED", refused, { check: "POLICY_RANGE" });
            }
          }
          if (saved.has(args.name) || (accepted && accepted.name === args.name)) return fail(id, "REFUSED", `a profile named '${args.name}' already exists (profiles are never overwritten)`, { check: "EXISTS" });
          if (!readFresh) return fail(id, "REFUSED", "the words of the last read may no longer be what the CPU holds: a write came after it. Read again first (Tune > Read), then save. Nothing was saved.", { check: "STALE_READ" });
          const contents = contentsOfHeld(intent ? heldAfter(held, intent) : held);
          const created = isoSeconds(now());
          saved.set(args.name, { created, contents });
          const result = {
            name: args.name, source: "saved", created, complete: true, units: contents.rows.length, points: readUnits().reduce((n, u) => n + pointsOfUnit(u.id).length, 0),
            turbo: true, ring_points: contents.ring ? Object.keys(contents.ring.points).length : 0, power: false, caps: false, uncore: false, not_captured: [], version: PROFILE_SCHEMA,
          };
          if (args.from !== undefined) result.from = "read";
          return ok(id, result);
        }
        case "profiles.diff": {
          const refOk = (v) => typeof v === "string" && PROFILE_NAME_RE.test(v);
          if (!refOk(args.a) || !refOk(args.b) || Object.keys(args).some((k) => k !== "a" && k !== "b")) return fail(id, "BAD_REQUEST", "give 'a' and 'b': 'accepted', 'read' or a saved profile name");
          const side = (ref) => {
            if (ref === "read") {
              return readFresh
                ? { source: "read", name: null, facts: diffFacts(contentsOfHeld(held)) }
                : { error: ["STALE_READ", "the words of the last read may no longer be what the CPU holds: a write came after it. Read again first (Tune > Read)."] };
            }
            if (ref === "accepted" || (accepted && accepted.name === ref)) {
              return accepted ? { source: "accepted", name: accepted.name, facts: diffFacts(accepted.contents) } : { error: ["NO_ACCEPTED_STATE", "No accepted state yet: save a profile as accepted (Profiles)."] };
            }
            const rec = saved.get(ref);
            return rec ? { source: "saved", name: ref, facts: diffFacts(rec.contents) } : { error: ["PROFILE_NOT_FOUND", `no saved profile named '${ref}'`] };
          };
          const sa = side(args.a);
          const sb = side(args.b);
          const bad = sa.error || sb.error;
          if (bad) return fail(id, bad[0].startsWith("PROFILE_") ? "BAD_REQUEST" : "REFUSED", bad[1], { check: bad[0] });
          if (diffExtras) {
            if (args.a === "accepted") sa.facts.push({ unit: "P1", order: 0, label: "OC word: whole-curve offset", kind: "mv", value: 0 });
            if (args.b === "read") sb.facts.push({ unit: "P1", order: 0, label: "OC word: whole-curve offset", kind: "mv", value: -5 }, { unit: "ring", order: 24, label: "Offset at 14x", kind: "mv", value: -25 });
          }
          const key = (f) => `${f.unit}|${f.order}`;
          const fa = new Map(sa.facts.map((f) => [key(f), f]));
          const fb = new Map(sb.facts.map((f) => [key(f), f]));
          const rows = [...new Set([...fa.keys(), ...fb.keys()])]
            .map((k) => {
              const x = fa.get(k);
              const y = fb.get(k);
              const f = x || y;
              return { unit: f.unit, order: f.order, label: f.label, kind: f.kind, a: x ? x.value : null, b: y ? y.value : null };
            })
            .filter((r) => r.a !== r.b)
            .sort((p, q) => DIFF_UNITS.indexOf(p.unit) - DIFF_UNITS.indexOf(q.unit) || p.order - q.order)
            .map(({ order, ...r }) => r);
          const units = [];
          for (const r of rows) {
            const last = units[units.length - 1];
            if (last && last.unit === r.unit) last.n++;
            else units.push({ unit: r.unit, n: 1 });
          }
          const info = (x, ref) => ({ ref, name: x.name, source: x.source, partial: false });
          return ok(id, {
            a: info(sa, args.a), b: info(sb, args.b), rows, units, truncated: 0,
            compared: ["each unit's OC word (whole-curve offset, OC ratio, OC target voltage)", "every fused point's offset", "the turbo tables"],
            not_compared: [{ what: "the ring", why: "neither state records it" }],
          });
        }
        case "profiles.accept": {
          if (acceptUnavailable) return { ...clone(profilesAcceptUnavailable), id };
          if (args.set_aside_unreadable !== undefined && args.set_aside_unreadable !== true) return fail(id, "BAD_REQUEST", "'set_aside_unreadable' must be true when given");
          if (unreadable && args.set_aside_unreadable !== true) {
            return fail(id, "REFUSED", "the accepted state that this would replace cannot be read (accepted CURRENT lists no profile), so it cannot be kept as a profile. You can have the whole directory /etc/linux-xtu/accepted moved aside to /etc/linux-xtu/accepted.unreadable-20261018-120000 (nothing is deleted) and accept anyway. Nothing was changed.", { check: "ACCEPTED_UNREADABLE" });
          }
          if (!readFresh) return fail(id, "REFUSED", "the words of the last read may no longer be what the CPU holds: a write came after it. Read again first (Tune > Read), then accept. Nothing was changed.", { check: "STALE_READ" });
          let name;
          if (args.from !== undefined) {
            if (args.from !== "read") return fail(id, "BAD_REQUEST", "'from' must be 'read'");
            name = "read-" + isoSeconds(now()).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
          } else {
            if (typeof args.name !== "string" || !PROFILE_NAME_RE.test(args.name)) return fail(id, "BAD_REQUEST", "'name' must be 1..64 characters of a-z 0-9 . _ -");
            const got = getResult(args.name);
            if (!got) return fail(id, "BAD_REQUEST", `no profile named '${args.name}'`, { check: "PROFILE_NOT_FOUND" });
            const difference = heldDifference(got.contents, held);
            if (difference) return fail(id, "REFUSED", `'${args.name}' is not what the CPU holds now (${difference}). Apply it first (Profiles > Review and apply), then set it as accepted.`, { check: "NOT_APPLIED" });
            name = args.name;
          }
          const replaced = accepted ? [accepted.name] : [];
          let previous = null; // G-228: the replaced state is kept as a saved profile first
          const setAside = unreadable ? "/etc/linux-xtu/accepted.unreadable-20261018-120000" : null;
          if (accepted) {
            const base = "accepted-before-" + isoSeconds(now()).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
            previous = base;
            for (let n = 2; saved.has(previous); n++) previous = `${base}-${n}`;
            saved.set(previous, { created: isoSeconds(now()), contents: clone(accepted.contents) });
          }
          accepted = { name, contents: contentsOfHeld(held) };
          unreadable = false;
          const sum = summarize(accepted.contents);
          return ok(id, { name, source: "accepted", from: args.from !== undefined ? "read" : "saved", accepted_at: isoSeconds(now()), replaced, previous_saved_as: previous, previous_saved_names: previous ? [previous] : [], set_aside_as: setAside, cpus: 24, core_entries: sum.units, points: sum.points, turbo: true, complete: true, ring_points: accepted.contents.ring ? Object.keys(accepted.contents.ring.points).length : 0, fingerprint: "complete" });
        }
        case "profiles.fingerprint": {
          if (acceptUnavailable) return { ...clone(profilesFingerprintUnavailable), id };
          if (!accepted) return fail(id, "REFUSED", "there is no accepted state to record a fingerprint for; accept a profile first (Profiles > Set as accepted).", { check: "NO_ACCEPTED_STATE" });
          const incomplete = fingerprint === "incomplete";
          return ok(id, { recorded: isoSeconds(now()), cpus: 24, accepted: [accepted.name], fingerprint: incomplete ? "incomplete: no CPU identity under the simulator" : "complete" });
        }
        case "audit.tail":
          return ok(id, clone(auditTailPage(auditTail.result, args)));
        case "tune.plan": {
          if (!args.intent || typeof args.intent !== "object") return fail(id, "BAD_REQUEST", "tune.plan needs {intent: {...}}");
          if (args.intent.profile !== undefined || args.intent.restore !== undefined) {
            const whole = planWholeState(args.intent);
            return whole.error ? fail(id, whole.error.code, whole.error.message, whole.error.detail) : ok(id, clone(whole.plan));
          }
          const shape = helperRefusal(args.intent); // the helper's own BAD_REQUEST / POLICY_RANGE / TURBO_ORDER answers, word for word
          if (shape) return fail(id, shape.code, shape.message, shape.detail);
          const refused = mockRefusal(args.intent);
          if (refused) return fail(id, "REFUSED", refused, { check: "POLICY_RANGE" });
          const planned = synthPlan(args.intent, held);
          if (planned.error) return fail(id, "BAD_REQUEST", planned.error); // a PlanError is BAD_REQUEST at plan (ops_tune.py)
          const negative = negativeOffsets(args.intent);
          if (uvpSeen === "on" && negative.length) return fail(id, "REFUSED", `${negative[0][0]}: offset ${negative[0][1]} mV: ${UVP_MESSAGE} Nothing was sent.`, { check: "UNDERVOLT_PROTECTION" });
          return ok(id, { ...clone(issuePlan(args.intent)), uvp: uvpSeen }); // an empty intent answers the recorded one-point plan; anything else is synthesized (synthPlan)
        }
        case "cancel": {
          if (args.op_id !== undefined && args.op_id !== null && args.op_id !== busyOp) return fail(id, "BAD_REQUEST", `${JSON.stringify(args.op_id)} is not the running operation`, { state: busyOp ? "applying" : "idle", op_id: busyOp });
          if (!running) return ok(id, { cancelled: false, state: "idle" });
          running.cancelled = true;
          return ok(id, { cancelled: true, op_id: running.id, state: "applying" });
        }
        case "tune.read": {
          if (busyOp) return fail(id, "BUSY", "another long op is running", { state: "applying", op_id: busyOp });
          const result = clone(tuneRead.result);
          overlayHeld(result, held); // R-B4: a read shows what the mock CPU holds, the applied whole-curve layer included
          result.read_at = new Date(now()).toISOString().replace(/\.\d+Z$/, "Z");
          result.uvp = uvpSeen;
          readFresh = true;
          replayLong(id, tuneReadEvents, ok(id, result));
          return { id };
        }
        case "tune.apply": {
          if (busyOp) return fail(id, "BUSY", "another long op is running", { state: "applying", op_id: busyOp });
          const plan = plans.get(args.plan_id);
          if (!plan) return fail(id, "PLAN_STALE", "no such plan (the mock only knows the plans it issued, once each)");
          if (applyMode === "stale" && !staleFired) {
            staleFired = true;
            recordedGone = true;
            plans.clear();
            return fail(id, "PLAN_STALE", "a word changed since this plan was made, or the plan is gone. Nothing was written. Plan again.");
          }
          if (args.typed !== `CONFIRM ${plan.nonce}`) return fail(id, "CONFIRM_MISMATCH", "the typed confirmation does not match the plan's nonce");
          plans.delete(plan.plan_id); // single use
          if (uvpBios && negativeOffsets(planIntents.get(plan.plan_id)).length) {
            uvpSeen = "on";
            return fail(id, "REFUSED", UVP_MESSAGE, { check: "UNDERVOLT_PROTECTION", ops_done: 8 });
          }
          held = heldAfter(held, planIntents.get(plan.plan_id), { asWords: true }); // G-213: what the mock CPU holds now (profiles.accept compares with it); R-B4: as words
          appliedHere = true;
          if (plan.plan_id === tunePlan.response.result.plan_id) recordedGone = true;
          if (!uvpBios && uvpSeen === "unknown" && negativeOffsets(planIntents.get(plan.plan_id)).length) uvpSeen = "off"; // a negative offset went in: Undervolt Protection is off
          const outcome = applyOutcome(id, plan);
          if (outcome.response && outcome.response.result) outcome.response.result.uvp = uvpSeen;
          replayLong(id, outcome.events, outcome.response);
          return { id };
        }
        default:
          return fail(id, "UNKNOWN_OP", `the mock bridge has no fixture for ${op}`);
      }
    },
    listen(event, cb) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    close() {
      if (telemetryTimer) clearInterval(telemetryTimer);
      telemetryTimer = null;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      listeners.clear();
    },
  };
}

// G-218: Curves/Stress fixtures and run simulation are layered on top of the base transport.
import { wrapMockTransport } from "./mock-backend-g218.js";
// G-217: power.* / runtime.* (Tune → Power, Ring & uncore, Ratio caps) and `cpu_limits` on the reads, layered on top
import { wrapMockTransportG217 } from "./mock-backend-g217.js";

// ---- the shell layer (R-A4): what the Rust side does between the helper and the webview, so the mock and the AppImage answer alike ----
const cut = (s) => [...String(s)].slice(0, DETAIL_ALLOW.str_max).join("");

/** Rust link.rs public_detail: scalars of the allowed keys, capped string lists, nothing else. */
function publicDetail(det) {
  const keep = {};
  for (const [k, v] of Object.entries(det)) {
    if (DETAIL_ALLOW.scalars.includes(k)) {
      if (typeof v === "string") keep[k] = cut(v);
      else if (v === null || typeof v === "number" || typeof v === "boolean") keep[k] = v;
    } else if (Object.hasOwn(DETAIL_ALLOW.lists, k) && Array.isArray(v)) {
      const max = DETAIL_ALLOW.lists[k];
      const strs = v.filter((x) => typeof x === "string");
      const over = strs.length > max;
      const list = strs.slice(0, over ? max - 1 : max).map(cut);
      if (over) list.push(`... and ${strs.length - (max - 1)} more not shown`);
      keep[k] = list;
    }
  }
  return keep;
}

/** Rust link.rs public_response: `{id, ok:true, result}` (a result's `nonce` removed: the shell keeps it) or `{id, ok:false, error:{code, message ≤ 500 chars, detail?}}`. */
export function publicResponse(resp) {
  const r = resp && typeof resp === "object" ? resp : {};
  const id = r.id === undefined ? null : r.id;
  if (r.ok === true) {
    let result = r.result === undefined ? null : r.result;
    if (result && typeof result === "object" && !Array.isArray(result) && "nonce" in result) {
      result = { ...result };
      delete result.nonce;
    }
    return { id, ok: true, result };
  }
  const err = r.error && typeof r.error === "object" && !Array.isArray(r.error) ? r.error : {};
  const out = { code: typeof err.code === "string" ? err.code : "INTERNAL", message: err.message == null ? "" : cut(typeof err.message === "string" ? err.message : JSON.stringify(err.message)) };
  if (err.detail && typeof err.detail === "object" && !Array.isArray(err.detail)) {
    const keep = publicDetail(err.detail);
    if (Object.keys(keep).length) out.detail = keep;
  }
  return { id, ok: false, error: out };
}

// ---- the confirmation (R-S3, D-053 item 4): src-tauri/src/helper/confirm.rs + link.rs + ops.rs, word for word (contract.test.mjs holds it to the samples) ----
export const SHELL_OPS = ["app.confirm"];
/** ops.rs PERSIST_OPS: sent only after a native dialog shown for that very request. */
export const PERSIST_OPS = ["profiles.accept", "profiles.fingerprint"];
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE_OK = /^[A-Z2-9]{6}$/;
const PROFILE_NAME = /^[a-z0-9._-]{1,64}$/;
const MAX_CONFIRM_PLANS = 4;
const APPROVAL_TTL_MS = 600_000;
const COOLDOWN_MS = 2000; // confirm.rs COOLDOWN: no dialog for 2 s after a Cancel
const PLAN_KIND = { "tune.plan": "tune", "power.plan": "power", "runtime.plan": "runtime" };
const APPLY_KIND = { "tune.apply": "tune", "power.apply": "power", "runtime.apply": "runtime" };
const PLAN_OP = { tune: "tune.plan", power: "power.plan", runtime: "runtime.plan" };
const APPLY_OP = { tune: "tune.apply", power: "power.apply", runtime: "runtime.apply" };
const MAX_PLANS = 8;
export const CONFIRM_TEXT = {
  gone: "refused locally: the app no longer holds this plan (used, replaced, or the helper connection changed). Nothing was written. Review again.",
  noNonce: "refused locally: this plan carries no confirmation code, so the app cannot apply it. Nothing was written.",
  notConfirmed: "refused locally: this plan was not confirmed in the system dialog. Nothing was sent.",
  typed: "refused locally: the page never sends a confirmation code (the app asks you in its own dialog and adds it)",
  onlyPlanId: "refused locally: an apply names its plan_id and, optionally, the intent the editor holds now",
  badIntent: (kind) => `refused locally: the intent of ${APPLY_OP[kind]} has the wrong shape (it is the ${PLAN_OP[kind]} request the editor would send now)`,
  undescribed: (why) => `the app cannot show every value this plan writes: ${why}. Review again; if it persists, update the app and the helper together`,
  page_preflight: "refused locally: the page sends preflight {} (the app declares its own client and version)",
  badConfirm: "refused locally: app.confirm takes {plans: [{op, plan_id}, ...]} (1 to 4 plans)",
  declined: "Not confirmed in the system dialog. Nothing was written.",
  unavailable: (why) => `The confirmation dialog could not be shown (${why}). Nothing was written.`,
  busy: (why) => `No dialog: ${why}. Nothing was written.`,
  open: "a confirmation dialog is already open; answer it first",
  pause: "you cancelled a moment ago; try again in 2 s",
  step2: "refused locally: the page never sends the confirmation step of an accept (the app asks you in its own dialog and sends it)",
  shape: (op) => `refused locally: arguments of ${op} have the wrong shape`,
  noCode: "refused locally: the helper asked for a confirmation step but its answer carried no usable code. Nothing was accepted.",
};
const nothingWritten = (code, message) => ({ ok: false, error: { code, message, detail: { writes_sent: 0 } } });
/** ops.rs needs_operator: an *.apply or a persistent op (the shell sends it only after the operator's OK). */
export const needsOperator = (op) => !!APPLY_KIND[op] || PERSIST_OPS.includes(op);

/** ops.rs webview_persist_args: accept step 1 ({name} | {from: "read"} [+ set_aside_unreadable: true]) or fingerprint {}. -> refusal | null. */
function persistRefusal(op, args) {
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : null;
  if (!a) return nothingWritten("BAD_REQUEST", "refused locally: args must be a JSON object");
  if (op === "profiles.accept") {
    if ("plan_id" in a || "typed" in a) return nothingWritten("BAD_REQUEST", CONFIRM_TEXT.step2);
    const rest = { ...a };
    const asideOk = !("set_aside_unreadable" in rest) || rest.set_aside_unreadable === true;
    delete rest.set_aside_unreadable;
    const keys = Object.keys(rest);
    const ok = asideOk && keys.length === 1 && ((keys[0] === "name" && safeProfileName(rest.name)) || (keys[0] === "from" && rest.from === "read"));
    return ok ? null : nothingWritten("BAD_REQUEST", CONFIRM_TEXT.shape(op));
  }
  return Object.keys(a).length ? nothingWritten("BAD_REQUEST", CONFIRM_TEXT.shape(op)) : null;
}

// ---- R-I1: ops.rs argument checks, confirm.rs dialog text, version.rs handshake — ported line by line (contract.test.mjs feeds the Rust-generated samples through
// these: `validators`, `dialog`, `version` of contract-samples.json). Only the ops the R-I1 arguments touch are checked here; the helper checks everything again.
const isObj_ = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const has_ = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const keysWithin = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));
const keysExactly = (o, wanted) => Object.keys(o).length === wanted.length && wanted.every((k) => has_(o, k));
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const intIn = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;
const isU64 = (v) => isInt(v) && v >= 0;
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const allChars = (s, min, max, ok) => {
  const cs = [...s];
  return cs.length >= min && cs.length <= max && cs.every(ok);
};
const DIGIT = (c) => c >= "0" && c <= "9";
const profileName = (s) => typeof s === "string" && PROFILE_NAME.test(s);
const safeProfileName = (s) => profileName(s) && !s.startsWith(".") && !s.startsWith("-") && !s.includes("..");
const hex64 = (s) => typeof s === "string" && HEX64.test(s);
const typedOk = (s) => typeof s === "string" && /^CONFIRM [A-Z2-9]{6}$/.test(s);
const unitId = (s) => typeof s === "string" && /^(P|EC)(0|[1-9][0-9]{0,2})$/.test(s);
const MAX_INTENT_BYTES = 16 * 1024;
const intentSizeOk = (v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_INTENT_BYTES;
const mvNumber = (v) => typeof v === "number";
const digits = (k, max) => allChars(k, 1, max, DIGIT);

/** ops.rs tune_row: the shape of a row (known keys, a target, offset / v_target_v / ratio typed); value ranges and a target twice are the helper's to judge. */
function tuneRow(v, simple) {
  if (!isObj_(v) || !keysWithin(v, ["target", "offset", "v_target_v", "ratio"])) return false;
  const targetOk = typeof v.target === "string" && (simple ? v.target === "P" || v.target === "E" : unitId(v.target));
  const o = has_(v, "offset") ? v.offset : null;
  const offsetOk = o === null
    || (isObj_(o) && keysExactly(o, ["kind", "mv"]) && (o.kind === "curve" ? mvNumber(o.mv)
      : o.kind === "points" ? isObj_(o.mv) && Object.keys(o.mv).length >= 1 && Object.keys(o.mv).length <= 12 && Object.entries(o.mv).every(([k, mv]) => digits(k, 3) && mvNumber(mv)) : false));
  const vtOk = !has_(v, "v_target_v") || v.v_target_v === null || typeof v.v_target_v === "number";
  const ratioOk = !has_(v, "ratio") || v.ratio === null || isInt(v.ratio);
  return targetOk && offsetOk && vtOk && ratioOk;
}
const turboTables = (v) => isObj_(v) && Object.keys(v).length > 0 && keysWithin(v, ["P", "E"]) && Object.values(v).every((t) => Array.isArray(t) && t.length === 8 && t.every(isInt));
const ringPoints = (v) => isObj_(v) && keysExactly(v, ["points"]) && isObj_(v.points) && Object.keys(v.points).length >= 1 && Object.keys(v.points).length <= 15
  && Object.entries(v.points).every(([k, mv]) => digits(k, 2) && mvNumber(mv));
/** ops.rs tune_intent: the shape of an ops_tune.py canonical_intent (keys, types, sizes); `editsOnly` (profiles.save) refuses the whole-state intents. */
export function tuneIntentOk(v, editsOnly = false) {
  if (!isObj_(v) || !intentSizeOk(v)) return false;
  const has = (k) => has_(v, k);
  if (keysWithin(v, ["scope", "rows", "turbo", "ring"]) && (has("rows") || has("turbo") || has("ring")) && has("rows") === has("scope")) {
    if ((has("turbo") && !turboTables(v.turbo)) || (has("ring") && !ringPoints(v.ring))) return false;
    if (!has("rows")) return true;
    if (v.scope !== "simple" && v.scope !== "unit") return false;
    return Array.isArray(v.rows) && v.rows.length <= 32 && v.rows.every((row) => tuneRow(row, v.scope === "simple"));
  }
  const keys = Object.keys(v);
  if (editsOnly || keys.length !== 1) return false;
  if (keys[0] === "profile") return profileName(v.profile);
  if (keys[0] === "reset") return v.reset === "stock";
  if (keys[0] === "restore") return v.restore === "accepted";
  return false;
}
const powerValues = (p) => isObj_(p) && keysWithin(p, ["pl1_w", "pl2_w", "tau_s"]) && Object.values(p).every((x) => x === null || typeof x === "number") && Object.values(p).some((x) => typeof x === "number");
function powerPlanOk(a) {
  const keys = Object.keys(a);
  if (keys.length !== 1) return false;
  const v = a[keys[0]];
  return keys[0] === "revert" ? v === true : keys[0] === "profile" ? profileName(v) : keys[0] === "restore" ? v === "accepted" : keys[0] === "power" ? powerValues(v) : false;
}
function runtimePlanOk(a) {
  if (!keysWithin(a, ["caps", "uncore", "revert", "profile", "restore"])) return false;
  const n = Object.keys(a).length;
  if (has_(a, "revert")) return n === 1 && a.revert === true;
  if (has_(a, "profile")) return n === 1 && profileName(a.profile);
  if (has_(a, "restore")) return n === 1 && a.restore === "accepted";
  let caps = false;
  if (has_(a, "caps") && a.caps !== null) {
    const c = a.caps;
    if (!isObj_(c) || !Object.keys(c).length || Object.keys(c).length > 1024 || !Object.entries(c).every(([k, r]) => allChars(k, 1, 4, DIGIT) && Number(k) < 1024 && intIn(r, 1, 255))) return false;
    caps = true;
  }
  let uncore = false;
  if (has_(a, "uncore") && a.uncore !== null) {
    const u = a.uncore;
    if (!isObj_(u) || !keysWithin(u, ["min_ratio", "max_ratio"]) || !Object.values(u).every((r) => r === null || intIn(r, 1, 255))) return false;
    uncore = Object.values(u).some((r) => r !== null);
  }
  return caps || uncore;
}
/** ops.rs apply_intent_ok: an apply's intent in the shape of its plan op's request. */
export function applyIntentOk(kind, intent) {
  if (kind === "tune") return tuneIntentOk(intent, false);
  if (!isObj_(intent)) return false;
  return kind === "power" ? powerPlanOk(intent) : kind === "runtime" ? runtimePlanOk(intent) : false;
}
const applyArgsOk = (a) => keysExactly(a, ["plan_id", "typed"]) && hex64(a.plan_id) && typedOk(a.typed);
function preflightOk(a) {
  if (!Object.keys(a).length) return true;
  if (!keysExactly(a, ["client"]) || !isObj_(a.client)) return false;
  const c = a.client;
  const text = (v) => typeof v === "string" && [...v].length >= 1 && [...v].length <= 64 && !/\p{Cc}/u.test(v);
  return keysWithin(c, ["name", "version", "protocol"]) && [c.name, c.version].every((v) => v == null || text(v)) && (c.protocol == null || (isU64(c.protocol) && c.protocol <= 1_000_000));
}
function profilesSaveOk(a) {
  if (!keysWithin(a, ["name", "intent", "from", "power", "runtime"]) || !profileName(a.name)) return false;
  if (has_(a, "from")) return keysExactly(a, ["name", "from"]) && a.from === "read";
  if (Object.keys(a).length < 2) return false;
  return (!has_(a, "intent") || tuneIntentOk(a.intent, true)) && (!has_(a, "power") || a.power === null || powerValues(a.power))
    && (!has_(a, "runtime") || a.runtime === null || (isObj_(a.runtime) && keysWithin(a.runtime, ["caps", "uncore"]) && runtimePlanOk(a.runtime)));
}
function profilesAcceptOk(a) {
  if (has_(a, "plan_id") || has_(a, "typed")) return applyArgsOk(a);
  const rest = { ...a };
  const asideOk = !has_(rest, "set_aside_unreadable") || rest.set_aside_unreadable === true;
  delete rest.set_aside_unreadable;
  return asideOk && ((keysExactly(rest, ["name"]) && safeProfileName(rest.name)) || (keysExactly(rest, ["from"]) && rest.from === "read"));
}
const WIRE_CHECKS = {
  preflight: preflightOk,
  "tune.plan": (a) => keysExactly(a, ["intent"]) && tuneIntentOk(a.intent, false),
  "power.plan": powerPlanOk,
  "runtime.plan": runtimePlanOk,
  "profiles.save": profilesSaveOk,
  "profiles.accept": profilesAcceptOk,
};
for (const [op, kind] of Object.entries(APPLY_KIND)) {
  WIRE_CHECKS[op] = (a) => {
    if (!has_(a, "intent")) return applyArgsOk(a);
    const rest = { ...a };
    delete rest.intent;
    return applyArgsOk(rest) && applyIntentOk(kind, a.intent);
  };
}
/** ops.rs check, for the ops above: null when `args` has the op's shape, else the shell's local refusal (`{code, message}`). Other ops: null (not checked here). */
export function checkArgs(op, args) {
  if (!WIRE_CHECKS[op]) return null;
  if (!isObj_(args)) return { code: "BAD_REQUEST", message: "refused locally: args must be a JSON object" };
  return WIRE_CHECKS[op](args) ? null : { code: "BAD_REQUEST", message: CONFIRM_TEXT.shape(op) };
}
/** ops.rs webview_apply_args: `{plan_id[, intent]}` from the page -> {plan_id, intent} | {refusal: {code, message}}. */
export function webviewApplyArgs(kind, args) {
  if (!isObj_(args)) return { refusal: { code: "BAD_REQUEST", message: "refused locally: args must be a JSON object" } };
  if (has_(args, "typed")) return { refusal: { code: "BAD_REQUEST", message: CONFIRM_TEXT.typed } };
  if (!keysWithin(args, ["plan_id", "intent"]) || !hex64(args.plan_id)) return { refusal: { code: "BAD_REQUEST", message: CONFIRM_TEXT.onlyPlanId } };
  if (has_(args, "intent") && !applyIntentOk(kind, args.intent)) return { refusal: { code: "BAD_REQUEST", message: CONFIRM_TEXT.badIntent(kind) } };
  return { plan_id: args.plan_id, intent: has_(args, "intent") ? args.intent : undefined };
}

// ---- the dialog's text (confirm.rs) ----
export const MAX_TUNE_LINES = 12;
export const RAISE_MARK = "↑ ";
const MAX_TARGETS = 8;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** confirm.rs scaled: |x| in 10^-d units rounded half up, and whether x is below zero by at least one unit (the same IEEE operations as the Rust). */
const scaled = (x, d) => {
  const n = Math.floor(Math.abs(x) * 10 ** d + 0.5);
  return [x < 0 && n > 0, n];
};
export function fmtMv(x) {
  const [neg, n] = scaled(x, 1);
  if (n === 0) return "0";
  const sign = neg ? "−" : "+";
  return n % 10 === 0 ? `${sign}${Math.floor(n / 10)}` : `${sign}${Math.floor(n / 10)}.${n % 10}`;
}
export function fmtV(x) {
  const n = scaled(x, 3)[1];
  return `${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, "0")}`;
}
const fmtVOpt = (v) => (v === null ? null : fmtV(v));
const ratioText = (r) => (r === null ? "unset" : `${r}×`);
const targetText = (v) => (v === null ? "unset" : `${fmtV(v)} V`);
const eight = (v) => (Array.isArray(v) && v.length === 8 && v.every((r) => isU64(r) && r <= 255) ? v.slice() : null);
const at = (o, k) => (isObj_(o) && has_(o, k) ? o[k] : undefined);
class Undescribed extends Error {}
/** confirm.rs word: null = not read; else {ratio, offset, target}; throws when the dialog cannot read it. */
function word(e, what) {
  if (e === undefined || e === null) return null;
  if (!isObj_(e)) throw new Undescribed(`${what} is not a V/F word`);
  const bad = () => new Undescribed(`${what} has a value the app cannot read`);
  const int = (k) => {
    const v = at(e, k);
    if (v === undefined || v === null) return null;
    if (!isU64(v)) throw bad();
    return v;
  };
  const real = (k) => {
    const v = at(e, k);
    if (v === undefined || v === null) return null;
    if (finite(v) === null) throw bad();
    return v;
  };
  return { ratio: int("ratio"), offset: real("offset_mv"), target: real("v_target_v") };
}
/** confirm.rs tune_lines: -> {lines, raises}; throws Undescribed(why). `rec` = {plan, request, tables}. */
export function tuneLines(rec) {
  const plan = rec.plan;
  const steps = at(plan, "steps");
  if (!Array.isArray(steps)) throw new Undescribed("the plan lists no steps");
  const writes = at(plan, "writes");
  if (!isU64(writes)) throw new Undescribed("the plan does not say how many writes it sends");
  if (at(plan, "steps_truncated") === true) throw new Undescribed(`the helper cut the plan's step list (${steps.length} of ${writes} writes listed)`);
  const conditional = steps.filter((s) => isObj_(s) && s.conditional === true).length;
  if (steps.length !== writes + conditional) throw new Undescribed(`the plan lists ${Math.max(0, steps.length - conditional)} of its ${writes} writes`);
  const written = [];
  const tables = [];
  for (const s of steps) {
    const kind = at(s, "kind");
    if (typeof kind !== "string") throw new Undescribed("a step names no kind");
    const unit = () => {
      const u = at(s, "unit");
      if (typeof u !== "string") throw new Undescribed(`a ${kind} step names no unit`);
      return u;
    };
    let w;
    if (kind === "write_percore_enable") continue;
    else if (kind === "write_vf" || kind === "write_favored" || kind === "write_granular") w = [unit(), 0];
    else if (kind === "write_vf_point" || kind === "write_ring_point") {
      const p = at(s, "point");
      if (!isU64(p) || p < 1) throw new Undescribed(`a ${kind} step names no point`);
      w = [unit(), p];
    } else if (kind === "write_msr") {
      const t0 = at(s, "table");
      const t = typeof t0 === "string" ? t0.toUpperCase() : null;
      if (t !== "P" && t !== "E") throw new Undescribed("a table write names no table");
      const after = eight(at(s, "after")) || eight(at(at(at(rec.request, "intent"), "turbo"), t));
      if (!after) throw new Undescribed(`the new ratios of turbo table ${t} are not in the plan`);
      const before = eight(at(s, "before")) || eight(at(rec.tables, t.toLowerCase()));
      if (!tables.some((x) => x[0] === t)) tables.push([t, before, after]);
      continue;
    } else throw new Undescribed(`a step of kind ${kind}`);
    if (!written.some((x) => x[0] === w[0] && x[1] === w[1])) written.push(w);
  }
  const units = (Array.isArray(at(plan, "units")) ? plan.units : []).filter((u) => typeof u === "string");
  const rank = (u) => (units.includes(u) ? units.indexOf(u) : Infinity);
  written.sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1] - b[1]);
  const raised = [];
  const plain = [];
  const put = (raise, line) => (raise ? raised.push(RAISE_MARK + line) : plain.push(line));
  for (const [unit, point] of written) {
    const what = point === 0 ? `${unit} OC word` : `${unit} point ${point}`;
    const entry = (side) => at(at(at(plan, side), unit), String(point));
    const a = word(entry("after"), what);
    if (!a) throw new Undescribed(`${what} is written but the plan gives no value for it`);
    const b = word(entry("before"), what);
    const was = (f) => (b ? f(b) : "not read");
    if (point > 0) {
      if (a.offset === null) throw new Undescribed(`${what} is written but the plan gives no offset for it`);
      const off = a.offset;
      const r = a.ratio ?? (b ? b.ratio : null);
      const ratio = r === null ? "" : ` · ${r}×`;
      put(scaled(off, 1)[1] > 0 && off > 0, `${unit} · point ${point}${ratio} · offset ${was((x) => fmtMv(x.offset ?? 0))} → ${fmtMv(off)} mV`);
      continue;
    }
    const off = a.offset ?? 0;
    const curveChanged = !b || fmtMv(b.offset ?? 0) !== fmtMv(off);
    if (curveChanged) put(scaled(off, 1)[1] > 0 && off > 0, `${unit} · whole curve · offset ${was((x) => fmtMv(x.offset ?? 0))} → ${fmtMv(off)} mV`);
    const ratioChanged = !b || b.ratio !== a.ratio;
    const targetChanged = !b || fmtVOpt(b.target) !== fmtVOpt(a.target);
    if (ratioChanged || targetChanged) {
      const parts = [`${unit} · OC point`];
      if (ratioChanged) parts.push(`ratio ${was((x) => ratioText(x.ratio))} → ${ratioText(a.ratio)}`);
      else if (a.ratio !== null) parts.push(`${a.ratio}×`);
      if (targetChanged) parts.push(`target ${was((x) => targetText(x.target))} → ${targetText(a.target)}`);
      else if (a.target !== null) parts.push(`target ${targetText(a.target)}`);
      const bt = b ? b.target : null;
      const up = a.target === null ? false : bt === null ? true : scaled(a.target, 3)[1] > scaled(bt, 3)[1];
      put(up && targetChanged, parts.join(" · "));
    } else if (!curveChanged) put(false, `${unit} · OC word · rewritten as it is (offset ${fmtMv(off)} mV)`);
  }
  for (const [t, before, after] of tables) plain.push(`turbo table ${t} · ${before ? before.join(" ") : "not read"} → ${after.join(" ")}`);
  return { lines: [...raised, ...plain], raises: raised.length };
}
function capped(v) {
  if (v.length <= MAX_TARGETS) return v;
  return [...v.slice(0, MAX_TARGETS - 1), `and ${v.length - (MAX_TARGETS - 1)} more`];
}
function ranges(cpus) {
  const c = [...new Set(cpus)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < c.length; ) {
    let j = i;
    while (j + 1 < c.length && c[j + 1] === c[j] + 1) j++;
    out.push(j >= i + 2 ? `${c[i]}–${c[j]}` : j === i + 1 ? `${c[i]}, ${c[j]}` : String(c[i]));
    i = j + 1;
  }
  return out.join(", ");
}
function checkCount(plan, steps) {
  const writes = at(plan, "writes");
  if (!isU64(writes)) throw new Undescribed("the plan does not say how many writes it sends");
  const conditional = steps.filter((s) => isObj_(s) && s.conditional === true).length;
  if (writes + conditional !== steps.length) throw new Undescribed(`the plan lists ${Math.max(0, steps.length - conditional)} of its ${writes} writes`);
  return { writes, conditional };
}
const LABEL = { tune: "V/F and ratio words", power: "Power limits", runtime: "Ratio caps and uncore" };
/** confirm.rs item_of: `rec` = {kind, plan, request, tables} -> {item: {kind, label, writes, targets, raises}} | {error}. */
export function itemOf(rec) {
  try {
    const steps = at(rec.plan, "steps");
    if (!Array.isArray(steps)) throw new Undescribed("the plan lists no steps");
    if (steps.some((s) => !isObj_(s))) throw new Undescribed("a step is not an object");
    let targets;
    let raises = 0;
    if (rec.kind === "tune") {
      const t = tuneLines(rec);
      targets = t.lines;
      raises = t.raises;
    } else if (rec.kind === "power") {
      targets = steps.map((s) => {
        const v = finite(s.value);
        const round2 = (uw) => Math.round((uw / 1e6) * 100) / 100;
        const secs = (us) => Math.round(us / 1e5) / 10;
        const b = finite(s.before);
        if (s.key === "pl1_w" && v !== null) return `PL1 ${b === null ? "not read" : round2(b)} → ${round2(v)} W`;
        if (s.key === "pl2_w" && v !== null) return `PL2 ${b === null ? "not read" : round2(b)} → ${round2(v)} W`;
        if (s.key === "tau_s" && v !== null) return `time window ${b === null ? "not read" : secs(b)} → ${secs(v)} s`;
        throw new Undescribed(`a power step (${typeof s.key === "string" ? s.key : "no key"}) the app cannot describe`);
      });
      targets = capped(targets);
    } else {
      const byRatio = [];
      const t = [];
      for (const s of steps) {
        const key = s.key;
        if (typeof key !== "string") throw new Undescribed("a caps / uncore step names no key");
        const after = isU64(s.ratio) ? `${s.ratio}×` : finite(s.value) !== null ? `${Math.round(s.value / 1e5)}×` : null;
        if (after === null) throw new Undescribed(`the ${key} step gives no value`);
        const ratio = `${finite(s.before) === null ? "not read" : `${Math.round(s.before / 1e5)}×`} → ${after}`;
        if (s.domain === "caps") {
          const m = /^cpu(\d+)$/.exec(key);
          const cpu = m ? Number(m[1]) : null;
          const g = byRatio.find((x) => x[0] === ratio);
          if (cpu === null) t.push(`${key} max ${ratio}`);
          else if (g) g[1].push(cpu);
          else byRatio.push([ratio, [cpu]]);
        } else if (s.domain === "uncore") t.push(`uncore ${key.replace(/(_ratio)+$/, "")} ${ratio}`);
        else throw new Undescribed(`the ${key} step names no domain the app knows`);
      }
      targets = capped([...byRatio.map(([r, cpus]) => `cpu ${ranges(cpus)} max ${r}`), ...t]);
    }
    const { writes, conditional } = checkCount(rec.plan, steps);
    return { item: { kind: rec.kind, label: LABEL[rec.kind], writes, targets, raises, conditional } };
  } catch (e) {
    if (e instanceof Undescribed) return { error: e.message };
    throw e;
  }
}
/** confirm.rs ConfirmRequest::text for plan items: {title, primary, secondary, ok_label}. */
export function dialogText(items) {
  const writes = items.reduce((n, i) => n + i.writes, 0);
  const lines = [];
  for (const i of items) {
    if (i.kind !== "tune") {
      lines.push(`• ${i.label} — ${plural(i.writes, "write")}${i.targets.length ? ": " + i.targets.join(", ") : ""}`);
      continue;
    }
    lines.push(`• ${i.label} — ${plural(i.writes, "write")}${i.conditional > 0 ? ` (+${i.conditional} if per-core voltage control is off)` : ""}:`);
    if (i.raises > 0) lines.push(`   ${RAISE_MARK}raises a voltage: ${plural(i.raises, "line")} listed first`);
    const cut = i.targets.length > MAX_TUNE_LINES;
    const shown = cut ? MAX_TUNE_LINES - 1 : i.targets.length;
    for (const t of i.targets.slice(0, shown)) lines.push(`   ${t}`);
    if (cut) {
      const hidden = Math.max(0, i.raises - shown);
      lines.push(`   … and ${i.targets.length - shown} more${hidden > 0 ? ` (${hidden} of them raise a voltage)` : ""}, all listed in the review`);
    }
  }
  lines.push("", "Each write is sent alone and read back. V/F and ratio words last until a cold boot; power limits, caps and uncore until a reboot.");
  return { title: "Linux XTU: confirm", primary: `Apply ${plural(writes, "write")} to the CPU?`, secondary: lines.join("\n"), ok_label: `Apply ${plural(writes, "write")}` };
}

// ---- the version handshake (version.rs) ----
/** This app as the shell declares it (lib.rs APP_NAME / VERSION, version.rs PROTOCOL, the hash of ops.rs ALLOWED_OPS); contract.test.mjs checks each against the samples. */
export const APP = { name: "linux-xtu-desktop", version: "0.2.0-dev", protocol: 1, ops_hash: "e09a47177e019c38639a922ec19b9fe4d0ec93d71be6bb57e243d2a18469350e", ops: 32 };
export const CLIENT = { name: APP.name, version: APP.version, protocol: APP.protocol };
export const REINSTALL = "sudo bash install.sh";
const vtext = (v) => (typeof v === "string" && v ? [...v].filter((c) => !/\p{Cc}/u.test(c)).slice(0, 64).join("") : null);
/** version.rs VersionCheck::of + to_value (`check.value`) + message / ops note; `decorate(public)` = the preflight as the webview gets it. */
export function versionCheck(resp) {
  const r = isObj_(resp) ? resp : {};
  const body = r.ok === true ? r.result : isObj_(r.error) ? r.error.detail : undefined;
  const helper = isObj_(at(body, "helper")) ? body.helper : null;
  const f = (k) => (helper ? at(helper, k) : undefined);
  const hVersion = vtext(f("version"));
  const hProtocol = isU64(f("protocol")) ? f("protocol") : null;
  const hHash = hex64(f("ops_hash")) ? f("ops_hash") : null;
  const hOps = isU64(f("ops")) ? f("ops") : null;
  const cOk = typeof at(at(body, "client"), "protocol_ok") === "boolean" ? body.client.protocol_ok : null;
  const protocolOk = hProtocol === APP.protocol && cOk !== false;
  const opsOk = hHash === null ? null : hHash === APP.ops_hash;
  const who = hVersion ? `the helper (${hVersion})` : "the helper";
  let message = null;
  if (!protocolOk) {
    const app = `this app (${APP.name} ${APP.version})`;
    const why = hProtocol === null ? `${who} reports no protocol (it is older than ${app}, which speaks protocol ${APP.protocol})`
      : hProtocol !== APP.protocol ? `${who} speaks protocol ${hProtocol}, ${app} protocol ${APP.protocol}` : `${who} refused ${app}'s protocol for this connection`;
    message = `Helper and app versions differ: ${why}. Writes are off. Install both from the same release: ${REINSTALL}`;
  }
  const note = opsOk === false
    ? `${who} serves a different set of operations (${hOps === null ? "an unknown number of" : hOps}) than this app was built against (${APP.ops}): the app sends only its own; one the helper lacks is refused by it. Install both from the same release.`
    : null;
  const value = {
    app: { ...APP },
    helper: hVersion === null && hProtocol === null && hHash === null ? null : { version: hVersion, protocol: hProtocol, ops_hash: hHash, ops: hOps },
    protocol_ok: protocolOk, ops_hash_ok: opsOk, message, fix: protocolOk ? null : REINSTALL,
  };
  const decorate = (pub) => {
    const out = clone(pub);
    if (!isObj_(out.result)) return out;
    if (!Array.isArray(out.result.checks) && (message || note)) out.result.checks = [];
    if (message) {
      out.result.writes_allowed = false;
      out.result.checks.unshift({ name: "app_version", status: "fail", reason: message });
    }
    if (note) out.result.checks.push({ name: "app_ops", status: "warn", reason: note });
    return out;
  };
  return { value, message, note, protocolOk, decorate };
}
/** ops.rs MUTATING_OPS: refused here, with app.confirm, while the protocols differ. */
export const MUTATING_OPS = ["tune.apply", "power.apply", "runtime.apply", "vf.measure", "stress.start", "profiles.save", "profiles.accept", "profiles.fingerprint", "curves.update", "curves.delete"];

// ---- the helper's apply-time intent check (ops_tune.py intent_changed, R-B1 / R-26), for every kind: the recorded mocks below know nothing of it ----
const canon = (x) => (Array.isArray(x) ? x.map(canon) : isObj_(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const sameIntent = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/**
 * Between the composed mock and the shell layer: remembers the intent each `*.plan` was made from (tune: its `intent`; power / runtime: the whole request) and refuses an
 * `*.apply` whose `intent` differs — `PLAN_STALE` / `INTENT_CHANGED`, `writes_sent: 0`, the plan spent — as the helper does; the apply's final answer comes as its
 * `result` event like any long op. The `intent` is not passed on to the inner mocks (they never read it).
 */
function helperIntentLayer(inner) {
  const planned = new Map(); // plan_id -> the intent it was made from
  const subs = new Map();
  let seq = 0;
  const emit = (event, payload) => {
    for (const cb of [...(subs.get(event) || [])]) cb(payload);
  };
  return {
    ...inner,
    connect: (...a) => inner.connect(...a),
    status: (...a) => inner.status(...a),
    async call(op, args = {}) {
      const kind = APPLY_KIND[op];
      if (kind && isObj_(args) && has_(args, "intent")) {
        const { intent, ...rest } = args;
        const was = planned.get(rest.plan_id);
        if (was !== undefined && !sameIntent(was, intent)) {
          planned.delete(rest.plan_id);
          const id = `mi${++seq}`;
          setTimeout(() => emit("result", fail(id, "PLAN_STALE", `the edits changed since the plan was made (intent: planned ${JSON.stringify(was)}, now ${JSON.stringify(intent)}); nothing was written. Review again.`,
            { check: "INTENT_CHANGED", writes_sent: 0 })), 0);
          return { id };
        }
        return inner.call(op, rest);
      }
      const res = await inner.call(op, args);
      if (PLAN_KIND[op] && res && res.ok === true && res.result && typeof res.result.plan_id === "string") planned.set(res.result.plan_id, op === "tune.plan" ? args.intent : args);
      return res;
    },
    listen(event, cb) {
      let set = subs.get(event);
      if (!set) subs.set(event, (set = new Set()));
      set.add(cb);
      const off = inner.listen(event, cb);
      return () => {
        set.delete(cb);
        if (typeof off === "function") off();
      };
    },
    close: (...a) => inner.close(...a),
    dropLink: inner.dropLink ? (...a) => inner.dropLink(...a) : undefined,
  };
}

/**
 * Wrap the composed mock so it answers exactly as the shell does (contract.test.mjs compares it with the Rust-generated samples):
 *  - connect()/status(): the shell's Status `{connected, path, dev_socket, pending_long, latest, preflight, version, last_error}`;
 *  - call(): NOT_CONNECTED with `detail.kind` while down (a call never reconnects), `{id, ok:true, pending:true}` for a long op, else the public response;
 *  - events: `result` filtered like public_response; a heartbeat names the long op in flight (the helper's does); nothing from a dropped connection;
 *  - dropLink(reason, {next}): the helper goes away — each long op in flight gets its LINK_LOST `result`, then `closed {reason}` (link.rs fail_all);
 *  - R-S3 confirmation: a plan's `nonce` is kept here and stripped from the answer; `app.confirm {plans}` plays the native dialog (`confirm`:
 *    "yes" after `confirmMs`, "no", "unavailable", or "hold" = never answers; `?confirm=`); an apply from the page is `{plan_id[, intent]}` and is
 *    sent, with `typed` added, only for an approved plan. A persistent op (profiles.accept, profiles.fingerprint) plays its own dialog and a
 *    two-step accept is completed here. One dialog at a time, none for 2 s after a "no". The plans are per connection (like link.rs).
 *  - R-I1: the arguments of the R-I1 ops are checked like ops.rs (checkArgs); the dialog is built from the kept plan, the request it was made from and the
 *    turbo tables the helper's answers reported (itemOf / dialogText: a value it cannot name fails closed, CONFIRM_UNAVAILABLE) and its text is in the confirmed
 *    answer (`dialog`); every preflight goes out with this app's `client` block and comes back compared (versionCheck): another protocol turns writes off and
 *    refuses app.confirm and the mutating ops (VERSION_MISMATCH).
 */
function shellLayer(base, inner, { confirm = searchParam("confirm") || "yes", confirmMs = 200, helper = "ok" } = {}) {
  const subs = new Map(); // event -> Set(cb)
  const hooked = new Map(); // event -> unlisten of the inner layers
  const pending = new Set(); // long ops started on this connection, oldest first
  const pendingOp = new Map(); // id -> op of each long op in flight
  const dead = new Set(); // ids of a connection that ended: nothing of theirs is delivered any more
  let latest = {};
  let preflightReply = null;
  let version = null; // versionCheck() of the last preflight answer of this (or the last) connection
  let tables = {}; // "e" / "p" -> 8 ratios the helper's answers reported (link.rs State.tables)
  let plans = { tune: [], power: [], runtime: [] }; // kind -> [{plan_id, nonce, approvedAt, plan, request, tables}], oldest first (link.rs State.plans)
  const gate = { open: false, lastNo: null }; // confirm.rs ConfirmGate
  const dialogs = []; // what each dialog asked (tests): {items: [{kind, plan_id}], writes, text} | {op, args, writes}

  function remember(kind, res, request) {
    if (!res || res.ok !== true || !res.result || typeof res.result.plan_id !== "string") return;
    const nonce = typeof res.result.nonce === "string" && NONCE_OK.test(res.result.nonce) ? res.result.nonce : null;
    const set = plans[kind].filter((p) => p.plan_id !== res.result.plan_id);
    const plan = { ...res.result };
    delete plan.nonce;
    set.push({ plan_id: res.result.plan_id, nonce, approvedAt: null, plan, request: clone(request), tables: clone(tables) });
    plans[kind] = set.slice(-MAX_PLANS);
  }
  const record = (kind, id) => plans[kind].find((p) => p.plan_id === id) || null;
  /** link.rs State::take_tables: the tables of a tune.read result (or of the read in tune.last). */
  function takeTables(read) {
    if (!isObj_(read) || !has_(read, "tables")) return;
    for (const k of ["e", "p"]) {
      const t = at(read.tables, k);
      if (Array.isArray(t) && t.length === 8 && t.every((r) => isU64(r) && r <= 255)) tables[k] = t.slice();
      else delete tables[k];
    }
  }
  /** link.rs State::fold_apply: a table write read back equal is the table in force; a refusal that wrote nothing changes nothing; anything else forgets both. */
  function foldApply(resp) {
    const wroteNothing = resp.ok !== true && at(at(resp.error, "detail"), "writes_sent") === 0;
    if (wroteNothing) return;
    const result = resp.ok === true ? resp.result : null;
    if (at(result, "complete") !== true) {
      tables = {};
      return;
    }
    for (const row of (Array.isArray(result.readback) ? result.readback : []).filter((r) => r && r.point === "turbo")) {
      const key = typeof row.unit === "string" ? row.unit.toLowerCase() : null;
      if (key !== "e" && key !== "p") continue;
      const hex = typeof row.actual === "string" && /^0x[0-9a-fA-F]+$/.test(row.actual) ? BigInt(row.actual) : null;
      if (hex === null || row.match !== true || hex >= 1n << 64n) delete tables[key];
      else tables[key] = Array.from({ length: 8 }, (_, k) => Number((hex >> BigInt(8 * k)) & 0xffn));
    }
  }

  /** The native dialog behind its gate (GatedConfirmer): "yes" | "no" | {busy} | {unavailable}. `confirm` = "hold" never answers. */
  async function ask(what) {
    const now = Date.now();
    if (gate.open) return { busy: CONFIRM_TEXT.open };
    if (gate.lastNo !== null && now - gate.lastNo < COOLDOWN_MS) return { busy: CONFIRM_TEXT.pause };
    gate.open = true;
    dialogs.push(what);
    let answer;
    try {
      if (confirm === "hold") await new Promise(() => {});
      await new Promise((r) => setTimeout(r, confirmMs));
      answer = confirm === "no" ? "no" : confirm === "unavailable" ? { unavailable: "no window" } : "yes";
    } finally {
      gate.open = false;
    }
    if (answer === "no") gate.lastNo = Date.now();
    return answer;
  }
  const notYes = (answer) =>
    answer === "no" ? nothingWritten("NOT_CONFIRMED", CONFIRM_TEXT.declined)
      : answer.unavailable ? nothingWritten("CONFIRM_UNAVAILABLE", CONFIRM_TEXT.unavailable(answer.unavailable))
      : nothingWritten("BUSY", CONFIRM_TEXT.busy(answer.busy));

  async function confirmPlans(args) {
    const list = args && Array.isArray(args.plans) && Object.keys(args).length === 1 ? args.plans : null;
    const ok = list && list.length >= 1 && list.length <= MAX_CONFIRM_PLANS && list.every((p) => p && typeof p === "object" && Object.keys(p).length === 2 && HEX64.test(p.plan_id) && APPLY_KIND[p.op])
      && new Set(list.map((p) => p.plan_id)).size === list.length;
    if (!ok) return nothingWritten("BAD_REQUEST", CONFIRM_TEXT.badConfirm);
    const items = list.map((p) => ({ kind: APPLY_KIND[p.op], plan_id: p.plan_id }));
    const described = [];
    for (const it of items) {
      const rec = record(it.kind, it.plan_id);
      if (!rec) return nothingWritten("PLAN_STALE", CONFIRM_TEXT.gone);
      if (!rec.nonce) return nothingWritten("BAD_REQUEST", CONFIRM_TEXT.noNonce);
      const d = itemOf({ kind: it.kind, plan: rec.plan, request: rec.request, tables: rec.tables });
      if (d.error) return notYes({ unavailable: CONFIRM_TEXT.undescribed(d.error) }); // fail closed: no dialog, nothing approved
      described.push(d.item);
    }
    const text = dialogText(described);
    const writes = described.reduce((n, d) => n + d.writes, 0);
    const answer = await ask({ items, writes, text });
    if (answer !== "yes") return notYes(answer);
    if (!items.every((it) => record(it.kind, it.plan_id))) return nothingWritten("PLAN_STALE", CONFIRM_TEXT.gone);
    const now = Date.now();
    for (const it of items) record(it.kind, it.plan_id).approvedAt = now;
    return { ok: true, result: { confirmed: true, plans: items.length, writes, dialog: text } };
  }

  /** confirm.rs persist_confirmed + link.rs persist: its own dialog, then step 1; a two-step accept is completed here (fail closed without a code). */
  async function persist(op, args) {
    const refusal = persistRefusal(op, args);
    if (refusal) return refusal;
    const answer = await ask({ op, args: { ...args }, writes: 0 });
    if (answer !== "yes") return notYes(answer);
    const first = await inner.call(op, args);
    const r = first && first.ok === true ? first.result : null;
    if (op !== "profiles.accept" || !r || r.confirm_required !== true) return publicResponse(first);
    if (typeof r.plan_id !== "string" || !HEX64.test(r.plan_id) || typeof r.nonce !== "string" || !NONCE_OK.test(r.nonce)) return nothingWritten("BAD_REQUEST", CONFIRM_TEXT.noCode);
    return publicResponse(await inner.call(op, { plan_id: r.plan_id, typed: `CONFIRM ${r.nonce}` }));
  }

  /** confirm.rs apply_confirmed: `{plan_id[, intent]}` (ops.rs webview_apply_args), an approved plan of this connection; the kept code is added; spent before the send. */
  function confirmedArgs(kind, args) {
    const w = webviewApplyArgs(kind, args);
    if (w.refusal) return { refusal: nothingWritten(w.refusal.code, w.refusal.message) };
    const rec = record(kind, w.plan_id);
    if (!rec) return { refusal: nothingWritten("PLAN_STALE", CONFIRM_TEXT.gone) };
    if (!rec.nonce) return { refusal: nothingWritten("BAD_REQUEST", CONFIRM_TEXT.noNonce) };
    if (!rec.approvedAt || Date.now() - rec.approvedAt > APPROVAL_TTL_MS) return { refusal: nothingWritten("NOT_CONFIRMED", CONFIRM_TEXT.notConfirmed) };
    plans[kind] = plans[kind].filter((p) => p !== rec);
    return { args: { plan_id: rec.plan_id, typed: `CONFIRM ${rec.nonce}`, ...(w.intent !== undefined ? { intent: w.intent } : {}) } };
  }

  /** mod.rs version_fence: a write or mutating op while the protocols differ. */
  const fence = (op) =>
    (op === "app.confirm" || MUTATING_OPS.includes(op)) && version && version.message
      ? { ok: false, error: { code: "VERSION_MISMATCH", message: `refused locally: ${version.message}`, detail: { check: "VERSION_MISMATCH", writes_sent: 0 } } }
      : null;
  /** mod.rs take_preflight: compare, keep, answer decorated. */
  function takePreflight(raw) {
    version = versionCheck(raw);
    return version.decorate(publicResponse(raw));
  }

  const emit = (event, payload) => {
    for (const cb of [...(subs.get(event) || [])]) cb(payload);
  };
  function deliver(event, payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    if (event === "result") {
      if (dead.has(p.id)) return;
      pending.delete(p.id);
      const op = pendingOp.get(p.id);
      pendingOp.delete(p.id);
      if (op === "tune.read" && p.ok === true) takeTables(p.result);
      if (op === "tune.apply") foldApply(p);
      return emit("result", publicResponse(p));
    }
    if (p.op_id != null && dead.has(p.op_id)) return;
    let out = payload;
    if (event === "heartbeat") {
      const running = [...pending].pop();
      if (p.op_id == null && running !== undefined) out = { ...p, op_id: running };
      latest.heartbeat = { event, ...out };
    } else if (event === "state") latest.state = { event, ...p };
    emit(event, out);
  }
  const hook = (event) => {
    if (!hooked.has(event)) hooked.set(event, inner.listen(event, (p) => deliver(event, p)));
  };
  for (const ev of ["result", "state", "heartbeat"]) hook(ev); // the shell tracks these with or without a webview listener

  async function status() {
    const l = await base.status();
    const up = l.state === "connected";
    return {
      connected: up,
      path: HELPER_SOCKET,
      dev_socket: false,
      pending_long: up ? pending.size : 0,
      latest: up ? clone(latest) : {},
      preflight: preflightReply ? clone(preflightReply) : null,
      version: version ? clone(version.value) : null,
      last_error: up ? null : { ...(l.error || NOT_CONNECTED) },
    };
  }

  return {
    async connect() {
      const before = (await base.status()).state;
      const l = await inner.connect();
      if (l.state === "connected" && before !== "connected") {
        latest = {};
        tables = {};
        plans = { tune: [], power: [], runtime: [] }; // a new connection holds no plans (link.rs: per Link)
        preflightReply = takePreflight({ id: "m0", ok: true, result: currentPreflight(helper, CLIENT) }); // the handshake's answer, compared (Rust keeps both in the status)
      }
      return status();
    },
    status,
    async call(op, args = {}) {
      const l = await base.status();
      if (l.state !== "connected") {
        const e = l.error || NOT_CONNECTED;
        return { ok: false, error: { code: "NOT_CONNECTED", message: e.message, detail: { kind: e.kind } } };
      }
      const fenced = fence(op);
      if (op === "app.confirm") return fenced || confirmPlans(args);
      if (PERSIST_OPS.includes(op) || APPLY_KIND[op]) {
        if (fenced) return fenced;
      }
      if (PERSIST_OPS.includes(op)) return persist(op, args);
      const kind = APPLY_KIND[op] || null;
      let sent = args;
      if (kind) {
        const c = confirmedArgs(kind, args);
        if (c.refusal) return c.refusal;
        sent = c.args;
      } else {
        const refused = checkArgs(op, args);
        if (refused) return { ok: false, error: refused };
        if (op === "preflight" && Object.keys(args).length) return { ok: false, error: { code: "BAD_REQUEST", message: CONFIRM_TEXT.page_preflight } };
        if (fenced) return fenced;
        if (op === "preflight") sent = { client: { ...CLIENT } };
      }
      const res = await inner.call(op, sent);
      if (res && typeof res === "object" && res.ok === undefined && typeof res.id === "string") {
        pending.add(res.id);
        pendingOp.set(res.id, op);
        return { id: res.id, ok: true, pending: true };
      }
      if (PLAN_KIND[op]) remember(PLAN_KIND[op], res, sent);
      if (op === "tune.last" && res && res.ok === true && at(res.result, "available") === true) takeTables(at(res.result, "result"));
      if (op === "preflight") return takePreflight(res);
      return publicResponse(res);
    },
    /** The shell's `app_version` (lib.rs VERSION) as the bridge's Tauri transport wraps it. The mock has no settings commands: the page keeps its preferences in
     *  localStorage then (store.js), and System says they are not saved. */
    appVersion: async () => ({ ok: true, result: APP.version }),
    /** Test seam: what each app.confirm asked ({items: [{kind, plan_id}], writes, text}). */
    dialogs: () => dialogs.slice(),
    /** Test seam: the turbo tables the shell knows. */
    tables: () => clone(tables),
    listen(event, cb) {
      hook(event);
      let set = subs.get(event);
      if (!set) subs.set(event, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    dropLink(reason = "eof", opts = {}) {
      base.dropLink(reason, opts);
      for (const id of [...pending]) {
        dead.add(id);
        emit("result", { id, ok: false, error: { code: "LINK_LOST", message: LINK_LOST_RESULT } });
      }
      pending.clear();
      pendingOp.clear();
      latest = {};
      tables = {};
      plans = { tune: [], power: [], runtime: [] };
      emit("closed", { reason });
    },
    close() {
      for (const off of hooked.values()) if (typeof off === "function") off();
      hooked.clear();
      subs.clear();
      return inner.close();
    },
  };
}

export function createMockTransport(opts = {}) {
  // the recorded simulator curves seed the library (incl. a baseline for Tune predictions) unless ?nobaseline asks for none
  const seed = opts.seed ?? (noBaselineParam() ? "none" : "recorded");
  const base = createBaseMockTransport(opts);
  const stepMs = opts.stepMs ?? stepParam() ?? 12;
  const inner = helperIntentLayer(wrapMockTransportG217(wrapMockTransport(base, { ...opts, seed }), opts));
  return shellLayer(base, inner, {
    confirm: opts.confirm ?? (searchParam("confirm") || "yes"), confirmMs: opts.confirmMs ?? Math.min(400, Math.max(1, stepMs * 15)), helper: opts.helper ?? (searchParam("helper") || "ok"),
  });
}
