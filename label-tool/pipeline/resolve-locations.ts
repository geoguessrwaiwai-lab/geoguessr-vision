import fs from "node:fs";
import path from "node:path";
import { getPanoMeta, isKnownShitcam } from "../../pano-meta.ts";
import { mapConcurrent } from "../../concurrency.ts";
import { getFlagInt, hasFlag, positionalArgs } from "../../shared/cli-args.ts";

// 使い方: npx tsx label-tool/resolve-locations.ts <raw-locations.json> <candidates-output.json> [--concurrency=N] [--all-resolutions]
//
// Valiが出力する生のロケーションJSON([{ lat, lng, heading, extra: { tags } , panoId }])を、
// capture-for-labeling.tsが読める candidates.json 形式([{ panoId, headingDeg, date, lat, lon,
// sourceFile, resolutionHeight, countryCode, isScout }])に変換する。
//
// 入力の`heading`/`lat`/`lng`はGeoGuessrの表示用値で、そのままでは使わない —
// render-pano.tsが要求する真のheadingDeg・撮影日・解像度・国コードは、panoIdごとに
// getPanoMeta()(Googleのphotometaエンドポイント)へ問い合わせて取得し直す
// (capture-locations.tsのコメント参照: 表示用headingとyawは別物)。
//
// デフォルトでは resolutionHeight===6656(Gen2/Gen3/Shitcamの可能性がある地点)だけを残す。
// Gen1/Gen4も含めた全世代を集めたい場合は --all-resolutions を付ける。
//
// resolutionHeight===6656に絞り込む場合、isKnownShitcam()(pano-meta.ts参照、tag-shitcam.tsと
// 同じ既知の国/期間テーブル)に一致する地点はGen2 vs Gen3の候補から除外する
// (AGENTS.mdのモデル分割方針: Shitcamは対象外、ラベリング労力の無駄を避ける)。
// これは限定的なテーブルなので、未知のShitcamが紛れ込む可能性は残る(意図的なfalse negative)。

interface RawLocation {
  lat: number;
  lng: number;
  heading?: number;
  extra?: { tags?: string[] };
  panoId?: string;
}

interface Candidate {
  panoId: string;
  headingDeg: number;
  date: string;
  lat: number;
  lon: number;
  sourceFile: string;
  resolutionHeight: number | null;
  countryCode: string | null;
  isScout: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = positionalArgs(args);
  const concurrency = getFlagInt(args, "concurrency", 8);
  const allResolutions = hasFlag(args, "all-resolutions");

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx label-tool/resolve-locations.ts <raw-locations.json> <candidates-output.json> [--concurrency=N] [--all-resolutions]",
    );
    process.exit(1);
  }

  const raw: RawLocation[] = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const sourceFile = path.basename(inputPath);
  const withPanoId = raw.filter((loc): loc is RawLocation & { panoId: string } => !!loc.panoId);
  console.log(`${raw.length} location(s), ${withPanoId.length} with panoId`);

  const started = Date.now();
  const results = await mapConcurrent(withPanoId, concurrency, async (loc, i): Promise<Candidate | null> => {
    try {
      const meta = await getPanoMeta(loc.panoId);
      if (!allResolutions && meta.resolutionHeight !== 6656) return null;
      if (!allResolutions && isKnownShitcam(meta)) {
        console.log(`[${i + 1}/${withPanoId.length}] ${loc.panoId} known Shitcam (${meta.countryCode} ${meta.date}), skipping`);
        return null;
      }
      console.log(`[${i + 1}/${withPanoId.length}] ${loc.panoId} resolutionHeight=${meta.resolutionHeight}`);
      return {
        panoId: loc.panoId,
        headingDeg: meta.headingDeg,
        date: meta.date ?? "",
        lat: meta.lat,
        lon: meta.lon,
        sourceFile,
        resolutionHeight: meta.resolutionHeight,
        countryCode: meta.countryCode,
        isScout: meta.isScout,
      };
    } catch (e) {
      console.log(`[${i + 1}/${withPanoId.length}] ${loc.panoId} FAILED: ${(e as Error).message}`);
      return null;
    }
  });

  const candidates = results.filter((r): r is Candidate => r !== null);
  fs.writeFileSync(outputPath, JSON.stringify(candidates, null, 2));
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nWrote ${candidates.length} candidate(s) to ${outputPath} in ${elapsed}s`);
}

await main();
