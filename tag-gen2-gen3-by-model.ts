import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import type { Sharp } from 'sharp';
import { getPanoMeta, isKnownShitcam } from './pano-meta.ts';
import { renderCarViews } from './render-pano.ts';
import { mapConcurrent } from './concurrency.ts';
import { positionalArgs, hasFlag, getFlagInt, getFlagValue } from './shared/cli-args.ts';
import { getPanoId, ensureExtraTags, addTagIfNew } from './shared/location-utils.ts';
import { isGeneration } from './shared/generations.ts';
import type { CustomCoordinatesFile } from './shared/types.ts';

/**
 * 使い方:  npx tsx tag-gen2-gen3-by-model.ts <input.json> <output.json> [--only-untagged]    [--concurrency=N] [--min-confidence=0.7]
 * [--model=models/gen2-vs-gen3.onnx]
 *
 * tag-gen2-gen3-by-date.tsが機械的に振り分けられない境界年(2010-2012年)の地点を、training/gen2-vs-gen3/で学習したONNXモデルで判定する。
 * resolutionHeight===6656(Gen2/Gen3/Shitcamの可能性がある地点)のうち、
 * 既にGen2/Gen3/Shitcamタグを持つ地点や既知のShitcam(tag-shitcam.ts参照)は対象外。
 *
 * 重要: ここでのfront/backレンダリングは、training/gen2-vs-gen3/で実際に学習したlabel-tool/gen2-vs-gen3/images/*
 * /front.jpg・back.jpgと同じ幾何(yaw 0°/180°、pitch -20°、fov 80°、900x700)でなければならない — renderCarViews()のデフォルト値がこれに一致する。
 * レンダリングの幾何を変更する場合は、学習データセットの再レンダリング・モデルの再学習とセットで行い、ここも追随させること。
 *
 * 前処理(リサイズ・正規化)はtraining/gen2-vs-gen3/dataset.pyのeval変換(Resize((224,224)) + ImageNet正規化)と一致させている。
 */

const INPUT_SIZE = 224;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const CLASS_NAMES = ['Gen2', 'Gen3'] as const;

async function toModelTensor(image: Sharp): Promise<ort.Tensor> {
  const { data } = await image
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  /**
   * sharpのrawバッファはHWC(インターリーブRGB)のuint8。
   * モデルはCHWのfloat32を期待するため、正規化しつつチャンネルごとの平面に並べ替える。
   */
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      chw[c * plane + i] = (value - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
    }
  }
  return new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function softmax([a, b]: readonly [number, number]): [number, number] {
  const max = Math.max(a, b);
  const ea = Math.exp(a - max);
  const eb = Math.exp(b - max);
  const sum = ea + eb;
  return [ea / sum, eb / sum];
}

async function classify(
  session: ort.InferenceSession,
  panoId: string,
  resolutionHeight: number,
): Promise<{ gen: (typeof CLASS_NAMES)[number]; confidence: number }> {
  const { front, back } = await renderCarViews(panoId, { resolutionHeight });
  const [frontTensor, backTensor] = await Promise.all([toModelTensor(front), toModelTensor(back)]);
  const outputs = await session.run({ front: frontTensor, back: backTensor });
  const logits = outputs.logits.data as Float32Array;
  const [probGen2, probGen3] = softmax([logits[0], logits[1]]);
  return probGen2 >= probGen3
    ? { gen: 'Gen2', confidence: probGen2 }
    : { gen: 'Gen3', confidence: probGen3 };
}

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, 'only-untagged');
  const concurrency = getFlagInt(args, 'concurrency', 4);
  const minConfidence = parseFloat(getFlagValue(args, 'min-confidence') ?? '0.7');
  const modelPath =
    getFlagValue(args, 'model') ?? path.join(import.meta.dirname, 'models', 'gen2-vs-gen3.onnx');

  if (!inputPath || !outputPath) {
    console.error(
      'Usage: npx tsx tag-gen2-gen3-by-model.ts <input.json> <output.json> [--only-untagged] [--concurrency=N] [--min-confidence=0.7] [--model=path]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(modelPath)) {
    console.error(
      `Model not found at ${modelPath}. Run training/gen2-vs-gen3/export_onnx.py first.`,
    );
    process.exit(1);
  }

  const session = await ort.InferenceSession.create(modelPath);

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  let tagged = 0;
  let unclear = 0;
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
      const { gen, confidence } = await classify(session, panoId, meta.resolutionHeight);
      if (confidence < minConfidence) {
        console.log(
          `[${index}] ${panoId} (${meta.countryCode} ${meta.date}) -> "${gen}" confidence=${confidence.toFixed(3)} below threshold, leaving untagged for manual review`,
        );
        unclear++;
        return;
      }
      const tags = ensureExtraTags(c);
      if (addTagIfNew(tags, gen)) tagged++;
      console.log(
        `[${index}] ${panoId} (${meta.countryCode} ${meta.date}) -> "${gen}" confidence=${confidence.toFixed(3)}`,
      );
    } catch (e) {
      console.log(`[${index}] FAILED: ${(e as Error).message}`);
    }
  });

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(
    `\nTagged ${tagged} location(s), ${unclear} below confidence threshold (left for manual review), skipped ${skipped} (already tagged). Wrote ${outputPath}`,
  );
}

await main();
