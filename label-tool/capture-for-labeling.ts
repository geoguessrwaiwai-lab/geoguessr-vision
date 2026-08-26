import fs from "node:fs";
import path from "node:path";
import { renderLocationBundle } from "../render-pano.ts";
import { mapConcurrent } from "../concurrency.ts";
import { positionalArgs, getFlagInt, hasFlag, getFlagValue } from "../shared/cli-args.ts";
import { isGeneration } from "../shared/generations.ts";
import type { Generation } from "../shared/generations.ts";
import type { LabelItem, LabelsFile } from "../shared/types.ts";

// 使い方: npx tsx capture-for-labeling.ts <candidates.json> <outDir> [--concurrency=N] [--append] [--preset-gen=Gen3]
//
// 各候補 { panoId, headingDeg, date, lat, lon, sourceFile } について、
// outDir/images/<panoId>/ にレンダリングする: front.jpg/back.jpg(想定yaw 0°/180°での
// 透視投影クロップ)とwatermark.jpg(著作権年のクロップ)。
//
// front/backは想定yaw=0/180(Gen3代替オフセット付き)を使い、headingDegは使わない —
// 理由はrender-pano.tsのrenderCarViews参照。headingDegは記述的なメタデータ(yaw=0が
// 既にどのコンパス方位を向いているか)であって適用すべき回転量ではなく、yaw入力として
// 使うと前方から二重に回転してしまう。それでも各アイテムにheadingDegを記録している
// のは、ラベリングUIに埋め込まれたStreet Viewのiframeがそれを必要とするため
// (Google自身の`heading` URLパラメータは、こちらのyawとは異なる真のコンパス方位)。
//
// renderLocationBundleは各パノラマのタイルを1回(並列で)stitchし、そこから全ての
// クロップを導出する。候補も(デフォルト8の)同時実行数の上限付きで処理する — 大きな
// ラベリングバッチを作る際、これをしないと総時間の大半をこの処理が占めてしまうため。
//
// ラベリングサーバーが配信するoutDir/items.jsonを書き出す。

interface Candidate {
  panoId: string;
  headingDeg: number;
  date: string;
  lat: number;
  lon: number;
  sourceFile: string;
  resolutionHeight?: number;
  isScout?: boolean;
  countryCode?: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const [candidatesPath, outDir] = positionalArgs(args);
  const concurrency = getFlagInt(args, "concurrency", 8);
  const append = hasFlag(args, "append");
  const presetGenArg = getFlagValue(args, "preset-gen");

  if (!candidatesPath || !outDir) {
    console.error(
      "Usage: npx tsx capture-for-labeling.ts <candidates.json> <outDir> [--concurrency=N] [--append] [--preset-gen=Gen3]",
    );
    process.exit(1);
  }

  if (presetGenArg && !isGeneration(presetGenArg)) {
    console.error(`Invalid --preset-gen value: ${presetGenArg}`);
    process.exit(1);
  }
  // isGeneration()による検証結果を、以降ずっと使い回せる型付き変数に一度だけ落とし込む
  // (presetGenArgのままだと使用箇所ごとにstring|undefinedのままで、Generation型が
  // 必要な箇所でキャストが必要になってしまう)。
  const presetGen: Generation | null = presetGenArg && isGeneration(presetGenArg) ? presetGenArg : null;

  const allCandidates: Candidate[] = JSON.parse(fs.readFileSync(candidatesPath, "utf8"));
  const imagesDir = path.join(outDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const itemsPath = path.join(outDir, "items.json");
  const existingItems: LabelItem[] =
    append && fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : [];
  const existingPanoIds = new Set(existingItems.map((item) => item.panoId));
  const candidates = allCandidates.filter((candidate) => !existingPanoIds.has(candidate.panoId));

  if (append) {
    console.log(`append mode: ${existingItems.length} existing, ${candidates.length} new candidates`);
  }

  const started = Date.now();
  const results = await mapConcurrent(candidates, concurrency, async (c, i): Promise<LabelItem | null> => {
    const dir = path.join(imagesDir, c.panoId);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const { front, back, watermark, resolutionHeight, resolutionClass } = await renderLocationBundle(c.panoId, {
        zoom: 3,
        resolutionHeight: c.resolutionHeight,
      });
      await Promise.all([
        front.toFile(path.join(dir, "front.jpg")),
        back.toFile(path.join(dir, "back.jpg")),
        watermark.toFile(path.join(dir, "watermark.jpg")),
      ]);
      console.log(`[${i + 1}/${candidates.length}] ${c.panoId} done`);
      return {
        panoId: c.panoId,
        resolutionHeight,
        resolutionClass,
        lat: c.lat,
        lon: c.lon,
        headingDeg: c.headingDeg,
        date: c.date,
        isScout: c.isScout,
        countryCode: c.countryCode,
        sourceFile: c.sourceFile,
        images: {
          front: `images/${c.panoId}/front.jpg`,
          back: `images/${c.panoId}/back.jpg`,
          watermark: `images/${c.panoId}/watermark.jpg`,
        },
      };
    } catch (e) {
      console.log(`[${i + 1}/${candidates.length}] ${c.panoId} FAILED: ${(e as Error).message}`);
      return null;
    }
  });

  const addedItems = results.filter((r): r is LabelItem => r !== null);
  const items = [...existingItems, ...addedItems];
  fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));

  if (presetGen) {
    const labelsPath = path.join(outDir, "labels.json");
    const labels: LabelsFile = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, "utf8")) : {};
    const labeledAt = new Date().toISOString();
    for (const item of addedItems) {
      labels[item.panoId] = {
        panoId: item.panoId,
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
}

await main();
