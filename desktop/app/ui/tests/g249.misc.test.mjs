// node --test desktop/app/ui/tests/   (G-249 R2-06 undo wording, R2-07 boot-restore command, R2-08 popover placement, R2-09 rail tips. Fake DOM; no browser, no hardware.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { install, fire } from "./fakedom.mjs";

const doc = install();
const UI = fileURLToPath(new URL("..", import.meta.url));
const css = (f) => readFileSync(join(UI, "styles", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------- R2-06
test("R2-06: the undo lines and the partial-apply box name buttons that exist ('Restore boot values', not 'Revert')", async () => {
  const { POWER_KIND, RUNTIME_KIND } = await import("../views/tune/runtime-kinds.js");
  const { RESTORE_LABEL } = await import("../views/tune/rt-common.js");
  assert.equal(POWER_KIND.undo, "Power limits: Restore boot values (Tune › Power), or a reboot.");
  assert.ok(POWER_KIND.undo.includes(RESTORE_LABEL.power.replace("…", "")), "the words of the Power tab's button");
  assert.ok(RUNTIME_KIND.undo.includes(RESTORE_LABEL.runtime.replace("…", "")), "the words of the caps / uncore button");
  const { partialWording } = await import("../views/tune/apply.js");
  assert.ok(!/Revert/i.test(POWER_KIND.undo + RUNTIME_KIND.undo + partialWording(true).text), "no 'Revert' anywhere");
  const src = readFileSync(join(UI, "views", "tune", "apply.js"), "utf8");
  assert.ok(!/Revert to boot values/.test(src));
});

// ---------------------------------------------------------------- R2-07
test("R2-07: the boot-restore command enables AND arms; a half-done state names only what is missing", async () => {
  const P = await import("../views/profiles.js");
  const both = P.BOOT_ENABLE_CMD;
  assert.match(both, /^sudo systemctl enable linux-xtu-restore\.timer && sudo \/usr\/lib\/linux-xtu\/linux-xtu-restore arm$/);
  const line = (b) => P.bootRestoreLine({ boot_restore: b });
  assert.equal(line({ state: "disarmed", timer: "disabled", armed: "no" }).cmd, both);
  assert.equal(line({ state: "disarmed" }).cmd, both, "an older helper that sends no halves: the full command");
  const timerOnly = line({ state: "disarmed", timer: "enabled", armed: "no" });
  assert.equal(timerOnly.cmd, "sudo /usr/lib/linux-xtu/linux-xtu-restore arm");
  assert.match(timerOnly.text, /timer on, not armed/);
  const armedOnly = line({ state: "disarmed", timer: "disabled", armed: "yes" });
  assert.equal(armedOnly.cmd, "sudo systemctl enable linux-xtu-restore.timer");
  assert.match(armedOnly.text, /armed, timer off/);
  assert.equal(line({ state: "armed", timer: "enabled", armed: "yes" }).cmd, "");
});

// ---------------------------------------------------------------- R2-08
test("R2-08: a popover that fits on neither side goes where there is more room and is limited to it; one that fits above is not clipped below", async () => {
  const { placePopover, popoverRoom } = await import("../components/popover.js");
  const view = { width: 1568, height: 882 };
  // the Limits popover from the TURBO row: 390 px tall, the trigger 530..540 px down
  const turbo = { left: 40, right: 180, top: 522, bottom: 540 };
  const p = placePopover(turbo, { width: 420, height: 390 }, view);
  assert.equal(p.place, "above");
  assert.ok(p.y + 390 <= turbo.top, "its whole height sits above the trigger");
  // taller than either side: the bigger side, height limited to its room
  const tall = placePopover(turbo, { width: 420, height: 700 }, view);
  assert.equal(tall.place, "above");
  assert.equal(popoverRoom(turbo, view, "above"), 522 - 4 - 8);
  assert.ok(popoverRoom(turbo, view, "above") > popoverRoom(turbo, view, "below"));
  const low = placePopover({ left: 40, right: 100, top: 20, bottom: 40 }, { width: 420, height: 900 }, view);
  assert.equal(low.place, "below", "the trigger near the top: more room below");
  assert.equal(popoverRoom({ top: 20, bottom: 40 }, view, "below"), 882 - 8 - 44);
  const rule = css("panels.css").match(/\.lx-pop\s*\{([^}]*)\}/);
  assert.ok(rule && /max-height:\s*var\(--pop-max-h/.test(rule[1]), "the stylesheet takes the limit from --pop-max-h");
});

test("R2-08: opening a popover sets --pop-max-h from the room on its side", async () => {
  const { createPopover } = await import("../components/popover.js");
  const trig = doc.createElement("button");
  doc.body.append(trig);
  trig.getBoundingClientRect = () => ({ left: 40, right: 180, top: 522, bottom: 540, width: 140, height: 18 });
  const pop = createPopover({ label: "Limits", id: "g249-pop", doc });
  pop.el.getBoundingClientRect = () => ({ left: 0, right: 420, top: 0, bottom: 390, width: 420, height: 390 });
  try {
    doc.defaultView.innerWidth = 1568;
    doc.defaultView.innerHeight = 882;
    pop.open(trig);
    assert.equal(pop.el.dataset.place, "above");
    assert.equal(pop.el.style.getPropertyValue("--pop-max-h"), 522 - 4 - 8 + "px");
  } finally {
    pop.dispose();
  }
});

// ---------------------------------------------------------------- R2-09
test("R2-09: a rail key's tip is gone the moment the key is pressed and stays gone until the pointer leaves", async () => {
  const { createNavRail } = await import("../components/nav-rail.js");
  const { createAppStore } = await import("../store.js");
  const root = doc.createElement("nav");
  doc.body.append(root);
  const picked = [];
  const dispose = createNavRail(root, createAppStore(), { onSelect: (id) => picked.push(id) });
  try {
    const stress = root.querySelector("#nav-stress");
    assert.equal(stress.dataset.tipOff, undefined);
    fire(stress, "click");
    assert.deepEqual(picked, ["stress"]);
    assert.equal(stress.dataset.tipOff, "1", "the tip is switched off by the press");
    fire(stress, "mouseleave");
    assert.equal(stress.dataset.tipOff, undefined, "the pointer left: the next hover shows it again");
    fire(stress, "click");
    fire(stress, "blur");
    assert.equal(stress.dataset.tipOff, undefined, "focus moved on");
    // live QA 2026-11-12: navigating moves focus into the new screen while the pointer still rests on the key — that blur keeps the tip off
    fire(stress, "click");
    const realMatches = stress.matches;
    stress.matches = (sel) => sel === ":hover" || (typeof realMatches === "function" ? realMatches.call(stress, sel) : false);
    fire(stress, "blur");
    assert.equal(stress.dataset.tipOff, "1", "blur while hovered keeps the tip off");
    stress.matches = realMatches;
    fire(stress, "mouseleave");
    assert.equal(stress.dataset.tipOff, undefined);
  } finally {
    dispose();
  }
  const frame = css("frame.css");
  assert.match(frame, /\.lx-key\[data-tip\]\[data-tip-off\]:hover::after[\s\S]*?visibility:\s*hidden/, "the stylesheet hides it even while hovered");
  assert.match(frame, /\.lx-key\[data-tip\]:hover::after,[\s\S]*?0\.5s/, "shown after a hover delay of 0.5 s");
});
