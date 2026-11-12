// components/sparkline.js: `.lx-spark` (desktop/DESIGN.md §5.14) — 44×14, fg2 1 px, no fill, no axes; the readout bar's only chart. Gaps (n/a samples)
// break the line; a lone sample is a dot; no data draws nothing. Scaling is fmt.sparkSegments, the same as every other sparkline in the app.
import { svg } from "./dom.js";
import { sparkSegments } from "./fmt.js";

/** Path data for `values` (null = gap) in w × h. */
export function sparkD(values, w, ht, pad = 1) {
  return sparkSegments(values || [], w, ht, pad)
    .map((seg) => (seg.length === 1 ? `M${seg[0]} L${seg[0]}` : "M" + seg.join(" L")))
    .join(" ");
}

/** createSparkline({w, h, label}) -> {el, draw(values) -> d}. `label` makes it an image with a name; default is decorative. */
export function createSparkline({ w = 44, h = 14, label = "" } = {}) {
  const path = svg("path", { d: "" });
  const el = svg("svg", { class: "lx-spark", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }), focusable: "false" }, path);
  return {
    el,
    draw(values) {
      const d = sparkD(values, w, h);
      // Same data (a flat history, a paused feed): no write. A changed path is an attribute update on the same node, never a rebuild (G-247).
      if (path.getAttribute("d") !== d) path.setAttribute("d", d);
      const empty = d === "" ? "true" : "false";
      if (el.dataset.empty !== empty) el.dataset.empty = empty;
      return d;
    },
  };
}
