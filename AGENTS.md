# AGENTS.md

このリポジトリで作業するAIエージェント向けの技術情報です。ユーザー向けの説明は[README.md](README.md)を参照してください。

## セットアップ・コマンド

```bash
npm install
```

全スクリプトはTypeScriptで書かれており、[tsx](https://github.com/privatenumber/tsx)でビルドなしに直接実行します(`npx tsx foo.ts`、`node foo.ts`ではない点に注意)。型エラーの確認は`npm run typecheck`で行えます。編集後は必ず実行してください。

GoogleのAPIキーは一切不要で、ノーコストで実行できます。

## 構成

| ファイル/フォルダ                             | 用途                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pb-url.ts`                                   | Google内部エンドポイント用の擬似protobuf URLエンコーダ(内部モジュール)                                                                                                                                           |
| `pano-meta.ts`                                | panoIdからパノラマのメタデータ(真の進行方向/roll、解像度、撮影日、国コード等)を取得(内部モジュール)                                                                                                              |
| `render-pano.ts`                              | パノラマタイルの合成・レンダリング(内部モジュール、詳細は下記)                                                                                                                                                   |
| `concurrency.ts`                              | 地点を並列処理するための小さなワーカープール(内部モジュール)                                                                                                                                                     |
| `capture-locations.ts`                        | 地点JSON一括処理。各地点のfront/back+透かしクロップをレンダリング + manifest出力                                                                                                                                 |
| `apply-tags.ts`                               | タグ付け結果を`extra.tags`にマージして保存                                                                                                                                                                       |
| `tag-watermark-year.ts`                       | 透かしの年号をOCRで自動タグ付け(Gen4/Smallcamのみ、読み取れない場合は`©unclear`)                                                                                                                                 |
| `tag-shitcam.ts`                              | 既知の国・撮影日の組み合わせからShitcamを自動タグ付け(画像判定不要)                                                                                                                                              |
| `tag-month.ts`                                | Googleメタデータの撮影日から撮影月(`January`〜`December`)を自動タグ付け(全世代対象、画像判定不要)                                                                                                                |
| `tag-gen2-gen3-by-rule.ts`                    | 撮影年(2009年以前/2013年以降)または国別カメラ世代データ(`shared/camera-gens-by-country.ts`、Gen2/Gen3どちらか一方しか存在しない国)から機械的に決まる地点を自動タグ付け。それでも決まらない地点は未タグのまま残す |
| `tag-gen2-gen3-by-model.ts`                   | `training/gen2-vs-gen3/`で学習した`models/gen2-vs-gen3.onnx`を使い、境界年(2010-2012)など画像ベースの判定が必要な地点をタグ付け(`onnxruntime-node`経由、推論にAPI課金・ネットワーク通信は不要)                   |
| `training/gen2-vs-gen3/`                      | Gen2 vs Gen3モデルの学習コード一式(Python/PyTorch)。詳細は下記「モデル2: Gen2 or Gen3」参照                                                                                                                      |
| `shared/generations.ts`                       | カノニカルな世代語彙(`Gen1`/`Gen2`/`Gen3`/`Gen4`/`Smallcam`/`Shitcam`)と`COLOR_GENS`(車体色収集の対象、現状Gen4のみ)の定義                                                                                       |
| `shared/camera-gens-by-country.ts`            | [geohints.com/meta/cameraGens](https://geohints.com/meta/cameraGens)の「By Country」を基にした、国コード(ISO 3166-1 alpha-2)ごとに存在するカメラ種別の参考データ(Trekkerは対象外)                                |
| `label-tool/pipeline/resolve-locations.ts`    | Valiが出力する生のロケーションJSON(`{lat, lng, heading, extra.tags, panoId}`)を、panoIdごとに`getPanoMeta()`で補完して学習用`candidates.json`形式に変換。デフォルトで`resolutionHeight===6656`のみ残す(下記参照) |
| `label-tool/pipeline/capture-for-labeling.ts` | 候補ごとにfront/back/watermarkをレンダリングし、ラベリングツールが読む`items.json`を生成(`--preset-gen`で既知世代を仮ラベル可)                                                                                   |
| `label-tool/ui/server.ts`                     | 世代・車体色をラベリングするローカルWebツール本体(下記参照)                                                                                                                                                      |
| `label-tool/pipeline/migrate-label-format.ts` | 棄却済み地点(ラベリングUIでXキー)のlabels/items/candidates/imagesからの除去                                                                                                                                      |
| `label-tool/<model-name>/`                    | モデルごとのデータフォルダ(`items.json`/`labels.json`/`images/`/`model.json`)。現在: `gen2-vs-gen3/`, `gen4-smallcam/`                                                                                           |
| `models/`(gitignore対象)                      | 学習済みモデルの出力先                                                                                                                                                                                           |

## レンダリング・世代分類の内部実装

- `render-pano.ts`の`renderLocationBundle()`が1回のタイル取得からfront/back/watermarkを全部切り出す。
- `ResolutionHeight`による世代区分は`pano-meta.ts`の`classifyResolutionHeight`に共通定義がある。定義外の値は`Unknown`とし、推測では分類しない。

| ResolutionHeight | 区分                                                          |
| ---------------- | ------------------------------------------------------------- |
| `1664`以下       | `Gen1`                                                        |
| `8192`           | `Gen4` / `Smallcam`(同じ解像度で、両者の区別は画像を見て行う) |
| `6656`           | `Gen2 / Gen3 / Shitcam`(これらは解像度だけでは区別できない)   |

## タグ・ラベルの語彙統一

`apply-tags.ts`(手動/Claudeレビュー)・`tag-watermark-year.ts`・`label-tool`は、すべて同じ文字列語彙を使う。学習ラベルの各フィールド(`gen`/`color`)は、そのままタグ文字列として書き出せる形で保存する設計。詳細なタグ付け方針の表はREADME参照。

## label-tool: モデルごとのデータフォルダ運用

`label-tool/`はモデル1つにつき1フォルダ(`label-tool/<model-name>/`)を持つ運用。各フォルダは`items.json`(候補メタデータ)・`labels.json`(ラベル本体)・`images/`に加えて、専用の`model.json`を持つ:

```json
{
  "name": "Gen2 vs Gen3",
  "generations": ["Gen2", "Gen3", "Shitcam"],
  "colorGens": [],
  "collectWatermark": false
}
```

`label-tool/ui/server.ts`は起動時に`<dataDir>/model.json`を読み、ラベリングUIの選択肢(世代ボタン・車体色収集の対象・透かし画像の表示有無)をそこから動的に切り替える。`collectWatermark`は`capture-for-labeling.ts`もdataDir/model.jsonから読み、trueの場合のみwatermark.jpgをレンダリング・書き出しする(著作権年はGen4/Smallcamの地点でしか意味を持たないため)。HTML/サーバーのコード自体はモデル間で共有し、フォルダを切り替えるだけでモデルごとの見た目になる(`model.json`が無い古いフォルダは全世代・watermarkありのフォールバックで動く)。複数モデルを扱う場合は`label-tool/<model-a>/`, `label-tool/<model-b>/`のように並べて増やす。現在あるモデル:

| フォルダ                    | `generations`               | `colorGens` | `collectWatermark` |
| --------------------------- | --------------------------- | ----------- | ------------------ |
| `label-tool/gen2-vs-gen3/`  | `Gen2` / `Gen3` / `Shitcam` | (なし)      | `false`            |
| `label-tool/gen4-smallcam/` | `Gen4` / `Smallcam`         | `Gen4`      | `true`             |

候補プールのJSON(`candidates/*.json`)はモデルのデータフォルダの中の`candidates/`サブフォルダに置く(例: `label-tool/gen2-vs-gen3/candidates/au-rural.json`)。まだどのモデル用か決まっていない/resolutionHeightで絞り込んでいない生の候補プールはモデルフォルダの外に置く。

### 候補プールの用意からラベリングまでの手順

学習データ用のpanoId候補プールは[Vali](https://github.com/geoguessrwaiwai-lab/Vali)側で生成する(このリポジトリでは生成しない)。Valiが出力する生のロケーションJSON(`{ lat, lng, heading, extra: { tags }, panoId }`の配列)は、`label-tool/pipeline/resolve-locations.ts`でpanoIdごとの実メタデータ(`headingDeg`/`date`/`resolutionHeight`/`countryCode`/`isScout`)を補って`candidates.json`形式に変換してから`label-tool/`に渡す:

```bash
npx tsx label-tool/pipeline/resolve-locations.ts /path/to/vali-output/xx-locations.json label-tool/<model-name>/candidates/xx.json
```

デフォルトでは`resolutionHeight===6656`(Gen2/Gen3/Shitcamの可能性がある地点)のみに絞り込む。Gen1/Gen4も含めた全世代を集めたい場合は`--all-resolutions`を付ける。

```bash
cd label-tool
npx tsx pipeline/capture-for-labeling.ts <model-name>/candidates/xx.json ./<model-name> --append
npx tsx ui/server.ts ./<model-name>
# → http://localhost:4173 でラベリング
```

既知のGen3地域(ウクライナ、韓国、レソト、エスワティニ、ブータン、ボリビア、ウルグアイ)など、世代があらかじめ分かっているバッチを別途追加する場合は、Vali側で該当するロケーションJSONを生成・`resolve-locations.ts`で変換した上で`--append --preset-gen=Gen3`を付けて取り込む:

```bash
cd label-tool
npx tsx pipeline/capture-for-labeling.ts /path/to/vali-output/gen3-country-candidates.json ./<model-name> --append --preset-gen=Gen3
```

Gen3トレッカー(Googleメタデータの`scout`フラグが立った地点)の除外はVali側の候補生成時に行う。既知の世代は`labels.json`へGen3として設定される。車体色は画像レビュー時に追記できる。

ラベリングツールは各地点について**Front/Back(真の進行方向とその180°反対)**、埋め込みのStreet Viewビューアを表示する。加えて、モデルの`collectWatermark`がtrueの場合のみ著作権年を読むための**Watermark**画像も表示する(現状Gen4/Smallcamモデルのみ)。

ラベル構造(モデルの`model.json`の`generations`/`colorGens`で選択肢を絞る):

- 世代の選択肢はモデルの`model.json`(`generations`)で決まる。カノニカルな語彙は`shared/generations.ts`に集約。`Smallcam`は`Gen4`と対等な独立した世代で、車体を判定するための特徴フラグではない。
- 車体色は、モデルの`colorGens`に含まれる世代のみで収集する(現状Gen4のみを想定)。任意項目で、選ばなくてもラベルは完了扱いになる(車体がfront/backどちらにも写っていない地点もあるため)。
- 著作権年はラベリングツールでは収集しない(`tag-watermark-year.ts`のOCRがGen4/Smallcamの地点に対して別途自動で行う)。

キーボード操作: `1-N`(Nはそのモデルの世代数)=世代、`Enter`=保存して次へ、`S`=スキップ、`X`=棄却、`←→`=移動。

棄却済み地点をデータセットから取り除く場合:

```bash
npx tsx label-tool/pipeline/migrate-label-format.ts label-tool/<model-name> label-tool/<model-name>/candidates/*.json
```

進捗は`label-tool/<model-name>/labels.json`に自動保存され、閉じても再開可能。

## モデル分割方針

`resolutionHeight`だけで既にGen1・Gen4/Smallcam・6656(Gen2/Gen3/Shitcam)の3層に機械的に分離できている(上記表参照)。この分離が既に解けている問題を、Gen1〜Shitcamを一括で扱う1つの多クラスモデルに再学習させるのは、学習信号の希釈(Gen2/Gen3のような画像的に難しいクラスの信号が、resolutionHeightだけで即答できるGen1/Gen4のような簡単なクラスに埋もれる)とデータの無駄遣いにしかならない。そのため、判別が難しいバケットごとに専用のモデルを立てる方針:

- **Gen2 vs Gen3**(現在進行中): `resolutionHeight===6656`の地点専用の2値分類モデル。Shitcamは対象に含めない — `tag-shitcam.ts`で拾いきれない未知のShitcamがGen2/Gen3の学習データに紛れ込む可能性は許容する(意図的なfalse negative、`tag-shitcam.ts`と同じ設計思想)。
- Smallcam vs Gen4(車体色学習と合わせて、将来的に着手予定)。

それぞれのモデルは`label-tool/<model-name>/`という専用のデータフォルダ・`model.json`・(将来的には)`models/<model-name>.onnx`という専用の出力を持つ。

学習済みモデルは`models/`にONNX形式で出力し、Claude/Codexなど特定のAIツールに依存せず、Node.js側から`onnxruntime-node`経由で直接呼び出せるようにする(推論にAPI課金・ネットワーク通信は不要)。

## モデル2: Gen2 or Gen3(実装済み)

`training/gen2-vs-gen3/`にPyTorchの学習コード一式がある(このリポジトリの他スクリプトはTypeScriptだが、事前学習済みCNNバックボーンの転移学習・ONNXエクスポートはPyTorch/torchvisionの方が枯れているため、学習だけPythonで行う方針。推論は上記の通りNode.js側)。

- `prepare_manifest.py`: `label-tool/gen2-vs-gen3/`の`items.json`+`labels.json`から、撮影年×クラスで層化train/val/test分割した`splits.json`を作る(境界年2010-2012がテストに十分残るように)。
- `model.py`: front/back共有のMobileNetV3-Smallバックボーン→特徴ベクトル結合→MLPの2分岐モデル(README「機械学習の方針」の設計そのまま)。
- `dataset.py` / `train.py`: 学習ループ。クラス不均衡(Gen2 269 / Gen3 1003)対策として、層化サンプリングではなくCrossEntropyLossへのclass weightingを採用。検証指標はaccuracyではなくmacro F1。
- `export_onnx.py`: 学習済み`checkpoint.pt`を`models/gen2-vs-gen3.onnx`にエクスポートし、PyTorchとonnxruntimeの出力一致を検証する。

境界年(2010-2012)だけのテストサブセットでもmacro F1 0.977と、標準のfront(yaw0)/back(yaw180)、pitch -20°スキームのままで十分な精度が出ている(2026-08-26に検証)。back方向をpitch違いで2枚見せる案も一時検討したが、未検証のまま先行して設定を入れると学習データと`tag-gen2-gen3-by-model.ts`のレンダリング幾何が食い違うリスクがあるため撤回し、標準スキームに一本化した。

使い方:

```bash
# 学習(必要なら): cd training/gen2-vs-gen3 && python3 prepare_manifest.py && python3 train.py && python3 export_onnx.py
npx tsx tag-gen2-gen3-by-rule.ts step0.json step0b.json --only-untagged
npx tsx tag-gen2-gen3-by-model.ts step0b.json step1.json --only-untagged
```
