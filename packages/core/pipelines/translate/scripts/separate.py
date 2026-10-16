#!/usr/bin/env python3
"""Optional local source separation for Vidmyo Translate Video.

Splits one audio track into `vocals` and `no_vocals` with Demucs so a dub can
keep the original music, ambience and sound effects while the original speech is
removed instead of merely ducked.

    python3 separate.py <input.wav> <out_dir> [--model htdemucs] [--device auto]

Writes `<out_dir>/separation.json`:

    {"model": "htdemucs", "device": "mps", "elapsed_seconds": 41.2,
     "vocals": "<abs path>", "no_vocals": "<abs path>", "sample_rate": 44100}

License: Demucs is MIT (Meta Platforms). htdemucs weights are published under the
same MIT terms. Nothing here uploads audio anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from typing import NoReturn


def fail(message: str, code: int = 1) -> NoReturn:
    print(f"separate: {message}", file=sys.stderr)
    raise SystemExit(code)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local Demucs two-stem separation for Vidmyo")
    parser.add_argument("input", help="Input audio file (WAV recommended)")
    parser.add_argument("out_dir", help="Directory for the separated stems")
    parser.add_argument("--model", default=os.environ.get("VIDMYO_TRANSLATE_DEMUCS_MODEL", "htdemucs"))
    parser.add_argument("--device", default=os.environ.get("VIDMYO_TRANSLATE_DEMUCS_DEVICE", "auto"))
    parser.add_argument("--jobs", type=int, default=0, help="Worker count (0 = library default)")
    return parser


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        return "cpu"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> int:
    args = build_parser().parse_args()
    if not os.path.isfile(args.input):
        fail(f"input audio not found: {args.input}", 2)

    try:
        import demucs.separate as demucs_separate  # noqa: PLC0415
    except ImportError:
        fail(
            "demucs is not installed for this Python. Install it with: "
            "python3 -m pip install demucs",
            3,
        )

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    device = pick_device(args.device)
    started = time.time()

    argv = [
        "--two-stems", "vocals",
        "-n", args.model,
        "-d", device,
        "-o", out_dir,
    ]
    if args.jobs > 0:
        argv.extend(["-j", str(args.jobs)])
    argv.append(os.path.abspath(args.input))

    previous = sys.argv
    try:
        sys.argv = ["demucs", *argv]
        demucs_separate.main()
    except SystemExit as error:  # demucs calls sys.exit on failure
        if error.code not in (0, None):
            fail(f"demucs exited with {error.code}", 4)
    except Exception as error:  # noqa: BLE001
        fail(f"demucs failed: {error}", 5)
    finally:
        sys.argv = previous

    # demucs writes <out_dir>/<model>/<track>/{vocals,no_vocals}.wav. Locate the
    # newest stems instead of assuming the track-directory spelling, because the
    # sanitised track name differs between demucs versions.
    def newest(name: str):
        matches = []
        for root, _dirs, files in os.walk(out_dir):
            if name in files:
                full = os.path.join(root, name)
                matches.append((os.path.getmtime(full), full))
        return max(matches)[1] if matches else None

    vocals = newest("vocals.wav")
    no_vocals = newest("no_vocals.wav")
    if not vocals or not no_vocals:
        fail(f"demucs produced no stems under {out_dir}", 6)

    payload = {
        "model": args.model,
        "device": device,
        "elapsed_seconds": round(time.time() - started, 2),
        "vocals": vocals,
        "no_vocals": no_vocals,
        "sample_rate": 44100,
    }
    handle, temporary = tempfile.mkstemp(dir=out_dir, suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, os.path.join(out_dir, "separation.json"))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    print(f"separate: {device} in {payload['elapsed_seconds']}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
