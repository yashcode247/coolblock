// Heat colour scale, units and date formatting for the Heat Explorer.
import { cToF } from "./analysis.js";

// The same blue → cream → red scale as CoolBlock's satellite heat card, so the map and the iMessage card match.
export const HEAT_STOPS = /** @type {[number, [number, number, number]][]} */ ([
  [0, [44, 123, 182]],
  [0.25, [120, 190, 220]],
  [0.5, [255, 240, 160]],
  [0.75, [250, 150, 80]],
  [1, [205, 30, 40]],
]);

const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 1;
    while (k < HEAT_STOPS.length - 1 && v > HEAT_STOPS[k][0]) k++;
    const [p0, c0] = HEAT_STOPS[k - 1], [p1, c1] = HEAT_STOPS[k];
    const t = (v - p0) / (p1 - p0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * t;
  }
  return lut;
})();

/** @param {number} v 0..1 */
export function heatRGB(v) {
  const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
  return [LUT[i], LUT[i + 1], LUT[i + 2]];
}
export const heatCss = (/** @type {number} */ v, a = 1) => { const [r, g, b] = heatRGB(v); return `rgba(${r},${g},${b},${a})`; };
export const gradientCss = (dir = "90deg") => `linear-gradient(${dir}, ${HEAT_STOPS.map(([p, [r, g, b]]) => `rgb(${r},${g},${b}) ${p * 100}%`).join(", ")})`;

/**
 * Writes values (°F) into RGBA pixels on the heat scale; NaN stays transparent.
 * @param {Uint8ClampedArray} px @param {ArrayLike<number>} values @param {number} lo @param {number} hi @param {number} alpha 0..255
 */
export function paint(px, values, lo, hi, alpha = 200) {
  const span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i], o = i * 4;
    if (!Number.isFinite(v)) { px[o + 3] = 0; continue; }
    const k = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255))) * 3;
    px[o] = LUT[k]; px[o + 1] = LUT[k + 1]; px[o + 2] = LUT[k + 2]; px[o + 3] = alpha;
  }
}

// Diverging pair for anomalies (warming stripes): blue ↔ red through a neutral grey, per the chart palette.
const COLD = [42, 120, 214], HOT = [227, 73, 72], MID = [56, 56, 53];
export function anomalyCss(/** @type {number} */ a, /** @type {number} */ maxAbs) {
  const t = Math.max(-1, Math.min(1, a / (maxAbs || 1)));
  const end = t < 0 ? COLD : HOT, k = Math.pow(Math.abs(t), 0.8);
  return `rgb(${MID.map((m, j) => Math.round(m + (end[j] - m) * k)).join(",")})`;
}

// ---------- Units ----------
/** @typedef {"F"|"C"} Unit */
export const fromC = (/** @type {number} */ c, /** @type {Unit} */ u) => (u === "F" ? cToF(c) : c);
export const fromF = (/** @type {number} */ f, /** @type {Unit} */ u) => (u === "F" ? f : ((f - 32) * 5) / 9);
const r0 = (/** @type {number} */ n) => (Object.is(Math.round(n), -0) ? 0 : Math.round(n));

/** "82°F" from °C. */
export const tC = (/** @type {number|null|undefined} */ c, /** @type {Unit} */ u) => (c == null || !Number.isFinite(c) ? "—" : `${r0(fromC(c, u))}°${u}`);
/** "108°F" from °F. */
export const tF = (/** @type {number|null|undefined} */ f, /** @type {Unit} */ u) => (f == null || !Number.isFinite(f) ? "—" : `${r0(fromF(f, u))}°${u}`);
/** Signed temperature difference from a °C difference: "+3°F" / "−2°C". */
export function dC(/** @type {number} */ dc, /** @type {Unit} */ u, digits = 0) {
  const v = u === "F" ? dc * 1.8 : dc;
  const s = Math.abs(v).toFixed(digits);
  return `${Number(s) === 0 ? "±" : v > 0 ? "+" : "−"}${s}°${u}`;
}
/** Signed difference from a °F difference. */
export const dF = (/** @type {number} */ df, /** @type {Unit} */ u, digits = 0) => dC(df / 1.8, u, digits);

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jul 2" */
export const day = (/** @type {string} */ iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
/** "Jun 1 – Aug 31" */
export const range = (/** @type {string} */ a, /** @type {string} */ b) => `${day(a)} – ${day(b)}`;
export const plural = (/** @type {number} */ n, /** @type {string} */ one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const ordinal = (/** @type {number} */ n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
