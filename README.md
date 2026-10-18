# CoolBlock 🌳🛰️

**Text an address, see your block's summer heat from space, see your street with trees, get one planted for free.**

Boston's formerly redlined neighborhoods run up to 7.5°F hotter during heat waves than the rest of the city (City of Boston Heat Plan). The city plants street trees for free, but many requests get closed because only the abutting property owner can ask. CoolBlock closes that gap over iMessage.

## How it works

1. You text an address (or "Nubian Square") to the CoolBlock iMessage number.
2. It geocodes it and looks up **Landsat 8/9 surface temperature and vegetation (NDVI)** for your block: how hot it gets on clear summer days, how you rank across Boston, Cambridge and Somerville, and how much cooler the leafy blocks within 1 km are.
   It also sends a **heat-map card** drawn from the same satellite grid: about 2 km around your block over a street map, with your block, the hottest and coolest blocks within 1 km, and a color scale.
3. You text a photo of your street. **Gemini** first reads the photo and compares it with the satellite reading. A bare street comes back with street trees drawn in; a street that's already shaded gets pointed to the hottest block within 1 km instead; a shaded street on a hot block is told the heat is likely coming from rooftops and pavement nearby.
4. It asks whether you own or rent, then gives the exact free request steps (Boston 311 / Cambridge Public Works) plus a pre-written request, or a ready-to-send text for your landlord.

## Where each sponsor technology is used

| Sponsor | Where | How |
|---|---|---|
| **SpaceXAI** | `data/precompute.py` | Real space data: every clear-sky summer Landsat 8/9 overpass 2022–2025, cloud-masked and median-composited. Built in Cursor. |
| **Photon 2.0** | `src/photon.ts` | The agent lives on an iMessage number via the Photon 2.0 beta API (`@photon-ai/api`); receives photos (incl. iPhone HEIC), replies with text and images, shows typing indicators. |
| **ASUS Sustainability** | whole project | Urban heat → AC energy use and heat illness; ends in a concrete local action (a tree request). |

## Evals

`npm run eval` checks that the agent tells the truth: parks read cooler than dense neighborhoods; every temperature and percentile in a reply matches the satellite grid exactly; out-of-area addresses get no invented numbers; Boston renters are routed to their landlord.

## Run it

```bash
# 1. Satellite data (Python, a few minutes, no API key)
pip install -r data/requirements.txt
python data/precompute.py --preview      # writes data/grid.json + data/heatmap.png

# 2. Agent (Node 18.17+)
npm install
cp .env.example .env                     # fill in keys
npm run eval
npm start                                # web chat on :3000 + iMessage if Photon keys are set
```

`python data/make_demo_grid.py` writes a **synthetic** grid for development only; every reply is labeled "(demo data)" while it's in use.

## Data notes

Land surface temperature is the temperature of the ground and rooftops measured by Landsat's thermal sensor around 10:30–11:00 local time, not the air temperature. It's the standard measure for mapping heat islands. NDVI is a vegetation index, not exact canopy percentage. Tree benefits (2–9°F lower peak air temperatures, ~22 kg CO₂/yr per mature tree) are general estimates.
