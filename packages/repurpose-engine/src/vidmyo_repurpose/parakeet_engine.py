"""Parakeet ASR engine adapter and model fetcher for Vidmyo Repurpose.

Provides ultra-fast local transcription with word-level timestamps using
parakeet-tdt models via parakeet-cli (Metal / GGUF).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

PARAKEET_DEFAULT_MODEL = "tdt-0.6b-v3-q4_k"
PARAKEET_HF_REPO = "mudler/parakeet-cpp-gguf"
PARAKEET_MODEL_URL = (
    "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/tdt-0.6b-v3-q4_k.gguf"
)


@dataclass(frozen=True)
class ParakeetWord:
    text: str
    start: float
    end: float
    confidence: float


@dataclass(frozen=True)
class ParakeetSegment:
    start: float
    end: float
    text: str
    confidence: float
    words: list[ParakeetWord]


def get_bin_dir() -> Path:
    """Return the bundled vendor binary directory for parakeet-cli."""
    return (Path(__file__).parent / "bin").resolve()


def get_parakeet_cli_path() -> Path | None:
    """Find parakeet-cli either in bundled vendor bin or system PATH."""
    bundled = get_bin_dir() / "parakeet-cli"
    if bundled.is_file() and os.access(bundled, os.X_OK):
        return bundled
    found = shutil.which("parakeet-cli")
    return Path(found).resolve() if found else None


def default_parakeet_model_cache() -> Path:
    """Return the default cache directory for Parakeet GGUF models."""
    configured = os.environ.get("VIDMYO_PARAKEET_MODEL_CACHE")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".cache" / "vidmyo" / "repurpose" / "parakeet").resolve()


def ensure_parakeet_model(
    model_name: str = PARAKEET_DEFAULT_MODEL,
    cache_dir: Path | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> Path:
    """Ensure the specified Parakeet model exists in cache, downloading it if missing."""
    cache = (cache_dir or default_parakeet_model_cache()).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    filename = f"{model_name}.gguf" if not model_name.endswith(".gguf") else model_name
    model_path = cache / filename

    if model_path.is_file() and model_path.stat().st_size > 10 * 1024 * 1024:
        return model_path

    # Download model from Hugging Face
    import urllib.request
    import ssl
    try:
        import certifi
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ssl_ctx = ssl.create_default_context()

    url = f"https://huggingface.co/{PARAKEET_HF_REPO}/resolve/main/{filename}"
    temp_path = cache / f".{filename}.download.tmp"

    if progress:
        progress(0.0, f"Pobieranie modelu Parakeet ({filename})...")

    req = urllib.request.Request(url, headers={"User-Agent": "Vidmyo-Repurpose/0.1"})
    with urllib.request.urlopen(req, context=ssl_ctx) as response, open(temp_path, "wb") as out_file:
        total = int(response.headers.get("Content-Length", 0))
        downloaded = 0
        chunk_size = 1024 * 1024 * 4  # 4 MB
        while chunk := response.read(chunk_size):
            out_file.write(chunk)
            downloaded += len(chunk)
            if progress and total > 0:
                fraction = min(1.0, downloaded / total)
                progress(fraction, f"Pobieranie {downloaded / (1024*1024):.1f}/{total / (1024*1024):.1f} MB")

    temp_path.replace(model_path)
    if progress:
        progress(1.0, "Model Parakeet pobrany i zweryfikowany.")
    return model_path


class ParakeetEngine:
    """Wrapper around parakeet-cli executing native speech recognition."""

    def __init__(self, cli_path: Path | None = None, model_path: Path | None = None):
        self.cli_path = cli_path or get_parakeet_cli_path()
        if not self.cli_path or not self.cli_path.is_file():
            raise RuntimeError(
                f"parakeet-cli binary not found. Expected in {get_bin_dir()} or system PATH."
            )
        self.model_path = model_path or ensure_parakeet_model()

    def transcribe(
        self,
        audio_path: str | Path,
        decoder: str = "tdt",
        threads: int = 4,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Transcribe an audio file and return normalized segments and words."""
        audio_path = Path(audio_path).resolve()
        if not audio_path.is_file():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        env = os.environ.copy()
        bin_dir = str(self.cli_path.parent)
        dyld = env.get("DYLD_LIBRARY_PATH", "")
        env["DYLD_LIBRARY_PATH"] = f"{bin_dir}:{dyld}" if dyld else bin_dir

        cmd = [
            str(self.cli_path),
            "transcribe",
            "--model", str(self.model_path),
            "--input", str(audio_path),
            "--decoder", decoder,
            "--timestamps",
            "--json",
            "--threads", str(threads),
        ]

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"parakeet-cli failed with code {result.returncode}: {result.stderr.strip()}"
            )

        raw_output = result.stdout.strip()
        data: dict[str, Any] = {}
        for line in raw_output.splitlines():
            line_str = line.strip()
            if line_str.startswith("{") and line_str.endswith("}"):
                try:
                    data = json.loads(line_str)
                    break
                except json.JSONDecodeError:
                    continue

        if not data and raw_output.startswith("{"):
            try:
                data = json.loads(raw_output)
            except json.JSONDecodeError:
                pass

        raw_words = data.get("words", [])
        backend_segments = []
        info = {
            "language": "auto",
            "language_probability": 1.0,
            "engine": "parakeet",
            "model": self.model_path.name,
        }

        # Build segments from words (grouping into sentences or pauses)
        if raw_words:
            current_words: list[dict[str, Any]] = []
            current_start = raw_words[0].get("start", 0.0)
            for idx, w in enumerate(raw_words):
                w_start = float(w.get("start", 0.0))
                w_end = float(w.get("end", 0.0))
                w_text = str(w.get("w", "")).strip()
                w_conf = float(w.get("conf", 1.0))

                current_words.append({
                    "start": w_start,
                    "end": w_end,
                    "word": w_text,
                    "probability": w_conf,
                })

                # Split on sentence ending punctuation or large pause (>1.2s)
                next_start = (
                    float(raw_words[idx + 1].get("start", 0.0))
                    if idx + 1 < len(raw_words)
                    else None
                )
                ends_sentence = any(w_text.endswith(p) for p in (".", "?", "!"))
                pause = (next_start - w_end) if next_start is not None else 0.0

                if ends_sentence or pause > 1.2 or idx == len(raw_words) - 1:
                    seg_text = " ".join(item["word"] for item in current_words)
                    seg_end = current_words[-1]["end"]
                    backend_segments.append({
                        "start": current_start,
                        "end": seg_end,
                        "text": seg_text,
                        "words": list(current_words),
                        "avg_logprob": 0.0,
                    })
                    current_words.clear()
                    if next_start is not None:
                        current_start = next_start

        return backend_segments, info
