"""Load and validate the versioned Repurpose JSON contracts."""

from __future__ import annotations

import json
import sysconfig
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker

PROTOCOL_VERSION = 1
MANIFEST_VERSION = 1
INGEST_ARTIFACT_VERSION = 1
TRANSCRIPT_ARTIFACT_VERSION = 1
CANDIDATE_ARTIFACT_VERSION = 1
STAGES = (
    "ingest",
    "transcribe",
    "generate_candidates",
    "rank",
    "repair_boundaries",
    "reframe",
    "render",
)

_SCHEMA_FILES = {
    "request": "worker-request.v1.schema.json",
    "event": "worker-event.v1.schema.json",
    "manifest": "project-manifest.v1.schema.json",
    "ingest_artifact": "ingest-artifact.v1.schema.json",
    "transcript_artifact": "transcript-artifact.v1.schema.json",
    "candidate_artifact": "candidate-artifact.v1.schema.json",
}


class ContractValidationError(ValueError):
    """A stable, field-addressed contract validation failure."""


def _schema_dir() -> Path:
    repository_dir = Path(__file__).resolve().parents[2] / "schemas"
    if repository_dir.is_dir():
        return repository_dir
    installed_dir = (
        Path(sysconfig.get_path("data"))
        / "share"
        / "vidmyo-repurpose"
        / "schemas"
    )
    if installed_dir.is_dir():
        return installed_dir
    raise RuntimeError("Vidmyo Repurpose schemas are missing from the installation")


def load_schema(kind: str) -> dict[str, Any]:
    try:
        filename = _SCHEMA_FILES[kind]
    except KeyError as exc:
        raise ValueError(f"Unknown contract kind: {kind}") from exc
    return json.loads((_schema_dir() / filename).read_text(encoding="utf-8"))


def _format_error(error: Any) -> str:
    path = ".".join(str(part) for part in error.absolute_path)
    return f"{path}: {error.message}" if path else error.message


def validate_document(kind: str, document: Any) -> Any:
    validator = Draft202012Validator(load_schema(kind), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    if errors:
        raise ContractValidationError(_format_error(errors[0]))
    if kind == "manifest":
        _validate_manifest_semantics(document)
    elif kind == "transcript_artifact":
        _validate_transcript_semantics(document)
    elif kind == "candidate_artifact":
        _validate_candidate_semantics(document)
    return document


def _finite_time(value: Any, field: str) -> float:
    import math

    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ContractValidationError(f"{field}: must be a finite number")
    return float(value)


def _validate_transcript_semantics(artifact: dict[str, Any]) -> None:
    duration = _finite_time(artifact["duration_seconds"], "duration_seconds")
    segments = artifact["segments"]
    words = artifact["words"]
    expected_segment_ids = [f"segment_{index:06d}" for index in range(1, len(segments) + 1)]
    expected_word_ids = [f"word_{index:06d}" for index in range(1, len(words) + 1)]
    segment_ids = [segment["id"] for segment in segments]
    word_ids = [word["id"] for word in words]
    if segment_ids != expected_segment_ids:
        raise ContractValidationError("segments.id: ids must be unique, sequential, and ordered")
    if word_ids != expected_word_ids:
        raise ContractValidationError("words.id: ids must be unique, sequential, and ordered")

    previous_start = -1.0
    previous_end = -1.0
    segment_by_id: dict[str, dict[str, Any]] = {}
    for index, segment in enumerate(segments):
        root = f"segments.{index}"
        start = _finite_time(segment["start_seconds"], f"{root}.start_seconds")
        end = _finite_time(segment["end_seconds"], f"{root}.end_seconds")
        if end < start:
            raise ContractValidationError(f"{root}.end_seconds: cannot precede start_seconds")
        if start < previous_start or end < previous_end:
            raise ContractValidationError(f"{root}: timestamps must be ordered")
        if end > duration:
            raise ContractValidationError(f"{root}.end_seconds: exceeds source duration")
        previous_start, previous_end = start, end
        segment_by_id[segment["id"]] = segment

    previous_start = -1.0
    previous_end = -1.0
    words_by_segment: dict[str, list[str]] = {segment_id: [] for segment_id in segment_ids}
    for index, word in enumerate(words):
        root = f"words.{index}"
        start = _finite_time(word["start_seconds"], f"{root}.start_seconds")
        end = _finite_time(word["end_seconds"], f"{root}.end_seconds")
        if end < start:
            raise ContractValidationError(f"{root}.end_seconds: cannot precede start_seconds")
        if start < previous_start or end < previous_end:
            raise ContractValidationError(f"{root}: timestamps must be ordered")
        if end > duration:
            raise ContractValidationError(f"{root}.end_seconds: exceeds source duration")
        segment_id = word["segment_id"]
        if segment_id not in segment_by_id:
            raise ContractValidationError(f"{root}.segment_id: dangling segment reference")
        segment = segment_by_id[segment_id]
        if start < segment["start_seconds"] or end > segment["end_seconds"]:
            raise ContractValidationError(f"{root}: timestamp lies outside its segment")
        previous_start, previous_end = start, end
        words_by_segment[segment_id].append(word["id"])

    for index, segment in enumerate(segments):
        if segment["word_ids"] != words_by_segment[segment["id"]]:
            raise ContractValidationError(
                f"segments.{index}.word_ids: references must exactly match ordered segment words"
            )
    if artifact["speech_detected"] != bool(segments or words):
        raise ContractValidationError(
            "speech_detected: must be true exactly when usable segments or words exist"
        )


def _validate_manifest_semantics(manifest: dict[str, Any]) -> None:
    incomplete_seen = False
    for stage in STAGES:
        state = manifest["stages"][stage]["state"]
        if incomplete_seen and state != "pending":
            raise ContractValidationError(
                f"stages.{stage}.state: cannot advance before its prerequisite"
            )
        if state != "completed":
            incomplete_seen = True
    candidate_ids = [candidate["id"] for candidate in manifest["candidates"]]
    if len(candidate_ids) != len(set(candidate_ids)):
        raise ContractValidationError("candidates.id: candidate ids must be unique")


def _validate_candidate_semantics(artifact: dict[str, Any]) -> None:
    windows = artifact["windows"]
    expected_window_ids = [f"window_{index:06d}" for index in range(1, len(windows) + 1)]
    if [window["id"] for window in windows] != expected_window_ids:
        raise ContractValidationError("windows.id: ids must be unique, sequential, and ordered")
    window_ids = set(expected_window_ids)
    expected_candidate_ids = [
        f"clip_{index:03d}" for index in range(1, len(artifact["candidates"]) + 1)
    ]
    candidates = artifact["candidates"]
    if [candidate["id"] for candidate in candidates] != expected_candidate_ids:
        raise ContractValidationError("candidates.id: ids must be unique, sequential, and ordered")
    provider_ids = [candidate["provider_suggestion_id"] for candidate in candidates]
    if len(provider_ids) != len(set(provider_ids)):
        raise ContractValidationError("candidates.provider_suggestion_id: ids must be unique")
    for index, candidate in enumerate(candidates):
        if candidate["window_id"] not in window_ids:
            raise ContractValidationError(f"candidates.{index}.window_id: dangling window reference")
        proposed = candidate["proposed_span"]
        if proposed["end_seconds"] < proposed["start_seconds"]:
            raise ContractValidationError(f"candidates.{index}.proposed_span: reversed timestamps")
        duration = proposed["end_seconds"] - proposed["start_seconds"]
        if duration < 20 or duration > 120:
            raise ContractValidationError(
                f"candidates.{index}.proposed_span: duration must be between 20 and 120 seconds"
            )
        for evidence_index, evidence in enumerate(candidate["evidence_spans"]):
            if (
                evidence["start_seconds"] < proposed["start_seconds"]
                or evidence["end_seconds"] > proposed["end_seconds"]
                or evidence["end_seconds"] < evidence["start_seconds"]
            ):
                raise ContractValidationError(
                    f"candidates.{index}.evidence_spans.{evidence_index}: outside proposed span"
                )
    if artifact["outcome"] == "no_candidates_found" and candidates:
        raise ContractValidationError("outcome: no_candidates_found requires an empty candidate list")
    if artifact["outcome"] == "candidates_generated" and not candidates:
        raise ContractValidationError("outcome: candidates_generated requires candidates")


def validate_event_stream(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    stream = [validate_document("event", event) for event in events]
    if not stream:
        raise ContractValidationError("event stream must not be empty")
    first = stream[0]
    if first["event"] != "accepted":
        raise ContractValidationError("events.0.event: first event must be accepted")
    expected_job_id = first["job_id"]
    expected_protocol = first["protocol_version"]
    expected_sequence = first["sequence"]
    terminal_seen = False
    for index, event in enumerate(stream):
        if event["job_id"] != expected_job_id:
            raise ContractValidationError(f"events.{index}.job_id: must match the first event")
        if event["protocol_version"] != expected_protocol:
            raise ContractValidationError(
                f"events.{index}.protocol_version: must match the first event"
            )
        if event["sequence"] != expected_sequence:
            raise ContractValidationError(
                f"events.{index}.sequence: expected {expected_sequence}, got {event['sequence']}"
            )
        if terminal_seen:
            raise ContractValidationError(f"events.{index}: event appears after a terminal event")
        if event["event"] in {"completed", "error"}:
            terminal_seen = True
        expected_sequence += 1
    if not terminal_seen:
        raise ContractValidationError("event stream must end with completed or error")
    return stream
