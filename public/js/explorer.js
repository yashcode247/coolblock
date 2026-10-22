// CoolBlock Heat Explorer: summer heat anywhere on Earth, from live NASA satellite and weather data.
import * as A from "./analysis.js";
import { sfx } from "./sfx.js";
import { countUp, leafBurst, enableRipples, toast, h, haptic, reducedMotion } from "./fx.js";
import { gradientCss, heatCss, tC, tF, dC, dF, day, range, plural, ordinal, fromC, fromF } from "./heat.js";
import { dailyChart, stripes, trendChart, hourlyChart } from "./charts.js";
import { CanvasOverlay, HeatTiles, pulseIcon, spotIcon, emojiIcon, labelSpot } from "./maplayers.js";

const L = /** @type {any} */ (window).L;
const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const DAY = 86_400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const QUICK = [
  { label: "Phoenix", lat: 33.4484, lon: -112.074, tag: "desert" },
  { label: "Delhi", lat: 28.6139, lon: 77.209, tag: "pre-monsoon" },
  { label: "Seville", lat: 37.3891, lon: -5.9845, tag: "Europe" },
  { label: "Houston", lat: 29.7604, lon: -95.3698, tag: "humid" },
  { label: "Cairo", lat: 30.0444, lon: 31.2357, tag: "" },
  { label: "Tokyo", lat: 35.6762, lon: 139.6503, tag: "" },
  { label: "Sydney", lat: -33.8688, lon: 151.2093, tag: "Dec–Feb" },
  { label: "Roxbury, Boston", lat: 42.3292, lon: -71.0837, tag: "50 m", zoom: 13 },
];

const state = {
  unit: /** @type {"F"|"C"} */ (store.get("cb_unit", /^en-US/.test(navigator.language) ? "F" : "C") === "C" ? "C" : "F"),
  place: /** @type {null | { lat: number, lon: number, label: string|null, detail?: string }} */ (null),
  history: /** @type {any} */ (null),
  historyError: /** @type {any} */ (null),
  seasonMode: /** @type {"auto"|number} */ ("auto"),
  startMonth: 5,
  years: /** @type {number[]} */ ([]),
  year: /** @type {number|null} */ (null),
  hot: /** @type {number|null} */ (null),
  localTh: /** @type {any} */ (null),
  series: /** @type {any[]} */ ([]),
  normals: /** @type {any} */ (null),
  days: /** @type {any[]} */ ([]),
  summary: /** @type {any} */ (null),
  sat: { day: /** @type {any} */ (null), night: /** @type {any} */ (null), error: /** @type {string|null} */ (null), key: "", loading: false },
  view: { layer: "day", t: /** @type {number|null} */ (null), playing: false },
  layers: { heat: true, night: false, priority: false, landsat: false, refuges: false, imagery: false, world: false },
  block: /** @type {any} */ (null),
  live: /** @type {any} */ (null),
  liveError: /** @type {string|null} */ (null),
  refuges: /** @type {any[]|null} */ (null),
  refugesLoading: false,
  tab: "summer",
  sim: 60,
  energy: { kWhPerCdd: 1.5, kgPerKwh: 0.45, kgPerTree: 22 },
  token: 0,
};

// ---------------------------------------------------------------- API
async function api(path) {
  const res = await fetch(path);
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true, worldCopyJump: true, minZoom: 2, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: true }).setView([24, 12], 2.4);
// Esri's Dark Gray Canvas: free with attribution and no key (the heat card already uses its light sibling).
const esri = (service, opts = {}) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, {
  maxNativeZoom: 16, maxZoom: 20, attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors", ...opts,
});
const base = esri("Canvas/World_Dark_Gray_Base").addTo(map);
const imagery = esri("World_Imagery", { maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
for (const [name, z] of [["heat", 410], ["priority", 430], ["landsat", 440], ["labels", 650]]) {
  map.createPane(name);
  map.getPane(name).style.zIndex = String(z);
  if (name === "labels") map.getPane(name).classList.add("labels-pane");
}
esri("Canvas/World_Dark_Gray_Reference", { pane: "labels", attribution: "" }).addTo(map);
map.attributionControl.addAttribution('Heat: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> MODIS · <a href="https://power.larc.nasa.gov">NASA POWER</a>');

let world = /** @type {any} */ (null);
const worldDate = isoDay(Date.now() - 20 * DAY);
api("/api/colormap?name=MODIS_Land_Surface_Temp").then(({ entries }) => {
  world = new HeatTiles(worldDate, entries, { pane: "heat", opacity: 0.78 });
  if (!state.place || state.layers.world) { world.addTo(map); state.layers.world = true; syncChips(); updateLegend(); }
  $("#intro-foot").textContent = `Background: NASA MODIS daytime land surface temperature, 8-day composite around ${day(worldDate)}.`;
}).catch(() => { $("#intro-foot").textContent = "Couldn't reach NASA GIBS for the background layer."; });

let pulse = /** @type {any} */ (null);
let spotLayer = L.layerGroup().addTo(map);
let priorityMarkers = L.layerGroup();
let refugeLayer = L.layerGroup();
let satOverlay = /** @type {any} */ (null), satOverlayKey = "";
let priorityOverlay = /** @type {any} */ (null);
let landsat = /** @type {any} */ (null), landsatOverlay = /** @type {any} */ (null);

let clickTimer = 0;
map.on("click", (e) => {
  clearTimeout(clickTimer);
  clickTimer = window.setTimeout(() => {
    const ll = e.latlng.wrap();
    selectPlace({ lat: ll.lat, lon: ll.lng, label: null }, { zoom: Math.max(map.getZoom(), 9) });
  }, 260);
});
map.on("dblclick", () => clearTimeout(clickTimer));

// Hover readout: the value under the cursor from whichever heat layer is showing.
const readout = $("#readout");
map.on("mousemove", (e) => {
  const v = valueAt(e.latlng);
  if (!v) { readout.hidden = true; return; }
  readout.replaceChildren(h("b", {}, v.value), v.note ? h("small", {}, v.note) : null);
  readout.hidden = false;
  const x = e.originalEvent.clientX, y = e.originalEvent.clientY;
  readout.style.left = Math.min(innerWidth - readout.offsetWidth - 8, x + 16) + "px";
  readout.style.top = Math.max(8, y - readout.offsetHeight - 10) + "px";
});
map.on("mouseout", () => { readout.hidden = true; });

function valueAt(raw) {
  const u = state.unit, ll = raw.wrap();
  if (state.layers.landsat && landsat) {
    const [x0, y0, x1, y1] = landsat.bbox;
    if (ll.lng >= x0 && ll.lng <= x1 && ll.lat >= y0 && ll.lat <= y1) {
      const col = Math.floor((ll.lng - x0) / landsat.res), row = Math.floor((y1 - ll.lat) / landsat.res);
      const i = row * landsat.width + col, t = landsat.lst_f_x10[i];
      if (t != null && !landsat.water[i]) return { value: `${tF(t / 10, u)} ground`, note: `Landsat 50 m · NDVI ${(landsat.ndvi_x100[i] / 100).toFixed(2)}` };
    }
  }
  const sat = activeSat();
  if (sat && state.layers.heat && satOverlay && map.hasLayer(satOverlay)) {
    const p = map.project(ll, 7);
    const px = Math.floor(p.x - sat.x0), py = Math.floor(p.y - sat.y0);
    if (px >= 0 && py >= 0 && px < sat.width && py < sat.height) {
      const i = py * sat.width + px, vals = currentValues(sat), v = vals[i];
      if (Number.isFinite(v)) {
        const cover = sat.cover?.[i], n = sat.ndviV?.[i];
        const bits = [Number.isFinite(n) ? `NDVI ${n.toFixed(2)}` : null, cover != null && cover !== 255 ? COVER[cover] : null].filter(Boolean);
        const t = state.view.t;
        const filled = t != null && sat.frames[Math.round(t)]?.f10[i] == null;
        return { value: `${tF(v, u)} surface`, note: `${state.view.layer === "night" ? "night" : "10:30 AM"}${t == null ? " · season avg" : filled ? " · cloudy that week, filled in" : ""}${bits.length ? " · " + bits.join(" · ") : ""}` };
      }
    }
  }
  if (world && map.hasLayer(world)) {
    const v = world.valueAt(ll, map);
    if (v != null) return { value: `${tF(v, u)} surface`, note: `MODIS 8-day around ${day(worldDate)}` };
  }
  return null;
}
const COVER = { 1: "evergreen forest", 2: "evergreen forest", 3: "deciduous forest", 4: "deciduous forest", 5: "mixed forest", 6: "shrubland", 7: "shrubland", 8: "woody savanna", 9: "savanna", 10: "grassland", 11: "wetland", 12: "cropland", 13: "built-up", 14: "cropland mosaic", 15: "snow/ice", 16: "barren", 17: "water", 0: "water" };

// ---------------------------------------------------------------- intro & search
let drift = 0;
function startDrift() {
  if (reducedMotion()) return;
  const step = () => {
    if (!document.body.classList.contains("intro-on")) return;
    map.panBy([0.35, 0], { animate: false });
    drift = requestAnimationFrame(step);
  };
  drift = requestAnimationFrame(step);
}
function hideIntro() {
  const intro = $("#intro");
  if (intro.classList.contains("gone")) return;
  intro.classList.add("gone");
  document.body.classList.remove("intro-on");
  cancelAnimationFrame(drift);
  map.setView(map.getCenter().wrap(), map.getZoom(), { animate: false });
  setTimeout(() => { intro.hidden = true; }, 800);
}
document.body.classList.add("intro-on");
startDrift();

$("#quick").append(...QUICK.map((q) => h("button", { type: "button", class: "ripple", onclick: () => selectPlace({ lat: q.lat, lon: q.lon, label: q.label }, { zoom: q.zoom ?? 9.5 }) },
  q.label, q.tag ? h("b", {}, q.tag) : null)));

/** @param {HTMLInputElement} input @param {HTMLElement|null} list */
async function runSearch(input, list) {
  const q = input.value.trim();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { selectPlace({ lat: +m[1], lon: +m[2], label: null }); return; }
  input.disabled = true;
  try {
    const { places } = await api(`/api/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent((navigator.language || "en").slice(0, 2))}`);
    if (!places.length) { toast(`Couldn't find “${q}”. Try a city or full address.`); return; }
    if (places.length === 1 || !list) { pick(places[0]); return; }
    showResults(list, places, input);
  } catch (e) {
    toast(e instanceof Error ? e.message : "Search failed");
  } finally {
    input.disabled = false;
  }
  function pick(p) {
    if (list) list.hidden = true;
    input.value = "";
    input.blur();
    selectPlace({ lat: p.lat, lon: p.lon, label: p.label, detail: p.detail }, { zoom: zoomFor(p.bbox) });
  }
  function showResults(ul, places, inp) {
    ul.replaceChildren(...places.map((p, i) => h("li", { role: "option", "aria-selected": i === 0 ? "true" : "false", onclick: () => pick(p) }, p.label, h("small", {}, p.detail))));
    ul.hidden = false;
    let sel = 0;
    const onKey = (e) => {
      if (ul.hidden) return inp.removeEventListener("keydown", onKey);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + places.length) % places.length;
        [...ul.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === sel)));
      } else if (e.key === "Enter") { e.preventDefault(); pick(places[sel]); inp.removeEventListener("keydown", onKey); }
      else if (e.key === "Escape") { ul.hidden = true; inp.removeEventListener("keydown", onKey); }
    };
    inp.addEventListener("keydown", onKey);
  }
}
const zoomFor = (bbox) => {
  if (!bbox) return 10;
  const span = Math.max(bbox[2] - bbox[0], (bbox[3] - bbox[1]) * Math.cos((bbox[0] * Math.PI) / 180));
  return span > 1.5 ? 8.5 : span > 0.4 ? 9.5 : span > 0.05 ? 12 : 14;
};
$("#search").addEventListener("submit", (e) => { e.preventDefault(); runSearch(/** @type {any} */ ($("#q")), $("#results")); });
$("#search-big").addEventListener("submit", (e) => { e.preventDefault(); runSearch(/** @type {any} */ ($("#q-big")), null); });
document.addEventListener("click", (e) => { if (!(/** @type {HTMLElement} */ (e.target)).closest(".search")) $("#results").hidden = true; });

function locate() {
  if (!navigator.geolocation) { toast("Location isn't available in this browser."); return; }
  toast("Finding you…", 1800);
  navigator.geolocation.getCurrentPosition(
    (p) => selectPlace({ lat: p.coords.latitude, lon: p.coords.longitude, label: null }, { zoom: 12 }),
    () => toast("Couldn't get your location. Search or click the map instead."),
    { enableHighAccuracy: false, timeout: 10_000 },
  );
}
$("#locate").addEventListener("click", locate);
$("#locate-big").addEventListener("click", locate);

// ---------------------------------------------------------------- selecting a place
/** @param {{ lat: number, lon: number, label: string|null, detail?: string }} p */
async function selectPlace(p, { fly = true, zoom = 10, year = /** @type {number|null} */ (null), season = /** @type {any} */ (null), tab = /** @type {string|null} */ (null) } = {}) {
  const token = ++state.token;
  stopPlay();
  Object.assign(state, {
    place: p, history: null, historyError: null, block: null, live: null, liveError: null, refuges: null,
    sat: { day: null, night: null, error: null, key: "", loading: false }, view: { layer: "day", t: null, playing: false },
  });
  if (season != null) state.seasonMode = season;
  if (year != null) state.year = year;
  state.layers.night = false;
  state.layers.refuges = false;
  hideIntro();
  if (world && map.hasLayer(world)) map.removeLayer(world);
  state.layers.world = false;
  syncChips();
  clearRegion();
  refugeLayer.clearLayers();
  if (pulse) pulse.setLatLng([p.lat, p.lon]);
  else pulse = L.marker([p.lat, p.lon], { icon: pulseIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
  showPanel();
  if (fly) {
    sfx.whoosh();
    haptic();
    flyToVisible([p.lat, p.lon], zoom, reducedMotion() ? 0.01 : 2.1);
  }
  if (tab) switchTab(tab, false);
  renderPlace();
  renderAll();
  updateHash();

  if (!p.label) {
    api(`/api/reverse?lat=${p.lat}&lon=${p.lon}&lang=${(navigator.language || "en").slice(0, 2)}`).then((r) => {
      if (token !== state.token) return;
      p.label = r.label ?? `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
      renderPlace();
      updateHash();
    }).catch(() => { p.label = `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`; renderPlace(); });
  }
  loadLive(token);
  api(`/api/block?lat=${p.lat}&lon=${p.lon}`).then((b) => {
    if (token !== state.token || !b.reading) return;
    state.block = b;
    $('[data-layer="landsat"]').hidden = false;
    renderCooling();
    toggleLayer("landsat", true);
  }).catch(() => {});

  try {
    state.history = await api(`/api/climate?lat=${p.lat}&lon=${p.lon}`);
  } catch (e) {
    if (token !== state.token) return;
    state.historyError = e instanceof Error ? e.message : String(e);
  }
  if (token !== state.token) return;
  computeSeason();
  renderSeasonControls();
  renderSummer();
  renderClimate();
  renderCooling();
  loadSatellite("day");
}

/** Flies so the point lands in the middle of the part of the map the panel doesn't cover. */
function flyToVisible(latlng, zoom, duration = 1.4) {
  const panel = $("#panel");
  let dx = 0, dy = 0;
  if (!panel.hidden) {
    const r = panel.getBoundingClientRect();
    if (r.width < innerWidth * 0.9) dx = r.width / 2;
    else dy = r.height / 2;
  }
  const target = map.unproject(map.project(latlng, zoom).add([dx, dy]), zoom);
  map.flyTo(target, zoom, { duration, easeLinearity: 0.2 });
}

function clearRegion() {
  for (const o of [satOverlay, priorityOverlay, landsatOverlay]) if (o && map.hasLayer(o)) map.removeLayer(o);
  satOverlay = null; satOverlayKey = ""; priorityOverlay = null;
  if (landsatOverlay) state.layers.landsat = false;
  spotLayer.clearLayers();
  priorityMarkers.clearLayers();
  $('[data-layer="landsat"]').hidden = true;
  $("#hud").hidden = true;
}

// ---------------------------------------------------------------- seasons
const thresholds = () => ({ ...(state.localTh ?? A.thresholds(state.unit)), ...(state.hot != null ? { hot: state.hot } : {}) });

function computeSeason() {
  const h0 = state.history, lat = state.place?.lat ?? 40;
  if (h0) {
    state.startMonth = state.seasonMode === "auto" ? A.hottestSeason(h0).startMonth : state.seasonMode;
    state.years = A.seasonYears(h0, state.startMonth);
  } else {
    // No air-temperature history: fall back to the astronomical summer and complete seasons only.
    state.startMonth = state.seasonMode === "auto" ? (lat >= 0 ? 5 : 11) : state.seasonMode;
    const now = new Date(), endYear = now.getUTCFullYear();
    state.years = [];
    for (let y = 2001; y <= endYear; y++) {
      const startYear = state.startMonth + 2 >= 12 ? y - 1 : y;
      if (Date.UTC(startYear, state.startMonth + 3, 7) < now.getTime()) state.years.push(y);
    }
  }
  if (state.year == null || !state.years.includes(state.year)) state.year = state.years[state.years.length - 1] ?? null;
  if (!h0 || state.year == null) { state.series = []; state.normals = null; state.days = []; state.summary = null; return; }
  state.localTh = A.localThresholds(h0, state.startMonth, state.unit);
  const th = thresholds();
  state.series = A.seasonSeries(h0, state.startMonth, th);
  state.normals = A.normals(h0, state.startMonth, state.series);
  state.days = A.seasonDays(h0, state.startMonth, state.year);
  state.summary = A.summarize(state.days, th);
}

function seasonDates(year = state.year) {
  const sm = state.startMonth, startYear = sm + 2 >= 12 ? /** @type {number} */ (year) - 1 : /** @type {number} */ (year);
  return { start: isoDay(Date.UTC(startYear, sm, 1)), end: isoDay(Date.UTC(startYear, sm + 3, 1) - DAY) };
}
const yearLabel = (y) => (state.startMonth + 2 >= 12 ? `${y - 1}–${String(y).slice(2)}` : String(y));

function renderSeasonControls() {
  const sel = /** @type {HTMLSelectElement} */ ($("#year"));
  sel.replaceChildren(...[...state.years].reverse().map((y) => h("option", { value: y, selected: y === state.year }, `${yearLabel(y)} summer`)));
  const ss = /** @type {HTMLSelectElement} */ ($("#season"));
  const auto = state.history ? A.hottestSeason(state.history) : null;
  ss.replaceChildren(
    h("option", { value: "auto", selected: state.seasonMode === "auto" }, auto ? `Auto: ${auto.label}` : "Auto"),
    ...Array.from({ length: 12 }, (_, m) => h("option", { value: m, selected: state.seasonMode === m }, A.seasonLabel(m))));
  /** @type {HTMLButtonElement} */ ($("#prev-year")).disabled = state.years.indexOf(/** @type {number} */ (state.year)) <= 0;
  /** @type {HTMLButtonElement} */ ($("#next-year")).disabled = state.years.indexOf(/** @type {number} */ (state.year)) >= state.years.length - 1;
}

function setYear(y) {
  if (y === state.year || !state.years.includes(y)) return;
  state.year = y;
  sfx.tick();
  stopPlay();
  computeSeason();
  renderSeasonControls();
  resetSatellite();
  renderAll();
  updateHash();
  loadSatellite("day");
}
function resetSatellite() {
  state.sat = { day: null, night: null, error: null, key: "", loading: false };
  state.view = { layer: "day", t: null, playing: false };
  state.layers.night = false;
  clearSatLayers();
  syncChips();
}
function clearSatLayers() {
  for (const o of [satOverlay, priorityOverlay]) if (o && map.hasLayer(o)) map.removeLayer(o);
  satOverlay = null; satOverlayKey = ""; priorityOverlay = null;
  spotLayer.clearLayers();
  priorityMarkers.clearLayers();
}
$("#year").addEventListener("change", (e) => setYear(Number(/** @type {HTMLSelectElement} */ (e.target).value)));
$("#prev-year").addEventListener("click", () => setYear(state.years[state.years.indexOf(/** @type {number} */ (state.year)) - 1]));
$("#next-year").addEventListener("click", () => setYear(state.years[state.years.indexOf(/** @type {number} */ (state.year)) + 1]));
$("#season").addEventListener("change", (e) => {
  const v = /** @type {HTMLSelectElement} */ (e.target).value;
  state.seasonMode = v === "auto" ? "auto" : Number(v);
  const y = state.year;
  computeSeason();
  state.year = state.years.includes(/** @type {number} */ (y)) ? y : state.years[state.years.length - 1];
  computeSeason();
  renderSeasonControls();
  resetSatellite();
  renderAll();
  updateHash();
  loadSatellite("day");
});

// ---------------------------------------------------------------- panel & tabs
function showPanel() {
  const panel = $("#panel");
  if (panel.hidden) { panel.hidden = false; requestAnimationFrame(moveInk); }
}
function switchTab(tab, sound = true) {
  state.tab = tab;
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute("aria-selected", String(/** @type {HTMLElement} */ (b).dataset.tab === tab)));
  document.querySelectorAll('[role="tabpanel"]').forEach((s) => { /** @type {HTMLElement} */ (s).hidden = s.id !== `tab-${tab}`; });
  moveInk();
  if (sound) { sfx.tick(); haptic(6); }
  $("#tab-body").scrollTop = 0;
  // Charts size to their container, so draw the newly visible tab now.
  ({ summer: renderSummer, satellite: renderSatellite, cooling: renderCooling, climate: renderClimate, live: renderLive })[tab]?.();
  syncPriorityMarkers();
  updateHash();
}
function moveInk() {
  const b = /** @type {HTMLElement|null} */ (document.querySelector('[role="tab"][aria-selected="true"]'));
  const ink = $("#tab-ink");
  if (!b) return;
  ink.style.left = b.offsetLeft + 8 + "px";
  ink.style.width = b.offsetWidth - 16 + "px";
}
document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener("click", () => switchTab(/** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.tab))));
$("#handle").addEventListener("click", () => {
  const p = $("#panel");
  if (p.classList.contains("expanded")) { p.classList.remove("expanded"); p.classList.add("peek"); }
  else if (p.classList.contains("peek")) p.classList.remove("peek");
  else p.classList.add("expanded");
  sfx.tick();
  setTimeout(() => map.invalidateSize(), 460);
});

function renderPlace() {
  const p = state.place;
  if (!p) return;
  $("#place-name").textContent = p.label ?? "Locating…";
  const coords = `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? "N" : "S"}, ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? "E" : "W"}`;
  $("#place-detail").textContent = p.detail ? `${p.detail} · ${coords}` : coords;
  document.title = `${p.label ?? "Heat"} · CoolBlock Heat Explorer`;
}

function renderAll() {
  renderSummer(); renderSatellite(); renderCooling(); renderClimate(); renderLive();
}

const tabEl = (name) => $(`#tab-${name}`);
const visible = (name) => state.tab === name;
const skeleton = (heights) => heights.map((hgt) => h("div", { class: "skel", style: { height: hgt + "px" } }));
const errorBox = (title, msg, retry) => h("div", { class: "err" }, h("b", {}, title), msg, retry ? h("div", { style: { marginTop: "10px" } }, h("button", { class: "btn small ripple", onclick: retry }, "Try again")) : null);
const source = (text) => h("p", { class: "source" }, text);

// ---------------------------------------------------------------- Summer tab
function renderSummer() {
  const el = tabEl("summer");
  if (!state.place) return;
  if (state.historyError) {
    el.replaceChildren(errorBox("NASA POWER didn't answer", state.historyError, () => state.place && selectPlace(state.place, { fly: false })));
    return;
  }
  if (!state.history) { el.replaceChildren(h("p", { class: "loading-note" }, "Pulling 45 years of daily temperatures from NASA POWER…"), ...skeleton([150, 250, 120])); return; }
  if (!state.summary) { el.replaceChildren(h("div", { class: "empty" }, "No complete summer on record here yet.")); return; }
  if (!visible("summer")) { el.dataset.stale = "1"; return; }
  const u = state.unit, s = state.summary, n = state.normals, th = thresholds();
  const { start, end } = seasonDates();
  const rk = A.rankOf(state.series, /** @type {number} */ (state.year));
  const shown = (c) => Math.round(fromC(c, u));
  const diff = n ? shown(s.avgHigh) - shown(n.avgHigh) : null;

  const heroNum = h("span", { class: "hero-num" }, "0");
  const localHot = state.hot == null && th.localHot, localNight = th.localNight;
  const hotKpi = kpi(`Days ≥ ${th.hot}°${u}`, String(s.hotDays), [localHot ? "local top 10%" : null, n ? `normal ${Math.round(n.hotDays)}` : null].filter(Boolean).join(" · "));
  const waveKpi = kpi("Longest heat wave", s.longestWave ? plural(s.longestWave, "day") : "None", `3+ days ≥ ${th.hot}°${u}`);
  const card1 = h("div", { class: "card" },
    h("p", { class: "eyebrow" }, `Summer ${yearLabel(state.year)} · ${range(start, end)}`),
    h("div", { class: "hero-row" },
      heroNum,
      h("div", {},
        diff != null ? h("span", { class: `delta ${diff > 0 ? "up" : diff < 0 ? "down" : ""}` }, h("span", { class: "arrow" }, diff > 0 ? "▲" : diff < 0 ? "▼" : "●"), `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff)}°${u} vs 1991–2020`) : null,
        h("div", { class: "hero-cap" }, `average daily high · average low ${tC(s.avgLow, u)}`))),
    h("div", { class: "kpis" },
      kpi("Hottest day", tC(s.hottest?.c, u), s.hottest ? day(s.hottest.date) : ""),
      hotKpi,
      kpi(`Nights ≥ ${th.night}°${u}`, String(s.warmNights), [localNight ? "local top 10%" : null, n ? `normal ${Math.round(n.warmNights)}` : null].filter(Boolean).join(" · ")),
      waveKpi,
      kpi("Peak heat index", tC(s.peakHeatIndex?.c, u), s.peakHeatIndex ? `${day(s.peakHeatIndex.date)} · ${A.heatRisk(s.peakHeatIndex.c).label}` : ""),
      kpi("Cooling demand", `${Math.round(s.cddF).toLocaleString()}`, n && n.cddF > 0 ? `°F·days · ${pct(s.cddF / n.cddF - 1)} vs normal` : "°F·degree-days")));
  countUp(heroNum, shown(s.avgHigh), { format: (v) => `${Math.round(v)}°${u}`, duration: 1100 });

  const chartHost = h("div", {});
  const lo0 = u === "F" ? 80 : 27, hi0 = u === "F" ? 110 : 43;
  const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: Math.min(lo0, th.hot - 10), max: Math.max(hi0, th.hot + 8), step: 1, value: th.hot, "aria-label": "Hot-day threshold" }));
  const sliderVal = h("b", {}, `${th.hot}°${u}`);
  setFill(slider);
  slider.addEventListener("input", () => {
    state.hot = Number(slider.value);
    sliderVal.textContent = `${state.hot}°${u}`;
    setFill(slider);
    state.summary = A.summarize(state.days, thresholds());
    hotKpi.querySelector(".label").textContent = `Days ≥ ${state.hot}°${u}`;
    hotKpi.querySelector(".value").textContent = String(state.summary.hotDays);
    waveKpi.querySelector(".value").textContent = state.summary.longestWave ? plural(state.summary.longestWave, "day") : "None";
    waveKpi.querySelector(".note").textContent = `3+ days ≥ ${state.hot}°${u}`;
    sfx.tick();
    drawChart();
  });
  slider.addEventListener("change", () => {
    state.series = A.seasonSeries(state.history, state.startMonth, thresholds());
    state.normals = A.normals(state.history, state.startMonth, state.series);
    renderSummer();
    renderClimate();
  });
  const drawChart = () => dailyChart(chartHost, { days: state.days, normals: state.normals, unit: u, hot: thresholds().hot, waves: state.summary.heatWaves, hottest: state.summary.hottest });
  const card2 = h("div", { class: "card" },
    h("h3", {}, "Every day of the summer"),
    h("p", { class: "sub" }, "Daily highs and lows against the 1991–2020 normal. Hover or use ← → for any day."),
    chartHost,
    h("div", { class: "slider-row" }, h("span", {}, "Hot-day line"), slider, sliderVal));

  const card3 = h("div", { class: "card" }, h("h3", {}, "Month by month"),
    h("table", { class: "month-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Month"), h("th", {}, "Avg high"), h("th", {}, "Avg low"))),
      h("tbody", {}, ...s.monthly.map((m) => h("tr", {}, h("td", {}, m.label), h("td", {}, tC(m.avgHigh, u)), h("td", {}, tC(m.avgLow, u)))))));

  const lines = [];
  const b = (t) => h("b", {}, t);
  lines.push(h("li", {}, `Summer ${yearLabel(state.year)} averaged `, b(tC(s.avgHigh, u)), " highs",
    diff != null ? [", ", b(diff === 0 ? "right at" : `${Math.abs(diff)}°${u} ${diff > 0 ? "warmer" : "cooler"} than`), " the 1991–2020 normal"] : "",
    rk ? [", the ", b(`${rk.rank === 1 ? "" : ordinal(rk.rank) + " "}hottest`), ` of ${rk.of} summers since ${state.series[0].year}`] : "", "."));
  if (s.heatWaves.length) {
    const w = s.heatWaves.reduce((a, x) => (x.days > a.days ? x : a));
    lines.push(h("li", {}, b(plural(s.heatWaves.length, "heat wave")), ` (3+ days in a row ≥ ${th.hot}°${u}). The longest ran `, b(`${range(w.start, w.end)}`), `, peaking at ${tC(w.peakC, u)}.`));
  } else lines.push(h("li", {}, "No heat waves ", `(3+ days in a row ≥ ${th.hot}°${u}).`));
  if (localHot && state.localTh) lines.push(h("li", {}, `Here a typical summer day already passes ${A.thresholds(u).hot}°${u}, so a hot day means `, b(`${th.hot}°${u} or more`), ", this place's own hottest 10% of 1991–2020 summer days."));
  lines.push(h("li", {}, b(plural(s.warmNights, "night")), ` stayed at or above ${th.night}°${u}`, n ? ` (normal: ${Math.round(n.warmNights)})` : "", ". Nights that don't cool off are among the biggest heat-health risks."));
  if (s.peakHeatIndex) lines.push(h("li", {}, `The most oppressive day, ${day(s.peakHeatIndex.date)}, had a heat index of `, b(tC(s.peakHeatIndex.c, u)), ` (National Weather Service: ${A.heatRisk(s.peakHeatIndex.c).label}).`));
  if (n && n.cddF > 0) {
    const ch = s.cddF / n.cddF - 1;
    lines.push(h("li", {}, "Air conditioners faced ", b(`${pct(Math.abs(ch), false)} ${ch >= 0 ? "more" : "less"}`), " cooling demand than in a normal summer (cooling degree-days)."));
  }
  const card4 = h("div", { class: "card" }, h("h3", {}, "What this summer meant"), h("ul", { class: "narrative" }, ...lines));
  el.replaceChildren(card1, card2, card3, card4,
    source(`Air temperature at 2 m from ${state.history.source}, cell centred ${state.history.cell.lat}°, ${state.history.cell.lon}°. Heat index from daily high and dew point (NWS formula). Data through ${day(state.history.end)} ${state.history.end.slice(0, 4)}.`));
  requestAnimationFrame(drawChart);
  delete el.dataset.stale;
}
const kpi = (label, value, note) => h("div", { class: "kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), note ? h("div", { class: "note" }, note) : null);
const pct = (x, signed = true) => `${signed ? (x > 0 ? "+" : x < 0 ? "−" : "±") : ""}${Math.round(Math.abs(x) * 100)}%`;
const setFill = (input) => {
  const min = Number(input.min), max = Number(input.max), v = Number(input.value);
  input.style.setProperty("--fill", `${((v - min) / (max - min || 1)) * 100}%`);
};

// ---------------------------------------------------------------- satellite data
const scanMsgs = ["Scanning NASA satellite archive…", "Fetching MODIS 8-day composites…", "Decoding 1 km land surface temperature…", "Reading vegetation and land cover…"];
let scanTimer = 0;
function showScan(on) {
  const sc = $("#scan");
  clearInterval(scanTimer);
  sc.hidden = !on;
  if (!on) return;
  let i = 0;
  $("#scan-text").textContent = scanMsgs[0];
  scanTimer = window.setInterval(() => { $("#scan-text").textContent = scanMsgs[++i % scanMsgs.length]; }, 1400);
}

async function loadSatellite(layer) {
  const p = state.place;
  if (!p || state.year == null) return;
  const { start, end } = seasonDates();
  if (start < "2000-03-01") { state.sat.error = "MODIS satellite records start in 2000. Pick a later summer for the satellite view."; renderSatellite(); renderCooling(); return; }
  const key = `${p.lat},${p.lon},${start},${end}`;
  if (state.sat[layer] && state.sat.key === key) { showSatLayer(); return; }
  state.sat.key = key;
  state.sat.loading = true;
  state.sat.error = null;
  showScan(true);
  try {
    const res = await api(`/api/satellite?lat=${p.lat}&lon=${p.lon}&start=${start}&end=${end}&layer=${layer}`);
    if (state.sat.key !== key) return;
    state.sat[layer] = prepareSat(res);
    sfx.ping();
    if (layer === "day" && state.sat.day.stats.here && state.sat.day.stats.here.percentile >= 80) setTimeout(() => sfx.sizzle(), 700);
  } catch (e) {
    if (state.sat.key !== key) return;
    state.sat.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (state.sat.key === key) { state.sat.loading = false; showScan(false); }
  }
  if (state.sat.key !== key) return;
  showSatLayer(true);
  renderSatellite();
  renderCooling();
}

function prepareSat(res) {
  const framesF = A.gapFill(res.frames.map((f) => f.f10));
  const water = (i) => res.cover && (res.cover[i] === 0 || res.cover[i] === 17);
  const meanF = Float32Array.from(res.mean, (v, i) => (v == null || water(i) ? NaN : v / 10));
  for (const f of framesF) for (let i = 0; i < f.length; i++) if (water(i)) f[i] = NaN;
  const ndviV = res.ndvi ? Float32Array.from(res.ndvi, (v) => (v == null ? NaN : v / 100)) : null;
  const vals = Array.from(meanF).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const nw = map.project(L.latLng(res.bounds[2], res.bounds[1]), 7);
  return { ...res, framesF, meanF, ndviV, lo: q(0.02), hi: q(0.98), x0: Math.round(nw.x), y0: Math.round(nw.y), buf: new Float32Array(meanF.length) };
}
const activeSat = () => state.sat[state.view.layer] ?? null;

function currentValues(sat) {
  const t = state.view.t;
  if (t == null || !sat.framesF.length) return sat.meanF;
  const i0 = Math.floor(t), i1 = Math.min(sat.framesF.length - 1, i0 + 1), k = t - i0;
  const a = sat.framesF[i0], b = sat.framesF[i1], out = sat.buf;
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}

function showSatLayer(reveal = false) {
  const sat = activeSat();
  $("#hud").hidden = !state.sat.day;
  if (!sat) return;
  const key = `${state.view.layer}/${sat.start}/${sat.bounds.join(",")}`;
  if (satOverlayKey !== key) {
    if (satOverlay) map.removeLayer(satOverlay);
    const [s0, w0, n0, e0] = sat.bounds;
    satOverlay = new CanvasOverlay([[s0, w0], [n0, e0]], sat.width, sat.height, { pane: "heat", className: "heat-overlay", interactive: false });
    satOverlayKey = key;
    if (state.layers.heat) satOverlay.addTo(map);
    if (state.layers.landsat) satOverlay.setOpacity(0.45);
    if (reveal && !reducedMotion()) {
      const el = satOverlay.getElement();
      el?.classList.add("scanning");
      setTimeout(() => el?.classList.remove("scanning"), 1600);
    }
  }
  drawSat();
  buildTimeline();
  placeSpots();
  if (state.layers.priority) drawPriority();
  updateLegend();
}

function drawSat() {
  const sat = activeSat();
  if (!sat || !satOverlay) return;
  satOverlay.draw(currentValues(sat), sat.lo, sat.hi, 215);
  updateTimelineLabel();
}

// ---------------------------------------------------------------- timeline animation
const tl = /** @type {HTMLInputElement} */ ($("#tl"));
function buildTimeline() {
  const sat = activeSat();
  if (!sat) return;
  const n = sat.frames.length;
  tl.max = String(Math.max(0, n - 1));
  tl.value = String(state.view.t ?? 0);
  setTlFill();
  const ticks = $("#tl-ticks");
  ticks.replaceChildren(...sat.frames.flatMap((f, i) => {
    const prev = sat.frames[i - 1];
    if (prev && prev.date.slice(0, 7) === f.date.slice(0, 7)) return [];
    return [h("span", { style: { left: `${(i / Math.max(1, n - 1)) * 100}%` } }, A.MONTHS[Number(f.date.slice(5, 7)) - 1])];
  }));
  $("#tl-avg").setAttribute("aria-pressed", String(state.view.t == null));
}
function setTlFill() { tl.style.setProperty("--fill", `${(Number(tl.value) / Math.max(1, Number(tl.max))) * 100}%`); }
function updateTimelineLabel() {
  const sat = activeSat();
  if (!sat) return;
  const t = state.view.t;
  const kind = state.view.layer === "night" ? "night (~10:30 PM)" : "day (~10:30 AM)";
  if (t == null) {
    $("#tl-label").textContent = "Summer average";
    $("#tl-sub").textContent = `${sat.frames.length} satellite composites · ${kind}`;
  } else {
    const f = sat.frames[Math.round(t)];
    const endT = Math.min(Date.parse(f.date + "T00:00:00Z") + 7 * DAY, Date.parse(sat.end + "T00:00:00Z"));
    $("#tl-label").textContent = range(f.date, isoDay(endT));
    $("#tl-sub").textContent = `8-day composite · ${kind} · ${Math.round(f.coverage * 100)}% clear`;
  }
}
let raf = 0, lastFrame = 0;
function play() {
  const sat = activeSat();
  if (!sat || sat.frames.length < 2) return;
  state.view.playing = true;
  if (state.view.t == null || state.view.t >= sat.frames.length - 1) state.view.t = 0;
  $("#play").textContent = "❚❚";
  $("#play").classList.add("playing");
  $("#play").setAttribute("aria-label", "Pause");
  $("#tl-avg").setAttribute("aria-pressed", "false");
  sfx.pop();
  lastFrame = performance.now();
  let lastWhole = Math.floor(state.view.t);
  const step = (now) => {
    if (!state.view.playing) return;
    const s2 = activeSat();
    if (!s2) return stopPlay();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    let t = /** @type {number} */ (state.view.t) + dt * 1.6;
    if (t > s2.frames.length - 1) t = 0;
    state.view.t = t;
    if (Math.floor(t) !== lastWhole) { lastWhole = Math.floor(t); sfx.tick(); }
    tl.value = String(t);
    setTlFill();
    drawSat();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stopPlay() {
  state.view.playing = false;
  cancelAnimationFrame(raf);
  const btn = $("#play");
  btn.textContent = "▶";
  btn.classList.remove("playing");
  btn.setAttribute("aria-label", "Play the summer");
}
$("#play").addEventListener("click", () => (state.view.playing ? stopPlay() : play()));
tl.addEventListener("input", () => {
  stopPlay();
  state.view.t = Number(tl.value);
  $("#tl-avg").setAttribute("aria-pressed", "false");
  setTlFill();
  drawSat();
});
$("#tl-avg").addEventListener("click", () => {
  stopPlay();
  state.view.t = null;
  tl.value = "0";
  setTlFill();
  $("#tl-avg").setAttribute("aria-pressed", "true");
  sfx.tick();
  drawSat();
});

// ---------------------------------------------------------------- legend & layers
function updateLegend() {
  const u = state.unit;
  let lo, hi, title, grad = gradientCss();
  if (state.layers.priority && state.sat.day) {
    title = "Tree priority: hot and bare (built-up land)";
    grad = "linear-gradient(90deg, rgba(95,211,141,.15), #5fd38d, #eaffb0)";
    $("#legend-lo").textContent = "lower";
    $("#legend-mid").textContent = "";
    $("#legend-hi").textContent = "plant here first";
    $("#legend-title").textContent = title;
    $("#legend-bar").style.background = grad;
    return;
  }
  if (state.layers.landsat && landsat) {
    lo = landsat.stats.lst_p10_f; hi = landsat.stats.lst_p90_f;
    title = `Landsat 50 m ground temperature, summers ${landsat.dates[0].slice(0, 4)}–${landsat.dates.at(-1).slice(0, 4)}`;
  } else if (activeSat() && state.layers.heat) {
    const sat = activeSat();
    lo = sat.lo; hi = sat.hi;
    title = `Surface temperature, ${state.view.layer === "night" ? "night" : "10:30 AM"} · MODIS 1 km`;
  } else if (world && map.hasLayer(world)) {
    lo = world.options.lo; hi = world.options.hi;
    title = "World surface temperature · MODIS 8-day";
  } else return;
  $("#legend-title").textContent = title;
  $("#legend-bar").style.background = grad;
  $("#legend-lo").textContent = tF(lo, u);
  $("#legend-mid").textContent = tF((lo + hi) / 2, u);
  $("#legend-hi").textContent = tF(hi, u);
}

function syncChips() {
  document.querySelectorAll("[data-layer]").forEach((b) => {
    const k = /** @type {HTMLElement} */ (b).dataset.layer;
    b.setAttribute("aria-pressed", String(!!state.layers[/** @type {keyof typeof state.layers} */ (k)]));
  });
}

async function toggleLayer(name, on = !state.layers[name]) {
  state.layers[name] = on;
  sfx.tick();
  if (name === "heat") { if (satOverlay) on ? satOverlay.addTo(map) : map.removeLayer(satOverlay); }
  if (name === "night") {
    stopPlay();
    state.view.layer = on ? "night" : "day";
    state.view.t = null;
    if (on && !state.sat.night) await loadSatellite("night");
    else showSatLayer(true);
    renderSatellite();
  }
  if (name === "priority") {
    if (on) { drawPriority(); if (!state.sat.day) toast("Tree priority needs the satellite view to finish loading."); }
    else if (priorityOverlay) map.removeLayer(priorityOverlay);
    syncPriorityMarkers();
  }
  if (name === "landsat") await showLandsat(on);
  if (name === "refuges") {
    if (on) { refugeLayer.addTo(map); if (!state.refuges) loadRefuges(); }
    else map.removeLayer(refugeLayer);
  }
  if (name === "imagery") {
    if (on) { map.removeLayer(base); imagery.addTo(map); imagery.bringToBack(); }
    else { map.removeLayer(imagery); base.addTo(map); base.bringToBack(); }
  }
  if (name === "world" && world) on ? world.addTo(map) : map.removeLayer(world);
  syncChips();
  updateLegend();
}
document.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => toggleLayer(/** @type {any} */ (/** @type {HTMLElement} */ (b).dataset.layer))));

// ---------------------------------------------------------------- hottest / coolest / priority markers
function placeSpots() {
  spotLayer.clearLayers();
  const sat = activeSat();
  if (!sat) return;
  const u = state.unit;
  for (const [kind, sp, word] of [["hot", sat.stats.hottest, "Hottest"], ["cool", sat.stats.coolest, "Coolest"]]) {
    if (!sp) continue;
    const m = L.marker([sp.lat, sp.lon], { icon: spotIcon(kind), keyboard: false, title: `${word} spot in the region` }).addTo(spotLayer);
    labelSpot(m, `${word} ${tF(sp.f, u)}`);
    m.on("click", (e) => { L.DomEvent.stopPropagation(e); map.flyTo([sp.lat, sp.lon], 12, { duration: 1.2 }); });
  }
  syncPriorityMarkers();
}
function syncPriorityMarkers() {
  priorityMarkers.clearLayers();
  const sat = state.sat.day;
  const show = sat && (state.layers.priority || state.tab === "cooling");
  if (!show) { map.removeLayer(priorityMarkers); return; }
  priorityMarkers.addTo(map);
  sat.stats.priority.forEach((sp, i) => {
    const m = L.marker([sp.lat, sp.lon], { icon: spotIcon("plant"), title: `Tree priority #${i + 1}` }).addTo(priorityMarkers);
    labelSpot(m, String(i + 1));
    m.on("click", (e) => { L.DomEvent.stopPropagation(e); flyToSpot(sp, 13); });
  });
}
function flyToSpot(sp, z = 12) { sfx.whoosh(); flyToVisible([sp.lat, sp.lon], z); }

function drawPriority() {
  const sat = state.sat.day;
  if (!sat || !sat.ndviV) return;
  if (!priorityOverlay) {
    const [s0, w0, n0, e0] = sat.bounds;
    priorityOverlay = new CanvasOverlay([[s0, w0], [n0, e0]], sat.width, sat.height, { pane: "priority", className: "heat-overlay", interactive: false });
  }
  const urban = sat.cover?.some((c) => c === 13);
  const cand = [];
  for (let i = 0; i < sat.meanF.length; i++)
    if (Number.isFinite(sat.meanF[i]) && Number.isFinite(sat.ndviV[i]) && (!urban || sat.cover[i] === 13)) cand.push(i);
  const rank = (arr) => {
    const order = [...cand].sort((a, b) => arr[a] - arr[b]);
    const r = new Float32Array(arr.length).fill(NaN);
    order.forEach((idx, k) => { r[idx] = k / Math.max(1, order.length - 1); });
    return r;
  };
  const heatR = rank(sat.meanF), greenR = rank(sat.ndviV);
  priorityOverlay.drawWith((i) => {
    if (!Number.isFinite(heatR[i])) return null;
    const sc = heatR[i] * (1 - greenR[i]);
    if (sc < 0.35) return null;
    const k = (sc - 0.35) / 0.65;
    return [Math.round(95 + 140 * k), Math.round(211 + 44 * k), Math.round(141 + 35 * k), Math.round(80 + 170 * k)];
  });
  if (!map.hasLayer(priorityOverlay)) priorityOverlay.addTo(map);
}

// ---------------------------------------------------------------- Satellite tab
function renderSatellite() {
  const el = tabEl("satellite");
  if (!state.place) return;
  const sat = activeSat(), u = state.unit;
  if (state.sat.error && !sat) { el.replaceChildren(errorBox("No satellite view for this summer", state.sat.error, state.sat.error.startsWith("MODIS") ? null : () => loadSatellite(state.view.layer))); return; }
  if (!sat) { el.replaceChildren(h("p", { class: "loading-note" }, "Decoding NASA MODIS satellite tiles for ~100 km around this spot…"), ...skeleton([170, 140, 160])); return; }
  if (!visible("satellite")) return;
  const st = sat.stats, night = state.view.layer === "night";
  const cards = [];
  const toggle = h("div", { class: "seg", role: "group", "aria-label": "Day or night" },
    h("button", { type: "button", "aria-pressed": String(!night), onclick: () => night && toggleLayer("night", false) }, "☀️ 10:30 AM"),
    h("button", { type: "button", "aria-pressed": String(night), onclick: () => !night && toggleLayer("night", true) }, "🌙 10:30 PM"));
  if (st.here) {
    const num = h("span", { class: "hero-num" }, "0");
    const meter = h("div", { class: "meter", style: { background: gradientCss() } }, h("span", { class: "mark", style: { left: "0%" } }));
    cards.push(h("div", { class: "card" },
      h("div", { class: "row between wrap" }, h("p", { class: "eyebrow" }, "Your spot from space"), toggle),
      h("div", { class: "hero-row" }, num, h("div", { class: "hero-cap" }, `average ${night ? "night-time" : "late-morning"} ground temperature`, h("br"), `hotter than `, h("b", {}, `${st.here.percentile}%`), ` of the region`)),
      meter,
      h("div", { class: "meter-ticks" }, h("span", {}, `coolest ${tF(st.coolest?.f, u)}`), h("span", {}, `median ${tF(st.median, u)}`), h("span", {}, `hottest ${tF(st.hottest?.f, u)}`)),
      h("p", { class: "sub", style: { marginTop: "10px" } }, [st.here.cover ? `Land cover: ${st.here.cover}` : null, st.here.ndvi != null ? `greenness (NDVI) ${st.here.ndvi.toFixed(2)}` : null].filter(Boolean).join(" · "))));
    countUp(num, Math.round(fromF(st.here.f, u)), { format: (v) => `${Math.round(v)}°${u}` });
    requestAnimationFrame(() => setTimeout(() => {
      const lo = st.coolest?.f ?? sat.lo, hi = st.hottest?.f ?? sat.hi;
      const mark = /** @type {HTMLElement} */ (meter.firstChild);
      mark.style.left = `${Math.max(0, Math.min(100, ((st.here.f - lo) / (hi - lo || 1)) * 100))}%`;
      meter.style.background = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((p) => heatCss(Math.max(0, Math.min(1, (lo + (hi - lo) * p - sat.lo) / (sat.hi - sat.lo || 1))))).join(",")})`;
    }, 60));
  } else cards.push(h("div", { class: "card" }, h("div", { class: "row between wrap" }, h("p", { class: "eyebrow" }, "Your spot from space"), toggle), h("p", { class: "sub" }, "Clouds or water hid this exact spot all season. The regional view still works.")));

  if (st.heatIsland) {
    const hi = st.heatIsland, d = Math.round(fromF(hi.urbanF, u)) - Math.round(fromF(hi.ruralF, u));
    const maxF = Math.max(hi.urbanF, hi.ruralF), minF = Math.min(hi.urbanF, hi.ruralF) - 8;
    const bar = (f, label, cls) => {
      const b = h("div", { class: "bar " + cls, style: { background: heatCss(Math.max(0, Math.min(1, (f - sat.lo) / (sat.hi - sat.lo || 1)))) } }, tF(f, u));
      requestAnimationFrame(() => setTimeout(() => { b.style.width = `${30 + ((f - minF) / (maxF - minF || 1)) * 70}%`; }, 80));
      return h("div", {}, h("div", { class: "lab" }, label), b);
    };
    cards.push(h("div", { class: "card" },
      h("h3", {}, night ? "The urban heat island after dark" : "The urban heat island"),
      h("p", { class: "sub" }, d > 0
        ? `Built-up land ran ${Math.abs(d)}°${u} hotter than the surrounding countryside${night ? " at night, when pavement and buildings release the day's heat" : ""}.`
        : d < 0 ? `Built-up land ran ${Math.abs(d)}°${u} cooler than the surrounding countryside, which happens where the countryside is dry, bare or farmed.`
        : "Built-up land and the countryside ran about the same."),
      h("div", { class: "compare" }, bar(hi.urbanF, `Built-up (${hi.urbanCells.toLocaleString()} km²)`, "u"), bar(hi.ruralF, `Countryside (${hi.ruralCells.toLocaleString()} km²)`, "r")),
      !night ? h("button", { class: "btn small ripple", style: { marginTop: "10px" }, onclick: () => toggleLayer("night", true) }, "🌙 Compare with night-time") : null));
  }

  const spot = (sp, word, swatch) => sp && h("li", { tabindex: 0, onclick: () => flyToSpot(sp), onkeydown: (e) => e.key === "Enter" && flyToSpot(sp) },
    h("span", { class: "swatch", style: { background: swatch } }),
    h("span", { class: "grow" }, word, h("small", {}, `${Math.round(sp.distanceKm)} km ${sp.direction}${sp.cover ? " · " + sp.cover : ""}`)),
    h("span", { class: "val" }, tF(sp.f, u)));
  cards.push(h("div", { class: "card" }, h("h3", {}, "Extremes within ~50 km"),
    h("ul", { class: "spots" }, spot(st.hottest, "Hottest spot", "#ff5a4f"), spot(st.coolest, "Coolest spot", "#6fc3ff"))));
  cards.push(h("div", { class: "card" },
    h("h3", {}, "▶ Play the summer"),
    h("p", { class: "sub" }, `Press play on the map to watch ${sat.frames.length} satellite snapshots of this summer sweep by, one per 8 days. Cloudy gaps are filled in from the snapshots before and after.`),
    h("button", { class: "btn primary ripple", onclick: () => { play(); } }, "▶ Play on the map")));
  el.replaceChildren(...cards, source(`${sat.source}. Land cover: MODIS ${sat.coverYear ?? "—"}. Surface temperature is the ground and roofs, which run hotter than the air.`));
}

// ---------------------------------------------------------------- Cooling tab (sustainability)
function renderCooling() {
  const el = tabEl("cooling");
  if (!state.place) return;
  if (!visible("cooling")) return;
  const u = state.unit, sat = state.sat.day, cards = [];
  if (state.block?.reading) {
    const r = state.block.reading;
    cards.push(h("div", { class: "cta" }, h("span", { class: "big" }, "🌳"),
      h("div", {}, h("b", {}, "This block has street-level Landsat data"),
        h("p", {}, `On clear summer days Landsat measured this block's ground at ${tF(r.lstF, u)} (50 m detail), hotter than ${r.percentile}% of Boston, Cambridge & Somerville. CoolBlock can help you request a free street tree.`),
        h("a", { class: "btn primary small ripple", href: `/chat?q=${encodeURIComponent(state.place.label ?? `${state.place.lat},${state.place.lon}`)}` }, "💬 Get a tree planted"))));
  }
  if (!sat) {
    cards.push(state.sat.error ? errorBox("Satellite data unavailable", state.sat.error, null) : h("div", {}, h("p", { class: "loading-note" }, "Measuring how greenery cools this region…"), ...skeleton([220, 160])));
    el.replaceChildren(...cards);
    return;
  }
  const st = sat.stats, g = st.greenness, here = st.here;

  // 1. Green cooling simulator
  if (g && here && here.ndvi != null) {
    const target = Math.max(here.ndvi, g.ndviP90);
    const room = target - here.ndvi;
    const scene = simScene();
    const out = h("span", { class: "big cool" }, "0");
    const after = h("div", { class: "hero-cap" });
    const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: 0, max: 100, step: 1, value: state.sim, "aria-label": "Added greenery", disabled: room < 0.02 ? true : null }));
    const label = h("b", {}, "");
    let celebrated = false;
    const update = (fromUser) => {
      const k = Number(slider.value) / 100, nd = here.ndvi + room * k;
      const eff = A.greeningEffectF(here, g, nd);
      const shownBefore = Math.round(fromF(here.f, u));
      const shownAfter = eff == null ? shownBefore : Math.round(fromF(here.f + eff, u));
      out.textContent = eff == null ? "—" : `${shownAfter - shownBefore === 0 ? "±0" : "−" + Math.abs(shownAfter - shownBefore)}°${u}`;
      after.textContent = eff == null ? "" : `1 km summer average ${shownBefore}°${u} → ${shownAfter}°${u} · NDVI ${here.ndvi.toFixed(2)} → ${nd.toFixed(2)}`;
      label.textContent = `+${Math.round(k * 100)}%`;
      setFill(slider);
      scene.set(k, eff == null ? 0 : Math.min(1, Math.abs(eff) / 12));
      state.sim = Number(slider.value);
      if (fromUser) { sfx.tick(); if (k === 1 && !celebrated) { celebrated = true; sfx.chime(); const r = scene.el.getBoundingClientRect(); leafBurst(r.left + r.width / 2, r.top + r.height / 2, 30); haptic(30); } }
    };
    slider.addEventListener("input", () => update(true));
    const strong = g.r <= -0.2 && g.slopeFPerTenth < 0;
    cards.push(h("div", { class: "card" },
      h("h3", {}, "🌳 Green cooling simulator"),
      h("p", { class: "sub" }, room < 0.02 ? "This spot is already as green as the greenest tenth of the region." : "Drag to make this spot as leafy as the greenest tenth of the region and see how much cooler its ground would read, based on this region's own satellite data."),
      scene.el,
      h("div", { class: "sim-out" }, h("div", {}, out, after), h("div", { class: "hero-cap", style: { textAlign: "right" } }, "greener than now", h("br"), label)),
      h("div", { class: "slider-row" }, h("span", {}, "Add greenery"), slider),
      h("p", { class: "source" }, strong
        ? `Across ${g.n.toLocaleString()} km² of this region, each +0.1 of greenness (NDVI) went with ${dF(g.slopeFPerTenth, u, 1)} on the ground (correlation r = ${g.r.toFixed(2)}). The greenest quarter ran ${Math.round(Math.abs(g.leastGreenF - g.greenestF) / (u === "F" ? 1 : 1.8))}°${u} ${g.leastGreenF >= g.greenestF ? "cooler" : "warmer"} than the least green. It's a pattern, not a promise: hills, water and wind matter too.`
        : `Here greenness explains little of the heat pattern (r = ${g.r.toFixed(2)}), so the simulator stays at zero. Shade still cools the ground right under a tree by 20–45°F (U.S. EPA).`)));
    requestAnimationFrame(() => update(false));
  }

  // 2. Priority zones
  if (st.priority.length) {
    const list = h("ul", { class: "spots" }, ...st.priority.map((sp, i) => {
      const name = h("span", {}, `Zone ${i + 1}`);
      nameSpot(sp, name);
      return h("li", { tabindex: 0, onclick: () => flyToSpot(sp, 13), onkeydown: (e) => e.key === "Enter" && flyToSpot(sp, 13) },
        h("span", { class: "rank" }, String(i + 1)),
        h("span", { class: "grow" }, name, h("small", {}, `${Math.round(sp.distanceKm)} km ${sp.direction} · NDVI ${sp.ndvi?.toFixed(2) ?? "—"}`)),
        h("span", { class: "val" }, tF(sp.f, u)));
    }));
    cards.push(h("div", { class: "card" },
      h("div", { class: "row between" }, h("h3", {}, "📍 Where trees would help most"),
        h("button", { class: "chip ripple", "aria-pressed": String(state.layers.priority), onclick: () => { toggleLayer("priority"); renderCooling(); } }, state.layers.priority ? "Hide map" : "Show on map")),
      h("p", { class: "sub" }, "The hottest, least green built-up square kilometres in the region: where new shade does the most good."),
      list));
  }

  // 3. Heat → energy → carbon
  const s = state.summary, n = state.normals;
  if (s && n) {
    const e = state.energy;
    const box = h("div", {});
    const sliders = h("div", {});
    const draw = () => {
      const fp = A.coolingFootprint(s.cddF, n.cddF, e);
      const more = fp.extraKwh >= 0;
      box.replaceChildren(
        h("div", { class: "kpis" },
          kpi("Cooling demand vs normal", fp.demandChange == null ? "—" : pct(fp.demandChange), `${Math.round(s.cddF).toLocaleString()} vs ${Math.round(n.cddF).toLocaleString()} °F·days`),
          kpi("AC power, one home", `${Math.round(fp.kwh).toLocaleString()} kWh`, `${more ? "+" : "−"}${Math.abs(Math.round(fp.extraKwh)).toLocaleString()} kWh vs normal`),
          kpi("CO₂ from that power", `${Math.round(fp.kgCo2).toLocaleString()} kg`, `${more ? "+" : "−"}${Math.abs(Math.round(fp.extraKgCo2)).toLocaleString()} kg vs normal`),
          kpi(more ? "Trees to absorb the extra" : "Extra CO₂ to absorb", more ? `🌳 ${Math.ceil(fp.treesToOffsetExtra)}` : "None", more ? "mature trees, one year" : "a cooler-than-normal summer")));
    };
    const mk = (label, key, min, max, step, fmt) => {
      const inp = /** @type {HTMLInputElement} */ (h("input", { type: "range", min, max, step, value: e[key], "aria-label": label }));
      const v = h("b", {}, fmt(e[key]));
      setFill(inp);
      inp.addEventListener("input", () => { e[key] = Number(inp.value); v.textContent = fmt(e[key]); setFill(inp); draw(); });
      return h("div", { class: "slider-row" }, h("span", { style: { minWidth: "128px" } }, label), inp, v);
    };
    sliders.append(
      mk("Home AC use", "kWhPerCdd", 0.3, 4, 0.1, (v) => `${v.toFixed(1)} kWh/°F·day`),
      mk("Grid carbon", "kgPerKwh", 0.02, 1, 0.01, (v) => `${v.toFixed(2)} kg/kWh`));
    draw();
    cards.push(h("div", { class: "card" },
      h("h3", {}, "⚡ Heat → energy → carbon"),
      h("p", { class: "sub" }, "Hotter summers make air conditioners work harder, which burns more power and emits more CO₂, which warms summers further. Here's that loop for one air-conditioned home."),
      box, sliders,
      h("p", { class: "source" }, "Estimates, not measurements. Assumes AC power scales with cooling degree-days (base 65°F). 1.5 kWh per °F·day is a rough figure for a U.S. air-conditioned home and 0.45 kg CO₂/kWh is close to the world-average grid: adjust both for your home. A mature tree absorbs roughly 22 kg of CO₂ a year.")));
  }
  el.replaceChildren(...cards);
}

/** Animated street scene for the simulator: trees grow, the sun dims and the heat shimmer fades as greenery rises. */
function simScene() {
  const NS = "http://www.w3.org/2000/svg";
  const wrap = h("div", { class: "sim", "aria-hidden": "true" });
  wrap.innerHTML = `<svg viewBox="0 0 320 150">
    <defs><linearGradient id="simSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sky" stop-color="#ff9a3c"/><stop offset="1" stop-color="#1d2f5c"/></linearGradient></defs>
    <rect width="320" height="150" fill="url(#simSky)"/>
    <circle class="sun" cx="262" cy="34" r="20" fill="#ffd27a" opacity=".95"/>
    <g fill="#14203f"><rect x="14" y="52" width="58" height="72" rx="3"/><rect x="82" y="34" width="46" height="90" rx="3"/><rect x="190" y="58" width="52" height="66" rx="3"/><rect x="250" y="72" width="58" height="52" rx="3"/></g>
    <g fill="#ffd27a" opacity=".55"><rect x="24" y="64" width="8" height="8"/><rect x="44" y="64" width="8" height="8"/><rect x="92" y="48" width="8" height="8"/><rect x="110" y="64" width="8" height="8"/><rect x="200" y="70" width="8" height="8"/><rect x="262" y="84" width="8" height="8"/></g>
    <rect y="124" width="320" height="26" fill="#2b2f3a"/><rect y="120" width="320" height="5" fill="#4a4f5c"/>
    <g class="shimmers" stroke="#ffb27a" stroke-width="1.6" fill="none" stroke-linecap="round">
      <path class="shimmer" d="M40 138 q6 -5 12 0 t12 0"/><path class="shimmer" d="M150 140 q6 -5 12 0 t12 0"/><path class="shimmer" d="M250 138 q6 -5 12 0 t12 0"/>
    </g>
    <g class="trees"></g>
  </svg>`;
  const svg = /** @type {SVGSVGElement} */ (wrap.firstElementChild);
  const trees = /** @type {SVGGElement} */ (svg.querySelector(".trees"));
  const xs = [36, 98, 160, 214, 280];
  const els = xs.map((x, i) => {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "tree");
    g.innerHTML = `<rect x="${x - 2.5}" y="98" width="5" height="24" rx="2" fill="#5a3d2b"/><circle cx="${x}" cy="88" r="16" fill="#2f9e5b"/><circle cx="${x - 10}" cy="96" r="11" fill="#38b46a"/><circle cx="${x + 10}" cy="95" r="12" fill="#2a8a50"/><circle cx="${x}" cy="76" r="10" fill="#5fd38d"/>`;
    g.style.transitionDelay = `${i * 60}ms`;
    trees.append(g);
    return g;
  });
  const sky = /** @type {SVGStopElement} */ (svg.querySelector(".sky")), sun = /** @type {SVGCircleElement} */ (svg.querySelector(".sun"));
  const shim = /** @type {SVGGElement} */ (svg.querySelector(".shimmers"));
  return {
    el: wrap,
    /** @param {number} k greenery 0..1 @param {number} cool cooling 0..1 */
    set(k, cool) {
      els.forEach((g, i) => {
        const grow = Math.max(0, Math.min(1, k * xs.length - i * 0.8));
        g.style.transform = `scale(${grow === 0 ? 0.001 : 0.35 + grow * 0.65})`;
      });
      const heat = 1 - Math.max(cool, k * 0.6);
      sky.setAttribute("stop-color", `rgb(${Math.round(255 - 140 * (1 - heat))},${Math.round(154 - 10 * (1 - heat))},${Math.round(60 + 140 * (1 - heat))})`);
      sun.setAttribute("r", String(14 + heat * 8));
      shim.style.opacity = String(heat);
    },
  };
}

const names = new Map();
function nameSpot(sp, el) {
  const key = `${sp.lat.toFixed(3)},${sp.lon.toFixed(3)}`;
  if (names.has(key)) { el.textContent = names.get(key); return; }
  api(`/api/reverse?lat=${sp.lat}&lon=${sp.lon}&lang=${(navigator.language || "en").slice(0, 2)}`).then((r) => {
    if (!r.label) return;
    const short = r.label.split(",").slice(0, 2).join(",");
    names.set(key, short);
    el.textContent = short;
  }).catch(() => {});
}

// ---------------------------------------------------------------- Climate tab
function renderClimate() {
  const el = tabEl("climate");
  if (!state.place) return;
  if (state.historyError) { el.replaceChildren(errorBox("No climate history", state.historyError, null)); return; }
  if (!state.history || !state.series.length) { el.replaceChildren(...skeleton([140, 220])); return; }
  if (!visible("climate")) return;
  const u = state.unit, ser = state.series, n = state.normals;
  const tr = A.trend(ser, "avgHigh"), rk = A.rankOf(ser, /** @type {number} */ (state.year));
  const stripeHost = h("div", {}), trendHost = h("div", {});
  const span = tr ? tr.to - tr.from : 0;
  const top = [...ser].sort((a, b) => b.avgHigh - a.avgHigh).slice(0, 5);
  el.replaceChildren(
    h("div", { class: "card" },
      h("h3", {}, "Warming stripes"),
      h("p", { class: "sub" }, `Each stripe is one summer's average high: blue cooler, red hotter than the 1991–2020 normal${n ? ` (${tC(n.avgHigh, u)})` : ""}. Click a stripe to open that summer.`),
      stripeHost),
    h("div", { class: "card" },
      h("h3", {}, tr ? `${dC(tr.perDecade, u, 1)} per decade` : "Trend"),
      h("p", { class: "sub" }, tr ? `Summers here have warmed by about ${dC(tr.perDecade * span / 10, u, 1)} since ${tr.from}${rk ? `. Summer ${yearLabel(state.year)} ranks ${ordinal(rk.rank)} hottest of ${rk.of}` : ""}.` : ""),
      trendHost),
    h("div", { class: "card" }, h("h3", {}, "Hottest summers on record here"),
      h("ul", { class: "spots" }, ...top.map((r, i) => h("li", { tabindex: 0, onclick: () => setYear(r.year), onkeydown: (e) => e.key === "Enter" && setYear(r.year) },
        h("span", { class: "rank" }, String(i + 1)), h("span", { class: "grow" }, `Summer ${yearLabel(r.year)}`, h("small", {}, `${r.hotDays} days ≥ ${thresholds().hot}°${u} · ${r.warmNights} warm nights`)), h("span", { class: "val" }, tC(r.avgHigh, u)))))),
    source(`${state.history.source}. Summers are ${A.seasonLabel(state.startMonth)}; trend is a least-squares fit (r² ${tr ? tr.r2.toFixed(2) : "—"}).`));
  requestAnimationFrame(() => {
    if (n) stripes(stripeHost, { series: ser, normalC: n.avgHigh, unit: u, selected: /** @type {number} */ (state.year), onPick: setYear });
    trendChart(trendHost, { series: ser, trend: tr, unit: u, selected: /** @type {number} */ (state.year) });
  });
}

// ---------------------------------------------------------------- Live tab
let liveTimer = 0;
async function loadLive(token) {
  clearInterval(liveTimer);
  const p = state.place;
  if (!p) return;
  try {
    const live = await api(`/api/now?lat=${p.lat}&lon=${p.lon}`);
    if (token !== state.token) return;
    const first = !state.live;
    state.live = live;
    state.liveError = null;
    const chip = $("#live-chip");
    chip.hidden = false;
    $("#live-t").textContent = tC(live.current.t, state.unit);
    if (first && live.daily.some((d) => A.heatRisk(d.hiMax ?? d.tmax).level >= 3)) setTimeout(() => sfx.alert(), 900);
  } catch (e) {
    if (token !== state.token) return;
    state.liveError = e instanceof Error ? e.message : String(e);
  }
  renderLive();
  liveTimer = window.setInterval(() => { if (token === state.token && !document.hidden) loadLive(token); }, 10 * 60_000);
}

function renderLive() {
  const el = tabEl("live");
  if (!state.place) return;
  if (state.liveError && !state.live) { el.replaceChildren(errorBox("Live weather unavailable", state.liveError, () => loadLive(state.token))); return; }
  if (!state.live) { el.replaceChildren(...skeleton([150, 170, 110])); return; }
  if (!visible("live")) return;
  const u = state.unit, L0 = state.live, c = L0.current;
  const risk = A.heatRisk(c.hi ?? c.t);
  const danger = L0.daily.filter((d) => A.heatRisk(d.hiMax ?? d.tmax).level >= 3);
  const cards = [];
  if (danger.length) cards.push(h("div", { class: "alert", role: "alert" }, h("span", { class: "ic" }, "🥵"),
    h("div", {}, h("b", {}, `Dangerous heat ahead: ${danger.map((d) => day(d.date)).join(", ")}`),
      h("div", { class: "sub" }, `Heat index forecast to reach ${tC(Math.max(...danger.map((d) => d.hiMax ?? d.tmax)), u)}. Check on neighbours, drink water, and find a cool place below.`))));
  const tnum = h("span", { class: "now-temp" }, "0");
  const updated = new Date(L0.fetchedAt);
  cards.push(h("div", { class: "card" },
    h("div", { class: "row between" }, h("p", { class: "eyebrow" }, h("span", { class: "live-dot" }), " Live now"), status(risk)),
    h("div", { class: "now-grid" },
      h("div", {}, tnum, h("div", { class: "hero-cap" }, `${c.sky.emoji} ${c.sky.text}`)),
      h("div", { class: "now-meta" },
        h("span", {}, "Heat index"), h("b", {}, tC(c.hi, u)),
        h("span", {}, "Humidity"), h("b", {}, c.rh == null ? "—" : `${Math.round(c.rh)}%`),
        h("span", {}, "Wind"), h("b", {}, c.wind == null ? "—" : u === "F" ? `${Math.round(c.wind / 1.609)} mph` : `${Math.round(c.wind)} km/h`),
        h("span", {}, "UV index"), h("b", {}, c.uv == null ? "—" : String(Math.round(c.uv))))),
    h("p", { class: "source" }, `${L0.source} · updated ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, refreshes every 10 minutes.`)));
  countUp(tnum, Math.round(fromC(c.t, u)), { format: (v) => `${Math.round(v)}°${u}` });
  const hourly = h("div", {});
  cards.push(h("div", { class: "card" }, h("h3", {}, "Next 48 hours"), hourly));
  cards.push(h("div", { class: "card" }, h("h3", {}, "7-day heat risk"),
    h("div", { class: "forecast" }, ...L0.daily.map((d, i) => {
      const rk = A.heatRisk(d.hiMax ?? d.tmax);
      return h("div", { class: "fday", style: { animationDelay: `${i * 50}ms` }, title: `${rk.label}: heat index up to ${tC(d.hiMax, u)}` },
        h("div", { class: "d" }, i === 0 ? "Today" : new Date(d.date + "T12:00:00Z").toLocaleDateString([], { weekday: "short" })),
        h("div", { class: "e" }, d.sky.emoji), h("div", { class: "hi" }, tC(d.tmax, u)), h("div", { class: "lo" }, tC(d.tmin, u)),
        h("div", { class: "risk", style: { background: `var(--${rk.status})` } }));
    })),
    h("div", { class: "legend" }, ...[0, 1, 2, 3].map((lv) => { const r = A.heatRisk(A.fToC([70, 85, 95, 110][lv])); return h("span", {}, h("i", { class: "key rect-key", style: { background: `var(--${r.status})` } }), `${r.icon} ${r.label}`); }))));
  cards.push(refugeCard());
  cards.push(h("div", { class: "card" }, h("h3", {}, `${risk.icon} ${risk.label}: what to do`), h("ul", { class: "tips" }, ...TIPS[Math.min(3, risk.level)].map((t) => h("li", {}, t)))));
  el.replaceChildren(...cards);
  requestAnimationFrame(() => hourlyChart(hourly, L0.hourly, u));
}
const status = (r) => h("span", { class: `status ${r.status}` }, h("span", { class: "ic" }, r.icon), r.label);
const TIPS = [
  ["Comfortable heat-wise. A good day to plan shade: request a street tree or plant one.", "Keep blinds closed on sunny windows to keep homes cooler later."],
  ["Drink water before you're thirsty.", "Limit hard work outdoors in the afternoon.", "Never leave people or pets in parked cars."],
  ["Heat cramps and exhaustion are possible: rest in shade or AC.", "Check on older neighbours and anyone living alone.", "Wear light, loose clothing and a hat."],
  ["Heat stroke is likely with long exposure: stay in air conditioning.", "Visit a library, cooling centre or mall if your home is hot.", "Call emergency services for confusion, fainting or no sweating."],
];

function refugeCard() {
  const u = state.unit;
  const list = state.refuges;
  const ICON = { water: "💧", splash: "💦", pool: "🏊", park: "🌳", library: "📚" };
  const NAME = { water: "Drinking water", splash: "Splash pad", pool: "Pool", park: "Park", library: "Library (air-conditioned)" };
  const dist = (m) => (u === "F" ? `${(m / 1609).toFixed(1)} mi` : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
  return h("div", { class: "card" },
    h("div", { class: "row between" }, h("h3", {}, "🧊 Cool spots within 1.5 km"),
      list ? null : h("button", { class: "btn small primary ripple", disabled: state.refugesLoading || null, onclick: () => { toggleLayer("refuges", true); } }, state.refugesLoading ? "Searching…" : "Find them")),
    h("p", { class: "sub" }, "Live from OpenStreetMap: drinking water, splash pads, pools, parks and libraries."),
    list ? (list.length ? h("ul", { class: "refuge-list" }, ...list.slice(0, 30).map((r) => h("li", { onclick: () => map.flyTo([r.lat, r.lon], 16, { duration: 1.2 }) },
      h("span", {}, ICON[r.kind]), h("span", {}, r.name ?? NAME[r.kind]), h("span", { class: "dist" }, dist(r.distanceM))))) : h("p", { class: "empty" }, "OpenStreetMap lists no cool spots this close.")) : null);
}

async function loadRefuges() {
  const p = state.place;
  if (!p || state.refugesLoading) return;
  state.refugesLoading = true;
  renderLive();
  const token = state.token;
  try {
    const { refuges } = await api(`/api/refuges?lat=${p.lat}&lon=${p.lon}`);
    if (token !== state.token) return;
    state.refuges = refuges;
    refugeLayer.clearLayers();
    const ICON = { water: "💧", splash: "💦", pool: "🏊", park: "🌳", library: "📚" };
    refuges.forEach((r) => L.marker([r.lat, r.lon], { icon: emojiIcon(ICON[r.kind]), title: r.name ?? r.kind }).addTo(refugeLayer));
    sfx.chime();
    toast(refuges.length ? `Found ${refuges.length} cool spots nearby` : "No cool spots mapped within 1.5 km");
    if (refuges.length && map.getZoom() < 14) map.flyTo([p.lat, p.lon], 14.5, { duration: 1.4 });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't load cool spots");
    state.layers.refuges = false;
    syncChips();
  } finally {
    state.refugesLoading = false;
    renderLive();
  }
}

// ---------------------------------------------------------------- Landsat 50 m (Boston, Cambridge, Somerville)
async function showLandsat(on) {
  if (!on) { if (landsatOverlay) map.removeLayer(landsatOverlay); satOverlay?.setOpacity(1); return; }
  try {
    if (!landsat) { toast("Loading 50 m Landsat data…", 1500); landsat = await api("/api/landsat"); }
    if (!landsatOverlay) {
      const [x0, y0, x1, y1] = landsat.bbox;
      landsatOverlay = new CanvasOverlay([[y0, x0], [y1, x1]], landsat.width, landsat.height, { pane: "landsat", className: "heat-overlay", interactive: false });
      const vals = Float32Array.from(landsat.lst_f_x10, (v, i) => (v == null || landsat.water[i] ? NaN : v / 10));
      landsatOverlay.draw(vals, landsat.stats.lst_p10_f, landsat.stats.lst_p90_f, 225);
    }
    landsatOverlay.addTo(map);
    satOverlay?.setOpacity(0.45);
    updateLegend();
  } catch (e) {
    toast("Couldn't load the Landsat layer");
    state.layers.landsat = false;
    syncChips();
  }
}

// ---------------------------------------------------------------- unit, sound, sharing, URL state
function setUnit(u) {
  if (u === state.unit) return;
  state.unit = u;
  state.hot = null;
  store.set("cb_unit", u);
  document.querySelectorAll("[data-unit]").forEach((b) => b.setAttribute("aria-pressed", String(/** @type {HTMLElement} */ (b).dataset.unit === u)));
  sfx.tick();
  if (state.history) computeSeason();
  if (state.live) $("#live-t").textContent = tC(state.live.current.t, u);
  renderAll();
  placeSpots();
  updateLegend();
}
document.querySelectorAll("[data-unit]").forEach((b) => {
  b.setAttribute("aria-pressed", String(/** @type {HTMLElement} */ (b).dataset.unit === state.unit));
  b.addEventListener("click", () => setUnit(/** @type {any} */ (/** @type {HTMLElement} */ (b).dataset.unit)));
});
const soundBtn = $("#sound");
const syncSound = () => { soundBtn.textContent = sfx.enabled ? "🔊" : "🔇"; soundBtn.setAttribute("aria-pressed", String(sfx.enabled)); soundBtn.title = sfx.enabled ? "Sound on" : "Sound off"; };
soundBtn.addEventListener("click", () => { sfx.enabled = !sfx.enabled; syncSound(); if (sfx.enabled) sfx.chime(); });
syncSound();

$("#share").addEventListener("click", async () => {
  updateHash();
  try { await navigator.clipboard.writeText(location.href); toast("Link copied: anyone can open this exact view"); sfx.chime(); }
  catch { toast(location.href, 6000); }
});

function updateHash() {
  const p = state.place;
  if (!p) return;
  const q = new URLSearchParams({ lat: p.lat.toFixed(4), lon: p.lon.toFixed(4) });
  if (p.label) q.set("n", p.label);
  if (state.year != null) q.set("y", String(state.year));
  if (state.seasonMode !== "auto") q.set("s", String(state.seasonMode));
  if (state.tab !== "summer") q.set("tab", state.tab);
  history.replaceState(null, "", "#" + q.toString());
}

function fromHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get("q")) { const inp = /** @type {HTMLInputElement} */ ($("#q-big")); inp.value = q.get("q") ?? ""; runSearch(inp, null); return; }
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  if (!q.has("lat") || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const s = q.get("s");
  selectPlace({ lat, lon, label: q.get("n") }, { zoom: 10, year: q.has("y") ? Number(q.get("y")) : null, season: s == null ? null : Number(s), tab: q.get("tab") });
}

document.addEventListener("keydown", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(t.tagName)) { e.preventDefault(); ($("#intro").classList.contains("gone") ? $("#q") : $("#q-big")).focus(); }
  if (e.key === " " && t === document.getElementById("map") && activeSat()) { e.preventDefault(); state.view.playing ? stopPlay() : play(); }
});
window.addEventListener("resize", () => { moveInk(); clearTimeout(/** @type {any} */ (window)._rz); /** @type {any} */ (window)._rz = setTimeout(() => ({ summer: renderSummer, climate: renderClimate, live: renderLive })[state.tab]?.(), 200); });

enableRipples();
updateLegend();
fromHash();
