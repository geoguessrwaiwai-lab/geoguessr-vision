"""
label-tool/gen2-vs-gen3のitems.json + labels.jsonから学習用マニフェストを作り、
train/val/testに分割してsplits.jsonに書き出す。

分割方針:
- (撮影年, gen)ごとに層化 -> 各年・各クラスがtrain/val/testに偏りなく配分される。
- 特に境界年(2010-2012)はtag-gen2-gen3-by-date.tsが機械的に振り分けられず実際に
  モデルが必要になる範囲なので、テストでの評価精度がここに集中するよう気を配る。
- Shitcamラベルはこのモデル(Gen2 vs Gen3の2値分類)の対象外なので除外する。

使い方: python3 prepare_manifest.py
"""

import json
import random
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "label-tool" / "gen2-vs-gen3"
OUT_PATH = Path(__file__).resolve().parent / "splits.json"

SEED = 42
VAL_FRAC = 0.15
TEST_FRAC = 0.15


def main() -> None:
    items = {i["panoId"]: i for i in json.loads((DATA_DIR / "items.json").read_text())}
    labels = json.loads((DATA_DIR / "labels.json").read_text())

    rng = random.Random(SEED)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)

    for pano_id, label in labels.items():
        gen = label["gen"]
        if gen not in ("Gen2", "Gen3"):
            continue
        item = items.get(pano_id)
        if item is None:
            continue
        year = item["date"].split("-")[0] if item.get("date") else "unknown"
        front = DATA_DIR / item["images"]["front"]
        back = DATA_DIR / item["images"]["back"]
        if not front.exists() or not back.exists():
            continue
        record = {
            "panoId": pano_id,
            "front": str(front),
            "back": str(back),
            "gen": gen,
            "year": year,
        }
        groups[(year, gen)].append(record)

    splits = {"train": [], "val": [], "test": []}

    for (year, gen), records in sorted(groups.items()):
        rng.shuffle(records)
        n = len(records)
        n_val = max(1, round(n * VAL_FRAC)) if n >= 3 else 0
        n_test = max(1, round(n * TEST_FRAC)) if n >= 3 else 0
        # 極端に小さいグループを全部train以外に吸い取られないよう調整
        n_val = min(n_val, n - 1) if n > 1 else 0
        n_test = min(n_test, n - n_val - 1) if n - n_val > 1 else 0

        test_records = records[:n_test]
        val_records = records[n_test : n_test + n_val]
        train_records = records[n_test + n_val :]

        splits["test"].extend(test_records)
        splits["val"].extend(val_records)
        splits["train"].extend(train_records)

    for split_name in splits:
        rng.shuffle(splits[split_name])

    summary: dict[str, dict] = {}
    for split_name, records in splits.items():
        c = defaultdict(int)
        for r in records:
            c[r["gen"]] += 1
        summary[split_name] = {"total": len(records), **c}

    OUT_PATH.write_text(json.dumps(splits, indent=2, ensure_ascii=False))
    print(f"Wrote {OUT_PATH}")
    for split_name, s in summary.items():
        print(f"  {split_name}: {s}")

    print("\nBoundary years (2010-2012) per split:")
    for split_name, records in splits.items():
        c = defaultdict(int)
        for r in records:
            if r["year"] in ("2010", "2011", "2012"):
                c[r["gen"]] += 1
        print(f"  {split_name}: {dict(c)}")


if __name__ == "__main__":
    main()
