// components/plot.js: the plot core (desktop/DESIGN.md §5.14) — one grammar for every chart (V/F curve, history, stress) and every Tips diagram.
// x is a real scale (ratio, MHz, seconds), never evenly spaced categories. The SVG is drawn at the container's pixel width (ResizeObserver), never
// letterboxed. Grid: horizontal rules at y ticks; tick labels mono 11 px; traces 1.5 px (measured fg, factory dashed fg3, edit cyan, channel hues only
// when several units share a plot); markers 6 px squares, diamonds for a value read from the CPU. Hover / keyboard cursor: a dashed vertical line and
// ONE readout box pinned top-left — it never follows the pointer. Everything is built with createElementNS (geometry ported from
// desktop/design/tools/svg.mjs); status colours never appear inside a plot.
import { h, svg, clear } from "./dom.js";
import { setText } from "./help.js";

export const r1 = (n) => Math.round(n * 10) / 10;

export function scale(d0, d1, r0, r1_) {
  const k = d1 === d0 ? 0 : (r1_ - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** A 1-2-5 step for about `n` intervals over `span`. */
export function niceStep(span, n = 5) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

/** Ticks covering [min, max] at a nice step, free of floating point dust. */
export function niceTicks(min, max, n = 5) {
  const step = niceStep(max - min, n);
  const out = [];
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(Number(t.toFixed(dec)));
  return out;
}

// ---------------------------------------------------------------- primitives (each returns SVG nodes)
export function gridAndAxes({ w, h: ht, m, x, y, xt = [], yt = [], xfmt = String, yfmt = String, xTitle = "", yTitle = "" }) {
  const out = [];
  for (const t of yt) {
    const py = r1(y(t));
    out.push(svg("line", { class: "lx-gridl", x1: m.l, x2: w - m.r, y1: py, y2: py }));
    out.push(svg("text", { class: "lx-tick", x: m.l - 6, y: py, dy: 3.5, "text-anchor": "end" }, yfmt(t)));
  }
  for (const t of xt) {
    const px = r1(x(t));
    out.push(svg("line", { class: "lx-axisl", x1: px, x2: px, y1: ht - m.b, y2: ht - m.b + 4 }));
    out.push(svg("text", { class: "lx-tick", x: px, y: ht - m.b + 15, "text-anchor": "middle" }, xfmt(t)));
  }
  out.push(svg("line", { class: "lx-axisl", x1: m.l, x2: w - m.r, y1: ht - m.b, y2: ht - m.b }));
  if (yTitle) out.push(svg("text", { class: "lx-axis-t", x: m.l, y: m.t - 8, "text-anchor": "start" }, yTitle));
  if (xTitle) out.push(svg("text", { class: "lx-axis-t", x: r1((m.l + w - m.r) / 2), y: ht - 3, "text-anchor": "middle" }, xTitle));
  return out;
}

const TRACE = { meas: "lx-tr--meas", base: "lx-tr--base", set: "lx-tr--set", p: "lx-tr--p", e: "lx-tr--e", r: "lx-tr--r" };
const MARK = { meas: "", base: "lx-mk--base", set: "lx-mk--set", solid: "lx-mk--solid" };

export function polyline(kind, pts, { approx = false, cls = "" } = {}) {
  return svg("polyline", { class: ["lx-tr", TRACE[kind] || "", approx ? "lx-tr--approx" : "", cls].filter(Boolean).join(" "), points: pts.map(([a, b]) => `${r1(a)},${r1(b)}`).join(" ") });
}
export function square(kind, cx, cy, s = 6) {
  return svg("rect", { class: ["lx-mk", MARK[kind] || ""].filter(Boolean).join(" "), x: r1(cx - s / 2), y: r1(cy - s / 2), width: s, height: s });
}
export function diamond(kind, cx, cy, s = 5) {
  return svg("path", { class: ["lx-mk", MARK[kind] || ""].filter(Boolean).join(" "), d: `M${r1(cx)} ${r1(cy - s)} L${r1(cx + s)} ${r1(cy)} L${r1(cx)} ${r1(cy + s)} L${r1(cx - s)} ${r1(cy)} Z` });
}
export function textAt(x, y, text, { kind = "", anchor = "start", dy = 4 } = {}) {
  return svg("text", { class: ["lx-lbl-t", kind ? `lx-lbl-t--${kind}` : ""].filter(Boolean).join(" "), x: r1(x), y: r1(y), dy, "text-anchor": anchor }, text);
}
export function leader(pts, { set = false } = {}) {
  return svg("polyline", { class: set ? "lx-lead lx-lead--set" : "lx-lead", points: pts.map(([a, b]) => `${r1(a)},${r1(b)}`).join(" ") });
}
export function refLine(x1, x2, y) {
  return svg("line", { class: "lx-ref", x1: r1(x1), x2: r1(x2), y1: r1(y), y2: r1(y) });
}
export function zoneRect(x0, x1, y0, y1) {
  return svg("rect", { class: "lx-zone", x: r1(Math.min(x0, x1)), y: r1(Math.min(y0, y1)), width: r1(Math.abs(x1 - x0)), height: r1(Math.abs(y1 - y0)) });
}

/** Rough width of a direct label (12 px sans): enough to know which labels can touch, not to typeset them. */
export const labelWidth = (text) => Math.ceil(String(text).length * 6.6) + 2;

/**
 * Collision avoidance for direct labels (QA-15). items = [{y, x0, x1}] (baseline y and the horizontal extent in px); returns the new baselines in the
 * same order. Labels whose extents overlap horizontally are kept `gap` px apart vertically: sorted top to bottom, a label that sits too close to the
 * one above is pushed down; if that runs past `hi` the stack is shifted back up (and never above `lo`). Labels that do not touch stay where they were.
 */
export function separateLabels(items, { gap = 13, lo = -Infinity, hi = Infinity } = {}) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].y - items[b].y);
  const ys = items.map((it) => it.y);
  const touches = (a, b) => items[a].x0 < items[b].x1 && items[b].x0 < items[a].x1;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    for (let j = 0; j < k; j++) {
      const o = order[j];
      if (touches(i, o) && ys[i] < ys[o] + gap) ys[i] = ys[o] + gap;
    }
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (ys[i] > hi) ys[i] = hi;
    for (let j = k + 1; j < order.length; j++) {
      const o = order[j];
      if (touches(i, o) && ys[i] > ys[o] - gap) ys[i] = ys[o] - gap;
    }
  }
  return ys.map((y) => Math.max(lo, y));
}

/**
 * G-248 (G-247 follow-up): make the children of `parent` equal to the freshly built `fresh` nodes WITHOUT replacing a node that can stay. Same position + same tag = the existing
 * node gets the attributes and text that differ (nothing is written when equal); only a missing, surplus or differently-tagged node is added / removed / swapped. WebKitGTK's
 * AT-SPI bridge keeps one accessible object per DOM node, so a chart that is redrawn every second must keep its nodes.
 */
export function reconcile(parent, fresh) {
  const old = [...parent.childNodes];
  fresh.forEach((f, i) => {
    const o = old[i];
    if (!o) parent.append(f);
    else if (o.nodeType === 3 && f.nodeType === 3) {
      if (o.data !== f.data) o.data = f.data;
    } else if (o.nodeType === 1 && f.nodeType === 1 && o.tagName === f.tagName && o.namespaceURI === f.namespaceURI) {
      const want = f.getAttributeNames();
      for (const n of o.getAttributeNames()) if (!want.includes(n)) o.removeAttribute(n);
      for (const n of want) if (o.getAttribute(n) !== f.getAttribute(n)) o.setAttribute(n, f.getAttribute(n));
      const kids = [...f.childNodes];
      if (kids.length === 1 && kids[0].nodeType === 3 && o.childNodes.length === 1 && o.firstChild.nodeType === 3) setText(o, kids[0].data);
      else reconcile(o, kids);
    } else {
      parent.insertBefore(f, o);
      o.remove();
    }
  });
  for (let i = fresh.length; i < old.length; i++) old[i].remove();
}

/** The UI scale the stylesheet applies (root font size / 16 px): 1 at the 1280x800 design, 1.25 at 2560x1440. Plots grow their height and margins by it. */
export function uiScale() {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const fs = root && typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(root).fontSize) : NaN;
  return Number.isFinite(fs) && fs > 0 ? fs / 16 : 1;
}

/** The x values the cursor can sit on: the given list, else every marker / trace x, sorted and unique. */
export function cursorStops(spec) {
  const xs = spec.cursorXs || [...(spec.markers || []).map((m) => m.x), ...(spec.traces || []).flatMap((t) => t.pts.map((p) => p[0]))];
  return [...new Set(xs.filter(Number.isFinite))].sort((a, b) => a - b);
}

/** Nearest stop to a data-space x. */
export function nearestStop(stops, xv) {
  let best = null;
  for (const s of stops) if (best === null || Math.abs(s - xv) < Math.abs(best - xv)) best = s;
  return best;
}

/**
 * createPlot({label, height, margin, x, y, readout, width}) -> {el, svg, draw(spec), setCursor(x), cursor(), dispose()}.
 *   x / y:   {min, max, ticks?, fmt?, title?}; ticks default to niceTicks.
 *   spec:    {traces: [{kind, pts: [[x, y]], approx}], markers: [{x, y, kind, shape: "sq"|"dia"}], refs: [{y, label}], zones: [{x0, x1}],
 *             labels: [{x, y, text, kind, anchor}], cursorXs: [x…]}
 *   readout(x) -> [[label, value] | text, …]: the pinned readout for the cursor x (values bold).
 * The plot redraws at the container width when it changes; `width` fixes it (tests, Tips diagrams).
 */
export function createPlot({ label = "", height = 220, margin = { l: 44, r: 14, t: 16, b: 26 }, x, y, readout = null, width = null } = {}) {
  // G-248: a plot whose live readout box names the values it shows is hidden from the accessibility tree itself (its drawn ticks, labels and lines are many accessible objects
  // for nothing the readout does not already say); the container carries the label instead. A plot without a readout stays an image with its label.
  const named = typeof readout === "function";
  const root = svg("svg", named ? { "aria-hidden": "true", tabindex: "0", focusable: "true" } : { role: "img", "aria-label": label, tabindex: "0", focusable: "true" });
  const ro = h("div", { class: "lx-plot-ro", hidden: true, "aria-live": "off" });
  const el = h("div", { class: "lx-plot", dataset: { plot: "true" } }, root, ro);
  if (named) {
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", label);
  }
  let spec = { traces: [], markers: [], refs: [], zones: [], labels: [] };
  let w = width || 600;
  let cur = null;
  let geo = null;

  const render = () => {
    const k = uiScale();
    const ht = Math.round(height * k);
    const m = k === 1 ? margin : { l: Math.round(margin.l * k), r: Math.round(margin.r * k), t: Math.round(margin.t * k), b: Math.round(margin.b * k) };
    const xs = scale(x.min, x.max, m.l, w - m.r);
    const ys = scale(y.min, y.max, ht - m.b, m.t);
    geo = { xs, ys, m, w, ht };
    setAttr(root, "viewBox", `0 0 ${w} ${ht}`);
    setAttr(root, "width", String(w));
    setAttr(root, "height", String(ht));
    const nodes = [];
    for (const z of spec.zones || []) nodes.push(zoneRect(xs(z.x0), xs(z.x1), m.t, ht - m.b));
    nodes.push(...gridAndAxes({ w, h: ht, m, x: xs, y: ys, xt: x.ticks || niceTicks(x.min, x.max), yt: y.ticks || niceTicks(y.min, y.max, 4), xfmt: x.fmt || String, yfmt: y.fmt || String, xTitle: x.title || "", yTitle: y.title || "" }));
    const refs = spec.refs || [];
    for (const r of refs) nodes.push(refLine(m.l, w - m.r, ys(r.y)));
    for (const t of spec.traces || []) if (t.pts.length) nodes.push(polyline(t.kind, t.pts.map(([a, b]) => [xs(a), ys(b)]), { approx: t.approx }));
    for (const mk of spec.markers || []) nodes.push(mk.shape === "dia" ? diamond(mk.kind, xs(mk.x), ys(mk.y)) : square(mk.kind, xs(mk.x), ys(mk.y)));
    // direct labels (reference-line labels at the right end, labels at line ends): kept apart so none overlaps another (QA-15)
    const tags = [];
    // G-249 (R2-02): reference labels sit above their line; when that would touch the label of the line above (limits a few watts apart), the lower one goes BELOW its own
    // line instead of being pushed down onto it (a dashed line struck through the text, PL1 over PL2). Labels that still collide are separated below.
    let above = -Infinity;
    for (const r of refs.filter((x) => x.label).sort((a, b) => ys(a.y) - ys(b.y))) {
      let y = ys(r.y) - 4 * k;
      if (y - above < 13 * k) y = ys(r.y) + 12 * k;
      above = Math.max(above, y);
      tags.push({ text: r.label, kind: "", anchor: "end", dy: 0, x: w - m.r, y });
    }
    for (const l of spec.labels || []) tags.push({ text: l.text, kind: l.kind, anchor: l.anchor || "start", dy: 4, x: xs(l.x), y: ys(l.y) + 4 });
    const extent = (t) => {
      const tw = labelWidth(t.text) * k;
      return t.anchor === "end" ? [t.x - tw, t.x] : t.anchor === "middle" ? [t.x - tw / 2, t.x + tw / 2] : [t.x, t.x + tw];
    };
    const placed = separateLabels(tags.map((t) => ({ y: t.y, x0: extent(t)[0], x1: extent(t)[1] })), { gap: 13 * k, lo: 10 * k, hi: ht - m.b - 2 });
    tags.forEach((t, i) => nodes.push(textAt(t.x, placed[i] - t.dy, t.text, { kind: t.kind, anchor: t.anchor, dy: t.dy })));
    if (cur !== null) nodes.push(svg("line", { class: "lx-cursor", "data-part": "cursor", x1: r1(xs(cur)), x2: r1(xs(cur)), y1: m.t, y2: ht - m.b }));
    reconcile(root, nodes); // the SVG is built once; a redraw updates attributes and text of the same nodes
    paintReadout();
  };
  const setAttr = (n, k, v) => {
    if (n.getAttribute(k) !== v) n.setAttribute(k, v);
  };
  let roSig = null;
  const paintReadout = () => {
    if (cur === null || !readout) {
      if (!ro.hidden) ro.hidden = true;
      roSig = null;
      return;
    }
    const parts = readout(cur) || [];
    const sig = JSON.stringify(parts);
    if (sig !== roSig) {
      roSig = sig;
      reconcile(ro, parts.map((p) => (Array.isArray(p) ? h("span", {}, p[0] ? p[0] + " " : "", h("b", { text: String(p[1]) }), p[2] ? " " + p[2] : "") : h("span", {}, h("b", { text: String(p) })))));
    }
    const hide = parts.length === 0;
    if (ro.hidden !== hide) ro.hidden = hide;
  };
  const stops = () => cursorStops(spec);

  root.addEventListener("pointermove", (e) => {
    if (!geo) return;
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / Math.max(1, box.width)) * geo.w;
    const xv = x.min + ((px - geo.m.l) / Math.max(1, geo.w - geo.m.l - geo.m.r)) * (x.max - x.min);
    const s = nearestStop(stops(), xv);
    if (s !== cur) api.setCursor(s);
  });
  root.addEventListener("pointerleave", () => {
    if (root.ownerDocument.activeElement !== root) api.setCursor(null);
  });
  root.addEventListener("keydown", (e) => {
    const st = stops();
    if (!st.length) return;
    const i = cur === null ? -1 : st.indexOf(cur);
    let j = null;
    if (e.key === "ArrowRight") j = Math.min(st.length - 1, i + 1);
    else if (e.key === "ArrowLeft") j = i < 0 ? st.length - 1 : Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = st.length - 1;
    if (j === null) return;
    e.preventDefault();
    api.setCursor(st[j]);
  });
  root.addEventListener("blur", () => api.setCursor(null));

  let obs = null;
  if (!width && typeof ResizeObserver === "function") {
    obs = new ResizeObserver((entries) => {
      const cw = Math.round(entries[0].contentRect.width);
      if (cw > 0 && cw !== w) {
        w = cw;
        render();
      }
    });
    obs.observe(el);
  }

  const api = {
    el,
    svg: root,
    draw(next) {
      spec = { traces: [], markers: [], refs: [], zones: [], labels: [], ...next };
      if (cur !== null && !stops().includes(cur)) cur = null;
      render();
    },
    setCursor(xv) {
      cur = xv === null || xv === undefined ? null : xv;
      const mark = cur === null ? "" : String(cur);
      if (el.dataset.cursor !== mark) el.dataset.cursor = mark;
      render();
    },
    cursor: () => cur,
    dispose() {
      if (obs) obs.disconnect();
      obs = null;
    },
  };
  render();
  return api;
}
