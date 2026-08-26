import sharp from "sharp";
import type { Sharp, Channels } from "sharp";
import { classifyResolutionHeight, getPanoMeta, RESOLUTION_CLASS } from "./pano-meta.ts";
import { isMainModule } from "./shared/is-main-module.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// 上のUAはpb-url.tsのUAと役割は同じ(Googleの内部エンドポイントに対してブラウザに
// 見せかけるため)だが、叩いている先(タイルCDN vs. photometa API)が異なり、それぞれ
// 個別に動作確認した経緯があるため、意図的に統合せずそのまま維持する。

async function fetchTile(panoId: string, x: number, y: number, zoom: number): Promise<Buffer> {
  const url = `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid=${panoId}&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fir=0`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`tile ${x},${y} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** stitchEquirectが返す、タイルを1枚に合成した生ピクセルデータ。 */
export interface Equirect {
  data: Buffer;
  width: number;
  height: number;
  channels: Channels;
}

// 指定したzoomレベル(0-5)で全天球のequirectangular(正距円筒図法)パノラマを合成する。
// zoom=3 -> 4096x2048(8x4タイル)。
//
// 古い/長らく再処理されていないパノラマは、より高いzoomレベルのタイルが存在しないことが
// 多く(特定のタイル — よくあるのは右端の列 — だけ400エラーになり、他は成功する)、
// そのためタイル取得が1枚でも失敗したら自動的に1段階低いzoomで再試行する
// (必要ならzoom=0まで下がる)。全体を丸ごと失敗させるよりも粘り強い挙動にしている。
export async function stitchEquirect(panoId: string, zoom = 3): Promise<Equirect> {
  const tilesX = 2 ** zoom;
  const tilesY = Math.ceil(tilesX / 2);
  const tileSize = 512;
  let composites: { input: Buffer; left: number; top: number }[];
  try {
    // 1枚ずつ順番にではなく、全タイルを並列で取得する — zoom=3では32回の逐次
    // ラウンドトリップ(数秒かかる)になるところを、1回の並列バッチで済ませられる。
    const coords: [number, number][] = [];
    for (let y = 0; y < tilesY; y++) for (let x = 0; x < tilesX; x++) coords.push([x, y]);
    const buffers = await Promise.all(coords.map(([x, y]) => fetchTile(panoId, x, y, zoom)));
    composites = coords.map(([x, y], i) => ({
      input: buffers[i],
      left: x * tileSize,
      top: y * tileSize,
    }));
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
  // sharpのOutputInfo型はchannelsを素のnumberとして返すが、実際の値は常に1〜4なので
  // Channels型へキャストする(sharpのraw()入力APIがChannels型を要求するため)。
  return { data, width: info.width, height: info.height, channels: info.channels as Channels };
}

// 注記: タイルの継ぎ目をクロスフェードで馴染ませる処理を試したが取りやめた —
// 隣接タイルは異なるカメラレンズ/露出由来であることがあり、稀に境界が視認できるほど
// ずれることがあるが、この手法は問題の有無に関わらずequirect全体の全タイル境界に
// 帯を入れてしまい、本来問題のない画像にまでソフトフォーカスの縞を持ち込んでしまった。
// レンズ間の実際の視差/露出ミスマッチは単純なクロスフェードでは直せない(確認済み:
// クロップのyawをずらして悪い継ぎ目を中心からずらしても改善しなかった — 色だけでなく
// 内容そのものが噛み合っていないため)。あるパノラマでfront/backのどちらかが悪い継ぎ目に
// 当たった場合は、もう片方を使うのが実際の回避策。

// equirect -> 透視投影ビューへの変換(heading: 0-360度、pitch: -90..90度、fovは度単位)。
// `roll`(度単位)はpitch/yawを適用する前に仮想カメラをその前方軸周りに回転させる —
// パノラマの実際の撮影roll(pano-meta.ts参照)を渡すことで、撮影時に車体が傾いていた
// (カントの付いた/傾斜した路面など)場合でも、描画されるビューが車体(ひいてはボンネット)に
// 対して水平を保つ。roll=0固定のビューだと、ボンネットが片側に寄ったりフレーム外に
// はみ出したりすることがある。
function reproject(
  equirect: Equirect,
  heading: number,
  pitch: number,
  fov: number,
  outW: number,
  outH: number,
  roll = 0,
): Buffer {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const out = Buffer.alloc(outW * outH * 3);
  const yaw0 = (heading * Math.PI) / 180;
  const pitch0 = (pitch * Math.PI) / 180;
  const roll0 = (roll * Math.PI) / 180;
  const fovRad = (fov * Math.PI) / 180;
  const focal = (0.5 * outW) / Math.tan(fovRad / 2);

  // 回転行列: まずZ軸(前方)周りにroll、次にX軸周りにpitch、最後にY軸周りにyaw
  const cosYaw = Math.cos(yaw0),
    sinYaw = Math.sin(yaw0);
  const cosPitch = Math.cos(pitch0),
    sinPitch = Math.sin(pitch0);
  const cosRoll = Math.cos(roll0),
    sinRoll = Math.sin(roll0);

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const px = ox - outW / 2;
      const py = oy - outH / 2;
      // カメラ座標系での視線方向(+z方向を見ている)
      let dx0 = px / focal;
      let dy0 = py / focal;
      let dz0 = 1;
      const len = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);
      dx0 /= len;
      dy0 /= len;
      dz0 /= len;

      // roll回転(z軸周り、つまり画像平面内での回転)
      const dx = dx0 * cosRoll - dy0 * sinRoll;
      const dy = dx0 * sinRoll + dy0 * cosRoll;
      const dz = dz0;

      // pitch回転(x軸周り)
      const y2 = dy * cosPitch - dz * sinPitch;
      const z2 = dy * sinPitch + dz * cosPitch;
      const x2 = dx;

      // yaw回転(y軸周り)
      const x3 = x2 * cosYaw + z2 * sinYaw;
      const z3 = -x2 * sinYaw + z2 * cosYaw;
      const y3 = y2;

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

function cropView(
  equirect: Equirect,
  heading: number,
  pitch: number,
  fov: number,
  outW: number,
  outH: number,
  roll = 0,
): Sharp {
  const buf = reproject(equirect, heading, pitch, fov, outW, outH, roll);
  return sharp(buf, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({ quality: 90 });
}

// 注記: yaw=0/180がちょうどタイル境界に乗る(renderCarViews参照)ことに起因する継ぎ目を
// 自動検出する処理を試したが取りやめた。一部のパノラマ(今のところ古い/Gen3世代のもの
// のみ確認)では2つのレンズの間に本物の視差/露出ミスマッチがある。既知の良品/不良品の
// レンダリングに対して2種類のヒューリスティック(中央をまたぐ生の色差チェック、続いて
// 局所的な勾配スパイクのチェック)を試したが、どちらも信頼できる形で判別できず —
// 2つ目のヒューリスティックは既知の不良レンダリングに対して既知の良品より低いスコアを
// 付けてしまうことすらあった。予測不能に発火するものを出荷するよりは取りやめを選んだ。
// 現状の実際の回避策は、front/backのどちらかが悪い継ぎ目に当たった場合はもう片方を
// 使うこと。

export interface RenderPanoViewOptions {
  fov?: number;
  outW?: number;
  outH?: number;
  zoom?: number;
  roll?: number;
}

export async function renderPanoView(
  panoId: string,
  heading: number,
  pitch: number,
  { fov = 90, outW = 800, outH = 600, zoom = 3, roll = 0 }: RenderPanoViewOptions = {},
): Promise<Sharp> {
  const equirect = await stitchEquirect(panoId, zoom);
  return cropView(equirect, heading, pitch, fov, outW, outH, roll);
}

// front(yaw=0)とback(yaw=180)を1回のタイル取得で両方レンダリングする — Street Viewの
// 撮影車は世代によってどちらの端が写るか異なるため、区別が必要な呼び出し元は両方を
// 見るべき。`roll`(pano-meta.tsから得られるパノラマの実際の撮影roll)を渡すことで、
// 撮影時に車体が傾いていても中央に写るようにする。
//
// 重要: yaw=0はパノラマ自身の前方方向であり、pano-meta.tsの`headingDeg`ではない。
// headingDegは記述的なメタデータ(「yaw=0はたまたまこのコンパス方位を向いている」)で
// あって、適用すべき回転量ではない。yaw入力としてheadingDegを使うと、前方からちょうど
// headingDeg分だけ余分に二重回転してしまう — Googleの公式ビューアを`heading=X`で
// スクリーンショットし、それがこのコードのyaw=Xではなくyaw=0の出力と一致することを
// 確認して判明した。旧来の(バグのある)広FOVレンダリングでも車自体は写り込むことが
// 多かった(ボンネットのような近い物体は大きな角度を占めるため)ので、これがしばらく
// 気づかれずにいた。
//
// デフォルトのpitch/fov(-20°/80°。以前試した、より深い-30°/100°ではない)は意図的な
// 妥協点: 古い/低品質なパノラマは最も深い鉛直下方(nadir)の画像データが実際に欠けている
// ことがあり(バグではなく、Googleが単に撮影していないだけ)、より深いクロップだと
// この欠落部分に達してしまい、フレーム下部に黒いドーム状の欠落として現れる
// (透視投影の極特異点が、平坦な欠損データの端を曲がった線に変えてしまう)。-20°/80°は、
// これまで確認したパノラマにおいてこの欠落が始まる直前にとどまりつつ、鉛直下方データが
// 揃っているパノラマではボンネットをうまくフレーミングできる。
//
// yaw=0/180はちょうどタイル境界に乗るため、古い/低品質なパノラマではその境界が目に見える
// 悪い継ぎ目になることがある(異なるレンズ由来の隣接タイルが噛み合っていない —
// cropView近くの取りやめた継ぎ目検出器の注記を参照)。継ぎ目そのものをピクセル単位で
// スコアリングしようとしたが信頼できなかった。代わりにGoogleのメタデータの
// ResolutionHeightを使う: 8192pxパノラマはGen4級、6656pxパノラマはGen3/Gen2/Shitcamと
// 識別される。低解像度のビューは正確なタイル境界からずらす。`front`については、
// -60/-45/-20/+20/+45/+70°を比較した結果-20°を採用した — -45°のようなより大きな回転を
// 使わずに道路を自然にフレーミングできる。`back`については、同じパノラマ群に対して
// -60°(yaw=120、180ではない)を確認し、25°のような小さいオフセットや他の候補
// (45°/90°)が一部のパノラマで依然として目に見える継ぎ目に当たったのに対し、一貫して
// 綺麗に構図の整ったボンネットショットを示した。8192px Gen4級パノラマはこの影響を
// 受けない。
const LOW_RES_FRONT_YAW_OFFSET = -20;
const LOW_RES_BACK_YAW_OFFSET = -60;

function isLowResolutionPanorama(resolutionHeight: number): boolean {
  return classifyResolutionHeight(resolutionHeight) !== RESOLUTION_CLASS.GEN4;
}

async function resolveResolutionHeight(
  panoId: string,
  resolutionHeight: number | null | undefined,
): Promise<number> {
  if (Number.isFinite(resolutionHeight)) return resolutionHeight as number;
  const meta = await getPanoMeta(panoId);
  if (!Number.isFinite(meta.resolutionHeight)) {
    throw new Error(`resolutionHeight is unavailable for panorama ${panoId}`);
  }
  return meta.resolutionHeight as number;
}

/**
 * 低解像度(Gen4未満)のパノラマではfront/backのyawをタイル境界からずらし、Gen4級では
 * ちょうど前方/後方(0°/180°)のままにする。renderCarViewsとrenderLocationBundleの両方で
 * 全く同じ6行が重複していたため、ここに抽出した。
 */
function resolveCarViewYaws(resolutionHeight: number): { frontYaw: number; backYaw: number } {
  const isLowResolution = isLowResolutionPanorama(resolutionHeight);
  return {
    frontYaw: isLowResolution ? LOW_RES_FRONT_YAW_OFFSET : 0,
    backYaw: 180 + (isLowResolution ? LOW_RES_BACK_YAW_OFFSET : 0),
  };
}

export interface CarViewOptions {
  pitch?: number;
  fov?: number;
  outW?: number;
  outH?: number;
  zoom?: number;
  roll?: number;
  resolutionHeight?: number | null;
}

export interface CarViewResult {
  front: Sharp;
  back: Sharp;
  resolutionHeight: number;
  resolutionClass: string;
}

export async function renderCarViews(
  panoId: string,
  { pitch = -20, fov = 80, outW = 900, outH = 700, zoom = 3, roll = 0, resolutionHeight }: CarViewOptions = {},
): Promise<CarViewResult> {
  const [equirect, resolvedHeight] = await Promise.all([
    stitchEquirect(panoId, zoom),
    resolveResolutionHeight(panoId, resolutionHeight),
  ]);
  const resolutionClass = classifyResolutionHeight(resolvedHeight);
  const { frontYaw, backYaw } = resolveCarViewYaws(resolvedHeight);
  return {
    front: cropView(equirect, frontYaw, pitch, fov, outW, outH, roll),
    back: cropView(equirect, backYaw, pitch, fov, outW, outH, roll),
    resolutionHeight: resolvedHeight,
    resolutionClass,
  };
}

/** renderViewsに渡す1ビュー分の指定。headingは絶対角度(headingDeg相対ではない)。 */
export interface RenderView {
  name: string;
  heading: number;
  pitch: number;
  fov: number;
  roll?: number;
}

export interface RenderViewsOptions {
  outW?: number;
  outH?: number;
  zoom?: number;
}

// 1回のタイル取得から任意個数の名前付きビューをレンダリングする。
export async function renderViews(
  panoId: string,
  views: RenderView[],
  { outW = 900, outH = 700, zoom = 3 }: RenderViewsOptions = {},
): Promise<Record<string, Sharp>> {
  const equirect = await stitchEquirect(panoId, zoom);
  const out: Record<string, Sharp> = {};
  for (const v of views) {
    const buf = reproject(equirect, v.heading, v.pitch, v.fov, outW, outH, v.roll ?? 0);
    out[v.name] = sharp(buf, { raw: { width: outW, height: outH, channels: 3 } }).jpeg({
      quality: 90,
    });
  }
  return out;
}

// reproject()の中心光線の計算と整合させる必要がある: pitch pに対して(負の値は下向き)、
// サンプリングされる緯度は+pではなく-pになる(pitchの回転で符号が反転するため)。
// pitchから直接行番号を導出する場合も同じ規約を使わないと、帯が上下逆になってしまう。
function pitchToRow(pitchDeg: number, eqH: number): number {
  const lat = (-pitchDeg * Math.PI) / 180;
  return Math.round((lat / Math.PI + 0.5) * eqH);
}

export interface CropBandOptions {
  pitchTop?: number;
  pitchBottom?: number;
  outW?: number;
  outH?: number;
}

// equirectangularの生パノラマから、pitchTopからpitchBottom(度単位)の範囲を全周360度分
// まとめて水平な帯として切り出す。renderPanoViewの透視投影とは異なり、heading/pitch/roll
// を推測する必要が一切ない — Street View撮影車が実際にどこにいるか(その正確なheadingは
// 世代によって異なり、メタデータから確実に復元できない)に関わらず、全周をカバーする帯の
// どこかに必ず写っている。equirectangular投影はGoogleによって既に重力方向に水平補正
// されているため、roll補正も不要。
function cropBand(
  equirect: Equirect,
  { pitchTop = -5, pitchBottom = -90, outW = 1600, outH = 300 }: CropBandOptions = {},
): Sharp {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const rowA = pitchToRow(pitchTop, eqH);
  const rowB = pitchToRow(pitchBottom, eqH);
  const top = Math.max(0, Math.min(rowA, rowB));
  const bottom = Math.min(eqH, Math.max(rowA, rowB));
  const bandBuf = Buffer.from(
    data.buffer,
    data.byteOffset + top * eqW * channels,
    (bottom - top) * eqW * channels,
  );
  return sharp(bandBuf, { raw: { width: eqW, height: bottom - top, channels } })
    .resize(outW, outH)
    .jpeg({ quality: 90 });
}

export interface RenderBandOptions extends CropBandOptions {
  zoom?: number;
}

export async function renderBand(panoId: string, opts: RenderBandOptions = {}): Promise<Sharp> {
  const equirect = await stitchEquirect(panoId, opts.zoom ?? 3);
  return cropBand(equirect, opts);
}

// Googleが全パノラマのタイルに焼き込んでいる「© YYYY Google」の透かしを切り出す。
// この透かしの年は撮影日(panoDate/extra.panoDate)とは別物であり — 画像が最後に
// (再)処理された年を反映しているだけで、それより後の年になりうる。
//
// 透かしの「©」記号は、シーンの内容に関わらずequirectangularキャンバス内の固定の
// *相対*位置から始まる(zoom=2のstitchに対する2048x1024キャンバスの割合として経験的に
// 求めた)。stitchEquirectがより低いzoomにフォールバックした場合(zoom=2のタイルが
// ない古いパノラマ)に備えて、比例的にスケーリングしている。ただし文字列全体の幅は
// 固定ではない — 公式Googleカバレッジは「© YYYY Google」だが、サードパーティの
// トレッカー/行政機関の画像は「© YYYY <機関名>」であり、
// 短いケース用に想定した箱を大きくはみ出して右端で切れることがある。以下のボックスは
// 十分に余裕を持たせてある — 記号の既知の開始位置周辺の左/上マージンと、その先の
// 幅/高さの余裕 — 長い機関名でもクロップ内に完全に収まるように。これによって取り込まれる
// 余分な空/地面の縁は無害(出力は目視確認用に縮小されるだけで、機械的にパースはされない)。
// 小さく低コントラストなため無料OCR(tesseract, EasyOCRを試した)では確実に読み取れず、
// (車体の色/世代と同様に)自動パースではなく目視で読むことを想定している。
function cropWatermark(
  equirect: Equirect,
  { outW = 420 * 4, outH = 90 * 4 }: { outW?: number; outH?: number } = {},
): Sharp {
  const { data, width: eqW, height: eqH, channels } = equirect;
  const left = Math.round((110 / 2048) * eqW);
  const top = Math.round((60 / 1024) * eqH);
  const width = Math.round((420 / 2048) * eqW);
  const height = Math.round((90 / 1024) * eqH);
  return sharp(data, { raw: { width: eqW, height: eqH, channels } })
    .extract({ left, top, width, height })
    .resize(outW, outH, { kernel: "lanczos3" })
    .jpeg({ quality: 95 });
}

export interface RenderWatermarkCropOptions {
  zoom?: number;
  outW?: number;
  outH?: number;
}

export async function renderWatermarkCrop(
  panoId: string,
  { zoom = 2, ...cropOpts }: RenderWatermarkCropOptions = {},
): Promise<Sharp> {
  // zoom=2は透かしを判読するのに十分な解像度があり、単体で(renderLocationBundleを
  // 経由せず)呼ばれる場合はzoom=3(8タイル対32タイル)よりずっと安い。
  // tag-watermark-year.tsは同じパノラマに対して意図的にzoom=2とzoom=3の両方でstitchし、
  // それぞれのOCR結果を突き合わせている。
  const equirect = await stitchEquirect(panoId, zoom);
  return cropWatermark(equirect, cropOpts);
}

export interface RenderOverviewOptions {
  outW?: number;
  outH?: number;
  zoom?: number;
}

// equirectangularパノラマ全体(全周360度x全垂直範囲)を扱いやすいサムネイルに縮小する —
// renderBandのクロップと並べて一目で見渡せる概観として使う。
export async function renderOverview(
  panoId: string,
  { outW = 1200, outH = 600, zoom = 3 }: RenderOverviewOptions = {},
): Promise<Sharp> {
  const equirect = await stitchEquirect(panoId, zoom);
  const { data, width: eqW, height: eqH, channels } = equirect;
  return sharp(data, { raw: { width: eqW, height: eqH, channels } })
    .resize(outW, outH)
    .jpeg({ quality: 90 });
}

export interface LocationBundleOptions {
  zoom?: number;
  pitch?: number;
  fov?: number;
  resolutionHeight?: number | null;
}

export interface LocationBundleResult {
  front: Sharp;
  back: Sharp;
  ground: Sharp;
  sky: Sharp;
  watermark: Sharp;
  resolutionHeight: number;
  resolutionClass: string;
}

// 1回のタイル取得から標準的な一式をレンダリングする — 大量処理での通常の入口。
// renderCarViews/renderBand/renderWatermarkCropをそれぞれ個別に呼ぶと同じパノラマを
// 何度もstitchし直すことになるため、それを避ける。
//
// front/back(yaw 0°/180°での透視投影クロップ — パノラマ自身の前方/後方であり、
// `headingDeg`ではない。renderCarViews参照)がPRIMARYの画像: 車が実際のStreet View
// ビューアで見えるのと同じ、通常の認識しやすいボンネット形状として写る。
//
// `ground`(全周360度の鉛直下方帯)は、front/backのどちらにも車が写らない稀なケースの
// FALLBACK参照としてのみ保持している — 以前はこれをprimaryにしていたが、
// equirectangularの歪みが車を読み取りづらい曲がったスジに変えてしまい、また古い/
// 低品質なパノラマは最も深い鉛直下方に実際に画像データが欠けている(バグではなく、
// Googleが単に撮影していないだけ)ことがあり、帯の中に黒い欠落として現れる。
export async function renderLocationBundle(
  panoId: string,
  { zoom = 3, pitch = -20, fov = 80, resolutionHeight }: LocationBundleOptions = {},
): Promise<LocationBundleResult> {
  const [equirect, resolvedHeight] = await Promise.all([
    stitchEquirect(panoId, zoom),
    resolveResolutionHeight(panoId, resolutionHeight),
  ]);
  const resolutionClass = classifyResolutionHeight(resolvedHeight);
  const { frontYaw, backYaw } = resolveCarViewYaws(resolvedHeight);
  return {
    front: cropView(equirect, frontYaw, pitch, fov, 900, 700, 0),
    back: cropView(equirect, backYaw, pitch, fov, 900, 700, 0),
    ground: cropBand(equirect, { pitchTop: -5, pitchBottom: -90, outW: 1800, outH: 340 }),
    sky: cropBand(equirect, { pitchTop: 60, pitchBottom: 0, outW: 1800, outH: 300 }),
    watermark: cropWatermark(equirect),
    resolutionHeight: resolvedHeight,
    resolutionClass,
  };
}

// CLI: npx tsx render-pano.ts <panoId> <outFile>
// Street Viewの撮影車のボンネットが通常写るビュー(yaw=0、パノラマ自身の前方方向 —
// headingDegではない理由はrenderCarViews参照)をレンダリングする。
if (isMainModule(import.meta.url)) {
  const [, , panoId, outFile] = process.argv;
  const img = await renderPanoView(panoId, 0, -20, { fov: 80, outW: 900, outH: 700, zoom: 3 });
  await img.toFile(outFile);
  console.log(`saved ${outFile}`);
}
