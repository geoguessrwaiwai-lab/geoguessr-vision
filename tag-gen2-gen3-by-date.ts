import fs from 'node:fs';
import { getPanoMeta, isKnownShitcam } from './pano-meta.ts';
import { mapConcurrent } from './concurrency.ts';
import { positionalArgs, hasFlag, getFlagInt } from './shared/cli-args.ts';
import { getPanoId, ensureExtraTags, addTagIfNew } from './shared/location-utils.ts';
import { isGeneration } from './shared/generations.ts';
import { CAMERA_GENS_BY_COUNTRY } from './shared/camera-gens-by-country.ts';
import type { CustomCoordinatesFile } from './shared/types.ts';

/**
 * 使い方: npx tsx tag-gen2-gen3-by-date.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]
 *
 * resolutionHeight===6656(Gen2/Gen3/Shitcamの可能性がある地点)のうち、
 * 撮影年だけでGen2/Gen3が機械的に決まる範囲を先にタグ付けする — label-tool/gen2-vs-gen3で集めたラベル(1272件、撮影年ごとの分布)を見ると、
 * 2011年だけがGen2/Gen3混在(約52%/48%)で、2009年以前は100%Gen2、2012年以降は100%Gen3という綺麗な境界だった。
 * この境界をカットオフとして採用し、境界年(2010-2012)だけを画像ベースのモデル/レビューに残すことで、判定コストを大きく削減できる。
 *
 * カットオフ(GEN2_MAX_YEAR/GEN3_MIN_YEAR)は現時点までにラベリングした地点だけに基づく経験的な境界であり、
 * 将来ラベルが増えて境界がずれた場合はここを調整すること。
 * このタグ付けはlabel-tool/gen2-vs-gen3のモデル学習データセットには影響しない —あちらは撮影年に関わらず全期間のラベルをそのまま学習に使い続け
 * る(このスクリプトは推論対象の地点を機械的に振り分けるだけ)。
 *
 * 境界年(2010-2012)であっても、`shared/camera-gens-by-country.ts`のカメラ世代の国別存在データを見て、
 * その国にGen2とGen3のどちらか一方しか存在しない場合(例: Isle of Manは`Gen2`のみ、Cambodiaは`Gen3`のみ)は、
 * 撮影年度によらず機械的に決定できる。この判定は日付カットオフより後に行い、それでも決まらない地点だけを画像ベースの
 * モデル/レビューに残す。
 *
 * tag-shitcam.tsと同じ理由で、上記いずれの方法でも決まらない地点は意図的に未タグのまま残す — false negativeであって、バグではない。
 * 既にGen2/Gen3/Shitcamのいずれかのタグを持つ地点は上書きしない。
 */

const GEN2_MAX_YEAR = 2009; // この年以前(含む)はGen2
const GEN3_MIN_YEAR = 2013; // この年以降(含む)はGen3

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, 'only-untagged');
  const concurrency = getFlagInt(args, 'concurrency', 8);

  if (!inputPath || !outputPath) {
    console.error(
      'Usage: npx tsx tag-gen2-gen3-by-date.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]',
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
      if (isKnownShitcam(meta)) {
        console.log(`[${index}] ${panoId} known Shitcam, skipping`);
        return;
      }
      const year = meta.date ? Number(meta.date.split('-')[0]) : NaN;
      if (!Number.isFinite(year)) {
        console.log(`[${index}] ${panoId} capture date unavailable, skipping`);
        return;
      }
      let gen: 'Gen2' | 'Gen3' | null = null;
      if (year <= GEN2_MAX_YEAR) gen = 'Gen2';
      else if (year >= GEN3_MIN_YEAR) gen = 'Gen3';
      if (!gen) {
        const possibleGens = meta.countryCode
          ? (CAMERA_GENS_BY_COUNTRY.get(meta.countryCode) ?? [])
          : [];
        const hasGen2 = possibleGens.includes('Gen2');
        const hasGen3 = possibleGens.includes('Gen3');
        if (hasGen2 && !hasGen3) gen = 'Gen2';
        else if (hasGen3 && !hasGen2) gen = 'Gen3';
      }
      if (!gen) {
        console.log(
          `[${index}] ${panoId} (${meta.countryCode} ${meta.date}) in ambiguous range, leaving for image-based review`,
        );
        return;
      }
      const tags = ensureExtraTags(c);
      if (addTagIfNew(tags, gen)) tagged++;
      console.log(`[${index}] ${panoId} (${meta.countryCode} ${meta.date}) -> "${gen}"`);
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
