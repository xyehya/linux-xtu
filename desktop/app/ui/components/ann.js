// components/ann.js: annunciators, tags and the small marks (desktop/DESIGN.md §5.5–§5.7). An annunciator is a rectangular legend, dark when idle and
// lit when its condition holds (lit-warn / lit-fault / lit-info), dashed while unknown; link and mode legends carry a 6 px pip instead of glowing.
// A tag is static text (never interactive); persistence tags say what clears a value.
import { h } from "./dom.js";

export const ANN_STATES = ["idle", "unknown", "lit-warn", "lit-fault", "lit-info"];
export const PIPS = ["ok", "warn", "fault", "off"];
export const TAGS = ["", "ok", "warn", "fault", "set", "mono", "persist"];

/** annunciator({label, state, pip, duty, hint, id, onClick, ann}) -> <button class="lx-ann" data-ann data-state> (a <span> without onClick). */
export function annunciator({ label, state = "idle", pip = null, duty = null, hint, id, onClick, ann, title } = {}) {
  const el = h(onClick ? "button" : "span", { class: "lx-ann", id, title, type: onClick ? "button" : undefined, dataset: { ...(ann ? { ann } : {}), ...(hint ? { hint } : {}) }, on: onClick ? { click: onClick } : undefined });
  if (onClick) {
    el.setAttribute("aria-haspopup", "dialog");
    el.setAttribute("aria-expanded", "false");
  }
  el.append(h("span", { class: "lx-pip", hidden: pip === null }), h("span", { class: "lx-ann-t", text: label }), h("span", { class: "lx-duty", hidden: duty === null, text: duty ?? "" }));
  return setAnn(el, { state, pip, duty });
}

/** Text of `el` changed in place: a lone text node gets new data (no node replaced); same text = no write (G-247). Local copy of help.js setText (help.js pulls in more than ann needs). */
function setText(el, s) {
  const only = el.childNodes.length === 1 ? el.firstChild : null;
  if (only && only.nodeType === 3) {
    if (only.data !== s) only.data = s;
  } else if (el.textContent !== s) el.textContent = s;
}

/** Update an annunciator in place: {label?, state?, pip? ("ok"|"warn"|"fault"|"off"|null = none), duty? (text or null)}. */
export function setAnn(el, { label, state, pip, duty } = {}) {
  const [pipEl, t, dutyEl] = el.children;
  if (label !== undefined) setText(t, label);
  if (state !== undefined) {
    if (!ANN_STATES.includes(state)) throw new Error(`annunciator: state "${state}"`);
    if (state === "idle") {
      if (el.getAttribute("data-state") !== null) el.removeAttribute("data-state");
    } else if (el.dataset.state !== state) el.dataset.state = state;
  }
  if (pip !== undefined) {
    if (pipEl.hidden !== (pip === null)) pipEl.hidden = pip === null;
    if (pip === null || pip === "off") {
      if (pipEl.getAttribute("data-pip") !== null) pipEl.removeAttribute("data-pip");
    } else if (pipEl.dataset.pip !== pip) pipEl.dataset.pip = pip;
  }
  if (duty !== undefined) {
    const hide = duty === null || duty === "";
    if (dutyEl.hidden !== hide) dutyEl.hidden = hide;
    setText(dutyEl, duty ?? "");
  }
  return el;
}

/** tag(text, variant) -> <span class="lx-tag lx-tag--variant">; variants: "" ok warn fault set mono persist. */
export function tag(text, variant = "") {
  if (!TAGS.includes(variant)) throw new Error(`tag: variant "${variant}"`);
  return h("span", { class: ["lx-tag", variant ? `lx-tag--${variant}` : ""], dataset: variant ? { tag: variant } : {}, text });
}

/** The 6 px cyan square "holds an edit". */
export const mark = () => h("span", { class: "lx-mark", "aria-hidden": "true" });
/** ★ favored core (fg2, never yellow). */
export const fav = () => h("span", { class: "lx-fav", title: "favored core", text: "★" });
