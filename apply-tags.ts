import fs from 'node:fs';
import { getPanoId, ensureExtraTags, addTagIfNew, hasTag } from './shared/location-utils.ts';
import type { CustomCoordinatesFile, TagEntry } from './shared/types.ts';

/**
 * 使い方:  npx tsx apply-tags.ts <input.json> <tags.json> <output.json>
 *
 * tags.json: [{ "index": 0, "panoId": "...", "tags": ["Blue 24"] }, ...](capture-locations.tsが出力したレンダリング結果をレビューして作成する)
 *
 * 各エントリのタグをcustomCoordinates[index].extra.tagsにマージする。
 * 既に存在する(大文字小文字を無視して比較する)タグはスキップするので、再実行しても安全。
 * panoIdは入力元ファイルと突き合わせて検証し、古い/対応がずれたタグファイルを検出する。
 */

function main() {
  const [, , inputPath, tagsPath, outputPath] = process.argv;
  if (!inputPath || !tagsPath || !outputPath) {
    console.error('Usage: npx tsx apply-tags.ts <input.json> <tags.json> <output.json>');
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const tagEntries: TagEntry[] = JSON.parse(fs.readFileSync(tagsPath, 'utf8'));

  let applied = 0;
  let skipped = 0;

  for (const entry of tagEntries) {
    const loc = data.customCoordinates[entry.index];
    if (!loc) {
      console.log(`[${entry.index}] no such location, skipping`);
      continue;
    }
    const actualPanoId = getPanoId(loc);
    if (entry.panoId && actualPanoId !== entry.panoId) {
      console.log(
        `[${entry.index}] panoId mismatch (expected ${entry.panoId}, found ${actualPanoId}), skipping`,
      );
      continue;
    }
    const tags = ensureExtraTags(loc);
    for (const tag of entry.tags ?? []) {
      if (hasTag(tags, tag)) {
        skipped++;
        continue;
      }
      addTagIfNew(tags, tag);
      applied++;
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(`Applied ${applied} tag(s), skipped ${skipped} duplicate(s). Wrote ${outputPath}`);
}

main();
