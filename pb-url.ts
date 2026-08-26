// streetlevel(https://github.com/sk-zk/streetlevel)を参考にした、Google Maps内部エンドポイント
// 向けの疑似protobuf URLエンコーダの最小移植版(`!1m2!2sfoo!3d1.5` のような形式を生成する)。

/** protobufの enum フィールドであることを明示するためのラッパー。 */
export class Enum {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

// このモジュールが組み立てる「protobuf風メッセージ」の値がとりうる形。
// Googleの内部エンドポイントが期待するネストしたオブジェクト/配列構造を素朴に
// JSのオブジェクトリテラルで表現しているため、フィールドタグ(キー)に意味的な名前は
// 付けられない(相手のprotoスキーマを完全に逆解析しない限り不可能)。
export type PbValue =
  | number
  | string
  | boolean
  | Enum
  | PbValue[]
  | PbMessage;

export type PbMessage = { [tag: string]: PbValue };

function fieldToString(tag: string, value: PbValue): [number, string] {
  if (Array.isArray(value)) {
    let serialized = "";
    let childCount = 0;
    for (const entry of value) {
      const [c, s] = fieldToString(tag, entry);
      serialized += s;
      childCount += c;
    }
    return [childCount, serialized];
  }
  if (value instanceof Enum) return [1, `!${tag}e${value.value}`];
  if (typeof value === "boolean") return [1, `!${tag}b${value ? 1 : 0}`];
  if (typeof value === "number") {
    const type = Number.isInteger(value) ? "i" : "d";
    return [1, `!${tag}${type}${value}`];
  }
  if (typeof value === "string") return [1, `!${tag}s${value}`];
  // `typeof null === "object"` なので、ネストしたメッセージとして扱う前に
  // null を弾く(元の実装ではここでガードがなく、null値を渡すと
  // `Object.entries(null)` で例外になっていた)。
  if (typeof value === "object" && value !== null) {
    const [subChildCount, subSerialized] = toProtobufUrl(value);
    return [subChildCount + 1, `!${tag}m${subChildCount}${subSerialized}`];
  }
  throw new Error(`unsupported value: ${value}`);
}

export function toProtobufUrl(fields: PbMessage): [number, string] {
  let serialized = "";
  let childCount = 0;
  for (const [tag, value] of Object.entries(fields)) {
    const [c, s] = fieldToString(tag, value);
    serialized += s;
    childCount += c;
  }
  return [childCount, serialized];
}

// Google内部エンドポイントに対してブラウザに見せかけるためのUA。タイルCDN(render-pano.ts)・
// photometa API(このモジュール)の両方でこの値を使う。
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function fetchGoogleJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "*/*", Referer: "https://www.google.com/", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  let text = await res.text();
  if (text.startsWith(")]}'")) text = text.slice(4);
  return JSON.parse(text);
}
