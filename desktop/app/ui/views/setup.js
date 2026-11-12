// views/setup.js: Setup screen (PLAN §7 "First run without the helper"; desktop/DESIGN.md §9.12): shown by the shell while the helper link is missing / not allowed /
// busy / untrusted. It says it once (V-23): what is missing, the exact command with Copy, and Retry (helper_connect). The helper's own message is kept, closed,
// under "What the helper said". The app never runs sudo and never installs anything: the operator pastes the command into a terminal, then presses Retry.
// R-F1b: also shown while the helper speaks another protocol (R-I1, link kind "version": connected, reads work, the shell refuses every write): what differs (app
// and helper version / protocol), the reinstall command, Retry (preflight again: the shell compares the versions on every preflight, no mailbox request) and
// Continue read-only (the work screens for this session; the top bar keeps READ-ONLY).
import { h, clear } from "../components/dom.js";
import { button, setBusy, setButton } from "../components/buttons.js";
import { panel, emptyState, kv } from "../components/panel.js";
import { NA } from "../components/fmt.js";
import { HINTS } from "../lib/hints.js";
import { FIXES } from "../bridge.js";
import { setLink, setPreflight, dismissSetup } from "../store.js";

/** Install script, run from a checkout of this repository. */
const INSTALL = "sudo bash install.sh";
const ENABLE_SOCKET = "sudo systemctl enable --now linux-xtu-helper.socket";
const USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

/** Link kinds (Rust `Kind::as_str`) the setup screen explains. Anything else not connected gets the generic panel. */
export const SETUP_KINDS = ["missing", "unavailable", "denied", "not_allowed", "busy", "untrusted"];

/** The kind of a normalized link ({state, kind, message, fix}); the bridge's state names stand in when the backend gave no kind. */
export function linkKind(link) {
  const l = link || {};
  if (SETUP_KINDS.includes(l.kind)) return l.kind;
  if (l.state === "not_installed") return "missing";
  if (l.state === "not_allowed") return "not_allowed";
  if (l.state === "busy") return "busy";
  return l.kind || "other";
}

/**
 * True when the shell should show this screen instead of the work screens: a link that is down for a reason the operator can fix, or a connected helper of another
 * protocol (kind "version") until the operator continues read-only (`dismissed`).
 */
export function needsSetup(link, { dismissed = false } = {}) {
  if (!link || link.state === "connecting") return false;
  if (link.state === "connected") return link.kind === "version" && !dismissed;
  return SETUP_KINDS.includes(linkKind(link));
}

/** needsSetup for the app state: the link and the session's "Continue read-only". */
export const showSetup = (st) => needsSetup(st.link, { dismissed: st.setupDismissed === true });

/** "0.3.0 · protocol 2" for one side of the version check ({version, protocol} | null). */
export function versionText(side) {
  if (!side) return `${NA} · not reported`;
  return `${side.version ?? NA} · protocol ${side.protocol ?? NA}`;
}

/** `sudo bash install.sh --add-user <user>`; `$USER` (expanded by the operator's own shell before sudo) unless a plain login name is given. */
export function addUserCommand(user) {
  const name = typeof user === "string" && USER_RE.test(user) ? user : "$USER";
  return `${INSTALL} --add-user ${name}`;
}

/**
 * What the screen says for a link: {kind, title, text, steps, command, note, tone}. `command` is the exact text to copy (null when there is none to run).
 * `text` is the link's own message when it has one (it already names the fix), else the named fix from the bridge.
 */
export function setupModel(link, { user } = {}) {
  const l = link || {};
  const kind = linkKind(l);
  const message = typeof l.message === "string" ? l.message : "";
  const base = { kind, text: message, steps: "", command: null, note: "The app never runs sudo or installs anything itself.", tone: "warn" };
  switch (kind) {
    case "missing":
      return {
        ...base,
        title: "The Linux XTU helper is not installed",
        text: message || "The helper is not installed or not started.",
        steps: "In a terminal, from a checkout of the linux-xtu repository, run this, then press Retry:",
        command: INSTALL,
      };
    case "unavailable":
      return {
        ...base,
        title: "The Linux XTU helper is not running",
        text: message || "Nothing is listening on the helper socket.",
        steps: "In a terminal run this, then press Retry:",
        command: ENABLE_SOCKET,
      };
    case "denied":
      return {
        ...base,
        title: "The helper socket cannot be opened",
        text: message || "Permission denied on the helper socket.",
        steps: "Just installed? Log out and back in first (the linux-xtu group applies to new logins), then press Retry. If it still fails, reinstall from a checkout of the linux-xtu repository:",
        command: INSTALL,
      };
    case "not_allowed":
      return {
        ...base,
        title: "Your user is not allowed to use the helper",
        text: message || "The helper's allowlist does not include this user.",
        steps: "From a checkout of the linux-xtu repository, add your user to the helper's allowlist, then press Retry (no re-login needed):",
        command: addUserCommand(user),
      };
    case "busy":
      return {
        ...base,
        title: "Another Linux XTU client is connected",
        text: message || FIXES.busy,
        steps: FIXES.busy,
        note: "The helper serves one client at a time. Nothing needs to be installed.",
      };
    case "version":
      return {
        ...base,
        title: "The helper and this app are from different releases",
        text: message || "Helper and app versions differ. Writes are off.",
        steps: "From a checkout of the linux-xtu repository at this app’s release, install both again, then press Retry:",
        command: typeof l.fix === "string" && l.fix ? l.fix : FIXES.version,
        versions: l.versions || null,
      };
    case "untrusted":
      return {
        ...base,
        title: "The helper socket is not trustworthy",
        text: message || "The helper socket is not owned by root.",
        steps: "This is a safety refusal, not a missing step: the app only talks to a socket that root owns and root listens on. Do not work around it; find out who created the socket.",
        note: "Retrying does not change the check.",
        tone: "error",
      };
    default:
      return {
        ...base,
        title: "The helper is not reachable",
        text: message || "The app could not connect to the helper.",
        steps: "Press Retry. If it keeps failing, the System screen lists what the helper reports.",
      };
  }
}

/**
 * Copy `text` to the clipboard: the async Clipboard API first, then a hidden textarea + execCommand (older webviews).
 * Resolves "copied" or "failed". `clipboard` / `doc` are injectable for tests.
 */
export async function copyText(text, { clipboard = globalThis.navigator?.clipboard, doc = globalThis.document } = {}) {
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return "copied";
    } catch {
      /* fall through to the selection route */
    }
  }
  if (!doc || !doc.body || typeof doc.execCommand !== "function") return "failed";
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.className = "lx-setup-offscreen";
  doc.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok ? "copied" : "failed";
}

/** The band caption per kind ("helper not installed"): what is missing, in two or three words. */
export const KIND_META = {
  missing: "helper not installed",
  unavailable: "helper not running",
  denied: "socket not readable",
  not_allowed: "user not allowed",
  busy: "helper busy",
  untrusted: "socket untrusted",
  version: "versions differ",
  other: "helper not reachable",
};
export const kindMeta = (kind) => KIND_META[kind] || KIND_META.other;

/**
 * The Setup screen (desktop/DESIGN.md §9.12, assessment V-23): says it once. One panel: a band naming what is missing, the title, the steps, the exact
 * command with Copy, Retry (0 requests), the note; the helper's own message sits in a closed "What the helper said" (it repeats the command for most kinds).
 * State lives in attributes: [data-setup-kind], [data-tone], [data-copy=copied|failed], Retry aria-busy.
 */
export function setupView() {
  let off = null;
  let alive = false;
  let outcome = ""; // what the last Retry found; survives the re-render so an unchanged failure is still visibly "tried again"
  return {
    id: "setup",
    lx: true,
    mount(root, ctx) {
      alive = true;
      const body = h("div", { class: "lx-tiles lx-setup", dataset: { setup: "screen" } });
      root.append(body);

      const retry = async (btn, status) => {
        btn.disabled = true;
        setBusy(btn, "Connecting…");
        status.textContent = "";
        try {
          const link = await ctx.bridge.connect();
          if (!alive) return;
          outcome = link.state === "connected" ? "" : `Still not connected (${new Date().toLocaleTimeString()}).`;
          setLink(ctx.store, link); // a new link object: the watcher below re-renders with the new message and `outcome`
          // the app's link watcher (app.js wireLink) runs the start-up (preflight, tune.last, telemetry.start) once for every connect, this one included
          if (link.state === "connected") ctx.toast("info", "Connected to the helper.");
          return;
        } catch (e) {
          if (alive) status.textContent = `Retry failed: ${e && e.message ? e.message : e}`;
        }
        if (alive) {
          setBusy(btn, null);
          setButton(btn, { label: "Retry" });
          btn.disabled = false;
        }
      };

      // version mismatch: the link is up; Retry asks for a preflight (the shell compares again) and the status, or connects when the link went down meanwhile
      const recheck = async (btn, status) => {
        if (ctx.store.get().link.state !== "connected") return retry(btn, status);
        btn.disabled = true;
        setBusy(btn, "Checking…");
        status.textContent = "";
        const pre = await ctx.bridge.call("preflight");
        if (!alive) return;
        if (pre.ok) setPreflight(ctx.store, pre.result);
        const link = await ctx.bridge.status();
        if (!alive) return;
        outcome = link.kind === "version" ? `Still different (${new Date().toLocaleTimeString()}).` : "";
        setLink(ctx.store, link); // a new link object: the watcher below re-renders with `outcome`; a match ends this screen (app.js)
        if (link.state === "connected" && link.kind !== "version") ctx.toast("ok", "The helper and this app now match.");
        else if (alive && !pre.ok) status.textContent = `Retry failed: ${pre.error.message}`;
      };

      const render = (link) => {
        clear(body);
        if (link && link.state === "connected" && link.kind !== "version") {
          const p = panel({ title: "Setup", meta: "connected", body: emptyState({ title: "Connected to the helper", teach: HINTS["setup.after"].line }) });
          body.append(p.el);
          return;
        }
        const m = setupModel(link);
        const status = h("span", { class: "lx-setup-status", role: "status", dataset: { setup: "status" }, text: outcome });
        const version = m.kind === "version";
        const retryBtn = button({ level: 1, label: "Retry", cost: "0 req", hint: version ? "setup.recheck" : "setup.retry", attrs: { "data-setup": "retry" } });
        retryBtn.addEventListener("click", () => (version ? recheck(retryBtn, status) : retry(retryBtn, status)));
        const act = [];
        let cmd = null;
        if (m.command) {
          cmd = h("pre", { class: "lx-box lx-mono lx-setup-cmd", dataset: { setup: "command" }, "aria-label": "command to run", text: m.command });
          const copyBtn = button({ level: 2, label: "Copy command", hint: "setup.copy", attrs: { "data-setup": "copy" } });
          copyBtn.addEventListener("click", async () => {
            const r = await copyText(m.command);
            if (!alive) return;
            copyBtn.dataset.copy = r;
            status.textContent = r === "copied" ? "Copied. Paste it into a terminal." : "Could not copy: select the command and press Ctrl+C.";
          });
          act.push(copyBtn);
        }
        act.push(retryBtn);
        if (version) act.push(button({ level: 0, label: "Continue read-only", hint: "setup.continue", attrs: { "data-setup": "continue" }, onClick: () => dismissSetup(ctx.store) }));
        act.push(status);
        const said = m.text && m.text !== m.steps
          ? h("details", { class: "lx-notes lx-setup-said", dataset: { setup: "said" } }, h("summary", { text: version ? "What the app found" : "What the helper said" }), h("p", { class: "lx-mono", text: m.text }))
          : null;
        const differs = version
          ? h("div", { class: "lx-setup-versions", dataset: { setup: "versions" } }, kv([["This app", versionText(m.versions && m.versions.app), { mono: true }], ["Helper", versionText(m.versions && m.versions.helper), { mono: true }]]))
          : null;
        const block = h(
          "div",
          { class: "lx-empty lx-setup-b", dataset: { setupKind: m.kind, tone: m.tone } },
          h("span", { class: "lx-empty-t", id: "setup-title", text: m.title }),
          differs,
          m.steps ? h("p", { dataset: { setup: "steps" }, text: m.steps }) : null,
          cmd,
          h("div", { class: "lx-empty-act" }, ...act),
          h("p", { class: "lx-setup-note", text: m.note }),
          h("p", { class: "lx-teach", text: HINTS[version ? "setup.version" : "setup.after"].line }),
          said,
        );
        const p = panel({ title: "Setup", meta: kindMeta(m.kind), body: block, label: "Setup" });
        if (m.tone === "error") p.el.dataset.tone = "error";
        body.append(p.el);
      };
      off = ctx.store.watch((s) => s.link, render);
    },
    unmount() {
      alive = false;
      if (off) off();
      off = null;
    },
  };
}
