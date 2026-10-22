// Live conditions and the 7-day forecast for any point. Open-Meteo first (it has UV and weather codes);
// MET Norway's Locationforecast as the fallback, since Open-Meteo's free tier is capped per IP.
import { cachedJson, fetchOk } from "./cache.js";
import { heatIndexC } from "../public/js/analysis.js";

export type Sky = { emoji: string; text: string };
export type LiveWeather = {
  source: string;
  fetchedAt: string;
  utcOffsetSeconds: number;
  // hi = National Weather Service heat index, the same formula the summer analysis uses, so risk bands agree
  current: { time: string; t: number; hi: number | null; rh: number | null; wind: number | null; uv: number | null; isDay: boolean | null; sky: Sky };
  hourly: { time: string[]; t: number[]; hi: (number | null)[] };
  daily: { date: string; tmax: number; tmin: number; hiMax: number | null; uvMax: number | null; sky: Sky }[];
};

const TTL = 10 * 60_000;
const hiOf = (t: number, rh: number | null | undefined) => (rh == null ? null : Math.round(heatIndexC(t, rh) * 10) / 10);

/** Highest hourly heat index per local date. */
function dailyHiMax(time: string[], hi: (number | null)[]) {
  const out = new Map<string, number>();
  time.forEach((t, i) => {
    const v = hi[i];
    if (v == null) return;
    const d = t.slice(0, 10);
    out.set(d, Math.max(out.get(d) ?? -Infinity, v));
  });
  return out;
}

export function liveWeather(lat: number, lon: number): Promise<LiveWeather> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cachedJson("live", key, TTL, async () => {
    try {
      return await openMeteo(lat, lon);
    } catch (e) {
      console.warn("[live] Open-Meteo unavailable, using MET Norway:", e instanceof Error ? e.message : e);
      return metNorway(lat, lon);
    }
  });
}

async function openMeteo(lat: number, lon: number): Promise<LiveWeather> {
  const key = process.env.OPEN_METEO_API_KEY;
  const url = new URL(`https://${key ? "customer-" : ""}api.open-meteo.com/v1/forecast`);
  const q = url.searchParams;
  q.set("latitude", lat.toFixed(4));
  q.set("longitude", lon.toFixed(4));
  q.set("current", "temperature_2m,relative_humidity_2m,is_day,weather_code,wind_speed_10m,uv_index");
  q.set("hourly", "temperature_2m,relative_humidity_2m");
  q.set("daily", "temperature_2m_max,temperature_2m_min,uv_index_max,weather_code");
  q.set("forecast_days", "7");
  q.set("timezone", "auto");
  if (key) q.set("apikey", key);
  const b = (await (await fetchOk(url, { timeoutMs: 10_000 })).json()) as any;
  if (!b?.current || !b?.daily?.time) throw new Error("Open-Meteo returned no forecast");
  const c = b.current;
  const nowIdx = Math.max(0, (b.hourly.time as string[]).findIndex((t) => t >= String(c.time).slice(0, 13)));
  const hourlyHi = (b.hourly.temperature_2m as number[]).map((t, i) => hiOf(t, b.hourly.relative_humidity_2m?.[i]));
  const hiMax = dailyHiMax(b.hourly.time, hourlyHi);
  return {
    source: "Open-Meteo forecast (national weather-service models)",
    fetchedAt: new Date().toISOString(),
    utcOffsetSeconds: b.utc_offset_seconds ?? 0,
    current: {
      time: c.time, t: c.temperature_2m, hi: hiOf(c.temperature_2m, c.relative_humidity_2m), rh: c.relative_humidity_2m ?? null,
      wind: c.wind_speed_10m ?? null, uv: c.uv_index ?? null, isDay: c.is_day == null ? null : c.is_day === 1,
      sky: wmoSky(c.weather_code, c.is_day !== 0),
    },
    hourly: {
      time: b.hourly.time.slice(nowIdx, nowIdx + 48),
      t: b.hourly.temperature_2m.slice(nowIdx, nowIdx + 48),
      hi: hourlyHi.slice(nowIdx, nowIdx + 48),
    },
    daily: (b.daily.time as string[]).map((date, i) => ({
      date,
      tmax: b.daily.temperature_2m_max[i], tmin: b.daily.temperature_2m_min[i],
      hiMax: hiMax.get(date) ?? null, uvMax: b.daily.uv_index_max?.[i] ?? null,
      sky: wmoSky(b.daily.weather_code?.[i], true),
    })),
  };
}

async function metNorway(lat: number, lon: number): Promise<LiveWeather> {
  // MET's terms ask for at most 4 decimals and an identifying User-Agent (set by fetchOk).
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const b = (await (await fetchOk(url, { timeoutMs: 10_000 })).json()) as any;
  const series = (b?.properties?.timeseries ?? []) as any[];
  if (!series.length) throw new Error("MET Norway returned no forecast");
  const offset = Math.round(lon / 15) * 3600; // MET reports UTC; solar-time offset is close enough for daily highs
  const local = (iso: string) => new Date(Date.parse(iso) + offset * 1000).toISOString().slice(0, 16);
  const hours = series.map((s) => {
    const d = s.data.instant.details;
    const symbol = s.data.next_1_hours?.summary?.symbol_code ?? s.data.next_6_hours?.summary?.symbol_code ?? "";
    return { time: local(s.time), t: d.air_temperature as number, rh: (d.relative_humidity ?? null) as number | null, wind: d.wind_speed ?? null, symbol };
  });
  const byDay = new Map<string, typeof hours>();
  for (const h of hours) {
    const day = h.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(h);
  }
  const now = hours[0];
  return {
    source: "MET Norway Locationforecast",
    fetchedAt: new Date().toISOString(),
    utcOffsetSeconds: offset,
    current: {
      time: now.time, t: now.t, hi: hiOf(now.t, now.rh), rh: now.rh, wind: now.wind != null ? now.wind * 3.6 : null,
      uv: null, isDay: !/_night$/.test(now.symbol), sky: metSky(now.symbol),
    },
    hourly: {
      time: hours.slice(0, 48).map((h) => h.time),
      t: hours.slice(0, 48).map((h) => h.t),
      hi: hours.slice(0, 48).map((h) => hiOf(h.t, h.rh)),
    },
    daily: [...byDay].slice(0, 7).map(([date, hs]) => {
      const peak = hs.reduce((a, b) => (b.t > a.t ? b : a));
      const midday = hs.find((h) => h.time.slice(11, 13) === "12") ?? peak;
      return {
        date, tmax: peak.t, tmin: Math.min(...hs.map((h) => h.t)),
        hiMax: Math.max(...hs.map((h) => hiOf(h.t, h.rh) ?? h.t)), uvMax: null, sky: metSky(midday.symbol),
      };
    }),
  };
}

function wmoSky(code: number | undefined, day: boolean): Sky {
  if (code == null) return { emoji: "🌡️", text: "" };
  if (code === 0) return day ? { emoji: "☀️", text: "Clear" } : { emoji: "🌙", text: "Clear" };
  if (code === 1) return { emoji: day ? "🌤️" : "🌙", text: "Mostly clear" };
  if (code === 2) return { emoji: "⛅", text: "Partly cloudy" };
  if (code === 3) return { emoji: "☁️", text: "Overcast" };
  if (code === 45 || code === 48) return { emoji: "🌫️", text: "Fog" };
  if (code >= 51 && code <= 57) return { emoji: "🌦️", text: "Drizzle" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { emoji: "🌧️", text: "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { emoji: "🌨️", text: "Snow" };
  if (code >= 95) return { emoji: "⛈️", text: "Thunderstorms" };
  return { emoji: "🌡️", text: "" };
}

function metSky(symbol: string): Sky {
  const s = symbol.replace(/_(day|night|polartwilight)$/, "");
  const night = symbol.endsWith("_night");
  if (/thunder/.test(s)) return { emoji: "⛈️", text: "Thunderstorms" };
  if (/snow|sleet/.test(s)) return { emoji: "🌨️", text: "Snow" };
  if (/rain|showers/.test(s)) return { emoji: "🌧️", text: "Rain" };
  if (s === "fog") return { emoji: "🌫️", text: "Fog" };
  if (s === "cloudy") return { emoji: "☁️", text: "Cloudy" };
  if (s === "partlycloudy") return { emoji: "⛅", text: "Partly cloudy" };
  if (s === "fair") return { emoji: night ? "🌙" : "🌤️", text: "Mostly clear" };
  if (s === "clearsky") return { emoji: night ? "🌙" : "☀️", text: "Clear" };
  return { emoji: "🌡️", text: "" };
}
