"""Contract validation and protocol smoke CLI for Vidmyo Repurpose."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from .contracts import (
    INGEST_ARTIFACT_VERSION,
    ContractValidationError,
    validate_document,
    validate_event_stream,
)
from .ingest import INGEST_ARTIFACT_RELATIVE_PATH, IngestError, ingest_project

MANIFEST_NAME = "repurpose.json"


def _read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _event(request: dict[str, Any], sequence: int, event: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "protocol_version": request["protocol_version"],
        "job_id": request["job_id"],
        "sequence": sequence,
        "event": event,
        "stage": request["stage"],
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }


def _validate(args: argparse.Namespace) -> int:
    validate_document(args.kind, _read_json(args.path))
    return 0


def _smoke(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    events = validate_event_stream(
        [
            _event(request, 1, "accepted", {"message": "request accepted"}),
            _event(
                request,
                2,
                "progress",
                {"fraction": 1.0, "message": "contract smoke only; no media work performed"},
            ),
            _event(request, 3, "completed", {"artifacts": []}),
        ]
    )
    for event in events:
        print(json.dumps(event, separators=(",", ":")))
    return 0


def _emit(event: dict[str, Any]) -> None:
    validate_document("event", event)
    print(json.dumps(event, separators=(",", ":")), flush=True)


def _ingest_failure(code: str, message: str, next_action: str) -> IngestError:
    return IngestError(
        code=code,
        message=message,
        preserved="The source media and existing project manifest were not changed.",
        next_action=next_action,
    )


def _ingest(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "ingest":
        raise ContractValidationError("stage: ingest command requires stage 'ingest'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "ingest request accepted"}))
    sequence += 1
    try:
        project_dir = Path(request["project_dir"]).expanduser().resolve()
        manifest_path = project_dir / MANIFEST_NAME
        if not manifest_path.is_file():
            raise _ingest_failure(
                "project_manifest_missing",
                f"The Repurpose project manifest is missing: {manifest_path}.",
                "Choose a valid Repurpose project folder and retry ingest.",
            )
        try:
            manifest = validate_document("manifest", _read_json(str(manifest_path)))
        except (ContractValidationError, json.JSONDecodeError, OSError) as exc:
            raise _ingest_failure(
                "project_manifest_invalid",
                f"The Repurpose project manifest is invalid: {exc}.",
                "Repair or recreate the project manifest, then retry ingest.",
            ) from exc
        _emit(_event(request, sequence, "progress", {
            "fraction": 0.1,
            "message": "validating and fingerprinting local source",
        }))
        sequence += 1
        artifact, artifact_path = ingest_project(project_dir, manifest)
        _emit(_event(request, sequence, "artifact", {
            "kind": "ingest_artifact",
            "version": INGEST_ARTIFACT_VERSION,
            "path": artifact_path.relative_to(project_dir).as_posix(),
            "fingerprint": artifact["source"]["fingerprint"],
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{
                "kind": "ingest_artifact",
                "version": INGEST_ARTIFACT_VERSION,
                "path": INGEST_ARTIFACT_RELATIVE_PATH.as_posix(),
            }],
        }))
        return 0
    except IngestError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except (ContractValidationError, json.JSONDecodeError, OSError) as exc:
        failure = _ingest_failure(
            "ingest_artifact_write_failed",
            f"Ingest could not create a valid artifact: {exc}.",
            "Check the project folder permissions and available disk space, then retry ingest.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vidmyo-repurpose")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="validate a versioned JSON document")
    validate.add_argument(
        "--kind", choices=("request", "manifest", "ingest_artifact"), required=True
    )
    validate.add_argument("path")
    validate.set_defaults(handler=_validate)

    smoke = commands.add_parser("smoke", help="emit a no-media JSONL protocol smoke run")
    smoke.add_argument("--request", required=True)
    smoke.set_defaults(handler=_smoke)

    ingest = commands.add_parser("ingest", help="validate and fingerprint local source media")
    ingest.add_argument("--request", required=True)
    ingest.set_defaults(handler=_ingest)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (ContractValidationError, json.JSONDecodeError, OSError) as exc:
        print(f"contract error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
