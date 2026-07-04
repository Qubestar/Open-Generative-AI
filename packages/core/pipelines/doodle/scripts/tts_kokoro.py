#!/usr/bin/env python3
"""
tts_kokoro.py — generate a voiceover WAV from a script using Kokoro (local, free, unlimited).

Usage:
    .venv/bin/python tts_kokoro.py <script.txt> <out.wav> [--voice am_onyx] [--speed 1.0]

Good narrator voices (calm documentary, Zenn-ish):
    am_onyx   deep, calm male  (default)
    am_michael clear neutral male
    bm_george  British male
    bm_fable   British male, warm
    af_heart   warm female
Run with --list to print all installed voices.
"""
import argparse, sys
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--voice", default="am_onyx")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="a", help="a=American, b=British English")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    from kokoro import KPipeline
    import soundfile as sf

    if args.list:
        # voices ship with the kokoro package
        from kokoro.pipeline import KPipeline as _K  # noqa
        print("Common voices: am_onyx am_michael am_adam am_liam bm_george bm_fable "
              "bm_lewis af_heart af_bella af_nicole af_sarah")
        return

    if not args.script or not args.out:
        ap.error("script and out are required")

    text = open(args.script, encoding="utf-8").read().strip()
    if not text:
        sys.exit("script is empty")

    pipeline = KPipeline(lang_code=args.lang)
    chunks = []
    # split on blank lines so the pipeline phrases naturally; '\n\n' = paragraph
    for gs, ps, audio in pipeline(text, voice=args.voice, speed=args.speed,
                                  split_pattern=r"\n\n+"):
        chunks.append(audio)

    full = np.concatenate(chunks)
    sf.write(args.out, full, 24000)
    dur = len(full) / 24000
    print(f"wrote {args.out}  {dur:0.1f}s  voice={args.voice} speed={args.speed}")


if __name__ == "__main__":
    main()
