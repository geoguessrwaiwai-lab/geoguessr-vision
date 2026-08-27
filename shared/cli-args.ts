/**
 * `--flag=value` / `--flag` 形式のCLI引数パース。
 *
 * 各スクリプトが `args.find(a => a.startsWith("--limit="))` のような手書きパースを個別に実装していた(capture-locations.ts,
 * tag-watermark-year.ts,label-tool/capture-for-labeling.ts で3箇所以上重複)。
 * Node組み込みの`node:util.parseArgs` は事前にオプション名を列挙する必要があり、
 * 本ツール群のように「位置引数+`--flag=value`」が混在する簡易なCLIにはやや大仰なため、既存の挙動を保ったまま関数として共通化するに留める。
 */

/** `--flag=value` 形式の引数から値を取り出す。無ければ `undefined`。 */
export function getFlagValue(args: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

/** `--flag=value` 形式の引数を整数として取り出す。無ければ `fallback`。 */
export function getFlagInt(args: string[], flag: string, fallback: number): number {
  const value = getFlagValue(args, flag);
  return value === undefined ? fallback : parseInt(value, 10);
}

/** `--flag`(値なし)形式の引数が存在するかどうか。 */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(`--${flag}`);
}

/** `--`で始まらない引数(位置引数)だけを取り出す。 */
export function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('--'));
}
