"""
Writes a SYNTHETIC data/grid.json so you can build and test the agent before the
real satellite run finishes. The agent labels every reply "(demo data)" while
this file is in use. Replace it by running precompute.py. Never demo with it.
"""
import json
import math
import random
from pathlib import Path

BBOX = (-71.191, 42.227, -70.986, 42.400)
RES = 0.0005
W = round((BBOX[2] - BBOX[0]) / RES)
H = round((BBOX[3] - BBOX[1]) / RES)

# (lat, lon, radius_deg, effect) — cool parks / hot dense areas, rough placement
PARKS = [(42.3551, -71.0656, 0.004, -12), (42.3770, -71.1210, 0.002, -8), (42.3110, -71.1180, 0.010, -14),
         (42.2980, -71.1050, 0.012, -15), (42.3170, -71.0930, 0.006, -10), (42.3740, -71.1160, 0.002, -6)]
HOT = [(42.3292, -71.0837, 0.012, 8), (42.3505, -71.0621, 0.005, 9), (42.2676, -71.0925, 0.010, 7),
       (42.3700, -71.0300, 0.015, 9), (42.3480, -71.0450, 0.008, 10)]

random.seed(7)
lst, ndvi, water = [], [], []
for r in range(H):
    lat = BBOX[3] - (r + 0.5) * RES
    for c in range(W):
        lon = BBOX[0] + (c + 0.5) * RES
        is_water = (lon > -71.045 and lat > 42.355 and lat < 42.368) or (abs(lat - (42.357 + (lon + 71.10) * 0.25)) < 0.0018 and lon < -71.06)
        t, g = 94.0, 0.30
        for la, lo, rad, eff in PARKS + HOT:
            d = math.hypot(lat - la, lon - lo)
            if d < rad * 2.5:
                k = math.exp(-(d / rad) ** 2)
                t += eff * k
                g -= eff * 0.025 * k
        t += random.gauss(0, 1.5)
        g = min(0.85, max(0.02, g + random.gauss(0, 0.05)))
        if is_water:
            t, g = 76 + random.gauss(0, 1), -0.1
        lst.append(int(round(t * 10)))
        ndvi.append(int(round(g * 100)))
        water.append(1 if is_water else 0)

land = sorted(v / 10 for v, w in zip(lst, water) if not w)
grid = {
    "source": "SYNTHETIC demo grid — not real data",
    "synthetic": True,
    "description": "fake values for development",
    "dates": [], "scene_count": 0,
    "bbox": list(BBOX), "res": RES, "width": W, "height": H,
    "lst_f_x10": lst, "ndvi_x100": ndvi, "water": water,
    "stats": {"lst_median_f": land[len(land) // 2], "lst_p10_f": land[len(land) // 10],
              "lst_p90_f": land[len(land) * 9 // 10], "ndvi_median": 0.3},
}
out = Path(__file__).parent / "grid.json"
out.write_text(json.dumps(grid, separators=(",", ":")))
print(f"Wrote SYNTHETIC {out} ({W}x{H})")
