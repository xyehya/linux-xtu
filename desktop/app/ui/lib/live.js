// lib/live.js: live numbers of a unit from a telemetry `values` object (Tune › Frequency's "Clock now" column).
import { isNum } from "./format.js";

const leafNum = (l) => (l && typeof l === "object" && l.status !== "unavailable" && typeof l.value === "number" && Number.isFinite(l.value) ? l.value : null);

/** Live numbers of a unit from a telemetry `values` object: highest clock of its CPUs, hottest per-core temperature if reported, highest VID. Null = n/a. */
export function liveFace(unit, values) {
  const cores = (values && values.cores) || {};
  const pick = (f) => {
    const xs = (unit.cpus || []).map((c) => leafNum(cores[String(c)] && cores[String(c)][f])).filter(isNum);
    return xs.length ? Math.max(...xs) : null;
  };
  const temps = (values && values.temps) || {};
  const tv = (unit.cpus || []).map((c) => leafNum(temps["Core " + c] || temps["cpu" + c] || temps["CPU " + c])).filter(isNum);
  return { mhz: pick("mhz"), temp: tv.length ? Math.max(...tv) : null, vid: pick("vid") };
}
