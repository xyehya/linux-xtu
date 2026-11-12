// views/system.js: System screen (PLAN §4.4, desktop/DESIGN.md §9.10): preflight (result glyphs, Re-run), the limits read from this CPU with their sources, helper & link
// (the app version when the bridge exposes it; G-252: the link state, mailbox count and last read are in the top bar and not repeated), settings (refresh interval and
// notifications through the Rust settings commands; the Hints On / Quiet switch is the footer's, not repeated), a link to Profiles for boot restore (hidden without the optional
// preflight `boot_restore`; the state and the enable command live in Profiles only), and the topology ("Max ratio (cpufreq)", U-39).
// Port of web/app.js: renderPreflight (:375-420, CHECK_ORDER :353), renderHelper (:476-494).
// The limits are never fixed in the page: they are the CPU's own (D-049), from the helper's kept tune read (`tune.last`: `cpu_limits`; no mailbox traffic) plus the Power /
// Ratio caps / Ring & uncore reads when those ran. Without a read there is no table, only the reason; a limit not read yet says "Read CPU state first".
// Settings (F-07): bridge.settingsGet / settingsSet (Rust settings.rs: refresh_s, notifications, hints, …) kept in store.settings (app.js loads them at boot) and
// telemetry.start for the interval in force. app.js saves each pref change through settings_set.
import { h, clear } from "../components/dom.js";
import { NA } from "../components/fmt.js";
import { setPreflight, setSettings, PREFS, DEFAULT_REFRESH_S } from "../store.js";
import { normCpuLimits, capWindow, uncoreWindow, READ_FIRST } from "../lib/cpulimits.js";
import { button, setBusy, setButton } from "../components/buttons.js";
import { panel, kv, box } from "../components/panel.js";
import { createSegmented } from "../components/segmented.js";
import { HINTS } from "../lib/hints.js";
import { wordmark, NOT_AFFILIATED } from "../components/topbar.js";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export const MINUS = "−";
export const INTERVALS = [0.25, 0.5, 1, 2, 5];
export const DEFAULT_INTERVAL_S = DEFAULT_REFRESH_S;

/** Worst first (web CHECK_ORDER). */
export const CHECK_ORDER = { refuse: 0, fail: 0, "read-only": 1, unknown: 2, warn: 3, missing: 4, pass: 5 };

export function sortChecks(checks) {
  const rank = (c) => (c && CHECK_ORDER[c.status] !== undefined ? CHECK_ORDER[c.status] : 6);
  return (Array.isArray(checks) ? checks : []).map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

/** Chip colour for a preflight status: ok / warn / error (the three semantic accents only). */
export function checkState(status) {
  if (status === "pass") return "ok";
  if (status === "fail" || status === "refuse") return "error";
  return "warn";
}

export function fmtSigned(x) {
  return (x > 0 ? "+" : x < 0 ? MINUS : "") + Math.abs(x);
}

/**
 * The CPU's own limits (D-049, lib/cpulimits.js): `tune.last`'s `cpu_limits` carries P / E / ring and the offset field; the power, cpufreq and uncore parts come from the
 * Power / Ratio caps / Ring & uncore reads (`rt` = {power, runtime}: their `cpu_limits`), merged in when those were read.
 */
export function mergeCpuLimits(base, rt = {}) {
  const cl = normCpuLimits(base);
  const pw = normCpuLimits(rt.power);
  const run = normCpuLimits(rt.runtime);
  if (!cl && !pw && !run) return null;
  const out = cl || { kinds: {}, offsetMv: null, power: null, capsKhz: {}, uncoreKhz: null };
  return {
    ...out,
    power: pw && pw.power && (pw.power.plMaxW !== null || pw.power.locked !== null) ? pw.power : out.power,
    capsKhz: run && Object.keys(run.capsKhz).length ? run.capsKhz : out.capsKhz,
    uncoreKhz: run && run.uncoreKhz ? run.uncoreKhz : out.uncoreKhz,
  };
}

/** Rows of the limits table. Each: {what, kind, cpu, source}; a limit that was not read says "Read CPU state first" in its cell (starts with NA). */
export function limitRows(cl) {
  if (!cl) return [];
  const rows = [];
  const unread = () => `${NA} · ${READ_FIRST}`;
  const mhz = (khz) => Math.round(khz / 1000);
  for (const [k, kind] of [["P", "P-cores"], ["E", "E-clusters"], ["ring", "Ring"]]) {
    const o = cl.kinds[k];
    if (!o) continue;
    rows.push({ what: "CPU max voltage", kind, cpu: isNum(o.maxMv) ? `${(o.maxMv / 1000).toFixed(3)} V` : unread(), source: "OC mailbox 0x28 [11:0] − 1 LSB" });
    rows.push({ what: "OC ratio limit", kind, cpu: isNum(o.maxRatio) ? `${o.maxRatio}×` : unread(), source: "OC mailbox 0x01 [7:0]" });
  }
  rows.push({ what: "V/F offset field", kind: "P, E, ring", cpu: cl.offsetMv ? `${fmtSigned(cl.offsetMv[0])}…${fmtSigned(cl.offsetMv[1])} mV` : `${NA} · not reported`, source: "11-bit offset field" });
  const p = cl.power;
  rows.push({
    what: "Package power limits",
    kind: "Package",
    cpu: !p || (p.locked === null && p.plMaxW === null) ? `${NA} · ${READ_FIRST} (Tune → Power)` : `${p.locked ? "locked by firmware" : "writable"}, field maximum ${isNum(p.plMaxW) ? p.plMaxW + " W" : NA}`,
    source: "MSR 0x610 (lock bit 63, 15-bit fields) in the units of MSR 0x606",
  });
  const cpus = Object.keys(cl.capsKhz);
  const ws = cpus.map((c) => capWindow(cl, c)).filter(Boolean);
  rows.push({
    what: "Ratio cap range",
    kind: "All CPUs",
    cpu: ws.length ? `${mhz(Math.min(...ws.map((w) => w.minKhz).filter(isNum)))}–${mhz(Math.max(...ws.map((w) => w.maxKhz)))} MHz (${cpus.length} CPUs)` : `${NA} · ${READ_FIRST} (Tune → Ratio caps)`,
    source: "cpufreq cpuinfo_min/max_freq",
  });
  const u = uncoreWindow(cl);
  rows.push({ what: "Uncore ratio range", kind: "Ring", cpu: u ? `${u.min}×–${u.max}×` : `${NA} · ${READ_FIRST} (Tune → Ring & uncore)`, source: "intel_uncore_frequency initial_min/max_freq_khz" });
  return rows;
}

/** The note above the limits table. `last` = the tune.last result ({available, result}) or null; `cl` = mergeCpuLimits(). */
export function limitsNote(last, cl) {
  if (!last || last.available !== true) return "Not read yet this boot: read the ratios and voltages in Tune to see the limits.";
  if (!cl) return "The helper did not report the CPU limits (update the helper), so the Tune controls stay disabled.";
  return "These are the limits of your CPU, read from it. They are the only bounds on a value (besides the field encodings); a limit that was not read is shown as \"Read CPU state first\" and a write that needs it is refused until it is.";
}

/** Said under the shell's version reason: the helper itself still answers reads. */
export const VERSION_NOTE = "Reading works; only writes are refused, by this app.";

/** Preflight summary + banner text (why the app is read-only / refused; one paragraph per line). */
export function preflightSummary(pre) {
  if (!isObj(pre) || typeof pre.mode !== "string" || !Array.isArray(pre.checks)) return null;
  const why = (status) => pre.checks.filter((c) => c && c.status === status).map((c) => `${c.name}: ${c.reason}`);
  const writes = typeof pre.writes_allowed === "boolean" ? pre.writes_allowed : null;
  // R-I1: the shell turns writes off when the helper speaks another protocol (failed check `app_version`); the helper itself still reads
  const version = pre.checks.find((c) => c && c.name === "app_version" && c.status === "fail") || null;
  let banner = "";
  if (pre.mode === "read-only") banner = "Read-only mode: mailbox requests are off, so Tune cannot read or apply. " + why("read-only").join(" | ");
  else if (pre.mode === "refuse") banner = "Refused: the app cannot operate on this system. " + why("refuse").join(" | ");
  else if (writes === false && version) banner = `${version.reason || "Helper and app versions differ. Writes are off."}\n${VERSION_NOTE}`;
  else if (writes === false) banner = "The helper does not permit mailbox requests (a check is unknown or failed): reading and applying are off. See the checks below.";
  return { mode: pre.mode, platform: String(pre.platform || NA), board: String(pre.board || NA), writes, banner, version: !!version, counts: countStatuses(pre.checks) };
}

export function countStatuses(checks) {
  const c = {};
  for (const x of Array.isArray(checks) ? checks : []) if (x && x.status) c[x.status] = (c[x.status] || 0) + 1;
  return c;
}

/** Rows of the live topology table from preflight.topology (D-036: never hard-coded). */
export function topologyRows(topology) {
  if (!isObj(topology) || !Array.isArray(topology.units)) return [];
  return topology.units.filter(isObj).map((u) => ({
    id: String(u.id),
    kind: u.kind === "P" ? "P-core" : u.kind === "E" ? "E-cluster" : String(u.kind ?? NA),
    cpus: Array.isArray(u.cpus) ? (u.cpus.length > 1 ? `${u.cpus[0]}–${u.cpus[u.cpus.length - 1]}` : String(u.cpus[0])) : NA,
    maxRatio: isNum(u.max_ratio) ? `${u.max_ratio}×` + (isNum(u.max_khz) && u.max_khz !== u.max_ratio * 100000 ? ` (kernel ${Math.round(u.max_khz / 1000)} MHz)` : "") : NA,
    perf: isNum(u.perf) ? String(u.perf) : NA,
    favored: u.favored === true,
  }));
}

/** Result glyph of a preflight status (§9.10): ✓ ok-text, ✕ fault-text, ? fg3. */
export function checkGlyph(status) {
  const st = checkState(status);
  return st === "ok" ? { glyph: "✓", res: "ok" } : st === "error" ? { glyph: "✕", res: "fault" } : { glyph: "?", res: "" };
}

/** "13 pass · 1 unknown" in the order worst first. */
export function countsText(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => (CHECK_ORDER[a[0]] ?? 6) - (CHECK_ORDER[b[0]] ?? 6))
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");
}

export const BOOT_RESTORE_STATES = { not_installed: "not installed", disarmed: "disarmed", armed: "armed" };
/**
 * The boot-restore line from an OPTIONAL preflight field `boot_restore` (a state string, or {state, note?}); null when the helper sends none (the panel stays hidden).
 * -> {state, label, tag ("" | ok | warn), note}. An unknown state is shown as it came.
 */
export function bootRestoreModel(pre) {
  const b = isObj(pre) ? pre.boot_restore : undefined;
  if (b === undefined || b === null) return null;
  const state = typeof b === "string" ? b : isObj(b) && typeof b.state === "string" ? b.state : null;
  if (!state) return null;
  const note = isObj(b) && typeof b.note === "string" ? b.note : "";
  return { state, label: BOOT_RESTORE_STATES[state] || state.replace(/_/g, " "), tag: state === "armed" ? "ok" : state === "disarmed" ? "warn" : "", note };
}

/**
 * Settings as the Rust side answers them -> store.settings: {saved (bool), refresh_s, notifications (bool | null), hints ("on" | "quiet" | null), why (reason it is not
 * saved, or the backend's warning, or "")}. Without an answer the interval is the default one.
 */
export function settingsModel(res) {
  if (res && res.ok && isObj(res.result)) {
    const r = res.result;
    return {
      saved: true, refresh_s: isNum(r.refresh_s) ? r.refresh_s : DEFAULT_REFRESH_S, notifications: typeof r.notifications === "boolean" ? r.notifications : null,
      hints: PREFS.hints.includes(r.hints) ? r.hints : null, why: typeof res.warning === "string" ? res.warning : "",
    };
  }
  return { saved: false, refresh_s: DEFAULT_REFRESH_S, notifications: null, hints: null, why: res && res.error && res.error.message ? res.error.message : "no answer" };
}

/** Ask the backend for the saved settings and keep them in the store (boot and the System screen). Returns the model. */
export async function fetchSettings(store, bridge) {
  const m = settingsModel(await bridge.settingsGet());
  setSettings(store, m);
  return m;
}

// ---- the view -------------------------------------------------------------------------------------------------------------------------------------------------------
export function systemView() {
  const subs = [];
  let closed = false;
  return {
    id: "system",
    lx: true,
    mount(root, ctx) {
      const { store, bridge, toast } = ctx;
      const goto = (s, tab) => ctx.goto && ctx.goto(s, tab);
      closed = false;

      // ---- preflight
      const rerun = button({ level: 1, label: "Re-run", cost: "0 req", hint: "system.rerun", id: "sys-rerun", onClick: () => rerunPreflight() });
      const preBox = h("div", { class: "lx-sys-pre-box" });
      const preFacts = h("div", { class: "lx-sys-facts", id: "sys-summary" });
      const checksBody = h("tbody", { id: "sys-checks" });
      const checksTable = h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--dense", "aria-label": "Preflight checks, worst first" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", "aria-label": "Result" }), h("th", { scope: "col", text: "Check" }), h("th", { scope: "col", text: "Detail" }))), checksBody);
      const preP = panel({ title: "Preflight", end: rerun, id: "sys-preflight", flush: true, body: [h("div", { class: "lx-sys-pre-top" }, preBox, preFacts), checksTable] });
      preP.band.el.dataset.hint = "system.preflight";

      // ---- limits
      const limNote = h("div", { class: "lx-tfoot-note", id: "sys-limits-note" });
      const limBody = h("tbody", { id: "sys-limits-body" });
      const limTable = h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--dense", id: "sys-limits", "aria-label": "Limits from this CPU" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Limit" }), h("th", { scope: "col", text: "Applies to" }), h("th", { scope: "col", class: "lx-n", text: "CPU limit" }), h("th", { scope: "col", class: "lx-wide", text: "Source" }))), limBody);
      const limReload = button({ level: 1, label: "Reload", cost: "0 req", id: "sys-limits-reload", onClick: () => loadLimits() });
      const limP = panel({ title: "Limits from this CPU", end: limReload, id: "sys-limits-card", flush: true, body: [limTable, limNote] });
      limP.band.el.dataset.hint = "system.limits";

      // ---- helper & link
      const helperBody = h("div", { id: "sys-helper" });
      const helperP = panel({ title: "App", id: "sys-helper-card", body: helperBody });
      helperP.band.el.dataset.hint = "system.helper";
      let version = { text: NA, why: "asking the app…" };

      // ---- settings
      const intervalSeg = createSegmented({ options: INTERVALS.map((v) => ({ value: String(v), label: `${v} s` })), value: String(store.get().settings.refresh_s), label: "Refresh interval", hint: "system.refresh", id: "sys-refresh", onChange: (v) => changeInterval(Number(v)) });
      const notifySeg = createSegmented({ options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }], value: "on", label: "Notifications", hint: "system.notify", id: "sys-notify", onChange: (v) => changeNotify(v === "on") });
      const setNote = h("p", { class: "lx-sys-note", id: "sys-setting-note", role: "status" });
      const unsaved = h("span", { class: "lx-why", id: "sys-unsaved", hidden: true });
      const row = (hintKey, control) => [h("dt", { dataset: { hint: hintKey } }, HINTS[hintKey].label), h("dd", {}, control)];
      // G-252: boot restore lives in Profiles (its state and the command that enables it); this is only the way there, shown when the helper reports it
      const bootGo = button({ level: 0, label: "Set up in Profiles ›", id: "sys-boot-go", hint: "system.bootrestore", onClick: () => goto("profiles") });
      const bootDt = h("dt", { dataset: { hint: "system.bootrestore" }, hidden: true }, "Boot restore");
      const bootDd = h("dd", { hidden: true }, bootGo);
      const setDl = h("dl", { class: "lx-kv lx-sys-settings" }, ...row("system.refresh", intervalSeg.el), ...row("system.notify", notifySeg.el), bootDt, bootDd);
      const setP = panel({ title: "Settings", id: "sys-settings", body: [setDl, unsaved, setNote] });

      // ---- topology
      const topoBody = h("tbody", { id: "sys-topo-body" });
      const topoNote = h("div", { class: "lx-tfoot-note", id: "sys-topo-note" });
      const topoTable = h("table", { class: "lx-tbl lx-tbl--fill lx-tbl--dense", "aria-label": "Topology" },
        h("thead", {}, h("tr", {},
          h("th", { scope: "col", text: "Unit" }), h("th", { scope: "col", text: "Kind" }), h("th", { scope: "col", class: "lx-n", text: "CPUs" }),
          h("th", { scope: "col", class: "lx-n", dataset: { hint: "system.maxratio" } }, "Max ratio", h("span", { class: "lx-hu", text: "× cpufreq" })),
          h("th", { scope: "col", class: "lx-n", text: "Perf" }), h("th", { scope: "col", "aria-label": "Favored" }))), topoBody);
      const topoP = panel({ title: "Topology", id: "sys-topology", flush: true, body: [topoTable, topoNote] });
      topoP.band.el.dataset.hint = "system.topology";

      // ---- about (D-054, docs/NAMING.md): the name, and the line that follows it wherever it is introduced
      const aboutP = panel({ title: "About", id: "sys-about", body: [
        h("p", { class: "lx-sys-about" }, wordmark({ large: true })),
        h("p", { class: "lx-sys-note", text: "Per-core voltage, ratio and power tuning for Intel Core Ultra 200S (Arrow Lake-S) processors on Linux." }),
        h("p", { class: "lx-sys-note", id: "sys-not-affiliated", text: NOT_AFFILIATED }),
      ] });

      root.append(h("div", { class: "lx-tiles lx-sys" },
        h("div", { class: "lx-sys-col" }, preP.el, limP.el, aboutP.el),
        h("div", { class: "lx-sys-col" }, helperP.el, setP.el, topoP.el)));

      // ---- drawing
      const drawPreflight = (pre) => {
        clear(checksBody);
        clear(preBox);
        clear(preFacts);
        drawTopology(pre);
        drawBoot(pre);
        const sum = preflightSummary(pre);
        if (!sum) {
          preP.setMeta(`${NA} · ${pre ? "the helper answered, but not with a full preflight report" : "no preflight yet"}`);
          ctx.head.set({ sub: "" });
          return;
        }
        preP.setMeta(countsText(sum.counts));
        if (sum.banner) preBox.append(box({ kind: sum.mode === "refuse" ? "fault" : "warn", title: sum.mode === "refuse" ? "Refused" : "Writes are off", body: sum.banner.replace(/^(Read-only mode|Refused): /, "").split("\n").map((t) => h("p", { text: t })), id: "sys-banner" }));
        preFacts.append(kv([["Mode", sum.mode, { mono: true }], ["Writes", sum.writes === null ? NA : sum.writes ? "allowed" : "not allowed"], ["Platform", sum.platform, { mono: true }], ["Board", sum.board]]));
        ctx.head.set({ sub: `${sum.platform} · ${sum.board}` });
        for (const c of sortChecks(pre.checks)) {
          const g = checkGlyph(c.status);
          checksBody.append(h("tr", { dataset: { status: String(c.status) } },
            h("td", { class: "lx-sys-glyph lx-res", dataset: { res: g.res }, title: String(c.status), text: g.glyph }),
            h("td", { class: "lx-mono lx-sys-check", text: String(c.name) }),
            h("td", { class: "lx-sys-detail", text: String(c.reason ?? "") })));
        }
      };
      const drawTopology = (pre) => {
        clear(topoBody);
        const rows = topologyRows(pre && pre.topology);
        const src = pre && pre.topology && pre.topology.favored_source;
        topoNote.textContent = rows.length ? `Read from this CPU by the helper${src ? `; ★ favored cores from ${src}` : ""}. Max ratio is the kernel’s (cpufreq), not the factory top V/F point.` : `${NA} · no topology from the helper yet`;
        for (const r of rows) {
          topoBody.append(h("tr", { dataset: { unit: r.id } },
            h("td", { class: "lx-k", text: r.id }), h("td", { text: r.kind }), h("td", { class: "lx-n", text: r.cpus }),
            h("td", { class: "lx-n", text: r.maxRatio.replace(/×/, "") }), h("td", { class: "lx-n", text: r.perf }),
            h("td", {}, r.favored ? h("span", { class: "lx-fav", title: "favored core", text: "★" }) : "")));
        }
      };
      const drawBoot = (pre) => {
        const m = bootRestoreModel(pre);
        bootDt.hidden = !m;
        bootDd.hidden = !m;
        if (m) bootDt.dataset.state = m.state;
      };
      const drawHelper = () => {
        clear(helperBody);
        const vNode = version.why ? [h("span", { class: "lx-na", text: version.text }), h("span", { class: "lx-sys-why", text: " · " + version.why })] : version.text;
        helperBody.append(kv([
          ["App version", vNode, { mono: !version.why }],
          ["Bridge", bridge.name, { mono: true }],
        ]));
        const dd = helperBody.querySelectorAll("dt");
        if (dd[0]) dd[0].dataset.hint = "system.version";
      };
      const drawSettings = (settings = store.get().settings) => {
        intervalSeg.set(String(settings.refresh_s));
        notifySeg.set(settings.notifications === false ? "off" : "on");
        notifySeg.setDisabled("on", !settings.saved);
        notifySeg.setDisabled("off", !settings.saved);
        clear(unsaved);
        unsaved.hidden = settings.saved;
        if (!settings.saved) unsaved.append(h("b", { text: HINTS["system.unsaved.why"].label }), HINTS["system.unsaved.why"].line);
        if (settings.saved && settings.why) setNote.textContent = settings.why;
      };
      let lastTune = null;
      const drawLimits = (last = lastTune) => {
        lastTune = last;
        clear(limBody);
        const rt = store.get().rt || {};
        const cl = last && last.available === true && isObj(last.result) ? mergeCpuLimits(last.result.cpu_limits, { power: rt.power && rt.power.result ? rt.power.result.cpu_limits : null, runtime: rt.runtime && rt.runtime.result ? rt.runtime.result.cpu_limits : null }) : null;
        limNote.textContent = limitsNote(last, cl);
        limTable.hidden = !cl;
        limP.setMeta(cl ? "read from the CPU" : "not read");
        for (const r of limitRows(cl)) {
          const na = r.cpu.startsWith(NA);
          limBody.append(h("tr", {}, h("td", { class: "lx-k", text: r.what }), h("td", { text: r.kind }),
            h("td", { class: na ? "lx-n lx-na" : "lx-n", text: r.cpu }), h("td", { class: "lx-wide lx-sys-src", text: r.source })));
        }
      };

      // ---- actions
      async function rerunPreflight() {
        rerun.disabled = true;
        setBusy(rerun, "Checking…");
        const res = await bridge.call("preflight");
        if (closed) return;
        setBusy(rerun, null);
        setButton(rerun, { label: "Re-run" });
        rerun.disabled = false;
        if (res.ok) setPreflight(store, res.result);
        else toast("error", `preflight failed: ${res.error.message}`);
      }
      async function loadLimits() {
        limP.setMeta("asking the helper…");
        const res = await bridge.call("tune.last");
        if (closed) return;
        if (res.ok) drawLimits(res.result);
        else {
          clear(limBody);
          limTable.hidden = true;
          limP.setMeta("unavailable");
          limNote.textContent = `${NA} · limits unavailable: ${res.error.message}`;
        }
      }
      async function changeInterval(s) {
        const res = await bridge.call("telemetry.start", { interval_s: s });
        if (closed) return;
        if (!res.ok) {
          intervalSeg.set(String(store.get().settings.refresh_s));
          setNote.textContent = `The interval was not changed: ${res.error.message}`;
          toast("warn", `refresh interval not changed: ${res.error.message}`);
          return;
        }
        setSettings(store, { refresh_s: s }); // the interval in force this session, saved or not
        if (!store.get().settings.saved) {
          setNote.textContent = `Live values every ${s} s until the app closes.`;
          return;
        }
        const saved = await bridge.settingsSet({ refresh_s: s });
        if (closed) return;
        setNote.textContent = saved.ok ? `Live values every ${s} s. Saved.` : `Live values every ${s} s, but not saved: ${saved.error.message}`;
      }
      async function changeNotify(on) {
        const res = await bridge.settingsSet({ notifications: on });
        if (closed) return;
        if (res.ok) {
          setSettings(store, settingsModel(res));
          setNote.textContent = on ? "Notifications on. Saved." : "Notifications off. Saved.";
        } else {
          setNote.textContent = `Notifications not changed: ${res.error.message}`;
          drawSettings();
        }
      }
      async function loadVersion() {
        const res = await bridge.appVersion();
        if (closed) return;
        version = res && res.ok && typeof res.result === "string" ? { text: res.result, why: "" } : { text: NA, why: (res && res.error && res.error.message) || "no answer" };
        drawHelper();
      }

      subs.push(
        store.watch((s) => s.preflight, (pre) => drawPreflight(pre)),
        store.watch((s) => s.settings, (v) => drawSettings(v)),
        store.watch((s) => s.rt, () => drawLimits()),
      );
      drawHelper();
      drawLimits(null);
      void fetchSettings(store, bridge); // the file may have changed since boot; the watcher redraws
      void loadVersion();
      if (store.get().link.state === "connected") loadLimits();
      else subs.push(store.watch((s) => s.link.state, (st) => { if (st === "connected") loadLimits(); }));
    },
    unmount() {
      closed = true;
      subs.splice(0).forEach((u) => u());
    },
  };
}
