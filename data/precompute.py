"""
CoolBlock satellite precompute.

Builds data/grid.json: a ~50 m grid over Boston + Cambridge + Somerville with
  - lst:  median clear-sky summer land surface temperature (deg F x10) from Landsat 8/9
  - ndvi: median summer vegetation index (x100) from the same Landsat scenes
  - water flag
Source: Landsat Collection 2 Level-2 on Microsoft Planetary Computer (free, no key).

Run once (takes a few minutes):
    pip install -r data/requirements.txt
    python data/precompute.py
Optional: --years 2023 2024 2025   --max-cloud 20   --preview (saves data/heatmap.png for Devpost)
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import odc.stac
import planetary_computer
import pystac_client

# lon_min, lat_min, lon_max, lat_max  (Boston incl. Mattapan/Hyde Park, Cambridge, Somerville, East Boston)
BBOX = (-71.191, 42.227, -70.986, 42.400)
RES = 0.0005  # degrees (~55 m N-S, ~41 m E-W)
OUT = Path(__file__).parent / "grid.json"

# Landsat C2 L2 QA_PIXEL bits
FILL, DILATED, CIRRUS, CLOUD, SHADOW, WATER = 0, 1, 2, 3, 4, 7


def bit(qa, b):
    return (qa & (1 << b)) > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, nargs="+", default=[2022, 2023, 2024, 2025])
    ap.add_argument("--max-cloud", type=float, default=20)
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()

    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    items = []
    for y in args.years:
        search = catalog.search(
            collections=["landsat-c2-l2"],
            bbox=BBOX,
            datetime=f"{y}-06-15/{y}-08-31",  # peak summer only
            query={
                "eo:cloud_cover": {"lt": args.max_cloud},
                "platform": {"in": ["landsat-8", "landsat-9"]},
            },
        )
        found = list(search.items())
        print(f"{y}: {len(found)} scenes")
        items += found
    if not items:
        sys.exit("No scenes found. Try --max-cloud 40 or more years.")

    print(f"Loading {len(items)} scenes ...")
    ds = odc.stac.load(
        items,
        bands=["lwir11", "red", "nir08", "qa_pixel"],
        bbox=BBOX,
        crs="EPSG:4326",
        resolution=RES,
        groupby="solar_day",
        chunks={},
    )

    qa = ds.qa_pixel.astype("uint16")
    clear = ~(bit(qa, FILL) | bit(qa, DILATED) | bit(qa, CIRRUS) | bit(qa, CLOUD) | bit(qa, SHADOW))

    # Surface temperature: DN * 0.00341802 + 149.0 = Kelvin
    st_k = ds.lwir11.where(clear & (ds.lwir11 > 0)) * 0.00341802 + 149.0
    st_f = (st_k - 273.15) * 9 / 5 + 32

    # Surface reflectance: DN * 0.0000275 - 0.2
    red = ds.red.where(clear & (ds.red > 0)) * 0.0000275 - 0.2
    nir = ds.nir08.where(clear & (ds.nir08 > 0)) * 0.0000275 - 0.2
    ndvi = (nir - red) / (nir + red)

    water = bit(qa, WATER).where(clear).mean("time")

    print("Computing summer medians ...")
    lst_med = st_f.median("time").compute()
    ndvi_med = ndvi.median("time").compute().clip(-1, 1)
    water = (water.compute() > 0.5)

    lat = lst_med["latitude"].values
    lon = lst_med["longitude"].values
    lst_a, ndvi_a, water_a = lst_med.values, ndvi_med.values, water.values
    if lat[0] < lat[-1]:  # make row 0 = north
        lat = lat[::-1]
        lst_a, ndvi_a, water_a = lst_a[::-1], ndvi_a[::-1], water_a[::-1]

    h, w = lst_a.shape
    land = ~water_a & np.isfinite(lst_a)
    land_lst = lst_a[land]

    def enc(arr, scale):
        flat = np.round(arr.flatten() * scale)
        return [None if not np.isfinite(v) else int(v) for v in flat]

    dates = sorted({str(t)[:10] for t in ds.time.values})
    grid = {
        "source": "Landsat 8/9 Collection 2 Level-2 (USGS), via Microsoft Planetary Computer",
        "synthetic": False,
        "description": "Median of clear-sky summer (Jun 15-Aug 31) Landsat overpasses, ~10:30-11:00 local time",
        "dates": dates,
        "scene_count": len(dates),
        "bbox": [float(lon[0] - RES / 2), float(lat[-1] - RES / 2), float(lon[-1] + RES / 2), float(lat[0] + RES / 2)],
        "res": RES,
        "width": int(w),
        "height": int(h),
        "lst_f_x10": enc(lst_a, 10),
        "ndvi_x100": enc(ndvi_a, 100),
        "water": [int(v) for v in water_a.flatten()],
        "stats": {
            "lst_median_f": round(float(np.median(land_lst)), 1),
            "lst_p10_f": round(float(np.percentile(land_lst, 10)), 1),
            "lst_p90_f": round(float(np.percentile(land_lst, 90)), 1),
            "ndvi_median": round(float(np.nanmedian(ndvi_a[land])), 3),
        },
    }
    OUT.write_text(json.dumps(grid, separators=(",", ":")))
    print(f"Wrote {OUT} ({w}x{h} cells, {len(dates)} clear summer days)")
    print("Stats:", grid["stats"])

    if args.preview:
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 2, figsize=(14, 7))
        ext = [grid["bbox"][0], grid["bbox"][2], grid["bbox"][1], grid["bbox"][3]]
        shown = np.where(water_a, np.nan, lst_a)
        im = ax[0].imshow(shown, extent=ext, cmap="inferno", vmin=np.percentile(land_lst, 2), vmax=np.percentile(land_lst, 98))
        ax[0].set_title("Summer surface temperature (°F) — Landsat")
        fig.colorbar(im, ax=ax[0], shrink=0.7)
        im2 = ax[1].imshow(np.where(water_a, np.nan, ndvi_a), extent=ext, cmap="Greens", vmin=0, vmax=0.8)
        ax[1].set_title("Vegetation (NDVI)")
        fig.colorbar(im2, ax=ax[1], shrink=0.7)
        out = OUT.with_name("heatmap.png")
        fig.savefig(out, dpi=150, bbox_inches="tight")
        print(f"Saved {out}")


if __name__ == "__main__":
    main()
