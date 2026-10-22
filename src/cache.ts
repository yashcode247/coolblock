// Small two-level cache (memory + disk) for the free upstream services the explorer uses.
// Every one of them is rate-limited per IP, so each answer is fetched once and reused.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

const DIR = process.env.CACHE_DIR ?? ".cache";
const MEM_MAX = 2_000;
const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

const file = (ns: string, key: string, ext: string) =>
  join(DIR, ns, createHash("sha1").update(key).digest("hex").slice(0, 20) + ext);

function remember(key: string, value: unknown) {
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value!);
  mem.set(key, { at: Date.now(), value });
}

/** Runs fn once per key while a call is in flight, so concurrent requests share one upstream fetch. */
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** JSON-cached call. ttlMs = Infinity for data that never changes (past satellite composites). */
export function cachedJson<T>(ns: string, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const k = `${ns}:${key}`;
  const hit = mem.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  return dedupe(k, async () => {
    const path = file(ns, key, ".json");
    try {
      const s = await stat(path);
      if (Date.now() - s.mtimeMs < ttlMs) {
        const value = JSON.parse(await readFile(path, "utf8")) as T;
        remember(k, value);
        return value;
      }
    } catch { /* not cached yet */ }
    const value = await fn();
    remember(k, value);
    await mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, JSON.stringify(value))).catch(() => {});
    return value;
  });
}

/** Binary-cached call for images that never change once published (map tiles of a past date). */
export function cachedBuffer(ns: string, key: string, fn: () => Promise<Buffer>): Promise<Buffer> {
  const k = `${ns}:${key}`;
  return dedupe(k, async () => {
    const path = file(ns, key, ".bin");
    try { return await readFile(path); } catch { /* not cached yet */ }
    const buf = await fn();
    await mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, buf)).catch(() => {});
    return buf;
  });
}

/** Runs async jobs with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** fetch with a timeout and the project's User-Agent; throws on non-2xx with the status in the message. */
export async function fetchOk(url: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, headers, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    ...rest,
    headers: { "User-Agent": userAgent(), ...(headers as Record<string, string> | undefined) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError(`${new URL(url).host} ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res;
}

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const userAgent = () => process.env.GEOCODER_USER_AGENT ?? "CoolBlock/0.2 (HackHarvard 2026 project)";
