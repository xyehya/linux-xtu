// components/nav-rail.js: the rail (desktop/DESIGN.md §4, §8.1): text soft-keys with their digit (Alt+digit), groups separated by gaps — Overview, Tune |
// Stress, Curves | Profiles | Audit, System — and Tips pinned at the foot (F1 / Alt+8). The active key takes the panel colour and covers the rail's
// rule (aria-current="page"); no key is active while Setup replaces the screens. A cyan mark after "Tune" while edits exist.
import { h, clear } from "./dom.js";

/** The pointer rests on the element (":hover"); false where the engine (or the fake DOM) cannot tell. */
function hovered(el) {
  try { return typeof el.matches === "function" && el.matches(":hover"); } catch { return false; }
}

export const SCREENS = [
  { id: "dashboard", label: "Overview", key: "1", group: 0 },
  { id: "tune", label: "Tune", key: "2", group: 0 },
  { id: "stress", label: "Stress", key: "3", group: 1 },
  { id: "curves", label: "Curves", key: "4", group: 1 },
  { id: "profiles", label: "Profiles", key: "5", group: 2 },
  { id: "audit", label: "Audit", key: "6", group: 3 },
  { id: "system", label: "System", key: "7", group: 3 },
  { id: "tips", label: "Tips", key: "8", keyLabel: "F1", foot: true },
];

export const screenLabel = (id) => (SCREENS.find((s) => s.id === id) || { label: id }).label;

/** Screen id for a pressed Alt+digit ("1".."8"), or null. G-234: a bare digit never switches (typing a value would change screens); Alt works from a field too. */
export function screenForKey(key, { ctrl = false, alt = false, meta = false } = {}) {
  if (!alt || ctrl || meta) return null;
  const s = SCREENS.find((x) => x.key === key);
  return s ? s.id : null;
}

/**
 * QA-07: Ctrl+A (Cmd+A) outside a text field selects nothing — in a desktop app the shortcut must not tint every label and table. True when this key event
 * is a select-all aimed at something that is not an input / textarea / editable element. (Lives with the rail because the rail is mounted once, at start,
 * and owns the app-wide keyboard map; createNavRail registers it on the document.)
 */
export function isStraySelectAll(e) {
  if (!e || (e.key !== "a" && e.key !== "A") || !(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const t = e.target;
  if (t && typeof t.closest === "function" && t.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return true;
}

/** createNavRail(root, store, {onSelect(id), isSetup() -> bool}) -> dispose */
export function createNavRail(root, store, { onSelect, isSetup = () => false }) {
  clear(root);
  root.classList.add("lx-rail");
  root.setAttribute("aria-label", "Screens");
  const items = new Map();
  const key = (s) => {
    const a = h("a", { class: "lx-key", href: `#/${s.id}`, id: `nav-${s.id}`, dataset: { screen: s.id, tip: `${s.label} (${s.keyLabel || "Alt+" + s.key})` }, "aria-keyshortcuts": s.keyLabel || "Alt+" + s.key, on: { click: (e) => { e.preventDefault(); a.dataset.tipOff = "1"; onSelect(s.id); } } },
      h("span", { class: "lx-key-t", text: s.label }), h("span", { class: "lx-key-d", text: s.keyLabel || s.key }));
    // G-249 (R2-09): the tip (hover after a short delay, or keyboard focus) is gone the moment the key is pressed and stays gone until the pointer has left it / focus has moved on
    for (const ev of ["pointerleave", "mouseleave"]) a.addEventListener(ev, () => delete a.dataset.tipOff);
    // navigating moves focus into the new screen: that blur must not bring the tip back while the pointer still rests on the key (live QA 2026-11-12)
    a.addEventListener("blur", () => { if (!hovered(a)) delete a.dataset.tipOff; });
    items.set(s.id, a);
    return a;
  };
  let group = 0;
  for (const s of SCREENS.filter((x) => !x.foot)) {
    if (s.group !== group) root.append(h("div", { class: "lx-rail-gap", "aria-hidden": "true" }));
    group = s.group;
    root.append(key(s));
  }
  root.append(h("div", { class: "lx-rail-end" }, ...SCREENS.filter((x) => x.foot).map(key)));
  const tuneMark = h("span", { class: "lx-mark", "aria-label": "holds edits", dataset: { mark: "edits" }, hidden: true });
  items.get("tune").querySelector(".lx-key-t").after(tuneMark);

  const paint = () => {
    const st = store.get();
    const setup = isSetup(st);
    for (const [id, a] of items) {
      if (!setup && id === st.screen) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    tuneMark.hidden = !(st.pending && st.pending.changes > 0);
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.screen !== prev.screen || s.link !== prev.link || s.pending !== prev.pending) paint();
  });
  paint();
  const doc = root.ownerDocument;
  const onKey = (e) => {
    if (isStraySelectAll(e)) e.preventDefault();
  };
  doc.addEventListener("keydown", onKey);
  return () => {
    unsub();
    doc.removeEventListener("keydown", onKey);
  };
}
