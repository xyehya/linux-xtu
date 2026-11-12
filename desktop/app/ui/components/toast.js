// components/toast.js: `.lx-toast` (desktop/DESIGN.md §5.11): bottom-right of the work area, 360 px, a 2 px status edge, title + one line. ok / info go
// after their time (the store's ttl); warn / error stay until dismissed. At most three on screen (the newest). A toast is never the only place an
// error is shown — the panel or sheet that failed says it too. State lives in the store (pushToast / dismissToast); this renders it.
import { h, clear } from "./dom.js";
import { dismissToast } from "../store.js";

export const MAX_VISIBLE = 3;
const EDGE = { ok: "ok", warn: "warn", error: "fault", info: "" };

/** Split a one-string toast into a title and a body at the first sentence end within 64 characters; else all of it is the title. Pure. */
export function toastParts(t) {
  if (t.title) return { title: t.title, body: t.text || "" };
  const text = String(t.text || "");
  const m = /^(.{8,64}?[.:])\s+(.+)$/s.exec(text);
  return m ? { title: m[1].replace(/[.:]$/, ""), body: m[2] } : { title: text, body: "" };
}

export function createToaster(root, store, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  clear(root);
  root.classList.add("lx-toasts");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Notices");
  root.setAttribute("aria-live", "polite"); // the only live region for ok / warn / info: a child role=status inside it is a nested live region (G-247)
  const timers = new Map();
  const nodes = new Map();

  const unsub = store.watch(
    (s) => s.toasts,
    (toasts) => {
      const shown = toasts.slice(-MAX_VISIBLE);
      const live = new Set(shown.map((t) => t.id));
      for (const [id, el] of nodes) {
        if (!live.has(id)) {
          el.remove();
          nodes.delete(id);
        }
      }
      for (const [id, handle] of timers) {
        if (!toasts.some((t) => t.id === id)) {
          cancel(handle);
          timers.delete(id);
        }
      }
      for (const t of shown) {
        if (nodes.has(t.id)) continue;
        const { title, body } = toastParts(t);
        const el = h(
          "div",
          { class: ["lx-toast", EDGE[t.kind] ? `lx-toast--${EDGE[t.kind]}` : ""], dataset: { kind: t.kind, toast: String(t.id) }, role: t.kind === "error" ? "alert" : undefined },
          h("span", { class: "lx-toast-t", text: title }),
          h("button", { type: "button", class: "lx-btn lx-btn--l0", "aria-label": "Dismiss", text: "✕", on: { click: () => dismissToast(store, t.id) } }),
          body ? h("span", { class: "lx-toast-b", text: body }) : null,
        );
        nodes.set(t.id, el);
        root.append(el);
        const stays = t.kind === "warn" || t.kind === "error";
        if (!stays && t.ttlMs > 0 && !timers.has(t.id)) timers.set(t.id, schedule(() => dismissToast(store, t.id), t.ttlMs));
      }
    },
  );
  return () => {
    unsub();
    for (const handle of timers.values()) cancel(handle);
    timers.clear();
  };
}
