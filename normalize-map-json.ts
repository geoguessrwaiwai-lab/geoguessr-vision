import fs from 'node:fs';
import { getPanoMeta } from './pano-meta.ts';
import { mapConcurrent } from './concurrency.ts';
import { addTagIfNew, getPanoId } from './shared/location-utils.ts';
import { IMAGE_TYPE } from './shared/types.ts';
import type { CustomCoordinatesFile, Location, PanoCapture, PanoMeta } from './shared/types.ts';

/**
 * 使い方:  npx tsx normalize-map-json.ts <input.json> [output.json] [オプション]
 *
 * Map Making App / GeoGuessrのエクスポートJSONを、マップ制作で毎回手作業していた形に揃える。
 *
 *   1. pitch/zoomを0、countryCode/stateCodeをnullにし、panoIdをextra.panoIdへ集約する
 *   2. 同じpanoIdの地点を1件にまとめる(tagsは和集合でマージ)
 *   3. headingを撮影車両の真の進行方向に書き換える
 *      (Map Making Appは道路の接続(link)の先頭を向きに使うため、約半数の地点が真後ろを向く)
 *   4. 同じ座標に新しいサードパーティ撮影がある地点を検出し、トップレベルpanoIdに公式のIDを入れて固定する
 *      (panoIdがnullだと、座標から解決された最新の撮影 = サードパーティのカバレッジが表示されてしまう)
 *
 * 出力先を省略すると入力ファイルを上書きし、直前の内容を<input>.bak(既にあれば.bak2, .bak3, ...)に残す。
 * 1地点1行の整形で書き出すため、エディタやgitの差分で地点単位の変更が追える。
 */

const USAGE = `Usage: npx tsx normalize-map-json.ts <input.json> [output.json] [options]

  --dry-run             ファイルを書かず、何が変わるかだけ報告する
  --keep-pitch-zoom     pitch/zoom/countryCode/stateCodeをそのままにする
  --keep-duplicates     同じpanoIdの地点をまとめない
  --keep-heading        headingを進行方向に書き換えない
  --pin=<mode>          トップレベルpanoIdの扱い (既定: all)
                          all        … 全地点で公式パノラマのIDを固定する
                          unofficial … 新しいサードパーティ撮影に上書きされる地点だけ固定する
                          none       … 全地点でnullにする(座標から解決させる)
  --report=<path.csv>   サードパーティ撮影に上書きされる地点の一覧をCSVで書き出す
  --concurrency=<n>     photometaの同時取得数 (既定: 8)`;

type PinMode = 'all' | 'unofficial' | 'none';

interface Options {
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
  normalizeFields: boolean;
  dedupe: boolean;
  fixHeading: boolean;
  pin: PinMode;
  reportPath: string | null;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Map<string, string>();
  for (const arg of argv.filter((a) => a.startsWith('--'))) {
    const [key, value] = arg.slice(2).split('=');
    flags.set(key, value ?? '');
  }
  const [inputPath, outputPath] = positional;
  if (!inputPath) {
    console.error(USAGE);
    process.exit(1);
  }
  const pin = (flags.get('pin') || 'all') as PinMode;
  if (!['all', 'unofficial', 'none'].includes(pin)) {
    console.error(
      `--pin には all / unofficial / none のいずれかを指定してください (指定値: ${pin})`,
    );
    process.exit(1);
  }
  return {
    inputPath,
    outputPath: outputPath || inputPath,
    dryRun: flags.has('dry-run'),
    normalizeFields: !flags.has('keep-pitch-zoom'),
    dedupe: !flags.has('keep-duplicates'),
    fixHeading: !flags.has('keep-heading'),
    pin,
    reportPath: flags.get('report') || null,
    concurrency: Number(flags.get('concurrency') || 8),
  };
}

/**
 * 1地点1行のJSONとして直列化する。
 * `JSON.stringify(data, null, 0)`だと全体が1行になり、`null, 2`だと1地点が十数行に膨らんで、どちらも地点単位の差分が読めない。
 * トップレベルのキーの順序は入力のまま保つ。
 */
function serialize(data: CustomCoordinatesFile): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'customCoordinates') {
      const lines = data.customCoordinates.map((loc) => JSON.stringify(loc)).join(',\n');
      parts.push(`"customCoordinates":[\n${lines}\n]`);
    } else {
      parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    }
  }
  const serialized = `{${parts.join(',')}}`;
  JSON.parse(serialized); // 壊れたJSONを書き出さないための保険
  return serialized;
}

/** 上書き保存の直前に、既存の内容を<path>.bak / .bak2 / .bak3 ... へ退避する。 */
function backup(path: string): string {
  let candidate = `${path}.bak`;
  for (let n = 2; fs.existsSync(candidate); n++) candidate = `${path}.bak${n}`;
  fs.copyFileSync(path, candidate);
  return candidate;
}

/** pitch/zoom/countryCode/stateCodeを揃え、panoIdをextra.panoIdへ集約する。 */
function normalizeFields(locations: Location[]): Record<string, number> {
  const changed = { pitch: 0, zoom: 0, panoIdをextraへ移動: 0, countryCode: 0, stateCode: 0 };
  for (const loc of locations) {
    if (loc.pitch !== 0) changed.pitch++;
    if (loc.zoom !== 0) changed.zoom++;
    if (loc.countryCode != null) changed.countryCode++;
    if (loc.stateCode != null) changed.stateCode++;
    loc.pitch = 0;
    loc.zoom = 0;
    loc.countryCode = null;
    loc.stateCode = null;
    const panoId = getPanoId(loc);
    loc.extra ??= {};
    if (panoId && loc.extra.panoId !== panoId) {
      loc.extra.panoId = panoId;
      changed.panoIdをextraへ移動++;
    }
  }
  return changed;
}

/** 同じpanoIdの地点を最初の1件にまとめる。tagsは和集合(最初に出現した順 + 後から出てきた新しいタグ)。 */
function dedupe(locations: Location[]): { kept: Location[]; removed: number; merged: number } {
  const byPanoId = new Map<string, Location>();
  const kept: Location[] = [];
  let removed = 0;
  let merged = 0;
  for (const loc of locations) {
    const panoId = getPanoId(loc);
    const existing = panoId ? byPanoId.get(panoId) : undefined;
    if (!existing) {
      if (panoId) byPanoId.set(panoId, loc);
      kept.push(loc);
      continue;
    }
    removed++;
    const incoming = loc.extra?.tags ?? [];
    if (incoming.length === 0) continue;
    existing.extra ??= {};
    existing.extra.tags ??= [];
    const added = incoming.filter((tag) => addTagIfNew(existing.extra!.tags!, tag)).length;
    if (added > 0) merged++;
  }
  return { kept, removed, merged };
}

/** 「YYYY-M」形式の撮影日を比較可能な数値にする。 */
function dateKey(date: string | null): number {
  if (!date) return 0;
  const [year, month] = date.split('-').map(Number);
  return (year || 0) * 12 + (month || 0);
}

/**
 * この地点を座標から開いたときに、保存されている公式パノラマではなくサードパーティの撮影が表示されるかどうか。
 * Street Viewは座標に対して「最新の撮影」を返すため、より新しいサードパーティ撮影が1件でもあれば上書きされる。
 */
function newerThirdPartyCaptures(meta: PanoMeta): PanoCapture[] {
  return meta.otherCaptures.filter(
    (c) => c.imageType === IMAGE_TYPE.THIRD_PARTY && dateKey(c.date) > dateKey(meta.date),
  );
}

async function fetchMetas(panoIds: string[], concurrency: number): Promise<Map<string, PanoMeta>> {
  const metas = new Map<string, PanoMeta>();
  const failures: string[] = [];
  let done = 0;
  await mapConcurrent(panoIds, concurrency, async (panoId) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        metas.set(panoId, await getPanoMeta(panoId));
        break;
      } catch (error) {
        if (attempt === 3) failures.push(panoId);
        else await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (++done % 500 === 0) console.log(`  メタデータ取得 ${done}/${panoIds.length}`);
  });
  if (failures.length > 0) {
    console.log(`  取得に失敗したpanoId: ${failures.length}件 (これらの地点は変更しません)`);
  }
  return metas;
}

function writeReport(
  path: string,
  rows: { index: number; location: Location; meta: PanoMeta; newer: PanoCapture[] }[],
): void {
  const csv = [
    'index,lat,lng,officialPanoId,officialDate,newerPanoIds,newerDates',
    ...rows.map(({ index, location, meta, newer }) =>
      [
        index,
        location.lat,
        location.lng,
        meta.id,
        meta.date ?? '',
        newer.map((c) => c.panoId).join(' '),
        newer.map((c) => c.date).join(' '),
      ].join(','),
    ),
  ].join('\n');
  fs.writeFileSync(path, `${csv}\n`);
  console.log(`サードパーティ撮影に上書きされる地点の一覧を ${path} に出力しました`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const data: CustomCoordinatesFile = JSON.parse(fs.readFileSync(options.inputPath, 'utf8'));
  const originalCount = data.customCoordinates.length;
  console.log(`${options.inputPath}: ${originalCount}地点`);

  if (options.normalizeFields) {
    const changed = normalizeFields(data.customCoordinates);
    const summary = Object.entries(changed)
      .filter(([, n]) => n > 0)
      .map(([key, n]) => `${key} ${n}件`);
    console.log(`フィールド統一: ${summary.length > 0 ? summary.join(' / ') : '変更なし'}`);
  }

  if (options.dedupe) {
    const { kept, removed, merged } = dedupe(data.customCoordinates);
    data.customCoordinates = kept;
    console.log(`panoId重複の削除: ${removed}件 (うちタグをマージした地点 ${merged}件)`);
  }

  // headingの修正もサードパーティ判定もpanoIdごとのメタデータが要る。どちらも不要なら通信しない。
  const needsMeta = options.fixHeading || options.pin !== 'none';
  const metas = new Map<string, PanoMeta>();
  if (needsMeta) {
    const panoIds = [...new Set(data.customCoordinates.map(getPanoId).filter((id) => !!id))];
    console.log(
      `photometaからメタデータを取得します (${panoIds.length}件, 同時${options.concurrency})`,
    );
    for (const [panoId, meta] of await fetchMetas(panoIds as string[], options.concurrency)) {
      metas.set(panoId, meta);
    }
  }

  if (options.fixHeading) {
    let changed = 0;
    let reversed = 0;
    for (const loc of data.customCoordinates) {
      const meta = metas.get(getPanoId(loc) ?? '');
      if (!meta) continue;
      // `((h % 360) + 360) % 360`と書くと、0-360に収まっている値にも丸め誤差が入り、
      // 向きが同じなのに最下位ビットだけ違う値がファイル中に大量に生まれてしまう。
      let heading = meta.headingDeg % 360;
      if (heading < 0) heading += 360;
      // エクスポート時に丸められた桁が戻るだけの地点(向きは同じ)は、書き換えた扱いにしない。
      const diff = Math.abs(((heading - (loc.heading as number) + 540) % 360) - 180);
      if (diff > 1e-6) changed++;
      if (diff > 90) reversed++;
      loc.heading = heading;
    }
    console.log(`headingの書き換え: ${changed}件 (うち真後ろを向いていた地点 ${reversed}件)`);
  }

  // 保存されている公式パノラマより新しいサードパーティ撮影がある地点。panoIdを固定しないとこちらが表示される。
  const overwritten: { index: number; location: Location; meta: PanoMeta; newer: PanoCapture[] }[] =
    [];
  if (metas.size > 0) {
    data.customCoordinates.forEach((location, index) => {
      const meta = metas.get(getPanoId(location) ?? '');
      if (!meta) return;
      const newer = newerThirdPartyCaptures(meta);
      if (newer.length > 0) overwritten.push({ index, location, meta, newer });
    });
    console.log(`座標から開くとサードパーティ撮影になる地点: ${overwritten.length}件`);
  }

  if (options.pin === 'none') {
    for (const loc of data.customCoordinates) loc.panoId = null;
    console.log('トップレベルpanoId: 全件null');
  } else {
    const targets =
      options.pin === 'all'
        ? data.customCoordinates.map((location, index) => ({ index, location }))
        : overwritten;
    for (const loc of data.customCoordinates) loc.panoId = null;
    let pinned = 0;
    for (const { location } of targets) {
      const panoId = location.extra?.panoId;
      if (!panoId) continue;
      location.panoId = panoId;
      pinned++;
    }
    console.log(`トップレベルpanoIdの固定: ${pinned}件 (--pin=${options.pin})`);
  }

  if (options.reportPath && overwritten.length > 0) writeReport(options.reportPath, overwritten);

  if (options.dryRun) {
    console.log(
      `--dry-run のためファイルは書き換えていません (${originalCount}地点 → ${data.customCoordinates.length}地点)`,
    );
    return;
  }
  if (options.outputPath === options.inputPath) {
    console.log(`バックアップ: ${backup(options.inputPath)}`);
  }
  fs.writeFileSync(options.outputPath, serialize(data));
  console.log(`${options.outputPath} に${data.customCoordinates.length}地点を書き出しました`);
}

await main();
