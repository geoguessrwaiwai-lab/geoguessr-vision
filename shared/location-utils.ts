// Location(customCoordinatesの1要素)に対する共通処理。
//
// 「panoIdをトップレベル/extra配下のどちらから拾うか」「タグの大文字小文字を無視した
// 重複排除」「extra/extra.tagsの初期化」は、capture-locations.ts / apply-tags.ts /
// tag-copyright.ts / tag-watermark-year.ts / tag-shitcam.ts の5ファイルでほぼ同じ
// コードがコピペされていた。ここに集約する。

import type { Location } from "./types.ts";

/** `location.panoId` が無ければ `location.extra.panoId` にフォールバックする。 */
export function getPanoId(location: Location): string | undefined {
  return location.panoId || location.extra?.panoId;
}

/** `location.extra` と `location.extra.tags` が無ければ初期化して返す。 */
export function ensureExtraTags(location: Location): string[] {
  location.extra ??= {};
  location.extra.tags ??= [];
  return location.extra.tags;
}

/**
 * タグ配列に対して、大文字小文字を無視した重複がなければ追加する。
 * 追加した場合は true、既に存在していた場合は false を返す。
 */
export function addTagIfNew(tags: string[], tag: string): boolean {
  const lowerTag = tag.toLowerCase();
  if (tags.some((t) => t.toLowerCase() === lowerTag)) return false;
  tags.push(tag);
  return true;
}

/** タグ配列に指定のタグ(大文字小文字を無視)が含まれるかどうか。 */
export function hasTag(tags: string[], tag: string): boolean {
  const lowerTag = tag.toLowerCase();
  return tags.some((t) => t.toLowerCase() === lowerTag);
}
