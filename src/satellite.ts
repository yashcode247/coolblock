// Satellite heat for any region on Earth, live from NASA GIBS (Global Imagery Browse Services).
// GIBS publishes MODIS products as colour-mapped PNG tiles, and every colour in a product's published
// colormap stands for exactly one value bin. Decoding a tile's pixels therefore gives back the
// measurements: ~1 km land surface temperature, vegetation (NDVI) and land cover, worldwide since 2000.
import sharp from "sharp";
import { cachedBuffer, cachedJson, fetchOk, mapLimit, UpstreamError } from "./cache.js";

const GIBS = "https://gibs.earthdata.nasa.gov";
export const Z = 7; // native zoom of the 1 km MODIS tiles
const TILE = 256;
const WORLD = TILE * 2 ** Z;
const DAY = 86_400_000;
const FRESH_DAYS = 24; // composites this recent may still be filling in, so they're never cached
const REGION_HALF_KM = 50;
const MAX_SEASON_DAYS = 125;
const SNAP = 16;
const REGIONS_KEPT = 12;

type LayerDef = { id: string; matrix: string; colormap: string };
export const LAYERS = {
  day: { id: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", matrix: "GoogleMapsCompatible_Level7", colormap: "MODIS_Land_Surface_Temp" },
  night: { id: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night", matrix: "GoogleMapsCompatible_Level7", colormap: "MODIS_Land_Surface_Temp" },
  ndvi: { id: "MODIS_Terra_L3_NDVI_Monthly", matrix: "GoogleMapsCompatible_Level7", colormap: "MODIS_L3_NDVI" },
  cover: { id: "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual", matrix: "GoogleMapsCompatible_Level8", colormap: "MODIS_IGBP_Land_Cover_Type" },
} satisfies Record<string, LayerDef>;

// MODIS IGBP land-cover classes (MCD12Q1). 0 and 17 are water.
export const COVER_NAMES: Record<number, string> = {
  1: "evergreen needleleaf forest", 2: "evergreen broadleaf forest", 3: "deciduous needleleaf forest",
  4: "deciduous broadleaf forest", 5: "mixed forest", 6: "closed shrubland", 7: "open shrubland",
  8: "woody savanna", 9: "savanna", 10: "grassland", 11: "permanent wetland", 12: "cropland",
  13: "urban and built-up", 14: "cropland/natural mosaic", 15: "snow and ice", 16: "barren land", 17: "water",
};
export const URBAN = 13;
const isWater = (c: number) => c === 0 || c === 17;

// ---------- Web Mercator pixel maths at zoom Z ----------
export const toX = (lon: number) => ((lon + 180) / 360) * WORLD;
export const toY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
};
export const toLon = (x: number) => (x / WORLD) * 360 - 180;
export const toLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;

export type Region = { x0: number; y0: number; width: number; height: number; bounds: [number, number, number, number] };

/**
 * A ~100 km square of zoom-7 pixels around the point. Its centre snaps to a 16 px grid so nearby clicks
 * share one decoded region; bounds are [south, west, north, east] of the outer pixel edges.
 */
export function regionAround(lat: number, lon: number, halfKm = REGION_HALF_KM): Region {
  const mPerPx = (40_075_016.7 * Math.cos((lat * Math.PI) / 180)) / WORLD;
  const half = Math.ceil((halfKm * 1000) / Math.max(mPerPx, 150));
  const cx = Math.round(toX(lon) / SNAP) * SNAP, cy = Math.round(toY(lat) / SNAP) * SNAP;
  const x0 = Math.max(0, cx - half), x1 = Math.min(WORLD, cx + half);
  const y0 = Math.max(0, cy - half), y1 = Math.min(WORLD, cy + half);
  return { x0, y0, width: x1 - x0, height: y1 - y0, bounds: [toLat(y1), toLon(x0), toLat(y0), toLon(x1)] };
}

// ---------- Colormaps ----------
export type Colormap = { values: Map<number, number>; entries: [number, number][] };
const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Parses a GIBS v1.3 colormap XML into packed-RGB → value. Open-ended end bins report their inner edge. */
export function parseColormap(xml: string): Colormap {
  const rows: { rgb: number; lo: number; hi: number | null }[] = [];
  for (const m of xml.matchAll(/<ColorMapEntry\b([^>]*)\/?>/g)) {
    const attr = (n: string) => m[1].match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
    if (attr("transparent") === "true" || attr("nodata") === "true") continue;
    const rgb = attr("rgb")?.split(",").map(Number);
    if (!rgb || rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v))) continue;
    const range = attr("value")?.match(/^[[(]\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*[\])]$/);
    if (range) rows.push({ rgb: pack(rgb[0], rgb[1], rgb[2]), lo: Number(range[1]), hi: Number(range[2]) });
    else {
      const v = Number(attr("sourceValue")?.split(",").at(-1));
      if (Number.isFinite(v)) rows.push({ rgb: pack(rgb[0], rgb[1], rgb[2]), lo: v, hi: null });
    }
  }
  const widths = rows.filter((r) => r.hi !== null && r.hi > r.lo).map((r) => r.hi! - r.lo);
  const narrowest = widths.length ? Math.min(...widths) : 0;
  const values = new Map<number, number>();
  rows.forEach((r, i) => {
    let v = r.lo;
    if (r.hi !== null) {
      // Only the first and last bins can be catch-alls like "below 200 K"; their midpoint would be meaningless.
      const openEnded = (i === 0 || i === rows.length - 1) && r.hi - r.lo > narrowest * 10;
      v = openEnded ? (i === 0 ? r.hi : r.lo) : (r.lo + r.hi) / 2;
    }
    values.set(r.rgb, v);
  });
  return { values, entries: [...values] };
}

export async function colormap(name: string): Promise<Colormap> {
  const entries = await cachedJson("gibs-colormap", name, Infinity, async () => {
    const xml = await (await fetchOk(`${GIBS}/colormaps/v1.3/${name}.xml`)).text();
    return parseColormap(xml).entries;
  });
  return { values: new Map(entries), entries };
}

/** Pixel colours → values. Small categorical maps fall back to the nearest colour, in case of resampling. */
export function decodePixels(rgba: Uint8Array | Buffer, cm: Colormap): Float32Array {
  const out = new Float32Array(rgba.length / 4).fill(NaN);
  const nearest = cm.entries.length <= 64;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] < 128) continue;
    const v = cm.values.get(pack(rgba[i], rgba[i + 1], rgba[i + 2]));
    if (v !== undefined) out[p] = v;
    else if (nearest) {
      let best = Infinity, bv = NaN;
      for (const [rgb, val] of cm.entries) {
        const d = ((rgb >> 16) - rgba[i]) ** 2 + (((rgb >> 8) & 255) - rgba[i + 1]) ** 2 + ((rgb & 255) - rgba[i + 2]) ** 2;
        if (d < best) { best = d; bv = val; }
      }
      if (best < 300) out[p] = bv;
    }
  }
  return out;
}

// ---------- Tiles → region rasters ----------
async function tile(layer: LayerDef, date: string, x: number, y: number): Promise<Buffer | null> {
  const url = `${GIBS}/wmts/epsg3857/best/${layer.id}/default/${date}/${layer.matrix}/${Z}/${y}/${x}.png`;
  const get = async () => Buffer.from(await (await fetchOk(url, { timeoutMs: 20_000 })).arrayBuffer());
  const fresh = Date.now() - Date.parse(date + "T00:00:00Z") < FRESH_DAYS * DAY;
  try {
    return fresh ? await get() : await cachedBuffer("gibs-tile", `${layer.id}/${date}/${Z}/${x}/${y}`, get);
  } catch (e) {
    if (!(e instanceof UpstreamError && e.status === 404)) console.error("[satellite] tile", layer.id, date, x, y, e instanceof Error ? e.message : e);
    return null;
  }
}

/** One layer/date as a Float32Array over the region (NaN = no data), or null when GIBS had nothing at all. */
async function raster(layer: LayerDef, date: string, r: Region): Promise<Float32Array | null> {
  const cm = await colormap(layer.colormap);
  const out = new Float32Array(r.width * r.height).fill(NaN);
  const tx0 = Math.floor(r.x0 / TILE), tx1 = Math.floor((r.x0 + r.width - 1) / TILE);
  const ty0 = Math.floor(r.y0 / TILE), ty1 = Math.floor((r.y0 + r.height - 1) / TILE);
  const jobs: { tx: number; ty: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  let any = false;
  await Promise.all(jobs.map(async ({ tx, ty }) => {
    const png = await tile(layer, date, tx, ty);
    if (!png) return;
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== TILE || info.height !== TILE) return;
    const vals = decodePixels(data, cm);
    any = true;
    for (let py = 0; py < TILE; py++) {
      const ry = ty * TILE + py - r.y0;
      if (ry < 0 || ry >= r.height) continue;
      for (let px = 0; px < TILE; px++) {
        const rx = tx * TILE + px - r.x0;
        if (rx >= 0 && rx < r.width) out[ry * r.width + rx] = vals[py * TILE + px];
      }
    }
  }));
  return any ? out : null;
}

// ---------- Season → product dates ----------
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Start dates of the MODIS 8-day composites (day-of-year 1, 9, 17 …) whose middle falls inside [start, end]. */
export function compositeDates(start: string, end: string): string[] {
  const s = Date.parse(start + "T00:00:00Z"), e = Date.parse(end + "T00:00:00Z") + DAY;
  const out: string[] = [];
  for (let y = new Date(s).getUTCFullYear(); y <= new Date(e).getUTCFullYear(); y++)
    for (let doy = 1; doy <= 366; doy += 8) {
      const t = Date.UTC(y, 0, doy);
      if (new Date(t).getUTCFullYear() !== y) break;
      const mid = t + 4 * DAY;
      if (mid >= s && mid <= e) out.push(iso(t));
    }
  return out;
}

/** First-of-month dates for every month the season touches. */
export function monthDates(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start.slice(0, 7) + "-01T00:00:00Z");
  while (iso(d.getTime()) <= end) {
    out.push(iso(d.getTime()));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

const kToF = (k: number) => ((k - 273.15) * 9) / 5 + 32;

// ---------- Analysis (pure, so the evals can run it on synthetic rasters) ----------
export type Spot = { lat: number; lon: number; f: number; ndvi: number | null; cover: string | null; distanceKm: number; direction: string };
export type RegionStats = {
  landCells: number;
  p10: number; median: number; p90: number;
  here: { f: number; ndvi: number | null; cover: string | null; percentile: number } | null;
  hottest: Spot | null; coolest: Spot | null;
  heatIsland: { urbanF: number; ruralF: number; deltaF: number; urbanCells: number; ruralCells: number } | null;
  greenness: { slopeFPerTenth: number; r: number; n: number; greenestF: number; leastGreenF: number; greenestNdvi: number; leastGreenNdvi: number; ndviP90: number } | null;
  priority: Spot[];
};

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Mean of the finite frame values per pixel; pixels seen in fewer than minFrames composites stay NaN. */
export function meanFrames(frames: Float32Array[], minFrames: number): Float32Array {
  const n = frames[0]?.length ?? 0;
  const out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let s = 0, k = 0;
    for (const f of frames) if (Number.isFinite(f[i])) { s += f[i]; k++; }
    if (k >= minFrames) out[i] = s / k;
  }
  return out;
}

export function analyzeRegion(r: Region, lat: number, lon: number, mean: Float32Array, ndvi: Float32Array | null, cover: Float32Array | null): RegionStats {
  const W = r.width, H = r.height;
  const land: number[] = [];
  for (let i = 0; i < mean.length; i++) {
    if (!Number.isFinite(mean[i])) continue;
    if (cover && Number.isFinite(cover[i]) && isWater(cover[i])) continue;
    land.push(i);
  }
  const sorted = Float64Array.from(land.map((i) => mean[i])).sort();
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const coverName = (i: number) => (cover && Number.isFinite(cover[i]) ? COVER_NAMES[cover[i]] ?? null : null);
  const ndviAt = (i: number) => (ndvi && Number.isFinite(ndvi[i]) ? ndvi[i] : null);

  const cx = toX(lon) - r.x0, cy = toY(lat) - r.y0;
  const mPerPx = (40_075_016.7 * Math.cos((lat * Math.PI) / 180)) / WORLD;
  const spot = (i: number): Spot => {
    const px = (i % W) + 0.5, py = Math.floor(i / W) + 0.5;
    const dx = (px - cx) * mPerPx, dy = (cy - py) * mPerPx;
    const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    return {
      lat: toLat(r.y0 + py), lon: toLon(r.x0 + px), f: mean[i], ndvi: ndviAt(i), cover: coverName(i),
      distanceKm: Math.hypot(dx, dy) / 1000, direction: COMPASS[Math.round(bearing / 45) % 8],
    };
  };
  const pct = (v: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return Math.round((100 * lo) / Math.max(1, sorted.length));
  };

  // The point's own pixel, or the nearest land pixel within 3 px when its own is a cloud gap.
  let hereIdx = -1, best = Infinity;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const px = Math.floor(cx) + dx, py = Math.floor(cy) + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = py * W + px;
      if (!Number.isFinite(mean[i]) || (cover && isWater(cover[i]))) continue;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; hereIdx = i; }
    }

  let hot = -1, cool = -1;
  for (const i of land) {
    if (hot < 0 || mean[i] > mean[hot]) hot = i;
    if (cool < 0 || mean[i] < mean[cool]) cool = i;
  }

  let heatIsland: RegionStats["heatIsland"] = null;
  if (cover) {
    let us = 0, uk = 0, rs = 0, rk = 0;
    for (const i of land) {
      const c = cover[i];
      if (c === URBAN) { us += mean[i]; uk++; }
      else if (Number.isFinite(c) && c !== 15) { rs += mean[i]; rk++; }
    }
    if (uk >= 5 && rk >= 20) heatIsland = { urbanF: us / uk, ruralF: rs / rk, deltaF: us / uk - rs / rk, urbanCells: uk, ruralCells: rk };
  }

  let greenness: RegionStats["greenness"] = null;
  const pairs = ndvi ? land.filter((i) => Number.isFinite(ndvi[i])) : [];
  if (ndvi && pairs.length >= 30) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const i of pairs) { const x = ndvi[i], y = mean[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
    const n = pairs.length;
    const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    if (vx > 0 && vy > 0) {
      const byNdvi = [...pairs].sort((a, b) => ndvi[a] - ndvi[b]);
      const k = Math.max(1, Math.floor(n / 4));
      const avg = (ids: number[], arr: Float32Array) => ids.reduce((s, i) => s + arr[i], 0) / ids.length;
      const least = byNdvi.slice(0, k), most = byNdvi.slice(-k);
      greenness = {
        slopeFPerTenth: (cov / vx) * 0.1,
        r: cov / Math.sqrt(vx * vy),
        n,
        greenestF: avg(most, mean), leastGreenF: avg(least, mean),
        greenestNdvi: avg(most, ndvi), leastGreenNdvi: avg(least, ndvi),
        ndviP90: ndvi[byNdvi[Math.min(n - 1, Math.floor(n * 0.9))]],
      };
    }
  }

  // Where a tree helps most: hot AND bare. Built-up cells only when the region has any.
  const priority: Spot[] = [];
  if (ndvi) {
    const hasUrban = cover ? land.some((i) => cover[i] === URBAN) : false;
    const cand = land.filter((i) => Number.isFinite(ndvi[i]) && (!hasUrban || cover![i] === URBAN));
    const nd = Float64Array.from(cand.map((i) => ndvi[i])).sort();
    const ndPct = (v: number) => {
      let lo = 0, hi = nd.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (nd[m] < v) lo = m + 1; else hi = m; }
      return lo / Math.max(1, nd.length);
    };
    const scored = cand.map((i) => ({ i, s: (pct(mean[i]) / 100) * (1 - ndPct(ndvi[i])) })).sort((a, b) => b.s - a.s);
    for (const { i } of scored) {
      const px = i % W, py = Math.floor(i / W);
      if (priority.some((p) => Math.hypot(toX(p.lon) - r.x0 - px - 0.5, toY(p.lat) - r.y0 - py - 0.5) < 5)) continue;
      priority.push(spot(i));
      if (priority.length === 5) break;
    }
  }

  return {
    landCells: land.length,
    p10: q(0.1), median: q(0.5), p90: q(0.9),
    here: hereIdx >= 0 ? { f: mean[hereIdx], ndvi: ndviAt(hereIdx), cover: coverName(hereIdx), percentile: pct(mean[hereIdx]) } : null,
    hottest: hot >= 0 ? spot(hot) : null,
    coolest: cool >= 0 ? spot(cool) : null,
    heatIsland,
    greenness,
    priority,
  };
}

// ---------- Public entry point ----------
export type SatelliteLayer = "day" | "night";
export type SatelliteResult = {
  source: string;
  layer: SatelliteLayer;
  start: string; end: string;
  bounds: [number, number, number, number];
  width: number; height: number;
  frames: { date: string; f10: (number | null)[]; coverage: number }[];
  mean: (number | null)[]; // °F × 10, per pixel season mean
  ndvi: (number | null)[] | null; // × 100
  cover: number[] | null; // IGBP class, 255 = unknown
  coverYear: number | null;
  stats: RegionStats;
};

const enc = (a: Float32Array, scale: number) => Array.from(a, (v) => (Number.isFinite(v) ? Math.round(v * scale) : null));

export function validSeason(start: string, end: string) {
  const s = Date.parse(start + "T00:00:00Z"), e = Date.parse(end + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    Number.isFinite(s) && Number.isFinite(e) && e >= s && e - s <= MAX_SEASON_DAYS * DAY && s >= Date.UTC(2000, 2, 1);
}

type RegionData = { r: Region; dates: string[]; frames: (Float32Array | null)[]; ndvi: Float32Array | null; cover: Float32Array | null; coverYear: number | null };
const regions = new Map<string, Promise<RegionData>>();

/** Decoded rasters for one region and season, kept in a small in-memory LRU (the tiles themselves are disk-cached). */
function regionData(r: Region, start: string, end: string, layer: SatelliteLayer): Promise<RegionData> {
  const key = `${layer}/${r.x0},${r.y0},${r.width},${r.height}/${start}/${end}`;
  const hit = regions.get(key);
  if (hit) { regions.delete(key); regions.set(key, hit); return hit; }
  const p = loadRegion(r, start, end, layer);
  p.catch(() => regions.delete(key));
  regions.set(key, p);
  if (regions.size > REGIONS_KEPT) regions.delete(regions.keys().next().value!);
  return p;
}

async function loadRegion(r: Region, start: string, end: string, layer: SatelliteLayer): Promise<RegionData> {
  const dates = compositeDates(start, end);
  const lst = await mapLimit(dates, 4, (d) => raster(LAYERS[layer], d, r));
  const frames = lst.map((k) => (k ? k.map(kToF) : null));
  if (!frames.some(Boolean)) throw new Error("NASA GIBS has no satellite composites for this season yet");
  const ndviRasters = await mapLimit(monthDates(start, end), 3, (d) => raster(LAYERS.ndvi, d, r));
  const ndviReal = ndviRasters.filter((f): f is Float32Array => f !== null);
  // Land cover is published yearly with a lag, so walk back to the newest available year.
  const want = Math.min(Number(end.slice(0, 4)), new Date().getUTCFullYear() - 1);
  let cover: Float32Array | null = null, coverYear: number | null = null;
  for (let y = want; y >= Math.max(2001, want - 3) && !cover; y--) {
    cover = await raster(LAYERS.cover, `${y}-01-01`, r);
    if (cover) coverYear = y;
  }
  return { r, dates, frames, ndvi: ndviReal.length ? meanFrames(ndviReal, 1) : null, cover, coverYear };
}

export async function regionalHeat(lat: number, lon: number, start: string, end: string, layer: SatelliteLayer): Promise<SatelliteResult> {
  const r = regionAround(lat, lon);
  const { dates, frames, ndvi, cover, coverYear } = await regionData(r, start, end, layer);
  const real = frames.filter((f): f is Float32Array => f !== null);
  const mean = meanFrames(real, Math.max(2, Math.ceil(real.length * 0.25)));
  const n = r.width * r.height;
  return {
    source: `NASA GIBS · MODIS Terra ${layer === "day" ? "daytime (~10:30 AM)" : "night-time (~10:30 PM)"} land surface temperature, 8-day composites, ~1 km`,
    layer, start, end,
    bounds: r.bounds,
    width: r.width, height: r.height,
    frames: dates.flatMap((date, i) => {
      const f = frames[i];
      if (!f) return [];
      let k = 0;
      for (let j = 0; j < n; j++) if (Number.isFinite(f[j])) k++;
      return [{ date, f10: enc(f, 10), coverage: Math.round((100 * k) / n) / 100 }];
    }),
    mean: enc(mean, 10),
    ndvi: ndvi ? enc(ndvi, 100) : null,
    cover: cover ? Array.from(cover, (v) => (Number.isFinite(v) ? v : 255)) : null,
    coverYear,
    stats: analyzeRegion(r, lat, lon, mean, ndvi, cover),
  };
}
