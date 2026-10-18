import { existsSync } from "node:fs";
import { CoolBlock } from "./agent.js";
import { Grid } from "./grid.js";
import { runWeb } from "./web.js";

try { process.loadEnvFile(".env"); } catch { /* no .env file, use real env vars */ }

const gridPath = process.env.GRID_PATH ?? "data/grid.json";
if (!existsSync(gridPath)) {
  console.error(`Missing ${gridPath}. Run: python data/precompute.py   (or python data/make_demo_grid.py to test)`);
  process.exit(1);
}
const grid = new Grid(gridPath);
if (grid.synthetic) console.warn("⚠️  Using SYNTHETIC demo grid. Run data/precompute.py before demoing.");
const bot = new CoolBlock(grid);

const mode = process.argv[2] ?? "all"; // web | photon | all
if (mode === "web" || mode === "all") runWeb(bot, Number(process.env.PORT ?? 3000));
if (mode === "photon" || mode === "all") {
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_API_KEY) {
    console.warn("PHOTON_PROJECT_ID / PHOTON_API_KEY not set — skipping iMessage. Web chat still works.");
  } else if (!process.env.PHOTON_PROJECT_ID.startsWith("pho_prj_")) {
    console.warn("PHOTON_PROJECT_ID should start with pho_prj_ (Photon 2.0 beta project) — skipping iMessage.");
  } else {
    const { runPhoton } = await import("./photon.js");
    runPhoton(bot).catch((e) => console.error("[photon] fatal", e));
  }
}
