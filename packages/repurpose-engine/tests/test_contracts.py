from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from vidmyo_repurpose.contracts import (
    ContractValidationError,
    load_schema,
    validate_document,
    validate_event_stream,
)

FIXTURES = Path(__file__).parent / "fixtures"


def load_json(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def load_jsonl(name: str):
    return [
        json.loads(line)
        for line in (FIXTURES / name).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


@pytest.mark.parametrize("kind", ["request", "event", "manifest", "ingest_artifact"])
def test_schemas_are_valid_draft_2020_12(kind: str):
    Draft202012Validator.check_schema(load_schema(kind))


def test_shared_valid_request_and_manifest_are_accepted():
    request = load_json("valid-worker-request.json")
    manifest = load_json("valid-project-manifest.json")
    assert validate_document("request", request) is request
    assert validate_document("manifest", manifest) is manifest


@pytest.mark.parametrize(
    ("kind", "fixture", "field"),
    [
        ("request", "invalid-worker-request-missing-project-dir.json", "project_dir"),
        ("request", "invalid-worker-request-stage.json", "stage"),
        ("manifest", "invalid-project-manifest-version.json", "version"),
        ("manifest", "invalid-project-manifest-candidate-id.json", "candidates.0.id"),
    ],
)
def test_shared_invalid_documents_name_the_bad_field(kind: str, fixture: str, field: str):
    with pytest.raises(ContractValidationError, match=field.replace(".", r"\.")):
        validate_document(kind, load_json(fixture))


def test_event_stream_accepts_ordered_terminal_stream():
    events = load_jsonl("valid-worker-events.jsonl")
    assert validate_event_stream(events) == events


def test_event_stream_rejects_sequence_gaps():
    with pytest.raises(ContractValidationError, match=r"events\.1\.sequence"):
        validate_event_stream(load_jsonl("invalid-worker-events-sequence.jsonl"))


def test_event_schema_rejects_malformed_job_id():
    event = load_jsonl("valid-worker-events.jsonl")[0]
    event["job_id"] = "not-a-job"
    with pytest.raises(ContractValidationError, match="job_id"):
        validate_document("event", event)


def test_manifest_semantics_reject_out_of_order_stages_and_duplicate_candidate_ids():
    out_of_order = load_json("valid-project-manifest.json")
    out_of_order["stages"]["transcribe"]["state"] = "running"
    with pytest.raises(ContractValidationError, match=r"stages\.transcribe\.state"):
        validate_document("manifest", out_of_order)

    duplicate = load_json("valid-project-manifest.json")
    duplicate["candidates"].append(dict(duplicate["candidates"][0]))
    with pytest.raises(ContractValidationError, match=r"candidate ids must be unique"):
        validate_document("manifest", duplicate)
