#!/usr/bin/env python3
"""Download NVIDIA's Kimodo SOMA RP v1.2 checkpoint and convert it to the GGUF Understudy loads.

SOMA RP v1.2 is the motion model Understudy prefers; it has the same architecture and tensor shapes as v1.1 but is not
published as GGUF, so this runs kimodo.cpp's converter on NVIDIA's checkpoint (safetensors and NPY only, no pickle).

    py scripts/convert_soma_v12.py                       download to sources/, write models/kimodo-soma-rp-v1.2-f32.gguf
    py scripts/convert_soma_v12.py --input DIR           convert a checkpoint already downloaded to DIR

Needs huggingface_hub (pip install huggingface_hub). The model is under the NVIDIA Open Model License; if Hugging Face
asks you to accept it, do so on the model page and log in with `hf auth login` first.
"""
import argparse
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODEL_ID = "nvidia/Kimodo-SOMA-RP-v1.2"
REVISION = "0e3c89024d896064b6851201373f7834784a386b"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", type=Path, help="an already downloaded checkpoint folder (skips the download)")
    p.add_argument("--output", type=Path, default=REPO / "models" / "kimodo-soma-rp-v1.2-f32.gguf")
    a = p.parse_args()

    src = a.input
    if src is None:
        from huggingface_hub import snapshot_download
        src = REPO / "sources" / "Kimodo-SOMA-RP-v1.2"
        print(f"Downloading {MODEL_ID}@{REVISION[:12]} to {src} ...")
        snapshot_download(MODEL_ID, revision=REVISION, local_dir=src, ignore_patterns=["*.pth"])
        (src / "REVISION").write_text(f"{REVISION}  {MODEL_ID}\n", encoding="utf-8")

    spec = importlib.util.spec_from_file_location("convert_motion_to_gguf", REPO / "kimodo.cpp" / "scripts" / "convert_motion_to_gguf.py")
    conv = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = conv  # its dataclasses look the module up
    spec.loader.exec_module(conv)
    # Same skeleton and license as v1.1; its tensors drop the "denoiser.backbone." prefix, which the reader strips.
    conv.MODEL_SPECS.setdefault(MODEL_ID, conv.MODEL_SPECS["nvidia/Kimodo-SOMA-RP-v1.1"])

    a.output.parent.mkdir(parents=True, exist_ok=True)
    sys.argv = ["convert_motion_to_gguf.py", "--input", str(src), "--output", str(a.output)]
    conv.main()
    print(f"Wrote {a.output}")


if __name__ == "__main__":
    main()
