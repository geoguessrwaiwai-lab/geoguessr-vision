import fs from "node:fs";
import { getPanoMeta } from "./pano-meta.ts";
import { mapConcurrent } from "./concurrency.ts";
import { positionalArgs, hasFlag, getFlagInt } from "./shared/cli-args.ts";
import { getPanoId, ensureExtraTags, addTagIfNew } from "./shared/location-utils.ts";
import type { CustomCoordinatesFile } from "./shared/types.ts";

// 使い方: npx tsx tag-month.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]
//
// getPanoMeta().date(撮影日、"YYYY-M"形式)から撮影月を英語の月名タグ("January"〜
// "December")として書き込む。世代を問わずすべての地点が対象(tag-shitcam.tsの
// resolutionHeightフィルタやtag-watermark-year.tsの世代フィルタとは異なり、撮影日は
// どの世代でもGoogleメタデータから直接取得できるため)。日付が取得できない地点は
// タグ付けせずスキップする。

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, "only-untagged");
  const concurrency = getFlagInt(args, "concurrency", 8);

  if (!inputPath || !outputPath) {
    console.error("Usage: npx tsx tag-month.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]");
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  let tagged = 0;
  let skipped = 0;
  let noDate = 0;

  const entries = data.customCoordinates.map((c, index) => ({ c, index }));

  await mapConcurrent(entries, concurrency, async ({ c, index }) => {
    const panoId = getPanoId(c);
    if (!panoId) {
      console.log(`[${index}] no panoId, skipping`);
      return;
    }
    const existingTags = c.extra?.tags ?? [];
    const alreadyHasMonthTag = existingTags.some((t) => (MONTH_NAMES as readonly string[]).includes(t));
    if (onlyUntagged && alreadyHasMonthTag) {
      skipped++;
      return;
    }
    try {
      const meta = await getPanoMeta(panoId);
      const month = meta.date ? parseInt(meta.date.split("-")[1], 10) : NaN;
      if (!meta.date || Number.isNaN(month) || month < 1 || month > 12) {
        noDate++;
        console.log(`[${index}] ${panoId} no usable date (${meta.date}), skipping`);
        return;
      }
      const tag = MONTH_NAMES[month - 1];
      const tags = ensureExtraTags(c);
      if (addTagIfNew(tags, tag)) tagged++;
      console.log(`[${index}] ${panoId} (${meta.date}) -> "${tag}"`);
    } catch (e) {
      console.log(`[${index}] FAILED: ${(e as Error).message}`);
    }
  });

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(`\nTagged ${tagged} location(s), skipped ${skipped} (already tagged), ${noDate} without a usable date. Wrote ${outputPath}`);
}

await main();
