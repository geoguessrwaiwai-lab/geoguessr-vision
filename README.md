# GeoGuessr Vision

[Vali](https://github.com/geoguessrwaiwai-lab/Vali)などで生成済みの地点JSON(`extra.tags`を持つ形式)に対して、Street Viewの見え方から**カメラ世代・著作権年・車体色**を判定し、タグ付けしたJSONを保存するためのコンピュータビジョン・機械学習ツールです。

## セットアップ

```bash
git clone https://github.com/geoguessrwaiwai-lab/geoguessr-vision.git
cd geoguessr-vision
npm install
```

## タグ付けの方針

`extra.tags`に付けるタグは、地点のカメラ世代に応じて、以下の6種類だけです。

| #   | 付与する条件                           | タグの意味          | タグの名称例                                          |
| --- | -------------------------------------- | ------------------- | ----------------------------------------------------- |
| 1   | 常に                                   | カメラの世代        | `Gen1`, `Gen2`, `Gen3`, `Gen4`, `Smallcam`, `Shitcam` |
| 2   | 常に                                   | 撮影月              | `January`, ..., `December`                            |
| 3   | Gen4 or Smallcam                       | 透かしの著作権年    | `©2023`, `©unclear`                                   |
| 4   | Gen4                                   | 車体色              | `Blue`, `Black`                                       |
| 5   | Gen4（著作権年が判明した地点だけ）     | 車体色+著作権年     | `Blue 2023`                                           |
| 6   | Smallcam（著作権年が判明した地点だけ） | `Smallcam`+著作権年 | `Smallcam 2026`                                       |

補足:

- 最終的にアウトプットされたJSONの利便性を踏まえ、`Smallcam`は`Gen4`と対等な独立した世代として扱います。
- 撮影月はGoogleメタデータの撮影日から機械的に取得できるため、カメラの世代を問わず全地点で自動タグ付けします。
- Gen4およびSmallcam以外の地点では、車体色および著作権を判定しません。これらの世代のパノラマは画質が不鮮明で学習精度が低く判定難度が高いためです。
- 著作権はOCR（光学文字認識）によって判定しています。曇りの場合など、パノラマから著作権を明瞭に判定できない場合は`©unclear`とします。

## カメラ世代

カメラ世代は以下の方法によって分類を実行します。

### ResolutionHeight

Googleのストリートビューのメタデータから得られる`ResolutionHeight`(解像度)を用いると、以下のように大まかにカメラ世代を区分できます。

| ResolutionHeight | 区分                    |
| ---------------- | ----------------------- |
| `1664`以下       | `Gen1`                  |
| `8192`           | `Gen4` / `Smallcam`     |
| `6656`           | `Gen2 / Gen3 / Shitcam` |

### Gen4 or Smallcam の判定

機械学習によって判定を行います。未実装。

### Gen2 or Gen3 or Shitcam の判定

Shitcamは機械学習なしで機械的に区別することができます(参照: `tag-shitcam.ts`)。ただしこれは既知の国・撮影日の組み合わせだけを機械的に拾う手法で、Shitcamの画質やカメラ・パノラマの特徴を本質的に検出するものではありません。そのため、今後新たに新しい国で出現したShitcamなどは一時的に判定を見逃しますが、これはレアケースであり、意図的に許容しています。

残る「Gen2とGen3の区別」は、大半の撮影年では単純な日付比較だけで機械的に決まります。

事前の`label-tool/gen2-vs-gen3`でのラベリング結果(1272件)では、2011年だけがGen2/Gen3混在(約52%/48%)で、2009年以前は100%Gen2、2012年以降は100%Gen3という綺麗な境界でした。この境界を`tag-gen2-gen3-by-date.ts`でカットオフとして採用し、2009年以前を`Gen2`、2013年以降を`Gen3`として機械的にタグ付けします。したがって、境界年(2010〜2012年、特に2011年)だけが画像から学習したモデル/目視レビューの対象として残ります。ただし、ラベリング結果はその撮影年に関わらず全てのデータをそのまま機械学習に使用します。

境界年(2010〜2012年)のGen2 or Gen3判定のみを機械学習によって行います(後述「モデル2」参照)。

## パノラマのレンダリング方式

front/back(透視図)のみを利用します。

- `front`/`back`(基準は真の進行方向とその180°反対、pitch -20°): 車のボンネットが自然な形で写る、確認に使う画像。

Googleメタデータの`ResolutionHeight`が8192ではない画像では、タイル境界を避けるためfrontを-20°、backを-60°ずらす。

## モデル1: Gen4 or Smallcam

（実装の詳細を記述します）

ここでは、カメラ世代だけではなく、車の色まで判定を行います。

## モデル2: Gen2 or Gen3

`training/gen2-vs-gen3/`で学習したモデルで判定します。front/backそれぞれを重み共有のCNNバックボーン(MobileNetV3-Small、転移学習)に通して特徴ベクトルを取り、結合してMLPで2クラス分類します。学習データ(1272件、Gen2 269 / Gen3 1003)はクラス不均衡があるため、学習時はCrossEntropyLossにclass weightingをかけています。

```bash
npx tsx tag-gen2-gen3-by-date.ts step0.json step0b.json --only-untagged
npx tsx tag-gen2-gen3-by-model.ts step0b.json step1.json --only-untagged
```

## OCR（光学文字認識）: 著作権

```bash
npx tsx tag-shitcam.ts input.json step0a.json
npx tsx tag-gen2-gen3-by-date.ts step0a.json step0.json --only-untagged
npx tsx capture-locations.ts step0.json ./renders --only-untagged
# → renders/*-front.jpg, *-back.jpg, *-watermark.jpg をClaude Codeなどに読ませ、
#   上記「タグ付けの方針」に沿って世代・車体色のtags.jsonを作らせる
npx tsx apply-tags.ts step0.json tags.json step1.json

npx tsx tag-watermark-year.ts step1.json step2.json --only-untagged
npx tsx tag-month.ts step2.json output.json --only-untagged
```

`extra.tags`に重複なくマージされます(panoIdの突合チェック付き)。詳細は各スクリプトの冒頭コメント参照。

透かしの著作権年は、[igs](https://github.com/iggedi-ig-ig)氏の[copyright-labeller](https://github.com/iggedi-ig-ig/copyright-labeller)(著作権OCRツール、~2/3のカバー率・~95%の正解率とのこと)と同じ技術方針(OCRの認識文字種を透かしが取りうる文字だけに絞り、1回のOCR結果を鵜呑みにせず複数の検出が一致した場合だけ採用する)を採用した`tag-watermark-year.ts`で自動タグ付けします。

- 認識文字種を`0-9`・`Google`・スペースのみに制限(小さく低コントラストな文字に対する誤認識の大半はここで削れる)
- 同じ切り出し画像に対しTesseractのページ分割モードを変えて2回OCRし、両方が同じ年で一致した場合のみ採用
- 一致しなかった/年号が全く読めなかった場合は、黙ってスキップせず`©unclear`タグを付けて目視レビューに回す(ただしタグを書き込むのはGen4/Smallcamの地点のみ。上記「タグ付けの方針」参照)

## 機械学習の方針

front単体・back単体では判断がつきにくいため、**FrontとBackを1組の入力として扱う2分岐モデル**で学習する方針です。

```
front.jpg ──▶ [CNN backbone] ──▶ 特徴ベクトルA ─┐
               (重み共有)                        ├─▶ 結合 ──▶ MLP ──▶ 世代・色
back.jpg  ──▶ [CNN backbone] ──▶ 特徴ベクトルB ─┘
```
