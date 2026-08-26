// Street View metadata lookups that need no Google API key: a panorama's true camera
// orientation (photometa) and nearby-panorama search (SingleImageSearch), both scraped
// from the same internal endpoints the Google Maps website itself uses.

import { Enum, Dbl, toProtobufUrl, fetchGoogleJson } from "./pb-url.mjs";

export const RESOLUTION_HEIGHT = Object.freeze({
  GEN1_MAX: 1664,
  GEN2_GEN3_SHITCAM: 6656,
  GEN4: 8192,
});

export const RESOLUTION_CLASS = Object.freeze({
  GEN1: "Gen1",
  GEN2_GEN3_SHITCAM: "Gen2 / Gen3 / Shitcam",
  GEN4: "Gen4",
  UNKNOWN: "Unknown",
});

// ResolutionHeight alone provides only these coarse camera-generation classes.
// In particular, 6656 cannot distinguish Gen2, Gen3, and Shitcam.
export function classifyResolutionHeight(resolutionHeight) {
  if (!Number.isFinite(resolutionHeight)) return RESOLUTION_CLASS.UNKNOWN;
  if (resolutionHeight <= RESOLUTION_HEIGHT.GEN1_MAX) return RESOLUTION_CLASS.GEN1;
  if (resolutionHeight === RESOLUTION_HEIGHT.GEN4) return RESOLUTION_CLASS.GEN4;
  if (resolutionHeight === RESOLUTION_HEIGHT.GEN2_GEN3_SHITCAM) {
    return RESOLUTION_CLASS.GEN2_GEN3_SHITCAM;
  }
  return RESOLUTION_CLASS.UNKNOWN;
}

// Country -> "captured on/after this year-month means it's known third-party Shitcam
// coverage" cutoffs. This is a manually-curated list of known country/date combinations,
// not a general detector — countries absent from this table are never flagged, even if
// they do have third-party low-quality coverage. That's an accepted false-negative, not a
// bug: the alternative (image-based classification) is the fallback for everything this
// list misses. Cutoffs are inclusive-from (>=).
const SHITCAM_CUTOFFS = new Map([
  ["BD", { year: 2021, month: 4 }],
  ["EC", { year: 2022, month: 3 }],
  ["FI", { year: 2020, month: 9 }],
  ["IN", { year: 2021, month: 10 }],
  ["KH", { year: 2022, month: 10 }],
  ["LB", { year: 2021, month: 1 }],
  ["LK", { year: 2021, month: 2 }],
  ["NG", { year: 2021, month: 6 }],
  ["NP", { year: 2020, month: 1 }],
  ["VN", { year: 2020, month: 1 }],
  // Europe-wide default cutoff, shared by all these countries.
  ["AT", { year: 2021, month: 1 }],
  ["BG", { year: 2021, month: 1 }],
  ["CZ", { year: 2021, month: 1 }],
  ["DK", { year: 2021, month: 1 }],
  ["EE", { year: 2021, month: 1 }],
  ["ES", { year: 2021, month: 1 }],
  ["FR", { year: 2021, month: 1 }],
  ["GB", { year: 2021, month: 1 }],
  ["GR", { year: 2021, month: 1 }],
  ["HR", { year: 2021, month: 1 }],
  ["IT", { year: 2021, month: 1 }],
  ["LT", { year: 2021, month: 1 }],
  ["LV", { year: 2021, month: 1 }],
  ["PL", { year: 2021, month: 1 }],
  ["PT", { year: 2021, month: 1 }],
  ["RO", { year: 2021, month: 1 }],
  ["SE", { year: 2021, month: 1 }],
  // Cyprus and São Tomé and Príncipe: ALL coverage is known Shitcam, no date cutoff.
  ["CY", { year: -Infinity, month: 1 }],
  ["ST", { year: -Infinity, month: 1 }],
]);
// US is special-cased on latitude (only Alaska, north of 52°N) on top of a date cutoff.
const US_SHITCAM_CUTOFF = { year: 2019, month: 1 };

// Given a resolutionHeight===6656 panorama's capture date ("YYYY-M" as returned by `date`
// above), country code, and latitude, checks whether it falls in a country/date range known
// to be third-party low-quality (Shitcam) coverage rather than genuine Gen2/Gen3.
// Countries not in SHITCAM_CUTOFFS always return false (see SHITCAM_CUTOFFS comment) — this
// is a targeted, incomplete heuristic, not a general Shitcam detector.
export function isKnownShitcam({ date, countryCode, lat }) {
  if (!date || !countryCode) return false;
  const [year, month] = date.split("-").map(Number);
  if (!Number.isFinite(year) || year <= 2000) return false;
  const yearMonth = year * 12 + month;
  if (countryCode === "US") {
    if (!(Number.isFinite(lat) && lat > 52)) return false;
    return yearMonth >= US_SHITCAM_CUTOFF.year * 12 + US_SHITCAM_CUTOFF.month;
  }
  const cutoff = SHITCAM_CUTOFFS.get(countryCode);
  if (!cutoff) return false;
  return yearMonth >= cutoff.year * 12 + cutoff.month;
}

function buildMetaRequestUrl(panoId) {
  const toggles = [1, 2, 3, 4, 5, 6, 8, 12].map((n) => new Enum(n));
  const message = {
    1: { 1: "maps_sv.tactile", 11: { 2: { 1: true } } },
    2: { 1: "en", 2: "US" },
    3: { 1: { 1: new Enum(2), 2: panoId } },
    4: {
      1: toggles,
      2: { 1: new Enum(1) },
      4: { 1: 48 },
      5: [{}],
      6: [{}],
      9: {
        1: [
          { 1: new Enum(2), 2: true, 3: new Enum(2) },
          { 1: new Enum(2), 2: false, 3: new Enum(3) },
          { 1: new Enum(3), 2: true, 3: new Enum(2) },
          { 1: new Enum(3), 2: false, 3: new Enum(3) },
          { 1: new Enum(8), 2: false, 3: new Enum(3) },
          { 1: new Enum(1), 2: false, 3: new Enum(3) },
          { 1: new Enum(4), 2: false, 3: new Enum(3) },
          { 1: new Enum(10), 2: true, 3: new Enum(2) },
          { 1: new Enum(10), 2: false, 3: new Enum(3) },
        ],
      },
      11: { 3: { 4: true } },
    },
  };
  const [, pb] = toProtobufUrl(message);
  return `https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=US&pb=${pb}`;
}

function parsePanoMessage(msg) {
  const orientation = msg[5][0][1][2]; // [headingDeg, pitchFromZenithDeg, rollDeg]
  const captureKind = msg[6]?.[5]?.[2];
  const resolutionHeight = msg[2]?.[2]?.[0] ?? null;
  return {
    id: msg[1][1],
    resolutionHeight,
    resolutionClass: classifyResolutionHeight(resolutionHeight),
    lat: msg[5][0][1][0][2],
    lon: msg[5][0][1][0][3],
    headingDeg: orientation[0],
    pitchDeg: 90 - orientation[1],
    rollDeg: orientation[2],
    date: msg[6]?.[7]?.slice(0, 2)?.join("-") ?? null, // [year, month] if present
    // ISO 3166-1 alpha-2 country code (e.g. "IN", "US"), used by isKnownShitcam() below.
    countryCode: msg[5]?.[0]?.[1]?.[4] ?? null,
    // The copyright line shown in the Street View corner, e.g. "© 2024 Google" for
    // official Google-driven coverage, or "© <company/agency name>" for third-party
    // (trekker, government, etc.) imagery — this is independent of the capture date.
    copyright: msg[4]?.[0]?.[0]?.[0]?.[0] ?? null,
    // Google's metadata marks Gen3 trekker coverage as "scout". Keep this as a
    // first-class field so dataset builders can reject it before downloading tiles.
    isScout: captureKind === "scout",
  };
}

// Returns { id, resolutionHeight, headingDeg, pitchDeg, rollDeg, lat, lon, date, countryCode,
// isScout } for a Street View panoId, using the direction the camera vehicle actually faced
// (not the map-maker's chosen view angle).
export async function getPanoMeta(panoId) {
  const data = await fetchGoogleJson(buildMetaRequestUrl(panoId));
  return parsePanoMessage(data[1][0]);
}

function buildFindRequestUrl(lat, lon, radius) {
  const message = {
    1: { 1: "apiv3", 5: "US", 11: { 1: { 1: false } } },
    2: { 1: { 3: new Dbl(lat), 4: new Dbl(lon) }, 2: new Dbl(radius) },
    3: {
      2: { 1: "en", 2: "US" },
      9: { 1: new Enum(2) },
      11: { 1: { 1: new Enum(2), 2: true, 3: new Enum(2) } },
    },
    4: {
      1: [1, 2, 3, 4, 6, 8, 12].map((n) => new Enum(n)),
      5: {},
      6: {},
    },
  };
  const [, pb] = toProtobufUrl(message);
  return `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=${pb}&callback=_xdc_._v2mub5`;
}

// Finds the nearest Street View panorama to a point (default 50m radius).
// Returns the same shape as getPanoMeta, or null if nothing was found.
export async function findPanoramaNear(lat, lon, radius = 50) {
  const url = buildFindRequestUrl(lat, lon, radius);
  const res = await fetch(url, {
    headers: { Accept: "*/*", Referer: "https://www.google.com/" },
  });
  if (!res.ok) throw new Error(`find_panorama failed: ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  const data = JSON.parse(`[${text.slice(start + 1, end)}]`);
  const responseCode = data[0][0][0];
  if (responseCode !== 0) return null;
  return parsePanoMessage(data[0][1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, a, b] = process.argv;
  if (cmd === "near") {
    console.log(await findPanoramaNear(parseFloat(a), parseFloat(b)));
  } else {
    console.log(await getPanoMeta(cmd));
  }
}
