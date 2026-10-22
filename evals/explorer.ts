// Heat Explorer evals: is the analysis right, is the satellite decoding exact, and does the web server behave?
// Run: npm run eval   (offline: synthetic data and a local server, no API keys or network needed)
import type { AddressInfo } from "node:net";
import * as A from "../public/js/analysis.js";
import { parsePower, powerCell, type ClimateHistory } from "../src/climate.js";
import { analyzeRegion, compositeDates, decodePixels, meanFrames, monthDates, parseColormap, regionAround, toLat, toLon, toX, toY } from "../src/satellite.js";
import { CoolBlock } from "../src/agent.js";
import { Grid } from "../src/grid.js";
import { runWeb } from "../src/web.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};
const DAY = 86_400_000;

/** Daily history from 1981 with a seasonal cycle peaking on `peakDoy`, steady warming and a little fixed noise. */
function synth(o: { peakDoy: number; meanC: number; ampC: number; warmPerDecadeC?: number; rangeC?: number; end?: string }): ClimateHistory {
  const t0 = Date.UTC(1981, 0, 1), t1 = Date.parse((o.end ?? "2026-09-30") + "T00:00:00Z");
  const n = Math.round((t1 - t0) / DAY) + 1;
  const tmax: number[] = [], tmin: number[] = [], tmean: number[] = [], dew: number[] = [], precip: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * DAY);
    const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
    const years = (d.getUTCFullYear() - 1981) + doy / 365;
    const noise = Math.sin(i * 12.9898) * 1.5;
    const hi = o.meanC + o.ampC * Math.cos((2 * Math.PI * (doy - o.peakDoy)) / 365) + ((o.warmPerDecadeC ?? 0) * years) / 10 + noise;
    tmax.push(hi); tmin.push(hi - (o.rangeC ?? 10)); tmean.push(hi - (o.rangeC ?? 10) / 2); dew.push(hi - (o.rangeC ?? 10) - 3); precip.push(0);
  }
  return { source: "synthetic", cell: { lat: 0, lon: 0 }, start: "1981-01-01", end: o.end ?? "2026-09-30", tmax, tmin, tmean, dew, precip };
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- 1. Which months are summer
const north = synth({ peakDoy: 200, meanC: 15, ampC: 13, warmPerDecadeC: 0.3 });
const south = synth({ peakDoy: 20, meanC: 18, ampC: 8 });
const india = synth({ peakDoy: 140, meanC: 32, ampC: 8 });
check("Northern summer is Jun–Aug", A.hottestSeason(north).label === "Jun–Aug", A.hottestSeason(north).label);
check("Southern summer is Dec–Feb", A.hottestSeason(south).label === "Dec–Feb", A.hottestSeason(south).label);
check("A pre-monsoon climate peaks Apr–Jun", A.hottestSeason(india).label === "Apr–Jun", A.hottestSeason(india).label);
const shYears = A.seasonYears(south, 11);
check("Dec–Feb summers are labelled by the year they end, complete ones only", shYears[0] === 1982 && shYears.at(-1) === 2026, `${shYears[0]}…${shYears.at(-1)}`);
const r26 = A.seasonRange(south, 11, 2026);
check("Summer 2026 down south runs Dec 2025 – Feb 2026", r26.start === "2025-12-01" && r26.end === "2026-02-28", `${r26.start} → ${r26.end}`);

// ---------------------------------------------------------------- 2. Heat waves, thresholds, rounding
const fTh = A.thresholds("F");
const days = (highsF: number[], start = "2026-07-01"): ReturnType<typeof A.seasonDays> =>
  highsF.map((f, i) => {
    const c = A.fToC(f);
    return { date: new Date(Date.parse(start + "T00:00:00Z") + i * DAY).toISOString().slice(0, 10), tmax: c, tmin: c - 10, tmean: c - 5, hi: null, precip: 0 };
  });
const wavey = days([85, 91, 92, 95, 90, 84, 91, 92, 80]);
const waves = A.heatWaves(wavey, fTh);
check("A 4-day run at or above 90°F is one heat wave", waves.length === 1 && waves[0].days === 4 && waves[0].start === "2026-07-02" && waves[0].end === "2026-07-05",
  JSON.stringify(waves.map((w) => [w.start, w.days])));
check("Two hot days in a row are not a heat wave", A.heatWaves(days([91, 92, 80]), fTh).length === 0);
const s1 = A.summarize(days([89.6, 89.4]), fTh);
check("A day shown as 90°F counts as a 90°F day; one shown as 89°F doesn't", s1.hotDays === 1, `hot days ${s1.hotDays}`);
const muggy = [{ date: "2026-07-01", tmax: A.fToC(95), tmin: 25, tmean: 30, precip: 0, hi: A.fToC(102.6) }];
const sm = A.summarize(muggy, fTh);
check("A peak heat index shown as 103°F counts as a Danger day", Math.round(A.cToF(sm.peakHeatIndex!.c)) === 103 && sm.dangerDays === 1);
const cTh = A.thresholds("C");
check("°C thresholds are whole °C on screen", cTh.hot === 32 && cTh.night === 20 && cTh.danger === 39);

// Cooling degree-days: 10 days at 5°C above the 65°F base = 50 °C·days = 90 °F·days.
const cddDays = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, tmax: 30, tmin: 16.6, tmean: A.CDD_BASE_C + 5, hi: null, precip: 0 }));
check("Cooling degree-days add up in °F·days", near(A.summarize(cddDays).cddF, 90, 0.01), `${A.summarize(cddDays).cddF.toFixed(2)}`);

// Local thresholds: a desert city moves the hot-day line up; a temperate one keeps 90°F.
const desert = synth({ peakDoy: 200, meanC: 30, ampC: 12 });
const dTh = A.localThresholds(desert, 5, "F"), nTh = A.localThresholds(north, 5, "F");
check("In a desert climate a hot day means the local top 10%", dTh.localHot && dTh.hot > 100, `hot ≥ ${dTh.hot}°F`);
check("In a temperate climate a hot day stays 90°F", !nTh.localHot && nTh.hot === 90, `hot ≥ ${nTh.hot}°F`);

// ---------------------------------------------------------------- 3. Normals, trend, rank
const series = A.seasonSeries(north, 5);
const tr = A.trend(series, "avgHigh")!;
check("The trend recovers the built-in warming (0.3°C per decade)", near(tr.perDecade, 0.3, 0.06), `${tr.perDecade.toFixed(3)}°C/decade`);
const hottest = [...series].sort((a, b) => b.avgHigh - a.avgHigh)[0];
check("The hottest summer ranks 1st", A.rankOf(series, hottest.year)?.rank === 1);
const nm = A.normals(north, 5, series)!;
check("1991–2020 normal uses 30 summers and a daily band as long as the season",
  nm.years === 30 && nm.dailyHigh.length === A.seasonDays(north, 5, 2000).length && nm.dailyHigh.every((v) => v !== null));
check("The normal high sits below recent summers in a warming climate", nm.avgHigh < series.at(-1)!.avgHigh);

// ---------------------------------------------------------------- 4. Heat index and risk bands
const hiTable: [number, number, number][] = [[90, 60, 100], [96, 50, 108], [100, 40, 109], [86, 90, 105]];
check("Heat index matches the NWS table", hiTable.every(([t, rh, want]) => Math.round(A.cToF(A.heatIndexC(A.fToC(t), rh))) === want));
check("Risk bands follow NWS heat-index categories",
  A.heatRisk(A.fToC(79)).status === "good" && A.heatRisk(A.fToC(80)).label === "Caution" && A.heatRisk(A.fToC(103)).label === "Danger" && A.heatRisk(A.fToC(125)).label === "Extreme danger");
check("Every risk band carries an icon and a label, not just a colour", [70, 85, 95, 110, 130].every((f) => { const r = A.heatRisk(A.fToC(f)); return !!r.icon && !!r.label; }));

// ---------------------------------------------------------------- 5. Sustainability estimates
const fp = A.coolingFootprint(1100, 1000, { kWhPerCdd: 1.5, kgPerKwh: 0.4, kgPerTree: 22 });
check("Cooling footprint: +10% demand, +150 kWh, +60 kg CO₂, 3 trees", near(fp.demandChange!, 0.1, 1e-9) && near(fp.extraKwh, 150, 1e-9) && near(fp.extraKgCo2, 60, 1e-9) && near(fp.treesToOffsetExtra, 60 / 22, 1e-9));
check("Greening helps when the region shows greener = cooler", near(A.greeningEffectF({ ndvi: 0.2 }, { slopeFPerTenth: -2, r: -0.6 }, 0.5) ?? 0, -6, 1e-9));
check("The simulator stays silent when greenness explains little", A.greeningEffectF({ ndvi: 0.2 }, { slopeFPerTenth: -2, r: -0.1 }, 0.5) === null);
const gf = A.gapFill([[10, 50], [null, null], [30, null]]);
check("Cloud gaps fill by interpolating in time", gf[1][0] === 2 && gf[2][1] === 5 && gf[0][1] === 5, `${gf.map((f) => Array.from(f).join("/")).join(" ")}`);

// ---------------------------------------------------------------- 6. NASA POWER parsing
const powerBody = {
  header: { fill_value: -999 },
  properties: { parameter: Object.fromEntries(["T2M_MAX", "T2M_MIN", "T2M", "T2MDEW", "PRECTOTCORR"].map((p) => [p, { "19810101": 1.25, "19810102": -999, "19810103": 3, "19810104": -999 }])) },
};
const ph = parsePower(powerBody, { lat: 42.5, lon: -71.25 });
check("POWER fill values become gaps and the unpublished tail is trimmed", ph.end === "1981-01-03" && ph.tmax.length === 3 && ph.tmax[1] === null && ph.tmax[0] === 1.3);
const cell = powerCell(42.36, -71.06);
check("Nearby clicks share one ~50 km POWER cell", cell.lat === 42.5 && cell.lon === -71.25 && JSON.stringify(powerCell(42.4, -71.1)) === JSON.stringify(cell));

// ---------------------------------------------------------------- 7. Satellite colormaps and decoding
const xml = `<ColorMaps><ColorMap title="No Data"><Entries><ColorMapEntry rgb="64,64,64" transparent="true" sourceValue="[0,1)" nodata="true" ref="0"/></Entries></ColorMap>
<ColorMap units="K"><Entries>
<ColorMapEntry rgb="201,0,255" transparent="false" sourceValue="[1,10000)" value="[0.02,200.00)" ref="1"/>
<ColorMapEntry rgb="197,0,255" transparent="false" sourceValue="[10000,10030)" value="[200.00,200.60)" ref="2"/>
<ColorMapEntry rgb="193,0,255" transparent="false" sourceValue="[10030,10060)" value="[200.60,201.20)" ref="3"/>
<ColorMapEntry rgb="255,1,0" transparent="false" sourceValue="[17500,32767)" value="[350.02,652.00)" ref="4"/>
</Entries></ColorMap></ColorMaps>`;
const cm = parseColormap(xml);
const v = (r: number, g: number, b: number) => cm.values.get((r << 16) | (g << 8) | b);
check("Colormap bins decode to their midpoints", near(v(197, 0, 255)!, 200.3, 1e-9) && near(v(193, 0, 255)!, 200.9, 1e-9));
check("Open-ended end bins report their inner edge, not a fake midpoint", v(201, 0, 255) === 200 && near(v(255, 1, 0)!, 350.02, 1e-9));
check("Transparent no-data colours aren't values", v(64, 64, 64) === undefined);
const cover = parseColormap(`<ColorMapEntry rgb="255,0,0" transparent="false" sourceValue="13" ref="12"/><ColorMapEntry rgb="134,202,227" transparent="false" sourceValue="0,17" ref="16"/>`);
check("Land-cover classes decode by class number", cover.values.get(0xff0000) === 13 && cover.values.get((134 << 16) | (202 << 8) | 227) === 17);
const px = Uint8Array.from([197, 0, 255, 255, 1, 2, 3, 255, 197, 0, 255, 0, 250, 2, 2, 255]);
const dec = decodePixels(px, cm), decCover = decodePixels(Uint8Array.from([250, 3, 4, 255]), cover);
check("Pixels decode exactly; unknown and transparent pixels stay empty", near(dec[0], 200.3, 1e-4) && Number.isNaN(dec[1]) && Number.isNaN(dec[2]));
check("Small categorical maps snap a resampled colour to the nearest class", decCover[0] === 13);

const nh = compositeDates("2026-06-01", "2026-08-31");
check("Jun–Aug 2026 uses 11 MODIS 8-day composites, Jun 2 → Aug 21", nh.length === 11 && nh[0] === "2026-06-02" && nh.at(-1) === "2026-08-21", nh.join(" "));
const sh = compositeDates("2025-12-01", "2026-02-28");
check("A season across New Year takes composites from both years", sh.includes("2025-12-27") && sh.includes("2026-01-01") && sh.at(-1)! < "2026-03-01");
check("NDVI months cover the season", JSON.stringify(monthDates("2025-12-01", "2026-02-28")) === JSON.stringify(["2025-12-01", "2026-01-01", "2026-02-01"]));

const region = regionAround(42.36, -71.06);
const [south0, west0, north0, east0] = region.bounds;
check("A region is ~100 km of 1 km pixels around the point", region.width >= 100 && region.width <= 130 && south0 < 42.36 && north0 > 42.36 && west0 < -71.06 && east0 > -71.06,
  `${region.width}×${region.height} px`);
check("Mercator maths round-trips", near(toLat(toY(42.36)), 42.36, 1e-9) && near(toLon(toX(-71.06)), -71.06, 1e-9));

// A synthetic region: a hot, bare built-up core, cool leafy countryside, and a cold lake on the west edge.
const W = region.width, H = region.height, N = W * H;
const mean = new Float32Array(N), ndvi = new Float32Array(N), cov = new Float32Array(N);
const cx = Math.floor(toX(-71.06) - region.x0), cy = Math.floor(toY(42.36) - region.y0);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x, d = Math.hypot(x - cx, y - cy);
    if (x < 6) { mean[i] = 70; ndvi[i] = NaN; cov[i] = 17; continue; }
    const urban = d < 12;
    cov[i] = urban ? 13 : 4;
    ndvi[i] = urban ? 0.15 + d / 200 : 0.75 - ((x * 7 + y * 13) % 10) / 100;
    mean[i] = urban ? 104 - d / 4 : 86 + ((x * 3 + y * 5) % 7) / 10;
  }
const st = analyzeRegion(region, 42.36, -71.06, mean, ndvi, cov);
check("Built-up land reads hotter than the countryside (heat island)", !!st.heatIsland && st.heatIsland.deltaF > 12, `+${st.heatIsland?.deltaF.toFixed(1)}°F`);
check("Greener pixels read cooler (negative slope, strong correlation)", !!st.greenness && st.greenness.slopeFPerTenth < 0 && st.greenness.r < -0.8, `r ${st.greenness?.r.toFixed(2)}`);
check("The hottest spot is in the built-up core", !!st.hottest && st.hottest.cover === "urban and built-up" && st.hottest.distanceKm < 3);
check("Water is excluded: the coolest spot is land, not the lake", !!st.coolest && st.coolest.cover !== "water" && st.coolest.f > 80, `${st.coolest?.f.toFixed(1)}°F ${st.coolest?.cover}`);
check("Your spot in the hot core ranks near the top of the region", (st.here?.percentile ?? 0) >= 95, `${st.here?.percentile}%`);
check("Tree-priority zones are hot, bare built-up cells, spread apart",
  st.priority.length > 0 && st.priority.every((p) => p.cover === "urban and built-up") &&
  st.priority.every((p, i) => st.priority.slice(i + 1).every((q) => Math.hypot(toX(p.lon) - toX(q.lon), toY(p.lat) - toY(q.lat)) >= 5)));
const mf = meanFrames([Float32Array.from([1, NaN]), Float32Array.from([3, NaN]), Float32Array.from([NaN, 7])], 2);
check("A pixel needs enough clear composites to get a season mean", mf[0] === 2 && Number.isNaN(mf[1]));

// ---------------------------------------------------------------- 8. The web server
const gridPath = process.env.GRID_PATH ?? "data/grid.json";
const grid = new Grid(gridPath);
const bot = new CoolBlock(grid, { heatCard: async () => null });
const server = runWeb(bot, 0, grid, gridPath);
await new Promise((ok) => server.once("listening", ok));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const get = (path: string, init?: RequestInit) => fetch(base + path, init);
const home = await get("/");
check("/ serves the Heat Explorer", home.status === 200 && (await home.text()).includes("CoolBlock Heat Explorer"));
const chat = await get("/chat");
check("/chat serves the chat", chat.status === 200 && (await chat.text()).includes("/js/chat.js"));
const js = await get("/js/analysis.js");
check("Shared analysis module is served as JavaScript", js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? ""));
check("Leaflet is served locally, not from a CDN", (await get("/vendor/leaflet/leaflet.js")).status === 200);
const traversal = await get("/%2e%2e/package.json");
check("Static files can't escape public/", traversal.status === 403 || traversal.status === 404, `status ${traversal.status}`);
check("A malformed URL escape is a 400, not a crash", (await get("/%E0%A4%A")).status === 400);
const bad = await get("/api/climate?lat=999&lon=0");
check("Bad coordinates get a 400 with a reason", bad.status === 400 && /lat must be/.test(((await bad.json()) as any).error));
const badSeason = await get("/api/satellite?lat=42&lon=-71&start=1990-06-01&end=1990-08-31");
check("Satellite requests before MODIS (2000) are refused", badSeason.status === 400);
const block = (await (await get("/api/block?lat=42.3292&lon=-71.0837")).json()) as any;
check("/api/block matches the Landsat grid exactly", block.reading?.lstF === grid.lookup(42.3292, -71.0837)?.lstF);
const landsat = await get("/api/landsat", { headers: { "Accept-Encoding": "gzip" } });
check("The 50 m Landsat layer is gzip-compressed", landsat.status === 200 && landsat.headers.get("content-encoding") === "gzip");
const msg = (await (await get("/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "eval", text: "nubian square" }) })).json()) as any;
check("Chat replies come with the conversation stage for quick replies", msg.context?.stage === "located" && msg.context?.place?.city === "Boston" && msg.replies?.[0]?.type === "text");
(bot as any).sessions.get("web:eval").stage = "askOwner"; // as after a street photo
const own = (await (await get("/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "eval", text: "I own it" }) })).json()) as any;
check("The OWN quick reply's wording is understood", own.context?.stage === "done" && own.replies.some((r: any) => /New street tree request/.test(r.text ?? "")));
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
