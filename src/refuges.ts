// Places to cool off near a point, live from OpenStreetMap via the Overpass API:
// drinking water, splash fountains, public pools, parks with shade, and libraries (air-conditioned, free).
import { cachedJson, fetchOk } from "./cache.js";

export type RefugeKind = "water" | "pool" | "park" | "library" | "splash";
export type Refuge = { kind: RefugeKind; name: string | null; lat: number; lon: number; distanceM: number };

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const RADIUS_M = 1500;
const TTL = 7 * 24 * 3_600_000;
const PER_KIND = 12;
const HEDGE_MS = 4_000;

export function coolRefuges(lat: number, lon: number): Promise<Refuge[]> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cachedJson("refuges", key, TTL, () => query(lat, lon));
}

async function query(lat: number, lon: number): Promise<Refuge[]> {
  const a = `(around:${RADIUS_M},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const ql = `[out:json][timeout:20];(
node${a}[amenity=drinking_water];
nwr${a}[leisure=splash_pad];
nwr${a}[amenity=fountain][fountain=splash_pad];
nwr${a}[leisure=swimming_pool][access!=private][access!=customers];
nwr${a}[leisure=water_park];
nwr${a}[leisure=park][name];
nwr${a}[amenity=library];
);out center 400;`;
  // Public Overpass instances are often busy, so start the next mirror if the previous one is slow, and keep the first answer.
  const stop = new AbortController();
  try {
    return await Promise.any(MIRRORS.map(async (mirror, i) => {
      await new Promise((ok) => setTimeout(ok, i * HEDGE_MS));
      if (stop.signal.aborted) throw new Error("not needed");
      try {
        const res = await fetchOk(mirror, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(ql),
          timeoutMs: 20_000,
          signal: stop.signal,
        });
        return parse((await res.json()) as any, lat, lon);
      } catch (e) {
        if (!stop.signal.aborted) console.warn("[refuges]", new URL(mirror).host, e instanceof Error ? e.message : e);
        throw e;
      }
    }));
  } catch {
    throw new Error("No Overpass mirror answered");
  } finally {
    stop.abort();
  }
}

export function parse(body: any, lat: number, lon: number): Refuge[] {
  const mLat = 110_540, mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const out: Refuge[] = [];
  for (const el of body?.elements ?? []) {
    const t = el.tags ?? {};
    const pLat = el.lat ?? el.center?.lat, pLon = el.lon ?? el.center?.lon;
    if (typeof pLat !== "number" || typeof pLon !== "number") continue;
    const kind: RefugeKind | null =
      t.amenity === "drinking_water" ? "water"
      : t.leisure === "splash_pad" || t.fountain === "splash_pad" ? "splash"
      : t.leisure === "swimming_pool" || t.leisure === "water_park" ? "pool"
      : t.leisure === "park" ? "park"
      : t.amenity === "library" ? "library"
      : null;
    if (!kind) continue;
    out.push({ kind, name: t.name ?? null, lat: pLat, lon: pLon, distanceM: Math.round(Math.hypot((pLat - lat) * mLat, (pLon - lon) * mLon)) });
  }
  out.sort((x, y) => x.distanceM - y.distanceM);
  const counts = new Map<RefugeKind, number>();
  return out.filter((r) => {
    const n = counts.get(r.kind) ?? 0;
    counts.set(r.kind, n + 1);
    return n < PER_KIND;
  });
}
