// CoolBlock summer-heat analysis: pure functions shared by the Heat Explorer (browser) and the evals (Node).
// Input is NASA POWER daily history: arrays of °C (or mm) with one value per day since `start`.

/**
 * @typedef {{ start: string, end: string, tmax: (number|null)[], tmin: (number|null)[], tmean: (number|null)[],
 *   dew: (number|null)[], precip: (number|null)[] }} History
 * @typedef {{ date: string, tmax: number|null, tmin: number|null, tmean: number|null, hi: number|null, precip: number|null }} Day
 * @typedef {{ start: string, end: string, days: number, peakC: number }} HeatWave
 */

const DAY = 86_400_000;
export const cToF = (/** @type {number} */ c) => (c * 9) / 5 + 32;
export const fToC = (/** @type {number} */ f) => ((f - 32) * 5) / 9;

export const CDD_BASE_C = fToC(65); // cooling degree-day base, 65°F

/**
 * Thresholds are whole numbers in the unit on screen, and values are rounded the same way before they're
 * compared, so a peak shown as "103°F" always counts as a 103°F day. Defaults: the 90°F hot day behind most
 * U.S. heat-wave definitions, the 20°C "tropical night", and the National Weather Service "Danger" heat index.
 * @typedef {{ unit: "F"|"C", hot: number, night: number, danger: number }} Thresholds
 * @param {"F"|"C"} unit @returns {Thresholds}
 */
export const thresholds = (unit) => (unit === "C" ? { unit, hot: 32, night: 20, danger: 39 } : { unit, hot: 90, night: 68, danger: 103 });
const inUnit = (/** @type {"F"|"C"} */ unit, /** @type {number} */ c) => Math.round(unit === "C" ? c : cToF(c));

/**
 * Thresholds that mean something locally. Where the standard line is crossed on most 1991–2020 summer days
 * (90°F highs in Phoenix, 68°F lows in Houston), it moves up to that place's own top 10%, so "hot day" and
 * "heat wave" still single out the unusual heat. Elsewhere the standard lines stay.
 * @param {History} h @param {number} startMonth @param {"F"|"C"} unit
 * @returns {Thresholds & { localHot: boolean, localNight: boolean }}
 */
export function localThresholds(h, startMonth, unit) {
  const th = thresholds(unit);
  /** @type {number[]} */
  const highs = [], lows = [];
  for (const y of seasonYears(h, startMonth)) {
    if (y < BASELINE[0] || y > BASELINE[1]) continue;
    for (const d of seasonDays(h, startMonth, y)) {
      if (d.tmax != null) highs.push(inUnit(unit, d.tmax));
      if (d.tmin != null) lows.push(inUnit(unit, d.tmin));
    }
  }
  if (highs.length < 300) return { ...th, localHot: false, localNight: false };
  const q = (/** @type {number[]} */ a, /** @type {number} */ p) => a.sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  const localHot = q(highs, 0.5) >= th.hot, localNight = q(lows, 0.5) >= th.night;
  return {
    ...th,
    hot: localHot ? Math.max(th.hot, q(highs, 0.9)) : th.hot,
    night: localNight ? Math.max(th.night, q(lows, 0.9)) : th.night,
    localHot, localNight,
  };
}
export const BASELINE = /** @type {const} */ ([1991, 2020]);
export const MIN_COVERAGE = 0.85;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const iso = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
const t0 = (/** @type {History} */ h) => Date.parse(h.start + "T00:00:00Z");
export const dayIndex = (/** @type {History} */ h, /** @type {string} */ date) => Math.round((Date.parse(date + "T00:00:00Z") - t0(h)) / DAY);
export const dateOf = (/** @type {History} */ h, /** @type {number} */ i) => iso(t0(h) + i * DAY);

/** Relative humidity (%) from air temperature and dew point (Magnus formula). */
export function rhFromDew(/** @type {number} */ tC, /** @type {number} */ dewC) {
  const es = (/** @type {number} */ t) => 6.112 * Math.exp((17.62 * t) / (243.12 + t));
  return Math.min(100, Math.max(1, (100 * es(dewC)) / es(tC)));
}

/** National Weather Service heat index (Rothfusz regression with NWS adjustments), °C in, °C out. */
export function heatIndexC(/** @type {number} */ tC, /** @type {number} */ rh) {
  const T = cToF(tC);
  if (T < 50) return tC;
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T
      - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    if (rh < 13 && T >= 80 && T <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (rh > 85 && T >= 80 && T <= 87) hi += ((rh - 85) / 10) * ((87 - T) / 5);
  }
  return fToC(hi);
}

/**
 * NWS heat-index risk bands. `status` names the reserved status colour; every band also carries an icon and label.
 * @param {number|null} hiC heat index, °C
 */
export function heatRisk(hiC) {
  if (hiC == null) return { level: 0, label: "Unknown", status: "good", icon: "·" };
  const f = cToF(hiC);
  if (f >= 125) return { level: 4, label: "Extreme danger", status: "critical", icon: "‼" };
  if (f >= 103) return { level: 3, label: "Danger", status: "critical", icon: "▲" };
  if (f >= 90) return { level: 2, label: "Extreme caution", status: "serious", icon: "!" };
  if (f >= 80) return { level: 1, label: "Caution", status: "warning", icon: "◆" };
  return { level: 0, label: "Lower risk", status: "good", icon: "✓" };
}

// ---------- Seasons ----------

/** @param {History} h @param {number} startMonth 0–11 @param {number} year the year the season ends in */
export function seasonRange(h, startMonth, year) {
  const startYear = startMonth + 2 >= 12 ? year - 1 : year;
  return { start: iso(Date.UTC(startYear, startMonth, 1)), end: iso(Date.UTC(startYear, startMonth + 3, 1) - DAY) };
}

export const seasonLabel = (/** @type {number} */ m) => `${MONTHS[m]}–${MONTHS[(m + 2) % 12]}`;

/** Average daily high for each calendar month over the 1991–2020 baseline (°C). */
export function monthlyNormals(/** @type {History} */ h) {
  const sum = new Array(12).fill(0), n = new Array(12).fill(0);
  const s = t0(h);
  for (let i = 0; i < h.tmax.length; i++) {
    const v = h.tmax[i];
    if (v == null) continue;
    const d = new Date(s + i * DAY);
    const y = d.getUTCFullYear();
    if (y < BASELINE[0] || y > BASELINE[1]) continue;
    sum[d.getUTCMonth()] += v;
    n[d.getUTCMonth()]++;
  }
  return sum.map((v, m) => (n[m] ? v / n[m] : null));
}

/**
 * The local summer: the three consecutive calendar months with the hottest 1991–2020 average high.
 * That is Jun–Aug across most of the north, Dec–Feb in the south and the pre-monsoon Apr–Jun in India.
 */
export function hottestSeason(/** @type {History} */ h) {
  const m = monthlyNormals(h);
  let best = 5, bestV = -Infinity;
  for (let s = 0; s < 12; s++) {
    const v = [0, 1, 2].reduce((acc, k) => acc + (m[(s + k) % 12] ?? -99), 0);
    if (v > bestV) { bestV = v; best = s; }
  }
  return { startMonth: best, label: seasonLabel(best) };
}

/** Season-years (labelled by the year they end) with at least 85% of days on record, oldest first. */
export function seasonYears(/** @type {History} */ h, /** @type {number} */ startMonth) {
  const first = Number(h.start.slice(0, 4)) + (startMonth + 2 >= 12 ? 1 : 0);
  const last = Number(h.end.slice(0, 4));
  const out = [];
  for (let y = first; y <= last; y++) {
    const { start, end } = seasonRange(h, startMonth, y);
    if (end > h.end || start < h.start) continue;
    const i0 = dayIndex(h, start), i1 = dayIndex(h, end);
    let k = 0;
    for (let i = i0; i <= i1; i++) if (h.tmax[i] != null && h.tmin[i] != null) k++;
    if (k >= (i1 - i0 + 1) * MIN_COVERAGE) out.push(y);
  }
  return out;
}

/** @param {History} h @param {number} startMonth @param {number} year */
export function seasonDays(h, startMonth, year) {
  const { start, end } = seasonRange(h, startMonth, year);
  const i0 = dayIndex(h, start), i1 = dayIndex(h, end);
  /** @type {Day[]} */
  const days = [];
  for (let i = i0; i <= i1; i++) {
    const tmax = h.tmax[i] ?? null, dew = h.dew[i] ?? null;
    days.push({
      date: dateOf(h, i), tmax, tmin: h.tmin[i] ?? null, tmean: h.tmean[i] ?? null, precip: h.precip[i] ?? null,
      hi: tmax != null && dew != null ? heatIndexC(tmax, rhFromDew(tmax, Math.min(dew, tmax))) : null,
    });
  }
  return days;
}

/** Runs of at least `minDays` consecutive days with highs at or above the hot-day threshold. */
export function heatWaves(/** @type {Day[]} */ days, /** @type {Thresholds} */ th, minDays = 3) {
  /** @type {HeatWave[]} */
  const out = [];
  let run = /** @type {Day[]} */ ([]);
  const close = () => {
    if (run.length >= minDays)
      out.push({ start: run[0].date, end: run[run.length - 1].date, days: run.length, peakC: Math.max(...run.map((d) => /** @type {number} */ (d.tmax))) });
    run = [];
  };
  for (const d of days) d.tmax != null && inUnit(th.unit, d.tmax) >= th.hot ? run.push(d) : close();
  close();
  return out;
}

/**
 * Everything the Summer tab shows for one season.
 * @param {Day[]} days @param {Thresholds} [th]
 */
export function summarize(days, th = thresholds("F")) {
  const ge = (/** @type {number|null} */ c, /** @type {number} */ t) => c != null && inUnit(th.unit, c) >= t;
  const highs = days.filter((d) => d.tmax != null), lows = days.filter((d) => d.tmin != null);
  const mean = (/** @type {number[]} */ a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const top = (/** @type {Day[]} */ a, /** @type {(d: Day) => number} */ k) => a.reduce((best, d) => (best && k(best) >= k(d) ? best : d), /** @type {Day|null} */ (null));
  const hottest = top(highs, (d) => /** @type {number} */ (d.tmax));
  const warmestNight = top(lows, (d) => /** @type {number} */ (d.tmin));
  const withHi = days.filter((d) => d.hi != null);
  const peakHi = top(withHi, (d) => /** @type {number} */ (d.hi));
  const waves = heatWaves(days, th);
  const cdd = days.reduce((s, d) => s + (d.tmean != null ? Math.max(0, d.tmean - CDD_BASE_C) : 0), 0);
  return {
    days: days.length,
    avgHigh: mean(highs.map((d) => /** @type {number} */ (d.tmax))),
    avgLow: mean(lows.map((d) => /** @type {number} */ (d.tmin))),
    hottest: hottest && { c: /** @type {number} */ (hottest.tmax), date: hottest.date },
    warmestNight: warmestNight && { c: /** @type {number} */ (warmestNight.tmin), date: warmestNight.date },
    hotDays: days.filter((d) => ge(d.tmax, th.hot)).length,
    warmNights: days.filter((d) => ge(d.tmin, th.night)).length,
    heatWaves: waves,
    longestWave: waves.reduce((m, w) => Math.max(m, w.days), 0),
    waveDays: waves.reduce((s, w) => s + w.days, 0),
    peakHeatIndex: peakHi && { c: /** @type {number} */ (peakHi.hi), date: peakHi.date },
    dangerDays: days.filter((d) => ge(d.hi, th.danger)).length,
    cddF: cdd * 1.8, // °F·days, the unit U.S. utilities use
    precipMm: days.reduce((s, d) => s + (d.precip ?? 0), 0),
    monthly: monthlyBreakdown(days),
  };
}

function monthlyBreakdown(/** @type {Day[]} */ days) {
  /** @type {Map<string, Day[]>} */
  const by = new Map();
  for (const d of days) {
    const k = d.date.slice(0, 7);
    if (!by.has(k)) by.set(k, []);
    /** @type {Day[]} */ (by.get(k)).push(d);
  }
  return [...by].map(([month, ds]) => {
    const hs = ds.flatMap((d) => (d.tmax != null ? [d.tmax] : [])), ls = ds.flatMap((d) => (d.tmin != null ? [d.tmin] : []));
    return {
      month, label: MONTHS[Number(month.slice(5, 7)) - 1],
      avgHigh: hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null,
      avgLow: ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : null,
    };
  });
}

/**
 * Every complete season since 1981 with its headline numbers; the stripes, trend, rank and normal come from this.
 * @param {History} h @param {number} startMonth @param {Thresholds} [th]
 */
export function seasonSeries(h, startMonth, th = thresholds("F")) {
  return seasonYears(h, startMonth).map((year) => {
    const s = summarize(seasonDays(h, startMonth, year), th);
    return { year, avgHigh: /** @type {number} */ (s.avgHigh), avgLow: /** @type {number} */ (s.avgLow), hotDays: s.hotDays, warmNights: s.warmNights, cddF: s.cddF, longestWave: s.longestWave };
  });
}

/** 1991–2020 averages of the series, plus a day-by-day normal high/low (7-day smoothed) for the chart band. */
export function normals(/** @type {History} */ h, /** @type {number} */ startMonth, /** @type {ReturnType<typeof seasonSeries>} */ series) {
  const base = series.filter((s) => s.year >= BASELINE[0] && s.year <= BASELINE[1]);
  if (base.length < 20) return null;
  const avg = (/** @type {(s: typeof base[number]) => number} */ k) => base.reduce((a, s) => a + k(s), 0) / base.length;
  const len = seasonDays(h, startMonth, base[0].year).length;
  const hi = new Array(len).fill(0), lo = new Array(len).fill(0), n = new Array(len).fill(0);
  for (const { year } of base) {
    seasonDays(h, startMonth, year).slice(0, len).forEach((d, i) => {
      if (d.tmax != null && d.tmin != null) { hi[i] += d.tmax; lo[i] += d.tmin; n[i]++; }
    });
  }
  const smooth = (/** @type {number[]} */ a) => a.map((_, i) => {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(a.length - 1, i + 3); j++) if (n[j]) { s += a[j] / n[j]; k++; }
    return k ? s / k : null;
  });
  return {
    years: base.length,
    avgHigh: avg((s) => s.avgHigh), avgLow: avg((s) => s.avgLow), hotDays: avg((s) => s.hotDays),
    warmNights: avg((s) => s.warmNights), cddF: avg((s) => s.cddF), longestWave: avg((s) => s.longestWave),
    dailyHigh: smooth(hi), dailyLow: smooth(lo),
  };
}

/** Ordinary least squares of key on year: slope per decade and r². */
export function trend(/** @type {{ year: number }[] & any[]} */ series, /** @type {string} */ key) {
  const pts = series.filter((s) => Number.isFinite(s[key]));
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((a, s) => a + s.year, 0) / n, my = pts.reduce((a, s) => a + s[key], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const s of pts) { sxy += (s.year - mx) * (s[key] - my); sxx += (s.year - mx) ** 2; syy += (s[key] - my) ** 2; }
  const slope = sxy / sxx;
  return { perDecade: slope * 10, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, from: pts[0].year, to: pts[n - 1].year };
}

/** 1 = hottest season on record by key. */
export function rankOf(/** @type {any[]} */ series, /** @type {number} */ year, key = "avgHigh") {
  const me = series.find((s) => s.year === year);
  if (!me) return null;
  return { rank: 1 + series.filter((s) => s[key] > me[key]).length, of: series.length };
}

// ---------- Sustainability: cooling energy and carbon ----------

/**
 * Cooling energy implied by degree-days. kWhPerCdd and kgPerKwh are user-adjustable assumptions, not measurements.
 * @param {number} cddF @param {number} baseCddF @param {{ kWhPerCdd: number, kgPerKwh: number, kgPerTree: number }} a
 */
export function coolingFootprint(cddF, baseCddF, a) {
  const kwh = cddF * a.kWhPerCdd, extraKwh = (cddF - baseCddF) * a.kWhPerCdd;
  return {
    demandChange: baseCddF > 0 ? cddF / baseCddF - 1 : null,
    kwh, extraKwh,
    kgCo2: kwh * a.kgPerKwh, extraKgCo2: extraKwh * a.kgPerKwh,
    treesToOffsetExtra: Math.max(0, (extraKwh * a.kgPerKwh) / a.kgPerTree),
  };
}

/**
 * Predicted surface cooling if a spot became as green as `targetNdvi`, from the region's own
 * satellite relationship between greenness and heat. Returns °F (negative = cooler) or null when the
 * relationship is too weak to lean on.
 * @param {{ ndvi: number|null }} here @param {{ slopeFPerTenth: number, r: number }} g @param {number} targetNdvi
 */
export function greeningEffectF(here, g, targetNdvi) {
  if (here.ndvi == null || !(g.r <= -0.2) || !(g.slopeFPerTenth < 0)) return null;
  return (g.slopeFPerTenth * Math.max(0, targetNdvi - here.ndvi)) / 0.1;
}

// ---------- Satellite frames ----------

/**
 * Fills cloud gaps in a stack of frames by linear interpolation in time, per pixel; pixels never seen stay NaN.
 * @param {(number|null)[][]} frames values ×10, null for no data
 * @returns {Float32Array[]} values (unscaled)
 */
export function gapFill(frames) {
  const n = frames[0]?.length ?? 0, T = frames.length;
  const out = frames.map(() => new Float32Array(n).fill(NaN));
  for (let i = 0; i < n; i++) {
    let prev = -1;
    for (let t = 0; t < T; t++) {
      const v = frames[t][i];
      if (v == null) continue;
      out[t][i] = v / 10;
      if (prev < 0) for (let k = 0; k < t; k++) out[k][i] = v / 10;
      else for (let k = prev + 1; k < t; k++) out[k][i] = out[prev][i] + ((v / 10 - out[prev][i]) * (k - prev)) / (t - prev);
      prev = t;
    }
    if (prev >= 0) for (let k = prev + 1; k < T; k++) out[k][i] = out[prev][i];
  }
  return out;
}
