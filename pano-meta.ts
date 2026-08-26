// Google APIキー不要で使える、Street Viewメタデータの取得処理。
// パノラマの真のカメラ向き(photometa)と、近傍パノラマ検索(SingleImageSearch)の
// 両方を、Google Maps自身のWebサイトが使っているのと同じ内部エンドポイントから取得する。

import { Enum, Dbl, toProtobufUrl, fetchGoogleJson } from "./pb-url.ts";
import { isMainModule } from "./shared/is-main-module.ts";
import type { PanoMeta } from "./shared/types.ts";

export const RESOLUTION_HEIGHT = Object.freeze({
  GEN1_MAX: 1664,
  GEN2_GEN3_SHITCAM: 6656,
  GEN4: 8192,
});

export const RESOLUTION_CLASS = Object.freeze({
  GEN1: "Gen1",
  GEN2_GEN3_SHITCAM: "Gen2 / Gen3 / Shitcam",
  GEN4: "Gen4",
  UNKNOWN: "Unknown",
});

// ResolutionHeightだけでは、この粗いカメラ世代の分類しかできない。
// 特に6656はGen2/Gen3/Shitcamのいずれなのかを区別できない。
export function classifyResolutionHeight(resolutionHeight: number | null | undefined): string {
  if (!Number.isFinite(resolutionHeight)) return RESOLUTION_CLASS.UNKNOWN;
  const height = resolutionHeight as number;
  if (height <= RESOLUTION_HEIGHT.GEN1_MAX) return RESOLUTION_CLASS.GEN1;
  if (height === RESOLUTION_HEIGHT.GEN4) return RESOLUTION_CLASS.GEN4;
  if (height === RESOLUTION_HEIGHT.GEN2_GEN3_SHITCAM) {
    return RESOLUTION_CLASS.GEN2_GEN3_SHITCAM;
  }
  return RESOLUTION_CLASS.UNKNOWN;
}

interface ShitcamCutoff {
  /** この年月(inclusive-from、>=)以降の撮影であればShitcamとみなす。 */
  year: number;
  month: number;
}

// 国 -> 「この年月以降の撮影なら既知のサードパーティShitcamカバレッジ」というカットオフ。
// これは手動でキュレーションされた既知の国/期間の組み合わせのリストであり、汎用的な
// 検出器ではない — このリストに載っていない国は、実際にサードパーティの低品質カバレッジが
// 存在していても一切フラグが立たない。これは意図的に許容しているfalse negativeであり、
// バグではない(代替手段である画像ベースの分類が、このリストの見逃しを拾うフォールバックと
// なる)。カットオフは inclusive-from(>=)。
const SHITCAM_CUTOFFS = new Map<string, ShitcamCutoff>([
  ["BD", { year: 2021, month: 4 }],
  ["EC", { year: 2022, month: 3 }],
  ["FI", { year: 2020, month: 9 }],
  ["IN", { year: 2021, month: 10 }],
  ["KH", { year: 2022, month: 10 }],
  ["LB", { year: 2021, month: 1 }],
  ["LK", { year: 2021, month: 2 }],
  ["NG", { year: 2021, month: 6 }],
  ["NP", { year: 2020, month: 1 }],
  ["VN", { year: 2020, month: 1 }],
  // ヨーロッパ全体で共通のデフォルトカットオフ。
  ["AT", { year: 2021, month: 1 }],
  ["BG", { year: 2021, month: 1 }],
  ["CZ", { year: 2021, month: 1 }],
  ["DK", { year: 2021, month: 1 }],
  ["EE", { year: 2021, month: 1 }],
  ["ES", { year: 2021, month: 1 }],
  ["FR", { year: 2021, month: 1 }],
  ["GB", { year: 2021, month: 1 }],
  ["GR", { year: 2021, month: 1 }],
  ["HR", { year: 2021, month: 1 }],
  ["IT", { year: 2021, month: 1 }],
  ["LT", { year: 2021, month: 1 }],
  ["LV", { year: 2021, month: 1 }],
  ["PL", { year: 2021, month: 1 }],
  ["PT", { year: 2021, month: 1 }],
  ["RO", { year: 2021, month: 1 }],
  ["SE", { year: 2021, month: 1 }],
  // キプロスとサントメ・プリンシペ: 全カバレッジが既知のShitcamで、日付カットオフなし。
  ["CY", { year: -Infinity, month: 1 }],
  ["ST", { year: -Infinity, month: 1 }],
]);
// 米国だけは日付カットオフに加えて緯度(アラスカ、北緯52度以北)でも特別扱いする。
const US_SHITCAM_CUTOFF: ShitcamCutoff = { year: 2019, month: 1 };

interface IsKnownShitcamInput {
  date: string | null | undefined;
  countryCode: string | null | undefined;
  lat: number | null | undefined;
}

// resolutionHeight===6656のパノラマについて、撮影日(上記`date`が返す"YYYY-M"形式)・国コード・
// 緯度から、既知のサードパーティ低品質(Shitcam)カバレッジである国/期間の範囲に該当するかを
// 判定する。SHITCAM_CUTOFFSに載っていない国は常にfalseを返す(上記コメント参照) —
// これは限定的で不完全なヒューリスティックであり、汎用的なShitcam検出器ではない。
export function isKnownShitcam({ date, countryCode, lat }: IsKnownShitcamInput): boolean {
  if (!date || !countryCode) return false;
  const [year, month] = date.split("-").map(Number);
  if (!Number.isFinite(year) || year <= 2000) return false;
  const yearMonth = year * 12 + month;
  if (countryCode === "US") {
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
    1: { 1: "maps_sv.tactile", 11: { 2: { 1: true } } },
    2: { 1: "en", 2: "US" },
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

// Googleの内部レスポンスは、ドキュメント化されていない「未加工の入れ子配列」形式
// (protobufをJSON化しただけのワイヤーフォーマット)であり、`msg[5][0][1][2]` のような
// 位置ベースのアクセスにならざるを得ない。型を完全に付けるのは非現実的なため、この関数の
// 入力は `unknown` として受け取り、内部でのみ位置アクセスの形をコメントで明示する。
// 各インデックスが何を表すかは、下のプロパティ名(id, resolutionHeight, ...)と
// 対応するコメントを参照。
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
    date: msg[6]?.[7]?.slice(0, 2)?.join("-") ?? null, // [year, month] があれば
    // ISO 3166-1 alpha-2の国コード(例: "IN", "US")。下のisKnownShitcam()で使う。
    countryCode: msg[5]?.[0]?.[1]?.[4] ?? null,
    // Street Viewの隅に表示される著作権行。公式Google撮影なら「© 2024 Google」、
    // サードパーティ(トレッカー・行政機関等)撮影なら「© <会社/機関名>」のように、
    // 撮影日とは独立した情報。
    copyright: msg[4]?.[0]?.[0]?.[0]?.[0] ?? null,
    // Googleのメタデータは、Gen3トレッカー撮影を"scout"としてマークしている。データセット
    // 構築時にタイル取得前に除外できるよう、独立したフィールドとして残している。
    isScout: captureKind === "scout",
  };
}

// Street ViewのpanoIdに対して、車両が実際に向いていた方角(マップ制作者が選んだ表示角度
// ではない)を含むメタデータを返す。
export async function getPanoMeta(panoId: string): Promise<PanoMeta> {
  const data = await fetchGoogleJson(buildMetaRequestUrl(panoId));
  return parsePanoMessage((data as any)[1][0]);
}

function buildFindRequestUrl(lat: number, lon: number, radius: number): string {
  const message = {
    1: { 1: "apiv3", 5: "US", 11: { 1: { 1: false } } },
    2: { 1: { 3: new Dbl(lat), 4: new Dbl(lon) }, 2: new Dbl(radius) },
    3: {
      2: { 1: "en", 2: "US" },
      9: { 1: new Enum(2) },
      11: { 1: { 1: new Enum(2), 2: true, 3: new Enum(2) } },
    },
    4: {
      1: [1, 2, 3, 4, 6, 8, 12].map((n) => new Enum(n)),
      5: {},
      6: {},
    },
  };
  const [, pb] = toProtobufUrl(message);
  return `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=${pb}&callback=_xdc_._v2mub5`;
}

// 指定した地点に最も近いStreet Viewパノラマを探す(デフォルト半径50m)。
// getPanoMetaと同じ形を返す。見つからなければnull。
//
// このエンドポイントはJSONP形式(`_xdc_._v2mub5(...)`でラップされたJSON)でレスポンスを
// 返すため、`)]}'`プレフィックス方式のfetchGoogleJsonは使えず、ここで個別にパースしている。
export async function findPanoramaNear(
  lat: number,
  lon: number,
  radius = 50,
): Promise<PanoMeta | null> {
  const url = buildFindRequestUrl(lat, lon, radius);
  const res = await fetch(url, {
    headers: { Accept: "*/*", Referer: "https://www.google.com/" },
  });
  if (!res.ok) throw new Error(`find_panorama failed: ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  const data = JSON.parse(`[${text.slice(start + 1, end)}]`);
  const responseCode = data[0][0][0];
  if (responseCode !== 0) return null;
  return parsePanoMessage(data[0][1]);
}

if (isMainModule(import.meta.url)) {
  const [, , cmd, a, b] = process.argv;
  if (cmd === "near") {
    console.log(await findPanoramaNear(parseFloat(a), parseFloat(b)));
  } else {
    console.log(await getPanoMeta(cmd));
  }
}
