import sharp, { type OverlayOptions } from "sharp";
import type { Grid, BlockReading, NearbySpot } from "./grid.js";
import type { Place } from "./geocode.js";

export type HeatCard = { jpeg: Buffer; statedF: number[] };
export type TileFetcher = (z: number, x: number, y: number) => Promise<Buffer>;

const ZOOM = 16;
const TILE = 256;
const MAP_PX = 1400; // rendered map, ~2.4 km across at Boston's latitude
const OUT_W = 1080;
const HEADER_H = 190;
const FOOTER_H = 200;
const HEAT_ALPHA = 0.78;
const STOPS: [number, [number, number, number]][] = [
  [0, [44, 123, 182]],
  [0.25, [120, 190, 220]],
  [0.5, [255, 240, 160]],
  [0.75, [250, 150, 80]],
  [1, [205, 30, 40]],
];

export const esriTiles: TileFetcher = async (z, x, y) => {
  const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`, {
    headers: { "User-Agent": process.env.GEOCODER_USER_AGENT ?? "CoolBlock/0.1 (HackHarvard 2026 project)" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const worldPx = TILE * 2 ** ZOOM;
const toX = (lon: number) => ((lon + 180) / 360) * worldPx;
const toY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
};
const toLon = (x: number) => (x / worldPx) * 360 - 180;
const toLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldPx))) * 180) / Math.PI;

function color(t: number, lo: number, hi: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, (t - lo) / (hi - lo)));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    if (v <= p1) {
      const [p0, c0] = STOPS[i - 1];
      const k = (v - p0) / (p1 - p0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function basemap(x0: number, y0: number, fetchTile: TileFetcher): Promise<Buffer | null> {
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((x0 + MAP_PX - 1) / TILE), ty1 = Math.floor((y0 + MAP_PX - 1) / TILE);
  const jobs: Promise<OverlayOptions>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(fetchTile(ZOOM, tx, ty).then((input) => ({ input, left: (tx - tx0) * TILE, top: (ty - ty0) * TILE })));
  try {
    const tiles = await Promise.all(jobs);
    const w = (tx1 - tx0 + 1) * TILE, h = (ty1 - ty0 + 1) * TILE;
    const mosaic = await sharp({ create: { width: w, height: h, channels: 3, background: "#f2f0eb" } }).composite(tiles).png().toBuffer();
    return sharp(mosaic)
      .extract({ left: Math.round(x0) - tx0 * TILE, top: Math.round(y0) - ty0 * TILE, width: MAP_PX, height: MAP_PX })
      .png()
      .toBuffer();
  } catch (e) {
    console.error("[heatcard] basemap unavailable, drawing heat only:", e instanceof Error ? e.message : e);
    return null;
  }
}

function pill(x: number, y: number, text: string, fill: string, size = 30): string {
  const w = text.length * size * 0.6 + 34, h = size + 22;
  const left = Math.min(OUT_W - w - 12, Math.max(12, x - w / 2));
  const top = Math.max(HEADER_H + 12, y - h - 26);
  return `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="white" stroke-width="3"/>` +
    `<text x="${left + w / 2}" y="${top + h / 2 + size * 0.36}" font-size="${size}" font-weight="700" fill="white" text-anchor="middle">${esc(text)}</text>`;
}

/**
 * A shareable card: the real Landsat surface-temperature grid around the block, over a street basemap,
 * marking the block, the hottest and coolest blocks within 1 km, and the 1 km radius.
 * Every °F drawn on the card is a rounded grid value and is listed in statedF.
 */
export async function renderHeatCard(grid: Grid, place: Place, reading: BlockReading, fetchTile: TileFetcher = esriTiles): Promise<HeatCard> {
  const { stats, sceneCount, firstDate, lastDate } = grid.meta;
  const lo = stats.lst_p10_f, hi = stats.lst_p90_f;
  const cx = toX(place.lon), cy = toY(place.lat);
  const x0 = cx - MAP_PX / 2, y0 = cy - MAP_PX / 2;

  const heat = Buffer.alloc(MAP_PX * MAP_PX * 4);
  for (let py = 0; py < MAP_PX; py++) {
    const lat = toLat(y0 + py + 0.5);
    for (let px = 0; px < MAP_PX; px++) {
      const t = grid.cellTempF(lat, toLon(x0 + px + 0.5));
      if (t === null) continue;
      const [r, g, b] = color(t, lo, hi);
      const i = (py * MAP_PX + px) * 4;
      heat[i] = r; heat[i + 1] = g; heat[i + 2] = b; heat[i + 3] = Math.round(255 * HEAT_ALPHA);
    }
  }
  const heatPng = await sharp(heat, { raw: { width: MAP_PX, height: MAP_PX, channels: 4 } }).png().toBuffer();
  const base = await basemap(x0, y0, fetchTile);
  const canvas = base ? sharp(base) : sharp({ create: { width: MAP_PX, height: MAP_PX, channels: 3, background: "#f2f0eb" } });
  const layered = await canvas
    .composite([{ input: heatPng, blend: base ? "multiply" : "over" }])
    .png()
    .toBuffer();
  const map = await sharp(layered).resize(OUT_W, OUT_W).png().toBuffer();

  const s = OUT_W / MAP_PX;
  const at = (lat: number, lon: number) => ({ x: (toX(lon) - x0) * s, y: HEADER_H + (toY(lat) - y0) * s });
  const metresPerPx = (156_543.03 * Math.cos((place.lat * Math.PI) / 180)) / 2 ** ZOOM;
  const kmR = (1000 / metresPerPx) * s;

  const you = Math.round(reading.lstF);
  const statedF = [you];
  const { hottest, coolest } = grid.nearbyExtremes(place.lat, place.lon);
  const marks: string[] = [];
  const spot = (sp: NearbySpot | null, label: string, fill: string, keep: (n: number) => boolean) => {
    if (!sp || !keep(Math.round(sp.lstF))) return;
    const { x, y } = at(sp.lat, sp.lon);
    statedF.push(Math.round(sp.lstF));
    marks.push(`<circle cx="${x}" cy="${y}" r="26" fill="none" stroke="${fill}" stroke-width="7"/>` +
      `<circle cx="${x}" cy="${y}" r="26" fill="none" stroke="white" stroke-width="2"/>` +
      pill(x, y, `${label} ${Math.round(sp.lstF)}°F`, fill, 26));
  };
  spot(hottest, "HOTTEST", "#c0392b", (n) => n > you);
  spot(coolest, "COOLEST", "#1f6fa8", (n) => n < you);
  const me = at(place.lat, place.lon);

  const [d0, d1] = [firstDate.slice(0, 4), lastDate.slice(0, 4)];
  const median = Math.round(stats.lst_median_f), p10 = Math.round(lo), p90 = Math.round(hi);
  statedF.push(p10, median, p90);
  const label = place.label.length > 46 ? place.label.slice(0, 45) + "…" : place.label;
  const barX = 70, barW = OUT_W - 140, barY = HEADER_H + OUT_W + 52;
  const gradient = STOPS.map(([p, [r, g, b]]) => `<stop offset="${p}" stop-color="rgb(${r},${g},${b})"/>`).join("");
  const tick = (t: number, text: string) => {
    const x = barX + ((t - lo) / (hi - lo)) * barW;
    return `<line x1="${x}" y1="${barY - 6}" x2="${x}" y2="${barY + 34}" stroke="#333" stroke-width="2"/>` +
      `<text x="${x}" y="${barY + 66}" font-size="26" fill="#333" text-anchor="middle">${text}</text>`;
  };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${HEADER_H + OUT_W + FOOTER_H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs><linearGradient id="g">${gradient}</linearGradient></defs>
  <rect width="${OUT_W}" height="${HEADER_H}" fill="#14261c"/>
  <text x="48" y="62" font-size="28" font-weight="700" fill="#7ddc8f" letter-spacing="3">COOLBLOCK · SEEN FROM SPACE</text>
  <text x="48" y="118" font-size="42" font-weight="700" fill="white">${esc(label)}</text>
  <text x="48" y="164" font-size="27" fill="#cfe3d4">Summer ground temperature, Landsat 8/9 · ~50 m cells</text>
  <circle cx="${me.x}" cy="${me.y}" r="${kmR}" fill="none" stroke="#14261c" stroke-width="3" stroke-dasharray="14 10" opacity="0.75"/>
  <text x="${me.x}" y="${me.y - kmR + 34}" font-size="24" font-weight="700" fill="#14261c" text-anchor="middle" opacity="0.8">1 km</text>
  ${marks.join("\n  ")}
  <circle cx="${me.x}" cy="${me.y}" r="17" fill="#14261c" stroke="white" stroke-width="6"/>
  ${pill(me.x, me.y, `YOUR BLOCK ${you}°F`, "#14261c")}
  <rect y="${HEADER_H + OUT_W}" width="${OUT_W}" height="${FOOTER_H}" fill="white"/>
  <text x="${barX}" y="${barY - 18}" font-size="24" fill="#555">cooler</text>
  <text x="${barX + barW}" y="${barY - 18}" font-size="24" fill="#555" text-anchor="end">hotter</text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="28" rx="6" fill="url(#g)"/>
  ${tick(lo, `${p10}°F`)}${tick(stats.lst_median_f, `${median}°F typical`)}${tick(hi, `${p90}°F`)}
  <text x="${OUT_W / 2}" y="${HEADER_H + OUT_W + FOOTER_H - 22}" font-size="20" fill="#888" text-anchor="middle">${sceneCount} clear summer days ${d0}–${d1}, ~10:30 AM ground (not air) temp · Basemap © Esri, OpenStreetMap</text>
</svg>`;

  const jpeg = await sharp({ create: { width: OUT_W, height: HEADER_H + OUT_W + FOOTER_H, channels: 3, background: "white" } })
    .composite([{ input: map, top: HEADER_H, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return { jpeg, statedF };
}
