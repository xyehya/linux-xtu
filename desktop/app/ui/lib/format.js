// format.js: number/label formatting shared by the Tune logic (G-207). Pure; no DOM. Ported from web/app.js fmtMv / MINUS / mixed text (web/app.js:1225-1233).
// Values are shown with their unit; a missing value is an en dash, never a guess.

export const MINUS = "−";
export const TIMES = "×";
export const DASH = "–";

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** Signed mV, whole when within 0.05 of a whole number (the hardware offset is a 1/1024 V raw, so reads are -19.531), else one decimal. */
export function fmtMvNum(x) {
  if (!isNum(x)) return DASH;
  const whole = Math.abs(x - Math.round(x)) < 0.05;
  const body = whole ? String(Math.abs(Math.round(x))) : Math.abs(x).toFixed(1);
  return (x > 0.0499 ? "+" : x < -0.0499 ? MINUS : "") + body;
}
export function fmtMv(x) {
  return isNum(x) ? fmtMvNum(x) + " mV" : DASH;
}
/** Volts, 3 decimals (4 when the value is not on the 1 mV grid, like an adaptive target read back from 1/1024 V). */
export function fmtV(v) {
  if (!isNum(v)) return DASH;
  return v.toFixed(Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6 ? 3 : 4) + " V";
}
export function fmtRatio(r) {
  return isNum(r) ? r + TIMES : DASH;
}

/** "mixed (min…max unit)" for an aggregate {state:"mixed", min, max}; the plain value otherwise. `fmt` formats one number (with its unit). */
export function fmtAgg(agg, fmt) {
  if (!agg || agg.state === "none") return DASH;
  if (agg.state === "same") return fmt(agg.value);
  return "mixed (" + fmt(agg.min) + "…" + fmt(agg.max) + ")";
}

export function plural(n, one, many = one + "s") {
  return n + " " + (n === 1 ? one : many);
}

// ---- local time (G-246, QA-34): the helper stores UTC ISO strings ("2026-11-12T08:53:00Z") or epoch seconds; the UI shows the machine's local time, 24 h, never a locale-dependent AM/PM.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
function toDate(x) {
  let d = null;
  if (typeof x === "string" && x) d = new Date(x);
  else if (isNum(x)) d = new Date(x < 1e12 ? x * 1000 : x);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
/** "Nov 12 10:53" in the local zone, from a UTC ISO string or epoch seconds; "" when it is not a date. */
export function fmtLocalDateTime(x) {
  const d = toDate(x);
  return d ? `${MONTHS[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}` : "";
}
/** "2026-11-12 10:53" in the local zone (the shape of a default curve / profile name); "" when it is not a date. */
export function fmtLocalStamp(x) {
  const d = toDate(x);
  return d ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` : "";
}
