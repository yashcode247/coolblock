// Leaflet layers for the Heat Explorer. Leaflet is loaded as a classic script (window.L).
import { paint } from "./heat.js";

const L = /** @type {any} */ (window).L;

/**
 * An image overlay backed by a <canvas>, so animation frames repaint in place instead of re-encoding images.
 * The data rasters are Web Mercator pixels, which is exactly how Leaflet stretches an overlay between its bounds.
 */
export const CanvasOverlay = L.ImageOverlay.extend({
  initialize(bounds, width, height, options) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pixels = this.ctx.createImageData(width, height);
    L.ImageOverlay.prototype.initialize.call(this, canvas, bounds, options);
  },
  _initImage() {
    const el = (this._image = this.canvas);
    L.DomUtil.addClass(el, "leaflet-image-layer");
    if (this._zoomAnimated) L.DomUtil.addClass(el, "leaflet-zoom-animated");
    if (this.options.className) L.DomUtil.addClass(el, this.options.className);
    el.onselectstart = L.Util.falseFn;
    el.onmousemove = L.Util.falseFn;
    if (this.options.zIndex != null) this._updateZIndex();
    this._updateOpacity();
  },
  /** Paints °F values on the heat scale. */
  draw(values, lo, hi, alpha = 210) {
    paint(this.pixels.data, values, lo, hi, alpha);
    this.ctx.putImageData(this.pixels, 0, 0);
  },
  /** Paints with a custom per-pixel colour function returning [r,g,b,a] or null. */
  drawWith(fn) {
    const px = this.pixels.data;
    for (let i = 0; i < px.length / 4; i++) {
      const c = fn(i), o = i * 4;
      if (!c) { px[o + 3] = 0; continue; }
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
    }
    this.ctx.putImageData(this.pixels, 0, 0);
  },
});

/**
 * NASA GIBS MODIS land-surface-temperature tiles, decoded in the browser through the product's colormap and
 * re-painted on CoolBlock's heat scale, so the whole planet reads on the same colours as the regional analysis.
 * Decoded values are kept per tile for the hover readout.
 */
export const HeatTiles = L.GridLayer.extend({
  options: { tileSize: 256, maxNativeZoom: 7, minZoom: 1, maxZoom: 19, lo: 50, hi: 140, opacity: 0.8, className: "heat-tiles" },
  initialize(date, colormap, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.date = date;
    this.lookup = new Map(colormap.map(([rgb, k]) => [rgb, ((k - 273.15) * 9) / 5 + 32]));
    this.values = new Map();
  },
  setDate(date) { this.date = date; this.values.clear(); this.redraw(); },
  createTile(coords, done) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { willReadFrequently: true }));
      g.drawImage(img, 0, 0);
      let data;
      try { data = g.getImageData(0, 0, 256, 256); } catch (e) { done(e, canvas); return; }
      const px = data.data, vals = new Float32Array(256 * 256);
      for (let i = 0, p = 0; i < px.length; i += 4, p++) {
        const v = px[i + 3] < 128 ? undefined : this.lookup.get((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        vals[p] = v === undefined ? NaN : v;
      }
      paint(px, vals, this.options.lo, this.options.hi, 255);
      g.putImageData(data, 0, 0);
      this.values.set(`${coords.z}/${coords.x}/${coords.y}`, vals);
      done(null, canvas);
    };
    img.onerror = () => done(null, canvas);
    img.src = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_Land_Surface_Temp_8Day_Day/default/${this.date}/GoogleMapsCompatible_Level7/${coords.z}/${coords.y}/${coords.x}.png`;
    return canvas;
  },
  /** °F under a lat/lng, from whichever native tile is loaded there. */
  valueAt(latlng, map) {
    const z = Math.min(this.options.maxNativeZoom, Math.round(map.getZoom()));
    const p = map.project(latlng, z);
    const key = `${z}/${Math.floor(p.x / 256)}/${Math.floor(p.y / 256)}`;
    const vals = this.values.get(key);
    if (!vals) return null;
    const v = vals[(Math.floor(p.y) % 256) * 256 + (Math.floor(p.x) % 256)];
    return Number.isFinite(v) ? v : null;
  },
});

export const pulseIcon = () => L.divIcon({ className: "pulse-pin", html: '<span class="ring r1"></span><span class="ring r2"></span><span class="dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11] });
export const spotIcon = (kind, text) => L.divIcon({ className: `spot-pin ${kind}`, html: `<span class="spot-ring"></span><span class="spot-label"></span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
export const emojiIcon = (emoji, cls = "") => L.divIcon({ className: `emoji-pin ${cls}`, html: `<span>${emoji}</span>`, iconSize: [30, 30], iconAnchor: [15, 28] });

/** Fills a spot marker's label safely (textContent, never HTML). */
export function labelSpot(marker, text) {
  const el = marker.getElement?.()?.querySelector(".spot-label");
  if (el) el.textContent = text;
}
