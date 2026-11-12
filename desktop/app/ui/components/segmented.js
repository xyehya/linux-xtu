// components/segmented.js: `.lx-seg` (desktop/DESIGN.md §5.3) — one joined control for every 2–5-way choice. Selected = aria-pressed; arrow keys
// move and select within; a disabled option keeps its reason in the context line (data-hint on the option). More than 5 options -> a select.
import { h } from "./dom.js";

/** createSegmented({options: [{value, label, disabled, hint}], value, label, hint, id, onChange}) -> {el, set(value), get(), setDisabled(value, on)} */
export function createSegmented({ options, value, label = "", hint, id, onChange } = {}) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 5) throw new Error("segmented: 2 to 5 options (more: use a select)");
  let cur = value;
  const el = h("span", { class: "lx-seg", role: "group", "aria-label": label, id, dataset: hint ? { hint } : {} });
  const btns = new Map();
  const paint = () => {
    for (const [v, b] of btns) {
      const on = v === String(cur);
      b.setAttribute("aria-pressed", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (![...btns.keys()].includes(String(cur))) {
      const first = [...btns.values()].find((b) => !b.disabled);
      if (first) first.tabIndex = 0;
    }
  };
  const pick = (v, focus = false) => {
    const b = btns.get(String(v));
    if (!b || b.disabled) return;
    const changed = String(cur) !== String(v);
    cur = options.find((o) => String(o.value) === String(v)).value;
    paint();
    if (focus) b.focus();
    if (changed && onChange) onChange(cur);
  };
  for (const o of options) {
    const b = h("button", { type: "button", dataset: { value: String(o.value), ...(o.hint ? { hint: o.hint } : {}) }, text: o.label, on: { click: () => pick(o.value) } });
    b.disabled = !!o.disabled;
    btns.set(String(o.value), b);
    el.append(b);
  }
  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const live = options.filter((o) => !btns.get(String(o.value)).disabled);
    if (!live.length) return;
    const i = live.findIndex((o) => String(o.value) === String(cur));
    const j = e.key === "Home" ? 0 : e.key === "End" ? live.length - 1 : (Math.max(0, i) + (e.key === "ArrowRight" ? 1 : -1) + live.length) % live.length;
    e.preventDefault();
    pick(live[j].value, true);
  });
  paint();
  return {
    el,
    set(v) {
      cur = v;
      paint();
    },
    get: () => cur,
    setDisabled(v, on) {
      const b = btns.get(String(v));
      if (b) b.disabled = !!on;
      paint();
    },
  };
}
