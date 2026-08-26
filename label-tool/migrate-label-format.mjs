import fs from "node:fs";
import path from "node:path";

// Migrates the old flat generation/color labels to the conditional schema used by the
// labeling UI. Reusable information is preserved; Smallcam (whether it was the old flat
// "Small cam" value or a Gen4 label with a "smallcam"/"Smallcam" feature) is normalized to its
// own top-level generation, since Smallcam is a sibling of Gen4 rather than a feature of it.
// Gen3's now-removed antenna features are dropped rather than guessed.
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

// Only Gen4 collects car color/carView. Copyright year is collected for every generation.
// See label-tool/server.mjs.
const COLOR_GENS = new Set(["Gen4"]);

function migrateLabel(panoId, oldLabel) {
  const oldFeatures = (oldLabel.features ?? []).map((f) => (f === "smallcam" ? "Smallcam" : f));
  const wasSmallcam = oldLabel.gen === "Small cam" || (oldLabel.gen === "Gen4" && oldFeatures.includes("Smallcam"));
  const gen = wasSmallcam ? "Smallcam" : oldLabel.gen;
  const migrated = {
    panoId,
    gen,
    confidence: oldLabel.confidence ?? "high",
    notes: oldLabel.notes ?? "",
  };

  if (oldLabel.copyrightYear === "unclear" || (Number.isInteger(oldLabel.copyrightYear) && oldLabel.copyrightYear >= 2009)) {
    migrated.copyrightYear = oldLabel.copyrightYear;
  }

  if (COLOR_GENS.has(gen)) {
    migrated.carView = oldLabel.carView;
    const omitColor = migrated.carView === "neither" || migrated.carView == null;
    migrated.color = omitColor ? null : (oldLabel.color ?? null);
    migrated.colorCustom = omitColor ? "" : (oldLabel.colorCustom ?? "");
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
