// components/workhead.js: the work header (desktop/DESIGN.md §4): screen title (15/600) · sub-tabs with edit marks, or a grey subtitle · at the right end
// the persistence tag of the active tab or screen actions (L0–L2 only). The frame resets it on every screen change; a screen fills it through
// ctx.head.set({...}). A screen that never calls set() shows its title only.
import { h, clear } from "./dom.js";
import { createTabs } from "./tabs.js";

/** createWorkHead(root) -> {reset(title), set({title, sub, tabs, selected, onTab, idPrefix, controls, label, end}), setLock(node), tabs(), title()} */
export function createWorkHead(root) {
  clear(root);
  root.classList.add("lx-head");
  const titleEl = h("h1", { class: "lx-head-t", id: "work-title" });
  const mid = h("div", { class: "lx-head-mid" });
  const end = h("div", { class: "lx-head-end" });
  const lock = h("span", { class: "lx-head-lock", hidden: true });
  root.append(titleEl, mid, lock, end);
  let tabs = null;
  let tabIds = "";
  const api = {
    reset(title) {
      titleEl.textContent = title || "";
      clear(mid);
      clear(end);
      tabs = null;
      tabIds = "";
    },
    /** Partial updates keep what is not given; `tabs` with the same ids updates marks / selection in place (focus survives). */
    set({ title, sub, tabs: list, selected, onTab, idPrefix = "tab-", controls, label = "Sections", end: endNodes } = {}) {
      if (title !== undefined) titleEl.textContent = title;
      if (list !== undefined) {
        const ids = (list || []).map((t) => t.id + ":" + t.label).join("|");
        if (!list || !list.length) {
          if (tabs) clear(mid);
          tabs = null;
          tabIds = "";
        } else if (tabs && ids === tabIds) tabs.update({ tabs: list, selected });
        else {
          tabs = createTabs({ tabs: list, selected, label, idPrefix, controls, onSelect: onTab });
          tabIds = ids;
          clear(mid).append(tabs.el);
        }
      } else if (tabs && selected !== undefined) tabs.update({ selected });
      if (sub !== undefined && !tabs) clear(mid).append(sub ? h("span", { class: "lx-head-sub", text: sub }) : "");
      if (endNodes !== undefined) clear(end).append(...[].concat(endNodes || []));
    },
    /** The frame's own slot: a why line said once for the whole work area (editors locked while a Read runs). `node` null hides it. */
    setLock(node) {
      if (node && !lock.contains(node)) clear(lock).append(node);
      lock.hidden = !node;
    },
    tabs: () => tabs,
    title: () => titleEl.textContent,
  };
  return api;
}
