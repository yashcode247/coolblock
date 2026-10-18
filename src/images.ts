import sharp from "sharp";
// @ts-ignore — no types published
import heicConvert from "heic-convert";

/** Normalise any inbound photo (iPhone HEIC, PNG, JPEG) to a <=1280px JPEG. */
export async function toJpeg(buf: Buffer, mimeType = ""): Promise<Buffer> {
  let input = buf;
  const isHeic = /hei[cf]/i.test(mimeType) || buf.subarray(4, 12).toString("latin1").includes("ftyphei");
  if (isHeic) input = Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }));
  return sharp(input).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
}
