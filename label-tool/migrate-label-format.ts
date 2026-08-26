import fs from "node:fs";
import path from "node:path";
import { COLOR_GENS } from "../shared/generations.ts";
import type { LabelEntry, LabelsFile, LabelItem } from "../shared/types.ts";

// 旧来のフラットな世代/色ラベルを、ラベリングUIが使う条件付きスキーマへ移行する。
// 再利用可能な情報は保持される。Smallcam(旧来のフラットな"Small cam"値であっても、
// Gen4ラベルに"smallcam"/"Smallcam"の特徴が付いていた場合であっても)は、Smallcamが
// Gen4の機能ではなく兄弟世代であるため、独立したトップレベルの世代に正規化される。
// Gen3の(現在は廃止された)アンテナの特徴は、推測せずに単純に落とす。
// 除外(rejected)されたパノラマIDは、ラベル・アイテム・候補プール・画像フォルダから
// 削除される。
//
// 使い方: npx tsx label-tool/migrate-label-format.ts <dataDir> [candidate.json ...]

// 旧形式のラベルは型が保証されていない自由形式のJSONなので、正規のLabelEntryとは
// 明確に区別してunknown寄りの型として扱う。
interface LegacyLabelEntry {
  gen?: string;
  features?: string[];
  confidence?: string;
  notes?: string;
  copyrightYear?: number | "unclear";
  carView?: "front" | "back" | "both" | "neither";
  color?: string | null;
  colorCustom?: string;
  at?: string;
  rejected?: boolean;
}

type LegacyLabelsFile = Record<string, LegacyLabelEntry>;

function migrateLabel(panoId: string, oldLabel: LegacyLabelEntry): LabelEntry {
  const oldFeatures = (oldLabel.features ?? []).map((f) => (f === "smallcam" ? "Smallcam" : f));
  const wasSmallcam = oldLabel.gen === "Small cam" || (oldLabel.gen === "Gen4" && oldFeatures.includes("Smallcam"));
  const gen = (wasSmallcam ? "Smallcam" : oldLabel.gen) as LabelEntry["gen"];
  const migrated: LabelEntry = {
    panoId,
    gen,
    confidence: oldLabel.confidence ?? "high",
    notes: oldLabel.notes ?? "",
  };

  if (oldLabel.copyrightYear === "unclear" || (Number.isInteger(oldLabel.copyrightYear) && (oldLabel.copyrightYear as number) >= 2009)) {
    migrated.copyrightYear = oldLabel.copyrightYear;
  }

  if (COLOR_GENS.has(gen)) {
    migrated.carView = oldLabel.carView;
    const omitColor = migrated.carView === "neither" || migrated.carView == null;
    migrated.color = omitColor ? null : oldLabel.color ?? null;
    migrated.colorCustom = omitColor ? "" : oldLabel.colorCustom ?? "";
  }

  if (oldLabel.at) migrated.at = oldLabel.at;
  return migrated;
}

function main() {
  const [, , dataDirArg, ...candidateArgs] = process.argv;
  if (!dataDirArg) {
    console.error("Usage: npx tsx label-tool/migrate-label-format.ts <dataDir> [candidate.json ...]");
    process.exit(1);
  }

  const dataDir = path.resolve(dataDirArg);
  const labelsPath = path.join(dataDir, "labels.json");
  const itemsPath = path.join(dataDir, "items.json");
  const candidatePaths = candidateArgs.map((file) => path.resolve(file));
  const labels: LegacyLabelsFile = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  const items: LabelItem[] = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
  const rejectedIds = new Set(
    Object.entries(labels)
      .filter(([, label]) => label.rejected)
      .map(([panoId]) => panoId),
  );

  const migratedLabels: LabelsFile = {};
  let migratedSmallcam = 0;
  for (const [panoId, label] of Object.entries(labels)) {
    if (rejectedIds.has(panoId)) continue;
    if (label.gen === "Small cam") migratedSmallcam++;
    if (label.gen) migratedLabels[panoId] = migrateLabel(panoId, label);
    else migratedLabels[panoId] = label as LabelsFile[string];
  }

  const retainedItems = items.filter((item) => !rejectedIds.has(item.panoId));
  fs.writeFileSync(labelsPath, JSON.stringify(migratedLabels, null, 2));
  fs.writeFileSync(itemsPath, JSON.stringify(retainedItems, null, 2));

  const candidateResults: { file: string; before: number; after: number }[] = [];
  for (const candidatePath of candidatePaths) {
    const candidates: { panoId: string }[] = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    const retained = candidates.filter((candidate) => !rejectedIds.has(candidate.panoId));
    fs.writeFileSync(candidatePath, JSON.stringify(retained, null, 2));
    candidateResults.push({ file: candidatePath, before: candidates.length, after: retained.length });
  }

  const imagesRoot = path.join(dataDir, "images");
  let deletedImageDirs = 0;
  for (const panoId of rejectedIds) {
    const imageDir = path.join(imagesRoot, panoId);
    // 削除前に、実際にimagesRoot配下のパスであることを確認する安全チェック。panoIdは
    // labels.jsonのキー(通常は内部生成された英数字ID)なので実運用で問題になることは
    // 想定していないが、`fs.rmSync(..., { recursive: true })`という再帰削除の操作の
    // 重大さに対して、この程度のガードは費用対効果が高い。
    const resolvedImageDir = path.resolve(imageDir);
    if (!resolvedImageDir.startsWith(imagesRoot + path.sep)) {
      console.log(`skipping suspicious image dir outside images/: ${imageDir}`);
      continue;
    }
    if (!fs.existsSync(resolvedImageDir)) continue;
    fs.rmSync(resolvedImageDir, { recursive: true });
    deletedImageDirs++;
  }

  const report = {
    migratedAt: new Date().toISOString(),
    labels: { before: Object.keys(labels).length, after: Object.keys(migratedLabels).length },
    items: { before: items.length, after: retainedItems.length },
    migratedSmallcam,
    rejectedRemoved: rejectedIds.size,
    deletedImageDirs,
    candidateResults,
    rejectedPanoIds: [...rejectedIds],
  };
  fs.writeFileSync(path.join(dataDir, "migration-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
