import sharp from "sharp";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchTile(panoId, x, y, zoom) {
  const url = `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid=${panoId}&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fir=0`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`tile ${x},${y} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Stitch full equirectangular panorama at given zoom (0-5). zoom=3 -> 4096x2048 (8x4 tiles).
// Older/less-recently-reprocessed panoramas often don't have tiles available at the higher
// zoom levels (a specific tile — commonly the last column — 400s while the rest succeed), so
// on any tile failure this automatically retries one zoom level down, all the way to zoom=0
// if needed, rather than failing the whole render.
export async function stitchEquirect(panoId, zoom = 3) {
  const tilesX = 2 ** zoom;
  const tilesY = Math.ceil(tilesX / 2);
  const tileSize = 512;
  let composites;
  try {
    // Fetch all tiles concurrently rather than one at a time — at zoom=3 that's 32 sequential
    // round-trips (multiple seconds) vs. one parallel batch (a few hundred ms).
    const coords = [];
    for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) coords.push([x, y]);
    const buffers = await Promise.all(coords.map(([x, y]) => fetchTile(panoId, x, y, zoom)));
    composites = coords.map(([x, y], i) => ({ input: buffers[i], left: x * tileSize, top: y * tileSize }));
  } catch (e) {
    if (zoom > 0) return stitchEquirect(panoId, zoom - 1);
    throw e;
  }
  const width = tilesX * tileSize;
  const height = tilesY * tileSize;
  const equirect = sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(composites);
  const { data, info } = await equirect.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// NOTE: a tile-seam cross-fade was tried here (adjacent tiles come from different camera
// lenses/exposures and occasionally show a hard, visibly-mismatched seam) but reverted — it
// blended a band across EVERY internal tile boundary in the whole equirect regardless of
// whether that particular seam actually had a problem, introducing a visible soft-focus
// stripe into otherwise-fine images. A genuine parallax/exposure mismatch between lenses
// can't be fixed with a simple cross-fade anyway (confirmed: shifting the crop's yaw to move
// a bad seam off-center didn't help either, since the underlying content itself doesn't
// line up, not just the color). When one of front/back lands on a bad seam for a given
// panorama, use the other — that's the actual mitigation.

// Reproject equirect -> perspective view (heading in degrees 0-360, pitch in degrees -90..90, fov in
// degrees). `roll` (degrees) rotates the virtual camera around its own forward axis before pitch/yaw —
// pass the panorama's true capture roll (see pano-meta.mjs) so the rendered view stays aligned with the
// vehicle body (and thus the hood) even when the car was banked/tilted at capture time; a level roll=0
// view can otherwise push the hood off to one side or out of frame entirely on cambered/sloped roads.
function reproject(equirect, heading, pitch, fov, outW, outH, roll = 0) {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const out = Buffer.alloc(outW * outH * 3);
  const yaw0 = (heading * Math.PI) / 180;
  const pitch0 = (pitch * Math.PI) / 180;
  const roll0 = (roll * Math.PI) / 180;
  const fovRad = (fov * Math.PI) / 180;
  const focal = 0.5 * outW / Math.tan(fovRad / 2);

  // Rotation matrix: roll around Z (forward), then pitch around X, then yaw around Y
  const cosYaw = Math.cos(yaw0), sinYaw = Math.sin(yaw0);
  const cosPitch = Math.cos(pitch0), sinPitch = Math.sin(pitch0);
  const cosRoll = Math.cos(roll0), sinRoll = Math.sin(roll0);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const px = ox - outW / 2;
      const py = oy - outH / 2;
      // camera-space direction (looking down +z)
      let dx0 = px / focal;
      let dy0 = py / focal;
      let dz0 = 1;
      const len = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);
      dx0 /= len; dy0 /= len; dz0 /= len;

      // roll rotation (around z axis, i.e. within the image plane)
      const dx = dx0 * cosRoll - dy0 * sinRoll;
      const dy = dx0 * sinRoll + dy0 * cosRoll;
      const dz = dz0;

      // pitch rotation (around x axis)
      let y2 = dy * cosPitch - dz * sinPitch;
      let z2 = dy * sinPitch + dz * cosPitch;
      let x2 = dx;

      // yaw rotation (around y axis)
      let x3 = x2 * cosYaw + z2 * sinYaw;
      let z3 = -x2 * sinYaw + z2 * cosYaw;
      let y3 = y2;

      const lon = Math.atan2(x3, z3); // -PI..PI
      const lat = Math.asin(Math.max(-1, Math.min(1, y3))); // -PI/2..PI/2

      const u = (lon / (2 * Math.PI) + 0.5) * eqW;
      const v = (lat / Math.PI + 0.5) * eqH;

      const sx = Math.min(eqW - 1, Math.max(0, Math.round(u)));
      const sy = Math.min(eqH - 1, Math.max(0, Math.round(v)));
      const srcIdx = (sy * eqW + sx) * channels;
      const dstIdx = (oy * outW + ox) * 3;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
    }
  }
  return out;
}

function cropView(equirect, heading, pitch, fov, outW, outH, roll = 0) {
  const buf = reproject(equirect, heading, pitch, fov, outW, outH, roll);
  return sharp(buf, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 90 });
}

// NOTE: an automatic tile-seam detector was tried here (yaw=0/180 sit exactly on a tile
// boundary — see renderCarViews — and some panoramas, so far only older/Gen3-era ones, have a
// genuine parallax/exposure mismatch between the two lenses meeting there). Two heuristics
// were tested against known good/bad renders (a raw color-difference-across-the-middle check,
// then a local-gradient-spike check) and neither reliably told them apart — the second one
// even scored a known-bad render LOWER than a known-good one. Reverted rather than ship
// something that fires unpredictably. When one of front/back lands on a bad seam for a given
// panorama, use the other one instead — that's the actual mitigation for now.

export async function renderPanoView(panoId, heading, pitch, { fov = 90, outW = 800, outH = 600, zoom = 3, roll = 0 } = {}) {
  const equirect = await stitchEquirect(panoId, zoom);
  return cropView(equirect, heading, pitch, fov, outW, outH, roll);
}

// Renders both the front (yaw=0) and rear (yaw=180) views in one go, reusing a single tile
// fetch — the Street View car can show either end depending on generation, so callers that
// need to tell them apart should look at both. Pass `roll` (the panorama's true capture roll,
// from pano-meta.mjs) so the car stays centered even when the vehicle was banked/tilted at
// capture time.
//
// IMPORTANT: yaw=0 is the panorama's own forward direction — NOT `headingDeg` from
// pano-meta.mjs. headingDeg is descriptive metadata ("yaw=0 happens to face this compass
// bearing"), not a rotation to apply. Using it as the yaw input double-rotates the view away
// from forward, by exactly headingDeg — confirmed by screenshotting Google's own viewer at
// `heading=X` and finding it matches this code's yaw=0 output, not yaw=X. The visible car
// still often showed up somewhere in the old (buggy) wide-FOV renders since a very close
// object like the hood subtends a large angle, which is how this went unnoticed for a while.
//
// Default pitch/fov (-20°/80°, not the steeper -30°/100° tried earlier) is a deliberate
// compromise: older/lower-quality panoramas can have genuinely blank imagery at the deepest
// nadir (not a bug — Google just never captured it, see hasNadirGap below), and a steeper
// crop reaches far enough down to hit that gap, showing up as a black dome at the bottom of
// the frame (the pole singularity in the perspective projection turns a flat missing-data
// edge into a curved one). -20°/80° stays just above where that gap starts for panoramas
// tested so far, while still framing the hood well on panoramas with full nadir data.
//
// yaw=0/180 sit exactly on a tile boundary, and on older/lower-quality panoramas that
// boundary can be a visibly bad seam (adjacent tiles from different lenses not lining up —
// see the abandoned seam-detector NOTE near cropView). Trying to score the seam itself
// pixel-by-pixel proved unreliable, but panoramas from that same older capture era reliably
// have a detectable side effect: a solid-black gap at the deepest nadir (hasNadirGap). Used
// here as a proxy: when present, both views are nudged off their exact tile boundaries. For
// `front`, -20° was selected after comparing -60/-45/-20/+20/+45/+70°: it keeps the road
// naturally framed without the larger rotation used by -45°. For `back`, -60° (yaw=120,
// not 180) was checked across the same panoramas and consistently showed a clean,
// well-composed hood shot, unlike smaller offsets (25°) or other candidates (45°/90°),
// which still hit visible seams on some of them. Gen4 panoramas (no gap) are unaffected.
const NADIR_GAP_FRONT_YAW_OFFSET = -20;
const NADIR_GAP_BACK_YAW_OFFSET = -60;

export async function renderCarViews(panoId, { pitch = -20, fov = 80, outW = 900, outH = 700, zoom = 3, roll = 0 } = {}) {
  const equirect = await stitchEquirect(panoId, zoom);
  const hasGap = hasNadirGap(equirect);
  const frontYaw = hasGap ? NADIR_GAP_FRONT_YAW_OFFSET : 0;
  const backYaw = 180 + (hasGap ? NADIR_GAP_BACK_YAW_OFFSET : 0);
  return {
    front: cropView(equirect, frontYaw, pitch, fov, outW, outH, roll),
    back: cropView(equirect, backYaw, pitch, fov, outW, outH, roll),
  };
}

// Renders an arbitrary set of named views from a single tile fetch. Each view is
// { name, heading, pitch, fov, roll? }; heading is absolute degrees (not relative to headingDeg).
export async function renderViews(panoId, views, { outW = 900, outH = 700, zoom = 3 } = {}) {
  const equirect = await stitchEquirect(panoId, zoom);
  const out = {};
  for (const v of views) {
    const buf = reproject(equirect, v.heading, v.pitch, v.fov, outW, outH, v.roll ?? 0);
    out[v.name] = sharp(buf, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 90 });
  }
  return out;
}

// Matches reproject()'s center-ray math: for pitch p (looking down when negative), the
// sampled latitude works out to -p, not +p (the pitch rotation flips the sign). Deriving a
// row directly from pitch must use the same convention or the band ends up upside down.
function pitchToRow(pitchDeg, eqH) {
  const lat = (-pitchDeg * Math.PI) / 180;
  return Math.round((lat / Math.PI + 0.5) * eqH);
}

// Older/lower-quality panoramas often have no imagery at all at the deepest nadir (Google
// just never captured directly beneath the vehicle) — a solid black region visible in the
// raw tiles, confirmed by inspecting them directly. Unlike the tile-seam mismatch (tried and
// abandoned — see the NOTE near cropView), this is trivial to detect reliably: sample pixels
// in the deep-nadir band and check how many are pure black. Used as a proxy for "this
// panorama is old/Gen3-tier capture quality" — that same lower-quality capture era is where
// the seam problem has shown up too, so panoramas with this gap get a small yaw nudge on
// front/back to move off the exactly-on-a-tile-boundary position (see renderCarViews).
export function hasNadirGap(equirect) {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const rowStart = Math.min(pitchToRow(-70, eqH), pitchToRow(-89, eqH));
  const rowEnd = Math.max(pitchToRow(-70, eqH), pitchToRow(-89, eqH));
  let black = 0, total = 0;
  for (let y = rowStart; y < rowEnd; y += 4) {
    for (let x = 0; x < eqW; x += 8) {
      const idx = (y * eqW + x) * channels;
      if (data[idx] < 10 && data[idx + 1] < 10 && data[idx + 2] < 10) black++;
      total++;
    }
  }
  return total > 0 && black / total > 0.3;
}

// Crops a full 360°-wide horizontal band out of the raw equirectangular panorama, covering
// every heading at once between pitchTop and pitchBottom (degrees). Unlike renderPanoView's
// perspective reprojection, this needs no heading/pitch/roll guessing at all — wherever the
// Street View car actually sits (its exact heading varies by generation and isn't reliably
// recoverable from metadata), it's guaranteed to be somewhere in a band that spans the whole
// circle. The equirectangular projection is also already gravity-leveled by Google, so no
// roll correction is needed either.
function cropBand(equirect, { pitchTop = -5, pitchBottom = -90, outW = 1600, outH = 300 } = {}) {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const rowA = pitchToRow(pitchTop, eqH);
  const rowB = pitchToRow(pitchBottom, eqH);
  const top = Math.max(0, Math.min(rowA, rowB));
  const bottom = Math.min(eqH, Math.max(rowA, rowB));
  const bandBuf = Buffer.from(data.buffer, data.byteOffset + top * eqW * channels, (bottom - top) * eqW * channels);
  return sharp(bandBuf, { raw: { width: eqW, height: bottom - top, channels } })
    .resize(outW, outH)
    .jpeg({ quality: 90 });
}

export async function renderBand(panoId, opts = {}) {
  const equirect = await stitchEquirect(panoId, opts.zoom ?? 3);
  return cropBand(equirect, opts);
}

// Crops the "© YYYY Google" watermark that Google bakes into every panorama's tiles. This
// watermark year is NOT the same as the capture date (panoDate/extra.panoDate) — it reflects
// whenever the imagery was last (re)processed, which can be a later year — and it's also NOT
// the same as the year in the photometa "copyright" field (see pano-meta.mjs), which always
// just reports the current date and carries no real per-panorama information.
//
// The watermark is tiled at a fixed *relative* position in the equirectangular canvas
// regardless of scene content, so a single fixed crop (found empirically against a zoom=2
// stitch, as a fraction of the 2048x1024 canvas) reliably lands on a legible instance for any
// panorama — scaled proportionally in case stitchEquirect had to fall back to a lower zoom
// (older panoramas without zoom=2 tiles available). It's small and low-contrast enough that
// free OCR (tried: tesseract, EasyOCR) fails to read it reliably, so this is meant to be read
// visually (the same way car color/generation are) rather than parsed automatically.
function cropWatermark(equirect, { outW = 180 * 8, outH = 50 * 8 } = {}) {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const left = Math.round((140 / 2048) * eqW);
  const top = Math.round((75 / 1024) * eqH);
  const width = Math.round((180 / 2048) * eqW);
  const height = Math.round((50 / 1024) * eqH);
  return sharp(data, { raw: { width: eqW, height: eqH, channels } })
    .extract({ left, top, width, height })
    .resize(outW, outH, { kernel: "lanczos3" })
    .jpeg({ quality: 95 });
}

export async function renderWatermarkCrop(panoId, opts = {}) {
  // zoom=2 has enough resolution for a legible watermark and is far cheaper than zoom=3
  // (8 tiles vs. 32) when this is called on its own rather than via renderLocationBundle.
  const equirect = await stitchEquirect(panoId, 2);
  return cropWatermark(equirect, opts);
}

// Downsamples the full equirectangular panorama (all 360° x full vertical range) to a
// manageable thumbnail — useful as an at-a-glance overview alongside renderBand crops.
export async function renderOverview(panoId, { outW = 1200, outH = 600, zoom = 3 } = {}) {
  const equirect = await stitchEquirect(panoId, zoom);
  const { data, width: eqW, height: eqH, channels } = equirect;
  return sharp(data, { raw: { width: eqW, height: eqH, channels } })
    .resize(outW, outH)
    .jpeg({ quality: 90 });
}

// Renders the full standard set from a single tile fetch — the usual entry point for bulk
// processing, since it avoids re-stitching the same panorama multiple times over (each
// renderCarViews/renderBand/renderWatermarkCrop call otherwise fetches its own equirect
// independently).
//
// front/back (perspective crops at yaw 0°/180° — the panorama's own forward/backward, NOT
// `headingDeg`; see renderCarViews) are the PRIMARY images: the car reads as a normal,
// recognizable hood shape here, the way it looks in the real Street View viewer.
//
// `ground` (the full 360° nadir band) is kept only as a FALLBACK reference for the rare case
// neither front nor back shows the car — earlier attempts made this the primary image, but
// the equirectangular warp turns the car into a hard-to-read curved streak, and older/lower-
// quality panoramas can have genuinely blank (not buggy — Google just never captured it)
// imagery at the deepest nadir, which shows up as a black gap in the band.
export async function renderLocationBundle(panoId, { zoom = 3, pitch = -20, fov = 80 } = {}) {
  const equirect = await stitchEquirect(panoId, zoom);
  const hasGap = hasNadirGap(equirect);
  const frontYaw = hasGap ? NADIR_GAP_FRONT_YAW_OFFSET : 0;
  const backYaw = 180 + (hasGap ? NADIR_GAP_BACK_YAW_OFFSET : 0);
  return {
    front: cropView(equirect, frontYaw, pitch, fov, 900, 700, 0),
    back: cropView(equirect, backYaw, pitch, fov, 900, 700, 0),
    ground: cropBand(equirect, { pitchTop: -5, pitchBottom: -90, outW: 1800, outH: 340 }),
    sky: cropBand(equirect, { pitchTop: 60, pitchBottom: 0, outW: 1800, outH: 300 }),
    watermark: cropWatermark(equirect),
  };
}

// CLI: node render-pano.mjs <panoId> <outFile>
// Renders the view where the Street View car's hood is typically visible (yaw=0, the
// panorama's own forward direction — see renderCarViews for why this is NOT headingDeg).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , panoId, outFile] = process.argv;
  const img = await renderPanoView(panoId, 0, -20, { fov: 80, outW: 900, outH: 700, zoom: 3 });
  await img.toFile(outFile);
  console.log(`saved ${outFile}`);
}
