#!/usr/bin/env python3
"""OpenVoice V2 (MyShell) voice cloning. Thin wrapper for the Siteline Mac helper.

    openvoice.py --check
    openvoice.py --text-file TEXT.txt --ref REFERENCE.wav --out OUT.wav

OpenVoice is a tone-colour converter, not a speaker: a base voice (MeloTTS) says the line, then the converter re-colours it to match the reference.

UNVERIFIED: written against OpenVoice's documented V2 usage (`ToneColorConverter`, `se_extractor.get_se`, MeloTTS `tts_to_file`), without the
checkpoints installed. It must be run on Logan's Mac in the engine spike (see helper/README.md).

Environment:
    SITELINE_OPENVOICE_CKPT   the unpacked `checkpoints_v2` folder (default: ~/.siteline-helper/openvoice/checkpoints_v2)
    SITELINE_OPENVOICE_SPEAKER  the Melo base speaker key (default EN-US)
    SITELINE_TORCH_DEVICE     "mps", "cpu" or "cuda" (default: cpu; the converter is small and mps is not always supported)
"""
import argparse
import os
import sys

# This folder holds chatterbox.py and openvoice.py: put it on the import path and they would shadow the libraries of the same name.
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != os.path.dirname(os.path.abspath(__file__))]
import tempfile


def check() -> None:
    from openvoice.api import ToneColorConverter  # noqa: F401
    from melo.api import TTS  # noqa: F401

    ckpt = checkpoints()
    if not os.path.exists(os.path.join(ckpt, "converter", "checkpoint.pth")):
        raise RuntimeError(f"OpenVoice checkpoints not found at {ckpt} (set SITELINE_OPENVOICE_CKPT)")


def checkpoints() -> str:
    return os.environ.get("SITELINE_OPENVOICE_CKPT") or os.path.expanduser("~/.siteline-helper/openvoice/checkpoints_v2")


def synth(text: str, ref: str, out: str) -> None:
    import torch
    from melo.api import TTS
    from openvoice import se_extractor
    from openvoice.api import ToneColorConverter

    dev = os.environ.get("SITELINE_TORCH_DEVICE", "cpu")
    ckpt = checkpoints()
    speaker_key = os.environ.get("SITELINE_OPENVOICE_SPEAKER", "EN-US")

    converter = ToneColorConverter(os.path.join(ckpt, "converter", "config.json"), device=dev)
    converter.load_ckpt(os.path.join(ckpt, "converter", "checkpoint.pth"))
    target_se, _ = se_extractor.get_se(ref, converter, vad=False)

    base = TTS(language="EN", device=dev)
    speaker_id = base.hps.data.spk2id[speaker_key]
    source_se = torch.load(
        os.path.join(ckpt, "base_speakers", "ses", speaker_key.lower().replace("_", "-") + ".pth"), map_location=dev
    )
    with tempfile.TemporaryDirectory() as tmp:
        base_wav = os.path.join(tmp, "base.wav")
        base.tts_to_file(text, speaker_id, base_wav, speed=1.0)
        converter.convert(audio_src_path=base_wav, src_se=source_se, tgt_se=target_se, output_path=out, message="@MyShell")


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
        print(f"openvoice: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
