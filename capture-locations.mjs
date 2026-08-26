import fs from "node:fs";
import path from "node:path";
import { renderLocationBundle } from "./render-pano.mjs";
import { mapConcurrent } from "./concurrency.mjs";

// Usage:
//   node capture-locations.mjs <input.json> <outDir> [--only-untagged] [--limit N] [--concurrency N]
//
// For each location in a GeoGuessr customCoordinates JSON, renders: front/back perspective
// crops at yaw 0°/180° — the panorama's OWN forward/backward direction, where the car
// normally shows in a natural recognizable shape (the PRIMARY images to review) — a
// ground/nadir band as a fallback for the rare case neither front nor back shows the car, and
// a crop of the "© YYYY Google" watermark baked into the tiles. Writes JPEGs per location plus
// a manifest.json describing them, for a human (or Claude) to review and tag with
// apply-tags.mjs.
//
// IMPORTANT: front/back deliberately do NOT use `headingDeg` from pano-meta.mjs as the yaw.
// headingDeg is descriptive metadata (it tells you what compass bearing yaw=0 already faces),
// not a rotation to apply — using it as yaw double-rotates away from forward. Confirmed by
// screenshotting Google's own viewer at heading=X and finding it matches yaw=0 here, not
// yaw=X. See renderCarViews in render-pano.mjs for the full writeup.
//
// Note the watermark year is NOT the same as panoDate (capture date) — it reflects whenever
// the imagery was last reprocessed, which can be later — so don't assume they match.
//
// No Google API key required — image tiles come from Street View's own tile CDN.
//
// A full-360° nadir band alone (no front/back) was tried first so no yaw ever needs guessing,
// but two problems showed up in practice: the equirectangular warp turns the car into a
// hard-to-read curved streak rather than a normal hood shape, and older/lower-quality
// panoramas can have genuinely blank imagery at the deepest nadir (not a bug — Google just
// never captured it), which shows up as a black gap right where the car would be. front/back
// perspective crops read far better, so those are primary; the band is kept only as a
// fallback reference.
//
// Performance: renderLocationBundle stitches each panorama's tiles exactly once (in parallel)
// and derives all crops from that single fetch, instead of re-stitching per crop. Locations
// are also processed with bounded concurrency (default 8) rather than one at a time — for
// thousands of locations this is the difference between ~6s/location serially (~1.7hr/1000
// locations) and roughly that same total work spread across concurrent workers.

const args = process.argv.slice(2);
const [inputPath, outDir] = args.filter((a) => !a.startsWith("--"));
const onlyUntagged = args.includes("--only-untagged");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split("=")[1], 10) : 8;

if (!inputPath || !outDir) {
  console.error("Usage: node capture-locations.mjs <input.json> <outDir> [--only-untagged] [--limit=N] [--concurrency=N]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

let coords = data.customCoordinates.map((c, index) => ({ c, index }));
if (onlyUntagged) {
  coords = coords.filter(({ c }) => !(c.extra?.tags?.length > 0));
}
coords = coords.slice(0, limit);

const started = Date.now();
const results = await mapConcurrent(coords, concurrency, async ({ c, index }) => {
  const panoId = c.panoId || c.extra?.panoId;
  if (!panoId) {
    console.log(`[${index}] no panoId, skipping`);
    return null;
  }
  try {
    const { front, back, ground, watermark } = await renderLocationBundle(panoId, { zoom: 3 });
    const frontFile = path.join(outDir, `${index}-${panoId}-front.jpg`);
    const backFile = path.join(outDir, `${index}-${panoId}-back.jpg`);
    const groundFile = path.join(outDir, `${index}-${panoId}-ground.jpg`);
    const watermarkFile = path.join(outDir, `${index}-${panoId}-watermark.jpg`);
    await Promise.all([
      front.toFile(frontFile),
      back.toFile(backFile),
      ground.toFile(groundFile),
      watermark.toFile(watermarkFile),
    ]);
    console.log(`[${index}] saved ${frontFile} (existing tags: ${JSON.stringify(c.extra?.tags ?? [])})`);
    return {
      index,
      panoId,
      frontFile,
      backFile,
      groundFile,
      watermarkFile,
      panoDate: c.extra?.panoDate ?? null,
      existingTags: c.extra?.tags ?? [],
    };
  } catch (e) {
    console.log(`[${index}] FAILED: ${e.message}`);
    return null;
  }
});

const manifest = results.filter(Boolean).sort((a, b) => a.index - b.index);
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nWrote ${manifest.length} location(s) (front+back+ground+watermark renders) + manifest.json to ${outDir} in ${elapsed}s`);
