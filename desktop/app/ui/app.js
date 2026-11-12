// app.js: composition root. Builds the frame of desktop/DESIGN.md §4 — top bar, rail, work area (header, body, context line), pending row, readout bar,
// toasts, commit sheet — wires the bridge to the store, routes the screens and owns the global keys (§8.2) and behaviours (UX report WP-7): Read with
// edits asks first, editors locked while a read is in flight, read-only mode gates Review, a close guard with pending edits.
// A screen is a view object {id, mount(root, ctx), unmount(), lx?}; `lx: true` = built in the new design (no legacy padding). ctx = {store, bridge,
// toast(kind, text), drawer (the commit sheet), head (the work header: set({tabs, selected, onTab, sub, end})), goto(screen, tab), openDrawer(title),
// closeDrawer()}.
import { selectBridge } from "./bridge.js";
import {
  createAppStore, SCREEN_IDS, setScreen, setLink, setPreflight, setLastRead, pushToast, openDrawer, closeDrawer, applyHelperEvent, markLinkLost,
  loadPrefs, openTipsAt, editLock, readOnly, setPref, setSettings,
} from "./store.js";
import { clear } from "./components/dom.js";
import { createNavRail, screenForKey, screenLabel } from "./components/nav-rail.js";
import { createTopBar } from "./components/topbar.js";
import { createWorkHead } from "./components/workhead.js";
import { createContextLine } from "./components/context-line.js";
import { createReadout } from "./components/readout.js";
import { createPendingBar } from "./components/pending-bar.js";
import { createToaster } from "./components/toast.js";
import { createSheet } from "./components/sheet.js";
import { closeTopLayer } from "./components/layers.js";
import { setTipsOpener, why, setWhy } from "./components/help.js";
import { setupView, needsSetup, showSetup } from "./views/setup.js";
import { createApplyDrawer } from "./views/tune/apply.js";
import { tuneView, discardDraft, requestReview, createController, patchTune, ensureTune, draftEdits, SUBTABS } from "./views/tune.js";
import { tipsView, SCREEN_TIP } from "./views/tips.js";

import { dashboardView } from "./views/dashboard.js";
import { systemView, fetchSettings, settingsModel } from "./views/system.js";
import { auditView } from "./views/audit.js";
import { curvesView } from "./views/curves.js";
import { stressView } from "./views/stress.js";
import { profilesView, reviewIntent } from "./views/profiles.js";

const VIEWS = { dashboard: dashboardView, tune: tuneView, curves: curvesView, stress: stressView, profiles: profilesView, system: systemView, audit: auditView, tips: tipsView };

/**
 * Boot: the app's saved settings (Rust settings_get) into store.settings, before the first connect, so the start-up asks telemetry for the saved refresh interval.
 * A saved Hints mode wins over the webview's localStorage copy; without settings (the mock, a plain browser) localStorage stays the source.
 */
export async function loadSettings({ store, bridge }) {
  let m;
  try {
    m = await fetchSettings(store, bridge);
  } catch (e) {
    return store.get().settings; // a broken backend: the defaults stay (the bridge already turns failures into {ok:false})
  }
  if (m.saved && m.hints) setPref(store, "hints", m.hints);
  return m;
}

/** Save each Hints change through settings_set while the backend keeps settings (desktop/DESIGN.md §6.7). Returns the unsubscribe function. */
export function persistHints({ store, bridge, toast }) {
  return store.watch((s) => s.prefs.hints, async (mode) => {
    const st = store.get().settings;
    if (!st.saved || st.hints === mode) return;
    const res = await bridge.settingsSet({ hints: mode });
    if (res.ok) setSettings(store, settingsModel(res));
    else toast("warn", `Hints ${mode === "quiet" ? "Quiet" : "on"} is not saved: ${res.error.message}`);
  });
}

/** "#/tune" -> {screen: "tune", sub: null}; "#/tips/power" -> {screen: "tips", sub: "power"}; anything else -> null. */
export function routeFromHash(hash) {
  const [id, sub] = String(hash || "").replace(/^#\/?/, "").split("/");
  return SCREEN_IDS.includes(id) ? { screen: id, sub: sub || null } : null;
}
const screenFromHash = (hash) => (routeFromHash(hash) || {}).screen || null;

/** The SCREEN key of lib/hints.js for the context line's idle text. Tune tabs map onto the design's tab names. */
const TAB_SCREEN = { cores: "tune.cores", turbo: "tune.frequency", ratios: "tune.frequency", power: "tune.power", ring: "tune.uncore" };
export function screenKey(st, setup = false) {
  if (setup) return "setup";
  if (st.screen === "dashboard") return "overview";
  if (st.screen === "tune") return TAB_SCREEN[(st.tune && st.tune.subtab) || "cores"] || "tune.cores";
  return st.screen;
}

/** Global keys (§8.2) -> an action name, or null. Pure (unit-tested). */
export function keyAction(e) {
  if (e.key === "F1" && !e.altKey && !e.ctrlKey && !e.metaKey) return "tips";
  if (e.key === "Enter" && e.ctrlKey && !e.altKey && !e.metaKey) return "review";
  if (e.key === "Escape") return "escape";
  return null;
}

/** Keys a locked editor must not take while a Read is in flight (U-08): typing is blocked by beforeinput, these by keydown. */
export const LOCKED_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Enter"];

/** Reconnect loop backoff (ms): 1, 2, 4, 8, 15 s, then every 30 s while the link is down for a reason a retry can change. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** Failures the loop does not retry: nothing changes them by itself (untrusted, root, no runtime), or each attempt is a refused connection the helper logs
 *  until the operator acts (busy, not_allowed). The Setup screen names the fix and has Retry. */
export const NO_RETRY_KINDS = ["untrusted", "root", "no_runtime", "busy", "not_allowed"];

/** After a connect: the read-only start-up reads (preflight, tune.last) and the telemetry stream. No mailbox traffic (tune.read is never automatic). */
/** Final QA 2026-11-12: a BUSY preflight (the helper's slow-op slots taken by views loading at connect) is retried after these delays (ms); the session
 *  must not stay read-only with no unit list because of a start-up race. */
export const PREFLIGHT_BUSY_RETRY_MS = [250, 750, 1500, 3000];

export async function startUp({ store, bridge, toast, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let pre = await bridge.call("preflight");
  for (const ms of PREFLIGHT_BUSY_RETRY_MS) {
    if (pre.ok || !pre.error || pre.error.code !== "BUSY") break;
    await wait(ms);
    pre = await bridge.call("preflight");
  }
  if (pre.ok) setPreflight(store, pre.result);
  else toast("error", `preflight failed: ${pre.error.message}`);
  const last = await bridge.call("tune.last");
  if (last.ok && last.result && last.result.available) {
    const r = last.result;
    setLastRead(store, new Date(r.at * 1000).toISOString(), r.result ? r.result.accepted_match ?? null : null, r.result ? r.result.accepted_note : "", r.result ? r.result.uvp : undefined);
    // the top bar's Read carries its cost: the request count of this boot's read, until a new read measures it again
    const t = ensureTune(store);
    if (r.result && Number.isFinite(r.result.ops_done) && t.read.state === "idle" && t.read.ops === null) patchTune(store, { read: { ...t.read, ops: r.result.ops_done } });
  }
  const tel = await bridge.call("telemetry.start", { interval_s: store.get().settings.refresh_s }); // the saved interval (loadSettings), else the default
  if (!tel.ok) toast("warn", `telemetry did not start: ${tel.error.message}`);
}

/**
 * F-02: the helper link's life cycle, in one place.
 *  - Each time the link comes up (boot, Setup's Retry, the reconnect loop) the start-up runs again, telemetry.start included: telemetry belongs to a
 *    connection, so a new one has none until it asks (src-tauri/tests/helper_sim.rs).
 *  - `closed` (the helper went away): the telemetry goes stale (n/a, not frozen values) and the reconnect loop starts.
 *  - The loop calls bridge.connect() (helper_connect) with backoff until the link is up or the failure is one of NO_RETRY_KINDS. It is the only automatic
 *    reconnect: calls never reconnect by themselves, so a background poll (throttle.tail every 15 s) cannot bring the link back behind the UI's back.
 * `schedule` / `cancel` are injectable for tests. Returns {start() (the loop), ready (the start-up of the current connection), reconnecting, dispose()}.
 */
export function wireLink({ store, bridge, toast, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t), delaysMs = RECONNECT_DELAYS_MS }) {
  let up = store.get().link.state === "connected";
  let everUp = up;
  let ready = null;
  let timer = null;
  let attempt = 0;
  let disposed = false;

  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    attempt = 0;
  };
  const next = () => {
    if (disposed || up || timer !== null) return;
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
    attempt += 1;
    timer = schedule(async () => {
      timer = null;
      if (disposed || up) return;
      const link = await bridge.connect();
      if (link.state !== "connected" && !NO_RETRY_KINDS.includes(link.kind)) next();
    }, delay);
  };
  const offLink = bridge.on("link", (l) => {
    setLink(store, l);
    const nowUp = l.state === "connected";
    if (nowUp && !up) {
      stop();
      if (everUp) toast("ok", "Reconnected to the helper.");
      everUp = true;
      ready = startUp({ store, bridge, toast }).catch((e) => toast("error", `startup failed: ${e && e.message ? e.message : e}`));
    }
    up = nowUp;
  });
  const offClosed = bridge.on("closed", () => {
    markLinkLost(store);
    toast("warn", "The connection to the helper was lost. Reconnecting…");
    stop();
    next();
  });
  return {
    start: () => {
      stop();
      next();
    },
    get ready() {
      return ready;
    },
    get reconnecting() {
      return timer !== null;
    },
    dispose() {
      disposed = true;
      stop();
      offLink();
      offClosed();
    },
  };
}

export async function boot(doc = document) {
  const store = createAppStore();
  loadPrefs(store);
  const bridge = await selectBridge();
  const $ = (id) => doc.getElementById(id);
  const html = doc.documentElement;

  const toast = (kind, text, ttlMs) => pushToast(store, { kind, text, ttlMs });
  // read-only mode (U-02): the sheet's Apply is gated with its reason; the helper would refuse the writes anyway
  const sheet = createSheet($("drawer"), store, { doc, gate: (st) => (readOnly(st) && st.link.state === "connected" ? { key: "locked.read_only", vars: { reason: st.mode.reason || "writes are off" } } : null) });
  const applyDrawer = createApplyDrawer({ store, bridge, toast, drawer: sheet, doc }); // G-210: the plan content of the sheet
  const head = createWorkHead($("work-head"));
  ensureTune(store);
  const tc = createController({ store, bridge, toast }); // the global Read (top bar) drives the same Tune slice the screens edit

  const goto = (id, tab) => {
    if (id === "tune" && tab && SUBTABS.some((t) => t.id === tab)) patchTune(store, { subtab: tab });
    if (!setScreen(store, id)) return;
    if (screenFromHash(doc.defaultView.location.hash) !== id) doc.defaultView.location.hash = `#/${id}`;
  };
  const openTips = (section) => {
    const st = store.get();
    const where = showSetup(st) ? "setup" : st.screen === "tune" ? `tune.${st.tune.subtab}` : st.screen;
    const id = section || SCREEN_TIP[where] || null;
    openTipsAt(store, id);
    goto("tips");
  };
  setTipsOpener(openTips);
  const ctx = { store, bridge, toast, drawer: sheet, head, goto, openDrawer: (title) => openDrawer(store, title), closeDrawer: () => closeDrawer(store) };

  createTopBar($("top"), store, {
    read: () => tc.readCpu(),
    restore: () => reviewIntent(store, { restore: "accepted" }, "Restore accepted"),
    goto,
    draftEdits: () => draftEdits(store),
  });
  createNavRail($("nav-rail"), store, { onSelect: (id) => goto(id), isSetup: (st) => showSetup(st) });
  const ctxLine = createContextLine($("ctx"), store, {
    scope: $("app"),
    screenKey: () => screenKey(store.get(), showSetup(store.get())),
    screenLabel: () => (showSetup(store.get()) ? "Setup" : store.get().screen === "tune" ? (SUBTABS.find((t) => t.id === store.get().tune.subtab) || { label: "Tune" }).label : screenLabel(store.get().screen)),
    onTips: openTips,
  });
  const pend = createPendingBar($("pending-bar"), store, {
    onDiscard: () => {
      discardDraft(store); // empties the Tune draft and the runtime edits (which re-counts the pending row)
      toast("info", "Edits discarded.");
    },
    // G-208 fires "tune:review" on store.events; the apply sheet (G-210) listens to it and opens itself.
    onReview: () => requestReview(store),
  });
  createReadout($("readout"), store, { goto });
  createToaster($("toasts"), store);

  // ---- preferences on the document: Hints on / quiet (§6.7), readout expanded ----
  store.watch((s) => s.prefs, (p) => {
    html.dataset.hints = p.hints;
    html.dataset.readout = p.readout;
  });

  // ---- screens ----
  const screenRoot = $("screen");
  let current = null;
  let shownKey = "";
  // The Setup screen (G-219) replaces the work screens while the helper link is down for a reason the operator can fix, and while the helper speaks another
  // protocol (R-I1) until the operator continues read-only.
  const render = () => {
    const st = store.get();
    const setup = showSetup(st);
    const key = setup ? "setup" : st.screen;
    if (key === shownKey && current) return;
    const hadFocus = doc.activeElement && doc.activeElement !== doc.body && ($("nav-rail").contains(doc.activeElement) || screenRoot.contains(doc.activeElement));
    shownKey = key;
    if (current) current.unmount();
    clear(screenRoot);
    screenRoot.scrollTop = 0;
    screenRoot.dataset.screen = key;
    current = setup ? setupView() : VIEWS[st.screen]();
    screenRoot.dataset.legacy = String(!current.lx); // every screen is lx now (C13); kept as a test hook
    head.reset(setup ? "Setup" : screenLabel(st.screen));
    current.mount(screenRoot, ctx);
    doc.title = `Linux XTU · ${setup ? "Setup" : screenLabel(st.screen)}`;
    ctxLine.refresh();
    if (hadFocus && key !== "tips") screenRoot.focus({ preventScroll: true }); // F-11: a screen switch does not leave focus on the rail
  };
  store.watch((s) => s.screen, render);
  store.watch((s) => s.link, render);
  store.watch((s) => s.setupDismissed, render);
  const fromHash = routeFromHash(doc.defaultView.location.hash);
  if (fromHash) {
    if (fromHash.screen === "tips" && fromHash.sub) openTipsAt(store, fromHash.sub);
    setScreen(store, fromHash.screen);
  }
  doc.defaultView.addEventListener("hashchange", () => {
    const r = routeFromHash(doc.defaultView.location.hash);
    if (!r) return;
    if (r.screen === "tips" && r.sub) openTipsAt(store, r.sub);
    setScreen(store, r.screen);
  });

  // ---- editors locked while a Read is in flight (U-08): the body carries data-lock, typing and stepping keys are refused, the why is said once ----
  const lockWhy = why(null, {}, { inline: true, id: "lock-why" });
  let lockKey = null;
  const paintLock = () => {
    const l = editLock(store.get());
    const k = l ? l.key : null;
    if (k === lockKey) return;
    lockKey = k;
    if (l) screenRoot.dataset.lock = k;
    else screenRoot.removeAttribute("data-lock");
    setWhy(lockWhy, k, l ? l.vars : {});
    head.setLock(l ? lockWhy : null);
  };
  store.subscribe(paintLock);
  paintLock();
  const guard = (e) => {
    if (!screenRoot.dataset.lock) return;
    const t = e.target;
    if (!t || typeof t.matches !== "function") return;
    const field = t.matches("input:not([type=checkbox]):not([type=radio]), textarea");
    const stepper = t.closest && t.closest(".lx-step");
    if ((e.type === "beforeinput" || e.type === "paste" || e.type === "drop") && field) e.preventDefault();
    else if (e.type === "keydown" && field && LOCKED_KEYS.includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.type === "click" && stepper) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  for (const ev of ["beforeinput", "paste", "drop", "keydown", "click"]) screenRoot.addEventListener(ev, guard, true);

  // ---- global keys (§8.2) ----
  doc.addEventListener("keydown", (e) => {
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code || ""); // Alt can change e.key on some layouts; the physical key is the digit
    const id = screenForKey(digit ? digit[1] : e.key, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    if (id) {
      e.preventDefault();
      goto(id);
      return;
    }
    const act = keyAction(e);
    if (!act || e.defaultPrevented) return;
    if (act === "tips") {
      e.preventDefault();
      const d = ctxLine.current();
      openTips(d ? d.tip : null);
    } else if (act === "review") {
      if (pend.review()) e.preventDefault();
    } else if (act === "escape") {
      if (closeTopLayer()) return e.preventDefault();
      const inField = screenRoot.contains(e.target) && typeof e.target.matches === "function" && e.target.matches("input, select, textarea");
      if (store.get().drawer.open && !inField) {
        e.preventDefault();
        closeDrawer(store);
      }
    }
  });

  // ---- close guard: a reload or a window close with pending edits asks first (edits are memory-only, U-33) ----
  doc.defaultView.addEventListener("beforeunload", (e) => {
    if (store.get().pending.changes > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---- bridge -> store ----
  for (const ev of ["heartbeat", "state", "progress", "telemetry"]) bridge.on(ev, (p) => applyHelperEvent(store, ev, p));
  // the link state, the start-up after every connect (Setup's Retry included) and the reconnect loop (F-02)
  const linkCycle = wireLink({ store, bridge, toast });
  // the saved settings first (the start-up's telemetry interval, the Hints mode), then every Hints change is saved through them
  await loadSettings({ store, bridge });
  persistHints({ store, bridge, toast });

  if (bridge.name === "mock") globalThis.__linux_xtu = { store, bridge, ctx, applyDrawer }; // test seam for visual_capture.py; never set for the real bridge

  try {
    const link = await bridge.connect();
    if (link.state === "connected") await linkCycle.ready;
    else {
      if (!needsSetup(link)) toast("warn", link.message || "The helper is not available.", 0); // Setup says it once (§5.12); a toast would repeat it
      if (!NO_RETRY_KINDS.includes(link.kind)) linkCycle.start();
    }
  } catch (e) {
    setLink(store, { state: "error", message: String(e && e.message ? e.message : e) });
    toast("error", `startup failed: ${e && e.message ? e.message : e}`);
  }
  html.dataset.ready = "1";
  return ctx;
}

// node --test imports this module for startUp / wireLink / the routing helpers; only a page with the frame (#app) boots.
if (typeof document !== "undefined" && document.getElementById("app")) boot().catch((e) => {
  // Last resort: the frame itself failed. textContent only.
  const root = document.getElementById("screen");
  if (root) root.textContent = `Linux XTU could not start: ${e && e.message ? e.message : e}`;
  console.error(e);
});
