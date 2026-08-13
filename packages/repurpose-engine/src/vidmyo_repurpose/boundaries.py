"""Word-safe boundary repair and local source-aspect preview extraction."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .candidates import _atomic_json
from .contracts import BOUNDARY_ARTIFACT_VERSION, ContractValidationError, validate_document
from .ingest import fingerprint_file

ENGINE_VERSION = "0.1.0"
BOUNDARY_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "boundary-artifact.v1.json"
PREVIEW_DIRECTORY = Path("artifacts") / "preview-clips"
SCHEMA_VERSION = "boundary-artifact.v1"
REPAIR_VERSION = "word-silence-repair.v1"
ENCODER_VERSION = "preview-h264-aac.v1"
MIN_DURATION = 20.0
MAX_DURATION = 120.0
SILENCE_NOISE_DB = -35.0
SILENCE_MINIMUM = 0.25
SILENCE_SEARCH = 1.5
_SILENCE_START = re.compile(r"silence_start:\s*([0-9]+(?:\.[0-9]+)?)")
_SILENCE_END = re.compile(r"silence_end:\s*([0-9]+(?:\.[0-9]+)?)")


@dataclass(frozen=True)
class BoundaryError(Exception):
    code: str
    message: str
    preserved: str
    next_action: str

    def __str__(self) -> str:
        return self.message

    def payload(self) -> dict[str, str]:
        return {
            "code": self.code, "message": self.message,
            "preserved": self.preserved, "next_action": self.next_action,
        }


@dataclass(frozen=True)
class BoundaryResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> BoundaryError:
    return BoundaryError(
        code, message[:1000],
        "The source, upstream artifacts, completed preview clips, and earlier valid boundary artifact were preserved.",
        next_action,
    )


def cancellation_error() -> BoundaryError:
    return _error(
        "boundary_repair_cancelled",
        "Boundary repair and preview extraction were cancelled at a safe clip boundary.",
        "Retry the same request to reuse completed validated preview clips.",
    )


def _hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _inside(project: Path, relative: str) -> Path:
    path = (project / relative).resolve()
    try:
        path.relative_to(project.resolve())
    except ValueError as exc:
        raise ContractValidationError(f"path: escapes project: {relative}") from exc
    return path


def _descriptor(request: Mapping[str, Any], kind: str, expected: str) -> Path:
    matches = [
        item for item in request["input_artifacts"]
        if item["kind"] == kind and item.get("version") == 1
    ]
    if len(matches) != 1 or matches[0]["path"] != expected:
        raise ContractValidationError(f"input_artifacts: must name current {kind}")
    return Path(matches[0]["path"])


def _load_inputs(request: dict[str, Any]) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    project = Path(request["project_dir"]).expanduser().resolve()
    try:
        manifest = validate_document("manifest", json.loads((project / "repurpose.json").read_text()))
        required = {
            "ingest_artifact": manifest["stages"]["ingest"],
            "transcript_artifact": manifest["stages"]["transcribe"],
            "ranking_artifact": manifest["stages"]["rank"],
        }
        for kind, stage in required.items():
            if stage["state"] != "completed" or not stage["artifact"]:
                raise ContractValidationError(f"stages.{kind}: must be completed")
        paths = {kind: _descriptor(request, kind, stage["artifact"]) for kind, stage in required.items()}
        ingest = validate_document("ingest_artifact", json.loads(_inside(project, paths["ingest_artifact"].as_posix()).read_text()))
        transcript = validate_document("transcript_artifact", json.loads(_inside(project, paths["transcript_artifact"].as_posix()).read_text()))
        ranking = validate_document("ranking_artifact", json.loads(_inside(project, paths["ranking_artifact"].as_posix()).read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "boundary_input_invalid", f"Boundary inputs are missing, stale, or invalid: {exc}.",
            "Complete ingest, transcription, and ranking for the current local source, then retry.",
        ) from exc
    fingerprint = manifest["source"]["fingerprint"]
    if manifest["source"]["type"] != "local_file":
        raise _error("boundary_url_not_supported", "Preview extraction supports local-file projects only.", "Use a local source file.")
    if not fingerprint or ingest["source"]["fingerprint"] != fingerprint or transcript["source"]["fingerprint"] != fingerprint or ranking["source"]["fingerprint"] != fingerprint:
        raise _error("boundary_input_stale", "The completed artifacts do not match the current source fingerprint.", "Rerun the earlier stages for the current source.")
    if ranking["source"]["transcript_cache_key"] != transcript["cache_key"]:
        raise _error("boundary_input_stale", "The ranking artifact does not match the current transcript.", "Rerun ranking from the current transcript.")
    source = Path(ingest["source"]["path"]).resolve()
    if source != Path(manifest["source"]["uri"]).expanduser().resolve() or not source.is_file():
        raise _error("boundary_source_missing", "The ingested local source is missing or changed location.", "Restore the source or rerun ingest.")
    if fingerprint_file(source) != fingerprint:
        raise _error("boundary_source_changed", "The local source bytes changed after ingest.", "Rerun ingest and every downstream stage for the changed source.")
    return project, ingest, transcript, ranking, manifest


def parse_silences(stderr: str, source_duration: float) -> list[dict[str, float]]:
    intervals: list[dict[str, float]] = []
    pending: float | None = None
    for line in stderr.splitlines():
        start = _SILENCE_START.search(line)
        end = _SILENCE_END.search(line)
        if start:
            pending = float(start.group(1))
        if end:
            end_value = float(end.group(1))
            if pending is not None and end_value >= pending:
                intervals.append({"start_seconds": pending, "end_seconds": end_value})
            pending = None
    if pending is not None and source_duration >= pending:
        intervals.append({"start_seconds": pending, "end_seconds": source_duration})
    return intervals


def detect_silences(source: Path, source_duration: float, *, runner: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> list[dict[str, float]]:
    command = [
        "ffmpeg", "-hide_banner", "-nostdin", "-i", str(source),
        "-vn", "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MINIMUM}",
        "-f", "null", "-",
    ]
    try:
        result = runner(command)
    except (FileNotFoundError, OSError) as exc:
        raise _error("ffmpeg_not_available", f"FFmpeg could not start: {exc}.", "Install FFmpeg and retry.") from exc
    if result.returncode != 0:
        raise _error("silence_detection_failed", "FFmpeg could not analyze source silence.", "Check the source and FFmpeg installation, then retry.")
    return parse_silences(result.stderr or "", source_duration)


def repair_span(candidate: Mapping[str, Any], words: Mapping[str, Any], silences: list[dict[str, float]], source_duration: float, override: Mapping[str, str] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    proposed = candidate["candidate"]["proposed_span"]
    first_id = override["first_word_id"] if override else proposed["first_word_id"]
    last_id = override["last_word_id"] if override else proposed["last_word_id"]
    if first_id not in words or last_id not in words:
        raise ContractValidationError("boundary_overrides: unknown word id")
    first, last = words[first_id], words[last_id]
    if first["start_seconds"] > last["end_seconds"]:
        raise ContractValidationError("boundary_overrides: reversed words")
    start, end = float(first["start_seconds"]), float(last["end_seconds"])
    if end - start < MIN_DURATION or end - start > MAX_DURATION:
        raise ContractValidationError("boundary_overrides: repaired duration must be 20–120 seconds")
    start_silence = end_silence = None
    start_reason = end_reason = "manual_word_override" if override else "word_boundary"
    if not override:
        before = [item for item in silences if start - SILENCE_SEARCH <= item["end_seconds"] <= start]
        after = [item for item in silences if end <= item["start_seconds"] <= end + SILENCE_SEARCH]
        if before:
            selected = sorted(before, key=lambda item: (start - item["end_seconds"], -item["end_seconds"]))[0]
            if end - selected["end_seconds"] <= MAX_DURATION:
                start, start_silence, start_reason = selected["end_seconds"], selected, "nearby_silence"
        if after:
            selected = sorted(after, key=lambda item: (item["start_seconds"] - end, item["start_seconds"]))[0]
            if selected["start_seconds"] - start <= MAX_DURATION:
                end, end_silence, end_reason = selected["start_seconds"], selected, "nearby_silence"
    start, end = max(0.0, start), min(source_duration, end)
    return (
        {"first_word_id": first_id, "last_word_id": last_id, "start_seconds": round(start, 6), "end_seconds": round(end, 6)},
        {"start_reason": start_reason, "end_reason": end_reason, "start_silence": start_silence, "end_silence": end_silence, "override_applied": bool(override)},
    )


def _probe_preview(path: Path, expected_duration: float, tolerance: float, *, runner: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> float:
    command = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    try:
        result = runner(command)
        document = json.loads(result.stdout)
        streams = document["streams"]
        duration = float(document["format"]["duration"])
    except (FileNotFoundError, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise _error("preview_validation_failed", f"The extracted preview could not be validated: {exc}.", "Check FFmpeg and retry extraction.") from exc
    if result.returncode != 0 or not any(item.get("codec_type") == "video" for item in streams) or not any(item.get("codec_type") == "audio" for item in streams):
        raise _error("preview_validation_failed", "The extracted preview lacks readable video or audio.", "Check the source and FFmpeg installation, then retry.")
    if abs(duration - expected_duration) > tolerance:
        raise _error("preview_duration_mismatch", f"Preview duration {duration:.3f}s does not match repaired span {expected_duration:.3f}s.", "Retry with a working FFmpeg build.")
    return round(duration, 6)


def _extract(source: Path, destination: Path, start: float, end: float, tolerance: float, *, ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]], ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.stem}.{os.getpid()}.tmp.mp4"
    command = [
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{start:.6f}", "-i", str(source), "-t", f"{end - start:.6f}",
        "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium",
        "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", str(temporary),
    ]
    try:
        try:
            result = ffmpeg(command)
        except (FileNotFoundError, OSError) as exc:
            raise _error(
                "ffmpeg_not_available",
                f"FFmpeg could not start preview extraction: {exc}.",
                "Install FFmpeg and retry extraction.",
            ) from exc
        if result.returncode != 0 or not temporary.is_file():
            raise _error("preview_extraction_failed", "FFmpeg did not create a complete preview clip.", "Check source codecs, disk space, and FFmpeg, then retry.")
        duration = _probe_preview(temporary, end - start, tolerance, runner=ffprobe)
        os.replace(temporary, destination)
        return {"requested": True, "state": "completed", "path": destination.as_posix(), "fingerprint": fingerprint_file(destination), "duration_seconds": duration}
    finally:
        temporary.unlink(missing_ok=True)


def repair_and_extract(
    request: dict[str, Any], *,
    ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> BoundaryResult:
    progress({"phase": "validating_inputs", "fraction": 0.02, "cache_hit": False, "message": "validating boundary inputs"})
    project, ingest, transcript, ranking, _manifest = _load_inputs(request)
    options = request["options"]
    if not isinstance(options, dict) or set(options) - {"candidate_ids", "boundary_overrides"}:
        raise ContractValidationError("options: only candidate_ids and boundary_overrides are supported")
    all_ids = [item["candidate"]["id"] for item in ranking["candidates"]]
    requested = options.get("candidate_ids", ranking["shortlist_candidate_ids"])
    if not isinstance(requested, list) or len(requested) != len(set(requested)) or any(item not in all_ids for item in requested):
        raise ContractValidationError("options.candidate_ids: must be unique retained candidate ids")
    overrides = options.get("boundary_overrides", {})
    if not isinstance(overrides, dict) or any(item not in all_ids for item in overrides):
        raise ContractValidationError("options.boundary_overrides: must name retained candidates")
    words = {item["id"]: item for item in transcript["words"]}
    duration = float(transcript["duration_seconds"])
    frame_rate = ingest["video"].get("average_frame_rate") or 30.0
    tolerance = round(max(0.15, 2.0 / float(frame_rate)), 6)
    source = Path(ingest["source"]["path"])
    settings = {
        "minimum_duration_seconds": MIN_DURATION, "maximum_duration_seconds": MAX_DURATION,
        "silence_noise_db": SILENCE_NOISE_DB, "silence_minimum_seconds": SILENCE_MINIMUM,
        "silence_search_seconds": SILENCE_SEARCH, "duration_tolerance_seconds": tolerance,
    }
    versions = {"schema": SCHEMA_VERSION, "repair": REPAIR_VERSION, "encoder": ENCODER_VERSION}
    source_identity = {"fingerprint": ingest["source"]["fingerprint"], "transcript_cache_key": transcript["cache_key"], "ranking_cache_key": ranking["cache_key"]}
    artifact_path = project / BOUNDARY_ARTIFACT_RELATIVE_PATH
    previous: dict[str, Any] | None = None
    try:
        previous = validate_document("boundary_artifact", json.loads(artifact_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError):
        pass
    cache_key = _hash({"source": source_identity, "versions": versions, "settings": settings, "requested": requested, "overrides": overrides})
    silences = detect_silences(source, duration, runner=ffmpeg)
    progress({"phase": "silence_analyzed", "fraction": 0.15, "cache_hit": False, "message": "detected reusable silence intervals"})
    previous_by_id = {item["candidate_id"]: item for item in previous["candidates"]} if previous else {}
    entries = []
    for ranked in ranking["candidates"]:
        candidate_id = ranked["candidate"]["id"]
        override = overrides.get(candidate_id)
        if override is not None and (not isinstance(override, dict) or set(override) != {"first_word_id", "last_word_id"}):
            raise ContractValidationError(f"options.boundary_overrides.{candidate_id}: requires first_word_id and last_word_id")
        repaired, repair = repair_span(ranked, words, silences, duration, override)
        proposed = ranked["candidate"]["proposed_span"]
        proposed_span = {key: proposed[key] for key in ("first_word_id", "last_word_id", "start_seconds", "end_seconds")}
        extraction_key = _hash({
            "source_fingerprint": source_identity["fingerprint"],
            "candidate_id": candidate_id,
            "proposed_span": proposed_span,
            "repaired_span": repaired,
            "versions": versions,
            "settings": settings,
        })
        is_requested = candidate_id in requested
        extraction = {"requested": is_requested, "state": "pending" if is_requested else "not_requested", "path": None, "fingerprint": None, "duration_seconds": None}
        old = previous_by_id.get(candidate_id)
        destination = project / PREVIEW_DIRECTORY / f"{candidate_id}.source.mp4"
        if candidate_id in requested and old and old["extraction_key"] == extraction_key and old["extraction"]["state"] == "completed" and destination.is_file():
            try:
                checked = _probe_preview(destination, repaired["end_seconds"] - repaired["start_seconds"], tolerance, runner=ffprobe)
                actual_fingerprint = fingerprint_file(destination)
                if actual_fingerprint == old["extraction"]["fingerprint"]:
                    extraction = {
                        "requested": True,
                        "state": "completed",
                        "path": destination.relative_to(project).as_posix(),
                        "fingerprint": actual_fingerprint,
                        "duration_seconds": checked,
                    }
            except BoundaryError:
                pass
        entries.append({"candidate_id": candidate_id, "proposed_span": proposed_span, "repaired_span": repaired, "repair": repair, "extraction_key": extraction_key, "extraction": extraction})
    created_at = clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def document() -> dict[str, Any]:
        return {
            "artifact_version": BOUNDARY_ARTIFACT_VERSION, "engine_version": ENGINE_VERSION,
            "created_at": created_at,
            "versions": versions, "source": source_identity, "settings": settings,
            "cache_key": cache_key, "requested_candidate_ids": list(requested), "candidates": entries,
        }

    expected = document()
    if previous is not None:
        deterministic_fields = (
            "artifact_version", "engine_version", "versions", "source", "settings",
            "cache_key", "requested_candidate_ids", "candidates",
        )
        all_requested_complete = all(
            item["extraction"]["state"] == "completed"
            for item in expected["candidates"]
            if item["candidate_id"] in requested
        )
        if all_requested_complete and all(
            previous[field] == expected[field] for field in deterministic_fields
        ):
            progress({"phase": "final_cache_hit", "fraction": 1.0, "percent": 100, "cache_hit": True, "message": "reusing matching validated boundary artifact and previews"})
            return BoundaryResult(previous, artifact_path, True)

    cache_hit = False
    requested_entries = [next(item for item in entries if item["candidate_id"] == candidate_id) for candidate_id in requested]
    for index, entry in enumerate(requested_entries):
        if cancelled():
            raise cancellation_error()
        if entry["extraction"]["state"] != "completed":
            span = entry["repaired_span"]
            destination = project / PREVIEW_DIRECTORY / f"{entry['candidate_id']}.source.mp4"
            entry["extraction"] = _extract(source, destination, span["start_seconds"], span["end_seconds"], tolerance, ffmpeg=ffmpeg, ffprobe=ffprobe)
            entry["extraction"]["path"] = destination.relative_to(project).as_posix()
            validate_document("boundary_artifact", document())
            _atomic_json(artifact_path, document())
        progress({"phase": "preview_completed", "candidate_id": entry["candidate_id"], "fraction": 0.2 + 0.75 * ((index + 1) / max(1, len(requested_entries))), "cache_hit": False, "message": f"validated {entry['candidate_id']} preview"})
    artifact = document()
    validate_document("boundary_artifact", artifact)
    _atomic_json(artifact_path, artifact)
    progress({"phase": "boundary_completed", "fraction": 1.0, "percent": 100, "cache_hit": cache_hit, "message": "repaired boundaries and prepared preview clips"})
    return BoundaryResult(artifact, artifact_path, cache_hit)
