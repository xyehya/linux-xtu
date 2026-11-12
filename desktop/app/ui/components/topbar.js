// components/topbar.js: the top bar (desktop/DESIGN.md §4, §8.1; UX report U-03, U-05): wordmark · HELPER / WRITES / UVP annunciators (each a button
// with its popover) · ACCEPTED (button -> Profiles) + "Restore accepted…" (L2, only while the CPU differs) · READ time + "Read" (L1 with its cost; asks
// before dropping edits; busy with the step) · MBX (mailbox requests this boot). Read is the one global read action of the app.
import { h, clear } from "./dom.js";
import { fmtClock } from "./fmt.js";
import { annunciator, setAnn } from "./ann.js";
import { button, setButton, setBusy, confirmInPlace } from "./buttons.js";
import { createPopover } from "./popover.js";
import { band, kv } from "./panel.js";
import { markReason, setText } from "./help.js";
import { HINTS, CONFIRM } from "../lib/hints.js";
import { reviewGate } from "../store.js";

/** G-248: what the UVP popover says before this boot has shown the state (only an apply learns it; a Read does not). */
export const UVP_UNKNOWN_WORD = "not known yet — the first apply tells (a Read does not)";

/** The app's name (docs/NAMING.md, D-054): the wordmark parts `linux` · `xtu` and the display name. */
export const APP_NAME = { os: "linux", tool: "xtu", full: "Linux XTU" };
/** The line that follows the name wherever it is introduced (System > About, Tips, README, `--version`). */
export const NOT_AFFILIATED = "Not affiliated with or endorsed by Intel. XTU is a trademark of Intel Corporation.";

/** The wordmark `linux‑xtu` (desktop/DESIGN.md §4): `linux` in --fg3, a 6×2 bar for the hyphen, `xtu` in --fg. `large`: the 15 px size of Setup / About. */
export function wordmark({ large = false } = {}) {
  return h("span", { class: large ? "lx-wordmark lx-wordmark--lg" : "lx-wordmark", role: "img", "aria-label": APP_NAME.full },
    h("span", { class: "lx-wm-os", text: APP_NAME.os }), h("span", { class: "lx-wm-dash", "aria-hidden": "true" }), h("span", { class: "lx-wm-tool", text: APP_NAME.tool }));
}

const LINK_LABEL = {
  connecting: "connecting",
  connected: "helper connected",
  busy: "helper busy (another client)",
  not_installed: "helper not installed",
  not_allowed: "helper refused this user",
  error: "helper unavailable",
};

export function linkLabel(link) {
  if (link.state === "error" && link.kind === "closed") return "helper disconnected"; // F-02: the link ended; the app reconnects
  return LINK_LABEL[link.state] || link.state;
}

/** HELPER pip: ok connected · warn busy (another client) · fault not reachable · off connecting (§5.6). */
export function helperPip(link) {
  if (link.state === "connected") return "ok";
  if (link.state === "busy") return "warn";
  if (link.state === "connecting") return "off";
  return "fault";
}

/** WRITES: pip ok while writes are allowed; lit READ-ONLY when preflight blocks them; dashed while preflight has not answered. */
export function writesAnn(mode, preflight) {
  if (mode.writes) return { label: "Writes", state: "idle", pip: "ok" };
  if (!preflight) return { label: "Writes", state: "unknown", pip: "off" };
  return { label: "Read-only", state: "lit-warn", pip: null };
}

/** UVP: "?" unknown (dashed) · OFF unlit · ON lit warn (it blocks undervolts). */
export function uvpAnn(uvp) {
  if (uvp === "on") return { label: "UVP on", state: "lit-warn" };
  if (uvp === "off") return { label: "UVP off", state: "idle" };
  return { label: "UVP ?", state: "unknown" };
}

/** ACCEPTED value: matches / differs · n / — (nothing to compare yet). */
export function acceptedText(a) {
  if (a.kind === "differs") return `differs · ${a.n}`;
  if (a.kind === "matches") return "matches";
  if (a.kind === "equivalent") return "matches";
  return "—";
}

/** The Read button's label and cost from the Tune read state: {label, cost, busy, p}. The cost is the request count of the last read, when known. */
export function readButtonModel(read) {
  const r = read || { state: "idle" };
  if (r.state === "reading") {
    const label = r.of ? `Reading ${r.step || 0} / ${r.of}` : "Reading…";
    return { label, cost: null, busy: true, p: r.of ? (r.step || 0) / r.of : 0 };
  }
  return { label: "Read", cost: Number.isFinite(r.ops) && r.ops > 0 ? `${r.ops} req` : null, busy: false, p: 0 };
}

/**
 * createTopBar(root, store, {read(), restore(), goto(screen), draftEdits() -> n}) -> dispose.
 * `read` runs the read; the bar asks first when `draftEdits()` > 0 ("Read drops 2 edits. [Read and drop] [Keep edits]").
 */
export function createTopBar(root, store, actions) {
  clear(root);
  root.classList.add("lx-top");
  root.setAttribute("role", "banner");
  const pop = createPopover({ label: "Status details", id: "top-pop" });
  let popFor = null; // which annunciator the popover shows

  const helper = annunciator({ label: "Helper", pip: "off", ann: "helper", hint: "ann.helper", id: "ann-helper", onClick: () => openPop("helper", helper) });
  const writes = annunciator({ label: "Writes", pip: "off", state: "unknown", ann: "writes", hint: "ann.writes", id: "ann-writes", onClick: () => openPop("writes", writes) });
  const uvp = annunciator({ label: "UVP ?", state: "unknown", ann: "uvp", hint: "ann.uvp", id: "ann-uvp", onClick: () => openPop("uvp", uvp) });

  const accVal = h("button", { type: "button", class: "lx-cluster-v lx-cluster-btn", id: "accepted-value", dataset: { hint: "state.accepted" }, on: { click: () => actions.goto("profiles") } });
  const restore = button({ level: 2, label: "Restore accepted…", id: "restore-accepted", hint: "state.restore", onClick: () => !restore.getAttribute("aria-disabled") && actions.restore() });
  const readTime = h("span", { class: "lx-cluster-v", id: "last-read" });
  const read = button({ level: 1, label: "Read", id: "read-btn", hint: "state.read", onClick: () => onRead() });
  const mbx = h("span", { class: "lx-cluster-v", id: "ops-used", dataset: { hint: "state.mbx" } });

  root.append(
    wordmark(),
    h("span", { class: "lx-top-sep", "aria-hidden": "true" }),
    h("div", { class: "lx-anns", role: "group", "aria-label": "Link and mode" }, helper, writes, uvp),
    h("span", { class: "lx-spacer" }),
    h("div", { class: "lx-cluster", id: "accepted-cluster" }, h("span", { class: "lx-cluster-k", text: "Accepted" }), accVal, restore),
    h("span", { class: "lx-top-sep", "aria-hidden": "true" }),
    h("div", { class: "lx-cluster", id: "read-cluster" }, h("span", { class: "lx-cluster-k", text: "Read" }), readTime, read),
    h("span", { class: "lx-top-sep", "aria-hidden": "true" }),
    h("div", { class: "lx-cluster" }, h("span", { class: "lx-cluster-k", text: "Mbx" }), mbx),
  );

  let confirm = null;
  function onRead() {
    if (read.getAttribute("aria-disabled") === "true" || read.getAttribute("aria-busy") === "true") return;
    const n = actions.draftEdits ? actions.draftEdits() : 0;
    if (n > 0) {
      const c = CONFIRM["read.drop"];
      confirm = confirmInPlace(read, {
        text: c.text.replace("{n}", n === 1 ? "1 edit" : `${n} edits`),
        confirmLabel: c.yes,
        keepLabel: c.no,
        label: "Confirm read",
        onConfirm: () => {
          confirm = null;
          actions.read();
        },
        onKeep: () => (confirm = null),
      });
      return;
    }
    actions.read();
  }

  // ---- popovers: built once per open, values updated in place (a focused control is never rebuilt) ----
  const POP = {
    helper: () => {
      const s = store.get();
      return { title: "Helper", meta: linkLabel(s.link), rows: [["Link", linkLabel(s.link)], ["Helper", s.helperOp.state], ["Message", s.link.message || "—"], ...(s.link.fix ? [["Fix", s.link.fix, { mono: true }]] : [])], note: HINTS["ann.helper"].line };
    },
    writes: () => {
      const s = store.get();
      return { title: "Writes", meta: s.mode.writes ? "allowed" : "read-only", rows: [["Mode", s.mode.label], ["Why", s.mode.writes ? "every preflight check passed" : s.mode.reason || "—"]], note: HINTS["ann.writes"].line, link: ["System › Preflight", "system"] };
    },
    uvp: () => {
      const s = store.get();
      const word = s.uvp === "on" ? "on: the CPU refuses negative offsets" : s.uvp === "off" ? "off" : UVP_UNKNOWN_WORD;
      return { title: "Undervolt Protection", meta: "UVP", rows: [["State", word]], note: (HINTS["ann.uvp"].more || []).join(" ") || HINTS["ann.uvp"].line };
    },
  };
  let popRows = null;
  function openPop(which, trigger) {
    if (pop.isOpen() && popFor === which) return pop.close();
    popFor = which;
    const m = POP[which]();
    const b = band({ title: m.title, meta: m.meta });
    popRows = kv(m.rows);
    const note = h("div", { class: "lx-tfoot-note" }, m.note, m.link ? h("span", {}, " ", h("button", { type: "button", class: "lx-link", text: m.link[0], on: { click: () => { pop.close({ focus: false }); actions.goto(m.link[1]); } } })) : null);
    clear(pop.el).append(b.el, h("div", { class: "lx-panel-b" }, popRows), note);
    pop.el.dataset.pop = which;
    pop.open(trigger, { align: "left", place: "below" });
  }
  function refreshPop() {
    if (!pop.isOpen() || !popFor || !popRows) return;
    const m = POP[popFor]();
    const dds = popRows.querySelectorAll("dd");
    m.rows.forEach((r, i) => {
      if (dds[i]) setText(dds[i], String(r[1]));
    });
  }

  const paint = () => {
    const s = store.get();
    setAnn(helper, { pip: helperPip(s.link) });
    if (helper.title !== linkLabel(s.link)) helper.title = linkLabel(s.link);
    setAnn(writes, writesAnn(s.mode, s.preflight));
    setAnn(uvp, uvpAnn(s.uvp));
    setText(accVal, acceptedText(s.accepted));
    if (accVal.dataset.accepted !== s.accepted.kind) accVal.dataset.accepted = s.accepted.kind;
    if (restore.hidden !== (s.accepted.kind !== "differs")) restore.hidden = s.accepted.kind !== "differs";
    const gate = reviewGate(s);
    if (gate) restore.setAttribute("aria-disabled", "true");
    else restore.removeAttribute("aria-disabled");
    markReason(restore, gate ? gate.key : null, gate ? gate.vars : {});
    setText(readTime, s.lastReadAt ? fmtClock(s.lastReadAt) : "—");
    const rm = readButtonModel(s.tune && s.tune.read);
    if (rm.busy) setBusy(read, rm.label, rm.p);
    else {
      setBusy(read, null);
      setButton(read, { label: rm.label, cost: rm.cost });
    }
    const off = s.link.state !== "connected";
    if (off) read.setAttribute("aria-disabled", "true");
    else read.removeAttribute("aria-disabled");
    markReason(read, off ? "locked.no_link" : null);
    setText(mbx, s.helperOp.opsBudget || s.helperOp.opsUsed ? String(s.helperOp.opsUsed) : "—");
    refreshPop();
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.link !== prev.link || s.mode !== prev.mode || s.preflight !== prev.preflight || s.uvp !== prev.uvp || s.accepted !== prev.accepted || s.lastReadAt !== prev.lastReadAt || s.helperOp !== prev.helperOp || (s.tune && prev.tune ? s.tune.read !== prev.tune.read : s.tune !== prev.tune)) paint();
  });
  paint();
  return {
    dispose() {
      unsub();
      pop.dispose();
      if (confirm) confirm.close();
    },
    readButton: read,
  };
}
