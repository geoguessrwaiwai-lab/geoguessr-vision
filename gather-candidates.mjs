import fs from "node:fs";
import path from "node:path";
import { findPanoramaNear } from "./pano-meta.mjs";

// Usage:
//   node gather-candidates.mjs <outFile.json> [--source-root=/path/to/Vali] [--per-file=N] [--countries=UA,KR,...] [--radius=N]
//
// Builds a pool of { lat, lon, panoId, headingDeg, date, source } candidates for the
// Gen1-4 / hood-color labeling tool, by resolving lat/lng points from Vali's own
// `*-locations.json` outputs (and any manually-added seed points below) to real
// Street View panoramas via the free findPanoramaNear lookup. No API key needed.
//
// Kept deliberately broad/diverse: the AR/MX location pool alone is almost certainly
// homogeneous in camera generation (same rural regions, similar capture eras), so a
// handful of manually chosen international points are mixed in to have a chance of
// covering Gen4 (recently-refreshed urban corridors) and older/rural Gen1-2 coverage.

const sourceRootArg = process.argv.slice(2).find((a) => a.startsWith("--source-root="));
const SOURCE_ROOT = sourceRootArg
  ? path.resolve(sourceRootArg.slice("--source-root=".length))
  : process.cwd();

const DEFAULT_GLOBS = [
  "argentina-provinces/*-locations.json",
  "mexico-states/*-locations.json",
];

// Manually curated seed points to broaden generation coverage beyond AR/MX.
// lat, lon, label (just for the operator's own reference, not sent anywhere)
const SEED_POINTS = [
  [40.758896, -73.98513, "NYC Times Square (candidate Gen4)"],
  [35.659518, 139.700575, "Tokyo Shibuya (candidate Gen4)"],
  [37.497913, 127.027596, "Seoul Gangnam (candidate Gen4)"],
  [-23.561414, -46.655881, "Sao Paulo Av. Paulista (candidate Gen4)"],
  [48.869814, 2.305188, "Paris Champs-Elysees (candidate Gen4)"],
  [51.507359, -0.127603, "London (candidate Gen4)"],
  [37.773972, -122.431297, "San Francisco (candidate Gen4)"],
  [55.755825, 37.617298, "Moscow (candidate mixed gen)"],
  [-33.868820, 151.209290, "Sydney (candidate mixed gen)"],
  [64.845742, -147.722603, "Fairbanks AK (candidate older coverage)"],
  [-1.286389, 36.817223, "Nairobi (candidate older coverage)"],
  [27.700769, 85.300140, "Kathmandu (candidate older coverage)"],
];

// Road-based samples from countries whose standard Street View coverage is Gen3.
// These are intentionally spread between regions and cities to reduce background
// shortcuts. The nearby panorama is still checked for Google's trekker/scout flag.
const GEN3_COUNTRY_SEEDS = {
  UA: [
    [50.4505, 30.5237, "Kyiv"],
    [49.8397, 24.0297, "Lviv"],
    [46.4825, 30.7233, "Odesa"],
    [49.9935, 36.2304, "Kharkiv"],
    [48.4647, 35.0462, "Dnipro"],
    [48.6208, 22.2879, "Uzhhorod"],
  ],
  KR: [
    [37.5665, 126.9780, "Seoul"],
    [35.1796, 129.0756, "Busan"],
    [35.8714, 128.6014, "Daegu"],
    [36.3504, 127.3845, "Daejeon"],
    [35.1595, 126.8526, "Gwangju"],
    [35.8242, 127.1480, "Jeonju"],
  ],
  LS: [
    [-29.3158, 27.4869, "Maseru"],
    [-28.7666, 28.2494, "Butha-Buthe"],
    [-28.8734, 28.0416, "Leribe"],
    [-29.8230, 27.2370, "Mafeteng"],
    [-30.1586, 27.4769, "Mohale's Hoek"],
    [-29.2894, 29.0675, "Mokhotlong"],
  ],
  SZ: [
    [-26.3054, 31.1367, "Mbabane"],
    [-26.4950, 31.3877, "Manzini"],
    [-26.4667, 31.2000, "Lobamba"],
    [-26.4525, 31.9472, "Siteki"],
    [-27.1122, 31.1988, "Nhlangano"],
    [-25.9617, 31.2476, "Piggs Peak"],
  ],
  BT: [
    [27.4728, 89.6393, "Thimphu"],
    [27.4305, 89.4133, "Paro"],
    [27.5921, 89.8797, "Punakha"],
    [27.4862, 89.8997, "Wangdue Phodrang"],
    [27.5026, 90.5049, "Trongsa"],
    [26.8516, 89.3883, "Phuentsholing"],
  ],
  BO: [
    [-16.4897, -68.1193, "La Paz"],
    [-17.7833, -63.1821, "Santa Cruz de la Sierra"],
    [-17.3895, -66.1568, "Cochabamba"],
    [-19.0196, -65.2619, "Sucre"],
    [-17.9647, -67.1060, "Oruro"],
    [-21.5355, -64.7296, "Tarija"],
  ],
  UY: [
    [-34.9011, -56.1645, "Montevideo"],
    [-34.9626, -54.9501, "Punta del Este"],
    [-34.4714, -57.8442, "Colonia del Sacramento"],
    [-31.3880, -57.9610, "Salto"],
    [-32.3214, -58.0756, "Paysandu"],
    [-30.9053, -55.5508, "Rivera"],
  ],
};

function globSync(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const full = path.join(SOURCE_ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => re.test(f)).map((f) => path.join(full, f));
}

function loadLatLngFromLocationsFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const coords = Array.isArray(data) ? data : data.customCoordinates ?? [];
  return coords.map((c) => ({ lat: c.lat, lon: c.lng, sourceFile: path.basename(file) }));
}

const args = process.argv.slice(2);
const outFile = args.find((a) => !a.startsWith("--"));
const perFileArg = args.find((a) => a.startsWith("--per-file="));
const perFile = perFileArg ? parseInt(perFileArg.split("=")[1], 10) : 6;
const countriesArg = args.find((a) => a.startsWith("--countries="));
const radiusArg = args.find((a) => a.startsWith("--radius="));
const radius = radiusArg ? parseInt(radiusArg.split("=")[1], 10) : 50;
const requestedCountries = countriesArg
  ? countriesArg.split("=")[1].split(",").map((code) => code.trim().toUpperCase()).filter(Boolean)
  : null;

if (!outFile) {
  console.error('Usage: node gather-candidates.mjs <outFile.json> [--source-root=/path/to/Vali] [--per-file=N] [--countries=UA,KR,LS,SZ,BT,BO,UY] [--radius=N]');
  process.exit(1);
}

if (!Number.isInteger(radius) || radius < 1 || radius > 1000) {
  console.error("--radius must be an integer between 1 and 1000 meters");
  process.exit(1);
}

if (requestedCountries) {
  const unknown = requestedCountries.filter((code) => !GEN3_COUNTRY_SEEDS[code]);
  if (unknown.length) {
    console.error(`Unknown Gen3 country code(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
}

const files = requestedCountries ? [] : DEFAULT_GLOBS.flatMap(globSync);
console.log(`found ${files.length} source location files`);

let pool = [];
for (const file of files) {
  const points = loadLatLngFromLocationsFile(file);
  // Spread the sample across the file rather than clustering at the start.
  const step = Math.max(1, Math.floor(points.length / perFile));
  for (let i = 0; i < points.length && pool.length < 100000; i += step) {
    pool.push(points[i]);
  }
}
if (!requestedCountries) {
  for (const [lat, lon, label] of SEED_POINTS) {
    pool.push({ lat, lon, sourceFile: `seed: ${label}` });
  }
}
const countryCodes = requestedCountries ?? Object.keys(GEN3_COUNTRY_SEEDS);
for (const countryCode of countryCodes) {
  for (const [lat, lon, label] of GEN3_COUNTRY_SEEDS[countryCode]) {
    pool.push({ lat, lon, sourceFile: `Gen3 ${countryCode}: ${label}`, countryCode });
  }
}

console.log(`resolving ${pool.length} candidate points to panoramas...`);

const candidates = [];
let i = 0;
for (const p of pool) {
  i++;
  try {
    const meta = await findPanoramaNear(p.lat, p.lon, radius);
    if (!meta) {
      console.log(`[${i}/${pool.length}] no panorama near ${p.lat},${p.lon} (${p.sourceFile})`);
      continue;
    }
    if (meta.isScout) {
      console.log(`[${i}/${pool.length}] skipped trekker/scout ${meta.id} (${p.sourceFile})`);
      continue;
    }
    candidates.push({
      panoId: meta.id,
      lat: meta.lat,
      lon: meta.lon,
      headingDeg: meta.headingDeg,
      rollDeg: meta.rollDeg,
      date: meta.date,
      copyright: meta.copyright,
      isScout: meta.isScout,
      countryCode: p.countryCode,
      sourceFile: p.sourceFile,
    });
    console.log(`[${i}/${pool.length}] ${meta.id} (${meta.date}, ${p.sourceFile})`);
  } catch (e) {
    console.log(`[${i}/${pool.length}] FAILED ${p.lat},${p.lon}: ${e.message}`);
  }
}

// De-dupe by panoId (adjacent samples can resolve to the same pano).
const seen = new Set();
const deduped = candidates.filter((c) => (seen.has(c.panoId) ? false : (seen.add(c.panoId), true)));

fs.writeFileSync(outFile, JSON.stringify(deduped, null, 2));
console.log(`\nWrote ${deduped.length} unique candidates to ${outFile}`);
