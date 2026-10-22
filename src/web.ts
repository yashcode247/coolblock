// Web front end: the Heat Explorer at /, the chat at /chat (same agent as iMessage), and the JSON API behind both.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { CoolBlock } from "./agent.js";
import type { Grid } from "./grid.js";
import { UpstreamError } from "./cache.js";
import { climateHistory } from "./climate.js";
import { describePoint, searchWorld } from "./geocode.js";
import { liveWeather } from "./live.js";
import { coolRefuges } from "./refuges.js";
import { colormap, regionalHeat, validSeason } from "./satellite.js";

const MAX_BODY = 20 * 1024 * 1024;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const LEAFLET = join(ROOT, "node_modules", "leaflet", "dist");
const gz = promisify(gzip);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

class BadRequest extends Error {}

export function runWeb(bot: CoolBlock, port: number, grid: Grid, gridPath: string) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/msg") return await onMessage(bot, req, res);
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      if (url.pathname.startsWith("/api/")) return await onApi(url, req, res, grid, gridPath);
      return await onStatic(url.pathname, req, res);
    } catch (e) {
      const status = e instanceof BadRequest ? 400 : e instanceof UpstreamError && e.status === 429 ? 503 : 502;
      if (status !== 400) console.error("[web]", url.pathname, e instanceof Error ? e.message : e);
      const error = e instanceof BadRequest ? e.message
        : status === 503 ? "A free data service is rate-limiting requests right now. Try again in a few minutes."
        : "A data service didn't answer. Try again in a moment.";
      if (!res.headersSent) await send(req, res, status, { error });
    }
  });
  server.listen(port, () => {
    const { port: p } = server.address() as AddressInfo;
    console.log(`🌍 Heat Explorer on http://localhost:${p}   💬 chat on http://localhost:${p}/chat`);
  });
  return server;
}

async function onMessage(bot: CoolBlock, req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return void res.writeHead(413).end();
    chunks.push(c as Buffer);
  }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BadRequest("body must be JSON"); }
  const user = `web:${String(body.user ?? "anon").slice(0, 64)}`;
  try {
    const replies = await bot.handle(user, {
      text: body.text,
      image: body.imageB64 ? { data: Buffer.from(body.imageB64, "base64"), mimeType: body.mimeType } : undefined,
    });
    await send(req, res, 200, {
      replies: replies.map((r) => (r.type === "text" ? r : { type: "image", src: `data:image/jpeg;base64,${r.jpeg.toString("base64")}`, name: r.name, delayMs: r.delayMs })),
      context: bot.context(user),
    });
  } catch (e) {
    console.error("[web] chat", e);
    await send(req, res, 500, { replies: [{ type: "text", text: "Something went wrong, try again." }], context: bot.context(user) });
  }
}

const num = (url: URL, k: string, lo: number, hi: number) => {
  const v = Number(url.searchParams.get(k));
  if (!url.searchParams.has(k) || !Number.isFinite(v) || v < lo || v > hi) throw new BadRequest(`${k} must be a number between ${lo} and ${hi}`);
  return v;
};
const point = (url: URL) => ({ lat: num(url, "lat", -85, 85), lon: num(url, "lon", -180, 180) });
const lang = (url: URL) => (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(url.searchParams.get("lang") ?? "") ? url.searchParams.get("lang")! : "en");

async function onApi(url: URL, req: IncomingMessage, res: ServerResponse, grid: Grid, gridPath: string) {
  switch (url.pathname) {
    case "/api/search": {
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      return send(req, res, 200, { places: q.trim() ? await searchWorld(q, lang(url)) : [] });
    }
    case "/api/reverse": {
      const { lat, lon } = point(url);
      return send(req, res, 200, { label: await describePoint(lat, lon, lang(url)) });
    }
    case "/api/climate": {
      const { lat, lon } = point(url);
      return send(req, res, 200, await climateHistory(lat, lon), "public, max-age=3600");
    }
    case "/api/satellite": {
      const { lat, lon } = point(url);
      const start = url.searchParams.get("start") ?? "", end = url.searchParams.get("end") ?? "";
      const layer = url.searchParams.get("layer") === "night" ? "night" : "day";
      if (!validSeason(start, end)) throw new BadRequest("start/end must be YYYY-MM-DD, at most ~4 months apart, from March 2000 on");
      return send(req, res, 200, await regionalHeat(lat, lon, start, end, layer), "public, max-age=3600");
    }
    case "/api/now": {
      const { lat, lon } = point(url);
      return send(req, res, 200, await liveWeather(lat, lon), "no-cache");
    }
    case "/api/refuges": {
      const { lat, lon } = point(url);
      return send(req, res, 200, { refuges: await coolRefuges(lat, lon) });
    }
    case "/api/colormap": { // lets the browser decode NASA's global tiles itself
      const name = url.searchParams.get("name");
      if (name !== "MODIS_Land_Surface_Temp") throw new BadRequest("unknown colormap");
      return send(req, res, 200, { entries: (await colormap(name)).entries }, "public, max-age=86400");
    }
    case "/api/landsat": // the street-level Landsat grid the chat uses, drawn as a 50 m layer on the map
      return sendFile(req, res, gridPath, "application/json", "public, max-age=86400");
    case "/api/block": {
      const { lat, lon } = point(url);
      const reading = grid.lookup(lat, lon);
      return send(req, res, 200, { reading, nearby: reading ? grid.nearbyExtremes(lat, lon) : null, meta: grid.meta });
    }
  }
  throw new BadRequest("unknown endpoint");
}

async function onStatic(path: string, req: IncomingMessage, res: ServerResponse) {
  if (path === "/") path = "/index.html";
  if (path === "/chat" || path === "/chat/") path = "/chat.html";
  const [base, rel] = path.startsWith("/vendor/leaflet/") ? [LEAFLET, path.slice("/vendor/leaflet/".length)] : [PUBLIC, path.slice(1)];
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { throw new BadRequest("malformed path"); }
  const file = normalize(join(base, decoded));
  if (!file.startsWith(base + sep)) return void res.writeHead(403).end();
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return void res.writeHead(404).end();
  return sendFile(req, res, file, type, base === LEAFLET ? "public, max-age=86400" : "no-cache");
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string, cache: string) {
  let body: Buffer;
  try { body = await readFile(file); } catch { return void res.writeHead(404).end(); }
  return write(req, res, 200, body, type, cache);
}

function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, cache = "no-store") {
  return write(req, res, status, Buffer.from(JSON.stringify(value)), "application/json", cache);
}

async function write(req: IncomingMessage, res: ServerResponse, status: number, body: Buffer, type: string, cache: string) {
  const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" };
  if (body.length > 1024 && /^(text|application\/(json|manifest)|image\/svg)/.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    body = await gz(body);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = String(body.length);
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
