// components/field.js: THE numeric field (desktop/DESIGN.md §5.2): right-aligned mono well, width in characters of the widest legal value, optional
// −/+ stepper, unit beside it, a why line it is described by. A typed value outside the window is REFUSED in place with the reason (WHY templates
// refused.*), the typed text kept and nothing committed — never clamped silently (D-053 §5; UX report U-11, frontend report F-12).
// Keys: ↑/↓ one step, Shift+↑/↓ and PageUp/PageDown ten steps (or `bigStep`), Enter commits, Esc restores the value it had on focus. The wheel does
// nothing. States live on `.lx-field[data-state]`: idle · set (differs from the CPU) · mixed · refused · disabled · reading.
import { h } from "./dom.js";
import { why, setWhy } from "./help.js";

export const MINUS = "−";
export const STATES = ["idle", "set", "mixed", "refused", "disabled", "reading"];

/** Display text of a number: fixed decimals, U+2212 for minus, "" for null. */
export function formatNumber(v, decimals = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  const s = Math.abs(v).toFixed(decimals);
  return (v < 0 && Number(s) !== 0 ? MINUS : "") + s;
}

/** Typed text -> number, or NaN. Accepts "-" and "−" and "+", spaces, a decimal comma. "" -> null (nothing typed). */
export function parseNumber(text) {
  const t = String(text ?? "").trim().replace(/−/g, "-").replace(/\s+/g, "").replace(",", ".");
  if (t === "") return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

/**
 * Decide what a typed text means for a field: {ok: true, value} or {ok: false, why: {key, vars}}. Pure (unit-tested).
 * `min` / `max` are the window (null = open); `source` names where the limit comes from ("0x28", "field encoding"); `allow(v)` may refuse with its own
 * WHY ({key, vars}) — e.g. refused.positive_offset; `decimals` rounds what is committed (never what is checked).
 */
export function judge(text, { min = null, max = null, unit = "", source = "", decimals = 0, allow = null } = {}) {
  const v = parseNumber(text);
  if (v === null) return { ok: false, empty: true, why: null };
  const shown = String(text).trim().replace(/-/g, MINUS);
  if (Number.isNaN(v)) return { ok: false, why: { key: "refused.not_a_number", vars: { value: String(text).trim() } } };
  if (min !== null && v < min) return { ok: false, why: { key: "refused.below_floor", vars: { value: shown, min: formatNumber(min, decimals), unit } } };
  if (max !== null && v > max) return { ok: false, why: { key: "refused.above_limit", vars: { value: shown, max: formatNumber(max, decimals), unit, source: source || "CPU limit" } } };
  const own = allow ? allow(v) : null;
  if (own) return { ok: false, why: own };
  const k = 10 ** decimals;
  return { ok: true, value: Math.round(v * k) / k };
}

/** The next value of a step from `v` by `delta`, kept inside the window (stepping stops at a bound; typing is what gets refused). */
export function stepValue(v, delta, { min = null, max = null, decimals = 0 } = {}) {
  const base = Number.isFinite(v) ? v : min !== null && min > 0 ? min : max !== null && max < 0 ? max : 0;
  let n = base + delta;
  if (min !== null) n = Math.max(min, n);
  if (max !== null) n = Math.min(max, n);
  const k = 10 ** decimals;
  return Math.round(n * k) / k;
}

/**
 * createField({label, hint, unit, width, value, min, max, source, step, bigStep, decimals, stepper, allow, warn, placeholder, id, onCommit})
 * -> {el, input, whyEl, set(value), setState(state, whyKey?, vars?), state(), value(), refused()}.
 *   label     accessible name of the input (the visible label is the caller's)
 *   hint      data-hint key (context line)
 *   width     characters of the widest legal value (lx-w4 … lx-w10)
 *   warn(v, previous) -> {key, vars} | null: a warning that does not refuse (WHY warn.*, e.g. warn.large_step)
 *   onCommit(value) — called with the accepted number; the caller updates the draft and calls set()/setState("set") from its model.
 * Place `whyEl` where the reason should read (beside, below, or in a tr.lx-why-row); the input is aria-describedby it.
 */
export function createField(opts = {}) {
  const o = { unit: "", width: 6, decimals: 0, step: 1, stepper: false, ...opts };
  const big = o.bigStep ?? o.step * 10;
  const input = h("input", {
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": o.label || "",
    id: o.id,
    placeholder: o.placeholder,
  });
  const whyEl = why(null);
  input.setAttribute("aria-describedby", whyEl.id);
  const lower = o.stepper ? h("button", { class: "lx-step", type: "button", tabindex: "-1", "aria-label": "Lower", text: MINUS }) : null;
  const raise = o.stepper ? h("button", { class: "lx-step", type: "button", tabindex: "-1", "aria-label": "Raise", text: "+" }) : null;
  const well = h("span", { class: ["lx-in", `lx-w${o.width}`] }, lower, input, raise);
  const el = h("span", { class: "lx-field", dataset: { state: "idle", ...(o.hint ? { hint: o.hint } : {}) } }, well, o.unit ? h("span", { class: "lx-field-u", text: o.unit }) : null);

  let value = Number.isFinite(o.value) ? o.value : null;
  let state = "idle";
  let refusedNow = false;
  let textOnFocus = "";
  const fmt = (v) => formatNumber(v, o.decimals);
  input.value = fmt(value);

  const showWhy = (w) => setWhy(whyEl, w ? w.key : null, w ? w.vars : {});
  const paintState = () => {
    el.dataset.state = refusedNow ? "refused" : state;
    if (refusedNow) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    const off = state === "disabled" || state === "reading";
    input.disabled = off;
    if (lower) lower.disabled = off;
    if (raise) raise.disabled = off;
  };
  const refuse = (w) => {
    refusedNow = true;
    showWhy(w);
    paintState();
  };
  const accept = (v) => {
    const prev = value;
    refusedNow = false;
    showWhy(o.warn ? o.warn(v, prev) : null);
    paintState();
    value = v;
    input.value = fmt(v);
    if (o.onCommit && v !== prev) o.onCommit(v);
  };
  const commitText = () => {
    if (state === "disabled" || state === "reading") return;
    if (input.value === fmt(value) && !refusedNow) return;
    const r = judge(input.value, o);
    if (r.empty) {
      if (state === "mixed") return; // nothing typed into a mixed field: nothing changes
      return refuse({ key: "refused.not_a_number", vars: { value: "" } });
    }
    if (!r.ok) return refuse(r.why);
    accept(r.value);
  };
  const step = (n) => {
    if (state === "disabled" || state === "reading") return;
    const from = refusedNow ? value : (parseNumber(input.value) ?? value);
    const next = stepValue(Number.isFinite(from) ? from : value, n * o.step, o);
    const r = judge(fmt(next), o);
    if (!r.ok) return refuse(r.why);
    accept(r.value);
  };

  input.addEventListener("focus", () => {
    textOnFocus = input.value;
  });
  input.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "Enter") {
      e.preventDefault();
      commitText();
    } else if (k === "Escape") {
      if (input.value !== textOnFocus || refusedNow) {
        e.preventDefault();
        e.stopPropagation();
        input.value = textOnFocus;
        refusedNow = false;
        showWhy(null);
        paintState();
      }
    } else if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const n = (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? big / o.step : 1);
      step(n);
    } else if (k === "PageUp" || k === "PageDown") {
      e.preventDefault();
      step((k === "PageUp" ? 1 : -1) * (big / o.step));
    }
  });
  input.addEventListener("change", commitText);
  // QA-19: one press on the field focuses the input. The well is wider than the input (its border, the steppers), and a stepper button would take the
  // focus itself (WebKitGTK focuses a tabindex=-1 button on press); a press anywhere in the well but on the input itself therefore focuses the input, and
  // the stepper click still fires. A press on the input is left alone: the browser places the caret.
  well.addEventListener("mousedown", (e) => {
    if (e.target === input || input.disabled || (e.button !== undefined && e.button > 0)) return;
    e.preventDefault();
    input.focus();
  });
  if (lower) lower.addEventListener("click", () => step(-1));
  if (raise) raise.addEventListener("click", () => step(1));

  return {
    el,
    input,
    whyEl,
    /** Show a value the model holds (not a commit). Clears a refusal. */
    set(v) {
      value = Number.isFinite(v) ? v : null;
      refusedNow = false;
      if (document.activeElement !== input) input.value = fmt(value);
      showWhy(null);
      paintState();
    },
    /** idle | set | mixed | disabled | reading; a why key for disabled / reading / mixed hints (WHY), or null. */
    setState(s, whyKey = null, vars = {}) {
      if (!STATES.includes(s) || s === "refused") throw new Error(`field: state "${s}"`);
      state = s;
      if (s === "mixed") {
        input.value = "";
        if (o.placeholder) input.placeholder = o.placeholder;
      }
      if (!refusedNow) showWhy(whyKey ? { key: whyKey, vars } : null);
      paintState();
    },
    state: () => (refusedNow ? "refused" : state),
    value: () => value,
    refused: () => refusedNow,
  };
}
