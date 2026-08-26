import fs from "node:fs";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import { renderWatermarkCrop } from "./render-pano.mjs";

// Usage:
//   node tag-watermark-year.mjs <input.json> <output.json> [--only-untagged] [--concurrency=N]
//
// Automates reading the "© YYYY Google" watermark year baked into the panorama tiles — the
// thing render-pano.mjs's renderWatermarkCrop says was left for manual review because a plain
// OCR pass (tesseract/EasyOCR tried previously) wasn't accurate enough. This isn't the same
// value as extra.panoDate (capture date) or pano-meta.mjs's copyright year (always just
// today's year, not per-panorama) — see the README's copyright/year table.
//
// Technique adopted from igs's copyright-labeller (github.com/iggedi-ig-ig/copyright-labeller),
// which reports ~2/3 coverage at ~95% accuracy on the assigned labels:
//   - restrict the OCR character set to exactly what the watermark can contain (digits +
//     "Google" + space). A general-purpose OCR pass over small low-contrast text produces a
//     lot of garbage that isn't even shaped like a year; starving the recognizer down to the
//     actual alphabet in play removes most of that up front.
//   - don't trust a single OCR pass — only accept a year that comes out corroborated.
//     copyright-labeller OCRs one whole-equirect image and requires the same year to appear
//     in >=2 independently-detected text lines before trusting it.
//
// Corroboration here comes from two OCR passes over the SAME crop with different Tesseract
// page-segmentation modes (which text-line-detection strategy it uses), requiring both to
// agree. Cross-checking across renderWatermarkCrop's two independently-stitched resolutions
// (zoom=2 vs zoom=3) was tried first, mirroring copyright-labeller's own zoom levels more
// literally, but zoom=2's crop is small enough post-upscale that tesseract frequently reads
// nothing at all from it even when the watermark is clearly legible to the eye (confirmed
// against known-good crops) — so it was replaced with two configurations of the
// better-resolved zoom=3 crop instead, which corroborates in practice without starving away
// most of the coverage.
//
// When the two passes disagree, or either finds no plausible year at all, the location is
// still tagged — with UNCLEAR_TAG below — rather than silently left untouched, so these cases
// are visible for manual review instead of quietly falling through the cracks. Note this
// still can't win when renderWatermarkCrop's own fixed-position assumption misses the
// watermark outright (its NOTE flags this as empirical, and it does drift on some
// lower-resolution/older panoramas) — that case also correctly falls into UNCLEAR_TAG, since
// neither pass finds a plausible year, but no OCR strategy can read text that wasn't cropped
// in.

const LAUNCH_YEAR = 2007; // Street View's public launch
const CURRENT_YEAR = new Date().getFullYear();
const CHAR_WHITELIST = "0123456789Google ";
// Tag vocabulary shared with label-tool's training labels (see README): a bare "©YYYY" when
// the year is legible, "©unclear" when it isn't — never left untagged either way.
const UNCLEAR_TAG = "©unclear";

const args = process.argv.slice(2);
const [inputPath, outputPath] = args.filter((a) => !a.startsWith("--"));
const onlyUntagged = args.includes("--only-untagged");
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split("=")[1], 10) : 4;

if (!inputPath || !outputPath) {
  console.error("Usage: node tag-watermark-year.mjs <input.json> <output.json> [--only-untagged] [--concurrency=N]");
  process.exit(1);
}

// Most-frequent plausible year mentioned in one OCR pass's raw text, or null. A single pass
// can still surface more than one 4-digit run (e.g. picking up part of a house number), so
// this isn't the corroboration step itself — just cleans up one pass's output before the two
// passes are compared against each other.
function extractYear(text) {
  const years = [...text.matchAll(/\d{4}/g)]
    .map((m) => parseInt(m[0], 10))
    .filter((y) => y >= LAUNCH_YEAR && y <= CURRENT_YEAR);
  if (years.length === 0) return null;
  const counts = new Map();
  for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Renders and preprocesses the watermark crop once; both OCR passes reuse this same image so
// the corroboration is purely about detection strategy, not image quality.
async function renderPreprocessedWatermark(panoId, zoom) {
  const jpeg = await renderWatermarkCrop(panoId, { zoom });
  const raw = await jpeg.toBuffer();
  // The watermark is low-contrast (light grey/blue text on sky, or on varied ground colors),
  // which is what made a plain OCR pass unreliable enough to abandon before (see
  // renderWatermarkCrop's NOTE). Stretching each crop's own histogram — normalize() maps its
  // darkest/lightest pixels to black/white — consistently pulled the watermark text out
  // enough for tesseract to read the digits, confirmed against known-good crops during
  // development. A fixed brightness/contrast curve doesn't work here since the watermark
  // sits on backgrounds ranging from bright sky to dark asphalt.
  return sharp(raw).grayscale().normalize().jpeg().toBuffer();
}

async function ocrYear(worker, image, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const {
    data: { text },
  } = await worker.recognize(image);
  return extractYear(text);
}

// Cross-checks the watermark year from two OCR passes over the same (zoom=3) crop, using
// different page-segmentation strategies. Returns { year } when they agree, or
// { unclear: true } otherwise (no plausible year from either pass, or the two disagree).
async function readWatermarkYear(worker, panoId) {
  const image = await renderPreprocessedWatermark(panoId, 3);
  // SPARSE_TEXT looks for scattered independent text blobs; SINGLE_BLOCK assumes one
  // uniform block of text. They fail differently, so requiring both to land on the same year
  // is a real independent check rather than two runs of the same detector.
  const fromSparse = await ocrYear(worker, image, PSM.SPARSE_TEXT);
  const fromBlock = await ocrYear(worker, image, PSM.SINGLE_BLOCK);
  if (fromSparse !== null && fromSparse === fromBlock) return { year: fromSparse };
  return { unclear: true };
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));

let coords = data.customCoordinates.map((c, index) => ({ c, index }));
if (onlyUntagged) {
  coords = coords.filter(({ c }) => {
    const tags = c.extra?.tags ?? [];
    return !tags.some((t) => /^©(\d{4}|unclear)$/.test(t));
  });
}

console.log(`Processing ${coords.length} location(s) with ${concurrency} worker(s)...`);

const workers = await Promise.all(
  Array.from({ length: Math.min(concurrency, coords.length || 1) }, async () => {
    const worker = await createWorker("eng");
    await worker.setParameters({ tessedit_char_whitelist: CHAR_WHITELIST });
    return worker;
  })
);

let tagged = 0;
let unclear = 0;
let failed = 0;

let next = 0;
async function lane(worker) {
  while (next < coords.length) {
    const { c, index } = coords[next++];
    const panoId = c.panoId || c.extra?.panoId;
    if (!panoId) {
      console.log(`[${index}] no panoId, skipping`);
      continue;
    }
    try {
      const result = await readWatermarkYear(worker, panoId);
      const tag = result.unclear ? UNCLEAR_TAG : `©${result.year}`;
      c.extra ??= {};
      c.extra.tags ??= [];
      const existingLower = new Set(c.extra.tags.map((t) => t.toLowerCase()));
      if (!existingLower.has(tag.toLowerCase())) {
        c.extra.tags.push(tag);
        if (result.unclear) unclear++;
        else tagged++;
      }
      console.log(`[${index}] ${panoId} -> "${tag}"`);
    } catch (e) {
      failed++;
      console.log(`[${index}] FAILED: ${e.message}`);
    }
  }
}

await Promise.all(workers.map(lane));
await Promise.all(workers.map((w) => w.terminate()));

fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
console.log(
  `\nTagged ${tagged} location(s) with a year, ${unclear} as "${UNCLEAR_TAG}", ${failed} failed. Wrote ${outputPath}`
);
