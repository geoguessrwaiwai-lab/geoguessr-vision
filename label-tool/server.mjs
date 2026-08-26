import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Usage: node server.mjs <dataDir> [port]
// dataDir must contain items.json (from capture-for-labeling.mjs) and images/.
// Labels are persisted to <dataDir>/labels.json, keyed by panoId, so the tool can be
// closed and reopened without losing progress.

const [, , dataDir, portArg] = process.argv;
if (!dataDir) {
  console.error("Usage: node server.mjs <dataDir> [port]");
  process.exit(1);
}
const port = portArg ? parseInt(portArg, 10) : 4173;
const labelsPath = path.join(dataDir, "labels.json");
const publicDir = path.join(import.meta.dirname, "public");

function loadLabels() {
  if (!fs.existsSync(labelsPath)) return {};
  return JSON.parse(fs.readFileSync(labelsPath, "utf8"));
}

function saveLabels(labels) {
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
}

// Values here are the same strings that end up in extra.tags on the final location JSON
// (see README's tag vocabulary table) — kept identical so a label can be turned into tags by
// copying fields, not translating them.
const GENERATIONS = new Set(["Gen1", "Gen2", "Gen3", "Gen4", "Shitcam"]);
const CAR_VIEWS = new Set(["front", "back", "both", "neither"]);
const GEN3_FEATURES = new Set(["stubby antenna", "long antenna", "short antenna"]);
const GEN4_FEATURES = new Set(["Smallcam"]);

function validateLabel(entry) {
  if (typeof entry.panoId !== "string" || entry.panoId.length === 0) return "panoId is required";
  if (!GENERATIONS.has(entry.gen)) return "invalid generation";
  const detailed = entry.gen === "Gen3" || entry.gen === "Gen4";
  if (!detailed) return null;

  const features = entry.features ?? [];
  if (!Array.isArray(features) || new Set(features).size !== features.length) return "features must be a unique array";
  const allowedFeatures = entry.gen === "Gen3" ? GEN3_FEATURES : GEN4_FEATURES;
  if (features.some((feature) => !allowedFeatures.has(feature))) return `invalid feature for ${entry.gen}`;

  const smallcam = features.includes("Smallcam");
  if (!CAR_VIEWS.has(entry.carView)) return "invalid car view";
  if (smallcam && entry.carView !== "both") return "Smallcam must use carView=both";
  if (!smallcam && entry.carView !== "neither" && !entry.color) return "color is required when the car is visible";
  if ((smallcam || entry.carView === "neither") && entry.color != null) return "color must be null for smallcam or neither";

  // "unclear" mirrors tag-watermark-year.mjs's "©unclear" fallback — the watermark year is
  // baked into the render just like copyright year is, and it's just as often illegible by
  // eye as it is by OCR. Forcing a guessed year here would poison training data with the same
  // kind of unreliable label the automated OCR path was built to avoid.
  const currentYear = new Date().getFullYear();
  const validYear = Number.isInteger(entry.copyrightYear) && entry.copyrightYear >= 2009 && entry.copyrightYear <= currentYear;
  if (entry.copyrightYear !== "unclear" && !validYear) {
    return `copyrightYear must be "unclear" or an integer from 2009 to ${currentYear}`;
  }
  return null;
}

function normalizeLabel(entry) {
  const normalized = {
    panoId: entry.panoId,
    gen: entry.gen,
    confidence: entry.confidence ?? "high",
    notes: entry.notes ?? "",
  };
  if (entry.gen === "Gen3" || entry.gen === "Gen4") {
    normalized.features = entry.features ?? [];
    normalized.carView = entry.carView;
    normalized.color = entry.color ?? null;
    normalized.colorCustom = entry.color == null ? "" : (entry.colorCustom ?? "");
    normalized.copyrightYear = entry.copyrightYear;
  }
  return normalized;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".css": "text/css" };

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");

  if (parsed.pathname === "/api/items" && req.method === "GET") {
    const items = JSON.parse(fs.readFileSync(path.join(dataDir, "items.json"), "utf8"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(items));
    return;
  }

  if (parsed.pathname === "/api/labels" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadLabels()));
    return;
  }

  if (parsed.pathname === "/api/label" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const entry = JSON.parse(body);
      const labels = loadLabels();
      if (entry.skip) {
        delete labels[entry.panoId];
        labels[entry.panoId] = { skipped: true, at: new Date().toISOString() };
      } else if (entry.reject) {
        delete labels[entry.panoId];
        labels[entry.panoId] = { rejected: true, reason: entry.reason ?? "", at: new Date().toISOString() };
      } else {
        const error = validateLabel(entry);
        if (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error }));
          return;
        }
        labels[entry.panoId] = { ...normalizeLabel(entry), at: new Date().toISOString() };
      }
      saveLabels(labels);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (parsed.pathname.startsWith("/images/")) {
    serveFile(res, path.join(dataDir, parsed.pathname));
    return;
  }

  const staticPath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  serveFile(res, path.join(publicDir, staticPath));
});

server.listen(port, () => {
  console.log(`Labeling tool running at http://localhost:${port}`);
  console.log(`Data dir: ${dataDir}`);
});
