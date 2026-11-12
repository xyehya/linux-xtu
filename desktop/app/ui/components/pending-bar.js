// components/pending-bar.js: the single pending row (desktop/DESIGN.md §4): one for all of Tune (V/F, OC, turbo, caps, power, uncore), shown on every
// screen while edits exist (edits survive navigation), hidden while the commit sheet is open. Cyan top rule, the count in cyan, the first edits in mono
// ("P0 pt4 48× 0→−20 mV | PL1 250→200 W"), Discard all (L0, inline confirm when > 1 edit), Review n edits… (L2, Ctrl+Enter). When Review cannot start
// (read-only, a Read in flight) the button is aria-disabled and its why line sits beside it.
import { h, clear } from "./dom.js";
import { plural } from "./fmt.js";
import { button, setButton, confirmInPlace } from "./buttons.js";
import { why, setWhy, markReason, fillWhy } from "./help.js";
import { CONFIRM } from "../lib/hints.js";
import { reviewGate } from "../store.js";

const MINUS = "−";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? (v < 0 ? MINUS + String(Math.abs(Math.round(v * 10) / 10)) : String(Math.round(v * 10) / 10)) : v === null || v === undefined ? "—" : String(v).replace(/^-/, MINUS));

export function pendingText(p) {
  return plural(p.changes, "edit");
}

/** One item -> "P0 pt4 48× 0→−20 mV" parts: [lead, from, to, unit]. Pure. */
export function itemParts(it) {
  const lead = [it.unit, it.what].filter(Boolean).join(" ");
  return { lead, from: it.from === undefined || it.from === null ? null : num(it.from), to: num(it.to), u: it.u || "" };
}

/** createPendingBar(root, store, {onDiscard(), onReview()}) -> {dispose, review()} — review() is what Ctrl+Enter calls (respects the gate). */
export function createPendingBar(root, store, { onDiscard, onReview }) {
  clear(root);
  root.classList.add("lx-pend");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Edits");
  const count = h("span", { class: "lx-pend-n", id: "pending-text" });
  const list = h("span", { class: "lx-pend-list", id: "pending-list" });
  const gateWhy = why(null, {}, { inline: true, id: "pending-why" });
  gateWhy.classList.add("lx-pend-why");
  const discard = button({ level: 0, label: "Discard all", id: "pending-discard", hint: "state.discard", onClick: () => askDiscard() });
  const review = button({ level: 2, label: "Review…", id: "pending-review", hint: "state.review", onClick: () => api.review() });
  review.setAttribute("aria-describedby", gateWhy.id);
  root.append(count, list, gateWhy, discard, review);

  let confirm = null;
  function askDiscard() {
    const n = store.get().pending.changes;
    if (n <= 1) return onDiscard();
    const c = CONFIRM["discard.all"];
    confirm = confirmInPlace(discard, { text: c.text.replace("{n}", `${n} edits`), confirmLabel: c.yes, keepLabel: c.no, label: "Confirm discard", onConfirm: () => { confirm = null; onDiscard(); }, onKeep: () => (confirm = null) });
  }

  const paint = () => {
    const s = store.get();
    const p = s.pending;
    root.hidden = p.changes <= 0 || s.drawer.open;
    if (p.changes <= 0 && confirm) confirm.close();
    count.textContent = pendingText(p);
    count.dataset.units = String(p.units);
    clear(list);
    const items = s.pendingItems || [];
    items.forEach((it, i) => {
      const x = itemParts(it);
      if (i) list.append(h("span", { class: "lx-sep", "aria-hidden": "true", text: "|" }));
      list.append(x.lead + " ", x.from !== null ? x.from : "", h("span", { class: "lx-arrow", text: "→" }), x.to + (x.u ? " " + x.u : ""));
    });
    if (items.length && p.changes > items.length) list.append(h("span", { class: "lx-sep", "aria-hidden": "true", text: "|" }), `+${p.changes - items.length} more`);
    setButton(review, { label: p.changes === 1 ? "Review 1 edit…" : `Review ${p.changes} edits…` });
    const gate = reviewGate(s);
    if (gate) review.setAttribute("aria-disabled", "true");
    else review.removeAttribute("aria-disabled");
    setWhy(gateWhy, gate ? gate.key : null, gate ? gate.vars : {});
    markReason(review, gate ? gate.key : null, gate ? gate.vars : {}); // the full sentence in the context line when the row truncates it
    if (gate) {
      const w = fillWhy(gate.key, gate.vars);
      gateWhy.title = `${w.lead} ${w.text}`;
    } else gateWhy.removeAttribute("title");
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.pending !== prev.pending || s.pendingItems !== prev.pendingItems || s.drawer.open !== prev.drawer.open || s.mode !== prev.mode || s.link !== prev.link || s.tune !== prev.tune) paint();
  });
  paint();
  const api = {
    /** Review (button or Ctrl+Enter): only with edits and an open gate. Returns whether it started. */
    review() {
      const s = store.get();
      if (s.pending.changes <= 0 || reviewGate(s)) return false;
      onReview();
      return true;
    },
    dispose() {
      unsub();
      if (confirm) confirm.close();
    },
  };
  return api;
}
