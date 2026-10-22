// SVG charts for the Heat Explorer. Thin marks, hairline grids, crosshair tooltips, keyboard focus,
// and a table view for every chart so no value is reachable only by hovering.
import { fromC, tC, dC, day, anomalyCss } from "./heat.js";
import { reducedMotion, h } from "./fx.js";

const NS = "http://www.w3.org/2000/svg";
/** @returns {SVGElement & any} */
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const step0 = span / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= step0) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** Shared tooltip: values lead, labels follow; built with textContent only. */
function tooltip(host) {
  const tip = h("div", { class: "viz-tip", role: "presentation" });
  host.append(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(h("div", { class: "viz-tip-title" }, title),
        ...rows.map(([color, value, label, dash]) => h("div", { class: "viz-tip-row" },
          h("span", { class: "viz-key" + (dash ? " dash" : ""), style: { background: dash ? "none" : color, borderColor: color } }),
          h("b", {}, value), h("span", {}, label))));
      tip.classList.add("on");
      const w = host.clientWidth, tw = tip.offsetWidth;
      tip.style.left = Math.min(w - tw - 4, Math.max(4, x + 14)) + "px";
      tip.style.top = Math.max(0, y - 10) + "px";
    },
    hide() { tip.classList.remove("on"); },
  };
}

/** Reveals an SVG left-to-right with a clip rect. */
function drawIn(svg, width, height, ms = 1100) {
  const id = "clip" + Math.random().toString(36).slice(2, 8);
  const rect = s("rect", { x: 0, y: 0, width: reducedMotion() ? width : 0, height });
  svg.prepend(s("defs", {}, s("clipPath", { id }, rect)));
  if (!reducedMotion()) {
    const t0 = performance.now();
    const step = (now) => {
      // rAF timestamps can precede t0 by a frame, so clamp at 0 too.
      const t = Math.max(0, Math.min(1, (now - t0) / ms)), e = 1 - Math.pow(1 - t, 3);
      rect.setAttribute("width", String(width * e));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return `url(#${id})`;
}

/** Collapsible table twin for a chart. */
export function tableToggle(host, caption, columns, rows) {
  const wrap = h("details", { class: "viz-table" }, h("summary", {}, "Show as table"));
  const table = h("table", {},
    h("caption", { class: "sr-only" }, caption),
    h("thead", {}, h("tr", {}, ...columns.map((c) => h("th", { scope: "col" }, c)))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((v) => h("td", {}, v))))));
  wrap.append(h("div", { class: "viz-table-scroll" }, table));
  host.append(wrap);
}

/**
 * Daily highs and lows over the season, with the 1991–2020 normal band, the hot-day line and heat waves.
 * @param {HTMLElement} host
 * @param {{ days: any[], normals: any, unit: "F"|"C", hot: number, waves: any[], hottest: any, onCursor?: (i: number|null) => void }} o
 */
export function dailyChart(host, o) {
  host.replaceChildren();
  host.classList.add("viz");
  const W = Math.max(280, host.clientWidth), H = 230, m = { l: 34, r: 10, t: 14, b: 24 };
  const u = o.unit, n = o.days.length;
  const val = (c) => (c == null ? null : fromC(c, u));
  const highs = o.days.map((d) => val(d.tmax)), lows = o.days.map((d) => val(d.tmin));
  const nh = o.normals?.dailyHigh?.map(val) ?? [], nl = o.normals?.dailyLow?.map(val) ?? [];
  const all = [...highs, ...lows, ...nh, ...nl, o.hot].filter((v) => v != null && Number.isFinite(v));
  const lo = Math.floor(Math.min(...all) - 2), hi = Math.ceil(Math.max(...all) + 2);
  const x = (i) => m.l + (i / Math.max(1, n - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Daily high and low temperatures, ${o.days[0]?.date} to ${o.days[n - 1]?.date}` });
  const grid = s("g", { class: "grid" });
  for (const t of niceTicks(lo, hi, 4)) {
    grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    grid.append(s("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end", class: "tick" }, document.createTextNode(`${t}°`)));
  }
  o.days.forEach((d, i) => {
    if (d.date.endsWith("-01") || i === 0) grid.append(s("text", { x: x(i), y: H - 6, class: "tick", "text-anchor": i === 0 ? "start" : "middle" }, document.createTextNode(day(d.date))));
  });
  svg.append(grid);
  const clip = drawIn(svg, W, H);
  const plot = s("g", { "clip-path": clip });

  // Heat waves first so the lines sit on top.
  const idx = (date) => o.days.findIndex((d) => d.date === date);
  const longest = o.waves.reduce((a, w) => (!a || w.days > a.days ? w : a), null);
  for (const w of o.waves) {
    const i0 = idx(w.start), i1 = idx(w.end);
    plot.append(s("rect", { x: x(i0) - 3, y: m.t, width: x(i1) - x(i0) + 6, height: H - m.t - m.b, class: "wave", rx: 3 }));
    if (w === longest) plot.append(s("text", { x: (x(i0) + x(i1)) / 2, y: m.t + 11, class: "wave-label", "text-anchor": "middle" }, document.createTextNode(`${w.days}-day heat wave`)));
  }
  const area = (top, bot) => {
    let d = "";
    top.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${x(i)},${y(v)}`; });
    for (let i = bot.length - 1; i >= 0; i--) if (bot[i] != null) d += `L${x(i)},${y(bot[i])}`;
    return d + "Z";
  };
  const line = (vals) => vals.reduce((d, v, i) => (v == null ? d : d + `${d ? "L" : "M"}${x(i)},${y(v)}`), "");
  if (nh.length) plot.append(s("path", { d: area(nh.slice(0, n), nl.slice(0, n)), class: "normal-band" }));
  plot.append(s("path", { d: area(highs, lows), class: "range-band" }));
  plot.append(s("line", { x1: m.l, x2: W - m.r, y1: y(o.hot), y2: y(o.hot), class: "threshold" }));
  plot.append(s("text", { x: m.l + 4, y: y(o.hot) - 5, class: "threshold-label" }, document.createTextNode(`${o.hot}°${u} hot day`)));
  plot.append(s("path", { d: line(lows), class: "line lows" }));
  plot.append(s("path", { d: line(highs), class: "line highs" }));
  if (o.hottest) {
    const i = idx(o.hottest.date), v = val(o.hottest.c);
    if (i >= 0) {
      plot.append(s("circle", { cx: x(i), cy: y(v), r: 4.5, class: "dot highs" }));
      const right = x(i) > W - 90;
      plot.append(s("text", { x: x(i) + (right ? -8 : 8), y: y(v) - 6, class: "direct", "text-anchor": right ? "end" : "start" }, document.createTextNode(`${Math.round(v)}° ${day(o.hottest.date)}`)));
    }
  }
  svg.append(plot);

  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, opacity: 0 });
  const dh = s("circle", { r: 4, class: "dot highs", opacity: 0 }), dl = s("circle", { r: 4, class: "dot lows", opacity: 0 });
  svg.append(cross, dh, dl);
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  svg.append(hit);
  host.append(svg);
  host.append(h("div", { class: "legend" },
    h("span", {}, h("i", { class: "key line-key highs" }), "Daily high"),
    h("span", {}, h("i", { class: "key line-key lows" }), "Daily low"),
    nh.length ? h("span", {}, h("i", { class: "key rect-key normal" }), "1991–2020 normal") : null,
    o.waves.length ? h("span", {}, h("i", { class: "key rect-key wave" }), "Heat wave") : null));

  const tip = tooltip(host);
  let cur = -1;
  const focus = (i) => {
    if (i == null || i < 0 || i >= n) { cur = -1; cross.setAttribute("opacity", "0"); dh.setAttribute("opacity", "0"); dl.setAttribute("opacity", "0"); tip.hide(); o.onCursor?.(null); return; }
    cur = i;
    const d = o.days[i];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", "1");
    if (highs[i] != null) { dh.setAttribute("cx", x(i)); dh.setAttribute("cy", y(highs[i])); dh.setAttribute("opacity", "1"); }
    if (lows[i] != null) { dl.setAttribute("cx", x(i)); dl.setAttribute("cy", y(lows[i])); dl.setAttribute("opacity", "1"); }
    const rows = [["var(--series-2)", tC(d.tmax, u), "high"], ["var(--series-1)", tC(d.tmin, u), "low"]];
    if (d.hi != null) rows.push(["var(--text-2)", tC(d.hi, u), "peak heat index", true]);
    if (nh[i] != null) rows.push(["var(--muted)", `${Math.round(nh[i])}°${u}`, "normal high", true]);
    tip.show(x(i), y(highs[i] ?? lo), day(d.date), rows);
    o.onCursor?.(i);
  };
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1));
  };
  hit.addEventListener("pointermove", (e) => focus(fromEvent(e)));
  hit.addEventListener("pointerleave", () => focus(null));
  host.tabIndex = 0;
  host.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); focus(Math.max(0, Math.min(n - 1, (cur < 0 ? 0 : cur) + (e.key === "ArrowRight" ? 1 : -1)))); }
    if (e.key === "Escape") focus(null);
  });
  host.addEventListener("blur", () => focus(null));
  tableToggle(host, "Daily temperatures", ["Date", "High", "Low", "Heat index"],
    o.days.map((d) => [day(d.date), tC(d.tmax, u), tC(d.tmin, u), tC(d.hi, u)]));
  return { focus };
}

/**
 * Warming stripes: one stripe per summer, coloured by its average high versus the 1991–2020 normal.
 * @param {HTMLElement} host
 * @param {{ series: any[], normalC: number, unit: "F"|"C", selected: number, onPick: (year: number) => void }} o
 */
export function stripes(host, o) {
  host.replaceChildren();
  host.classList.add("viz");
  const n = o.series.length, W = Math.max(280, host.clientWidth), H = 96, axis = 18;
  const anoms = o.series.map((s) => s.avgHigh - o.normalC);
  const maxAbs = Math.max(...anoms.map(Math.abs), 0.5);
  const bw = W / n;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H + axis}`, width: W, height: H + axis, role: "img", "aria-label": `Warming stripes, ${o.series[0]?.year}–${o.series[n - 1]?.year}` });
  const tip = tooltip(host);
  o.series.forEach((row, i) => {
    const g = s("g", { class: "stripe" + (row.year === o.selected ? " selected" : ""), tabindex: 0, role: "button", "aria-label": `${row.year}: ${tC(row.avgHigh, o.unit)}, ${dC(anoms[i], o.unit, 1)} vs normal` });
    const r = s("rect", { x: i * bw, y: 0, width: Math.ceil(bw) + 0.5, height: H, fill: anomalyCss(anoms[i], maxAbs) });
    if (!reducedMotion()) { r.style.transformOrigin = `${i * bw}px ${H}px`; r.style.animation = `stripeIn .5s ${i * 14}ms both cubic-bezier(.2,.8,.2,1)`; }
    g.append(r);
    if (row.year === o.selected) g.append(s("rect", { x: i * bw + 1, y: 1, width: Math.max(2, bw - 2), height: H - 2, class: "stripe-ring" }));
    const show = () => tip.show(i * bw, 4, String(row.year), [[anomalyCss(anoms[i], maxAbs), tC(row.avgHigh, o.unit), "average high"], ["var(--text-2)", dC(anoms[i], o.unit, 1), "vs 1991–2020", true]]);
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => tip.hide());
    g.addEventListener("blur", () => tip.hide());
    g.addEventListener("click", () => o.onPick(row.year));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.onPick(row.year); } });
    svg.append(g);
    if (row.year % 10 === 0 || i === 0 || i === n - 1)
      svg.append(s("text", { x: i * bw + bw / 2, y: H + 13, class: "tick", "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, document.createTextNode(String(row.year))));
  });
  host.append(svg);
  tableToggle(host, "Summer average highs", ["Summer", "Average high", "vs 1991–2020"],
    o.series.map((row, i) => [String(row.year), tC(row.avgHigh, o.unit), dC(anoms[i], o.unit, 1)]).reverse());
}

/**
 * Summer average high per year with the least-squares trend line.
 * @param {HTMLElement} host
 * @param {{ series: any[], trend: any, unit: "F"|"C", selected: number, key?: string, label?: string }} o
 */
export function trendChart(host, o) {
  host.replaceChildren();
  host.classList.add("viz");
  const key = o.key ?? "avgHigh";
  const W = Math.max(280, host.clientWidth), H = 190, m = { l: 34, r: 12, t: 12, b: 22 };
  const pts = o.series.map((r) => ({ year: r.year, v: fromC(r[key], o.unit) }));
  const vs = pts.map((p) => p.v);
  const lo = Math.floor(Math.min(...vs) - 1), hi = Math.ceil(Math.max(...vs) + 1);
  const y0 = pts[0].year, y1 = pts[pts.length - 1].year;
  const x = (yr) => m.l + ((yr - y0) / Math.max(1, y1 - y0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Summer average high by year with trend" });
  const grid = s("g", { class: "grid" });
  for (const t of niceTicks(lo, hi, 4)) {
    grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    grid.append(s("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end", class: "tick" }, document.createTextNode(`${t}°`)));
  }
  for (let yr = Math.ceil(y0 / 10) * 10; yr <= y1; yr += 10) grid.append(s("text", { x: x(yr), y: H - 6, class: "tick", "text-anchor": "middle" }, document.createTextNode(String(yr))));
  svg.append(grid);
  const clip = drawIn(svg, W, H, 1300);
  const plot = s("g", { "clip-path": clip });
  plot.append(s("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.year)},${y(p.v)}`).join(""), class: "line soft" }));
  if (o.trend) {
    const tv = (yr) => fromC(o.trend.intercept + (o.trend.perDecade / 10) * yr, o.unit);
    plot.append(s("line", { x1: x(y0), y1: y(tv(y0)), x2: x(y1), y2: y(tv(y1)), class: "trend" }));
  }
  for (const p of pts) plot.append(s("circle", { cx: x(p.year), cy: y(p.v), r: p.year === o.selected ? 5 : 3, class: "dot highs" + (p.year === o.selected ? " ringed" : "") }));
  svg.append(plot);
  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, opacity: 0 });
  svg.append(cross);
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  svg.append(hit);
  host.append(svg);
  host.append(h("div", { class: "legend" },
    h("span", {}, h("i", { class: "key dot-key highs" }), o.label ?? "Summer average high"),
    o.trend ? h("span", {}, h("i", { class: "key line-key trend" }), "Trend since " + y0) : null));
  const tip = tooltip(host);
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const yr = Math.round(y0 + (((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r) * (y1 - y0));
    const p = pts.find((q) => q.year === yr);
    if (!p) return;
    cross.setAttribute("x1", x(yr)); cross.setAttribute("x2", x(yr)); cross.setAttribute("opacity", "1");
    tip.show(x(yr), y(p.v), String(yr), [["var(--series-2)", `${Math.round(p.v)}°${o.unit}`, o.label ?? "average high"]]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", "0"); tip.hide(); });
}

/**
 * Next 48 hours: temperature and heat index.
 * @param {HTMLElement} host @param {{ time: string[], t: number[], hi: (number|null)[] }} hr @param {"F"|"C"} unit
 */
export function hourlyChart(host, hr, unit) {
  host.replaceChildren();
  host.classList.add("viz");
  const W = Math.max(280, host.clientWidth), H = 150, m = { l: 30, r: 8, t: 10, b: 22 };
  const n = hr.time.length;
  const t = hr.t.map((c) => fromC(c, unit)), f = hr.hi.map((c) => (c == null ? null : fromC(c, unit)));
  const all = [...t, ...f].filter((v) => v != null);
  const lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
  const x = (i) => m.l + (i / Math.max(1, n - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Next 48 hours temperature forecast" });
  const grid = s("g", { class: "grid" });
  for (const v of niceTicks(lo, hi, 3)) {
    grid.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    grid.append(s("text", { x: m.l - 5, y: y(v) + 4, class: "tick", "text-anchor": "end" }, document.createTextNode(`${v}°`)));
  }
  hr.time.forEach((tm, i) => {
    const hh = Number(tm.slice(11, 13));
    if (hh === 0) grid.append(s("line", { x1: x(i), x2: x(i), y1: m.t, y2: H - m.b, class: "midnight" }));
    if (hh % 6 === 0) grid.append(s("text", { x: x(i), y: H - 6, class: "tick", "text-anchor": "middle" }, document.createTextNode(hh === 0 ? day(tm.slice(0, 10)) : `${hh % 12 || 12}${hh < 12 ? "a" : "p"}`)));
  });
  svg.append(grid);
  const clip = drawIn(svg, W, H, 900);
  const line = (vals) => vals.reduce((d, v, i) => (v == null ? d : d + `${d ? "L" : "M"}${x(i)},${y(v)}`), "");
  const plot = s("g", { "clip-path": clip });
  plot.append(s("path", { d: line(f), class: "line feels" }));
  plot.append(s("path", { d: line(t), class: "line highs" }));
  svg.append(plot);
  const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, opacity: 0 });
  svg.append(cross);
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  svg.append(hit);
  host.append(svg);
  host.append(h("div", { class: "legend" },
    h("span", {}, h("i", { class: "key line-key highs" }), "Temperature"),
    h("span", {}, h("i", { class: "key line-key feels" }), "Heat index")));
  const tip = tooltip(host);
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity", "1");
    const hh = Number(hr.time[i].slice(11, 13));
    tip.show(x(i), y(t[i]), `${day(hr.time[i].slice(0, 10))}, ${hh % 12 || 12} ${hh < 12 ? "AM" : "PM"}`,
      [["var(--series-2)", `${Math.round(t[i])}°${unit}`, "temperature"], ["var(--series-5)", f[i] == null ? "—" : `${Math.round(f[i])}°${unit}`, "heat index"]]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("opacity", "0"); tip.hide(); });
}
