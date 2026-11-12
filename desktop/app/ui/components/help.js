// components/help.js: the hint layers that sit next to a control (desktop/DESIGN.md §6): label + expert term, the "?" expander that opens in place,
// and the why line (refusal, lock, warning). All text comes from lib/hints.js (HINTS, WHY); nothing here writes prose. The context line and F1 live in
// the frame (context-line.js); "More in Tips ›" calls the opener the frame registers with setTipsOpener().
import { h, clear, nextId } from "./dom.js";
import { HINTS, WHY } from "../lib/hints.js";
import { TIPS } from "../lib/tips.js";
import { pushLayer } from "./layers.js";

let tipsOpener = null;
/** The frame registers how to open Tips at a section id (app.js). */
export function setTipsOpener(fn) {
  tipsOpener = typeof fn === "function" ? fn : null;
}
export function openTips(id) {
  if (tipsOpener) tipsOpener(id || null);
}

export const tipTitle = (id) => (TIPS.sections.find((s) => s.id === id) || {}).title || "";

/** A WHY template filled: {lead, text, kind}. Unknown keys throw (a typo must not ship a blank reason). */
export function fillWhy(key, vars = {}) {
  const t = WHY[key];
  if (!t) throw new Error(`help: unknown WHY key "${key}"`);
  const text = t.text.replace(/\{([a-zA-Z]+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  return { lead: t.lead, text, kind: whyKind(key) };
}
export const whyKind = (key) => (String(key).startsWith("refused.") ? "refused" : String(key).startsWith("warn.") ? "warn" : "locked");

/** <span class="lx-why" data-kind data-why>: bold lead + one sentence. `key` null gives an empty, hidden line (fill it later with setWhy). */
export function why(key = null, vars = {}, { inline = false, id } = {}) {
  const el = h("span", { class: ["lx-why", inline ? "lx-why--inline" : ""], id: id || nextId("why"), "aria-live": "polite" });
  return setWhy(el, key, vars);
}

/** Text of `el` changed in place: an existing lone text node gets new data (no node replaced), nothing is written when it is the same (G-247). */
export function setText(el, s) {
  const only = el.childNodes.length === 1 ? el.firstChild : null;
  if (only && only.nodeType === 3) {
    if (only.data !== s) only.data = s;
  } else if (el.textContent !== s) el.textContent = s;
  return el;
}

const whyNodes = new WeakMap(); // why line -> {lead: <b>, text: Text}: the two children are kept, only their text changes

/**
 * Fill a why line IN PLACE (G-247). The line is an aria-live region: replacing its children on every call (the old clear() + append) hands the
 * screen-reader bridge a fresh accessible object each time, and a call that changes nothing must change nothing. Same key + same text = no DOM write.
 */
export function setWhy(el, key, vars = {}) {
  if (!key) {
    if (el.firstChild) clear(el);
    whyNodes.delete(el);
    if (!el.hidden) el.hidden = true;
    if (el.getAttribute("data-why") !== null) el.removeAttribute("data-why");
    if (el.getAttribute("data-kind") !== null) el.removeAttribute("data-kind");
    return el;
  }
  const w = fillWhy(key, vars);
  if (el.hidden) el.hidden = false;
  if (el.dataset.why !== key) el.dataset.why = key;
  if (w.kind === "locked") {
    if (el.getAttribute("data-kind") !== null) el.removeAttribute("data-kind");
  } else if (el.dataset.kind !== w.kind) el.dataset.kind = w.kind;
  let n = whyNodes.get(el);
  if (!n || el.childNodes.length !== 2 || el.firstChild !== n.lead || el.lastChild !== n.text) {
    clear(el);
    n = { lead: h("b", { text: w.lead }), text: document.createTextNode(w.text) };
    el.append(n.lead, n.text);
    whyNodes.set(el, n);
    return el;
  }
  setText(n.lead, w.lead);
  if (n.text.data !== w.text) n.text.data = w.text;
  return el;
}

/**
 * A reason attached to a control that has no room for its why line (top bar, readout bar): the context line shows it on focus / hover instead of the
 * hint. `key` = a WHY template (vars filled), or `text` = a reason the helper gave (shown after `lead`). null clears it.
 */
export function markReason(el, key, vars = {}, { text = null, lead = "n/a" } = {}) {
  if (!key && !text) {
    el.removeAttribute("data-reason-key");
    el.removeAttribute("data-reason-vars");
    el.removeAttribute("data-reason");
    return el;
  }
  if (key) {
    el.dataset.reasonKey = key;
    el.dataset.reasonVars = JSON.stringify(vars || {});
    el.removeAttribute("data-reason");
  } else {
    el.dataset.reason = text;
    el.dataset.reasonLead = lead;
    el.removeAttribute("data-reason-key");
    el.removeAttribute("data-reason-vars");
  }
  return el;
}

/** The reason markReason() put on `el`, as {lead, text, kind}, or null. */
export function reasonOf(el) {
  if (!el || !el.dataset) return null;
  if (el.dataset.reasonKey) {
    let vars = {};
    try {
      vars = JSON.parse(el.dataset.reasonVars || "{}");
    } catch {
      vars = {};
    }
    return fillWhy(el.dataset.reasonKey, vars);
  }
  if (el.dataset.reason) return { lead: el.dataset.reasonLead || "n/a", text: el.dataset.reason, kind: "locked" };
  return null;
}

/** Plain label first, the expert term second in grey mono (§6.5). `text` / `term` override the hint's own. */
export function label(hintKey, { text, term, id, forId } = {}) {
  const hint = HINTS[hintKey] || {};
  const t = term ?? hint.term;
  return h(forId ? "label" : "span", { class: "lx-lbl-wrap", id, for: forId, dataset: hintKey ? { hint: hintKey } : {} }, h("span", { class: "lx-lbl", text: text ?? hint.label ?? "" }), t ? h("span", { class: "lx-term", text: t }) : null);
}

const openIn = new WeakMap(); // container -> the open expander's api (one open per panel)

/**
 * The "?" expander (§6.3): createQ(hintKey, {colspan}) -> {button, more, open(), close(), toggle()}. `more` goes directly after the label's row; with
 * `colspan` it is a `tr.lx-why-row` for a table. Only one open per panel (closest .lx-panel, else the parent of `more`); Esc collapses and refocuses.
 */
export function createQ(hintKey, { colspan = 0, label: aria } = {}) {
  const hint = HINTS[hintKey];
  if (!hint) throw new Error(`help: unknown hint "${hintKey}"`);
  const id = nextId("more");
  const button = h("button", { class: "lx-q", type: "button", "aria-expanded": "false", "aria-controls": id, "aria-label": aria || `About ${hint.label}`, dataset: { hint: hintKey, q: hintKey }, text: "?" });
  const box = h("div", { class: "lx-more", id: colspan ? undefined : id });
  const paras = (hint.more && hint.more.length ? hint.more : [hint.line]).map((p, i) => {
    if (i > 0) return h("p", { text: p });
    const m = /^(.+?[.:])(\s+)([\s\S]*)$/.exec(p);
    return m ? h("p", {}, h("span", { class: "lx-more-t", text: m[1] }), m[2] + m[3]) : h("p", {}, h("span", { class: "lx-more-t", text: p }));
  });
  box.append(...paras);
  if (hint.tip) box.append(h("p", {}, h("button", { type: "button", class: "lx-link", dataset: { tip: hint.tip }, text: `More in Tips › ${tipTitle(hint.tip)}`, on: { click: () => openTips(hint.tip) } })));
  const more = colspan ? h("tr", { class: "lx-why-row", id }, h("td", { colspan }, box)) : box;
  more.hidden = true;
  let drop = null;
  const scope = () => button.closest(".lx-panel") || more.parentNode || button.parentNode;
  const api = {
    button,
    more,
    isOpen: () => !more.hidden,
    open() {
      if (!more.hidden) return;
      const sc = scope();
      const other = sc ? openIn.get(sc) : null;
      if (other && other !== api) other.close({ focus: false });
      more.hidden = false;
      button.setAttribute("aria-expanded", "true");
      if (sc) openIn.set(sc, api);
      drop = pushLayer(() => api.close({ focus: true }), more);
    },
    close({ focus = false } = {}) {
      if (more.hidden) return;
      more.hidden = true;
      button.setAttribute("aria-expanded", "false");
      const sc = scope();
      if (sc && openIn.get(sc) === api) openIn.delete(sc);
      if (drop) drop();
      drop = null;
      if (focus && button.isConnected) button.focus();
    },
    toggle() {
      if (more.hidden) api.open();
      else api.close({ focus: false });
    },
  };
  button.addEventListener("click", () => api.toggle());
  for (const node of [button, more]) {
    node.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !more.hidden) {
        e.preventDefault();
        e.stopPropagation();
        api.close({ focus: true });
      }
    });
  }
  return api;
}
