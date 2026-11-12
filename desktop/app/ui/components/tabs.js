// components/tabs.js: `.lx-tabs` (desktop/DESIGN.md §5.4) — sub-screens only (Tune tabs, Curves Chart/Table/Library). Selected = aria-selected + the 2 px
// underline on the header rule; a `.lx-mark` after a tab that holds edits. Roving tabindex; ←/→/Home/End move and select (the WAI tabs pattern).
import { h, clear } from "./dom.js";

/**
 * createTabs({tabs: [{id, label, edited, disabled, hint}], selected, label, idPrefix, controls, onSelect}) -> {el, update({tabs?, selected?}), focus()}
 * Each tab is <button role="tab" id="{idPrefix}{id}" data-tab="{id}" [data-edited]>; `controls` = id of the tabpanel.
 */
export function createTabs({ tabs = [], selected = null, label = "", idPrefix = "tab-", controls, onSelect } = {}) {
  const el = h("div", { class: "lx-tabs", role: "tablist", "aria-label": label });
  let list = tabs;
  let sel = selected;
  const btns = new Map();
  const build = () => {
    clear(el);
    btns.clear();
    for (const t of list) {
      const b = h("button", {
        type: "button",
        role: "tab",
        id: idPrefix + t.id,
        "aria-controls": controls,
        dataset: { tab: t.id, ...(t.hint ? { hint: t.hint } : {}) },
        on: { click: () => choose(t.id) },
      });
      b.append(h("span", { class: "lx-tab-t", text: t.label }));
      btns.set(t.id, b);
      el.append(b);
    }
  };
  const paint = () => {
    for (const t of list) {
      const b = btns.get(t.id);
      const on = t.id === sel;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = !!t.disabled;
      const mark = b.querySelector(".lx-mark");
      if (t.edited && !mark) b.append(h("span", { class: "lx-mark", "aria-hidden": "true" }));
      if (!t.edited && mark) mark.remove();
      if (t.edited) b.dataset.edited = "true";
      else b.removeAttribute("data-edited");
      b.setAttribute("aria-label", t.edited ? `${t.label}, holds edits` : t.label);
    }
  };
  const choose = (id, focus = false) => {
    const t = list.find((x) => x.id === id);
    if (!t || t.disabled) return;
    if (focus) btns.get(id).focus();
    if (id !== sel && onSelect) onSelect(id);
  };
  el.addEventListener("keydown", (e) => {
    const live = list.filter((t) => !t.disabled);
    const i = live.findIndex((t) => t.id === sel);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? live.length - 1 : null;
    if (j === null || !live.length) return;
    e.preventDefault();
    choose(live[(j + live.length) % live.length].id, true);
  });
  build();
  paint();
  return {
    el,
    update({ tabs: next, selected: s } = {}) {
      if (next && (next.length !== list.length || next.some((t, i) => t.id !== list[i].id || t.label !== list[i].label))) {
        list = next;
        build();
      } else if (next) list = next;
      if (s !== undefined) sel = s;
      paint();
    },
    focus() {
      const b = btns.get(sel);
      if (b) b.focus();
    },
  };
}
