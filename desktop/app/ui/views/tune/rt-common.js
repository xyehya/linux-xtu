// views/tune/rt-common.js: the pieces the runtime tabs share. Nothing here writes anything: Review only opens the commit sheet, which plans first (no hardware)
// and applies on its own button.
//   R-S2 (new design, DESIGN.md §9.3–§9.5): restoreButton(store, kind) (the L2 "Restore boot values…" + its why line), restoreGate(st, kind),
//   rtLock(st, key) (why the runtime fields cannot be edited now), whyOf(refusal) (a lib refusal -> a WHY {key, vars}), RESTORE_LABEL. Their CSS is styles/tune-rt.css.
// Runtime settings are written through the root helper to sysfs / powercap; a reboot restores the firmware / kernel values.
import { h } from "../../components/dom.js";
import { revertReason } from "../../lib/rtstate.js";
import { reviewGate, editLock } from "../../store.js";
import { button } from "../../components/buttons.js";
import { why, setWhy } from "../../components/help.js";
import { WHY } from "../../lib/hints.js";
import { requestReview, revertRequest } from "./runtime-kinds.js";

// ---- R-S2 ---------------------------------------------------------------------------------------------------------------------------------
/** The label of the restore button of a kind: "runtime" puts back caps AND uncore together (one journal, U-24), so it says so. */
export const RESTORE_LABEL = { power: "Restore boot values…", runtime: "Restore boot caps and uncore…" };
const RESTORE_WHAT = { power: "power limit", runtime: "ratio cap or ring range" };

/** A refusal of lib/draft.js / lib/limits.js ({reason, values}) as a WHY {key, vars}; a reason without a WHY template is said through locked.unavailable. */
export function whyOf(r) {
  if (!r || r.ok) return null;
  return WHY[r.reason] ? { key: r.reason, vars: r.values || {} } : { key: "locked.unavailable", vars: { reason: String(r.reason || "refused") } };
}

/** Why "Restore boot values" of `kind` ("power" | "runtime") cannot start now ({key, vars} of WHY) or null. The frame's review gate first. */
export function restoreGate(st, kind) {
  const g = reviewGate(st);
  if (g) return g;
  const rt = st.rt;
  if (!rt) return { key: "locked.reading", vars: {} };
  const r = rt[kind];
  if (r.state === "reading" && !r.result) return { key: "locked.reading", vars: {} };
  if (!r.result) return null; // unread or unreadable: the plan answers (NO_JOURNAL), nothing is written by asking
  return revertReason(rt, kind) ? { key: "locked.nothing_to_restore", vars: { what: RESTORE_WHAT[kind] } } : null;
}

/** The L2 restore button of a kind with its why line; update() repaints both from the store. */
export function restoreButton(store, kind) {
  const btn = button({ level: 2, label: RESTORE_LABEL[kind], hint: kind === "power" ? "rt.restore_power" : "rt.restore_runtime", onClick: () => requestReview(store, [revertRequest(kind)]) });
  btn.dataset.restore = kind;
  const whyEl = why(null, {}, { inline: true });
  btn.setAttribute("aria-describedby", whyEl.id);
  const el = h("span", { class: "lx-rt-restore" }, btn, whyEl);
  const update = () => {
    const g = restoreGate(store.get(), kind);
    btn.disabled = !!g;
    setWhy(whyEl, g ? g.key : null, g ? g.vars : {});
  };
  return { el, btn, whyEl, update };
}

/**
 * Why the fields of a runtime read ("power" | "runtime") cannot take an edit now: {state: "reading" | "disabled", key, vars} or null.
 * A tune Read in flight locks every editor (U-08); the tab's own read in flight shows "reading"; a failed read says why once.
 */
export function rtLock(st, key) {
  const l = editLock(st);
  if (l) return { state: "reading", ...l };
  const r = st.rt ? st.rt[key] : null;
  if (!r || (r.state === "reading" && !r.result) || (r.state === "idle" && !r.result)) return { state: "reading", key: "locked.reading", vars: {} };
  if (!r.result) return { state: "disabled", key: "locked.unavailable", vars: { reason: "the read failed: " + String(r.error || "no answer") } };
  return null;
}
