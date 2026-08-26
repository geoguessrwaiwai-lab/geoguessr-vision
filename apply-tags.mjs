import fs from "node:fs";

// Usage:
//   node apply-tags.mjs <input.json> <tags.json> <output.json>
//
// tags.json: [{ "index": 0, "panoId": "...", "tags": ["Blue 24"] }, ...]
// (as produced by reviewing the renders from capture-locations.mjs)
//
// Merges each entry's tags into customCoordinates[index].extra.tags, skipping any tag
// that's already present (case-insensitive) so re-running is safe. panoId is cross-checked
// against the source file to catch stale/mismatched tag files.

const [, , inputPath, tagsPath, outputPath] = process.argv;
if (!inputPath || !tagsPath || !outputPath) {
  console.error("Usage: node apply-tags.mjs <input.json> <tags.json> <output.json>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const tagEntries = JSON.parse(fs.readFileSync(tagsPath, "utf8"));

let applied = 0;
let skipped = 0;

for (const entry of tagEntries) {
  const loc = data.customCoordinates[entry.index];
  if (!loc) {
    console.log(`[${entry.index}] no such location, skipping`);
    continue;
  }
  const actualPanoId = loc.panoId || loc.extra?.panoId;
  if (entry.panoId && actualPanoId !== entry.panoId) {
    console.log(`[${entry.index}] panoId mismatch (expected ${entry.panoId}, found ${actualPanoId}), skipping`);
    continue;
  }
  loc.extra ??= {};
  loc.extra.tags ??= [];
  const existingLower = new Set(loc.extra.tags.map((t) => t.toLowerCase()));
  for (const tag of entry.tags ?? []) {
    if (existingLower.has(tag.toLowerCase())) {
      skipped++;
      continue;
    }
    loc.extra.tags.push(tag);
    existingLower.add(tag.toLowerCase());
    applied++;
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
console.log(`Applied ${applied} tag(s), skipped ${skipped} duplicate(s). Wrote ${outputPath}`);
