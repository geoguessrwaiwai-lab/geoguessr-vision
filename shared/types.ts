// リポジトリ全体で使い回すデータ形状をまとめた型定義。
//
// 元の.mjs実装では、同じ形のオブジェクト(GeoGuessrのcustomCoordinates要素や
// パノラマメタデータなど)を各ファイルがそれぞれ暗黙の前提として扱っており、
// 形が一致しているかはレビュー時に目視で確認するしかなかった。ここに集約することで
// 「この関数はどんな形のデータを受け取り、何を返すのか」が型として保証される。

import type { Generation } from "./generations.ts";

/** GeoGuessrのエクスポートJSONにおける、地点1件分の `extra` フィールド。 */
export interface LocationExtra {
  panoId?: string;
  resolutionHeight?: number;
  /** パノラマの撮影日("YYYY-M"形式)。透かしの著作権年とは別物(README参照)。 */
  panoDate?: string;
  tags?: string[];
  [key: string]: unknown;
}

/** GeoGuessrのcustomCoordinates配列の要素1件分。 */
export interface Location {
  panoId?: string;
  resolutionHeight?: number;
  extra?: LocationExtra;
  [key: string]: unknown;
}

/** capture-locations.ts等が読み書きする、GeoGuessrエクスポートJSON全体の形。 */
export interface CustomCoordinatesFile {
  customCoordinates: Location[];
  [key: string]: unknown;
}

/**
 * Google内部エンドポイントから得られたパノラマメタデータ。
 */
export interface PanoMeta {
  id: string;
  resolutionHeight: number | null;
  resolutionClass: string;
  lat: number;
  lon: number;
  /** 撮影車両が実際に向いていた真の方角(0-360、北=0、時計回り)。マップ制作者が選んだ表示用headingとは別物。 */
  headingDeg: number;
  /** 水平を0とするカメラのピッチ角(正で上向き)。Googleの生値はzenith(天頂)基準なので`90 - 生値`に変換済み。 */
  pitchDeg: number;
  /** カメラのロール角(水平線に対する傾き)。 */
  rollDeg: number;
  /** 撮影日("YYYY-M"形式)。取得できない場合はnull。 */
  date: string | null;
  /** ISO 3166-1 alpha-2の国コード(例: "US")。取得できない場合はnull。 */
  countryCode: string | null;
  /** 公式のGoogle撮影のカバレッジであるかどうか。取得できない場合はfalse。 */
  isGoogleOfficial: boolean;
  /** Gen3のトレッカー撮影かどうか。 */
  isScout: boolean;
}

/** capture-locations.ts が manifest.json に書き出す1地点分のレコード。 */
export interface ManifestEntry {
  index: number;
  panoId: string;
  frontFile: string;
  backFile: string;
  watermarkFile: string;
  panoDate: string | null;
  resolutionHeight: number | null;
  resolutionClass: string;
  existingTags: string[];
}

/** apply-tags.ts が読み込む tags.json の1エントリ。 */
export interface TagEntry {
  index: number;
  panoId?: string;
  tags: string[];
}

/**
 * label-tool の各データフォルダ(<dataDir>/model.json)が宣言する、そのモデル固有の
 * ラベリング設定。モデルごとにデータフォルダを分ける(例: gen2-vs-gen3/)一方で、
 * ラベリングUI・サーバー本体は1つのコードを共有する — 選択可能な世代やUIタイトルを
 * このファイルから読むことで、コード重複なしにモデルごとの見た目を変える。
 */
export interface LabelToolConfig {
  name: string;
  generations: Generation[];
  /** 車体色・ブラーの見え方を集める世代。省略時は空(このモデルでは色を扱わない)。 */
  colorGens?: Generation[];
}

/** label-tool の items.json に書き出される1候補分のレコード。 */
export interface LabelItem {
  panoId: string;
  resolutionHeight: number | null;
  resolutionClass: string;
  lat: number;
  lon: number;
  headingDeg: number;
  date: string;
  isScout?: boolean;
  countryCode?: string | null;
  sourceFile: string;
  images: { front: string; back: string; watermark?: string };
}

/** label-tool が labels.json に書き出す通常ラベル1件分。 */
export interface LabelEntry {
  panoId: string;
  gen: Generation;
  confidence?: string;
  notes?: string;
  // capture-for-labeling.tsの--preset-genが直接書き込むプリセットラベルには存在しない
  // (server.tsのvalidateLabel/normalizeLabelを経由する通常のラベル付けでのみ必須)ため、
  // 型としては省略可能とする。
  copyrightYear?: number | "unclear";
  /** COLOR_GENS(現状はGen4のみ)の場合だけ存在するフィールド群。 */
  carView?: "front" | "back" | "both" | "neither";
  color?: string | null;
  colorCustom?: string;
  at?: string;
}

/** ラベリングUIで「スキップ」した地点のセンチネル値。 */
export interface SkippedLabel {
  skipped: true;
  at: string;
}

/** ラベリングUIで「除外(reject)」した地点のセンチネル値。 */
export interface RejectedLabel {
  rejected: true;
  reason: string;
  at: string;
}

/** labels.json はpanoIdをキーに、通常ラベルかスキップ/除外のいずれかを値に持つ。 */
export type LabelsFile = Record<
  string,
  LabelEntry | SkippedLabel | RejectedLabel
>;
