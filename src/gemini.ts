// Gemini image editing: POST .../models/{model}:generateContent
// Docs: https://ai.google.dev/gemini-api/docs/image-generation

const TREE_PROMPT =
  "Edit this street photo: add a row of healthy, mature, leafy deciduous street trees planted in sidewalk " +
  "tree pits along the street, with realistic dappled shade on the pavement. Keep the buildings, road, cars, " +
  "people, camera angle, lighting, weather and season exactly the same. Photorealistic, no text, no watermark.";

export async function addTrees(jpeg: Buffer): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-lite-image";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: jpeg.toString("base64") } },
            { text: TREE_PROMPT },
          ],
        }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: AbortSignal.timeout(90_000),
    },
  );
  const raw = await res.text();
  if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${raw.slice(0, 300)}`);
  let body: any;
  try { body = JSON.parse(raw); } catch { throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 300)}`); }
  const b64 = imageBase64(body);
  if (!b64) {
    const reason = body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "no image";
    throw new Error(`Gemini returned no image (${reason}): ${raw.slice(0, 300)}`);
  }
  return Buffer.from(b64, "base64");
}

function imageBase64(body: any): string | undefined {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const data = part?.inlineData?.data ?? part?.inline_data?.data;
    if (typeof data === "string" && data.length > 0) return data;
  }
}
