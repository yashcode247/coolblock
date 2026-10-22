// CoolBlock web chat: the same agent as the iMessage number, with sound, motion and quick replies.
import { sfx } from "./sfx.js";
import { leafBurst, enableRipples, haptic, reducedMotion, toast, h } from "./fx.js";
import { heatCss } from "./heat.js";

const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
const log = $("#log"), input = /** @type {HTMLTextAreaElement} */ ($("#t")), fileInput = /** @type {HTMLInputElement} */ ($("#file"));
const sendBtn = /** @type {HTMLButtonElement} */ ($("#send")), chipsEl = $("#chips"), statusEl = $("#status");
const sleep = (/** @type {number} */ ms) => new Promise((ok) => setTimeout(ok, reducedMotion() ? Math.min(ms, 150) : ms));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const IDLE = "online · satellite link ready";
const EXAMPLES = ["Nubian Square", "Chinatown", "Harvard Square", "East Boston"];

let user = store.get("cb_user");
if (!user) { user = Math.random().toString(36).slice(2); store.set("cb_user", user); }
let ctx = { stage: "new", place: /** @type {any} */ (null), reading: /** @type {any} */ (null) };
let busy = false;
let lastSender = "";
let lastPhoto = /** @type {string|null} */ (null);
let lastQuery = "";
/** @type {any[]} */
let transcript = [];

// ---------------------------------------------------------------- rendering
const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Text with °F values as heat chips, phone numbers as tel: links and bare domains as links. Never uses innerHTML. */
function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /(\d{2,3})°F|(\b\d{3}-\d{3}-\d{4}\b)|\b((?:[a-z0-9-]+\.)+(?:gov|org|com|net|edu)(?:\/[\w\-./?=&#%]*[\w/])?)/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(h("span", { class: "temp", style: { background: heatCss(Math.max(0, Math.min(1, (Number(m[1]) - 70) / 45))) } }, m[0]));
    else if (m[2]) frag.append(h("a", { href: "tel:" + m[2].replaceAll("-", "") }, m[2]));
    else frag.append(h("a", { href: "https://" + m[3], target: "_blank", rel: "noopener" }, m[3]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function row(who, bubble) {
  const first = lastSender !== who;
  lastSender = who;
  const r = h("div", { class: `msg ${who}${first ? " first" : ""}` }, who === "bot" ? h("span", { class: "face", "aria-hidden": "true" }, "🌳") : null, bubble, h("span", { class: "time" }, clock()));
  log.querySelector(".meta")?.remove();
  log.append(r);
  scrollDown();
  return r;
}
const scrollDown = () => requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

function addText(who, text, { copy = false, save = true } = {}) {
  const b = h("div", { class: "b" }, richText(text));
  const r = row(who, b);
  if (copy) {
    r.classList.add("has-copy");
    const btn = h("button", { class: "copy", type: "button" }, "📋 Copy");
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); btn.textContent = "✓ Copied"; btn.classList.add("done"); sfx.chime(); haptic(15); }
      catch { toast("Select the text and copy it"); }
    });
    b.append(btn);
  }
  if (save) remember({ who, kind: "text", text, copy });
  return r;
}

function addImage(who, src, { scan = false, save = true } = {}) {
  const img = /** @type {HTMLImageElement} */ (h("img", { src, alt: who === "me" ? "Your photo" : "CoolBlock image" }));
  img.addEventListener("load", scrollDown);
  img.addEventListener("click", () => openLightbox(src));
  const r = row(who, h("div", { class: `b img${scan ? " scan" : ""}` }, img));
  if (save) remember({ who, kind: "img", src });
  return r;
}

/** Drag-to-compare: the street as it is, and with trees. Sweeps once on arrival. */
function addCompare(before, after, { save = true, animate = true } = {}) {
  const wrap = h("div", { class: "compare", role: "slider", tabindex: 0, "aria-label": "Compare your street today and with trees", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": 50 },
    h("img", { src: before, alt: "Your street today" }), h("img", { class: "after", src: after, alt: "Your street with trees" }),
    h("span", { class: "bar" }), h("span", { class: "knob", "aria-hidden": "true" }, "⟷"),
    h("span", { class: "tag l" }, "Today"), h("span", { class: "tag r" }, "🌳 With trees"));
  const set = (p) => { wrap.style.setProperty("--pos", `${p}%`); wrap.setAttribute("aria-valuenow", String(Math.round(p))); };
  const afterImg = /** @type {HTMLImageElement} */ (wrap.querySelector(".after"));
  afterImg.addEventListener("load", () => { wrap.style.setProperty("--ar", `${afterImg.naturalWidth}/${afterImg.naturalHeight}`); scrollDown(); });
  const move = (e) => { const r = wrap.getBoundingClientRect(); set(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))); };
  wrap.addEventListener("pointerdown", (e) => { wrap.setPointerCapture(e.pointerId); move(e); });
  wrap.addEventListener("pointermove", (e) => { if (wrap.hasPointerCapture(e.pointerId)) move(e); });
  wrap.addEventListener("keydown", (e) => {
    const cur = Number(wrap.getAttribute("aria-valuenow"));
    if (e.key === "ArrowLeft") set(Math.max(0, cur - 5));
    if (e.key === "ArrowRight") set(Math.min(100, cur + 5));
  });
  wrap.addEventListener("dblclick", () => openLightbox(after));
  const r = row("bot", h("div", { class: "b img" }, wrap));
  if (animate && !reducedMotion()) {
    const t0 = performance.now();
    set(100);
    const step = (now) => {
      const t = Math.max(0, Math.min(1, (now - t0) / 2200));
      // all "today" → all trees → settle in the middle
      set(t < 0.55 ? 100 - (t / 0.55) * 100 : ((t - 0.55) / 0.45) * 50);
      if (t < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 300);
  } else set(50);
  if (save) remember({ who: "bot", kind: "compare", before, after });
  return r;
}

function typingBubble() {
  const r = h("div", { class: "msg bot first typing-row" }, h("span", { class: "face", "aria-hidden": "true", style: { visibility: "visible" } }, "🌳"),
    h("div", { class: "b" }, h("span", { class: "typing", "aria-label": "CoolBlock is typing" }, h("i"), h("i"), h("i"))));
  log.append(r);
  scrollDown();
  return r;
}

// ---------------------------------------------------------------- status line while waiting
const WAIT = {
  photo: ["looking at your street…", "comparing it with the satellite reading…", "planting trees on your photo… 🌱", "watering them… 💧", "almost there, trees take a moment to grow…"],
  address: ["finding that address…", "reading Landsat satellite data… 🛰️", "drawing your block's heat map…"],
  owner: ["looking up your city's free tree program…"],
  hello: ["waking up… ☀️"],
};
let waitTimer = 0, tickTimer = 0;
function setBusy(kind) {
  clearInterval(waitTimer);
  clearTimeout(tickTimer);
  if (!kind) { statusEl.textContent = IDLE; statusEl.classList.remove("busy"); return; }
  const lines = WAIT[kind];
  let i = 0;
  statusEl.textContent = lines[0];
  statusEl.classList.add("busy");
  waitTimer = window.setInterval(() => { statusEl.textContent = lines[Math.min(lines.length - 1, ++i)]; }, kind === "photo" ? 4200 : 2200);
  const tick = () => { sfx.typing(); tickTimer = window.setTimeout(tick, 380 + Math.random() * 520); };
  tick();
}

// ---------------------------------------------------------------- talking to the agent
async function send(payload, kind) {
  if (busy) return;
  busy = true;
  setChips([]);
  setBusy(kind);
  let typing = typingBubble();
  const t0 = Date.now();
  try {
    const res = await fetch("/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, ...payload }) });
    const body = await res.json();
    await sleep(Math.max(0, 650 - (Date.now() - t0)));
    const prevStage = ctx.stage;
    let afterArrow = false, gotRequest = false;
    for (const [i, x] of (body.replies ?? []).entries()) {
      if (i > 0) {
        typing = typingBubble();
        await sleep(x.delayMs ?? 700);
      }
      typing.remove();
      if (x.type === "text") {
        addText("bot", x.text, { copy: afterArrow });
        gotRequest ||= afterArrow;
        afterArrow = /👇/.test(x.text);
        sfx.pop();
      } else if (/with-trees/.test(x.name ?? "") && lastPhoto) {
        addCompare(lastPhoto, x.src);
        sfx.sparkle();
        const r = log.lastElementChild?.getBoundingClientRect();
        if (r) leafBurst(r.left + r.width / 2, r.top + 40, 36);
      } else {
        addImage("bot", x.src, { scan: true });
        sfx.ping();
      }
      haptic(8);
    }
    if (body.context) ctx = body.context;
    if (gotRequest && prevStage !== "done") {
      setTimeout(() => { leafBurst(innerWidth / 2, innerHeight * 0.75, 56); sfx.sparkle(); haptic(40); toast("🌳 Your tree request is ready. Copy it and send it in!", 4200); }, 400);
    }
    setChips(chipsFor(body.replies ?? []));
  } catch {
    typing.remove();
    addText("bot", "Connection problem. Check your internet and try again.", { save: false });
    setChips(chipsFor([]));
  } finally {
    busy = false;
    setBusy(null);
    input.focus({ preventScroll: true });
  }
}

function sendText(text) {
  text = text.trim();
  if (!text || busy) return;
  addText("me", text);
  delivered();
  sfx.send();
  haptic(10);
  const kind = /^\/?reset$/i.test(text) ? "hello" : /^(own|rent|public|i own|i rent|owner|renter|tenant|none|neither|park|plaza|yes|no|y|n)\b/i.test(text) ? "owner" : /^(hi|hey|hello|start|help)\b/i.test(text) ? "hello" : "address";
  if (kind === "address") lastQuery = text;
  send({ text }, kind);
}
const delivered = () => log.append(h("div", { class: "meta" }, "Delivered ✓"));

/** Downscales a photo to ≤1600 px JPEG in the browser (faster upload). Falls back to the raw file, e.g. HEIC. */
async function preparePhoto(file) {
  const raw = await new Promise((ok, fail) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result)); rd.onerror = fail; rd.readAsDataURL(file); });
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    /** @type {CanvasRenderingContext2D} */ (c.getContext("2d")).drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.88);
    return { display: url, b64: url.split(",")[1], mime: "image/jpeg" };
  } catch {
    return { display: raw, b64: raw.split(",")[1], mime: file.type };
  }
}

async function sendPhoto(file) {
  if (!file || busy) return;
  if (!file.type.startsWith("image/") && !/\.hei[cf]$/i.test(file.name)) { toast("That's not a photo. Send a picture of your street."); return; }
  sfx.shutter();
  haptic(20);
  const p = await preparePhoto(file);
  lastPhoto = p.display;
  addImage("me", p.display);
  delivered();
  send({ imageB64: p.b64, mimeType: p.mime }, "photo");
}

// ---------------------------------------------------------------- quick replies
function chipsFor(replies) {
  const said = replies.map((r) => (r.type === "text" ? r.text : "")).join("\n");
  const place = ctx.place;
  const explore = (label) => place ? { label, href: `/#lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}&n=${encodeURIComponent(place.label)}` } : null;
  if (/outside my satellite map|couldn't find/i.test(said) && lastQuery)
    return [{ label: `🌍 Explore “${lastQuery.slice(0, 24)}” anywhere on Earth`, href: `/#q=${encodeURIComponent(lastQuery)}`, primary: true }, ...EXAMPLES.slice(0, 3).map((t) => ({ label: t, text: t }))];
  if (ctx.stage === "askOwner")
    return [{ label: "🏠 I own it", text: "I own it", primary: true }, { label: "🔑 I rent", text: "I rent", primary: true }, { label: "🏛️ Public space", text: "Public space", primary: true }];
  if (ctx.stage === "located")
    return [{ label: "📸 Send a street photo", photo: true, primary: true }, explore("🗺️ Full summer analysis"), { label: "↪ Another address", focus: true }].filter(Boolean);
  if (ctx.stage === "done")
    return [explore("🗺️ Explore this block's summer"), { label: "📸 Another photo", photo: true }, { label: "↺ Start over", reset: true }].filter(Boolean);
  return [...EXAMPLES.map((t) => ({ label: `📍 ${t}`, text: t })), { label: "🌍 Any city? Heat Explorer", href: "/" }];
}

function setChips(list) {
  chipsEl.replaceChildren(...list.map((c, i) => {
    const el = c.href
      ? h("a", { class: `chip ripple${c.primary ? " primary" : ""}`, href: c.href, style: { animationDelay: `${i * 50}ms` } }, c.label)
      : h("button", { type: "button", class: `chip ripple${c.primary ? " primary" : ""}`, style: { animationDelay: `${i * 50}ms` } }, c.label);
    el.addEventListener("click", (e) => {
      sfx.tick();
      if (c.href) return;
      e.preventDefault();
      if (c.text) sendText(c.text);
      else if (c.photo) fileInput.click();
      else if (c.focus) { input.focus(); input.placeholder = "Type another address…"; }
      else if (c.reset) reset();
    });
    return el;
  }));
}

// ---------------------------------------------------------------- transcript (survives a reload in this tab)
function remember(item) {
  transcript.push(item);
  try {
    let keep = transcript;
    while (JSON.stringify(keep).length > 3_500_000 && keep.length > 1) keep = keep.slice(1);
    sessionStorage.setItem("cb_chat", JSON.stringify({ items: keep, ctx }));
  } catch { /* storage full or blocked */ }
}
function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("cb_chat") ?? "null");
    if (!saved?.items?.length) return false;
    transcript = saved.items;
    ctx = saved.ctx ?? ctx;
    for (const it of transcript) {
      if (it.kind === "text") addText(it.who, it.text, { copy: it.copy, save: false });
      else if (it.kind === "img") addImage(it.who, it.src, { save: false });
      else if (it.kind === "compare") addCompare(it.before, it.after, { save: false, animate: false });
    }
    log.querySelectorAll(".msg").forEach((m) => { /** @type {HTMLElement} */ (m).style.animation = "none"; });
    setChips(chipsFor([]));
    return true;
  } catch { return false; }
}

async function reset() {
  if (busy) return;
  try { sessionStorage.removeItem("cb_chat"); } catch { /* ignore */ }
  transcript = [];
  lastSender = "";
  lastPhoto = null;
  ctx = { stage: "new", place: null, reading: null };
  sfx.whoosh();
  [...log.children].forEach((el, i) => { /** @type {HTMLElement} */ (el).style.transition = `opacity .3s ${i * 15}ms, transform .3s ${i * 15}ms`; /** @type {HTMLElement} */ (el).style.opacity = "0"; /** @type {HTMLElement} */ (el).style.transform = "translateY(-10px)"; });
  await sleep(350);
  log.replaceChildren();
  await fetch("/api/msg", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, text: "reset" }) }).catch(() => {});
  send({ text: "hi" }, "hello");
}

// ---------------------------------------------------------------- input wiring
const grow = () => { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; sendBtn.disabled = !input.value.trim(); };
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = input.value;
  if (!v.trim() || busy) return;
  input.value = "";
  grow();
  sendBtn.classList.remove("fly");
  void sendBtn.offsetWidth;
  sendBtn.classList.add("fly");
  sendText(v);
});
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) sendPhoto(f); });
input.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); sendPhoto(f); }
});
const app = $("#app"), drop = $("#drop");
let dragDepth = 0;
app.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); dragDepth++; drop.hidden = false; } });
app.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
app.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
app.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; drop.hidden = true; const f = e.dataTransfer?.files?.[0]; if (f) sendPhoto(f); });

const lightbox = $("#lightbox");
function openLightbox(src) { /** @type {HTMLImageElement} */ (lightbox.querySelector("img")).src = src; lightbox.hidden = false; sfx.tick(); }
lightbox.addEventListener("click", () => { lightbox.hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") lightbox.hidden = true; });

const soundBtn = $("#sound");
const syncSound = () => { soundBtn.textContent = sfx.enabled ? "🔊" : "🔇"; soundBtn.setAttribute("aria-pressed", String(sfx.enabled)); };
soundBtn.addEventListener("click", () => { sfx.enabled = !sfx.enabled; syncSound(); if (sfx.enabled) sfx.chime(); });
syncSound();
$("#reset").addEventListener("click", reset);
$("#explore").addEventListener("click", (e) => {
  if (!ctx.place) return;
  e.preventDefault();
  location.href = `/#lat=${ctx.place.lat.toFixed(4)}&lon=${ctx.place.lon.toFixed(4)}&n=${encodeURIComponent(ctx.place.label)}`;
});

// ---------------------------------------------------------------- start
function openApp() {
  $("#intro").classList.add("gone");
  app.classList.remove("hidden");
  setTimeout(() => { $("#intro").hidden = true; }, 700);
}
const q = new URLSearchParams(location.search).get("q");
enableRipples();
if (q) {
  // Arriving from the Heat Explorer with a place: skip the intro and look it up straight away.
  openApp();
  history.replaceState(null, "", "/chat");
  sendText(q);
} else if (restore()) {
  openApp();
} else {
  $("#go").addEventListener("click", () => {
    sfx.whoosh();
    haptic(15);
    openApp();
    send({ text: "hi" }, "hello");
    setTimeout(() => input.focus(), 500);
  });
}
