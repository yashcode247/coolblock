// CoolBlock evals: does the agent tell people the truth about their block?
// Run: npm run eval   (needs data/grid.json; no API keys needed)
import { CoolBlock } from "../src/agent.js";
import { geocode } from "../src/geocode.js";
import { Grid } from "../src/grid.js";

const grid = new Grid(process.env.GRID_PATH ?? "data/grid.json");
const bot = new CoolBlock(grid);
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

if (grid.synthetic) console.log("\n⚠️  These ran on the SYNTHETIC grid. Re-run after data/precompute.py.");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
