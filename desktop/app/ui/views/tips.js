// views/tips.js: the Tips screen (desktop/DESIGN.md §10): the reading path for non-experts, pinned at the rail's foot (F1 at the current context,
// Alt+8). Content: lib/tips.js, rendered with createElement only — the inline marks (**strong**, [set]…[/set], [base]…[/base], [write]…[/write]) become
// text nodes and spans, never markup. One panel: a 232 px numbered path on the left (aria-current follows the section in view), the reading column on
// the right (14/22, ≤ 68ch). Figures are drawn by the plot core (components/plot.js) with the geometry of desktop/design/tools/svg.mjs; they are
// illustrations with round numbers. "Open <screen> ›" routes to the screen the section is about. F1 / "More in Tips ›" scroll to a section and focus
// its heading (store.tipsAt).
import { h, svg, clear } from "../components/dom.js";
import { scale, gridAndAxes, polyline, square, diamond, textAt, leader, refLine, zoneRect, r1 } from "../components/plot.js";
import { createSegmented } from "../components/segmented.js";
import { TIPS } from "../lib/tips.js";
import { setPref } from "../store.js";

/** lib/tips.js `goto` -> the app's route: screens keep their ids (Overview is "dashboard"); Tune tabs map onto today's tab ids until C8 renames them. */
export const GOTO_SCREEN = { overview: "dashboard" };
export const GOTO_TAB = { cores: "cores", frequency: "turbo", power: "power", uncore: "ring" };
const GOTO_LABEL = { overview: "Overview", stress: "Stress", curves: "Curves", profiles: "Profiles", audit: "Audit", system: "System", cores: "Tune › Cores", frequency: "Tune › Frequency", power: "Tune › Power", uncore: "Tune › Ring & uncore" };

/** The section F1 opens when no focused control names one: per screen (and Tune tab). */
export const SCREEN_TIP = { dashboard: "indicators", "tune.cores": "first-undervolt", "tune.turbo": "ratios", "tune.ratios": "ratios", "tune.power": "power", "tune.ring": "ratios", stress: "testing", curves: "first-undervolt", profiles: "stop", audit: "start", system: "start", setup: "start", tips: null };

export const gotoLabel = (g) => (g ? GOTO_LABEL[g.tab || g.screen] || g.screen : "");

/** Inline marks -> [{text, mark: null|"strong"|"set"|"base"|"write"}]. Pure (unit-tested): unmatched markers stay as text. */
export function parseInline(s) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\[(set|base|write)\](.+?)\[\/\2\]/g;
  let at = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), mark: null });
    out.push(m[1] !== undefined ? { text: m[1], mark: "strong" } : { text: m[3], mark: m[2] });
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ text: s.slice(at), mark: null });
  return out;
}

function inline(s) {
  return parseInline(String(s)).map((p) =>
    p.mark === "strong" ? h("strong", { text: p.text }) : p.mark === "set" ? h("span", { dataset: { v: "set" }, text: p.text }) : p.mark === "base" ? h("span", { dataset: { v: "base" }, text: p.text }) : p.mark === "write" ? h("span", { class: "lx-w", text: p.text }) : p.text,
  );
}

// ---------------------------------------------------------------- diagrams (geometry: desktop/design/tools/svg.mjs)
const M = { l: 44, r: 150, t: 20, b: 38 };
const wrap = (w, ht, alt, nodes) => svg("svg", { viewBox: `0 0 ${w} ${ht}`, width: w, height: ht, role: "img", "aria-label": alt }, ...nodes);

export function diagVf(d) {
  const w = 600, ht = 250;
  const x = scale(d.x[0], d.x[1], M.l, w - M.r);
  const y = scale(d.y[0], d.y[1], ht - M.b, M.t);
  const out = gridAndAxes({ w, h: ht, m: M, x, y, xt: d.xticks, yt: d.yticks, xfmt: (t) => `${t}×`, yfmt: (t) => t.toFixed(1), yTitle: "volts", xTitle: "ratio (×100 MHz)" });
  const P = d.points;
  const shift = d.curveMv / 1000;
  const fac = P.map((p) => [x(p.r), y(p.v)]);
  const eff = P.map((p, i) => [x(p.r), y(p.v + shift + (i === d.pointIndex ? d.pointMv / 1000 : 0))]);
  out.push(polyline("base", fac), polyline("set", eff), polyline("set", [eff[eff.length - 1], [x(d.oc.r), y(d.oc.v)]], { approx: true }));
  P.forEach((p) => out.push(square("base", x(p.r), y(p.v), 5)));
  eff.forEach(([a, b], i) => out.push(square(i === d.pointIndex ? "set" : "meas", a, b, 6)));
  out.push(diamond("set", x(d.oc.r), y(d.oc.v), 5));
  const lx = w - M.r + 12;
  const top = P[P.length - 1];
  const ocY = y(d.oc.v), ocX = x(d.oc.r);
  out.push(leader([[ocX + 6, ocY], [lx - 4, M.t + 6]], { set: true }), textAt(lx, M.t + 6, d.labels.oc, { kind: "set" }));
  const facTopY = y(top.v);
  out.push(leader([[x(top.r) + 6, facTopY], [lx - 4, facTopY + 26]]), textAt(lx, facTopY + 26, d.labels.factory, { kind: "dim" }));
  const pp = P[d.pointIndex];
  const pY = y(pp.v + shift + d.pointMv / 1000);
  out.push(leader([[x(pp.r) + 6, pY], [lx - 4, pY + 34]], { set: true }), textAt(lx, pY + 34, d.labels.point, { kind: "set" }));
  const mid = P[2];
  out.push(textAt(x(mid.r) + 8, y(mid.v + shift) + 22, d.labels.curve, { kind: "set", dy: 0 }));
  return wrap(w, ht, d.alt, out);
}

export function diagTurbo(d) {
  const w = 600, ht = 220;
  const n = d.buckets.length;
  const x = scale(0.5, n + 0.5, M.l, w - M.r);
  const y = scale(d.y[0], d.y[1], ht - M.b, M.t);
  const out = gridAndAxes({ w, h: ht, m: M, x, y, xt: d.buckets.map((_, i) => i + 1), yt: d.yticks, xfmt: String, yfmt: (t) => `${t}×`, yTitle: "max ratio", xTitle: "busy cores" });
  const pts = [];
  d.buckets.forEach((v, i) => pts.push([x(i + 0.5), y(v)], [x(i + 1.5), y(v)]));
  out.push(polyline("meas", pts));
  d.buckets.forEach((v, i) => out.push(square("meas", x(i + 1), y(v), 6)));
  if (d.bad) {
    const bx = x(d.bad.bucket), by = y(d.bad.value), py = y(d.buckets[d.bad.bucket - 1]);
    out.push(svg("line", { class: "lx-bad", x1: r1(bx), x2: r1(bx), y1: r1(py), y2: r1(by) }), svg("rect", { class: "lx-bad", x: r1(bx - 4), y: r1(by - 4), width: 8, height: 8 }), svg("line", { class: "lx-bad", x1: r1(bx - 6), x2: r1(bx + 6), y1: r1(by - 6), y2: r1(by + 6) }), textAt(bx + 10, by, d.labels.bad, { kind: "dim" }));
  }
  const lx = w - M.r + 12;
  out.push(textAt(lx, y(d.buckets[0]), d.labels.few), textAt(lx, y(d.buckets[n - 1]), d.labels.all));
  return wrap(w, ht, d.alt, out);
}

export function diagPower(d) {
  const w = 600, ht = 230;
  const x = scale(0, d.t, M.l, w - M.r);
  const y = scale(0, d.ymax, ht - M.b, M.t);
  const out = [zoneRect(x(d.burstStart), x(d.burstStart + d.tau), M.t, ht - M.b)];
  out.push(...gridAndAxes({ w, h: ht, m: M, x, y, xt: d.xticks, yt: d.yticks, xfmt: (t) => `${t} s`, yfmt: String, yTitle: "watts", xTitle: "time under a heavy load" }));
  const lx = w - M.r + 12;
  for (const r of d.refs) out.push(refLine(M.l, w - M.r, y(r.w)), textAt(lx, y(r.w), r.label));
  out.push(polyline("meas", d.trace.map(([t, wv]) => [x(t), y(wv)])));
  out.push(textAt(x(d.burstStart) + 6, ht - M.b - 8, d.labels.tau, { kind: "dim", dy: 0 }));
  return wrap(w, ht, d.alt, out);
}

export const DIAGRAMS = { vf: diagVf, turbo: diagTurbo, power: diagPower };

// ---------------------------------------------------------------- blocks
export function renderBlock(b) {
  if (b.p) return h("p", {}, ...inline(b.p));
  if (b.steps) return h("ol", { class: "lx-steps" }, ...b.steps.map((s) => h("li", {}, ...inline(s))));
  if (b.bullets) return h("ul", { class: "lx-bullets" }, ...b.bullets.map((s) => h("li", {}, ...inline(s))));
  if (b.box) return h("div", { class: "lx-box" }, h("span", { class: "lx-box-t", text: b.box.title }), ...inline(b.box.text));
  if (b.indicators) return h("dl", { class: "lx-tip-anns" }, ...b.indicators.flatMap((i) => [h("dt", {}, h("span", { class: "lx-ann", dataset: { state: i.state } }, i.ann)), h("dd", {}, h("p", {}, ...inline(i.text)))]));
  if (b.figure) {
    const { kind, ...data } = b.figure;
    const draw = DIAGRAMS[kind];
    return h("figure", { class: "lx-fig lx-plot", dataset: { fig: kind } }, draw ? draw(data) : null, h("figcaption", {}, ...inline(b.caption || "")));
  }
  if (b.glossary) return h("dl", { class: "lx-gloss" }, ...b.glossary.flatMap((g) => [h("dt", {}, g.term, g.expert ? h("span", { class: "lx-term", text: g.expert }) : null), h("dd", {}, h("p", {}, ...inline(g.text)))]));
  return null;
}

export function tipsView() {
  let off = [];
  return {
    id: "tips",
    lx: true, // built in the new design: the frame gives it no legacy padding
    mount(root, ctx) {
      const { store } = ctx;
      const seg = createSegmented({ options: [{ value: "on", label: "Hints on" }, { value: "quiet", label: "Quiet" }], value: store.get().prefs.hints, label: "Hints", hint: "ui.hints", id: "tips-hints", onChange: (v) => setPref(store, "hints", v) });
      if (ctx.head) ctx.head.set({ end: [h("span", { class: "lx-cluster-k", text: "Hints" }), seg.el] });
      const links = new Map();
      const heads = new Map();
      const sections = [];
      const nav = h("nav", { class: "lx-tips-nav", "aria-label": "Tips sections" }, h("span", { class: "lx-tips-nav-t", text: "Read in order" }));
      const ol = h("ol");
      for (const s of TIPS.sections) {
        const a = h("a", { href: `#/tips/${s.id}`, dataset: { tipLink: s.id }, on: { click: (e) => { e.preventDefault(); show(s.id, true); } } }, h("span", { class: "lx-tn-n", text: s.n }), h("span", { text: s.title }));
        links.set(s.id, a);
        ol.append(h("li", {}, a));
      }
      nav.append(ol);
      const main = h("article", { class: "lx-tips-main" }, h("h1", { class: "lx-tips-h1", text: TIPS.title }), h("p", { class: "lx-tips-lead" }, ...inline(TIPS.lead)));
      for (const s of TIPS.sections) {
        const h2 = h("h2", { id: `tip-${s.id}-h`, tabindex: "-1", text: s.title });
        heads.set(s.id, h2);
        const go = s.goto ? h("button", { type: "button", class: "lx-btn lx-btn--l0 lx-tip-goto", dataset: { goto: s.goto.tab || s.goto.screen }, text: `Open ${gotoLabel(s.goto)} ›`, on: { click: () => ctx.goto(GOTO_SCREEN[s.goto.screen] || s.goto.screen, s.goto.tab ? GOTO_TAB[s.goto.tab] || s.goto.tab : undefined) } }) : null;
        const sec = h("section", { class: "lx-tip", id: `tip-${s.id}`, dataset: { tip: s.id }, "aria-labelledby": h2.id }, h("header", { class: "lx-tip-head" }, h("span", { class: "lx-tip-n", text: s.n }), h2, go, h("span", { class: "lx-tip-meta", text: s.meta })), h("div", { class: "lx-tip-body" }, ...s.blocks.map(renderBlock).filter(Boolean)));
        sections.push(sec);
        main.append(sec);
      }
      main.append(h("p", { class: "lx-tips-foot", text: TIPS.footer }));
      root.append(h("div", { class: "lx-tips", id: "tips" }, nav, main));

      const scroller = root; // #screen is the scroll container
      const mark = (id) => {
        for (const [k, a] of links) {
          if (k === id) a.setAttribute("aria-current", "true");
          else a.removeAttribute("aria-current");
        }
      };
      const inView = () => {
        const top = scroller.getBoundingClientRect().top + 96;
        let cur = TIPS.sections[0].id;
        for (const sec of sections) if (sec.getBoundingClientRect().top <= top) cur = sec.dataset.tip;
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) cur = sections[sections.length - 1].dataset.tip;
        mark(cur);
      };
      function show(id, focus) {
        const sec = sections.find((x) => x.dataset.tip === id);
        if (!sec) return;
        sec.scrollIntoView({ block: "start" });
        mark(id);
        if (focus) heads.get(id).focus({ preventScroll: true });
      }
      scroller.addEventListener("scroll", inView, { passive: true });
      off.push(() => scroller.removeEventListener("scroll", inView));
      off.push(store.watch((st) => st.prefs.hints, (v) => seg.set(v)));
      let seq = store.get().tipsAt.seq;
      const at = store.get().tipsAt.id;
      if (at) (globalThis.requestAnimationFrame || setTimeout)(() => show(at, true));
      else mark(TIPS.sections[0].id);
      off.push(
        store.watch(
          (st) => st.tipsAt,
          (t) => {
            if (t.seq === seq) return;
            seq = t.seq;
            if (t.id) show(t.id, true);
          },
        ),
      );
    },
    unmount() {
      for (const f of off.splice(0)) f();
    },
  };
}
