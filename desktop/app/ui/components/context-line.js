// components/context-line.js: the one-line hint strip at the foot of the work area (desktop/DESIGN.md §6.2). Every control with a hint carries
// data-hint="<key of HINTS>"; the line shows the focused control's label (+ expert term) and line, else the hovered one's, else the screen's idle line
// (SCREEN, data-idle). A control with no room for its why line (top bar, readout) carries a reason (help.js markReason): the line shows that instead.
// Right end: "F1 Tips" (opens Tips at the hint's section) and the Hints on / Quiet control (a persisted preference). Text swaps without animation.
import { h, clear } from "./dom.js";
import { HINTS, SCREEN } from "../lib/hints.js";
import { button } from "./buttons.js";
import { createSegmented } from "./segmented.js";
import { reasonOf, setText as setElText } from "./help.js";
import { setPref } from "../store.js";

const SEL = "[data-hint], [data-reason], [data-reason-key]";

/** What the line says for a target element (or null = idle): {label, term, line, lead, kind, tip}. Pure over the element's data-* (unit-tested). */
export function describe(el) {
  if (!el) return null;
  const key = el.dataset.hint;
  const hint = key ? HINTS[key] : null;
  const reason = reasonOf(el);
  const label = hint ? hint.label : el.getAttribute("aria-label") || el.textContent.trim().slice(0, 32);
  const term = el.dataset.hintTerm ?? (hint ? hint.term : "") ?? "";
  if (reason) return { label, term, line: reason.text, lead: reason.lead, kind: reason.kind, tip: hint ? hint.tip || null : null, key };
  if (!hint) return null;
  return { label, term, line: hint.line, lead: "", kind: "", tip: hint.tip || null, key };
}

/**
 * createContextLine(root, store, {scope, screenKey() -> SCREEN key, screenLabel() -> text, onTips(sectionId|null)}) -> {current() -> description|null, refresh(), dispose()}
 * `scope` is the element whose controls are watched (the whole app frame).
 */
export function createContextLine(root, store, { scope, screenKey, screenLabel, onTips }) {
  clear(root);
  root.classList.add("lx-ctx");
  root.setAttribute("aria-live", "off"); // §11: it would chatter
  const k = h("span", { class: "lx-ctx-k", dataset: { part: "label" } });
  const t = h("span", { class: "lx-ctx-t", dataset: { part: "line" } });
  const tips = button({ level: 0, label: "Tips", id: "ctx-tips", hint: "ui.tips", onClick: () => onTips(current() ? current().tip : null) });
  tips.prepend(h("kbd", { text: "F1" }));
  const seg = createSegmented({ options: [{ value: "on", label: "Hints on" }, { value: "quiet", label: "Quiet" }], value: store.get().prefs.hints, label: "Hints", hint: "ui.hints", id: "hints-mode", onChange: (v) => setPref(store, "hints", v) });
  root.append(k, t, h("span", { class: "lx-ctx-end" }, tips, seg.el));

  let focused = null;
  let hovered = null;
  const target = (node) => (node && node.closest ? node.closest(SEL) : null);
  const current = () => describe(focused && focused.isConnected ? focused : hovered && hovered.isConnected ? hovered : null);

  // G-247: paint() runs on every hover, focus and link change. It rewrites the strip's text IN PLACE (three stable text nodes; the term span and the
  // lead <b> come and go only when they appear or disappear) and writes nothing when the text is unchanged: no accessible object is replaced.
  const kText = document.createTextNode("");
  const tGap = document.createTextNode("");
  const tLine = document.createTextNode("");
  k.append(kText);
  t.append(tLine);
  let term = null;
  let lead = null;
  const setData = (node, s) => {
    if (node.data !== s) node.data = s;
  };
  const paint = () => {
    const d = current();
    if (!d) {
      if (root.dataset.idle !== "true") root.dataset.idle = "true";
      if (root.getAttribute("data-hint-shown") !== null) root.removeAttribute("data-hint-shown");
    } else {
      if (root.getAttribute("data-idle") !== null) root.removeAttribute("data-idle");
      const shown = d.key || "";
      if (root.dataset.hintShown !== shown) root.dataset.hintShown = shown;
    }
    setData(kText, d ? d.label : String(screenLabel()));
    if (d && d.term) {
      if (!term) k.append((term = h("span", { class: "lx-term" })));
      setElText(term, d.term);
    } else if (term) {
      term.remove();
      term = null;
    }
    if (d && d.lead) {
      if (!lead) {
        lead = h("b", { class: "lx-ctx-lead" });
        t.prepend(lead, tGap);
      }
      setElText(lead, d.lead);
      if (lead.dataset.kind !== d.kind) lead.dataset.kind = d.kind;
      setData(tGap, " ");
    } else if (lead) {
      lead.remove();
      tGap.remove();
      lead = null;
    }
    setData(tLine, d ? d.line : SCREEN[screenKey()] || "");
  };
  const onFocusIn = (e) => {
    focused = target(e.target);
    paint();
  };
  const onFocusOut = (e) => {
    if (!scope.contains(e.relatedTarget)) focused = null;
    else focused = target(e.relatedTarget);
    paint();
  };
  const onOver = (e) => {
    const next = target(e.target);
    if (next === hovered) return;
    hovered = next;
    if (!focused) paint();
  };
  const onLeave = () => {
    hovered = null;
    if (!focused) paint();
  };
  scope.addEventListener("focusin", onFocusIn);
  scope.addEventListener("focusout", onFocusOut);
  scope.addEventListener("pointerover", onOver);
  scope.addEventListener("pointerleave", onLeave);
  const unsub = store.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) seg.set(s.prefs.hints);
    if (s.screen !== prev.screen || s.tune !== prev.tune || s.link !== prev.link) paint();
  });
  paint();
  return {
    current,
    refresh: paint,
    dispose() {
      unsub();
      scope.removeEventListener("focusin", onFocusIn);
      scope.removeEventListener("focusout", onFocusOut);
      scope.removeEventListener("pointerover", onOver);
      scope.removeEventListener("pointerleave", onLeave);
    },
  };
}
