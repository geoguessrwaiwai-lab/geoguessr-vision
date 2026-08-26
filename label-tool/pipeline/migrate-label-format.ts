import fs from "node:fs";
import path from "node:path";
import type { LabelsFile, LabelItem } from "../../shared/types.ts";

// 使い方: npx tsx label-tool/migrate-label-format.ts <dataDir> [candidate.json ...]
//
// ラベリングUIで棄却(Xキー)された地点を、labels.json・items.json・候補プール
// (candidates/*.json)・images/から取り除く。

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
  const labels: LabelsFile = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  const items: LabelItem[] = JSON.parse(fs.readFileSync(itemsPath, "utf8"));

  const rejectedIds = new Set(
    Object.entries(labels)
      .filter(([, label]) => "rejected" in label && label.rejected)
      .map(([panoId]) => panoId),
  );

  const retainedLabels: LabelsFile = Object.fromEntries(
    Object.entries(labels).filter(([panoId]) => !rejectedIds.has(panoId)),
  );
  const retainedItems = items.filter((item) => !rejectedIds.has(item.panoId));
  fs.writeFileSync(labelsPath, JSON.stringify(retainedLabels, null, 2));
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
    labels: { before: Object.keys(labels).length, after: Object.keys(retainedLabels).length },
    items: { before: items.length, after: retainedItems.length },
    rejectedRemoved: rejectedIds.size,
    deletedImageDirs,
    candidateResults,
    rejectedPanoIds: [...rejectedIds],
  };
  fs.writeFileSync(path.join(dataDir, "migration-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
