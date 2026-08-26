import fs from "node:fs";
import path from "node:path";
import { renderLocationBundle } from "./render-pano.ts";
import { mapConcurrent } from "./concurrency.ts";
import { getFlagInt, hasFlag, positionalArgs } from "./shared/cli-args.ts";
import { getPanoId } from "./shared/location-utils.ts";
import type { CustomCoordinatesFile, ManifestEntry } from "./shared/types.ts";

// 使い方:
//   npx tsx capture-locations.ts <input.json> <outDir> [--only-untagged] [--limit=N] [--concurrency=N]
//
// GeoGuessrのcustomCoordinates JSONの各地点について、以下をレンダリングする: yaw 0°/180°
// (パノラマ自身の前方/後方方向)での透視投影クロップ(front/back。通常は車が認識しやすい
// 自然な形で写る、レビューのPRIMARY画像)、front/backのどちらにも車が写らない稀なケースの
// フォールバックとなる地面/鉛直下方帯(ground)、タイルに焼き込まれた「© YYYY Google」透かし
// のクロップ(watermark)。各地点ごとにJPEGと、それらを記述するmanifest.jsonを書き出し、
// 人間(またはClaude)がレビューしてapply-tags.tsでタグ付けできるようにする。
//
// 重要: front/backは意図的にpano-meta.tsの`headingDeg`をyawとして使っていない。
// headingDegは記述的なメタデータ(yaw=0が既にどのコンパス方位を向いているかを教えるだけ)
// であって、適用すべき回転量ではない — これをyawとして使うと前方から二重に回転してしまう。
// Googleの公式ビューアをheading=Xでスクリーンショットし、それがyaw=Xではなくyaw=0の
// 出力と一致することを確認済み。詳細はrender-pano.tsのrenderCarViewsを参照。
//
// 透かしの年は撮影日(panoDate)とは別物である点に注意 — 画像が最後に再処理された年を
// 反映しているだけで、より後の年になりうるので、両者が一致すると仮定しないこと。
//
// Google APIキーは不要 — 画像タイルはStreet View自身のタイルCDNから取得する。
//
// 全周360°の鉛直下方帯だけ(front/backなし)でyawの推測を一切不要にする案を最初に試したが、
// 実運用で2つの問題が出た: equirectangularの歪みが車を読み取りづらい曲がったスジに
// 変えてしまうこと、そして古い/低品質なパノラマは最も深い鉛直下方に画像データが実際に
// 欠けている(バグではなく、Googleが単に撮影していないだけ)ことがあり、ちょうど車が
// 写るはずの場所に黒い欠落として現れること。front/backの透視投影クロップの方がずっと
// 読み取りやすいため、これらをprimaryとし、帯はフォールバック参照としてのみ残している。
//
// パフォーマンス: renderLocationBundleは各パノラマのタイルをちょうど1回(並列で)stitchし、
// そこから全てのクロップを導出する — クロップごとに毎回equirectを取り直すことはしない。
// 地点も(デフォルト8の)同時実行数の上限付きで処理する。1000地点あたり、逐次実行なら
// 約6秒/地点(約1.7時間)かかるところを、同時実行に分散させることで同程度の総作業量を
// 大幅に短い時間で終えられる。

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outDir] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, "only-untagged");
  const limit = getFlagInt(args, "limit", Infinity);
  const concurrency = getFlagInt(args, "concurrency", 8);

  if (!inputPath || !outDir) {
    console.error(
      "Usage: npx tsx capture-locations.ts <input.json> <outDir> [--only-untagged] [--limit=N] [--concurrency=N]",
    );
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });

  let coords = data.customCoordinates.map((c, index) => ({ c, index }));
  if (onlyUntagged) {
    coords = coords.filter(({ c }) => !(c.extra?.tags && c.extra.tags.length > 0));
  }
  coords = coords.slice(0, limit);

  const started = Date.now();
  const results = await mapConcurrent(coords, concurrency, async ({ c, index }): Promise<ManifestEntry | null> => {
    const panoId = getPanoId(c);
    if (!panoId) {
      console.log(`[${index}] no panoId, skipping`);
      return null;
    }
    try {
      const knownResolutionHeight = c.resolutionHeight ?? c.extra?.resolutionHeight;
      const { front, back, ground, watermark, resolutionHeight, resolutionClass } =
        await renderLocationBundle(panoId, {
          zoom: 3,
          resolutionHeight: knownResolutionHeight,
        });
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
        resolutionHeight,
        resolutionClass,
        existingTags: c.extra?.tags ?? [],
      };
    } catch (e) {
      console.log(`[${index}] FAILED: ${(e as Error).message}`);
      return null;
    }
  });

  const manifest = results.filter((r): r is ManifestEntry => r !== null).sort((a, b) => a.index - b.index);
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nWrote ${manifest.length} location(s) (front+back+ground+watermark renders) + manifest.json to ${outDir} in ${elapsed}s`,
  );
}

await main();
