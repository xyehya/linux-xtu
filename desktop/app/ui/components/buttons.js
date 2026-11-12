// components/buttons.js: the button ladder L0–L4 and the inline confirm (desktop/DESIGN.md §5.1). The label states the action and its cost
// ("Read  132 req", "Apply 2 writes"); risk is visible by level. Disabled is never opacity: the caller puts a why line (help.js why()) beside it.
// Busy: aria-busy + the step as the label + a progress rule fed by --p. Markup = kit.html §04.
import { h, setVar } from "./dom.js";
import { pushLayer } from "./layers.js";

export const LEVELS = [0, 1, 2, 3, 4];

/**
 * button({level, label, cost, id, hint, title, disabled, onClick, cls, attrs}) -> <button class="lx-btn lx-btn--lN">label<span class="lx-cost">cost</span></button>
 * level 2 (local: plan, file, copy) is the default look; 4 (write) belongs to the commit sheet only.
 */
export function button({ level = 2, label = "", cost = null, id, hint, title, disabled = false, onClick, cls, attrs = {} } = {}) {
  if (!LEVELS.includes(level)) throw new Error(`button: level ${level} is not one of L0–L4`);
  const t = h("span", { class: "lx-btn-t", text: label });
  const c = h("span", { class: "lx-cost", text: cost ?? "", hidden: cost === null || cost === "" });
  const b = h(
    "button",
    { type: "button", class: ["lx-btn", level === 2 ? "" : `lx-btn--l${level}`, cls], id, title, dataset: { level: String(level), ...(hint ? { hint } : {}) }, ...attrs, on: onClick ? { click: onClick } : undefined },
    t,
    c,
  );
  b.disabled = !!disabled;
  return b;
}

/** Change label and/or cost in place (the element and its focus survive). */
export function setButton(btn, { label, cost } = {}) {
  const [t, c] = btn.children;
  if (label !== undefined && t) t.textContent = label;
  if (cost !== undefined && c) {
    c.textContent = cost ?? "";
    c.hidden = cost === null || cost === "";
  }
  return btn;
}

/** Busy with a step label and a progress fraction 0..1 (null label = not busy). */
export function setBusy(btn, label, p = 0) {
  if (label === null || label === undefined) {
    btn.removeAttribute("aria-busy");
    setVar(btn, "--p", 0);
    return btn;
  }
  btn.setAttribute("aria-busy", "true");
  setVar(btn, "--p", Math.max(0, Math.min(1, Number(p) || 0)));
  return setButton(btn, { label });
}

/**
 * Inline confirm for a destructive local action, replacing `control` in place (§5.1): "Read drops 2 edits. [Read and drop] [Keep edits]".
 * Esc or Keep = keep. Focus starts on Keep (the safe answer). Returns {el, close()}; `onConfirm` / `onKeep` run after the control is back.
 */
export function confirmInPlace(control, { text, confirmLabel, keepLabel = "Keep", onConfirm, onKeep, label = "Confirm" }) {
  let done = false;
  const finish = (fn, focusControl) => {
    if (done) return;
    done = true;
    drop();
    el.remove();
    control.hidden = false;
    if (focusControl && control.isConnected) control.focus();
    if (fn) fn();
  };
  const yes = button({ level: 2, label: confirmLabel, attrs: { "data-confirm": "yes" }, onClick: () => finish(onConfirm, true) });
  const no = button({ level: 0, label: keepLabel, attrs: { "data-confirm": "keep" }, onClick: () => finish(onKeep, true) });
  const el = h("span", { class: "lx-confirm", role: "group", "aria-label": label, dataset: { confirm: "open" } }, h("span", { class: "lx-confirm-t", text }), yes, no);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(onKeep, true);
    }
  });
  const drop = pushLayer(() => finish(onKeep, true), el);
  control.hidden = true;
  control.after(el);
  no.focus();
  return { el, close: () => finish(onKeep, false), yes, no };
}
