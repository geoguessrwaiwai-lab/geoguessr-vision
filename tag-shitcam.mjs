import fs from "node:fs";
import { getPanoMeta, isKnownShitcam } from "./pano-meta.mjs";

// Usage: node tag-shitcam.mjs <input.json> <output.json> [--only-untagged]
//
// Tags locations as "Shitcam" using isKnownShitcam() (see pano-meta.mjs) — a manually-curated
// table of country/date ranges known to be low-quality third-party coverage. Only
// resolutionHeight===6656 locations are checked (see README's ResolutionHeight table); this
// is a targeted, incomplete heuristic that only catches Shitcam in the specific
// countries/dates the table covers — locations outside that table are left untagged even if
// they ARE Shitcam. That's an accepted false-negative, not a bug: whatever this misses is
// left for image-based review. Never mistags a non-Shitcam location as Shitcam (the table
// only adds a tag, never removes one), so it's safe to run before or after other tagging
// steps.

const args = process.argv.slice(2);
const [inputPath, outputPath] = args.filter((a) => !a.startsWith("--"));
const onlyUntagged = args.includes("--only-untagged");

if (!inputPath || !outputPath) {
  console.error("Usage: node tag-shitcam.mjs <input.json> <output.json> [--only-untagged]");
  process.exit(1);
}

const GENERATIONS = new Set(["Gen1", "Gen2", "Gen3", "Gen4", "Smallcam", "Shitcam"]);

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
let tagged = 0;
let skipped = 0;

for (const [index, c] of data.customCoordinates.entries()) {
  const panoId = c.panoId || c.extra?.panoId;
  if (!panoId) {
    console.log(`[${index}] no panoId, skipping`);
    continue;
  }
  const existingTags = c.extra?.tags ?? [];
  const alreadyHasGenTag = existingTags.some((t) => GENERATIONS.has(t));
  if (onlyUntagged && alreadyHasGenTag) {
    skipped++;
    continue;
  }
  try {
    const meta = await getPanoMeta(panoId);
    if (meta.resolutionHeight !== 6656) {
      console.log(`[${index}] ${panoId} resolutionHeight=${meta.resolutionHeight}, not in the Gen2/Gen3/Shitcam range, skipping`);
      continue;
    }
    if (!isKnownShitcam(meta)) {
      console.log(`[${index}] ${panoId} not a known Shitcam country/date, skipping`);
      continue;
    }
    c.extra ??= {};
    c.extra.tags ??= [];
    if (!c.extra.tags.some((t) => t.toLowerCase() === "shitcam")) {
      c.extra.tags.push("Shitcam");
      tagged++;
    }
    console.log(`[${index}] ${panoId} (${meta.countryCode} ${meta.date}) -> "Shitcam"`);
  } catch (e) {
    console.log(`[${index}] FAILED: ${e.message}`);
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
console.log(`\nTagged ${tagged} location(s), skipped ${skipped} (already tagged). Wrote ${outputPath}`);
