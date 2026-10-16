#!/usr/bin/env python3
"""Local speech recognition for Vidmyo Translate Video (faster-whisper).

Runs fully offline after the model is cached. Emits one JSON document:

    {
      "model": "small",
      "device": "cpu",
      "compute_type": "int8",
      "language": "en",
      "language_probability": 0.99,
      "duration": 12.34,
      "elapsed_seconds": 4.1,
      "segments": [
        {"id": 0, "start": 0.0, "end": 2.1, "text": "…",
         "words": [{"word": "…", "start": 0.0, "end": 0.4, "probability": 0.91}]}
      ]
    }

The script is deterministic, takes an argument list (never a shell string), and
never downloads anything unless the requested model is genuinely missing.

License: faster-whisper is MIT. Whisper model weights are MIT (OpenAI). See
docs/translate/LICENSES.md in the Vidmyo repository.
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
    print(f"transcribe: {message}", file=sys.stderr)
    raise SystemExit(code)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local faster-whisper transcription for Vidmyo")
    parser.add_argument("audio", help="Input audio file (16 kHz mono WAV is recommended)")
    parser.add_argument("output", help="Destination JSON path")
    parser.add_argument("--model", default="small", help="Whisper model size or local path")
    parser.add_argument("--compute-type", default="int8", help="int8, int8_float16, float16 or float32")
    parser.add_argument("--device", default="cpu", help="cpu or cuda")
    parser.add_argument("--language", default="auto", help="ISO code or 'auto' to detect")
    parser.add_argument("--word-timestamps", action="store_true", help="Include per-word timings")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--threads", type=int, default=0, help="CPU threads (0 = library default)")
    parser.add_argument("--no-vad", action="store_true", help="Disable the voice-activity filter")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    if not os.path.isfile(args.audio):
        fail(f"audio file not found: {args.audio}", 2)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail(
            "faster-whisper is not installed for this Python. "
            "Install it with: python3 -m pip install faster-whisper",
            3,
        )

    cache_dir = os.environ.get("VIDMYO_TRANSLATE_MODEL_DIR") or None
    threads = args.threads if args.threads > 0 else (os.cpu_count() or 4)
    started = time.time()
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            cpu_threads=threads,
            download_root=cache_dir,
        )
    except Exception as error:  # noqa: BLE001 - surfaced to the job log verbatim
        fail(f"could not load model '{args.model}': {error}", 4)

    language = None if args.language in ("", "auto", None) else args.language
    try:
        raw_segments, info = model.transcribe(
            args.audio,
            language=language,
            word_timestamps=bool(args.word_timestamps),
            beam_size=max(1, args.beam_size),
            vad_filter=not args.no_vad,
        )
        segments = []
        for index, segment in enumerate(raw_segments):
            words = []
            for word in getattr(segment, "words", None) or []:
                words.append(
                    {
                        "word": word.word,
                        "start": round(float(word.start), 3),
                        "end": round(float(word.end), 3),
                        "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
                    }
                )
            segments.append(
                {
                    "id": index,
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": (segment.text or "").strip(),
                    "words": words,
                }
            )
    except Exception as error:  # noqa: BLE001
        fail(f"transcription failed: {error}", 5)

    payload = {
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "language": getattr(info, "language", None) or language,
        "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
        "elapsed_seconds": round(time.time() - started, 2),
        "segments": segments,
    }

    directory = os.path.dirname(os.path.abspath(args.output))
    if directory:
        os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory or ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    print(
        f"transcribe: {len(segments)} segments, language={payload['language']} "
        f"({payload['language_probability']}), {payload['elapsed_seconds']}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
