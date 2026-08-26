"""
学習済みcheckpoint.ptをONNXにエクスポートし、models/gen2-vs-gen3.onnxに書き出す。
Node.js側からはonnxruntime-node経由で(front, back)の2入力を渡して推論する想定
(AGENTS.md「学習済みモデルは`models/`にONNX形式で出力」を参照)。

使い方: python3 export_onnx.py
"""

from pathlib import Path

import onnx
import onnxruntime as ort
import torch

from model import Gen2Gen3Net, INPUT_SIZE

HERE = Path(__file__).resolve().parent
CHECKPOINT_PATH = HERE / "checkpoint.pt"
OUT_PATH = HERE.parents[1] / "models" / "gen2-vs-gen3.onnx"


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    model = Gen2Gen3Net()
    model.load_state_dict(torch.load(CHECKPOINT_PATH, map_location="cpu"))
    model.eval()

    dummy_front = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    dummy_back = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)

    torch.onnx.export(
        model,
        (dummy_front, dummy_back),
        str(OUT_PATH),
        input_names=["front", "back"],
        output_names=["logits"],
        dynamic_axes={
            "front": {0: "batch"},
            "back": {0: "batch"},
            "logits": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print(f"Wrote {OUT_PATH}")

    onnx_model = onnx.load(str(OUT_PATH))
    onnx.checker.check_model(onnx_model)
    print("ONNX model check passed")

    session = ort.InferenceSession(str(OUT_PATH), providers=["CPUExecutionProvider"])
    with torch.no_grad():
        torch_out = model(dummy_front, dummy_back).numpy()
    ort_out = session.run(None, {"front": dummy_front.numpy(), "back": dummy_back.numpy()})[0]
    max_diff = abs(torch_out - ort_out).max()
    print(f"Max diff between torch and onnxruntime outputs: {max_diff:.6f}")


if __name__ == "__main__":
    main()
