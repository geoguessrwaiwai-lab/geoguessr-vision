"""
Gen2 vs Gen3の2分岐モデル定義。

front.jpg/back.jpgを同じCNNバックボーン(重み共有)に通して特徴ベクトルを取り、
結合してMLPで2クラス分類する(README「機械学習の方針」の設計をそのまま実装)。
"""

import torch
import torch.nn as nn
import torchvision.models as models

NUM_CLASSES = 2  # Gen2, Gen3
CLASS_NAMES = ["Gen2", "Gen3"]
INPUT_SIZE = 224


def _build_backbone() -> tuple[nn.Module, int]:
    net = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    feature_dim = net.classifier[0].in_features  # 576
    net.classifier = nn.Identity()
    return net, feature_dim


class Gen2Gen3Net(nn.Module):
    def __init__(self, dropout: float = 0.3):
        super().__init__()
        self.backbone, feature_dim = _build_backbone()
        self.head = nn.Sequential(
            nn.Linear(feature_dim * 2, 128),
            nn.ReLU(inplace=True),
            nn.Dropout(dropout),
            nn.Linear(128, NUM_CLASSES),
        )

    def forward(self, front: torch.Tensor, back: torch.Tensor) -> torch.Tensor:
        feat_front = self.backbone(front)
        feat_back = self.backbone(back)
        combined = torch.cat([feat_front, feat_back], dim=1)
        return self.head(combined)
