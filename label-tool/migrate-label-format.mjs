import fs from "node:fs";
import path from "node:path";

// Migrates the old flat generation/color labels to the conditional schema used by the
// labeling UI. Reusable information is preserved; fields that cannot be inferred safely
// (copyrightYear and Gen3 antenna features) are deliberately left unset for re-review.
// Rejected panorama IDs are removed from labels, items, candidate pools, and image folders.
//
// Usage: node label-tool/migrate-label-format.mjs <dataDir> [candidate.json ...]

const [, , dataDirArg, ...candidateArgs] = process.argv;
if (!dataDirArg) {
  console.error("Usage: node label-tool/migrate-label-format.mjs <dataDir> [candidate.json ...]");
  process.exit(1);
}

const dataDir = path.resolve(dataDirArg);
const labelsPath = path.join(dataDir, "labels.json");
const itemsPath = path.join(dataDir, "items.json");
const candidatePaths = candidateArgs.map((file) => path.resolve(file));
const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
const items = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
const rejectedIds = new Set(
  Object.entries(labels).filter(([, label]) => label.rejected).map(([panoId]) => panoId),
);

function migrateLabel(panoId, oldLabel) {
  const wasSmallcam = oldLabel.gen === "Small cam";
  const gen = wasSmallcam ? "Gen4" : oldLabel.gen;
  const migrated = {
    panoId,
    gen,
    confidence: oldLabel.confidence ?? "high",
    notes: oldLabel.notes ?? "",
  };

  if (gen === "Gen3" || gen === "Gen4") {
    const allowedFeatures = gen === "Gen3"
      ? new Set(["stubby antenna", "long antenna", "short antenna"])
      : new Set(["smallcam"]);
    migrated.features = wasSmallcam
      ? ["smallcam"]
      : [...new Set(oldLabel.features ?? [])].filter((feature) => allowedFeatures.has(feature));
    migrated.carView = wasSmallcam ? "both" : oldLabel.carView;
    const omitColor = wasSmallcam || migrated.carView === "neither";
    migrated.color = omitColor ? null : (oldLabel.color ?? null);
    migrated.colorCustom = omitColor ? "" : (oldLabel.colorCustom ?? "");
    if (Number.isInteger(oldLabel.copyrightYear) && oldLabel.copyrightYear >= 2009) {
      migrated.copyrightYear = oldLabel.copyrightYear;
    }
  }

  if (oldLabel.at) migrated.at = oldLabel.at;
  return migrated;
}

const migratedLabels = {};
let migratedSmallcam = 0;
for (const [panoId, label] of Object.entries(labels)) {
  if (rejectedIds.has(panoId)) continue;
  if (label.gen === "Small cam") migratedSmallcam++;
  if (label.gen) migratedLabels[panoId] = migrateLabel(panoId, label);
  else migratedLabels[panoId] = label;
}

const retainedItems = items.filter((item) => !rejectedIds.has(item.panoId));
fs.writeFileSync(labelsPath, JSON.stringify(migratedLabels, null, 2));
fs.writeFileSync(itemsPath, JSON.stringify(retainedItems, null, 2));

const candidateResults = [];
for (const candidatePath of candidatePaths) {
  const candidates = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const retained = candidates.filter((candidate) => !rejectedIds.has(candidate.panoId));
  fs.writeFileSync(candidatePath, JSON.stringify(retained, null, 2));
  candidateResults.push({ file: candidatePath, before: candidates.length, after: retained.length });
}

let deletedImageDirs = 0;
for (const panoId of rejectedIds) {
  const imageDir = path.join(dataDir, "images", panoId);
  if (!fs.existsSync(imageDir)) continue;
  fs.rmSync(imageDir, { recursive: true });
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
