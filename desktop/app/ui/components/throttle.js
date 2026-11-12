// components/throttle.js: the throttling indicators (G-229; docs/knowledge/throttling.md) as the LIMITS annunciators of desktop/DESIGN.md §5.6:
// PL1 · PL2 · PL4 · THERM · VR · TURBO, dark when idle, lit with the 10 Hz duty while the 0x64F status bit (or group) holds, and ONE popover with the
// bits, the source word, the time limited this session and a link to the setting (U-28). The popover is built once per open and updated in place: a
// telemetry tick never rebuilds a focused control (F-10). Also the models of the "Throttle events" list (Overview). Pure models first (unit-tested), DOM after.
// Reads only; "Reset indicators" clears this app's own counters, never a register.
import { h, clear } from "./dom.js";
import { fmtClock, fmtNum, NA } from "./fmt.js";
import { THROTTLE_GROUPS, resetThrottle } from "../store.js";
import { annunciator, setAnn } from "./ann.js";
import { button } from "./buttons.js";
import { band } from "./panel.js";
import { createPopover } from "./popover.js";

export const EVENTS_POLL_MS = 15000;
export const EVENTS_N = 50;
const XTU_NOTE = "since boot (sticky); may have been cleared by XTU on Windows";
const KERNEL_NOTE = "since boot (sticky); the Linux kernel clears these itself";

const pct = (duty) => `${Math.round(duty * 100)} %`;

/** One chip: {text, state: 'ok'|'warn'|'error'|'info'|'na', title}. Yes = amber (power, current) or red (thermal); Max turbo is grey whatever it says. */
export function chipModel(g) {
  if (g.state === "na") return { text: `${g.chip}: ${NA}`, state: "na", title: `${g.label}: n/a` };
  if (g.state === "no") return { text: `${g.chip}: No`, state: g.info ? "info" : "ok", title: `${g.label}: not limiting now` };
  const duty = typeof g.duty === "number" ? ` · ${pct(g.duty)}` : "";
  return {
    text: `${g.chip}: Yes${duty}`,
    state: g.info ? "info" : g.severity === "error" ? "error" : "warn",
    title: `${g.label}: limiting${typeof g.duty === "number" ? ` for ${pct(g.duty)} of the last samples` : " now"}${g.bits.length ? " (" + g.bits.map((b) => b.label).join(", ") + ")" : ""}`,
  };
}

/** "1 h 02 min" / "3 min 04 s" / "12.5 s" */
export function fmtSeconds(s) {
  if (!Number.isFinite(s) || s < 0) return NA;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// plain words for the limit reasons in the popover's text; the SDM names and bit numbers go to tooltips (QA-40)
const PLAIN = {
  prochot: "PROCHOT", thermal: "temperature", ratl: "average temperature", vr_therm_alert: "VR temperature", vr_tdc: "VR current", other: "PL4", pl1: "PL1", pl2: "PL2",
  max_turbo_limit: "turbo table", residency_state_regulation: "idle residency", turbo_transition_attenuation: "turbo transition", inefficient_operation: "inefficient operation",
  critical_temp: "critical temperature", threshold1: "temperature threshold 1", threshold2: "temperature threshold 2", power_limit: "power limit", pmax_log: "Pmax",
};
const SUBJECT = { "0x64F": "the CPU has also been limited by", "0x6B1": "the ring has also been limited by", "0x6B0": "the iGPU has also been limited by", "0x1B1": "the package temperature logged" };
export const plainReason = (key) => PLAIN[key] || key;

/** The popover as data: {state, reason, groups:[{label, text, seconds}], active:[line], others:[line], unknown:[line], sticky:[{head, note, names}], kernel, footer}. */
export function popoverModel(model, session) {
  if (!model || model.state === "na") {
    return { state: "na", reason: (model && model.reason) || "no telemetry yet", source: (model && model.source) || "", groups: [], active: [], others: [], unknown: [], sticky: [], kernel: null, activeWords: [], sinceBoot: [], words: model ? model.words : [], footer: "" };
  }
  const groups = model.groups.map((g) => ({ label: g.label, text: chipModel(g).text.replace(`${g.chip}: `, ""), state: chipModel(g).state, seconds: session ? session.seconds[g.key] || 0 : 0 }));
  const active = model.active.map((a) => {
    const g = THROTTLE_GROUPS.find((x) => x.key === a.group);
    return { bit: a.bit, label: a.label, group: g ? g.label : "informational", info: !g || !!g.info, duty: a.duty, msr: a.msr, line: `bit ${a.bit} · ${a.label} · ${g ? g.label : "informational"}${a.duty !== null ? ` · ${pct(a.duty)} of samples` : ""} · ${a.msr}` };
  });
  const others = [];
  for (const w of model.words) {
    if (w.msr === "0x64F" || !w.status.length) continue;
    others.push(`${w.msr} ${w.name}: ${w.status.map((s) => s.label).join(", ")}`);
  }
  const sticky = model.words.filter((w) => w.log.length).map((w) => ({ head: `${w.msr} ${w.name}`, note: w.xtuClears ? XTU_NOTE : KERNEL_NOTE, names: w.log.map((l) => l.label) }));
  const activeWords = active.map((a) => ({ text: `${a.label} · ${a.group}${a.duty !== null ? ` · ${pct(a.duty)} of samples` : ""}`, title: a.line }));
  const sinceBoot = model.words.filter((w) => w.log.length).map((w) => {
    const names = [...new Set(w.log.map((l) => plainReason(l.key)))];
    return { text: `Since boot ${SUBJECT[w.msr] || `${w.name} has logged`}: ${names.join(", ")}`, title: `${w.msr} ${w.name} (log): ${w.log.map((l) => l.label).join(", ")} — ${w.xtuClears ? XTU_NOTE : KERNEL_NOTE}` };
  });
  const k = model.kernel;
  const kernel = k ? `Kernel thermal events since boot: core ${k.core_count}, package ${k.package_count}${k.core_delta + k.package_delta ? ` (+${k.core_delta + k.package_delta} this tick)` : ""}` : null;
  const footer = model.samples > 1 ? `${model.samples} samples over the last ${model.windowS === null ? "?" : fmtNum(model.windowS, 1)} s (~10 Hz on CPU 0)` : "one point-in-time read (no duty: this helper does not oversample)";
  return { state: "ok", reason: null, source: model.source, groups, active, others, unknown: model.unknown.map((b) => `bit ${b} · not named by the SDM`), sticky, kernel, activeWords, sinceBoot, words: model.words, footer, simulated: !!model.simulated, logFile: model.logFile };
}

/** One throttle.jsonl record -> table cells. */
export function eventModel(r) {
  if (!r || typeof r !== "object" || r.unparsable !== undefined) return { bad: true, text: r && r.unparsable !== undefined ? `unparsable line: ${r.unparsable}` : "unreadable record" };
  const num = (v, u, d = 0) => (typeof v === "number" ? `${fmtNum(v, d)} ${u}` : NA);
  return {
    bad: false,
    key: `${r.t_on}-${r.group}`,
    when: `${r.t_on ? new Date(r.t_on * 1000).toLocaleDateString() : ""} ${fmtClock(r.t_on)}`.trim(),
    tOff: typeof r.t_off === "number" ? r.t_off : null,
    group: r.label || r.group || NA,
    bits: Array.isArray(r.bits) ? r.bits.join(", ") : NA,
    duration: typeof r.dur_ms === "number" ? fmtSeconds(r.dur_ms / 1000) : NA,
    duty: typeof r.duty === "number" ? pct(r.duty) : NA,
    peaks: [num(r.peak_temp_c, "°C"), num(r.peak_pkg_w, "W", 1), num(r.peak_mhz, "MHz")].join(" · "),
    kernel: typeof r.kernel_thermal_delta === "number" && r.kernel_thermal_delta > 0 ? `+${r.kernel_thermal_delta} kernel thermal` : "",
    tuning: r.tuning_id || "none recorded",
  };
}

/** Events newer than the last "Reset indicators" (all of them when `all` or never reset), newest first. */
export function visibleEvents(records, resetAt, all) {
  const list = Array.isArray(records) ? records : [];
  const kept = !all && resetAt ? list.filter((r) => !r || typeof r.t_off !== "number" || r.t_off >= resetAt) : list;
  return [...kept].reverse();
}

// ---------------------------------------------------------------- LIMITS annunciators (§5.6)
/** The six legends: which status bit (per-bit duty) or group (group duty) lights each, and how it lights. */
export const LIMIT_ANNS = [
  { key: "pl1", label: "PL1", hint: "ann.pl1", lit: "lit-warn", bit: "pl1", what: "Package power limit PL1", group: "power" },
  { key: "pl2", label: "PL2", hint: "ann.pl2", lit: "lit-warn", bit: "pl2", what: "Package power limit PL2", group: "power" },
  { key: "pl4", label: "PL4", hint: "ann.pl4", lit: "lit-warn", group: "current", what: "Current / PL4 (electrical)" },
  { key: "therm", label: "Therm", hint: "ann.therm", lit: "lit-fault", group: "thermal", what: "Thermal" },
  { key: "vr", label: "VR", hint: "ann.vr", lit: "lit-warn", group: "vr_thermal", what: "VR thermal" },
  { key: "turbo", label: "Turbo", hint: "ann.turbo", lit: "lit-info", group: "max_turbo", what: "Max turbo cap (normal under load)" },
];

const pctShort = (duty) => `${Math.round(duty * 100)}%`;

/**
 * The legends from the throttle model (store.telemetry.throttle): [{key, label, state, duty, on, text}]. n/a while connected = "unknown" (dashed);
 * disconnected = dark (§5.12: the reason is said once, in Setup). Pure (unit-tested).
 */
export function limitAnnModel(model, { connected = true } = {}) {
  return LIMIT_ANNS.map((a) => {
    if (!model || model.state === "na") return { key: a.key, label: a.label, state: connected ? "unknown" : "idle", duty: null, on: false, text: NA };
    let on = false;
    let duty = null;
    if (a.bit) {
      const bit = model.active.find((x) => x.key === a.bit);
      on = !!bit;
      duty = bit && typeof bit.duty === "number" ? bit.duty : null;
    } else {
      const g = model.groups.find((x) => x.key === a.group);
      on = !!g && g.state === "yes";
      duty = on && typeof g.duty === "number" ? g.duty : null;
    }
    return { key: a.key, label: a.label, state: on ? a.lit : "idle", duty: on && duty !== null ? pctShort(duty) : null, on, text: on ? (duty !== null ? pctShort(duty) : "on") : "off" };
  });
}

/**
 * createLimits(store, {goto(screen, tab), caption, id}) -> {el, anns: Map(key -> button), pop, dispose()}.
 * `el` = <span class="lx-read-end">LIMITS + six annunciator buttons; any of them opens the one popover.
 */
export function createLimits(store, { goto = null, caption = true, id = "limits", place = "above" } = {}) {
  const anns = new Map();
  const el = h("span", { class: caption ? "lx-read-end" : "lx-anns", id, role: "group", "aria-label": "Limits" }, caption ? h("span", { class: "lx-cluster-k lx-wide", text: "Limits" }) : null);
  const pop = createPopover({ label: "Limit reasons", id: `${id}-pop` });
  for (const a of LIMIT_ANNS) {
    const b = annunciator({ label: a.label, ann: a.key, hint: a.hint, id: `${id}-${a.key}`, onClick: () => toggle(b) });
    anns.set(a.key, b);
    el.append(b);
  }

  // popover: static frame built once; text cells updated in place; lists below are text-only (no focusable element is ever rebuilt)
  const head = band({ title: "Limit reasons", meta: "" });
  const rows = new Map();
  const tbody = h("tbody");
  for (const a of LIMIT_ANNS) {
    const now = h("td", { class: "lx-n", dataset: { col: "now" } });
    const sess = h("td", { class: "lx-n", dataset: { col: "session" } });
    tbody.append(h("tr", { dataset: { limit: a.key } }, h("td", { class: "lx-k", text: a.label }), h("td", { text: a.what }), now, sess));
    rows.set(a.key, { now, sess, group: a.group });
  }
  const table = h("table", { class: "lx-tbl lx-tbl--compact lx-tbl--fill" }, h("thead", {}, h("tr", {}, h("th", { text: "Limit" }), h("th", { text: "What" }), h("th", { class: "lx-n", text: "Now" }), h("th", { class: "lx-n", text: "This session" }))), tbody);
  const active = h("div", { class: "lx-pop-sec", id: `${id}-pop-bits` });
  const note = h("div", { class: "lx-tfoot-note", id: `${id}-pop-note` });
  const reset = button({ level: 0, label: "Reset indicators", id: `${id}-reset`, title: "Clears this app's session counters only. No register is written.", onClick: () => resetThrottle(store) });
  const toPower = h("button", { type: "button", class: "lx-link", id: `${id}-to-power`, text: "Tune › Power", on: { click: () => { pop.close({ focus: false }); if (goto) goto("tune", "power"); } } });
  const foot = h("div", { class: "lx-pop-foot" }, reset, h("span", { class: "lx-spacer" }), toPower);
  pop.el.append(head.el, table, active, note, foot);
  pop.el.dataset.pop = "limits";

  function fillPop() {
    const st = store.get();
    const model = st.telemetry.throttle;
    const pm = popoverModel(model, st.throttleSession);
    head.setMeta(model.state === "na" ? `n/a · ${model.reason}` : `${model.source}${model.windowS ? ` · last ${fmtNum(model.windowS, 1)} s` : ""}`);
    const am = limitAnnModel(model, { connected: st.link.state === "connected" });
    for (const m of am) {
      const r = rows.get(m.key);
      if (r.now.textContent !== m.text) r.now.textContent = m.text;
      const secs = model.state === "na" ? NA : fmtSeconds(st.throttleSession.seconds[r.group] || 0);
      if (r.sess.textContent !== secs) r.sess.textContent = secs;
    }
    const lines = pm.state === "na" ? [] : [...pm.activeWords, ...pm.unknown.map((t) => ({ text: "A limit bit with no public name is set", title: t })), ...pm.others.map((t) => ({ text: t, title: "" })), ...pm.sinceBoot, ...(pm.kernel ? [{ text: pm.kernel, title: "" }] : [])];
    const sig = lines.map((l) => `${l.text}\u0001${l.title}`).join("\n");
    if (active.dataset.sig !== sig) {
      active.dataset.sig = sig;
      clear(active).append(...(lines.length ? lines : [{ text: "No limit is holding the CPU back.", title: "" }]).map((l) => h("div", { class: "lx-pop-line", text: l.text, title: l.title || undefined })));
    }
    const raw = pm.state === "na" ? "" : pm.words.map((w) => `${w.msr} = ${w.rawText}  (${w.name})`).join("\n");
    const nt = pm.state === "na" ? `${pm.reason}${pm.source ? " (" + pm.source + ")" : ""}` : `${pm.footer}.${pm.simulated ? " Simulated words, not hardware." : ""}`;
    if (note.textContent !== nt) note.textContent = nt;
    note.setAttribute("title", raw);
  }
  function toggle(trigger) {
    if (pop.isOpen() && pop.trigger() === trigger) return pop.close();
    fillPop();
    pop.open(trigger, { align: "right", place });
  }
  /** Open the same popover at another trigger (the Overview's limit rows, QA-40). */
  function openAt(trigger, opts = {}) {
    if (pop.isOpen() && pop.trigger() === trigger) return pop.close();
    fillPop();
    pop.open(trigger, { align: "left", place: "below", ...opts });
  }
  const paint = () => {
    const st = store.get();
    for (const m of limitAnnModel(st.telemetry.throttle, { connected: st.link.state === "connected" })) setAnn(anns.get(m.key), { state: m.state, duty: m.duty });
    if (pop.isOpen()) fillPop();
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.telemetry.throttle !== prev.telemetry.throttle || s.throttleSession !== prev.throttleSession || s.link !== prev.link) paint();
  });
  paint();
  return {
    el,
    anns,
    pop,
    openAt,
    dispose() {
      unsub();
      pop.dispose();
    },
  };
}
