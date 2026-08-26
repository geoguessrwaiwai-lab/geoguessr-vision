import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { GENERATIONS, COLOR_GENS as DEFAULT_COLOR_GENS } from "../shared/generations.ts";
import type { LabelEntry, LabelsFile, LabelToolConfig } from "../shared/types.ts";

// 使い方: npx tsx server.ts <dataDir> [port]
// dataDirにはitems.json(capture-for-labeling.tsが生成)とimages/が必要。
// ラベルは<dataDir>/labels.jsonにpanoIdをキーとして永続化されるので、ツールを閉じて
// 再度開いても進捗は失われない。
//
// <dataDir>/model.json があれば、そのモデル専用の設定(選択可能な世代・タイトルなど)
// として読み込む。モデルごとにデータフォルダを分ける(例: gen2-vs-gen3/)ことで、
// ラベリングUI・サーバーのコード自体は1つのまま、モデルごとに選択肢だけを変えられる。
// model.jsonが無いデータフォルダ(移行前の古いもの)は、全世代を扱う従来の挙動にフォールバックする。

const [, , dataDir, portArg] = process.argv;
if (!dataDir) {
  console.error("Usage: npx tsx server.ts <dataDir> [port]");
  process.exit(1);
}
const port = portArg ? parseInt(portArg, 10) : 4173;
const labelsPath = path.join(dataDir, "labels.json");
const configPath = path.join(dataDir, "model.json");
// import.meta.dirnameはNode 20.11+/21.2+で使える比較的新しいAPI。tsxはホストのNode
// ランタイム上で動くため、これより古いNodeでは動作しない点に注意。
const publicDir = path.join(import.meta.dirname, "public");

const config: LabelToolConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : { name: path.basename(path.resolve(dataDir)), generations: [...GENERATIONS], colorGens: [...DEFAULT_COLOR_GENS] };
const GENS = new Set(config.generations);
const COLOR_GENS = new Set(config.colorGens ?? []);

function loadLabels(): LabelsFile {
  if (!fs.existsSync(labelsPath)) return {};
  return JSON.parse(fs.readFileSync(labelsPath, "utf8"));
}

function saveLabels(labels: LabelsFile) {
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
}

// CAR_VIEWSとCOLOR_GENSの値は、最終的な地点JSONのextra.tagsに入るのと同じ文字列
// (READMEのタグ語彙表参照) — ラベルをタグに変換するときに翻訳ではなくフィールドの
// コピーで済むよう、意図的に同じにしている。Smallcamはそれ自体が独立した世代
// (Gen4にぶら下がる機能ではなく兄弟世代)であり、Gen4と同じResolutionHeightを共有
// しつつ見た目は明確に異なり、車体色を一切示さない。
const CAR_VIEWS = new Set(["front", "back", "both", "neither"]);

function validateLabel(entry: any): string | null {
  if (typeof entry.panoId !== "string" || entry.panoId.length === 0) return "panoId is required";
  if (!GENS.has(entry.gen)) return "invalid generation";

  if (!COLOR_GENS.has(entry.gen)) return null;

  if (!CAR_VIEWS.has(entry.carView)) return "invalid car view";
  if (entry.carView !== "neither" && !entry.color) return "color is required when the car is visible";
  if (entry.carView === "neither" && entry.color != null) return "color must be null when carView is neither";
  return null;
}

function normalizeLabel(entry: any): Omit<LabelEntry, "at"> {
  const normalized: Omit<LabelEntry, "at"> = {
    panoId: entry.panoId,
    gen: entry.gen,
    confidence: entry.confidence ?? "high",
    notes: entry.notes ?? "",
  };
  if (COLOR_GENS.has(entry.gen)) {
    normalized.carView = entry.carView;
    normalized.color = entry.color ?? null;
    normalized.colorCustom = entry.color == null ? "" : entry.colorCustom ?? "";
  }
  return normalized;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".css": "text/css",
};

function serveFile(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url ?? "/", "http://localhost");

  if (parsed.pathname === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }

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
      let entry: any;
      try {
        entry = JSON.parse(body);
      } catch {
        // 元の実装はここでJSON.parseの例外を捕捉しておらず、不正なリクエストボディを
        // 送るとこのリクエストハンドラがクラッシュしていた(プロセス全体は落ちないが、
        // レスポンスも返らずクライアントがハングする)。400を返して安全に終える。
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
      }
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
        labels[entry.panoId] = { ...normalizeLabel(entry), at: new Date().toISOString() } as LabelEntry;
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
