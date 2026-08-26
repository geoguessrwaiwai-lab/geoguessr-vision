import fs from "node:fs";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { renderWatermarkCrop } from "./render-pano.ts";
import { positionalArgs, hasFlag, getFlagInt } from "./shared/cli-args.ts";
import { getPanoId, ensureExtraTags, addTagIfNew } from "./shared/location-utils.ts";
import type { CustomCoordinatesFile, Location } from "./shared/types.ts";

// 使い方:
//   npx tsx tag-watermark-year.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]
//
// 既にGen4(またはSmallcam)としてタグ付けされている地点にのみOCRを実行しタグを書き込む —
// それ以外の世代は透かしの位置/判読性がこのクロップ&OCR方式では信頼できないほど異なる
// ため、そもそも対象から除外する。
//
// パノラマのタイルに焼き込まれた「© YYYY Google」透かしの年を自動で読み取る —
// render-pano.tsのrenderWatermarkCropが、単純なOCR(以前tesseract/EasyOCRを試した)では
// 精度が不十分なため手動レビューに残していたものを自動化する。この値はextra.panoDate
// (撮影日)ともpano-meta.tsの著作権年(常に今日の年を返すだけでパノラマ固有ではない)とも
// 別物 — README の著作権/年の表を参照。
//
// igsのcopyright-labeller(github.com/iggedi-ig-ig/copyright-labeller)から採用した技法。
// これは割り当てたラベルに対して約2/3のカバレッジ・約95%の精度を報告している:
//   - OCRの文字セットを、透かしが取りうる文字だけ(数字+"Google"+スペース)に制限する。
//     小さく低コントラストなテキストに対する汎用OCRは、年の形をすらしていない大量の
//     ゴミを生成するため、実際に使われているアルファベットまで認識器を絞ることで
//     その大半を事前に除去できる。
//   - 1回のOCR結果を鵜呑みにしない — 裏付けの取れた年だけを採用する。
//     copyright-labellerはequirect全体を1枚OCRし、独立に検出された2つ以上のテキスト行で
//     同じ年が現れることを要求する。
//
// ここでの裏付けは、同じクロップに対して異なるTesseractページ分割モード(どのテキスト行
// 検出戦略を使うか)で2回OCRを行い、両方が一致することを要求する形で得ている。
// renderWatermarkCropの2つの独立したstitch解像度(zoom=2 vs zoom=3)を突き合わせる案を
// copyright-labeller自身のzoomレベルにより忠実な形として最初に試したが、zoom=2のクロップは
// アップスケール後でも小さすぎて、目には明らかに読める透かしでもtesseractが何も読み取れない
// ことが多かった(既知の良好なクロップに対して確認済み) — そのため、より高解像度の
// zoom=3クロップに対する2つの設定に置き換えた。これなら実運用でカバレッジの大半を
// 失わずに裏付けが取れる。
//
// 2回のパスが一致しない場合、またはどちらも妥当な年を見つけられない場合は、地点には
// 下記のUNCLEAR_TAGでタグ付けする — 何もせず放置するのではなく、手動レビューのために
// 可視化する。これは、renderWatermarkCrop自体の固定位置の前提が透かしを完全に外して
// しまうケース(その注記が経験則によるものとフラグしており、一部の低解像度/古い
// パノラマではずれることがある)には勝てない点に注意 — そのケースも正しくUNCLEAR_TAGに
// 分類される(どちらのパスも妥当な年を見つけられないため)が、そもそもクロップされて
// いないテキストはどんなOCR戦略でも読めない。
//
// 対象はGen4またはその兄弟世代Smallcamの地点だけ — READMEのタグ語彙表を参照。それより
// 古い世代は透かしの位置/判読性がこのクロップ&OCR方式では信頼できないほど異なるため
// (世代別クロップ戦略は将来の改善候補として書き留めてあるが未実装)、OCR自体を実行せず
// スキップする。これは世代タグ(apply-tags.tsから)が既にextra.tagsに存在することを
// 前提とする — 世代タグ付けの後に実行すること、前ではない。

const LAUNCH_YEAR = 2007; // Street Viewの一般公開年
const CURRENT_YEAR = new Date().getFullYear();
const CHAR_WHITELIST = "0123456789Google ";
// label-toolの学習ラベルと共有するタグ語彙(README参照): 年が判読できれば素の
// 「©YYYY」、できなければ「©unclear」— どちらの場合もタグ付けせずに終わることはない。
const UNCLEAR_TAG = "©unclear";

type WatermarkYearResult = { year: number } | { unclear: true };

// 1回のOCRパスの生テキストに現れる、最も頻出する妥当な年(またはnull)。1回のパスでも
// 4桁の並びが複数出てくることがある(例: 番地の一部を拾ってしまう)ので、これは裏付けの
// ステップそのものではなく、2つのパスを突き合わせる前に1回分の出力を整えるだけのもの。
function extractYear(text: string): number | null {
  const years = [...text.matchAll(/\d{4}/g)]
    .map((m) => parseInt(m[0], 10))
    .filter((y) => y >= LAUNCH_YEAR && y <= CURRENT_YEAR);
  if (years.length === 0) return null;
  const counts = new Map<number, number>();
  for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// 透かしのクロップを1回だけレンダリング・前処理する。2回のOCRパスはどちらも同じ画像を
// 再利用するので、裏付けは画質の違いではなく純粋に検出戦略の違いによるものになる。
async function renderPreprocessedWatermark(panoId: string, zoom: number): Promise<Buffer> {
  const jpeg = await renderWatermarkCrop(panoId, { zoom });
  const raw = await jpeg.toBuffer();
  // 透かしは低コントラスト(空を背景にした薄いグレー/青の文字、または様々な地面の色の上)
  // であり、これが以前単純なOCRパスを断念するほど不安定にしていた原因(renderWatermarkCrop
  // の注記参照)。各クロップ自身のヒストグラムを引き伸ばす(normalize()は最も暗い/明るい
  // ピクセルを黒/白に写す)ことで、tesseractが数字を読み取れる程度まで透かしの文字が
  // 一貫して浮き出ることを開発時に既知の良好なクロップで確認した。透かしは明るい空から
  // 暗いアスファルトまで様々な背景の上に乗るため、固定の明度/コントラストカーブでは
  // 対応できない。
  return sharp(raw).grayscale().normalize().jpeg().toBuffer();
}

async function ocrYear(worker: Worker, image: Buffer, psm: (typeof PSM)[keyof typeof PSM]): Promise<number | null> {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const {
    data: { text },
  } = await worker.recognize(image);
  return extractYear(text);
}

// 同じ(zoom=3)クロップに対する2回のOCRパス(異なるページ分割戦略を使用)から透かしの年を
// 突き合わせる。両者が一致すれば{ year }を、そうでなければ{ unclear: true }を返す
// (どちらのパスからも妥当な年が得られない、または2つが食い違う場合)。
async function readWatermarkYear(worker: Worker, panoId: string): Promise<WatermarkYearResult> {
  const image = await renderPreprocessedWatermark(panoId, 3);
  // SPARSE_TEXTは散らばった独立したテキストの塊を探し、SINGLE_BLOCKは1つの均一な
  // テキストブロックを仮定する。それぞれ異なる失敗の仕方をするため、両方が同じ年に
  // 落ち着くことを要求するのは、同じ検出器を2回走らせるのとは違う本当の独立チェックになる。
  const fromSparse = await ocrYear(worker, image, PSM.SPARSE_TEXT);
  const fromBlock = await ocrYear(worker, image, PSM.SINGLE_BLOCK);
  if (fromSparse !== null && fromSparse === fromBlock) return { year: fromSparse };
  return { unclear: true };
}

// OCR・タグ書き込みの対象となる世代かどうか(Gen4またはその兄弟世代Smallcamのみ)。
// shared/generations.tsのCOLOR_GENS(車体色収集の対象、現状Gen4のみ)とは判定基準が
// 異なる(こちらはSmallcamも含む)ため、あえて別の判定として local に持つ。
function hasWatermarkYearGeneration(c: Location): boolean {
  const tags = c.extra?.tags ?? [];
  return tags.some((t) => t.toLowerCase() === "gen4" || t.toLowerCase() === "smallcam");
}

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const onlyUntagged = hasFlag(args, "only-untagged");
  const concurrency = getFlagInt(args, "concurrency", 4);

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx tag-watermark-year.ts <input.json> <output.json> [--only-untagged] [--concurrency=N]",
    );
    process.exit(1);
  }

  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  let coords = data.customCoordinates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => hasWatermarkYearGeneration(c));
  if (onlyUntagged) {
    coords = coords.filter(({ c }) => {
      const tags = c.extra?.tags ?? [];
      return !tags.some((t) => /^©(\d{4}|unclear)$/.test(t));
    });
  }

  console.log(`Processing ${coords.length} location(s) with ${concurrency} worker(s)...`);

  // Tesseractのワーカーはそれぞれ状態(setParametersで設定した文字ホワイトリスト等)を
  // 持つため、concurrency.tsのmapConcurrent(汎用的な「アイテムごとにfnを呼ぶ」プール)
  // ではなく、ワーカーを使い回す専用のプール実装をここに保持している。汎用プールに
  // 「ワーカーごとのリソースファクトリ」を持たせて統合する手もあるが、この1箇所だけの
  // ためにmapConcurrentの汎用APIを複雑にするコストに見合わないと判断し、独立実装のまま
  // 維持する。
  const workers = await Promise.all(
    Array.from({ length: Math.min(concurrency, coords.length || 1) }, async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({ tessedit_char_whitelist: CHAR_WHITELIST });
      return worker;
    }),
  );

  let tagged = 0;
  let unclear = 0;
  let failed = 0;

  let next = 0;
  async function lane(worker: Worker) {
    while (next < coords.length) {
      const { c, index } = coords[next++];
      const panoId = getPanoId(c);
      if (!panoId) {
        console.log(`[${index}] no panoId, skipping`);
        continue;
      }
      try {
        const result = await readWatermarkYear(worker, panoId);
        const tag = "unclear" in result ? UNCLEAR_TAG : `©${result.year}`;
        const tags = ensureExtraTags(c);
        if (addTagIfNew(tags, tag)) {
          if ("unclear" in result) unclear++;
          else tagged++;
        }
        console.log(`[${index}] ${panoId} -> "${tag}"`);
      } catch (e) {
        failed++;
        console.log(`[${index}] FAILED: ${(e as Error).message}`);
      }
    }
  }

  await Promise.all(workers.map(lane));
  await Promise.all(workers.map((w) => w.terminate()));

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 0));
  console.log(
    `\nTagged ${tagged} location(s) with a year, ${unclear} as "${UNCLEAR_TAG}", ${failed} failed. Wrote ${outputPath}`,
  );
}

await main();
