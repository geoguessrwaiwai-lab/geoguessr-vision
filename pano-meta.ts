/**
 * Google APIキー不要で使える、Street Viewメタデータの取得処理。
 * パノラマの真のカメラ向き(photometa)を、Google Maps自身のWebサイトが使っているのと同じ内部エンドポイントから取得する。
 */

import { Enum, toProtobufUrl, fetchGoogleJson } from './pb-url.ts';
import { isMainModule } from './shared/is-main-module.ts';
import type { PanoMeta } from './shared/types.ts';

export const RESOLUTION_HEIGHT = Object.freeze({
  GEN1_MAX: 1664,
  GEN2_GEN3_SHITCAM: 6656,
  GEN4: 8192,
});

export const RESOLUTION_CLASS = Object.freeze({
  GEN1: 'Gen1',
  GEN2_GEN3_SHITCAM: 'Gen2 / Gen3 / Shitcam',
  GEN4_SMALLCAM: 'Gen4 / Smallcam',
  UNKNOWN: 'Unknown',
});

/**
 * ResolutionHeightだけでは、この粗いカメラ世代の分類しかできない。
 * 特に6656はGen2/Gen3/Shitcamのいずれなのかを区別できない。
 */
export function classifyResolutionHeight(resolutionHeight: number | null | undefined): string {
  if (!Number.isFinite(resolutionHeight)) return RESOLUTION_CLASS.UNKNOWN;
  const height = resolutionHeight as number;
  if (height <= RESOLUTION_HEIGHT.GEN1_MAX) return RESOLUTION_CLASS.GEN1;
  if (height === RESOLUTION_HEIGHT.GEN4) return RESOLUTION_CLASS.GEN4_SMALLCAM;
  if (height === RESOLUTION_HEIGHT.GEN2_GEN3_SHITCAM) {
    return RESOLUTION_CLASS.GEN2_GEN3_SHITCAM;
  }
  return RESOLUTION_CLASS.UNKNOWN;
}

/**
 * Street View左下の著作権表記は、公式Google撮影なら「© 2024 Google」、
 * サードパーティ(トレッカー・行政機関等)撮影なら「© <年> <会社/機関名>」になる。
 * 年プレフィックスを取り除いた残りが厳密に"Google"と一致する場合だけ公式とみなす。
 */
function isGoogleOfficialCopyright(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw.replace(/^©\s*\d{4}\s*/, '').trim() === 'Google';
}

interface ShitcamCutoff {
  year: number;
  month: number;
}

/**
 * "Gen2/Gen3/Shitcam"の三択のうち、国コードごとに「この年月以降の撮影ならばShitcam」と判断するためのマッピング。
 * これは手動でキュレーションされた既知の国/期間の組み合わせのリストであり、汎用的な検出器ではないこのリストから漏れる範囲では、
 * ShitcamをShitcamとして検出できないが許容する。
 */
const SHITCAM_CUTOFFS = new Map<string, ShitcamCutoff>([
  ['BD', { year: 2021, month: 4 }], // バングラデシュ
  ['EC', { year: 2022, month: 3 }], // エクアドル
  ['FI', { year: 2020, month: 9 }], // フィンランド
  ['IN', { year: 2021, month: 10 }], // インド
  ['KH', { year: 2022, month: 10 }], // カンボジア
  ['LB', { year: 2021, month: 1 }], // レバノン
  ['LK', { year: 2021, month: 2 }], // スリランカ
  ['NG', { year: 2021, month: 6 }], // ナイジェリア
  ['NP', { year: 2020, month: 1 }], // ネパール
  ['VN', { year: 2020, month: 1 }], // ベトナム
  // ヨーロッパ全体で共通のデフォルトカットオフ。
  ['AT', { year: 2021, month: 1 }], // オーストリア
  ['BG', { year: 2021, month: 1 }], // ブルガリア
  ['CZ', { year: 2021, month: 1 }], // チェコ
  ['DK', { year: 2021, month: 1 }], // デンマーク
  ['EE', { year: 2021, month: 1 }], // エストニア
  ['ES', { year: 2021, month: 1 }], // スペイン
  ['FR', { year: 2021, month: 1 }], // フランス
  ['GB', { year: 2021, month: 1 }], // イギリス
  ['GR', { year: 2021, month: 1 }], // ギリシャ
  ['HR', { year: 2021, month: 1 }], // クロアチア
  ['IT', { year: 2021, month: 1 }], // イタリア
  ['LT', { year: 2021, month: 1 }], // リトアニア
  ['LV', { year: 2021, month: 1 }], // ラトビア
  ['PL', { year: 2021, month: 1 }], // ポーランド
  ['PT', { year: 2021, month: 1 }], // ポルトガル
  ['RO', { year: 2021, month: 1 }], // ルーマニア
  ['SE', { year: 2021, month: 1 }], // スウェーデン
  // キプロスとサントメ・プリンシペ: 全カバレッジが既知のShitcamで、日付カットオフなし。
  ['CY', { year: -Infinity, month: 1 }], // キプロス
  ['ST', { year: -Infinity, month: 1 }], // サントメ・プリンシペ
]);
// 米国だけは日付カットオフに加えて緯度(アラスカ、北緯52度以北)でも特別扱いする。
const US_SHITCAM_CUTOFF: ShitcamCutoff = { year: 2019, month: 1 };

interface IsKnownShitcamInput {
  date: string | null | undefined;
  countryCode: string | null | undefined;
  lat: number | null | undefined;
}

// 撮影日、国コード、緯度から、この地点がShitcamであるかどうかを判定する。
export function isKnownShitcam({ date, countryCode, lat }: IsKnownShitcamInput): boolean {
  if (!date || !countryCode) return false;
  const [year, month] = date.split('-').map(Number);
  if (!Number.isFinite(year) || year <= 2000) return false;
  const yearMonth = year * 12 + month;
  if (countryCode === 'US') {
    if (!(Number.isFinite(lat) && (lat as number) > 52)) return false;
    return yearMonth >= US_SHITCAM_CUTOFF.year * 12 + US_SHITCAM_CUTOFF.month;
  }
  const cutoff = SHITCAM_CUTOFFS.get(countryCode);
  if (!cutoff) return false;
  return yearMonth >= cutoff.year * 12 + cutoff.month;
}

function buildMetaRequestUrl(panoId: string): string {
  const toggles = [1, 2, 3, 4, 5, 6, 8, 12].map((n) => new Enum(n));
  const message = {
    1: { 1: 'maps_sv.tactile', 11: { 2: { 1: true } } },
    2: { 1: 'en', 2: 'US' },
    3: { 1: { 1: new Enum(2), 2: panoId } },
    4: {
      1: toggles,
      2: { 1: new Enum(1) },
      4: { 1: 48 },
      5: [{}],
      6: [{}],
      9: {
        1: [
          { 1: new Enum(2), 2: true, 3: new Enum(2) },
          { 1: new Enum(2), 2: false, 3: new Enum(3) },
          { 1: new Enum(3), 2: true, 3: new Enum(2) },
          { 1: new Enum(3), 2: false, 3: new Enum(3) },
          { 1: new Enum(8), 2: false, 3: new Enum(3) },
          { 1: new Enum(1), 2: false, 3: new Enum(3) },
          { 1: new Enum(4), 2: false, 3: new Enum(3) },
          { 1: new Enum(10), 2: true, 3: new Enum(2) },
          { 1: new Enum(10), 2: false, 3: new Enum(3) },
        ],
      },
      11: { 3: { 4: true } },
    },
  };
  const [, pb] = toProtobufUrl(message);
  return `https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=US&pb=${pb}`;
}

/**
 * Googleの内部レスポンスは、ドキュメント化されていない「未加工の入れ子配列」形式(protobufをJSON化しただけのワイヤーフォーマット)であり、
 * `msg[5][0][1][2]` のような位置ベースのアクセスにならざるを得ない。
 * 型を完全に付けるのは非現実的なため、この関数の入力は `unknown` として受け取り、内部でのみ位置アクセスの形をコメントで明示する。
 * 各インデックスが何を表すかは、下のプロパティ名(id, resolutionHeight, ...)と対応するコメントを参照。
 */
function parsePanoMessage(msg: any): PanoMeta {
  const orientation = msg[5][0][1][2]; // [headingDeg, pitchFromZenithDeg, rollDeg]
  const captureKind = msg[6]?.[5]?.[2];
  const resolutionHeight = msg[2]?.[2]?.[0] ?? null;
  return {
    id: msg[1][1],
    resolutionHeight,
    resolutionClass: classifyResolutionHeight(resolutionHeight),
    lat: msg[5][0][1][0][2],
    lon: msg[5][0][1][0][3],
    headingDeg: orientation[0],
    pitchDeg: 90 - orientation[1],
    rollDeg: orientation[2],
    date: msg[6]?.[7]?.slice(0, 2)?.join('-') ?? null, // [year, month] があれば
    // ISO 3166-1 alpha-2の国コード(例: "IN", "US")。
    countryCode: msg[5]?.[0]?.[1]?.[4] ?? null,
    isGoogleOfficial: isGoogleOfficialCopyright(msg[4]?.[0]?.[0]?.[0]?.[0]),
    /**
     * Googleのメタデータは、Gen3トレッカー撮影を"scout"としてマークしている。
     * データセット構築時にタイル取得前に除外できるよう、独立したフィールドとして残している。
     */
    isScout: captureKind === 'scout',
  };
}

// Street ViewのpanoIdに対して、車両が実際に向いていた方角(マップ制作者が選んだ表示角度ではない)を含むメタデータを返す。
export async function getPanoMeta(panoId: string): Promise<PanoMeta> {
  const data = await fetchGoogleJson(buildMetaRequestUrl(panoId));
  return parsePanoMessage((data as any)[1][0]);
}

if (isMainModule(import.meta.url)) {
  const [, , panoId] = process.argv;
  console.log(await getPanoMeta(panoId));
}
