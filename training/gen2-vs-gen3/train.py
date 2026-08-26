"""
Gen2 vs Gen3モデルの学習。

クラス不均衡(train: Gen2 189 / Gen3 701)への対策として、CrossEntropyLossに
逆頻度のclass weightを与える(層化サンプリングではなくweighted lossを採用 —
このデータ規模ではエポックごとの実効サンプル数を削らずに済む)。
検証指標はaccuracyではなくmacro F1(不均衡データでGen3への偏りを見逃さないため)。

使い方: python3 train.py [--epochs 20] [--batch-size 16] [--lr 3e-4]
"""

import argparse
import json
from pathlib import Path

import torch
import torch.nn as nn
from sklearn.metrics import f1_score, confusion_matrix
from torch.utils.data import DataLoader

from dataset import Gen2Gen3Dataset
from model import Gen2Gen3Net, CLASS_NAMES

HERE = Path(__file__).resolve().parent
SPLITS_PATH = HERE / "splits.json"
CHECKPOINT_PATH = HERE / "checkpoint.pt"


def get_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def compute_class_weights(records: list[dict]) -> torch.Tensor:
    counts = {name: 0 for name in CLASS_NAMES}
    for r in records:
        counts[r["gen"]] += 1
    total = sum(counts.values())
    weights = [total / (len(CLASS_NAMES) * counts[name]) for name in CLASS_NAMES]
    return torch.tensor(weights, dtype=torch.float32)


@torch.no_grad()
def evaluate(model: nn.Module, loader: DataLoader, device: torch.device) -> dict:
    model.eval()
    all_preds, all_labels = [], []
    for front, back, labels in loader:
        front, back = front.to(device), back.to(device)
        logits = model(front, back)
        preds = logits.argmax(dim=1).cpu()
        all_preds.extend(preds.tolist())
        all_labels.extend(labels.tolist())
    macro_f1 = f1_score(all_labels, all_preds, average="macro")
    cm = confusion_matrix(all_labels, all_preds, labels=[0, 1])
    return {"macro_f1": macro_f1, "confusion_matrix": cm.tolist()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--num-workers", type=int, default=4)
    args = parser.parse_args()

    splits = json.loads(SPLITS_PATH.read_text())
    train_records, val_records, test_records = splits["train"], splits["val"], splits["test"]

    device = get_device()
    print(f"Using device: {device}")

    train_ds = Gen2Gen3Dataset(train_records, train=True)
    val_ds = Gen2Gen3Dataset(val_records, train=False)
    test_ds = Gen2Gen3Dataset(test_records, train=False)

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=args.num_workers)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=args.num_workers)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False, num_workers=args.num_workers)

    model = Gen2Gen3Net().to(device)
    class_weights = compute_class_weights(train_records).to(device)
    print(f"Class weights ({CLASS_NAMES}): {class_weights.tolist()}")
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_f1 = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        running_loss = 0.0
        for front, back, labels in train_loader:
            front, back, labels = front.to(device), back.to(device), labels.to(device)
            optimizer.zero_grad()
            logits = model(front, back)
            loss = criterion(logits, labels)
            loss.backward()
            optimizer.step()
            running_loss += loss.item() * labels.size(0)
        scheduler.step()

        train_loss = running_loss / len(train_ds)
        val_metrics = evaluate(model, val_loader, device)
        print(
            f"epoch {epoch:2d}/{args.epochs}  train_loss={train_loss:.4f}  "
            f"val_macro_f1={val_metrics['macro_f1']:.4f}  val_cm={val_metrics['confusion_matrix']}"
        )

        if val_metrics["macro_f1"] > best_f1:
            best_f1 = val_metrics["macro_f1"]
            torch.save(model.state_dict(), CHECKPOINT_PATH)
            print(f"  -> new best (macro_f1={best_f1:.4f}), saved to {CHECKPOINT_PATH}")

    print(f"\nBest val macro_f1: {best_f1:.4f}")

    model.load_state_dict(torch.load(CHECKPOINT_PATH, map_location=device))
    test_metrics = evaluate(model, test_loader, device)
    print(f"Test macro_f1: {test_metrics['macro_f1']:.4f}")
    print(f"Test confusion matrix (rows=true, cols=pred, order={CLASS_NAMES}): {test_metrics['confusion_matrix']}")


if __name__ == "__main__":
    main()
