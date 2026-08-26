# GeoGuessr Vision

[Vali](https://github.com/geoguessrwaiwai-lab/Vali)などで生成済みの地点JSON(`extra.tags`を持つ形式)に対して、Street Viewの見え方から**カメラ世代・特徴・車体色**を判定し、タグ付けしたJSONを保存するためのコンピュータビジョン・機械学習ツールです。

GoogleのAPIキーは一切不要です(Street View自体の内部エンドポイントを直接叩いています)。

## セットアップ

```bash
git clone https://github.com/geoguessrwaiwai-lab/geoguessr-vision.git
cd geoguessr-vision
npm install
```

## 構成

| ファイル/フォルダ        | 用途                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `pb-url.mjs`             | Google内部エンドポイント用の擬似protobuf URLエンコーダ(内部モジュール)                    |
| `pano-meta.mjs`          | パノラマのメタデータ(緯度経度からのパノラマ検索・真の進行方向/roll等)取得(内部モジュール) |
| `render-pano.mjs`        | パノラマタイルの合成・レンダリング(内部モジュール、詳細は下記)                            |
| `concurrency.mjs`        | 地点を並列処理するための小さなワーカープール(内部モジュール)                              |
| `capture-locations.mjs`  | 地点JSON一括処理。各地点のground/sky帯+透かしクロップをレンダリング + manifest出力        |
| `apply-tags.mjs`         | タグ付け結果を`extra.tags`にマージして保存                                                |
| `tag-copyright.mjs`      | 著作権(撮影主体)を自動判定してタグ付け(画像判定不要、下記参照)                            |
| `gather-candidates.mjs`  | 学習データ収集用に、既存の`*-locations.json`や海外の代表地点からpanoIdの候補プールを作成  |
| `label-tool/`            | 世代・Smallcam/アンテナ特徴・車体色・著作権年をラベリングするローカルWebツール             |
| `models/`(gitignore対象) | 学習済みモデルの出力先                                                                    |

## レンダリング方式: front/back(透視図)がメイン、360°帯は保険

**経緯(行きつ戻りつしたので記録):**

1. 最初は、パノラマの「真のカメラ進行方向(true heading)」を推定し、そこに向けてpitch/rollを合わせた1枚のクロップ画像を作る方式でした。
2. しかしGen3/Gen4（smallcamを含む）は車体の前後どちらが写るかが世代・特徴で異なり、道路のカント等で「狙った角度」がズレて車がフレーム外になることも多かったため、**特定の方角を推測するのをやめ、正距円筒(equirectangular)画像から仰角(pitch)範囲を360°全周ぶん帯状に切り出す**方式(`renderBand()`)に変更しました。
3. ところがこの帯方式には別の問題がありました: (a) equirect投影の歪みで車が曲がった筋状パターンになり視覚的に解釈しづらい、(b) 古い/低品質なパノラマは**真下(nadir)付近のデータをGoogleが元々持っておらず**(バグではなく、単に未撮影)、車が写るはずの位置が黒塗りになることがある。
4. heading/roll補正が正しくできるようになった今、front/back(`renderCarViews`と同等の透視図)の方が実際のGoogle Mapビューアーで見るのと同じ自然な形で車が写るため、**front/backをメインに戻し、360°帯(`ground`)は前後どちらにも車が写らない場合の保険**として残す構成にしました。

- `front`/`back`(基準は真の進行方向とその180°反対、pitch -20°): 車のボンネットが自然な形で写る、メインで確認する画像。Googleメタデータの`ResolutionHeight`が8192ではない画像では、タイル境界を避けるためfrontを-20°、backを-60°ずらす。Gen3/Gen4側の切り替えに画像下部の黒領域は使用しない
- `ground`帯(pitch -5°〜-90°、フォールバック): front/backどちらにも車が見当たらない場合の保険。車が写る可能性のある領域をヘディング問わず丸ごと含む
- `sky`帯(pitch 0°〜60°): 太陽・ハレーション・空の色など、Gen1/Gen2判定や全体の鮮明さ確認に使う領域を丸ごと含む(`capture-locations.mjs`では現在未使用、ラベリングツールでは過去に使用)

内部的には`renderLocationBundle()`が1回のタイル取得からfront/back/ground/watermarkを全部切り出します。

`ResolutionHeight`による世代区分は次の共通定義を使用します。定義外の値は`Unknown`とし、推測では分類しません。

| ResolutionHeight | 区分 |
| --- | --- |
| `1664`以下 | `Gen1` |
| `8192` | `Gen4` |
| `6656` | `Gen2 / Gen3 / badcam`（解像度だけでは区別しない） |

## パフォーマンス: 大量地点を処理する場合

地点数が多くなると律速するのはレンダリング方式そのものではなく、タイル取得のI/Oでした。以下2点を修正済みです:

1. **タイルの並列取得**: `stitchEquirect`は以前1枚ずつ`await`で逐次取得していました(zoom=3で32枚 = 32回の直列往復)。現在は`Promise.all`で並列取得します。
2. **1地点1スティッチ**: `ground`/`sky`/`watermark`を別々に取得すると同じパノラマを2〜3回re-stitchしてしまうため、`renderLocationBundle()`で1回のタイル取得から3つとも切り出すようにしました。
3. **地点間の並列処理**: `capture-locations.mjs` / `label-tool/capture-for-labeling.mjs` はどちらも`concurrency.mjs`の`mapConcurrent`で地点を並列処理します(デフォルト8、`--concurrency=N`で調整可)。

効果(1地点あたり): 6.27秒 → 0.47秒(**約13倍**)。1000地点なら単純計算で約1.7時間 → 数分程度に短縮される見込みです。Google側の(非公式・無認証)タイルエンドポイントに対する配慮として、並列数はデフォルト8に抑えています。大量処理時にレート制限等が起きた場合は`--concurrency`を下げてください。

## 使い方1: 車の色などを判定してJSONにタグ付けする(半自動)

```bash
node capture-locations.mjs input.json ./renders --only-untagged
# → renders/*-front.jpg, *-back.jpg, *-ground.jpg(保険), *-watermark.jpg をClaude Codeなどに読ませてtags.jsonを作らせる
node apply-tags.mjs input.json tags.json output.json
```

`extra.tags`に重複なくマージされます(panoIdの突合チェック付き)。詳細は各スクリプトの冒頭コメント参照。

## 著作権・年号まわりの3つの似て非なる値

紛らわしいので整理しておきます。

| 値                                | 取得元                                                              | 意味                                                                                       | 自動/目視                     |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| `panoDate`(`extra.panoDate`)      | GeoGuessrのエクスポート                                             | **撮影日**                                                                                 | 既にJSONにある                |
| 著作権の**団体名**(例: `Google`)  | `pano-meta.mjs`の`copyright`フィールド                              | 撮影主体(公式Google車 or 第三者/行政機関)                                                  | `tag-copyright.mjs`で完全自動 |
| 著作権の**年号**(例: `2026`)      | 同じ`copyright`フィールドの年部分                                   | ⚠️**常にリクエストした「今日の年」を返すだけで、パノラマ固有の情報ではない**。使わないこと | —                             |
| 透かしの年号(例: `© 2025 Google`) | 画像タイルに焼き込まれた透かし文字(`renderWatermarkCrop`で切り出し) | そのパノラマが最後に(再)処理された年。**撮影年度とは別物**で、後年に再処理されると変わる   | 目視(下記)                    |

`tag-copyright.mjs`は団体名だけを`extra.tags`に追加し、意味のない年号部分は最初から捨てているので、その点は元々問題ありません。一方で「本当のその地点の透かし年号」が欲しい場合は、`capture-locations.mjs`が出力する`*-watermark.jpg`をレビュー時に一緒に読んでタグ化してください(下記の理由でOCRでの完全自動化は断念しました)。

透かしは小さく低コントラストなため、tesseract・EasyOCRいずれも試しましたが実用的な精度で読み取れませんでした。ただし**equirect画像上の固定ピクセル位置に焼き込まれている**ため(シーン内容に依存しない)、`renderWatermarkCrop()`で同じ座標を切り出すだけで、どのパノラマでも人が読める程度には鮮明な画像が安定して得られます。

## 使い方2: Gen1-4 / 色の学習データを集める

```bash
node gather-candidates.mjs label-tool/candidates.json --source-root=../Vali --per-file=3
cd label-tool
node capture-for-labeling.mjs candidates.json ./data
node server.mjs ./data
# → http://localhost:4173 でラベリング
```

既知のGen3地域（ウクライナ、韓国、レソト、エスワティニ、ブータン、ボリビア、ウルグアイ）だけを別バッチで収集する場合:

```bash
node gather-candidates.mjs label-tool/gen3-country-candidates.json --countries=UA,KR,LS,SZ,BT,BO,UY --radius=500
cd label-tool
node capture-for-labeling.mjs gen3-country-candidates.json ./data --append --preset-gen=Gen3
```

候補検索時にGoogleメタデータの`scout`フラグを確認し、Gen3トレッカーは画像取得前に自動除外します。
既知の世代は`labels.json`へGen3として設定されます。車体色は画像レビュー時に追記できます。

ラベリングツールは各地点について **Front/Back(真の進行方向とその180°反対、メイン)**、**Ground(360°帯、フォールバック)**、著作権年を読むための**Watermark**を表示します。

ラベル構造:

- 世代は`Gen1` / `Gen2` / `Gen3` / `Gen4` / `Shitcam`。Gen1・Gen2・Shitcamは世代だけで完了
- Gen4の任意特徴は`smallcam`。選択時は車体・ブラーの見え方が自動的に`both`となり、色は記録しない
- Gen3の任意特徴は`stubby antenna` / `long antenna` / `short antenna`
- Gen3/Gen4のみ車体・ブラーの見え方を`front` / `back` / `both` / `neither`から選択
- `neither`または`smallcam`の場合は色を記録しない。それ以外は従来どおり車体色を選択
- Gen3/Gen4のみ、透かしの著作権年を2009年から現在年までの整数で選択

キーボード操作: `1-5`=世代、`F/B/O/N`=車体・ブラーの見え方、`Enter`=保存して次へ、`S`=スキップ、`X`=棄却、`←→`=移動。

旧形式のラベルを移行し、棄却済み地点をデータセットから取り除く場合:

```bash
node label-tool/migrate-label-format.mjs label-tool/data label-tool/candidates.json label-tool/gen3-country-candidates.json
```

進捗は`label-tool/data/labels.json`に自動保存され、閉じても再開可能です。

## 学習方針

front単体・back単体では判断がつきにくいため、**FrontとBackを1組の入力として扱う2分岐モデル**で学習する方針です。Smallcamは独立世代ではなくGen4の特徴として扱います。

```
front.jpg ──▶ [CNN backbone] ──▶ 特徴ベクトルA ─┐
               (重み共有)                        ├─▶ 結合 ──▶ MLP ──▶ 世代・特徴・色
back.jpg  ──▶ [CNN backbone] ──▶ 特徴ベクトルB ─┘
```

学習済みモデルは`models/`にONNX形式で出力し、Claude/Codexなど特定のAIツールに依存せず、Node.js側から`onnxruntime-node`経由で直接呼び出せるようにします(推論にAPI課金・ネットワーク通信は不要)。
