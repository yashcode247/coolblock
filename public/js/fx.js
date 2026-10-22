// Visual effects shared by the Heat Explorer and the chat. Everything respects prefers-reduced-motion.

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Short vibration on phones that support it. */
export const haptic = (ms = 12) => {
  if (!(/** @type {any} */ (navigator).userActivation?.hasBeenActive ?? true)) return;
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
};

const easeOut = (/** @type {number} */ t) => 1 - Math.pow(1 - t, 3);

/**
 * Animates an element's text from its current number (or `from`) to `to`.
 * @param {HTMLElement} el @param {number} to
 * @param {{ from?: number, duration?: number, format?: (n: number) => string }} [o]
 */
export function countUp(el, to, o = {}) {
  const format = o.format ?? ((n) => String(Math.round(n)));
  if (!Number.isFinite(to)) { el.textContent = "—"; return; }
  if (reducedMotion()) { el.textContent = format(to); return; }
  const from = o.from ?? (Number(el.dataset.v) || 0);
  const dur = o.duration ?? 900;
  const start = performance.now();
  el.dataset.v = String(to);
  const id = Number(el.dataset.anim || 0) + 1;
  el.dataset.anim = String(id);
  const step = (/** @type {number} */ now) => {
    if (el.dataset.anim !== String(id)) return;
    const t = Math.max(0, Math.min(1, (now - start) / dur));
    el.textContent = format(from + (to - from) * easeOut(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Leaf confetti burst from a point (defaults to the screen centre). */
export function leafBurst(x = innerWidth / 2, y = innerHeight / 2, count = 46) {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "fx-canvas";
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "9999" });
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.appendChild(canvas);
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  g.scale(dpr, dpr);
  const glyphs = ["🍃", "🌿", "🌱", "🍀", "🌳", "✨"];
  const parts = Array.from({ length: count }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1, v = 6 + Math.random() * 9;
    return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      s: 16 + Math.random() * 16, g: glyphs[(Math.random() * glyphs.length) | 0], life: 0 };
  });
  const t0 = performance.now();
  const frame = (/** @type {number} */ now) => {
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx + Math.sin(t * 3 + p.s) * 0.8; p.y += p.vy; p.r += p.vr;
      g.save();
      g.globalAlpha = Math.max(0, 1 - t / 2.4);
      g.translate(p.x, p.y);
      g.rotate(p.r);
      g.font = `${p.s}px serif`;
      g.fillText(p.g, -p.s / 2, p.s / 2);
      g.restore();
    }
    if (t < 2.4) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Material-style ripple on any element with class "ripple" (delegated, call once per page). */
export function enableRipples(root = document) {
  root.addEventListener("pointerdown", (e) => {
    const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.(".ripple"));
    if (!el || reducedMotion()) return;
    const r = el.getBoundingClientRect();
    const s = document.createElement("span");
    s.className = "ripple-ink";
    const size = Math.max(r.width, r.height) * 2;
    Object.assign(s.style, { width: size + "px", height: size + "px", left: e.clientX - r.left - size / 2 + "px", top: e.clientY - r.top - size / 2 + "px" });
    el.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });
}

/** Small transient message at the bottom of the screen. */
export function toast(text, ms = 3200) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 400); }, ms);
}

/** Creates an element with classes and children; strings become text nodes (never HTML). */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
