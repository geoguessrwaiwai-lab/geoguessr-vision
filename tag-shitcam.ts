import fs from 'node:fs';
import { getPanoMeta, isKnownShitcam } from './pano-meta.ts';
import { mapConcurrent } from './concurrency.ts';
import { positionalArgs, hasFlag, getFlagInt } from './shared/cli-args.ts';
import { getPanoId, ensureExtraTags, addTagIfNew } from './shared/location-utils.ts';
import { isGeneration } from './shared/generations.ts';
import type { CustomCoordinatesFile } from './shared/types.ts';

/**
 * 使い方: npx tsx tag-shitcam.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]
 *
 * isKnownShitcam()(pano-meta.ts参照)を使って地点を"Shitcam"としてタグ付けする —既知の低品質サードパーティカバレッジである国/期間の範囲を手動で
 * キュレーションした表。
 * resolutionHeight===6656の地点のみをチェックする(READMEのResolutionHeight表を参照)。
 * これは限定的で不完全なヒューリスティックであり、表がカバーする特定の国/期間でのみShitcamを検出できる — 表の範囲外の地点は、
 * 実際にShitcamであってもタグ付けされずに残る。
 * これは意図的に許容されているfalse negativeであり、バグではない: この手法が見逃すものは画像ベースのレビューに委ねられる。
 * 非Shitcam地点を誤ってShitcamとタグ付けすることは決してない(表はタグを追加するだけで削除しない)ので、
 * 他のタグ付けステップの前後どちらで実行しても安全。
 */

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, 'only-untagged');
  const concurrency = getFlagInt(args, 'concurrency', 8);

  if (!inputPath || !outputPath) {
    console.error(
      'Usage: npx tsx tag-shitcam.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]',
    );
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  let tagged = 0;
  let skipped = 0;

  const entries = data.customCoordinates.map((c, index) => ({ c, index }));

  await mapConcurrent(entries, concurrency, async ({ c, index }) => {
    const panoId = getPanoId(c);
    if (!panoId) {
      console.log(`[${index}] no panoId, skipping`);
      return;
    }
    const existingTags = c.extra?.tags ?? [];
    const alreadyHasGenTag = existingTags.some((t) => isGeneration(t));
    if (onlyUntagged && alreadyHasGenTag) {
      skipped++;
      return;
    }
    try {
      const meta = await getPanoMeta(panoId);
      if (meta.resolutionHeight !== 6656) {
        console.log(
          `[${index}] ${panoId} resolutionHeight=${meta.resolutionHeight}, not in the Gen2/Gen3/Shitcam range, skipping`,
        );
        return;
      }
      if (!isKnownShitcam(meta)) {
        console.log(`[${index}] ${panoId} not a known Shitcam country/date, skipping`);
        return;
      }
      const tags = ensureExtraTags(c);
      if (addTagIfNew(tags, 'Shitcam')) tagged++;
      console.log(`[${index}] ${panoId} (${meta.countryCode} ${meta.date}) -> "Shitcam"`);
    } catch (e) {
      console.log(`[${index}] FAILED: ${(e as Error).message}`);
    }
  });

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(
    `\nTagged ${tagged} location(s), skipped ${skipped} (already tagged). Wrote ${outputPath}`,
  );
}

await main();
