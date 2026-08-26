"""splits.jsonのレコードをPyTorch Datasetとして読み込む。"""

from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import Dataset
from torchvision import transforms

from model import INPUT_SIZE, CLASS_NAMES

_IMAGENET_MEAN = [0.485, 0.456, 0.406]
_IMAGENET_STD = [0.229, 0.224, 0.225]

_LABEL_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}


def build_transform(train: bool) -> transforms.Compose:
    if train:
        return transforms.Compose(
            [
                transforms.RandomResizedCrop(INPUT_SIZE, scale=(0.8, 1.0), ratio=(0.9, 1.1)),
                transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.15),
                transforms.ToTensor(),
                transforms.Normalize(_IMAGENET_MEAN, _IMAGENET_STD),
            ]
        )
    return transforms.Compose(
        [
            transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
            transforms.ToTensor(),
            transforms.Normalize(_IMAGENET_MEAN, _IMAGENET_STD),
        ]
    )


class Gen2Gen3Dataset(Dataset):
    def __init__(self, records: list[dict], train: bool):
        self.records = records
        self.transform = build_transform(train)

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, idx: int):
        r = self.records[idx]
        front = Image.open(Path(r["front"])).convert("RGB")
        back = Image.open(Path(r["back"])).convert("RGB")
        front_t = self.transform(front)
        back_t = self.transform(back)
        label = _LABEL_TO_IDX[r["gen"]]
        return front_t, back_t, label
