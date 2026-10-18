// iMessage via the Photon 2.0 beta (@photon-ai/api). Credentials come from
// PHOTON_PROJECT_ID (pho_prj_...) and PHOTON_API_KEY (a project key with
// project:read and project:write), both from the beta dashboard.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, Photon } from "@photon-ai/api";
import type { CoolBlock, Inbound } from "./agent.js";

const POLL_MS = 2_000;
// listMessages is eventually consistent, so each poll re-reads a short overlap.
const OVERLAP_MS = 15_000;

type Part = { type: string; text?: string; attachmentId?: string };
type Received = {
  id: string;
  createdAt: string;
  status: string;
  content: Part & { parts?: Part[] };
  sentBy: { id: string; kind: string };
  receivedBy?: { id: string };
  space: { id: string };
};

export async function runPhoton(bot: CoolBlock) {
  const project = process.env.PHOTON_PROJECT_ID!;
  const photon = new Photon({ headers: { Authorization: `Bearer ${process.env.PHOTON_API_KEY}` } });
  const startedAt = Date.now();
  let cursor = startedAt;
  const seen = new Set<string>();
  console.log("📱 Photon 2.0 iMessage agent listening");

  while (true) {
    try {
      let pageToken: string | undefined;
      do {
        const page = await photon.projects.listMessages({
          path: { id: project },
          query: {
            createdSince: new Date(cursor - OVERLAP_MS).toISOString(),
            direction: "received",
            order: "asc",
            pageSize: 100,
            platform: "imessage",
            ...(pageToken ? { pageToken } : {}),
          },
        });
        for (const m of page.items as unknown as Received[]) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          const created = Date.parse(m.createdAt);
          cursor = Math.max(cursor, created);
          if (created < startedAt || m.status !== "received" || m.sentBy.kind !== "human") continue;
          void handle(photon, project, bot, m);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      console.error("[photon] poll", describe(e));
      if (e instanceof ApiError && e.status === 429) {
        await sleep(Number(e.headers?.get("retry-after") ?? 10) * 1000);
      }
    }
    await sleep(POLL_MS);
  }
}

async function handle(photon: Photon, project: string, bot: CoolBlock, m: Received) {
  const senderId = m.receivedBy?.id;
  if (!senderId) return console.error("[photon] message has no receiving agent", m.id);
  const spaceId = m.space.id;
  const typing = (on: boolean) =>
    photon.projects.setSpaceTyping({ path: { id: project, spaceId }, body: { senderId, typing: on } }).catch(() => {});

  try {
    const inbound = await toInbound(photon, project, m.content);
    if (!inbound) return;
    await typing(true);
    const replies = await bot.handle(m.sentBy.id, inbound);
    const send = (i: number, content: Parameters<typeof photon.projects.sendMessage>[0]["body"]["content"]) =>
      photon.projects.sendMessage({
        path: { id: project },
        headers: { "idempotency-key": `coolblock:${m.id}:${i}` },
        body: { spaceId, senderId, content },
      });
    for (const [i, r] of replies.entries()) {
      if (r.type === "text") {
        await send(i, { type: "text", format: "plain", text: r.text });
        continue;
      }
      try {
        await send(i, { type: "attachment", attachmentId: await upload(photon, project, r.jpeg, r.name) });
      } catch (e) {
        console.error("[photon] image", describe(e));
        await send(i, { type: "text", format: "plain", text: "Couldn't send the tree photo just now. Try another photo in a moment." });
      }
    }
  } catch (e) {
    console.error("[photon]", describe(e));
  } finally {
    await typing(false);
  }
}

async function toInbound(photon: Photon, project: string, content: Received["content"]): Promise<Inbound | null> {
  const parts = content.type === "group" ? content.parts ?? [] : [content];
  for (const p of parts) {
    if (p.type !== "attachment" || !p.attachmentId) continue;
    const meta = await photon.projects.getAttachment({ path: { id: project, attachmentId: p.attachmentId } });
    if (!/^image\//.test(meta.contentType)) continue;
    return { image: { data: await download(photon, project, p.attachmentId), mimeType: meta.contentType } };
  }
  const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
  return text ? { text } : null;
}

async function download(photon: Photon, project: string, attachmentId: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const blob = (await photon.projects.downloadAttachment({ path: { id: project, attachmentId } })) as Blob;
      return Buffer.from(await blob.arrayBuffer());
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409) || attempt >= 5) throw e;
      await sleep(5_000);
    }
  }
}

async function upload(photon: Photon, project: string, jpeg: Buffer, name: string): Promise<string> {
  const boundary = `coolblock-${randomUUID()}`;
  const meta = JSON.stringify({ contentType: "image/jpeg", sizeBytes: jpeg.length, filename: name });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const attachment = await photon.projects.uploadAttachment({
    path: { id: project },
    headers: {
      "content-length": String(body.length),
      "content-type": `multipart/related; boundary=${boundary}`,
      "idempotency-key": randomUUID(),
    },
    body: new Blob([body]),
  });
  return attachment.id;
}

function describe(e: unknown): string {
  if (e instanceof ApiError) return `HTTP ${e.status} ${e.message} (request ${e.requestId ?? "unknown"})`;
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message;
}
