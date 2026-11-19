#!/usr/bin/env python3
"""Chatterbox (Resemble AI) voice cloning. Thin wrapper for the Siteline Mac helper.

    chatterbox.py --check
    chatterbox.py --text-file TEXT.txt --ref REFERENCE.wav --out OUT.wav

UNVERIFIED: written against the Chatterbox README's documented `ChatterboxTTS.from_pretrained(...)` / `model.generate(text, audio_prompt_path=...)`
calls, without the model installed. It must be run on Logan's Mac in the engine spike (see helper/README.md).

Environment:
    SITELINE_TORCH_DEVICE  "mps" (default on Apple Silicon), "cpu" or "cuda"
"""
import argparse
import os
import sys

# This folder holds chatterbox.py and openvoice.py: put it on the import path and they would shadow the libraries of the same name.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != os.path.dirname(os.path.abspath(__file__))]


def check() -> None:
    from chatterbox.tts import ChatterboxTTS  # noqa: F401
    import torchaudio  # noqa: F401


def device() -> str:
    forced = os.environ.get("SITELINE_TORCH_DEVICE")
    if forced:
        return forced
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def synth(text: str, ref: str, out: str) -> None:
    import torch
    import torchaudio as ta
    from chatterbox.tts import ChatterboxTTS

    dev = device()
    if dev != "cuda":
        # The released checkpoints were saved on CUDA; loading them elsewhere needs the tensors mapped to the device in use.
        original_load = torch.load
        torch.load = lambda *args, **kw: original_load(*args, **{**kw, "map_location": torch.device(dev)})
    model = ChatterboxTTS.from_pretrained(device=dev)
    wav = model.generate(text, audio_prompt_path=ref)
    ta.save(out, wav.cpu(), model.sr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--text-file")
    ap.add_argument("--ref")
    ap.add_argument("--out")
    a = ap.parse_args()
    try:
        if a.check:
            check()
            return 0
        if not (a.text_file and a.ref and a.out):
            ap.error("--text-file, --ref and --out are required")
        with open(a.text_file, encoding="utf-8") as f:
            text = f.read().strip()
        synth(text, a.ref, a.out)
        return 0
    except Exception as e:
        print(f"chatterbox: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
