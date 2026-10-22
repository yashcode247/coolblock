// Daily air-temperature history for any point on Earth from NASA POWER (MERRA-2 reanalysis, ~50 km cells).
// One request returns every day since 1981, which is all the summer analysis, the 1991–2020 normal
// and the warming stripes need. Docs: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
import { cachedJson, fetchOk } from "./cache.js";

export type ClimateHistory = {
  source: string;
  cell: { lat: number; lon: number }; // centre of the MERRA-2 cell the values describe
  start: string; // YYYY-MM-DD of index 0
  end: string; // last day with data (POWER runs a few days behind)
  tmax: (number | null)[]; // °C, one value per day from start
  tmin: (number | null)[];
  tmean: (number | null)[];
  dew: (number | null)[]; // dew point, °C
  precip: (number | null)[]; // mm/day
};

const START = "1981-01-01";
const PARAMS = { tmax: "T2M_MAX", tmin: "T2M_MIN", tmean: "T2M", dew: "T2MDEW", precip: "PRECTOTCORR" } as const;
const CELL_LAT = 0.5, CELL_LON = 0.625; // MERRA-2 grid
const DAY = 86_400_000;
const TTL = 12 * 3_600_000; // new days are published daily

export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The MERRA-2 cell centre for a point, so every click inside one ~50 km cell shares one cached request. */
export function powerCell(lat: number, lon: number) {
  const cLat = Math.max(-90, Math.min(90, Math.round(lat / CELL_LAT) * CELL_LAT));
  let cLon = Math.round(lon / CELL_LON) * CELL_LON;
  if (cLon >= 180) cLon -= 360;
  if (cLon < -180) cLon += 360;
  return { lat: +cLat.toFixed(3), lon: +cLon.toFixed(3) };
}

export function climateHistory(lat: number, lon: number): Promise<ClimateHistory> {
  const cell = powerCell(lat, lon);
  return cachedJson("power", `${cell.lat},${cell.lon}`, TTL, () => fetchHistory(cell));
}

async function fetchHistory(cell: { lat: number; lon: number }): Promise<ClimateHistory> {
  const url = new URL("https://power.larc.nasa.gov/api/temporal/daily/point");
  url.searchParams.set("parameters", Object.values(PARAMS).join(","));
  url.searchParams.set("community", "RE");
  url.searchParams.set("latitude", String(cell.lat));
  url.searchParams.set("longitude", String(cell.lon));
  url.searchParams.set("start", START.replaceAll("-", ""));
  url.searchParams.set("end", isoDay(Date.now()).replaceAll("-", ""));
  url.searchParams.set("format", "JSON");
  const body = (await (await fetchOk(url, { timeoutMs: 60_000 })).json()) as any;
  return parsePower(body, cell);
}

/** Turns POWER's {param: {YYYYMMDD: value}} JSON into aligned daily arrays, trimming the not-yet-published tail. */
export function parsePower(body: any, cell: { lat: number; lon: number }): ClimateHistory {
  const p = body?.properties?.parameter;
  if (!p?.[PARAMS.tmax]) throw new Error("NASA POWER returned no temperature data");
  const fill = Number(body?.header?.fill_value ?? -999);
  const t0 = Date.parse(START + "T00:00:00Z");
  const keys = Object.keys(p[PARAMS.tmax]).sort();
  const n = Math.round((Date.parse(toIso(keys[keys.length - 1]) + "T00:00:00Z") - t0) / DAY) + 1;

  const read = (param: string) => {
    const src = p[param] ?? {};
    const out: (number | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const v = src[isoDay(t0 + i * DAY).replaceAll("-", "")];
      out[i] = typeof v === "number" && v !== fill && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
    }
    return out;
  };
  const series = Object.fromEntries(Object.entries(PARAMS).map(([k, param]) => [k, read(param)])) as Record<keyof typeof PARAMS, (number | null)[]>;

  let last = n - 1;
  while (last >= 0 && (series.tmax[last] === null || series.tmin[last] === null)) last--;
  if (last < 0) throw new Error("NASA POWER returned only missing values");
  for (const k of Object.keys(series) as (keyof typeof PARAMS)[]) series[k] = series[k].slice(0, last + 1);

  return {
    source: "NASA POWER daily (MERRA-2 reanalysis, ~50 km)",
    cell,
    start: START,
    end: isoDay(t0 + last * DAY),
    ...series,
  };
}

const toIso = (k: string) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
