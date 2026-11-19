#!/usr/bin/env python3
"""Qwen3-TTS voice cloning through mlx-audio. Thin wrapper for the Siteline Mac helper.

    qwen3.py --check
    qwen3.py --text-file TEXT.txt --ref REFERENCE.wav --out OUT.wav

UNVERIFIED: written against mlx-audio's documented `generate_audio` call, without the model installed. It must be run on Logan's Mac in the
engine spike (see helper/README.md) and the call below corrected if the installed mlx-audio version differs.

Environment:
    SITELINE_QWEN3_MODEL  the mlx-audio model id (default below; a Qwen3-TTS *Base* model, the one that accepts a reference voice)
    SITELINE_QWEN3_REF_TEXT  optional transcript of the reference clip; when unset mlx-audio is left to transcribe the reference itself
"""
import argparse
import glob
import os
import shutil
import sys

# This folder holds chatterbox.py and openvoice.py: put it on the import path and they would shadow the libraries of the same name.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != os.path.dirname(os.path.abspath(__file__))]
import tempfile

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"


def check() -> None:
    import mlx_audio.tts.generate  # noqa: F401  (importing is the whole check)


def synth(text: str, ref: str, out: str) -> None:
    from mlx_audio.tts.generate import generate_audio

    model = os.environ.get("SITELINE_QWEN3_MODEL", DEFAULT_MODEL)
    ref_text = os.environ.get("SITELINE_QWEN3_REF_TEXT") or None
    with tempfile.TemporaryDirectory() as tmp:
        prefix = os.path.join(tmp, "speech")
        generate_audio(
            text=text,
            model=model,
            ref_audio=ref,
            ref_text=ref_text,
            file_prefix=prefix,
            audio_format="wav",
            join_audio=True,
            verbose=False,
        )
        made = sorted(glob.glob(prefix + "*.wav"))
        if not made:
            raise RuntimeError("mlx-audio wrote no wav file")
        shutil.move(made[0], out)


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
    except Exception as e:  # the helper shows the last line of stderr as the job's reason
        print(f"qwen3: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
