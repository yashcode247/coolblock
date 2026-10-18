import { geocode, type Place } from "./geocode.js";
import { Grid, type BlockReading } from "./grid.js";
import { toJpeg } from "./images.js";
import { addTrees } from "./gemini.js";

export type Inbound = { text?: string; image?: { data: Buffer; mimeType?: string } };
export type Reply = { type: "text"; text: string } | { type: "image"; jpeg: Buffer; name: string };

type Session = { place?: Place; reading?: BlockReading; stage: "new" | "located" | "askOwner" | "done" };

const f = (n: number) => `${Math.round(n)}°F`;

export class CoolBlock {
  private sessions = new Map<string, Session>();
  constructor(private grid: Grid) {}

  private session(user: string) {
    let s = this.sessions.get(user);
    if (!s) this.sessions.set(user, (s = { stage: "new" }));
    return s;
  }

  async handle(user: string, msg: Inbound): Promise<Reply[]> {
    const s = this.session(user);
    if (msg.image) return this.onPhoto(s, msg.image);

    const text = (msg.text ?? "").trim();
    if (!text) return [];
    if (/^\/?reset$/i.test(text)) { this.sessions.delete(user); return [t("Reset. Text me an address to start.")]; }
    if (/^(hi|hey|hello|start|help|\?)\b/i.test(text) && text.split(/\s+/).length <= 3) return [t(INTRO)];
    if (s.stage === "askOwner" || s.stage === "done") {
      if (/^(own|i own|owner|yes|y|homeowner)\b/i.test(text)) return this.onOwner(s, true);
      if (/^(rent|i rent|renter|tenant|no|n)\b/i.test(text)) return this.onOwner(s, false);
    }
    return this.onAddress(s, text);
  }

  private async onAddress(s: Session, text: string): Promise<Reply[]> {
    const place = await geocode(text);
    if (!place) return [t(`I couldn't find "${text}" in Boston, Cambridge or Somerville. Try a street address like "120 Warren St, Roxbury".`)];
    const r = this.grid.lookup(place.lat, place.lon);
    if (!r) return [t(`${place.label} is outside my satellite map (or over water). I cover Boston, Cambridge and Somerville for now.`)];
    s.place = place;
    s.reading = r;
    s.stage = "located";

    const lines = [
      `🛰️ ${place.label}`,
      `On clear summer days, Landsat satellites measured the ground on your block at about ${f(r.lstF)}.`,
      `That's hotter than ${r.percentile}% of Boston, Cambridge & Somerville (typical: ${f(r.cityMedianF)}).`,
    ];
    if (r.greenDeltaF !== null && r.greenDeltaF >= 2)
      lines.push(`Leafy blocks within 1 km run ${f(r.greenDeltaF)} cooler.`);
    else if (r.greenDeltaF !== null && r.greenDeltaF < 2)
      lines.push(`Good news: you're about as cool as the leafy blocks around you.`);
    lines.push(`Green cover here: ${r.greenLabel} (NDVI ${r.ndvi.toFixed(2)}).`);
    lines.push("", "📸 Send me a photo of your street and I'll show you what it looks like with trees.");
    if (r.synthetic) lines.push("", "(demo data, not real satellite readings)");
    return [t(lines.join("\n"))];
  }

  private async onPhoto(s: Session, image: { data: Buffer; mimeType?: string }): Promise<Reply[]> {
    const out: Reply[] = [];
    let rendered = false;
    try {
      const jpeg = await toJpeg(image.data, image.mimeType);
      const withTrees = await addTrees(jpeg);
      out.push({ type: "image", jpeg: await toJpeg(withTrees, "image/jpeg"), name: "coolblock-with-trees.jpg" });
      rendered = true;
    } catch (e) {
      console.error("[addTrees]", e);
      const quota = e instanceof Error && /\b429\b|quota/i.test(e.message);
      out.push(t(quota
        ? "Couldn't draw the trees just now — the image service is over its quota. The heat data and tree request still work."
        : "Couldn't render the trees on that photo just now. Try another photo in a moment."));
    }
    if (!s.place) {
      out.push(t((rendered ? "🌳 That's your street with trees. " : "") + "Text me the address so I can pull the satellite heat data for it."));
      return out;
    }
    s.stage = "askOwner";
    out.push(t(
      `${rendered ? "🌳 Your street, with trees.\n\n" : ""}Street trees can cut peak summer air temperatures by roughly 2–9°F (US EPA), ` +
      `and each mature tree absorbs about 22 kg of CO₂ a year.\n\n` +
      `${s.place.city === "Boston" ? "Boston" : s.place.city === "Cambridge" ? "Cambridge" : "Your city"} plants street trees for free when residents ask. ` +
      `Do you OWN or RENT the home there? (reply OWN or RENT)`,
    ));
    return out;
  }

  private onOwner(s: Session, owns: boolean): Reply[] {
    s.stage = "done";
    const p = s.place, r = s.reading;
    if (!p || !r) return [t("Text me an address first.")];
    const evidence =
      `Satellite data (Landsat) shows this block's summer ground temperature averages about ${f(r.lstF)}, ` +
      `hotter than ${r.percentile}% of the city` + (r.greenDeltaF && r.greenDeltaF >= 2 ? `, and ${f(r.greenDeltaF)} hotter than leafy blocks nearby.` : ".");

    if (p.city === "Boston") {
      if (owns) return [
        t(
          "Here's how to get a free street tree from Boston:\n" +
          "1. Open the BOS:311 app, call 311, or call Urban Forestry at 617-635-TREE → \"New Tree Request\".\n" +
          "2. Check the spot: at least 10 ft from light poles, driveways and hydrants, not under power lines, room for a ~24 sq ft tree pit.\n" +
          "3. An arborist inspects; the city plants it and waters it for you.\n\nPaste this into your request 👇",
        ),
        t(`New street tree request for the sidewalk in front of ${p.label}. ${evidence} I am the property owner and would like a tree (or several) planted here.`),
      ];
      return [
        t("Heads up: Boston only acts on new-tree requests made by the property owner next to the spot, so renter requests get closed. Send this to your landlord 👇"),
        t(`Hi! I'm your tenant at ${p.label}. The City of Boston plants street trees out front for free; the owner just has to request one (311 app, or 617-635-TREE). ${evidence} A tree would cool the building in summer and it costs you nothing. Would you be willing to submit the request?`),
      ];
    }
    if (p.city === "Cambridge") {
      if (owns) return [
        t("Cambridge Public Works takes tree planting requests at cambridgema.gov/tree. For your own yard, Green Cambridge's Canopy Crew plants native trees for free.\n\nPaste this into your request 👇"),
        t(`Tree planting request for the sidewalk at ${p.label}. ${evidence} I'm the property owner and support planting here.`),
      ];
      return [
        t("In Cambridge the property owner next to the spot has the final say, so ask your landlord. Send this 👇"),
        t(`Hi! I'm your tenant at ${p.label}. Cambridge Public Works plants street trees on request (cambridgema.gov/tree). ${evidence} Would you be willing to request one?`),
      ];
    }
    return [t(`Contact your city's public works or forestry department to request a street tree. Include this: ${evidence}`)];
  }
}

const t = (text: string): Reply => ({ type: "text", text });

const INTRO =
  "Hi, I'm CoolBlock 🌳🛰️\nText me any address in Boston, Cambridge or Somerville and I'll tell you how hot that block gets in summer, measured from space. " +
  "Then send a photo of the street and I'll show it to you with trees, and help you get one planted for free.";
