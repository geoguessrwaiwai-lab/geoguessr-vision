# GeoGuessr Vision

[Vali](https://github.com/geoguessrwaiwai-lab/Vali)などで生成済みの地点JSON(`extra.tags`を持つ形式)に対して、Street Viewの見え方から**カメラ世代・著作権年・車体色**を判定し、タグ付けしたJSONを保存するためのコンピュータビジョン・機械学習ツールです。

GoogleのAPIキーは一切不要で、ノーコストで実行できます。

## セットアップ

```bash
git clone https://github.com/geoguessrwaiwai-lab/geoguessr-vision.git
cd geoguessr-vision
npm install
```

全スクリプトはTypeScriptで書かれており、[tsx](https://github.com/privatenumber/tsx)でビルドなしに直接実行します(`npx tsx foo.ts`、`node foo.ts`ではない点に注意)。型エラーの確認は`npm run typecheck`で行えます。

## 構成

| ファイル/フォルダ        | 用途                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `pb-url.ts`             | Google内部エンドポイント用の擬似protobuf URLエンコーダ(内部モジュール)                    |
| `pano-meta.ts`          | パノラマのメタデータ(緯度経度からのパノラマ検索・真の進行方向/roll等)取得(内部モジュール) |
| `render-pano.ts`        | パノラマタイルの合成・レンダリング(内部モジュール、詳細は下記)                            |
| `concurrency.ts`        | 地点を並列処理するための小さなワーカープール(内部モジュール)                              |
| `capture-locations.ts`  | 地点JSON一括処理。各地点のground/sky帯+透かしクロップをレンダリング + manifest出力        |
| `apply-tags.ts`         | タグ付け結果を`extra.tags`にマージして保存                                                |
| `tag-watermark-year.ts` | 透かしの年号をOCRで自動タグ付け(Gen4のみ、読み取れない場合は`©unclear`、下記参照)         |
| `tag-shitcam.ts`        | 既知の国・撮影日の組み合わせからShitcamを自動タグ付け(画像判定不要、下記参照)             |
| `label-tool/`            | 世代・車体色・著作権年をラベリングするローカルWebツール                                   |
| `models/`(gitignore対象) | 学習済みモデルの出力先                                                                    |

## レンダリング方式: front/back(透視図)がメイン、360°帯は保険

- `front`/`back`(基準は真の進行方向とその180°反対、pitch -20°): 車のボンネットが自然な形で写る、メインで確認する画像。Googleメタデータの`ResolutionHeight`が8192ではない画像では、タイル境界を避けるためfrontを-20°、backを-60°ずらす。Gen3/Gen4側の切り替えに画像下部の黒領域は使用しない
- `ground`帯(pitch -5°〜-90°、フォールバック): front/backどちらにも車が見当たらない場合の保険。車が写る可能性のある領域をヘディング問わず丸ごと含む
- `sky`帯(pitch 0°〜60°): 太陽・ハレーション・空の色など、Gen1/Gen2判定や全体の鮮明さ確認に使う領域を丸ごと含む(`capture-locations.ts`では現在未使用、ラベリングツールでは過去に使用)

内部的には`renderLocationBundle()`が1回のタイル取得からfront/back/ground/watermarkを全部切り出します。

`ResolutionHeight`による世代区分は次の共通定義を使用します(`pano-meta.ts`の`classifyResolutionHeight`)。定義外の値は`Unknown`とし、推測では分類しません。

| ResolutionHeight | 区分                                                          |
| ---------------- | ------------------------------------------------------------- |
| `1664`以下       | `Gen1`                                                        |
| `8192`           | `Gen4` / `Smallcam`(同じ解像度で、両者の区別は画像を見て行う) |
| `6656`           | `Gen2 / Gen3 / Shitcam`(これらは解像度だけでは区別できない)   |

`6656`の3パターン(Gen2 / Gen3 / Shitcam)を画像なしで区別する部分的な手段として`tag-shitcam.ts`があります(下記参照)。ただしこれは既知の国・撮影日の組み合わせだけを機械的に拾う手法で、Shitcamを網羅的に検出するものではありません(未収録の国・期間のShitcamは見逃します、意図的に許容している false negative)。それ以外(Gen2とGen3の区別、未収録のShitcamの検出)は今後実装予定で、現状は未実装です(保留)。

## タグ付けの方針

`extra.tags`に付けるタグは、地点のカメラ世代に応じて次の5種類だけです。`apply-tags.ts`(手動/Claudeレビュー)・`tag-watermark-year.ts`・`label-tool`は、すべて同じ文字列語彙を使います(学習ラベルの各フィールド`gen`/`color`/`copyrightYear`は、そのままタグ文字列として書き出せる形で保存されています)。

`Smallcam`は`Gen4`と対等な独立した世代として扱います(`Gen4`の特徴・派生ではありません)。解像度は`Gen4`と同じ8192pxですが、車体・アンテナ等の見た目が異なる別カテゴリとして画像から判定します。

| #   | 条件                                 | タグ                   | 例                                                             |
| --- | ------------------------------------ | ---------------------- | -------------------------------------------------------------- |
| 1   | 常に                                 | カメラ世代(単体)       | `Gen1`, `Gen4`, `Smallcam`, `Shitcam`, `Gen2 / Gen3 / Shitcam` |
| 2   | Gen4またはSmallcamの地点だけ         | 透かしの著作権年(単体) | `©2023`, `©unclear`                                            |
| 3   | Gen4の地点だけ(Smallcamを除く)       | 車体色(単体)           | `Blue`, `Black`                                                |
| 4   | Gen4で著作権年が判明した地点だけ     | 車体色+著作権年        | `Blue 2023`                                                    |
| 5   | Smallcamで著作権年が判明した地点だけ | `Smallcam`+著作権年    | `Smallcam 2026`                                                |

補足:

- **世代の判別だけで十分な地点(Gen1/Gen2/Gen3/Shitcam/Smallcam)は車体色を判定しない**。Gen1/Gen2/Gen3/Shitcamは画質が不鮮明で車体色の学習精度が低く判定難度が高いため、Smallcamはそもそも車体がほとんど写らないため。いずれも世代タグ1つだけを付ける(Gen4だけが例外的に車体色を持つ)
- 透かしの著作権年は**全ての世代で常に抽出を試みる**(`tag-watermark-year.ts`のOCRは世代を問わず毎回実行される)。ただし単体タグとして`extra.tags`に書き込むのはGen4/Smallcamの地点のみ。理由は精度: 透かしの位置は世代によって差があり(古い撮影は上空付近に1箇所、新しい撮影は路面付近に複数箇所など)、Gen4/Smallcam以外への対応(クロップ位置の世代別最適化)は今後の改善候補として保留中
- 透かしの年号が読み取れない(目視でも不鮮明)場合は`©unclear`とし、タグ自体を省略しない
- 「車体色/Smallcam + 著作権年」の組み合わせタグ(表4・5)は、著作権年が判明している場合のみ付ける。`©unclear`の場合は組み合わせタグを作らず、単体の色/Smallcamタグと`©unclear`タグだけを付ける

## 使い方1: 車の色などを判定してJSONにタグ付けする(半自動)

`tag-watermark-year.ts`は地点の世代タグ(`Gen4`/`Smallcam`)がすでに付いているかどうかで著作権年タグを書き込むか判断するため、**世代タグを先に確定させてから**実行する必要があります。

```bash
npx tsx tag-shitcam.ts input.json step0.json
npx tsx capture-locations.ts step0.json ./renders --only-untagged
# → renders/*-front.jpg, *-back.jpg, *-ground.jpg(保険), *-watermark.jpg をClaude Codeなどに読ませ、
#   上記「タグ付けの方針」に沿って世代・車体色のtags.jsonを作らせる
npx tsx apply-tags.ts step0.json tags.json step1.json

npx tsx tag-watermark-year.ts step1.json output.json --only-untagged
```

`extra.tags`に重複なくマージされます(panoIdの突合チェック付き)。詳細は各スクリプトの冒頭コメント参照。

透かしの著作権年は、[igs](https://github.com/iggedi-ig-ig)氏の[copyright-labeller](https://github.com/iggedi-ig-ig/copyright-labeller)(著作権OCRツール、~2/3のカバー率・~95%の正解率とのこと)と同じ技術方針(OCRの認識文字種を透かしが取りうる文字だけに絞り、1回のOCR結果を鵜呑みにせず複数の検出が一致した場合だけ採用する)を採用した`tag-watermark-year.ts`で自動タグ付けします。

- 認識文字種を`0-9`・`Google`・スペースのみに制限(小さく低コントラストな文字に対する誤認識の大半はここで削れる)
- 同じ切り出し画像に対しTesseractのページ分割モードを変えて2回OCRし、両方が同じ年で一致した場合のみ採用
- 一致しなかった/年号が全く読めなかった場合は、黙ってスキップせず`©unclear`タグを付けて目視レビューに回す(ただしタグを書き込むのはGen4/Smallcamの地点のみ。上記「タグ付けの方針」参照)

## 使い方2: Gen1-4 / 色の学習データを集める

学習データ用のpanoId候補プール(`candidates.json`)は[Vali](https://github.com/geoguessrwaiwai-lab/Vali)側で生成します。このリポジトリでは生成しません。`candidates.json`は`{ lat, lon, panoId, headingDeg, date, sourceFile }`の配列で、Valiが出力したものをそのまま`label-tool/`に渡します。

```bash
cd label-tool
npx tsx capture-for-labeling.ts /path/to/vali-output/candidates.json ./data
npx tsx server.ts ./data
# → http://localhost:4173 でラベリング
```

既知のGen3地域（ウクライナ、韓国、レソト、エスワティニ、ブータン、ボリビア、ウルグアイ）など、世代があらかじめ分かっているバッチを別途追加する場合も、Vali側で該当する`candidates.json`を生成した上で`--append --preset-gen=Gen3`を付けて取り込みます:

```bash
cd label-tool
npx tsx capture-for-labeling.ts /path/to/vali-output/gen3-country-candidates.json ./data --append --preset-gen=Gen3
```

Gen3トレッカー(Googleメタデータの`scout`フラグが立った地点)の除外はVali側の候補生成時に行われます。
既知の世代は`labels.json`へGen3として設定されます。車体色は画像レビュー時に追記できます。

ラベリングツールは各地点について **Front/Back(真の進行方向とその180°反対、メイン)**、**Ground(360°帯、フォールバック)**、著作権年を読むための**Watermark**を表示します。

ラベル構造(「タグ付けの方針」と対応、`label-tool/server.ts`の`COLOR_GENS`参照):

- 世代は`Gen1` / `Gen2` / `Gen3` / `Gen4` / `Smallcam` / `Shitcam`。`Smallcam`は`Gen4`と対等な独立した世代で、車体を判定するための特徴フラグではない
- 透かしの著作権年は**全世代で必須**(2009年から現在年までの整数、または`©unclear`)。抽出精度の改善は世代によらず常に試みる方針のため、Gen4/Smallcam以外でもラベルを集める
- 車体・ブラーの見え方(`front` / `back` / `both` / `neither`)と車体色は**Gen4のみ**で収集する。Gen1/Gen2/Gen3/Smallcam/Shitcamは世代が決まった時点で完了
- Gen4で`neither`の場合は色を記録しない。それ以外は車体色を選択

キーボード操作: `1-6`=世代、`F/B/O/N`=車体・ブラーの見え方(Gen4のみ)、`Enter`=保存して次へ、`S`=スキップ、`X`=棄却、`←→`=移動。

旧形式のラベルを移行し、棄却済み地点をデータセットから取り除く場合:

```bash
npx tsx label-tool/migrate-label-format.ts label-tool/data label-tool/candidates.json label-tool/gen3-country-candidates.json
```

進捗は`label-tool/data/labels.json`に自動保存され、閉じても再開可能です。

## 学習方針

front単体・back単体では判断がつきにくいため、**FrontとBackを1組の入力として扱う2分岐モデル**で学習する方針です。Smallcamは`Gen4`と対等な独立した世代クラスとして扱います。

```
front.jpg ──▶ [CNN backbone] ──▶ 特徴ベクトルA ─┐
               (重み共有)                        ├─▶ 結合 ──▶ MLP ──▶ 世代・色
back.jpg  ──▶ [CNN backbone] ──▶ 特徴ベクトルB ─┘
```

学習済みモデルは`models/`にONNX形式で出力し、Claude/Codexなど特定のAIツールに依存せず、Node.js側から`onnxruntime-node`経由で直接呼び出せるようにします(推論にAPI課金・ネットワーク通信は不要)。
