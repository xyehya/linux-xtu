// components/readout.js: the one-line readout bar (desktop/DESIGN.md §4; replaces the 151 px monitoring strip): the six live values — PKG, CLK, HOT,
// VCORE, CORE, DRAM (key caps, value mono 500, unit grey, a 44×14 sparkline for PKG and HOT) — then LIMITS and the six throttle annunciators.
// Select a value: the bar expands to 72 px with 60 s sparklines for all six; it pushes the work area up and never overlays (a persisted preference).
// Disconnected: values "—", annunciators dark, no message here. n/a carries the helper's reason, shown once in the context line on focus / hover.
// Below 1180 px CORE and DRAM hide (.lx-wide).
import { h, clear } from "./dom.js";
import { createSparkline } from "./sparkline.js";
import { markReason, setText } from "./help.js";
import { createLimits } from "./throttle.js";
import { setPref } from "../store.js";

export const EXPANDED_SAMPLES = 60; // ~60 s at the 1 s telemetry interval

export const READOUTS = [
  { key: "pkg_power", k: "PKG", unit: "W", digits: 1, scale: 1, hint: "readout.pkg", spark: true, w: 5 },
  { key: "clock", k: "CLK", unit: "GHz", digits: 2, scale: 1 / 1000, hint: "readout.clk", w: 4 },
  { key: "temp", k: "HOT", unit: "°C", digits: 0, scale: 1, hint: "readout.hot", spark: true, w: 3 },
  { key: "vcore", k: "VCORE", unit: "V", digits: 3, scale: 1, hint: "readout.vcore", w: 5 },
  { key: "core_power", k: "CORE", unit: "W", digits: 1, scale: 1, hint: "readout.core", wide: true, w: 5 },
  { key: "dram", k: "DRAM", unit: "GB/s", digits: 1, scale: 1, hint: "readout.dram", wide: true, w: 5 },
];

/** One readout's text: {text, na, unit, reason}. Disconnected = "—"; unavailable = "n/a" + the helper's reason; never 0 for a missing value. Pure. */
export function readoutValue(def, sample, { connected = true } = {}) {
  if (!connected) return { text: "—", na: true, unit: "", reason: null };
  if (!sample) return { text: "n/a", na: true, unit: "", reason: "no telemetry yet" };
  if (sample.value === null || sample.value === undefined || !Number.isFinite(sample.value)) return { text: "n/a", na: true, unit: "", reason: sample.reason || "not reported" };
  return { text: (sample.value * def.scale).toFixed(def.digits), na: false, unit: def.unit, reason: null };
}

/** createReadout(root, store, {goto}) -> {dispose, limits} */
export function createReadout(root, store, { goto = null } = {}) {
  clear(root);
  root.classList.add("lx-read");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Live values and limits");
  const cells = new Map();
  const vals = h("div", { class: "lx-ro-row" });
  for (const def of READOUTS) {
    const v = h("span", { class: ["lx-ro-v", `lx-w${def.w}`], dataset: { part: "value" } });
    const u = h("span", { class: "lx-ro-u", text: def.unit });
    const small = def.spark ? createSparkline({ w: 44, h: 14 }) : null;
    const big = createSparkline({ w: 120, h: 24, label: `${def.k}, last 60 s` });
    big.el.classList.add("lx-spark--lg");
    const btn = h("button", { type: "button", class: ["lx-ro", def.wide ? "lx-wide" : ""], id: `ro-${def.key}`, "aria-expanded": "false", dataset: { ro: def.key, hint: def.hint }, on: { click: () => setPref(store, "readout", store.get().prefs.readout === "expanded" ? "line" : "expanded") } },
      h("span", { class: "lx-ro-line" }, h("span", { class: "lx-ro-k", text: def.k }), v, u, small ? small.el : null), big.el);
    cells.set(def.key, { btn, v, u, small, big, def });
    vals.append(btn);
  }
  const limits = createLimits(store, { goto, id: "limits" });
  root.append(vals, limits.el);

  const draw = () => {
    const st = store.get();
    const connected = st.link.state === "connected";
    const expanded = st.prefs.readout === "expanded";
    if (root.dataset.expanded !== String(expanded)) root.dataset.expanded = String(expanded);
    for (const [key, c] of cells) {
      const r = readoutValue(c.def, st.telemetry.samples ? st.telemetry.samples[key] : null, { connected });
      // G-248 (G-247): text and attributes are written only when they change, so a telemetry tick that moves nothing touches nothing
      setText(c.v, r.text);
      if (c.v.dataset.na !== String(r.na)) c.v.dataset.na = String(r.na);
      if (c.u.hidden !== r.na) c.u.hidden = r.na;
      if (c.btn.getAttribute("aria-expanded") !== String(expanded)) c.btn.setAttribute("aria-expanded", String(expanded));
      if (c.reason !== r.reason) {
        c.reason = r.reason;
        markReason(c.btn, null, {}, { text: r.reason });
      }
      const hist = (st.telemetry.history[key] || []).map((x) => (x === null ? null : x * c.def.scale));
      if (c.small) c.small.draw(connected ? hist : []);
      if (expanded) c.big.draw(connected ? hist.slice(-EXPANDED_SAMPLES) : []);
    }
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.telemetry !== prev.telemetry || s.link !== prev.link || s.prefs !== prev.prefs) draw();
  });
  draw();
  return {
    limits,
    dispose() {
      unsub();
      limits.dispose();
    },
  };
}
