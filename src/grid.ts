import { readFileSync } from "node:fs";

type GridFile = {
  source: string;
  synthetic: boolean;
  scene_count: number;
  dates: string[];
  bbox: [number, number, number, number];
  res: number;
  width: number;
  height: number;
  lst_f_x10: (number | null)[];
  ndvi_x100: (number | null)[];
  water: number[];
  stats: { lst_median_f: number; lst_p10_f: number; lst_p90_f: number; ndvi_median: number };
};

export type BlockReading = {
  lstF: number; // block-average summer surface temp
  ndvi: number;
  percentile: number; // % of land cells cooler than this block
  greenNearbyF: number | null; // avg temp of leafy cells within 1 km
  greenDeltaF: number | null; // this block minus leafy nearby
  cityMedianF: number;
  greenLabel: string;
  synthetic: boolean;
  sceneCount: number;
};

export type NearbySpot = {
  lat: number; // centre of the block's middle cell, so lookup(lat, lon) returns the same lstF
  lon: number;
  lstF: number;
  distanceM: number;
  direction: string; // e.g. "south-east"
};

const LEAFY_NDVI = 0.5;
const BLOCK_RADIUS_CELLS = 1; // 3x3 cells ≈ 150 m
const NEARBY_KM = 1;
const OWN_BLOCK_M = 200;
const MIN_BLOCK_CELLS = 6;
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

export class Grid {
  private g: GridFile;
  private sortedLand: Float64Array;

  constructor(path: string) {
    this.g = JSON.parse(readFileSync(path, "utf8"));
    const land: number[] = [];
    for (let i = 0; i < this.g.lst_f_x10.length; i++) {
      const v = this.g.lst_f_x10[i];
      if (v !== null && !this.g.water[i]) land.push(v / 10);
    }
    this.sortedLand = Float64Array.from(land).sort();
  }

  get synthetic() {
    return this.g.synthetic;
  }

  get meta() {
    const { stats, scene_count, dates } = this.g;
    return { stats, sceneCount: scene_count, firstDate: dates[0], lastDate: dates[dates.length - 1] };
  }

  /** Surface temp of the single ~50 m land cell at this point, or null for water / no data. */
  cellTempF(lat: number, lon: number): number | null {
    if (!this.contains(lat, lon)) return null;
    const { row, col } = this.cell(lat, lon);
    return this.at(row, col)?.t ?? null;
  }

  contains(lat: number, lon: number) {
    const [x0, y0, x1, y1] = this.g.bbox;
    return lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1;
  }

  private cell(lat: number, lon: number) {
    const col = Math.floor((lon - this.g.bbox[0]) / this.g.res);
    const row = Math.floor((this.g.bbox[3] - lat) / this.g.res);
    return { row, col };
  }

  private at(row: number, col: number) {
    if (row < 0 || col < 0 || row >= this.g.height || col >= this.g.width) return null;
    const i = row * this.g.width + col;
    if (this.g.water[i]) return null;
    const t = this.g.lst_f_x10[i];
    const n = this.g.ndvi_x100[i];
    if (t === null || n === null) return null;
    return { t: t / 10, n: n / 100 };
  }

  private block(row: number, col: number) {
    let ts = 0, ns = 0, k = 0;
    for (let dr = -BLOCK_RADIUS_CELLS; dr <= BLOCK_RADIUS_CELLS; dr++)
      for (let dc = -BLOCK_RADIUS_CELLS; dc <= BLOCK_RADIUS_CELLS; dc++) {
        const v = this.at(row + dr, col + dc);
        if (v) { ts += v.t; ns += v.n; k++; }
      }
    return k === 0 ? null : { t: ts / k, n: ns / k, k };
  }

  private radiusCells(lat: number) {
    return {
      rRows: Math.ceil(NEARBY_KM / 111 / this.g.res),
      rCols: Math.ceil(NEARBY_KM / (111 * Math.cos((lat * Math.PI) / 180)) / this.g.res),
    };
  }

  lookup(lat: number, lon: number): BlockReading | null {
    if (!this.contains(lat, lon)) return null;
    const { row, col } = this.cell(lat, lon);

    const b = this.block(row, col);
    if (!b) return null;
    const lstF = b.t;
    const ndvi = b.n;

    // leafy cells within ~1 km
    const { rRows, rCols } = this.radiusCells(lat);
    let gs = 0, gk = 0;
    for (let dr = -rRows; dr <= rRows; dr++)
      for (let dc = -rCols; dc <= rCols; dc++) {
        if ((dr / rRows) ** 2 + (dc / rCols) ** 2 > 1) continue;
        const v = this.at(row + dr, col + dc);
        if (v && v.n >= LEAFY_NDVI) { gs += v.t; gk++; }
      }
    const greenNearbyF = gk >= 5 ? gs / gk : null;

    return {
      lstF,
      ndvi,
      percentile: this.percentile(lstF),
      greenNearbyF,
      greenDeltaF: greenNearbyF === null ? null : lstF - greenNearbyF,
      cityMedianF: this.g.stats.lst_median_f,
      greenLabel: ndvi < 0.2 ? "very little" : ndvi < 0.35 ? "some" : ndvi < 0.5 ? "moderate" : "leafy",
      synthetic: this.g.synthetic,
      sceneCount: this.g.scene_count,
    };
  }

  /** Hottest and coolest blocks within 1 km, excluding the caller's own block. */
  nearbyExtremes(lat: number, lon: number): { hottest: NearbySpot | null; coolest: NearbySpot | null } {
    if (!this.contains(lat, lon)) return { hottest: null, coolest: null };
    const { row, col } = this.cell(lat, lon);
    const { rRows, rCols } = this.radiusCells(lat);
    const mPerDegLat = 110_540, mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
    let hottest: NearbySpot | null = null, coolest: NearbySpot | null = null;
    for (let dr = -rRows; dr <= rRows; dr++)
      for (let dc = -rCols; dc <= rCols; dc++) {
        const r = row + dr, c = col + dc;
        const cLat = this.g.bbox[3] - (r + 0.5) * this.g.res;
        const cLon = this.g.bbox[0] + (c + 0.5) * this.g.res;
        const dx = (cLon - lon) * mPerDegLon, dy = (cLat - lat) * mPerDegLat;
        const distanceM = Math.hypot(dx, dy);
        if (distanceM < OWN_BLOCK_M || distanceM > NEARBY_KM * 1000) continue;
        const b = this.block(r, c);
        if (!b || b.k < MIN_BLOCK_CELLS) continue;
        const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        const spot = { lat: cLat, lon: cLon, lstF: b.t, distanceM, direction: COMPASS[Math.round(bearing / 45) % 8] };
        if (!hottest || b.t > hottest.lstF) hottest = spot;
        if (!coolest || b.t < coolest.lstF) coolest = spot;
      }
    return { hottest, coolest };
  }

  private percentile(t: number) {
    let lo = 0, hi = this.sortedLand.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedLand[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return Math.round((100 * lo) / this.sortedLand.length);
  }
}
