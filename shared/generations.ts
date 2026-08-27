/**
 * カメラ世代タグの正準リスト。
 *
 * これまで各スクリプトがそれぞれ独自に `Set(["Gen1", "Gen2", ...])` のようなリテラルを定義しており(pano-meta.ts, tag-shitcam.ts,
 * tag-watermark-year.ts,label-tool/server.ts, label-tool/capture-for-labeling.ts,label-tool/migrate-label-format.ts の6箇所)、
 * 語彙の追加・変更があった場合に直し漏れが起きやすかった。
 * このファイルを唯一の定義元とする。
 *
 * 値は最終的に extra.tags にそのまま書き込まれる文字列と一致する(README参照)。
 */
export const GENERATIONS = ['Gen1', 'Gen2', 'Gen3', 'Gen4', 'Smallcam', 'Shitcam'] as const;

export type Generation = (typeof GENERATIONS)[number];

export const GENERATION_SET: ReadonlySet<Generation> = new Set(GENERATIONS);

export function isGeneration(value: string): value is Generation {
  return (GENERATION_SET as ReadonlySet<string>).has(value);
}

/**
 * 車体の色・カーブロック情報を集めるのはGen4のみ(Smallcamはそもそも車体が写らず、Gen1/Gen2/Gen3は解像度が低く色の判定が信頼できないため)。
 * Gen4の「兄弟世代」であるSmallcamは機能ではなく独立した世代として扱う点に注意(label-tool/server.ts,label-tool/migrate-label-format.ts
 * で重複定義されていたものを統合)。
 */
export const COLOR_GENS: ReadonlySet<Generation> = new Set(['Gen4']);
