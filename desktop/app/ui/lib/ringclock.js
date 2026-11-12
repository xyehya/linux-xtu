// ringclock.js: the live ring clock from the helper's telemetry `values.ring` (G-243 / QA-20; moved out of views/tune/ring.js in G-250 so the Tune › Cores unit table shares it).
import { isNum } from "./format.js";

/** The live ring clock from the telemetry `values.ring` ({mhz, ratio}, each a reading leaf). -> {text, ratio, mhz, note}; unavailable stays n/a with its reason. */
export function ringNow(values) {
  const r = values && values.ring;
  const ok = (x) => x && x.status !== "unavailable" && isNum(x.value);
  if (!r || (!ok(r.ratio) && !ok(r.mhz))) {
    const leaf = r && (r.mhz || r.ratio);
    return { text: "n/a", ratio: null, mhz: null, note: !values ? "no telemetry yet" : (leaf && leaf.reason) || "the helper does not report the ring clock" };
  }
  const ratio = ok(r.ratio) ? r.ratio.value : Math.round(r.mhz.value / 100);
  const mhz = ok(r.mhz) ? r.mhz.value : ratio * 100;
  return { text: ratio + "×" + " · " + Math.round(mhz) + " MHz", ratio, mhz, note: "" };
}
