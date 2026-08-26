import fs from "node:fs";
import { getPanoMeta } from "./pano-meta.ts";
import { mapConcurrent } from "./concurrency.ts";
import { getFlagValue, hasFlag, positionalArgs } from "./shared/cli-args.ts";
import { getPanoId, ensureExtraTags, addTagIfNew } from "./shared/location-utils.ts";
import type { CustomCoordinatesFile } from "./shared/types.ts";

// 使い方: npx tsx tag-copyright.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]
//
// 車体の色やカメラ世代と違って、Street Viewパノラマの著作権保持者は目視で判定するもの
// ではなく、Googleが地点ごとに報告している正確なメタデータそのもの(例:
// 公式Google撮影は「© 2024 Google」、サードパーティのトレッカー/行政機関撮影は
// 「© <会社/機関名>」)。撮影日(extra.panoDate)とも独立しており、混同されがちだが別物。
//
// 著作権保持者名のタグを1つ追加する(他の短いタグと同じ見た目になるよう「© YYYY 」の
// プレフィックスは取り除く。例: "Google"や"Instituto Geografico Nacional")。完全自動・
// 100%正確 — 画像レンダリングもレビューも不要。

function normalizeCopyrightHolder(copyright: string | null): string | null {
  if (!copyright) return null;
  // "© 2024 Google" -> "Google"; "© 2019 Instituto Geografico Nacional" -> "Instituto Geografico Nacional"
  return copyright.replace(/^©\s*\d{4}\s*/, "").trim() || null;
}

// 著作権保持者タグは自由記述(既知の団体名の閉じた集合ではない)なので、`--only-untagged`が
// 既にタグ付け済みかどうかを判定するには、いずれにせよヒューリスティックにならざるを
// 得ない。この正規表現は「よくある著作権系の単語」を含むタグを大まかに検出するだけであり、
// リスト外の団体名(例: 未知の行政機関名)を見逃すことがある — その場合は
// `--only-untagged`指定時に再タグ付けがスキップされず、無駄にgetPanoMetaを呼ぶだけで
// 実害はない(addTagIfNewが最終的な重複追加は正確に防ぐため)。
const LIKELY_COPYRIGHT_TAG = /google|instituto|survey|geografic|geographic|national|ordnance|地理院/i;

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, "only-untagged");
  const concurrency = getFlagValue(args, "concurrency");
  const concurrencyLimit = concurrency ? parseInt(concurrency, 10) : 8;

  if (!inputPath || !outputPath) {
    console.error("Usage: npx tsx tag-copyright.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]");
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  let tagged = 0;
  let skipped = 0;

  const entries = data.customCoordinates.map((c, index) => ({ c, index }));

  await mapConcurrent(entries, concurrencyLimit, async ({ c, index }) => {
    const panoId = getPanoId(c);
    if (!panoId) {
      console.log(`[${index}] no panoId, skipping`);
      return;
    }
    const existingTags = c.extra?.tags ?? [];
    const alreadyHasCopyrightTag = existingTags.some((t) => LIKELY_COPYRIGHT_TAG.test(t));
    if (onlyUntagged && alreadyHasCopyrightTag) {
      skipped++;
      return;
    }
    try {
      const meta = await getPanoMeta(panoId);
      const holder = normalizeCopyrightHolder(meta.copyright);
      if (!holder) {
        console.log(`[${index}] no copyright info returned`);
        return;
      }
      const tags = ensureExtraTags(c);
      if (addTagIfNew(tags, holder)) tagged++;
      console.log(`[${index}] ${panoId} -> "${holder}"`);
    } catch (e) {
      console.log(`[${index}] FAILED: ${(e as Error).message}`);
    }
  });

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(`\nTagged ${tagged} location(s), skipped ${skipped} (already tagged). Wrote ${outputPath}`);
}

await main();
