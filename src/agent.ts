import { geocode, reverseGeocode, type Place } from "./geocode.js";
import { Grid, type BlockReading } from "./grid.js";
import { toJpeg } from "./images.js";
import { addTrees } from "./gemini.js";
import { analyzeStreet, type StreetAnalysis } from "./vision.js";
import { renderHeatCard, type HeatCard } from "./heatcard.js";

export type Inbound = { text?: string; image?: { data: Buffer; mimeType?: string } };
export type Reply = { type: "text"; text: string } | { type: "image"; jpeg: Buffer; name: string };
export type PhotoAction = "notStreet" | "alreadyShaded" | "hiddenHeat" | "addTrees";

export type Deps = {
  analyzeStreet: (jpeg: Buffer) => Promise<StreetAnalysis | null>;
  addTrees: (jpeg: Buffer, analysis?: StreetAnalysis | null) => Promise<Buffer>;
  reverseGeocode: (lat: number, lon: number) => Promise<string | null>;
  heatCard: (place: Place, reading: BlockReading) => Promise<HeatCard | null>;
};

type Session = { place?: Place; reading?: BlockReading; stage: "new" | "located" | "askOwner" | "done" };

const f = (n: number) => `${Math.round(n)}°F`;
const SHADED_CANOPY = 0.35;

/** What to do with a street photo, from what the photo shows and what the satellite measured. */
export function decidePhotoAction(analysis: StreetAnalysis | null, reading: BlockReading | null | undefined): PhotoAction {
  if (!analysis) return "addTrees";
  if (!analysis.isOutdoorStreet) return "notStreet";
  const shaded = analysis.canopyShare >= SHADED_CANOPY;
  if (!reading) return shaded ? "alreadyShaded" : "addTrees";
  if (!shaded) return "addTrees";
  // A hot block wins over "not hot" signals like a missing leafy comparison, so it's checked first.
  if (reading.percentile >= 70) return "hiddenHeat";
  if (reading.percentile < 60 || reading.greenDeltaF === null || reading.greenDeltaF < 2) return "alreadyShaded";
  return "addTrees";
}

export class CoolBlock {
  private sessions = new Map<string, Session>();
  private deps: Deps;
  constructor(private grid: Grid, deps: Partial<Deps> = {}) {
    this.deps = { analyzeStreet, addTrees, reverseGeocode, heatCard: (p, r) => renderHeatCard(grid, p, r), ...deps };
  }

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
    if (/^(hi|hey|hello|start|help|\?)\b/i.test(text) && text.split(/\s+/).length <= 3)
      return [t(FACTS[Math.floor(Math.random() * FACTS.length)]), t(INTRO)];
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
    if (r.synthetic) lines.push("", "(demo data, not real satellite readings)");
    const photoAsk = "📸 Now step outside and snap a photo of your street. I'll grow it some shade and show you the cooler block it could become.";

    const card = await this.deps.heatCard(place, r).catch((e) => { console.error("[heatcard]", e); return null; });
    if (!card) return [t(`${lines.join("\n")}\n\n${photoAsk}`)];
    return [
      t(lines.join("\n")),
      { type: "image", jpeg: card.jpeg, name: "coolblock-heat-map.jpg" },
      t(`Here's your block from space: red is hotter ground, blue is cooler. The hottest and coolest blocks within 1 km are circled.\n\n${photoAsk}`),
    ];
  }

  private async onPhoto(s: Session, image: { data: Buffer; mimeType?: string }): Promise<Reply[]> {
    const jpeg = await toJpeg(image.data, image.mimeType).catch((e) => { console.error("[photo]", e); return null; });
    const analysis = jpeg ? await this.deps.analyzeStreet(jpeg).catch(() => null) : null;
    switch (decidePhotoAction(analysis, s.reading)) {
      case "notStreet":
        return [t("That doesn't look like a street. Send me a photo of the sidewalk outside your place.")];
      case "alreadyShaded":
        return this.onShaded(s);
      case "hiddenHeat":
        return this.onHiddenHeat(s);
      default:
        return this.onAddTrees(s, jpeg, analysis);
    }
  }

  private async onShaded(s: Session): Promise<Reply[]> {
    const p = s.place, r = s.reading;
    if (!p || !r)
      return [t("🌳 Your street already has good shade, so there's nothing to add. Text me the address and I'll check it from space and find the hottest block nearby.")];
    s.stage = "done";
    const hot = await this.hottestNearby(p, r);
    return [t([
      `🌳 Your street already has good shade, and the satellite agrees: your block measured about ${f(r.lstF)} on clear summer days, ` +
        `hotter than ${r.percentile}% of Boston, Cambridge & Somerville.`,
      "",
      hot
        ? `${hot}\n\nThat's where a tree would do the most good. Know anyone who lives there?`
        : "I couldn't find a hotter block within 1 km, so your area is in good shape.",
    ].join("\n"))];
  }

  private async onHiddenHeat(s: Session): Promise<Reply[]> {
    const p = s.place!, r = s.reading!;
    s.stage = "askOwner";
    const hot = await this.hottestNearby(p, r);
    return [
      t(
        `I can see trees in your photo, but from space your block reads about ${f(r.lstF)}, hotter than ${r.percentile}% of Boston, Cambridge & Somerville. ` +
        "So most of the heat is likely coming from rooftops, parking lots and pavement nearby rather than this street." +
        (hot ? `\n\n${hot}` : ""),
      ),
      t(askOwner(p)),
    ];
  }

  private async onAddTrees(s: Session, jpeg: Buffer | null, analysis: StreetAnalysis | null): Promise<Reply[]> {
    const out: Reply[] = [];
    let rendered = false;
    try {
      if (!jpeg) throw new Error("photo could not be read");
      const withTrees = await this.deps.addTrees(jpeg, analysis);
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
    const seen = analysis?.oneLine ? `I see: ${analysis.oneLine}.\n\n` : "";
    out.push(t(`${rendered ? "🌳 Your street, with trees.\n\n" : ""}${seen}${askOwner(s.place)}`));
    return out;
  }

  /** One sentence pointing to the hottest block within 1 km, or null if none is hotter than this one. */
  private async hottestNearby(p: Place, r: BlockReading): Promise<string | null> {
    const spot = this.grid.nearbyExtremes(p.lat, p.lon).hottest;
    if (!spot || Math.round(spot.lstF) <= Math.round(r.lstF)) return null;
    const street = await this.deps.reverseGeocode(spot.lat, spot.lon).catch(() => null);
    const metres = Math.max(100, Math.round(spot.distanceM / 100) * 100);
    const where = `about ${metres >= 1000 ? "1 km" : `${metres} m`} ${spot.direction}`;
    return street
      ? `The hottest block within 1 km is around ${street}, ${where}, at about ${f(spot.lstF)}.`
      : `The hottest block within 1 km is ${where} of you, at about ${f(spot.lstF)}.`;
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
          "1. Open the BOS:311 app, call 311, or call Urban Forestry at 617-635-8733 → \"New Tree Request\".\n" +
          "2. Check the spot: at least 10 ft from light poles, driveways and hydrants, not under power lines, room for a ~24 sq ft tree pit.\n" +
          "3. An arborist inspects; the city plants it and waters it for you.\n\nPaste this into your request 👇",
        ),
        t(`New street tree request for the sidewalk in front of ${p.label}. ${evidence} I am the property owner and would like a tree (or several) planted here.`),
      ];
      return [
        t("Heads up: Boston only acts on new-tree requests made by the property owner next to the spot, so renter requests get closed. Send this to your landlord 👇"),
        t(`Hi! I'm your tenant at ${p.label}. The City of Boston plants street trees out front for free; the owner just has to request one (311 app, or 617-635-8733). ${evidence} A tree would cool the building in summer and it costs you nothing. Would you be willing to submit the request?`),
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

const askOwner = (p: Place) =>
  `Street trees can cut peak summer air temperatures by roughly 2–9°F (US EPA), ` +
  `and each mature tree absorbs about 22 kg of CO₂ a year.\n\n` +
  `${p.city === "Boston" ? "Boston" : p.city === "Cambridge" ? "Cambridge" : "Your city"} plants street trees for free when residents ask. ` +
  `Do you OWN or RENT the home there? (reply OWN or RENT)`;

const FACTS = [
  "🔥 Did you know? On a sunny summer day, roofs and pavement can get 50–90°F hotter than the air around them (US EPA).",
  "🌡️ Did you know? Heat kills more Americans than any other kind of weather, more than hurricanes, floods or tornadoes (National Weather Service).",
  "🌳 Did you know? A patch of tree shade can be 20–45°F cooler than sun-baked pavement just a few steps away (US EPA).",
  "🏙️ Did you know? During heat waves, some Boston neighborhoods run up to 7.5°F hotter than the rest of the city, often the ones that were once redlined (City of Boston Heat Plan).",
];

const INTRO =
  "I'm CoolBlock 🌳🛰️, and I can see your neighborhood's heat from space.\n\n" +
  "1️⃣ Text me any address in Boston, Cambridge or Somerville and I'll reveal how hot that block gets on summer days.\n" +
  "2️⃣ Snap a photo of your street and I'll plant a few trees on it: a sneak peek at your block's cooler future.\n" +
  "3️⃣ Then I'll help you get a real one planted, for free.";
