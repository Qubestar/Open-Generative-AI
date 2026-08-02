"""Local-only, cache-safe faster-whisper transcription for Repurpose."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .contracts import (
    TRANSCRIPT_ARTIFACT_VERSION,
    ContractValidationError,
    validate_document,
)
from .ingest import fingerprint_file

ENGINE_VERSION = "0.1.0"
DEFAULT_MODEL = "small"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"
TRANSCRIPT_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "transcript-artifact.v1.json"
MODEL_READY_MARKER = ".vidmyo-model-ready.json"
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_DEVICES = frozenset({"cpu", "cuda", "auto"})
_COMPUTE_TYPES = frozenset({
    "default", "auto", "int8", "int8_float16", "int8_float32", "int8_bfloat16",
    "int16", "float16", "float32", "bfloat16",
})


@dataclass(frozen=True)
class TranscriptionError(Exception):
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


@dataclass(frozen=True)
class TranscriptionSettings:
    model: str = DEFAULT_MODEL
    language: str | None = None
    device: str = DEFAULT_DEVICE
    compute_type: str = DEFAULT_COMPUTE_TYPE

    def cache_document(self) -> dict[str, str | None]:
        return {
            "model": self.model,
            "language": self.language,
            "device": self.device,
            "compute_type": self.compute_type,
            "word_timestamps": True,
        }


@dataclass(frozen=True)
class TranscriptionResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> TranscriptionError:
    return TranscriptionError(
        code=code,
        message=message,
        preserved=(
            "The completed ingest artifact and any earlier valid transcript were preserved; "
            "no partial transcript replaced them."
        ),
        next_action=next_action,
    )


def cancellation_error() -> TranscriptionError:
    return _error(
        "transcription_cancelled",
        "Transcription was cancelled at a safe boundary.",
        "Retry the same transcribe request to reuse a matching completed cache or start safely again.",
    )


def default_model_cache() -> Path:
    configured = os.environ.get("VIDMYO_REPURPOSE_MODEL_CACHE")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".cache" / "vidmyo" / "repurpose" / "faster-whisper").resolve()


def normalize_model_name(model: Any) -> str:
    if not isinstance(model, str) or not _MODEL_RE.fullmatch(model.strip()):
        raise ContractValidationError(
            "options.model: must use letters, digits, dots, underscores, or hyphens"
        )
    return model.strip()


def normalize_settings(options: dict[str, Any] | None) -> TranscriptionSettings:
    options = options or {}
    if not isinstance(options, dict):
        raise ContractValidationError("options: must be an object")
    unknown = sorted(set(options) - {"model", "language", "device", "compute_type", "model_cache"})
    if unknown:
        raise ContractValidationError(f"options.{unknown[0]}: unsupported transcribe option")
    model = normalize_model_name(options.get("model", DEFAULT_MODEL))
    language = options.get("language")
    if language is not None:
        if not isinstance(language, str) or not _LANGUAGE_RE.fullmatch(language.strip()):
            raise ContractValidationError("options.language: must be a valid language code or null")
        language = language.strip().lower()
    device = options.get("device", DEFAULT_DEVICE)
    if device not in _DEVICES:
        raise ContractValidationError(f"options.device: must be one of {sorted(_DEVICES)}")
    compute_type = options.get("compute_type", DEFAULT_COMPUTE_TYPE)
    if compute_type not in _COMPUTE_TYPES:
        raise ContractValidationError(
            f"options.compute_type: must be one of {sorted(_COMPUTE_TYPES)}"
        )
    model_cache = options.get("model_cache")
    if model_cache is not None and (not isinstance(model_cache, str) or not model_cache.strip()):
        raise ContractValidationError("options.model_cache: must be a non-empty path string")
    return TranscriptionSettings(model, language, device, compute_type)


def resolve_model_cache(options: dict[str, Any] | None = None, override: str | Path | None = None) -> Path:
    value: str | Path | None = override
    if value is None and isinstance(options, dict):
        value = options.get("model_cache")
    return Path(value).expanduser().resolve() if value is not None else default_model_cache()


def model_directory(model: str, cache_dir: Path) -> Path:
    return cache_dir / normalize_model_name(model)


def faster_whisper_version() -> str | None:
    try:
        return importlib.metadata.version("faster-whisper")
    except importlib.metadata.PackageNotFoundError:
        return None


def _supported_library_version(version: str | None) -> bool:
    if version is None:
        return False
    match = re.match(r"^(\d+)\.(\d+)(?:\.|$)", version)
    return bool(match and (int(match.group(1)), int(match.group(2))) == (1, 2))


def _setup_command(model: str, cache_dir: Path) -> str:
    return (
        f"vidmyo-repurpose setup-model --model {model} "
        f"--model-cache {json.dumps(str(cache_dir))}"
    )


def inspect_model(model: str = DEFAULT_MODEL, cache_dir: Path | None = None) -> dict[str, Any]:
    """Read model readiness without creating directories or opening a model."""

    model = normalize_model_name(model)
    cache_dir = (cache_dir or default_model_cache()).expanduser().resolve()
    directory = model_directory(model, cache_dir)
    version = faster_whisper_version()
    dependency_available = (
        importlib.util.find_spec("faster_whisper") is not None
        and _supported_library_version(version)
    )
    marker_path = directory / MODEL_READY_MARKER
    marker_valid = False
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker_valid = (
            marker.get("model") == model
            and marker.get("engine") == "faster-whisper"
            and marker.get("verified") is True
        )
    except (OSError, json.JSONDecodeError, AttributeError):
        marker_valid = False
    required_files = [directory / "config.json", directory / "model.bin"]
    model_ready = dependency_available and marker_valid and all(path.is_file() for path in required_files)
    setup_command = _setup_command(model, cache_dir)
    return {
        "ok": model_ready,
        "dependency": {
            "name": "faster-whisper",
            "required_version": ">=1.2,<1.3",
            "installed_version": version,
            "available": dependency_available,
        },
        "model": model,
        "model_cache": str(cache_dir),
        "model_path": str(directory),
        "model_ready": model_ready,
        "setup_command": None if model_ready else setup_command,
        "message": (
            f"faster-whisper model '{model}' is ready locally."
            if model_ready
            else f"Model '{model}' is not fully available locally. Run exactly: {setup_command}"
        ),
    }


def _default_download(model: str, destination: Path) -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=f"Systran/faster-whisper-{model}",
        local_dir=str(destination),
    )


def _default_model_open(path: Path, *, device: str, compute_type: str) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(
        str(path),
        device=device,
        compute_type=compute_type,
        local_files_only=True,
    )


def setup_model(
    model: str = DEFAULT_MODEL,
    cache_dir: Path | None = None,
    *,
    download: Callable[[str, Path], None] = _default_download,
    open_model: Callable[..., Any] = _default_model_open,
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
) -> dict[str, Any]:
    """Explicitly download and verify a model; no other code path calls a downloader."""

    model = normalize_model_name(model)
    cache_dir = (cache_dir or default_model_cache()).expanduser().resolve()
    existing = inspect_model(model, cache_dir)
    if existing["model_ready"]:
        progress({"phase": "ready", "percent": 100, "message": "model already ready"})
        return existing
    if not _supported_library_version(faster_whisper_version()):
        raise _error(
            "faster_whisper_not_installed",
            "faster-whisper 1.2.x is not installed.",
            "Install the Vidmyo Repurpose package dependencies, then rerun setup-model.",
        )
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = model_directory(model, cache_dir)
    staging: Path | None = Path(tempfile.mkdtemp(prefix=f".{model}.", dir=cache_dir))
    backup: Path | None = None
    try:
        progress({"phase": "download", "percent": 5, "message": f"downloading model {model}"})
        download(model, staging)
        progress({"phase": "verify", "percent": 90, "message": "verifying cached model"})
        open_model(staging, device=DEFAULT_DEVICE, compute_type=DEFAULT_COMPUTE_TYPE)
        for required in (staging / "config.json", staging / "model.bin"):
            if not required.is_file():
                raise RuntimeError(f"downloaded model is missing {required.name}")
        marker = {
            "engine": "faster-whisper",
            "model": model,
            "verified": True,
            "library_version": faster_whisper_version(),
        }
        (staging / MODEL_READY_MARKER).write_text(
            json.dumps(marker, indent=2) + "\n", encoding="utf-8"
        )
        if destination.exists():
            backup = cache_dir / f".{model}.previous"
            if backup.exists():
                shutil.rmtree(backup)
            os.replace(destination, backup)
        os.replace(staging, destination)
        staging = None
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
            backup = None
        progress({"phase": "ready", "percent": 100, "message": "model setup complete"})
        result = inspect_model(model, cache_dir)
        if not result["model_ready"]:
            raise RuntimeError("verified model did not pass the final readiness check")
        return result
    except TranscriptionError:
        raise
    except Exception as exc:
        if backup is not None and backup.exists() and not destination.exists():
            os.replace(backup, destination)
            backup = None
        raise _error(
            "transcription_model_setup_failed",
            f"Model setup failed: {exc}.",
            "Check network access and free disk space, then explicitly rerun setup-model.",
        ) from exc
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if backup is not None and backup.exists():
            shutil.rmtree(backup, ignore_errors=True)


def cache_key(source_fingerprint: str, settings: TranscriptionSettings) -> str:
    document = {
        "source_fingerprint": source_fingerprint,
        "settings": settings.cache_document(),
    }
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _inside_project(project_dir: Path, relative_path: str) -> Path:
    candidate = (project_dir / relative_path).resolve()
    try:
        candidate.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise _error(
            "ingest_artifact_invalid",
            "The ingest artifact path escapes the selected project.",
            "Use the completed ingest artifact inside the same Repurpose project.",
        ) from exc
    return candidate


def _load_ingest(request: dict[str, Any], project_dir: Path) -> tuple[dict[str, Any], Path]:
    manifest_path = project_dir / "repurpose.json"
    try:
        manifest = validate_document(
            "manifest", json.loads(manifest_path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "project_manifest_invalid",
            f"The Repurpose project manifest is missing or invalid: {exc}.",
            "Repair or recreate the project, rerun ingest, and retry transcription.",
        ) from exc
    ingest_stage = manifest["stages"]["ingest"]
    if ingest_stage["state"] != "completed" or not ingest_stage["artifact"]:
        raise _error(
            "ingest_not_completed",
            "The project's ingest stage is not completed with an artifact.",
            "Run ingest successfully before transcription.",
        )
    descriptors = [
        item for item in request["input_artifacts"]
        if item["kind"] == "ingest_artifact" and item.get("version") == 1
    ]
    if len(descriptors) != 1 or descriptors[0]["path"] != ingest_stage["artifact"]:
        raise _error(
            "ingest_artifact_invalid",
            "The transcribe request must name the project's completed version-1 ingest artifact.",
            "Rebuild the request from the current completed ingest stage and retry.",
        )
    artifact_path = _inside_project(project_dir, descriptors[0]["path"])
    try:
        artifact = validate_document(
            "ingest_artifact", json.loads(artifact_path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "ingest_artifact_invalid",
            f"The completed ingest artifact is missing or invalid: {exc}.",
            "Rerun ingest to recreate a valid artifact, then retry transcription.",
        ) from exc
    source_path = Path(artifact["source"]["path"]).resolve()
    manifest_source = Path(manifest["source"]["uri"]).expanduser()
    if not manifest_source.is_absolute():
        manifest_source = project_dir / manifest_source
    manifest_source = manifest_source.resolve()
    if (
        manifest["source"]["type"] != "local_file"
        or manifest_source != source_path
        or manifest["source"]["fingerprint"] != artifact["source"]["fingerprint"]
    ):
        raise _error(
            "ingest_artifact_stale",
            "The project source no longer matches its completed ingest artifact.",
            "Rerun ingest for the current local source before transcription.",
        )
    try:
        current_fingerprint = fingerprint_file(source_path)
        current_size = source_path.stat().st_size
    except OSError as exc:
        raise _error(
            "source_missing",
            f"The ingested local source cannot be read: {source_path} ({exc}).",
            "Restore the source file or select and ingest it again.",
        ) from exc
    if (
        current_fingerprint != artifact["source"]["fingerprint"]
        or current_size != artifact["source"]["byte_size"]
    ):
        raise _error(
            "source_changed_since_ingest",
            "The source bytes changed after ingest, so transcription was stopped before inference.",
            "Rerun ingest to fingerprint the current source, then retry transcription.",
        )
    return artifact, source_path


def _value(item: Any, name: str, default: Any = None) -> Any:
    return item.get(name, default) if isinstance(item, dict) else getattr(item, name, default)


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} is not a finite number")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{field} is not a finite non-negative number")
    return number


def _confidence(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > 1:
        raise ValueError("confidence must be finite and between zero and one")
    return number


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _segment_confidence(segment: Any) -> float | None:
    direct = _value(segment, "confidence")
    if direct is not None:
        return _confidence(direct)
    average_log_probability = _value(segment, "avg_logprob")
    if average_log_probability is None:
        return None
    value = float(average_log_probability)
    if not math.isfinite(value):
        raise ValueError("avg_logprob must be finite")
    return max(0.0, min(1.0, math.exp(value)))


def normalize_segments(
    backend_segments: Iterable[Any],
    *,
    duration_seconds: float,
    cancelled: Callable[[], bool] = lambda: False,
    on_segment: Callable[[float], None] = lambda _processed: None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    for backend_segment in backend_segments:
        if cancelled():
            raise cancellation_error()
        segment_text = _normalize_text(_value(backend_segment, "text"))
        raw_words = list(_value(backend_segment, "words", []) or [])
        normalized_words: list[tuple[float, float, str, float | None]] = []
        for raw_word in raw_words:
            text = _normalize_text(_value(raw_word, "word", _value(raw_word, "text")))
            if not text:
                continue
            normalized_words.append((
                _number(_value(raw_word, "start"), "word.start"),
                _number(_value(raw_word, "end"), "word.end"),
                text,
                _confidence(_value(raw_word, "probability", _value(raw_word, "confidence"))),
            ))
        if not segment_text and normalized_words:
            segment_text = " ".join(word[2] for word in normalized_words)
        if not segment_text:
            continue
        segment_id = f"segment_{len(segments) + 1:06d}"
        start = _number(_value(backend_segment, "start"), "segment.start")
        end = _number(_value(backend_segment, "end"), "segment.end")
        word_ids: list[str] = []
        for word_start, word_end, text, confidence in normalized_words:
            word_id = f"word_{len(words) + 1:06d}"
            word_ids.append(word_id)
            words.append({
                "id": word_id,
                "segment_id": segment_id,
                "start_seconds": word_start,
                "end_seconds": word_end,
                "text": text,
                "confidence": confidence,
            })
        segments.append({
            "id": segment_id,
            "start_seconds": start,
            "end_seconds": end,
            "text": segment_text,
            "confidence": _segment_confidence(backend_segment),
            "word_ids": word_ids,
        })
        on_segment(min(end, duration_seconds))
    if cancelled():
        raise cancellation_error()
    return segments, words


def write_transcript_artifact(
    project_dir: Path,
    artifact: dict[str, Any],
    *,
    replace: Callable[[str | bytes | os.PathLike[str], str | bytes | os.PathLike[str]], None] = os.replace,
) -> Path:
    validate_document("transcript_artifact", artifact)
    destination = (project_dir / TRANSCRIPT_ARTIFACT_RELATIVE_PATH).resolve()
    try:
        destination.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise RuntimeError("transcript artifact path escaped the project directory") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=destination.parent,
            prefix=f".{destination.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(artifact, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def _matching_cache(
    path: Path,
    *,
    source_path: Path,
    source_fingerprint: str,
    expected_key: str,
    settings: TranscriptionSettings,
) -> dict[str, Any] | None:
    try:
        artifact = validate_document(
            "transcript_artifact", json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError):
        return None
    metadata = artifact["transcription"]
    if (
        artifact["engine_version"] != ENGINE_VERSION
        or artifact["source"] != {
            "path": str(source_path), "fingerprint": source_fingerprint,
        }
        or artifact["cache_key"] != expected_key
        or metadata["model"] != settings.model
        or metadata["device"] != settings.device
        or metadata["compute_type"] != settings.compute_type
        or metadata["requested_language"] != settings.language
        or metadata["word_timestamps"] is not True
    ):
        return None
    return artifact


def _default_model_factory(path: Path, settings: TranscriptionSettings) -> Any:
    return _default_model_open(path, device=settings.device, compute_type=settings.compute_type)


def transcribe_project(
    request: dict[str, Any],
    *,
    model_factory: Callable[[Path, TranscriptionSettings], Any] = _default_model_factory,
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    library_version: Callable[[], str | None] = faster_whisper_version,
    writer: Callable[[Path, dict[str, Any]], Path] = write_transcript_artifact,
) -> TranscriptionResult:
    request = validate_document("request", request)
    if request["stage"] != "transcribe":
        raise ContractValidationError("stage: transcribe command requires stage 'transcribe'")
    settings = normalize_settings(request["options"])
    model_cache = resolve_model_cache(request["options"])
    project_dir = Path(request["project_dir"]).expanduser().resolve()
    if cancelled():
        raise cancellation_error()
    progress({
        "phase": "input_validation", "fraction": 0.05, "percent": 5,
        "processed_seconds": 0.0, "total_seconds": None, "cache_hit": False,
        "message": "validating completed ingest artifact and current source",
    })
    ingest, source_path = _load_ingest(request, project_dir)
    duration = float(ingest["container"]["duration_seconds"])
    source_fingerprint = ingest["source"]["fingerprint"]
    expected_key = cache_key(source_fingerprint, settings)
    transcript_path = project_dir / TRANSCRIPT_ARTIFACT_RELATIVE_PATH
    cached = _matching_cache(
        transcript_path, source_path=source_path, source_fingerprint=source_fingerprint,
        expected_key=expected_key, settings=settings,
    )
    if cached is not None:
        progress({
            "phase": "cache_hit", "fraction": 1.0, "percent": 100,
            "processed_seconds": duration, "total_seconds": duration, "cache_hit": True,
            "message": "reusing matching validated transcript artifact",
        })
        return TranscriptionResult(cached, transcript_path, True)
    if cancelled():
        raise cancellation_error()
    readiness = inspect_model(settings.model, model_cache)
    if not readiness["model_ready"]:
        raise _error(
            "transcription_model_not_ready",
            f"The local faster-whisper model '{settings.model}' is not ready.",
            f"Run exactly: {readiness['setup_command']}",
        )
    version = library_version()
    if not _supported_library_version(version):
        raise _error(
            "faster_whisper_not_installed",
            "faster-whisper 1.2.x is not installed.",
            "Install the Vidmyo Repurpose dependencies, then retry transcription.",
        )
    progress({
        "phase": "model_loading", "fraction": 0.15, "percent": 15,
        "processed_seconds": 0.0, "total_seconds": duration, "cache_hit": False,
        "message": f"loading local model {settings.model}",
    })
    if cancelled():
        raise cancellation_error()
    try:
        model = model_factory(model_directory(settings.model, model_cache), settings)
    except Exception as exc:
        raise _error(
            "transcription_model_load_failed",
            f"The ready local transcription model could not be opened: {exc}.",
            "Run doctor, explicitly rerun setup-model if needed, then retry transcription.",
        ) from exc
    if cancelled():
        raise cancellation_error()
    progress({
        "phase": "transcription", "fraction": 0.2, "percent": 20,
        "processed_seconds": 0.0, "total_seconds": duration, "cache_hit": False,
        "message": "transcribing locally with word timestamps",
    })
    try:
        backend_segments, info = model.transcribe(
            str(source_path), language=settings.language, word_timestamps=True,
        )

        def segment_progress(processed: float) -> None:
            fraction = min(0.95, 0.2 + 0.75 * (processed / duration))
            progress({
                "phase": "transcription", "fraction": fraction,
                "percent": round(fraction * 100, 3),
                "processed_seconds": processed, "total_seconds": duration,
                "cache_hit": False, "message": "transcribing locally",
            })

        segments, words = normalize_segments(
            backend_segments, duration_seconds=duration,
            cancelled=cancelled, on_segment=segment_progress,
        )
    except TranscriptionError:
        raise
    except (ValueError, TypeError, ContractValidationError) as exc:
        raise _error(
            "transcription_backend_output_invalid",
            f"The transcription backend returned invalid timestamps or metadata: {exc}.",
            "Retry after checking the local model; the existing ingest artifact is safe.",
        ) from exc
    except Exception as exc:
        raise _error(
            "transcription_inference_failed",
            f"Local transcription failed: {exc}.",
            "Check local compute and model readiness, then retry from the preserved ingest artifact.",
        ) from exc
    if cancelled():
        raise cancellation_error()
    try:
        if fingerprint_file(source_path) != source_fingerprint:
            raise _error(
                "source_changed_during_transcription",
                "The source bytes changed while transcription was running.",
                "Rerun ingest for the current source, then retry transcription.",
            )
    except TranscriptionError:
        raise
    except OSError as exc:
        raise _error(
            "source_changed_during_transcription",
            f"The source became unreadable during transcription: {exc}.",
            "Restore the source, rerun ingest if needed, and retry.",
        ) from exc
    detected_language = _value(info, "language")
    if detected_language is not None:
        detected_language = str(detected_language).strip().lower() or None
    try:
        language_confidence = _confidence(_value(info, "language_probability"))
        artifact = {
            "artifact_version": TRANSCRIPT_ARTIFACT_VERSION,
            "engine_version": ENGINE_VERSION,
            "created_at": clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": {"path": str(source_path), "fingerprint": source_fingerprint},
            "cache_key": expected_key,
            "transcription": {
                "engine": "faster-whisper", "library_version": version,
                "model": settings.model, "device": settings.device,
                "compute_type": settings.compute_type, "word_timestamps": True,
                "requested_language": settings.language,
                "detected_language": detected_language,
                "language_confidence": language_confidence,
            },
            "duration_seconds": duration,
            "speech_detected": bool(segments or words),
            "segments": segments,
            "words": words,
        }
        validate_document("transcript_artifact", artifact)
    except (ValueError, TypeError, ContractValidationError) as exc:
        raise _error(
            "transcription_backend_output_invalid",
            f"The normalized transcript is invalid: {exc}.",
            "Retry after checking the local model; the prior validated artifacts are preserved.",
        ) from exc
    progress({
        "phase": "artifact_write", "fraction": 0.98, "percent": 98,
        "processed_seconds": duration, "total_seconds": duration, "cache_hit": False,
        "message": "validating and atomically writing transcript artifact",
    })
    if cancelled():
        raise cancellation_error()
    try:
        path = writer(project_dir, artifact)
    except Exception as exc:
        raise _error(
            "transcription_artifact_write_failed",
            f"The validated transcript could not be written atomically: {exc}.",
            "Check project permissions and free disk space, then retry safely.",
        ) from exc
    return TranscriptionResult(artifact, path, False)
