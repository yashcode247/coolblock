// Tiny synthesized sound effects (WebAudio, no audio files). Shared by the Heat Explorer and the chat.
// Browsers only allow audio after a user gesture, so the context is created lazily on first use.

const KEY = "cb_sound";
let ctx = /** @type {AudioContext|null} */ (null);
let master = /** @type {GainNode|null} */ (null);
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== "off"; } catch { /* private mode */ }

// Browsers refuse audio until the person has interacted with the page, so stay silent until then.
const activated = () => /** @type {any} */ (navigator).userActivation?.hasBeenActive ?? true;

function audio() {
  if (!enabled || !activated()) return null;
  if (!ctx) {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** A single enveloped oscillator note. */
function tone(freq, { type = "sine", at = 0, dur = 0.18, vol = 0.5, slideTo = 0, attack = 0.005 } = {}) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = /** @type {OscillatorType} */ (type);
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Filtered noise sweep. */
function noise({ at = 0, dur = 0.5, from = 400, to = 3000, vol = 0.35, q = 1.2 } = {}) {
  const c = audio();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf;
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  get enabled() { return enabled; },
  set enabled(v) {
    enabled = v;
    try { localStorage.setItem(KEY, v ? "on" : "off"); } catch { /* ignore */ }
    if (!v && ctx) ctx.suspend().catch(() => {});
  },
  /** Message sent / camera flying away. */
  whoosh: () => noise({ dur: 0.55, from: 300, to: 2600, vol: 0.28 }),
  /** Soft send blip. */
  send: () => { tone(520, { dur: 0.09, vol: 0.25, slideTo: 880 }); noise({ dur: 0.18, from: 1500, to: 5000, vol: 0.08 }); },
  /** Incoming message bubble. */
  pop: () => { tone(880, { dur: 0.12, vol: 0.32, slideTo: 1320, type: "triangle" }); tone(1760, { at: 0.04, dur: 0.08, vol: 0.08 }); },
  /** Satellite data arrived: sonar ping with two echoes. */
  ping: () => { [0, 0.22, 0.44].forEach((at, i) => tone(1318, { at, dur: 0.5, vol: 0.28 / (i * 1.8 + 1) })); },
  /** UI tick for tabs and toggles. */
  tick: () => tone(1200, { dur: 0.035, vol: 0.12, type: "square" }),
  /** Two-note success chime. */
  chime: () => { tone(784, { dur: 0.35, vol: 0.3 }); tone(1175, { at: 0.12, dur: 0.5, vol: 0.26 }); },
  /** Rising arpeggio for celebrations (confetti). */
  sparkle: () => [1047, 1319, 1568, 2093, 2637].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.22, vol: 0.18, type: "triangle" })),
  /** Low two-tone alert for dangerous heat ahead. */
  alert: () => { tone(440, { dur: 0.22, vol: 0.25, type: "sawtooth" }); tone(330, { at: 0.24, dur: 0.3, vol: 0.22, type: "sawtooth" }); },
  /** Gentle bubbling for "typing…". */
  typing: () => tone(660 + Math.random() * 220, { dur: 0.05, vol: 0.05, type: "sine" }),
  /** Shutter for photos. */
  shutter: () => { noise({ dur: 0.08, from: 2000, to: 6000, vol: 0.3, q: 0.7 }); noise({ at: 0.09, dur: 0.07, from: 1500, to: 4000, vol: 0.2, q: 0.7 }); },
  /** Heat shimmer: falling tone + hiss, used when a hot reading lands. */
  sizzle: () => { noise({ dur: 0.7, from: 5000, to: 1800, vol: 0.1, q: 0.6 }); tone(392, { dur: 0.5, vol: 0.12, slideTo: 330 }); },
};
