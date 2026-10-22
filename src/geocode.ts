export type Place = { lat: number; lon: number; label: string; city: "Boston" | "Cambridge" | "Somerville" | "Other" };

// Demo-safe shortcuts: these never hit the network, so the live demo can't stall.
const LANDMARKS: Record<string, Place> = {
  "nubian square": { lat: 42.3292, lon: -71.0837, label: "Nubian Square, Roxbury", city: "Boston" },
  "roxbury": { lat: 42.3292, lon: -71.0837, label: "Nubian Square, Roxbury", city: "Boston" },
  "chinatown": { lat: 42.3505, lon: -71.0621, label: "Chinatown, Boston", city: "Boston" },
  "mattapan": { lat: 42.2676, lon: -71.0925, label: "Mattapan Square", city: "Boston" },
  "east boston": { lat: 42.3691, lon: -71.0395, label: "Maverick Square, East Boston", city: "Boston" },
  "boston common": { lat: 42.3551, lon: -71.0656, label: "Boston Common", city: "Boston" },
  "harvard yard": { lat: 42.3744, lon: -71.1169, label: "Harvard Yard", city: "Cambridge" },
  "harvard square": { lat: 42.3732, lon: -71.1190, label: "Harvard Square", city: "Cambridge" },
  "cambridge common": { lat: 42.3770, lon: -71.1210, label: "Cambridge Common", city: "Cambridge" },
  "central square": { lat: 42.3651, lon: -71.1037, label: "Central Square, Cambridge", city: "Cambridge" },
  "sec": { lat: 42.3637, lon: -71.1252, label: "Harvard SEC, Allston", city: "Boston" },
  "science and engineering complex": { lat: 42.3637, lon: -71.1252, label: "Harvard SEC, Allston", city: "Boston" },
};

function cityOf(s: string | undefined): Place["city"] {
  if (!s) return "Other";
  if (/cambridge/i.test(s)) return "Cambridge";
  if (/somerville/i.test(s)) return "Somerville";
  if (/boston|roxbury|dorchester|mattapan|allston|brighton|jamaica plain|hyde park|charlestown|roslindale|west roxbury/i.test(s)) return "Boston";
  return "Other";
}

const cache = new Map<string, Place | null>();
const userAgent = () => process.env.GEOCODER_USER_AGENT ?? "CoolBlock/0.1 (HackHarvard 2026 project)";

// Nominatim's usage policy allows at most one request per second, so every call queues through here.
let nextSlot = 0;
async function nominatim(url: URL, timeoutMs: number): Promise<Response> {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  if (wait) await new Promise((ok) => setTimeout(ok, wait));
  return fetch(url, { headers: { "User-Agent": userAgent() }, signal: AbortSignal.timeout(timeoutMs) });
}

export async function geocode(query: string): Promise<Place | null> {
  const q = query.trim().toLowerCase().replace(/[?.!]+$/, "");
  if (LANDMARKS[q]) return LANDMARKS[q];
  if (cache.has(q)) return cache.get(q)!;

  // OpenStreetMap Nominatim, bounded to the Boston area. Policy: max 1 req/s, real User-Agent.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("viewbox", "-71.191,42.400,-70.986,42.227");
  url.searchParams.set("bounded", "1");
  try {
    const res = await nominatim(url, 8000);
    if (!res.ok) return null;
    const [hit] = (await res.json()) as any[];
    if (!hit) { cache.set(q, null); return null; }
    const a = hit.address ?? {};
    const place: Place = {
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      label: [a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road ?? hit.name, a.suburb ?? a.neighbourhood ?? a.city]
        .filter(Boolean).join(", ") || hit.display_name,
      city: cityOf([a.city, a.town, a.suburb, hit.display_name].join(" ")),
    };
    cache.set(q, place);
    return place;
  } catch {
    return null;
  }
}

/** Street name at a point, via Nominatim reverse at street level. Null on any failure. */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "17");
  try {
    const res = await nominatim(url, 6000);
    if (!res.ok) return null;
    const hit = (await res.json()) as any;
    const a = hit?.address ?? {};
    return a.road ?? a.pedestrian ?? a.footway ?? a.square ?? null;
  } catch {
    return null;
  }
}

export type WorldPlace = { lat: number; lon: number; label: string; detail: string; bbox: [number, number, number, number] | null };
const worldCache = new Map<string, WorldPlace[]>();

/** Anywhere-on-Earth search for the Heat Explorer (the chat stays bounded to its Landsat area). */
export async function searchWorld(query: string, lang = "en"): Promise<WorldPlace[]> {
  const q = `${lang}:${query.trim().toLowerCase()}`;
  if (!query.trim()) return [];
  if (worldCache.has(q)) return worldCache.get(q)!;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("accept-language", lang);
  const res = await nominatim(url, 8000);
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const hits = (await res.json()) as any[];
  const out = hits.map((h): WorldPlace => {
    const a = h.address ?? {};
    const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county;
    const name = h.name || [a.house_number, a.road].filter(Boolean).join(" ") || town || h.display_name.split(",")[0];
    const b = (h.boundingbox ?? []).map(Number); // [south, north, west, east]
    return {
      lat: Number(h.lat), lon: Number(h.lon),
      label: name,
      detail: [name === town ? null : town, a.state, a.country].filter(Boolean).join(", "),
      bbox: b.length === 4 && b.every(Number.isFinite) ? [b[0], b[2], b[1], b[3]] : null,
    };
  });
  if (worldCache.size > 500) worldCache.clear();
  worldCache.set(q, out);
  return out;
}

const describeCache = new Map<string, string | null>();

/** "Neighbourhood, City, Country" for a map click, or null. Cached on a ~100 m grid. */
export async function describePoint(lat: number, lon: number, lang = "en"): Promise<string | null> {
  const key = `${lang}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (describeCache.has(key)) return describeCache.get(key)!;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", lat.toFixed(5));
  url.searchParams.set("lon", lon.toFixed(5));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "14");
  url.searchParams.set("accept-language", lang);
  try {
    const res = await nominatim(url, 6000);
    if (!res.ok) return null;
    const a = ((await res.json()) as any)?.address ?? {};
    const local = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.hamlet ?? a.village;
    const town = a.city ?? a.town ?? a.municipality ?? a.county;
    const label = [local, town !== local ? town : null, a.country].filter(Boolean).join(", ") || null;
    if (describeCache.size > 2000) describeCache.clear();
    describeCache.set(key, label);
    return label;
  } catch {
    return null;
  }
}
