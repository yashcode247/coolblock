# CoolBlock 🌳🛰️

**Text an address, see your block's summer heat from space, see your street with trees, get one planted for free.**
**Or open the Heat Explorer and see how summer hit any place on Earth, live from NASA satellites.**

Boston's formerly redlined neighborhoods run up to 7.5°F hotter during heat waves than the rest of the city (City of Boston Heat Plan). The city plants street trees for free, but many requests get closed because only the abutting property owner can ask. CoolBlock closes that gap over iMessage.

## How it works

1. You text an address (or "Nubian Square") to the CoolBlock iMessage number.
2. It geocodes it and looks up **Landsat 8/9 surface temperature and vegetation (NDVI)** for your block: how hot it gets on clear summer days, how you rank across Boston, Cambridge and Somerville, and how much cooler the leafy blocks within 1 km are.
   It also sends a **heat-map card** drawn from the same satellite grid: about 2 km around your block over a street map, with your block, the hottest and coolest blocks within 1 km, and a color scale.
3. You text a photo of your street. **Gemini** first reads the photo and compares it with the satellite reading. A bare street comes back with street trees drawn in; a street that's already shaded gets pointed to the hottest block within 1 km instead; a shaded street on a hot block is told the heat is likely coming from rooftops and pavement nearby.
4. It asks whether you own or rent, then gives the exact free request steps (Boston 311 / Cambridge Public Works) plus a pre-written request, or a ready-to-send text for your landlord.

## 🌍 Heat Explorer: any place on Earth (web, `/`)

Search a city, click anywhere on the map, or use your location. Everything is fetched live, for that spot, from free keyless sources:

| Tab | What you get | Source |
|---|---|---|
| ☀️ **Summer** | Average high vs the 1991–2020 normal, hottest day, hot days, warm nights, heat waves, peak heat index, cooling demand; an interactive daily chart with a draggable hot-day line | NASA POWER daily air temperature (MERRA-2, ~50 km), 1981 → last week |
| 🛰️ **Satellite** | ~1 km map of land surface temperature for ~100 km around the spot, day or night; **▶ play the summer** as 8-day snapshots; your spot's rank in the region; hottest/coolest spots; urban heat island (built-up vs countryside) | NASA GIBS MODIS Terra LST, NDVI and land cover, decoded from the published colour maps |
| 🌳 **Cooling** | **Green cooling simulator**: drag to make the spot as leafy as the region's greenest tenth and see the cooling the region's own satellite data predicts. **Where trees would help most**: the hottest, least green built-up km². **Heat → energy → carbon**: extra AC power and CO₂ vs a normal summer, and the trees it would take to absorb it | the satellite layers above + degree-days |
| 📈 **Trend** | Warming stripes for every summer since 1981 (click one to open it), °/decade trend, rank, hottest summers | NASA POWER |
| 📡 **Live** | Temperature and heat index now, next 48 h, 7-day heat-risk forecast with alerts, safety tips, and **cool spots within 1.5 km** (drinking water, splash pads, pools, parks, libraries) | Open-Meteo (MET Norway fallback), OpenStreetMap Overpass |

"Summer" is the place's own three hottest months (Jun–Aug in Boston, Dec–Feb in Sydney, Apr–Jun in Delhi), and where 90°F is an ordinary day (Phoenix, Seville) a "hot day" moves up to that place's own hottest 10%. In Boston, Cambridge and Somerville the map adds the **50 m Landsat layer** the chat uses and a button to get a tree planted.

Also: °F/°C, shareable links, keyboard support, table views for every chart, synthesized sound effects (toggle 🔊), and a bottom-sheet layout on phones.

## 💬 Web chat (`/chat`)

The same agent as the iMessage number, with typing indicators that say what it's doing, quick-reply chips for each step (OWN / RENT / PUBLIC), a **before/after slider** for your street with trees, copy buttons on the pre-written requests, tap-to-call numbers, drag-and-drop or pasted photos, and a burst of leaves when your tree request is ready.

## Where each sponsor technology is used

| Sponsor | Where | How |
|---|---|---|
| **SpaceXAI** | `data/precompute.py`, `src/satellite.ts` | Real space data: every clear-sky summer Landsat 8/9 overpass 2022–2025, cloud-masked and median-composited (built in Cursor), plus NASA MODIS heat, vegetation and land cover decoded live for any region on Earth. |
| **Photon 2.0** | `src/photon.ts` | The agent lives on an iMessage number via the Photon 2.0 beta API (`@photon-ai/api`); receives photos (incl. iPhone HEIC), replies with text and images, shows typing indicators. |
| **ASUS Sustainability** | whole project | Urban heat → AC energy use and heat illness; ends in a concrete local action (a tree request). |

## Evals

`npm run eval` checks that the agent tells the truth: parks read cooler than dense neighborhoods; every temperature and percentile in a reply matches the satellite grid exactly; out-of-area addresses get no invented numbers; Boston renters are routed to their landlord.

`evals/explorer.ts` (offline) checks the Heat Explorer: the right summer months north, south and pre-monsoon; heat waves, degree-days and the NWS heat index; that a value shown as "103°F" always counts as a 103°F day; that the trend recovers known warming; that NASA colormaps decode exactly (water excluded, open-ended bins handled); that the heat island, greenness and tree-priority maths come out right on a synthetic region; and that the web server serves the pages, refuses bad input and path traversal, and returns the chat stage.

## Run it

```bash
# 1. Satellite data (Python, a few minutes, no API key)
pip install -r data/requirements.txt
python data/precompute.py --preview      # writes data/grid.json + data/heatmap.png

# 2. Agent (Node 18.17+)
npm install
cp .env.example .env                     # fill in keys
npm run eval
npm start                                # Heat Explorer on :3000, chat on :3000/chat, + iMessage if Photon keys are set
```

The Heat Explorer needs no keys. NASA tiles and API answers are cached in `.cache/` so each place is fetched once.

`python data/make_demo_grid.py` writes a **synthetic** grid for development only; every reply is labeled "(demo data)" while it's in use.

## Data notes

Land surface temperature is the temperature of the ground and rooftops measured by Landsat's thermal sensor around 10:30–11:00 local time, not the air temperature. It's the standard measure for mapping heat islands. NDVI is a vegetation index, not exact canopy percentage. Tree benefits (2–9°F lower peak air temperatures, ~22 kg CO₂/yr per mature tree) are general estimates.

The Heat Explorer's satellite layer is MODIS (Terra, ~10:30 AM and ~10:30 PM), 8-day composites at ~1 km; cloudy gaps in the animation are filled from neighbouring weeks and the hover readout says so. It reads cooler than Landsat's clear-day snapshots because composites include hazier days. Its air temperatures are NASA POWER reanalysis averaged over ~50 km cells, so coasts and mountains are smoothed. The greening simulator is a regional correlation, not a promise, and the energy and CO₂ figures are estimates from adjustable assumptions (kWh per degree-day, grid carbon intensity).

## Layout

```
src/         agent, iMessage, geocoding, Landsat grid, heat card (chat)
             climate.ts (NASA POWER) · satellite.ts (NASA GIBS decode + regional analysis)
             live.ts (Open-Meteo / MET Norway) · refuges.ts (OpenStreetMap) · cache.ts · web.ts
public/      index.html + js/explorer.js (Heat Explorer), chat.html + js/chat.js (web chat)
             js/analysis.js: the summer maths, shared by the browser and the evals
data/        Landsat grid for Boston, Cambridge and Somerville + the script that builds it
evals/       run.ts (agent truthfulness) · explorer.ts (analysis, decoding, server)
```
