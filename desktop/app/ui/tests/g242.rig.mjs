// Shared rig of the G-242 tests (not a test file itself): the commit sheet on the fake DOM, against the mock bridge or a scripted one.
import { install } from "./fakedom.mjs";

export const doc = install();
const { default: FIX } = await import("../fixtures/fixtures.js");
const { Bridge } = await import("../bridge.js");
const { createMockTransport } = await import("../fixtures/mock-backend.js");
const { createAppStore, setLink, setPreflight } = await import("../store.js");
const { createSheet } = await import("../components/sheet.js");
const { modelFromRead } = await import("../lib/units.js");
const { emptyDraft, setPoint } = await import("../lib/draft.js");
const { ensureTune, patchTune } = await import("../views/tune.js");
export const A = await import("../views/tune/apply.js");

export const READ = FIX["tune-read"].result;

export const mount = () => {
  for (const n of [...doc.body.children]) n.remove();
  const root = doc.createElement("section");
  root.id = "drawer";
  const screen = doc.createElement("div");
  screen.id = "screen";
  doc.body.append(screen, root);
  return root;
};

const connect = (store) => {
  setLink(store, { state: "connected" });
  setPreflight(store, { writes_allowed: true, mode: "write", checks: [] });
};

/** The sheet over the mock helper, with the V/F edit `mutate` makes on the read model. */
export async function rig(mutate = (m, d) => setPoint(m, d, ["P0"], 53, -20), opts = {}) {
  const bridge = new Bridge(createMockTransport({ intervalMs: 5, stepMs: 1, applyMode: null, ...opts }), "mock");
  await bridge.connect();
  const store = createAppStore();
  connect(store);
  ensureTune(store);
  const model = modelFromRead(structuredClone(READ));
  patchTune(store, { model, draft: mutate(model, emptyDraft()) });
  const root = mount();
  const sheet = createSheet(root, store, { doc });
  const toasts = [];
  const applyDrawer = A.createApplyDrawer({ store, bridge, toast: (k, t) => toasts.push([k, t]), drawer: sheet, doc });
  return { bridge, store, root, sheet, applyDrawer, ctl: applyDrawer.controller, model, toasts };
}

export const until = async (cond, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Open the sheet the way the Review button does and wait for the plan. */
export const review = async (r) => {
  r.store.events.dispatchEvent(new CustomEvent("tune:review"));
  await until(() => ["review", "failed"].includes(r.store.get().apply.state));
};

/** A scripted helper: `tune.plan` answers `plan`; the dialog approves; any other op is an error (and is logged). */
export function fakeBridge(plan, log) {
  return {
    on() {}, off() {},
    async call(op, args) {
      log.push([op, args]);
      if (op === "tune.plan") return { ok: true, result: plan };
      if (op === "app.confirm") return { ok: true, result: { confirmed: true } };
      return { ok: false, error: { code: "UNEXPECTED", message: op } };
    },
    wait: async () => ({ ok: false, error: { code: "UNEXPECTED", message: "wait" } }),
  };
}

/** The sheet over a scripted helper; the tune kind asks for `intent`. */
export async function plainRig(plan, intent = { restore: "accepted" }) {
  const store = createAppStore();
  connect(store);
  ensureTune(store);
  const root = mount();
  const sheet = createSheet(root, store, { doc });
  const log = [];
  const kinds = { tune: { ...A.KINDS.tune, request: () => ({ intent }), afterApply: async () => {} } };
  const applyDrawer = A.createApplyDrawer({ store, bridge: fakeBridge(plan, log), toast() {}, drawer: sheet, doc, kinds });
  return { store, root, log, applyDrawer, ctl: applyDrawer.controller };
}
