// components/panel.js: surfaces (desktop/DESIGN.md §5.9, §5.12): panel + 28 px title band, key/value list, boxes, and the empty / loading /
// disconnected blocks. Panels are ruled, not carded: they sit in an .lx-tiles grid and the 1 px gap is the seam.
import { h, clear, setVar } from "./dom.js";

const nodes = (x) => (x === null || x === undefined ? [] : [].concat(x));

/** band({title, meta, end, top}) -> <div class="lx-band"> caption · meta · right end (L0/L1 buttons, "?", a persistence tag). */
export function band({ title = "", meta = null, end = null, top = false, id } = {}) {
  const metaEl = h("span", { class: "lx-band-m" }, ...nodes(meta));
  const endEl = h("span", { class: "lx-band-end" }, ...nodes(end));
  const el = h("div", { class: ["lx-band", top ? "lx-band--top" : ""], id }, h("span", { class: "lx-band-t", text: title }), metaEl, endEl);
  return { el, metaEl, endEl, setMeta: (m) => clear(metaEl).append(...nodes(m)) };
}

/**
 * panel({title, meta, end, body, id, flush, scroll, label}) -> {el, band, body, setMeta}.
 * `flush` drops the 12 px body inset (tables); `scroll` lets the body scroll inside the panel (sticky table headers).
 */
export function panel({ title = "", meta = null, end = null, body = null, id, flush = false, scroll = false, label } = {}) {
  const b = title || meta || end ? band({ title, meta, end }) : null;
  const bodyEl = h("div", { class: ["lx-panel-b", flush ? "lx-panel-b--flush" : "", scroll ? "lx-panel-b--scroll" : ""] }, ...nodes(body));
  const el = h("section", { class: "lx-panel", id, "aria-label": label || title || undefined }, b ? b.el : null, bodyEl);
  return { el, band: b, body: bodyEl, setMeta: b ? b.setMeta : () => {} };
}

/** kv([[key, value, {mono}]]) -> <dl class="lx-kv">; value may be text or nodes. */
export function kv(rows) {
  const dl = h("dl", { class: "lx-kv" });
  for (const [k, v, o = {}] of rows) dl.append(h("dt", { text: k }), h("dd", { class: o.mono ? "lx-mono" : "", dataset: o.v ? { v: o.v } : {} }, ...nodes(v)));
  return dl;
}

/** box({kind, title, body}) -> <div class="lx-box lx-box--kind">: a refusal (fault), a warning, an ok result, or a neutral fact that must be read. */
export function box({ kind = "", title = "", body = null, id } = {}) {
  if (!["", "ok", "warn", "fault"].includes(kind)) throw new Error(`box: kind "${kind}"`);
  return h("div", { class: ["lx-box", kind ? `lx-box--${kind}` : ""], id, dataset: kind ? { box: kind } : {}, role: kind === "fault" ? "alert" : undefined }, h("span", { class: "lx-box-t", text: title }), ...nodes(body));
}

/**
 * emptyState({title, teach, action, cost, id}) -> <div class="lx-empty">: what is missing, one teaching sentence (hidden with Hints: quiet), the one
 * action that starts it with its cost ("About 1 s. Changes nothing."). Copy comes from lib/hints.js EMPTY.
 */
export function emptyState({ title, teach = "", action = null, cost = "", id } = {}) {
  return h(
    "div",
    { class: "lx-empty", id, dataset: { empty: "true" } },
    h("span", { class: "lx-empty-t", text: title }),
    teach ? h("p", { class: "lx-teach", text: teach }) : null,
    action || cost ? h("div", { class: "lx-empty-act" }, ...nodes(action), cost ? h("span", { class: "lx-teach-cost", text: cost }) : null) : null,
  );
}

/** The loading rule under a band: 2 px, --p = fraction done (0..1). `write` = the orange write progress (commit sheet only). */
export function progressRule(p = 0, { write = false } = {}) {
  const el = h("div", { class: ["lx-progress", write ? "lx-progress--write" : ""], role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" });
  return setProgress(el, p);
}
export function setProgress(el, p) {
  const f = Math.max(0, Math.min(1, Number(p) || 0));
  setVar(el, "--p", f);
  el.setAttribute("aria-valuenow", String(Math.round(f * 100)));
  return el;
}

/** The disconnected look of a block: values grey ("—"), the reason said once by the caller (Setup, a band meta) — never in every cell. */
export function setOffline(el, off) {
  el.classList.toggle("lx-offline", !!off);
  if (off) el.dataset.offline = "true";
  else el.removeAttribute("data-offline");
  return el;
}
