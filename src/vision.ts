// Reads a street photo with a fast Gemini model before deciding whether to draw trees.
import { generateContent } from "./gemini.js";

export type StreetAnalysis = {
  isOutdoorStreet: boolean;
  treeCount: "none" | "few" | "many";
  canopyShare: number; // fraction of the frame that is tree foliage
  pavedShare: number;
  roomForStreetTrees: boolean;
  oneLine: string; // empty when the model's line was unusable
};

const SCHEMA = {
  type: "OBJECT",
  properties: {
    isOutdoorStreet: { type: "BOOLEAN", description: "True if this is an outdoor photo of a street or sidewalk." },
    treeCount: { type: "STRING", enum: ["none", "few", "many"], description: "How many trees are visible." },
    canopyShare: { type: "NUMBER", description: "Fraction 0-1 of the frame covered by tree foliage." },
    pavedShare: { type: "NUMBER", description: "Fraction 0-1 of the frame that is pavement, road or parking." },
    roomForStreetTrees: { type: "BOOLEAN", description: "True if the sidewalk has room for new street trees." },
    oneLine: { type: "STRING", description: "What the street looks like, at most 15 words, no numbers." },
  },
  required: ["isOutdoorStreet", "treeCount", "canopyShare", "pavedShare", "roomForStreetTrees", "oneLine"],
};

const PROMPT =
  "You are helping a street-tree planting assistant. Look at this photo and fill in the schema. " +
  "canopyShare and pavedShare are fractions of the whole frame between 0 and 1. " +
  "oneLine describes the street in at most 15 words and contains no digits or numbers.";

export async function analyzeStreet(jpeg: Buffer): Promise<StreetAnalysis | null> {
  try {
    const model = process.env.GEMINI_VISION_MODEL ?? "gemini-3.5-flash-lite";
    const body = await generateContent(model, {
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: "image/jpeg", data: jpeg.toString("base64") } },
          { text: PROMPT },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
    }, 15_000);
    const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("");
    return parse(JSON.parse(text));
  } catch (e) {
    console.error("[analyzeStreet]", e instanceof Error ? e.message : e);
    return null;
  }
}

function parse(v: any): StreetAnalysis | null {
  if (!v || typeof v !== "object") return null;
  const share = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);
  const canopyShare = share(v.canopyShare), pavedShare = share(v.pavedShare);
  if (typeof v.isOutdoorStreet !== "boolean" || typeof v.roomForStreetTrees !== "boolean") return null;
  if (!["none", "few", "many"].includes(v.treeCount) || canopyShare === null || pavedShare === null) return null;
  return {
    isOutdoorStreet: v.isOutdoorStreet,
    treeCount: v.treeCount,
    canopyShare,
    pavedShare,
    roomForStreetTrees: v.roomForStreetTrees,
    oneLine: cleanLine(v.oneLine),
  };
}

// Replies must not contain numbers that don't come from the satellite grid.
function cleanLine(s: unknown): string {
  if (typeof s !== "string" || /\d/.test(s)) return "";
  return s.trim().replace(/[.!\s]+$/, "").split(/\s+/).slice(0, 15).join(" ");
}
