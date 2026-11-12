// components/popover.js: `.lx-pop` (desktop/DESIGN.md §5.11). Anchored to its trigger: 4 px below and aligned to its left edge, or above / right-aligned
// where the trigger sits at the foot or the right end of the window (the readout bar's LIMITS), so it never clips at 960x600. Fixed position from the
// trigger's box through CSS custom properties (CSSOM, CSP-safe). Escape / a click outside closes; focus goes to the first control on open and back to the
// trigger on close (F-10, F-11). The content is the caller's: build it once and update text in place, never rebuild focused controls.
import { h, setVar, focusables } from "./dom.js";
import { pushLayer } from "./layers.js";

const GAP = 4;
const EDGE = 8;

/** The height available to a popover on one side of its trigger (viewport px). Pure. */
export function popoverRoom(anchor, viewport, place) {
  return Math.max(0, Math.floor(place === "above" ? anchor.top - GAP - EDGE : viewport.height - EDGE - (anchor.bottom + GAP)));
}

/**
 * Where the popover goes: {x, y, place} in viewport px for a trigger box and the popover's own (natural) size. Pure (unit-tested). G-249 (R2-08): a popover that fits on neither
 * side goes where there is more room (the caller then limits its height to `popoverRoom` and it scrolls), so its last line is never cut off by the window edge or the bars.
 */
export function placePopover(anchor, size, viewport, { align = "left", place = "below" } = {}) {
  let x = align === "right" ? anchor.right - size.width : anchor.left;
  x = Math.max(EDGE, Math.min(x, viewport.width - size.width - EDGE));
  let where = place;
  if (where === "below" && anchor.bottom + GAP + size.height > viewport.height - EDGE && anchor.top - GAP - size.height >= EDGE) where = "above";
  if (where === "above" && anchor.top - GAP - size.height < EDGE && anchor.bottom + GAP + size.height <= viewport.height - EDGE) where = "below";
  if (size.height > popoverRoom(anchor, viewport, where) && popoverRoom(anchor, viewport, where === "above" ? "below" : "above") > popoverRoom(anchor, viewport, where)) where = where === "above" ? "below" : "above";
  const y = where === "above" ? Math.max(EDGE, anchor.top - GAP - size.height) : anchor.bottom + GAP;
  return { x: Math.round(x), y: Math.round(y), place: where };
}

/**
 * createPopover({label, id, host}) -> {el, open(trigger, {align, place}), close({focus}), toggle(trigger, opts), isOpen(), trigger(), dispose()}.
 * `onOpen` / `onClose` callbacks run after the change. The element is appended to `host` (default document.body) once.
 */
export function createPopover({ label, id, host = null, onOpen = null, onClose = null, doc = globalThis.document } = {}) {
  const el = h("div", { class: "lx-pop lx-pop--fixed", role: "dialog", "aria-label": label || "", id, tabindex: "-1", hidden: true });
  (host || doc.body).append(el);
  let trig = null;
  let opts = {};
  let drop = null;

  const position = () => {
    if (!trig || el.hidden) return;
    const a = trig.getBoundingClientRect();
    setVar(el, "--pop-max-h", "none"); // measure what it wants, then limit it to the room on the side it goes to (frame.css: max-height)
    const r = el.getBoundingClientRect();
    const view = doc.defaultView;
    const viewport = { width: view.innerWidth, height: view.innerHeight };
    const p = placePopover(a, { width: r.width, height: Math.max(r.height, el.scrollHeight || 0) }, viewport, opts);
    const room = popoverRoom(a, viewport, p.place);
    setVar(el, "--pop-max-h", room > 0 ? room + "px" : "none");
    setVar(el, "--pop-x", p.x + "px");
    setVar(el, "--pop-y", p.y + "px");
    el.dataset.place = p.place;
  };
  const onDown = (e) => {
    if (el.hidden) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (path.includes(el) || (trig && path.includes(trig))) return;
    api.close({ focus: false });
  };
  const onResize = () => position();

  const api = {
    el,
    open(trigger, o = {}) {
      if (!el.hidden && trig === trigger) return;
      if (!el.hidden) api.close({ focus: false });
      trig = trigger;
      opts = o;
      el.hidden = false;
      if (trig) trig.setAttribute("aria-expanded", "true");
      position();
      drop = pushLayer(() => api.close({ focus: true }), el);
      doc.addEventListener("pointerdown", onDown, true);
      doc.defaultView.addEventListener("resize", onResize);
      const first = focusables(el)[0];
      (first || el).focus({ preventScroll: true });
      el.scrollTop = 0;
      if (onOpen) onOpen(trig);
    },
    close({ focus = true } = {}) {
      if (el.hidden) return;
      const hadFocus = el.contains(doc.activeElement);
      el.hidden = true;
      if (trig) trig.setAttribute("aria-expanded", "false");
      if (drop) drop();
      drop = null;
      doc.removeEventListener("pointerdown", onDown, true);
      doc.defaultView.removeEventListener("resize", onResize);
      if (trig && (focus || hadFocus) && typeof trig.focus === "function" && trig.isConnected) trig.focus();
      const was = trig;
      trig = null;
      if (onClose) onClose(was);
    },
    toggle(trigger, o) {
      if (!el.hidden && trig === trigger) api.close();
      else api.open(trigger, o);
    },
    reposition: position,
    isOpen: () => !el.hidden,
    trigger: () => trig,
    dispose() {
      api.close({ focus: false });
      el.remove();
    },
  };
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      api.close({ focus: true });
    }
  });
  return api;
}
