import fs from "node:fs";
import { getPanoMeta } from "./pano-meta.mjs";

// Usage: node tag-copyright.mjs <input.json> <output.json> [--only-untagged]
//
// Unlike car color or camera generation, the copyright holder of a Street View panorama
// isn't something to visually judge from a render — it's exact metadata Google already
// reports per panorama (e.g. "© 2024 Google" for official Google-driven coverage, or
// "© <company/agency>" for third-party trekker/government imagery). It's also independent
// of the capture date (extra.panoDate), which people otherwise conflate it with.
//
// This adds one tag per location with the copyright holder's name (the "© YYYY " prefix is
// stripped so it reads like the other short tags, e.g. "Google" or "Instituto Geografico
// Nacional"). Fully automatic and 100% accurate — no image rendering, no review needed.

const args = process.argv.slice(2);
const [inputPath, outputPath] = args.filter((a) => !a.startsWith("--"));
const onlyUntagged = args.includes("--only-untagged");

if (!inputPath || !outputPath) {
  console.error("Usage: node tag-copyright.mjs <input.json> <output.json> [--only-untagged]");
  process.exit(1);
}

function normalizeCopyrightHolder(copyright) {
  if (!copyright) return null;
  // "© 2024 Google" -> "Google"; "© 2019 Instituto Geografico Nacional" -> "Instituto Geografico Nacional"
  return copyright.replace(/^©\s*\d{4}\s*/, "").trim() || null;
}

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
  const alreadyHasCopyrightTag = existingTags.some((t) => /google|instituto|survey|geografic/i.test(t));
  if (onlyUntagged && alreadyHasCopyrightTag) {
    skipped++;
    continue;
  }
  try {
    const meta = await getPanoMeta(panoId);
    const holder = normalizeCopyrightHolder(meta.copyright);
    if (!holder) {
      console.log(`[${index}] no copyright info returned`);
      continue;
    }
    c.extra ??= {};
    c.extra.tags ??= [];
    if (!c.extra.tags.some((t) => t.toLowerCase() === holder.toLowerCase())) {
      c.extra.tags.push(holder);
      tagged++;
    }
    console.log(`[${index}] ${panoId} -> "${holder}"`);
  } catch (e) {
    console.log(`[${index}] FAILED: ${e.message}`);
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
console.log(`\nTagged ${tagged} location(s), skipped ${skipped} (already tagged). Wrote ${outputPath}`);
