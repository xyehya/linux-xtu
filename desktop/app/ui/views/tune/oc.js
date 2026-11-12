// views/tune/oc.js: the OC POINT band of the Tune › Cores inspector (desktop/DESIGN.md §9.2): OC ratio and OC voltage (the adaptive target, the only mode
// offered: D-053 §6), the "?" with the facts, and the why lines in place: a ratio or target refused by lib/draft.js editOcRatio / editVt (never clamped),
// the voltage locked until an OC ratio above the factory top exists, the target the CPU lifts to the top point, a line between the top point and the OC
// ratio that has not been measured, an OC ratio above the turbo table (D-050), an OC ratio left incomplete (G-239). One band per kind section (P and E
// have separate OC ratios); the ring has none (its OC word is never written, D-045). The pure helpers are node-tested.
import { h, clear } from "../../components/dom.js";
import { why, setWhy, createQ, label } from "../../components/help.js";
import { button } from "../../components/buttons.js";
import { tag } from "../../components/ann.js";
import { isNum, TIMES } from "../../lib/format.js";
import { aggregate, sameV, ocClass, aboveTop, fusedTopOf, ocRatioWindow } from "../../lib/units.js";
import { curRatio, effRatio, effVt, curVt, ocRatioValue, editOcRatio, editVt, clearOcEdits, turboEff, ocIncomplete, completeOcRatio, ocModeOf } from "../../lib/draft.js";
import { ocPointPrediction, voltageDetail, NOT_MEASURED } from "../../lib/predict.js";
import { createPlannedField } from "./curve-editor.js";

const units = (model, ids) => ids.map((id) => model.units[id]).filter((u) => u && u.kind !== "R");

/** Point number of the OC point of a kind's table: one after its last fused point (P 9, E 7). */
export const ocPointNo = (us) => (us.length ? Math.max(...us.map((u) => u.points.length)) + 1 : null);

/** {cls: none|middle|oc|unknown|mixed, ratio (agg), text}: the OC state of a set of units, as read (eff false) or as edited. */
export function ocInfo(model, draft, ids, eff = true) {
  const us = units(model, ids);
  const cls = us.map((u) => ocClass(u, eff ? effRatio(draft, u) : curRatio(u)));
  const cls0 = cls.length && cls.every((c) => c === cls[0]) ? cls[0] : "mixed";
  const rt = ocRatioValue(model, draft, ids, eff);
  const rtxt = rt.state === "same" ? rt.value + TIMES : rt.state === "mixed" ? "mixed ratios" : "–";
  const abs = us.map((u) => aboveTop(model, u, eff ? effRatio(draft, u) : curRatio(u)));
  const ab = cls0 === "none" && abs.length && abs.every((a) => a && a.ft === abs[0].ft && a.max === abs[0].max) ? abs[0] : null;
  let text;
  if (!us.length) text = "";
  else if (ab) text = "OC ratio " + ab.max + TIMES + " (fused top " + ab.ft + TIMES + ", set at boot) · no OC point";
  else if (cls0 === "none") text = "No OC ratio configured";
  else if (cls0 === "unknown") text = "OC ratio not judged: this unit's stock ratio was not read";
  else if (cls0 === "mixed") text = "mixed: the units differ";
  else if (cls0 === "middle") text = "OC ratio " + rtxt + " (fused top " + fusedTopOf(us[0]) + TIMES + ") · on a fused point: offset only";
  else text = "OC ratio " + rtxt + " (fused top " + fusedTopOf(us[0]) + TIMES + ") · OC point " + ocPointNo(us) + " · adaptive V";
  return { cls: cls0, ratio: rt, text, boot: ab };
}

/** The OC ratio a unit shows in the OC column / field: a ratio above its stock maximum (an OC point, or one on a fused point), else null ("none"). */
export function ocShown(unit, ratio) {
  const c = ocClass(unit, ratio);
  return c === "oc" || c === "middle" ? ratio : null;
}

/** Units of `ids` with an OC ratio above the fused top, or a boot-set ratio above it. */
export function offsetUnits(model, draft, ids) {
  return units(model, ids).filter((u) => ocClass(u, effRatio(draft, u)) === "oc" || aboveTop(model, u, effRatio(draft, u)));
}

/**
 * D-050: the OC ratio never changes a turbo table, so a unit of `kind` whose (drafted) ratio is above the top bucket of the kind's table (the draft's table if edited, else the one read)
 * runs at most that bucket. -> {kind, top (highest bucket), table (the effective one), units: [{id, ratio}]} or null (no table read, or nothing above it).
 */
export function ocAboveTable(model, draft, kind) {
  const table = model && model.turbo && model.turbo[kind] ? turboEff(model, draft, kind) : null;
  if (!Array.isArray(table) || !table.length) return null;
  const top = Math.max(...table);
  const over = [];
  for (const id of model.order) {
    const u = model.units[id];
    if (!u || u.kind !== kind) continue;
    const r = effRatio(draft, u);
    if (isNum(r) && r > top) over.push({ id, ratio: r });
  }
  return over.length ? { kind, top, table, units: over } : null;
}

/**
 * G-239: the units of `ids` whose OC word says a ratio their own maximum ratio (0x1C[7:0]) does not reach, and whether the draft already carries a ratio for all of
 * them (`queued`: Apply then sends 0x1D / 0x27). -> {units: [{id, ratio (OC word), max (0x1C)}], queued} or null.
 */
export function ocIncompleteInfo(model, draft, ids) {
  const us = units(model, ids).filter(ocIncomplete);
  if (!us.length) return null;
  return { units: us.map((u) => ({ id: u.id, ratio: curRatio(u), max: u.favored })), queued: us.every((u) => draft.units[u.id] && draft.units[u.id].ratio !== undefined) };
}

/** The G-239 note as a WHY template (warn.oc_incomplete) for the first incomplete unit: what the band shows. */
export function ocIncompleteWhy(info) {
  const u = info.units[0];
  return { key: "warn.oc_incomplete", vars: { ratio: String(u.ratio), max: String(u.max) } };
}
/** The G-239 note as one sentence naming every incomplete unit (the operator's wording; kept for g239's tests and plain-text reports). */
export function ocIncompleteText(info) {
  if (info.units.length === 1) {
    const u = info.units[0];
    return "The OC word says " + u.ratio + TIMES + " but this core's maximum ratio (0x1C) is " + u.max + TIMES + ": the apply that set it stopped early.";
  }
  return "The OC word is higher than the maximum ratio (0x1C) of " + info.units.map((u) => u.id + " (" + u.ratio + TIMES + " vs " + u.max + TIMES + ")").join(", ") + ": the apply that set it stopped early.";
}

/**
 * The prediction flags of a section's OC point, as WHY templates: the target lifted to the top point (warn.target_lifted) and the line between the top point and the
 * OC ratio, measured only with the top point at offset 0 (warn.interp_not_measured). A whole-curve offset on a unit with an OC point is said by the V/F band.
 */
export function ocFlags(model, draft, ids, base) {
  const out = [];
  for (const u of units(model, ids)) {
    const p = ocPointPrediction(model, draft, u.id, base);
    if (!p) continue;
    if (p.clampedBy && isNum(p.target) && isNum(p.v)) out.push({ key: "warn.target_lifted", vars: { volts: p.target.toFixed(3), lifted: p.v.toFixed(3) }, unit: u.id });
    const ft = fusedTopOf(u);
    if (isNum(ft) && p.ratio > ft + 1 && voltageDetail(model, draft, u.id, ft + 0.5, base).notMeasured.includes(NOT_MEASURED.interpStart)) out.push({ key: NOT_MEASURED.interpStart, vars: {}, unit: u.id });
  }
  const seen = new Set();
  return out.filter((f) => !seen.has(f.key) && seen.add(f.key));
}

/** The OC POINT band of one P/E section. `onFrequency()` opens Tune › Frequency. Returns {el, update(), dispose()}. */
export function createOcBand(tc, section, { onFrequency = null } = {}) {
  const kind = section.kind;
  const ids = section.ids;
  const st = () => tc.state();
  const reading = () => st().read.state === "reading";

  const ratioAgg = (eff) => {
    const { model, draft } = st();
    return aggregate(units(model, ids).map((u) => ocShown(u, eff ? effRatio(draft, u) : curRatio(u))));
  };
  const vtAgg = (eff) => {
    const { model, draft } = st();
    return aggregate(units(model, ids).filter((u) => (eff ? ocModeOf(draft, u) : ocClass(u, curRatio(u)) === "oc")).map((u) => (eff ? effVt(draft, u) : curVt(u))), sameV);
  };
  const ft = () => {
    const us = units(st().model, ids);
    return us.length ? fusedTopOf(us[0]) : null;
  };

  const ratioField = createPlannedField({
    label: "OC ratio", hint: "oc.ratio", unit: TIMES, width: 4, decimals: 0, step: 1, bigStep: 5, placeholder: "none", dataset: { oc: "ratio" },
    show: (v) => (isNum(v) ? String(v) : ""),
    plan: (v) => {
      const cur = ratioAgg(true);
      if (cur.state === "same" && cur.value === v) return null;
      return editOcRatio(st().model, st().draft, ids, v);
    },
    commit: (draft) => tc.edit(() => draft),
    warn: (v) => (isNum(ft()) && v > ft() + 3 ? { key: "warn.unusual_oc", vars: { value: String(v), top: String(ft()) } } : null),
  });
  const vtField = createPlannedField({
    label: "OC voltage, adaptive target", hint: "oc.voltage", unit: "V", width: 6, decimals: 3, step: 0.005, bigStep: 0.025, dataset: { oc: "voltage" },
    show: (v) => (isNum(v) ? v.toFixed(3) : ""),
    plan: (v) => {
      const cur = vtAgg(true);
      if (cur.state === "same" && Math.abs(cur.value - v) < 0.0025) return null;
      return editVt(st().model, st().draft, ids, v);
    },
    commit: (draft) => tc.edit(() => draft),
  });
  const q = createQ("oc.voltage", { label: "About the OC point" });
  const range = h("span", { class: "lx-band-m" });
  const discard = button({ level: 0, label: "Discard OC edits", hint: "state.discard", attrs: { "data-discard-oc": kind }, onClick: () => tc.edit((m, d) => clearOcEdits(m, d, ids)) });
  // G-251: without an OC point the band is one line (the ratio field and what to do); the voltage field and its "?" appear once a ratio makes the OC point
  const vtLabel = label("oc.voltage");
  const noOc = h("span", { class: "lx-band-m", dataset: { part: "no-oc" }, hidden: true });
  const bandEl = h(
    "div",
    { class: ["lx-band", "lx-band--top"] },
    h("span", { class: "lx-band-t", text: "OC point" }),
    label("oc.ratio", { term: "" }),
    ratioField.el,
    noOc,
    vtLabel,
    vtField.el,
    q.button,
    h("span", { class: "lx-band-end" }, range, discard),
  );

  // why lines under the band
  const flagEls = [why(null), why(null)];
  const tableWhy = why(null);
  const tableGo = button({ level: 0, label: "Frequency ›", attrs: { "data-goto": "frequency" }, onClick: () => (onFrequency ? onFrequency() : tc.setSubtab("turbo")) });
  const tableLine = h("div", { class: "lx-tune-whyline", hidden: true }, tableWhy, tableGo);
  const incWhy = why(null);
  const incGo = button({ level: 2, label: "Complete OC ratio", attrs: { "data-complete-oc": kind }, onClick: () => tc.edit((m, d) => completeOcRatio(m, d, ids)) });
  const incQueued = tag("queued for Apply", "set");
  const incLine = h("div", { class: "lx-tune-whyline", hidden: true }, incWhy, incGo, incQueued);
  const whys = h("div", { class: "lx-tune-whys", dataset: { whys: "oc-" + kind } }, ratioField.whyEl, vtField.whyEl, ...flagEls, tableLine, incLine);
  const el = h("section", { class: "lx-tune-oc", dataset: { ocBand: kind }, "aria-label": "OC point" }, bandEl, q.more, whys);

  function update() {
    const { model, draft } = st();
    const rd = reading();
    const us = units(model, ids);
    const w = ocRatioWindow(model, ids);
    const rNow = ratioAgg(true);
    const rRead = ratioAgg(false);
    const rEdited = ids.some((id) => draft.units[id] && draft.units[id].ratio !== undefined);
    ratioField.paint({
      state: rd ? "reading" : w.min === null ? "disabled" : rNow.state === "mixed" ? "mixed" : rEdited && JSON.stringify(rNow) !== JSON.stringify(rRead) ? "set" : "idle",
      value: rNow.state === "same" ? rNow.value : null,
      placeholder: rNow.state === "mixed" ? rNow.min + "…" + rNow.max : "none",
    });
    if (!rd && w.min === null) setWhy(ratioField.whyEl, "locked.no_read");
    clear(range);
    if (w.min !== null && w.max !== null && w.max >= w.min) range.append("ratio ", h("span", { class: "lx-mono", text: w.min + "…" + w.max + TIMES }));
    // the voltage: only with an OC point on every unit of the section (D-035: a target without an OC point is not kept)
    const withOc = us.filter((u) => ocModeOf(draft, u));
    const vNow = vtAgg(true);
    const vRead = vtAgg(false);
    const vEdited = ids.some((id) => draft.units[id] && draft.units[id].vt !== undefined);
    const locked = withOc.length !== us.length || !withOc.length;
    vtField.paint({
      state: rd ? "reading" : locked ? "disabled" : vNow.state === "mixed" ? "mixed" : vEdited && JSON.stringify(vNow) !== JSON.stringify(vRead) ? "set" : "idle",
      value: locked ? null : vNow.state === "same" ? vNow.value : null,
      placeholder: locked ? "—" : vNow.state === "mixed" ? vNow.min.toFixed(3) + "…" + vNow.max.toFixed(3) : "",
    });
    for (const e of [vtLabel, vtField.el, q.button]) e.hidden = locked && !rd;
    noOc.hidden = !(locked && !rd);
    noOc.textContent = "No OC point." + (isNum(ft()) ? " Set a ratio above " + ft() + TIMES + " to add one." : "");
    discard.hidden = !ids.some((id) => draft.units[id] && (draft.units[id].ratio !== undefined || draft.units[id].vt !== undefined));
    // prediction flags
    const flags = ocFlags(model, draft, ids, tc.baseFn());
    flagEls.forEach((e, i) => setWhy(e, flags[i] ? flags[i].key : null, flags[i] ? flags[i].vars : {}));
    // D-050: the turbo table still caps an OC ratio above it
    const over = ocAboveTable(model, draft, kind);
    const mine = over ? over.units.filter((x) => ids.includes(x.id)) : [];
    tableLine.hidden = !mine.length;
    setWhy(tableWhy, mine.length ? "warn.oc_above_table" : null, mine.length ? { oc: String(Math.max(...mine.map((x) => x.ratio))), table: String(over.top) } : {});
    // G-239: an OC ratio the apply did not complete
    const inc = ocIncompleteInfo(model, draft, ids);
    incLine.hidden = !inc;
    if (inc) {
      const t = ocIncompleteWhy(inc);
      setWhy(incWhy, t.key, t.vars);
      incGo.hidden = inc.queued;
      incQueued.hidden = !inc.queued;
    } else setWhy(incWhy, null);
    whys.hidden = [ratioField.whyEl, vtField.whyEl, ...flagEls].every((e) => e.hidden) && tableLine.hidden && incLine.hidden;
  }
  // a refusal or a warning shows in the field's own why line: the block around it follows
  for (const f of [ratioField, vtField]) for (const ev of ["keydown", "change", "blur"]) f.input.addEventListener(ev, () => queueMicrotask(() => {
    if (!f.whyEl.hidden) whys.hidden = false;
  }));
  return { el, update, dispose() {}, ratioField, vtField };
}

