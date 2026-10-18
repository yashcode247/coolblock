// CoolBlock evals: does the agent tell people the truth about their block?
// Run: npm run eval   (needs data/grid.json; no API keys needed)
import sharp from "sharp";
import { CoolBlock, decidePhotoAction } from "../src/agent.js";
import { geocode } from "../src/geocode.js";
import { Grid, type BlockReading } from "../src/grid.js";
import { renderHeatCard } from "../src/heatcard.js";
import type { StreetAnalysis } from "../src/vision.js";

const grid = new Grid(process.env.GRID_PATH ?? "data/grid.json");
const bot = new CoolBlock(grid, { heatCard: async () => null });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

// 1. Physical sanity: big green spaces should read cooler than dense, paved areas.
const cool = ["boston common", "cambridge common", "harvard yard"];
const hot = ["chinatown", "nubian square", "east boston"];
const temps = async (names: string[]) =>
  Promise.all(names.map(async (n) => { const p = (await geocode(n))!; return grid.lookup(p.lat, p.lon)!.lstF; }));
const coolT = await temps(cool), hotT = await temps(hot);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
check("Parks read cooler than dense neighborhoods", avg(coolT) < avg(hotT),
  `parks ${avg(coolT).toFixed(1)}°F vs dense ${avg(hotT).toFixed(1)}°F`);

// 2. Faithfulness: every number the agent texts must match the satellite grid exactly.
for (const name of [...cool, ...hot]) {
  const p = (await geocode(name))!;
  const r = grid.lookup(p.lat, p.lon)!;
  const [reply] = await bot.handle(`eval:${name}`, { text: name });
  const text = reply.type === "text" ? reply.text : "";
  check(`Reply for "${name}" states the measured temperature`, text.includes(`${Math.round(r.lstF)}°F`));
  check(`Reply for "${name}" states the correct percentile`, text.includes(`hotter than ${r.percentile}%`));
}

// 3. Safety: out-of-area and nonsense input must not produce invented numbers.
const [far] = await bot.handle("eval:far", { text: "Times Square, New York" });
check("Out-of-area address gets no made-up data", far.type === "text" && !/°F/.test(far.text));

// 4. Policy correctness: Boston renters are told the owner must request.
await bot.handle("eval:renter", { text: "nubian square" });
(bot as any).sessions.get("eval:renter").stage = "askOwner";
const renter = await bot.handle("eval:renter", { text: "rent" });
check("Boston renter is routed to landlord", renter.some((r) => r.type === "text" && /property owner/.test(r.text)));

// 5. Photo decisions: what the photo shows vs what the satellite measured (no network).
const photo = (o: Partial<StreetAnalysis>): StreetAnalysis => ({
  isOutdoorStreet: true, treeCount: "none", canopyShare: 0.05, pavedShare: 0.6, roomForStreetTrees: true, oneLine: "A paved street", ...o,
});
const reading = (o: Partial<BlockReading>): BlockReading => ({
  lstF: 95, ndvi: 0.3, percentile: 50, greenNearbyF: 92, greenDeltaF: 3, cityMedianF: 96.6, greenLabel: "some", synthetic: false, sceneCount: 20, ...o,
});
const shady = photo({ treeCount: "many", canopyShare: 0.5 });
const decisions: [string, ReturnType<typeof decidePhotoAction>, ReturnType<typeof decidePhotoAction>][] = [
  ["no analysis (Gemini failed)", decidePhotoAction(null, reading({})), "addTrees"],
  ["indoor photo", decidePhotoAction(photo({ isOutdoorStreet: false }), reading({})), "notStreet"],
  ["shaded street on a cool block", decidePhotoAction(shady, reading({ percentile: 40 })), "alreadyShaded"],
  ["shaded street, as cool as leafy neighbours", decidePhotoAction(shady, reading({ percentile: 65, greenDeltaF: 1 })), "alreadyShaded"],
  ["shaded street on a hot block", decidePhotoAction(shady, reading({ percentile: 85, greenDeltaF: 6 })), "hiddenHeat"],
  ["shaded street on a hot block with no leafy comparison", decidePhotoAction(shady, reading({ percentile: 90, greenDeltaF: null })), "hiddenHeat"],
  ["bare street on a hot block", decidePhotoAction(photo({}), reading({ percentile: 85 })), "addTrees"],
  ["shaded street, warm block with hotter-than-leafy gap", decidePhotoAction(shady, reading({ percentile: 65, greenDeltaF: 4 })), "addTrees"],
  ["shaded street, no saved location", decidePhotoAction(shady, undefined), "alreadyShaded"],
  ["bare street, no saved location", decidePhotoAction(photo({}), undefined), "addTrees"],
  ["indoor photo, no saved location", decidePhotoAction(photo({ isOutdoorStreet: false }), undefined), "notStreet"],
];
for (const [name, got, want] of decisions) check(`Photo decision: ${name} → ${want}`, got === want, got === want ? "" : `got ${got}`);

// 6. An "already shaded" reply quotes the grid exactly and makes no image edit.
let editCalled = false;
const offline = new CoolBlock(grid, {
  analyzeStreet: async () => shady,
  addTrees: async () => { editCalled = true; throw new Error("should not be called"); },
  reverseGeocode: async () => null,
  heatCard: async () => null,
});
const commonPlace = (await geocode("boston common"))!;
const common = grid.lookup(commonPlace.lat, commonPlace.lon)!;
const hottest = grid.nearbyExtremes(commonPlace.lat, commonPlace.lon).hottest;
check("Boston Common photo with shade decides alreadyShaded", decidePhotoAction(shady, common) === "alreadyShaded",
  `percentile ${common.percentile}, greenDelta ${common.greenDeltaF?.toFixed(1)}`);
await offline.handle("eval:shaded", { text: "boston common" });
const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 120, b: 50 } } }).jpeg().toBuffer();
const shadedReply = await offline.handle("eval:shaded", { image: { data: jpg, mimeType: "image/jpeg" } });
const shadedText = shadedReply.map((r) => (r.type === "text" ? r.text : "")).join("\n");
check("Already-shaded reply makes no image edit", !editCalled && shadedReply.every((r) => r.type === "text"));
check("Already-shaded reply states the block's measured °F", shadedText.includes(`about ${Math.round(common.lstF)}°F`));
check("Already-shaded reply states the block's percentile", shadedText.includes(`hotter than ${common.percentile}%`));
check("Hottest nearby block reads the same as grid.lookup there", !!hottest && grid.lookup(hottest.lat, hottest.lon)?.lstF === hottest.lstF);
const allowedF = new Set([Math.round(common.lstF), ...(hottest ? [Math.round(hottest.lstF)] : [])]);
const statedF = [...shadedText.matchAll(/(\d+)°F/g)].map((m) => Number(m[1]));
check("Every °F in the already-shaded reply comes from the grid", statedF.length > 0 && statedF.every((n) => allowedF.has(n)),
  `stated ${statedF.join(", ")}°F`);
check("Already-shaded reply doesn't ask OWN/RENT", !/OWN or RENT/.test(shadedText) && (offline as any).sessions.get("eval:shaded").stage === "done");

// 7. Heat-map card: renders without the basemap, and every °F drawn on it is a grid value.
const ctPlace = (await geocode("chinatown"))!;
const ct = grid.lookup(ctPlace.lat, ctPlace.lon)!;
const card = await renderHeatCard(grid, ctPlace, ct, async () => { throw new Error("offline"); });
const meta = await sharp(card.jpeg).metadata();
check("Heat-map card renders with no basemap", meta.format === "jpeg" && meta.width === 1080 && (meta.height ?? 0) > 1080, `${meta.width}x${meta.height}`);
check("Heat-map card labels your block with the reply's °F", card.statedF[0] === Math.round(ct.lstF));
const ext = grid.nearbyExtremes(ctPlace.lat, ctPlace.lon);
const { stats } = grid.meta;
const cardAllowed = new Set([ct.lstF, ext.hottest?.lstF, ext.coolest?.lstF, stats.lst_p10_f, stats.lst_median_f, stats.lst_p90_f]
  .filter((n): n is number => n !== undefined).map(Math.round));
check("Every °F on the heat-map card comes from the grid", card.statedF.every((n) => cardAllowed.has(n)), `drawn ${card.statedF.join(", ")}°F`);

const withCard = await new CoolBlock(grid, { heatCard: async () => card }).handle("eval:card", { text: "chinatown" });
check("Address reply sends text, then the map, then the photo ask",
  withCard.map((r) => r.type).join(",") === "text,image,text" && withCard[2].type === "text" && /photo of your street/.test(withCard[2].text));
const cardFails = await new CoolBlock(grid, { heatCard: async () => { throw new Error("boom"); } }).handle("eval:nocard", { text: "chinatown" });
check("A failed heat map still sends the numbers and the photo ask",
  cardFails.length === 1 && cardFails[0].type === "text" && cardFails[0].text.includes(`${Math.round(ct.lstF)}°F`) && /photo of your street/.test(cardFails[0].text));

if (grid.synthetic) console.log("\n⚠️  These ran on the SYNTHETIC grid. Re-run after data/precompute.py.");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
