"""Deterministic, local-only media ingest for Vidmyo Repurpose."""

from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .contracts import INGEST_ARTIFACT_VERSION, validate_document

ENGINE_VERSION = "0.1.0"
INGEST_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "ingest-artifact.v1.json"


@dataclass(frozen=True)
class IngestError(Exception):
    """An observable ingest failure with stable recovery guidance."""

    code: str
    message: str
    preserved: str
    next_action: str

    def __str__(self) -> str:
        return self.message

    def payload(self) -> dict[str, str]:
        return {
            "code": self.code,
            "message": self.message,
            "preserved": self.preserved,
            "next_action": self.next_action,
        }


def _error(code: str, message: str, next_action: str) -> IngestError:
    return IngestError(
        code=code,
        message=message,
        preserved="The source media and existing project manifest were not changed.",
        next_action=next_action,
    )


def _file_signature(path: Path) -> tuple[int, int, int, int, int]:
    details = path.stat()
    return (
        details.st_dev,
        details.st_ino,
        details.st_size,
        details.st_mtime_ns,
        details.st_ctime_ns,
    )


def fingerprint_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    """Return a path-independent streaming SHA-256 fingerprint."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(chunk_size):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _default_probe(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def probe_media(
    path: Path,
    *,
    run_probe: Callable[[list[str]], subprocess.CompletedProcess[str]] = _default_probe,
) -> dict[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = run_probe(command)
    except FileNotFoundError as exc:
        raise _error(
            "ffprobe_not_available",
            "ffprobe is not available, so the source media could not be inspected.",
            "Install FFmpeg so ffprobe is on PATH, then retry ingest.",
        ) from exc
    except OSError as exc:
        raise _error(
            "ffprobe_failed",
            f"ffprobe could not be started: {exc}.",
            "Check the FFmpeg installation and retry ingest.",
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        suffix = f" ({detail})" if detail else ""
        raise _error(
            "ffprobe_failed",
            f"ffprobe could not read the source media{suffix}.",
            "Choose a supported, uncorrupted local media file and retry ingest.",
        )
    try:
        document = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError) as exc:
        raise _error(
            "ffprobe_invalid_json",
            "ffprobe returned invalid metadata instead of JSON.",
            "Check the FFmpeg installation and retry ingest.",
        ) from exc
    if not isinstance(document, dict):
        raise _error(
            "ffprobe_invalid_json",
            "ffprobe returned metadata with an invalid top-level shape.",
            "Check the FFmpeg installation and retry ingest.",
        )
    return document


def _nullable_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return None if not value or value.upper() == "N/A" else value


def _nullable_float(value: Any, *, positive: bool = False) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or (positive and number <= 0):
        return None
    return number


def _nullable_int(value: Any, *, positive: bool = False) -> int | None:
    number = _nullable_float(value, positive=positive)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _frame_rate(value: Any) -> float | None:
    if isinstance(value, str) and "/" in value:
        numerator, denominator = value.split("/", 1)
        top = _nullable_float(numerator)
        bottom = _nullable_float(denominator)
        if top is None or bottom in (None, 0):
            return None
        rate = top / bottom
        return rate if math.isfinite(rate) and rate > 0 else None
    return _nullable_float(value, positive=True)


def normalize_probe(document: dict[str, Any]) -> dict[str, Any]:
    streams = document.get("streams")
    format_data = document.get("format")
    if not isinstance(streams, list) or not isinstance(format_data, dict):
        raise _error(
            "ffprobe_invalid_metadata",
            "ffprobe returned JSON without valid streams and format metadata.",
            "Check the FFmpeg installation or choose another local video file, then retry ingest.",
        )
    video = next(
        (item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"),
        None,
    )
    audio = next(
        (item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"),
        None,
    )
    if video is None:
        raise _error(
            "video_stream_missing",
            "The source media does not contain a video stream.",
            "Choose a local video file that contains both video and audio, then retry ingest.",
        )
    if audio is None:
        raise _error(
            "audio_stream_missing",
            "The source media does not contain an audio stream.",
            "Choose a local video file that contains both video and audio, then retry ingest.",
        )
    duration = _nullable_float(format_data.get("duration"), positive=True)
    if duration is None:
        raise _error(
            "invalid_media_duration",
            "The source media does not report a finite positive duration.",
            "Choose a valid local video file with a measurable duration, then retry ingest.",
        )
    format_name = _nullable_string(format_data.get("format_name"))
    format_names = [] if format_name is None else list(dict.fromkeys(
        name.strip() for name in format_name.split(",") if name.strip()
    ))
    return {
        "container": {
            "format_names": format_names,
            "format_long_name": _nullable_string(format_data.get("format_long_name")),
            "duration_seconds": duration,
        },
        "video": {
            "codec_name": _nullable_string(video.get("codec_name")),
            "width": _nullable_int(video.get("width"), positive=True),
            "height": _nullable_int(video.get("height"), positive=True),
            "average_frame_rate": _frame_rate(video.get("avg_frame_rate")),
            "real_frame_rate": _frame_rate(video.get("r_frame_rate")),
            "duration_seconds": _nullable_float(video.get("duration"), positive=True),
        },
        "audio": {
            "codec_name": _nullable_string(audio.get("codec_name")),
            "sample_rate_hz": _nullable_int(audio.get("sample_rate"), positive=True),
            "channels": _nullable_int(audio.get("channels"), positive=True),
            "channel_layout": _nullable_string(audio.get("channel_layout")),
            "duration_seconds": _nullable_float(audio.get("duration"), positive=True),
        },
    }


def resolve_local_source(project_dir: Path, source_uri: str) -> Path:
    source = Path(source_uri).expanduser()
    if not source.is_absolute():
        source = project_dir / source
    source = source.resolve(strict=False)
    if not source.exists():
        raise _error(
            "source_missing",
            f"The selected local source does not exist: {source}.",
            "Choose an existing local video file and retry ingest.",
        )
    if not source.is_file():
        raise _error(
            "source_not_regular_file",
            f"The selected source is not a regular file: {source}.",
            "Choose a readable local video file, not a directory or special file.",
        )
    mode = source.stat().st_mode
    if not mode & (stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH):
        raise _error(
            "source_not_readable",
            f"The selected source is not readable: {source}.",
            "Grant read permission or choose another local video file, then retry ingest.",
        )
    try:
        with source.open("rb"):
            pass
    except OSError as exc:
        raise _error(
            "source_not_readable",
            f"The selected source could not be opened for reading: {source} ({exc}).",
            "Grant read permission or choose another local video file, then retry ingest.",
        ) from exc
    return source


def build_ingest_artifact(
    project_dir: Path,
    manifest: dict[str, Any],
    *,
    run_probe: Callable[[list[str]], subprocess.CompletedProcess[str]] = _default_probe,
    fingerprint: Callable[[Path], str] = fingerprint_file,
) -> dict[str, Any]:
    source = manifest["source"]
    if source["type"] == "url":
        raise _error(
            "url_ingest_not_implemented",
            "URL ingest is reserved by the version-1 contract but is not implemented.",
            "Choose a local file source and retry ingest.",
        )
    if source["type"] != "local_file":
        raise _error(
            "source_type_unsupported",
            f"The source type {source['type']!r} cannot be ingested.",
            "Choose a local file source and retry ingest.",
        )
    source_path = resolve_local_source(project_dir, source["uri"])
    try:
        before = _file_signature(source_path)
        first_fingerprint = fingerprint(source_path)
        after_fingerprint = _file_signature(source_path)
        probe = probe_media(source_path, run_probe=run_probe)
        after_probe = _file_signature(source_path)
        verified_fingerprint = fingerprint(source_path)
        final = _file_signature(source_path)
    except FileNotFoundError as exc:
        raise _error(
            "source_changed_during_ingest",
            "The source file moved or disappeared while ingest was running.",
            "Restore or reselect the local file, then retry ingest.",
        ) from exc
    except OSError as exc:
        raise _error(
            "source_not_readable",
            f"The source could not be read during ingest: {exc}.",
            "Check the file permissions and retry ingest.",
        ) from exc
    if not (before == after_fingerprint == after_probe == final) or first_fingerprint != verified_fingerprint:
        raise _error(
            "source_changed_during_ingest",
            "The source file changed while it was being fingerprinted or probed.",
            "Wait for the file to finish changing, then retry ingest.",
        )
    normalized = normalize_probe(probe)
    artifact = {
        "artifact_version": INGEST_ARTIFACT_VERSION,
        "engine_version": ENGINE_VERSION,
        "source": {
            "path": str(source_path),
            "byte_size": final[2],
            "fingerprint": verified_fingerprint,
        },
        **normalized,
    }
    validate_document("ingest_artifact", artifact)
    return artifact


def write_ingest_artifact(project_dir: Path, artifact: dict[str, Any]) -> Path:
    """Validate and atomically replace the versioned artifact inside project_dir."""

    validate_document("ingest_artifact", artifact)
    destination = (project_dir / INGEST_ARTIFACT_RELATIVE_PATH).resolve()
    project_root = project_dir.resolve()
    if project_root not in destination.parents:
        raise RuntimeError("ingest artifact path escaped the project directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(artifact, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def ingest_project(
    project_dir: Path,
    manifest: dict[str, Any],
    *,
    run_probe: Callable[[list[str]], subprocess.CompletedProcess[str]] = _default_probe,
    fingerprint: Callable[[Path], str] = fingerprint_file,
) -> tuple[dict[str, Any], Path]:
    artifact = build_ingest_artifact(
        project_dir,
        manifest,
        run_probe=run_probe,
        fingerprint=fingerprint,
    )
    return artifact, write_ingest_artifact(project_dir, artifact)
