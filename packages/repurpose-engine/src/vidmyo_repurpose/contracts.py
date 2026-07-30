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
    return document


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
