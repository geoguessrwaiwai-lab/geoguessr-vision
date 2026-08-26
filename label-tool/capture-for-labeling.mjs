import fs from "node:fs";
import path from "node:path";
import { renderLocationBundle } from "../render-pano.mjs";
import { mapConcurrent } from "../concurrency.mjs";

// Usage: node capture-for-labeling.mjs <candidates.json> <outDir> [--concurrency=N] [--append] [--preset-gen=Gen3]
//
// For each candidate { panoId, headingDeg, date, lat, lon, sourceFile }, renders into
// outDir/images/<panoId>/: front.jpg/back.jpg (perspective crops at nominal yaw 0°/180° — PRIMARY,
// the car reads as a normal recognizable hood shape here) and ground.jpg (a full-360° nadir
// band, kept only as a fallback for the rare case neither front nor back shows the car).
//
// front/back use nominal yaw=0/180 (with Gen3-proxy offsets), NOT headingDeg — see
// renderCarViews in render-pano.mjs for why
// headingDeg is descriptive metadata (what compass bearing yaw=0 happens to face), not a
// rotation to apply; using it as a yaw input double-rotates the view away from forward. It's
// still recorded per item below because the labeling UI's embedded Street View iframe needs
// it (Google's own `heading` URL param is a true compass bearing, unlike our yaw).
//
// A full-360° band alone (no front/back) was tried first so no yaw ever needs guessing, but
// two problems showed up: the equirectangular warp turns the car into a hard-to-read curved
// streak rather than a normal hood shape, and older/lower-quality panoramas can have
// genuinely blank imagery at the deepest nadir (not a bug — Google just never captured it),
// which shows up as a black gap right where the car would be. front/back read far better, so
// those are primary.
//
// renderLocationBundle stitches each panorama's tiles once (in parallel) and derives all
// crops from that single fetch; candidates are also processed with bounded concurrency
// (default 8) instead of one at a time, since this otherwise dominates wall-clock time when
// building a large labeling batch.
//
// Writes outDir/items.json for the labeling server to serve.

const args = process.argv.slice(2);
const [candidatesPath, outDir] = args.filter((a) => !a.startsWith("--"));
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split("=")[1], 10) : 8;
const append = args.includes("--append");
const presetGenArg = args.find((a) => a.startsWith("--preset-gen="));
const presetGen = presetGenArg ? presetGenArg.split("=")[1] : null;
const validGens = new Set(["Gen1", "Gen2", "Gen3", "Gen4", "Small cam"]);

if (!candidatesPath || !outDir) {
  console.error("Usage: node capture-for-labeling.mjs <candidates.json> <outDir> [--concurrency=N] [--append] [--preset-gen=Gen3]");
  process.exit(1);
}

if (presetGen && !validGens.has(presetGen)) {
  console.error(`Invalid --preset-gen value: ${presetGen}`);
  process.exit(1);
}

const allCandidates = JSON.parse(fs.readFileSync(candidatesPath, "utf8"));
const imagesDir = path.join(outDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });
const itemsPath = path.join(outDir, "items.json");
const existingItems = append && fs.existsSync(itemsPath)
  ? JSON.parse(fs.readFileSync(itemsPath, "utf8"))
  : [];
const existingPanoIds = new Set(existingItems.map((item) => item.panoId));
const candidates = allCandidates.filter((candidate) => !existingPanoIds.has(candidate.panoId));

if (append) {
  console.log(`append mode: ${existingItems.length} existing, ${candidates.length} new candidates`);
}

const started = Date.now();
const results = await mapConcurrent(candidates, concurrency, async (c, i) => {
  const dir = path.join(imagesDir, c.panoId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const { front, back, ground } = await renderLocationBundle(c.panoId, { zoom: 3 });
    await Promise.all([
      front.toFile(path.join(dir, "front.jpg")),
      back.toFile(path.join(dir, "back.jpg")),
      ground.toFile(path.join(dir, "ground.jpg")),
    ]);
    console.log(`[${i + 1}/${candidates.length}] ${c.panoId} done`);
    return {
      panoId: c.panoId,
      lat: c.lat,
      lon: c.lon,
      headingDeg: c.headingDeg,
      date: c.date,
      copyright: c.copyright,
      isScout: c.isScout,
      countryCode: c.countryCode,
      sourceFile: c.sourceFile,
      images: {
        front: `images/${c.panoId}/front.jpg`,
        back: `images/${c.panoId}/back.jpg`,
        ground: `images/${c.panoId}/ground.jpg`,
      },
    };
  } catch (e) {
    console.log(`[${i + 1}/${candidates.length}] ${c.panoId} FAILED: ${e.message}`);
    return null;
  }
});

const addedItems = results.filter(Boolean);
const items = [...existingItems, ...addedItems];
fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));

if (presetGen) {
  const labelsPath = path.join(outDir, "labels.json");
  const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, "utf8")) : {};
  const labeledAt = new Date().toISOString();
  for (const item of addedItems) {
    labels[item.panoId] = {
      gen: presetGen,
      confidence: "high",
      notes: "Preset from known country coverage; trekker/scout excluded",
      at: labeledAt,
    };
  }
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
  console.log(`Preset ${addedItems.length} new labels to ${presetGen}; hood color remains available for review`);
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nWrote ${items.length} total items (${addedItems.length} added) to ${outDir}/items.json in ${elapsed}s`);
