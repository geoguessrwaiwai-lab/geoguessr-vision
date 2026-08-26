import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".css": "text/css" };

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

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
        labels[entry.panoId] = { ...entry, at: new Date().toISOString() };
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
