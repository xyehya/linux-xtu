// components/sheet.js: the commit sheet SHELL — "Review" (desktop/DESIGN.md §5.10): slides 160 ms from the right edge of the work area over the
// inspector, full body height, 720 px; the unit pane stays visible; the pending row hides while it is open. Initial focus: "Close, keep plan" (never
// Apply). Tab stays inside the sheet while focus is in it; Esc closes it (it never cancels a running write: views/tune/apply.js keeps the apply going);
// focus goes back to whatever opened it. The plan content and the footer buttons are views/tune/apply.js's (setContent), unchanged.
// Same API as the old drawer, so apply.js needs no change: {setContent(body, footer), focus(selector), body, footer, dispose}.
import { h, clear, focusables } from "./dom.js";
import { closeDrawer } from "../store.js";
import { why, setWhy, markReason } from "./help.js";

/** The element that takes focus when the sheet opens: [data-initial-focus], else apply.js's "#apply-close", else the head's Close. */
export const INITIAL_FOCUS = ["[data-initial-focus]", "#apply-close", "#drawer-close"];

/**
 * createSheet(root, store, {doc, gate}) — `gate(state) -> {key, vars} | null`: while it answers, the plan's Apply ("#apply-go") is aria-disabled, its
 * click does nothing and the reason (a WHY template) sits beside it (read-only mode, UX report U-02). The plan logic itself is apply.js's.
 */
export function createSheet(root, store, { doc = globalThis.document, gate = null } = {}) {
  clear(root);
  root.classList.add("lx-sheet");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "false");
  root.setAttribute("aria-labelledby", "drawer-title");
  const title = h("h2", { class: "lx-sheet-t", id: "drawer-title" });
  // G-242 (QA-14): no native `title` here. WebKitGTK keeps the tooltip window of a `title` on screen when the button goes away under the pointer, and that window takes the next
  // click (the first click after closing was swallowed, with a stale "Close (Esc)" left behind). The context line's hint says what Close does.
  const close = h("button", { type: "button", class: "lx-btn lx-btn--l0", id: "drawer-close", dataset: { hint: "sheet.close" }, text: "Close", on: { click: () => closeDrawer(store) } });
  const body = h("div", { class: "lx-sheet-b", id: "drawer-body" });
  const footer = h("div", { class: "lx-sheet-foot", id: "drawer-footer" });
  root.append(h("div", { class: "lx-sheet-head" }, title, h("span", { class: "lx-band-end" }, close)), body, footer);

  let opener = null;
  let wasOpen = false;
  const gateWhy = why(null, {}, { inline: true, id: "apply-gate-why" });
  const paintGate = () => {
    const g = gate ? gate(store.get()) : null;
    const go = footer.querySelector("#apply-go");
    setWhy(gateWhy, g && go ? g.key : null, g ? g.vars : {});
    if (!go) return;
    if (g) {
      go.setAttribute("aria-disabled", "true");
      go.setAttribute("aria-describedby", gateWhy.id);
      if (gateWhy.parentNode !== footer || gateWhy.nextSibling !== go) go.before(gateWhy);
    } else {
      go.removeAttribute("aria-disabled");
      if (go.getAttribute("aria-describedby") === gateWhy.id) go.removeAttribute("aria-describedby");
    }
    markReason(go, g ? g.key : null, g ? g.vars : {});
  };
  footer.addEventListener(
    "click",
    (e) => {
      const g = gate ? gate(store.get()) : null;
      if (g && e.target && e.target.closest && e.target.closest("#apply-go")) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDrawer(store);
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(root);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  const initialFocus = () => {
    for (const sel of INITIAL_FOCUS) {
      const el = root.querySelector(sel);
      if (el && !el.disabled && !el.closest("[hidden]")) {
        el.focus();
        return el;
      }
    }
    return null;
  };

  const unsub = store.watch(
    (s) => s.drawer,
    (d) => {
      title.textContent = d.title;
      if (d.open) {
        // opening: take the sheet out of `hidden`, let the browser lay it out in its parked place, then flip data-open so it slides in
        root.hidden = false;
        void root.offsetWidth;
      } else if (wasOpen) {
        // G-249 (R2-01): closing releases the work area at once. Focus leaves the sheet BEFORE it goes inert / hidden (a focused element that vanishes under the
        // pointer left WebKitGTK with a stale focus target, and the next click went to it), then `hidden` takes the sheet out of hit-testing, tooltips and
        // transitions in the same turn, with no slide-out that could still catch a pointer for 160 ms.
        const inside = root.contains(doc.activeElement) || doc.activeElement === doc.body || !doc.activeElement;
        if (inside) {
          const back = opener && opener.isConnected && !opener.closest("[hidden], [inert]") ? opener : doc.getElementById("screen");
          if (back) back.focus();
        }
        opener = null;
      }
      root.dataset.open = String(d.open);
      root.inert = !d.open;
      if (!d.open) {
        root.hidden = true;
        for (const t of root.querySelectorAll("[title]")) t.removeAttribute("title"); // a tooltip owner never outlives the open sheet
      }
      root.setAttribute("aria-hidden", String(!d.open));
      if (d.open && !wasOpen) {
        const a = doc.activeElement;
        opener = a && a !== doc.body && !root.contains(a) ? a : null;
        initialFocus();
      }
      wasOpen = d.open;
    },
  );
  const unsubGate = gate ? store.subscribe((st, prev) => (st.mode !== prev.mode || st.link !== prev.link) && paintGate()) : () => {};
  return {
    setContent(bodyNode, footerNodes = []) {
      clear(body).append(...[].concat(bodyNode || []));
      clear(footer).append(...footerNodes);
      footer.hidden = !footerNodes.length;
      const go = footer.querySelector("#apply-go"); // the one L4: the context line explains it on focus / hover
      if (go && !go.dataset.hint) go.dataset.hint = "state.apply";
      paintGate();
    },
    focus(selector) {
      const el = root.querySelector(selector);
      if (!el || el.disabled) return false;
      el.focus();
      return true;
    },
    body,
    footer,
    dispose() {
      unsub();
      unsubGate();
    },
  };
}
