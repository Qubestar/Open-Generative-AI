"""Contract validation and protocol smoke CLI for Vidmyo Repurpose."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from .contracts import ContractValidationError, validate_document, validate_event_stream


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vidmyo-repurpose")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="validate a versioned JSON document")
    validate.add_argument("--kind", choices=("request", "manifest"), required=True)
    validate.add_argument("path")
    validate.set_defaults(handler=_validate)

    smoke = commands.add_parser("smoke", help="emit a no-media JSONL protocol smoke run")
    smoke.add_argument("--request", required=True)
    smoke.set_defaults(handler=_smoke)
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
