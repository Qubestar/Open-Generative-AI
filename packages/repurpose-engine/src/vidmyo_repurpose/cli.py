"""Contract validation and protocol smoke CLI for Vidmyo Repurpose."""

from __future__ import annotations

import argparse
import json
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from .contracts import (
    BOUNDARY_ARTIFACT_VERSION,
    CANDIDATE_ARTIFACT_VERSION,
    INGEST_ARTIFACT_VERSION,
    RANKING_ARTIFACT_VERSION,
    REFRAME_ARTIFACT_VERSION,
    RENDER_ARTIFACT_VERSION,
    TRANSCRIPT_ARTIFACT_VERSION,
    ContractValidationError,
    validate_document,
    validate_event_stream,
)
from .boundaries import (
    BOUNDARY_ARTIFACT_RELATIVE_PATH,
    BoundaryError,
    repair_and_extract,
)
from .candidates import (
    CANDIDATE_ARTIFACT_RELATIVE_PATH,
    CandidateGenerationError,
    generate_candidates,
)
from .ingest import INGEST_ARTIFACT_RELATIVE_PATH, IngestError, ingest_project
from .ranking import RANKING_ARTIFACT_RELATIVE_PATH, RankingError, rank_candidates
from .reframe import REFRAME_ARTIFACT_RELATIVE_PATH, ReframeError, reframe_previews
from .reframe_two import (
    REFRAME_V2_ARTIFACT_RELATIVE_PATH,
    TwoSpeakerReframeError,
    upgrade_reframe_previews,
)
from .render import RENDER_ARTIFACT_RELATIVE_PATH, RenderError, render_platform_outputs
from .transcribe import (
    DEFAULT_MODEL,
    TRANSCRIPT_ARTIFACT_RELATIVE_PATH,
    TranscriptionError,
    inspect_model,
    resolve_model_cache,
    setup_model,
    transcribe_project,
)

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


def _doctor(args: argparse.Namespace) -> int:
    result = inspect_model(args.model, resolve_model_cache(override=args.model_cache))
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ok"] else 1


def _setup_model(args: argparse.Namespace) -> int:
    def report(event: dict[str, Any]) -> None:
        print(json.dumps({"event": "progress", **event}, separators=(",", ":")), flush=True)

    try:
        result = setup_model(
            args.model,
            resolve_model_cache(override=args.model_cache),
            progress=report,
        )
        print(json.dumps({"event": "completed", **result}, separators=(",", ":")))
        return 0
    except TranscriptionError as exc:
        print(json.dumps({"event": "error", **exc.payload()}, separators=(",", ":")))
        return 1


def _transcribe(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "transcribe":
        raise ContractValidationError("stage: transcribe command requires stage 'transcribe'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "transcribe request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    last_fraction = -1.0

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence, last_fraction
        fraction = float(payload["fraction"])
        if fraction < last_fraction:
            raise ContractValidationError("progress.fraction: must be monotonic")
        last_fraction = fraction
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = transcribe_project(
            request,
            progress=emit_progress,
            cancelled=lambda: cancellation["requested"],
        )
        _emit(_event(request, sequence, "artifact", {
            "kind": "transcript_artifact",
            "version": TRANSCRIPT_ARTIFACT_VERSION,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"],
            "cache_hit": result.cache_hit,
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{
                "kind": "transcript_artifact",
                "version": TRANSCRIPT_ARTIFACT_VERSION,
                "path": TRANSCRIPT_ARTIFACT_RELATIVE_PATH.as_posix(),
            }],
            "cache_hit": result.cache_hit,
        }))
        return 0
    except TranscriptionError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = TranscriptionError(
            code="transcription_request_invalid",
            message=f"The transcribe request or normalized output is invalid: {exc}.",
            preserved="The ingest artifact and any earlier valid transcript were preserved.",
            next_action="Correct the version-1 request or input artifact and retry transcription.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _candidates(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "generate_candidates":
        raise ContractValidationError(
            "stage: candidates command requires stage 'generate_candidates'"
        )
    sequence = 1
    _emit(_event(request, sequence, "accepted", {
        "message": "candidate generation request accepted",
    }))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = generate_candidates(
            request,
            progress=emit_progress,
            cancelled=lambda: cancellation["requested"],
        )
        outcome = result.artifact["outcome"]
        _emit(_event(request, sequence, "artifact", {
            "kind": "candidate_artifact",
            "version": CANDIDATE_ARTIFACT_VERSION,
            "path": result.path.relative_to(
                Path(request["project_dir"]).expanduser().resolve()
            ).as_posix(),
            "cache_key": result.artifact["cache_key"],
            "cache_hit": result.cache_hit,
            "outcome": outcome,
            "candidate_count": len(result.artifact["candidates"]),
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{
                "kind": "candidate_artifact",
                "version": CANDIDATE_ARTIFACT_VERSION,
                "path": CANDIDATE_ARTIFACT_RELATIVE_PATH.as_posix(),
            }],
            "cache_hit": result.cache_hit,
            "outcome": outcome,
        }))
        return 0
    except CandidateGenerationError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = CandidateGenerationError(
            code="candidate_request_invalid",
            message=f"The candidate request or normalized output is invalid: {exc}.",
            preserved=(
                "The completed transcript, validated window caches, and any earlier valid "
                "candidate artifact were preserved."
            ),
            next_action="Correct the version-1 request or input artifact and retry.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _rank(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "rank":
        raise ContractValidationError("stage: rank command requires stage 'rank'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "candidate ranking request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = rank_candidates(
            request,
            progress=emit_progress,
            cancelled=lambda: cancellation["requested"],
        )
        _emit(_event(request, sequence, "artifact", {
            "kind": "ranking_artifact",
            "version": RANKING_ARTIFACT_VERSION,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"],
            "cache_hit": result.cache_hit,
            "candidate_count": len(result.artifact["candidates"]),
            "shortlist_count": len(result.artifact["shortlist_candidate_ids"]),
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{
                "kind": "ranking_artifact",
                "version": RANKING_ARTIFACT_VERSION,
                "path": RANKING_ARTIFACT_RELATIVE_PATH.as_posix(),
            }],
            "cache_hit": result.cache_hit,
        }))
        return 0
    except RankingError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = RankingError(
            code="ranking_request_invalid",
            message=f"The ranking request or normalized output is invalid: {exc}.",
            preserved=(
                "The completed transcript and candidate artifact, validated ranking caches, "
                "and any earlier valid ranking artifact were preserved."
            ),
            next_action="Correct the version-1 request or input artifact and retry ranking.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _boundaries(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "repair_boundaries":
        raise ContractValidationError("stage: repair command requires stage 'repair_boundaries'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "boundary repair request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = repair_and_extract(
            request, progress=emit_progress,
            cancelled=lambda: cancellation["requested"],
        )
        completed = [
            item for item in result.artifact["candidates"]
            if item["extraction"]["state"] == "completed"
        ]
        _emit(_event(request, sequence, "artifact", {
            "kind": "boundary_artifact", "version": BOUNDARY_ARTIFACT_VERSION,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"], "cache_hit": result.cache_hit,
            "preview_count": len(completed),
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{
                "kind": "boundary_artifact", "version": BOUNDARY_ARTIFACT_VERSION,
                "path": BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(),
            }],
            "cache_hit": result.cache_hit, "preview_count": len(completed),
        }))
        return 0
    except BoundaryError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = BoundaryError(
            "boundary_request_invalid",
            f"The repair request or normalized output is invalid: {exc}.",
            "The source, upstream artifacts, completed previews, and earlier valid boundary artifact were preserved.",
            "Correct the version-1 request or input artifacts and retry.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _reframe(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "reframe":
        raise ContractValidationError("stage: reframe command requires stage 'reframe'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "single-speaker reframe request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = reframe_previews(request, progress=emit_progress, cancelled=lambda: cancellation["requested"])
        completed = [item for item in result.artifact["candidates"] if item["output"]["state"] == "completed"]
        _emit(_event(request, sequence, "artifact", {
            "kind": "reframe_artifact", "version": REFRAME_ARTIFACT_VERSION,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"], "cache_hit": result.cache_hit,
            "preview_count": len(completed),
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{"kind": "reframe_artifact", "version": REFRAME_ARTIFACT_VERSION, "path": REFRAME_ARTIFACT_RELATIVE_PATH.as_posix()}],
            "cache_hit": result.cache_hit, "preview_count": len(completed),
        }))
        return 0
    except ReframeError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = ReframeError(
            "reframe_request_invalid", f"The reframe request or normalized output is invalid: {exc}.",
            "The Issue 6 previews, completed reframed previews, and earlier valid reframe artifact were preserved.",
            "Correct the version-1 request or input artifacts and retry.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _reframe_two(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "reframe":
        raise ContractValidationError("stage: reframe-two command requires stage 'reframe'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "two-speaker reframe request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = upgrade_reframe_previews(
            request, progress=emit_progress, cancelled=lambda: cancellation["requested"],
        )
        completed = [item for item in result.artifact["candidates"] if item["output"]["state"] == "completed"]
        _emit(_event(request, sequence, "artifact", {
            "kind": "reframe_artifact", "version": 2,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"], "cache_hit": result.cache_hit,
            "preview_count": len(completed),
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{"kind": "reframe_artifact", "version": 2, "path": REFRAME_V2_ARTIFACT_RELATIVE_PATH.as_posix()}],
            "cache_hit": result.cache_hit, "preview_count": len(completed),
        }))
        return 0
    except TwoSpeakerReframeError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except ContractValidationError as exc:
        failure = TwoSpeakerReframeError(
            "two_speaker_request_invalid",
            f"The two-speaker request or normalized output is invalid: {exc}.",
            "The source, Issue 6 previews, reframe v1 artifact, and every earlier valid output were preserved.",
            "Correct the version-1 request or input artifacts and retry.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def _render(args: argparse.Namespace) -> int:
    request = validate_document("request", _read_json(args.request))
    if request["stage"] != "render":
        raise ContractValidationError("stage: render command requires stage 'render'")
    sequence = 1
    _emit(_event(request, sequence, "accepted", {"message": "caption and platform render request accepted"}))
    sequence += 1
    cancellation = {"requested": False}
    previous_handlers: dict[int, Any] = {}

    def handle_signal(_signum: int, _frame: Any) -> None:
        cancellation["requested"] = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.getsignal(signum)
        signal.signal(signum, handle_signal)

    def emit_progress(payload: dict[str, Any]) -> None:
        nonlocal sequence
        _emit(_event(request, sequence, "progress", payload))
        sequence += 1

    try:
        result = render_platform_outputs(
            request, progress=emit_progress, cancelled=lambda: cancellation["requested"],
        )
        completed = [item for item in result.artifact["candidates"] if item["state"] == "completed"]
        export_count = sum(len(item["exports"]) for item in completed)
        _emit(_event(request, sequence, "artifact", {
            "kind": "render_artifact", "version": RENDER_ARTIFACT_VERSION,
            "path": result.path.relative_to(Path(request["project_dir"]).expanduser().resolve()).as_posix(),
            "cache_key": result.artifact["cache_key"], "cache_hit": result.cache_hit,
            "master_count": len(completed), "export_count": export_count,
        }))
        sequence += 1
        _emit(_event(request, sequence, "completed", {
            "artifacts": [{"kind": "render_artifact", "version": RENDER_ARTIFACT_VERSION, "path": RENDER_ARTIFACT_RELATIVE_PATH.as_posix()}],
            "cache_hit": result.cache_hit, "master_count": len(completed), "export_count": export_count,
        }))
        return 0
    except RenderError as exc:
        _emit(_event(request, sequence, "error", exc.payload()))
        return 1
    except (ContractValidationError, OSError, ReframeError) as exc:
        request_invalid = isinstance(exc, ContractValidationError)
        failure = RenderError(
            "render_request_invalid" if request_invalid else "render_local_io_failed",
            ("The render request or normalized output is invalid" if request_invalid else "Local render I/O failed") + f": {exc}.",
            "The source, transcript, boundaries, reframed previews, approvals, and every earlier valid render were preserved.",
            "Correct the version-1 request or current input artifacts and retry." if request_invalid else "Check local disk access and FFmpeg/FFprobe, then retry.",
        )
        _emit(_event(request, sequence, "error", failure.payload()))
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vidmyo-repurpose")
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="validate a versioned JSON document")
    validate.add_argument(
        "--kind",
        choices=(
            "request", "manifest", "ingest_artifact", "transcript_artifact",
            "candidate_artifact",
            "ranking_artifact",
            "boundary_artifact",
            "reframe_artifact",
            "reframe_artifact_v2",
            "render_artifact",
        ),
        required=True,
    )
    validate.add_argument("path")
    validate.set_defaults(handler=_validate)

    smoke = commands.add_parser("smoke", help="emit a no-media JSONL protocol smoke run")
    smoke.add_argument("--request", required=True)
    smoke.set_defaults(handler=_smoke)

    ingest = commands.add_parser("ingest", help="validate and fingerprint local source media")
    ingest.add_argument("--request", required=True)
    ingest.set_defaults(handler=_ingest)

    transcribe = commands.add_parser(
        "transcribe", help="create or reuse a local word-level transcript artifact"
    )
    transcribe.add_argument("--request", required=True)
    transcribe.set_defaults(handler=_transcribe)

    candidates = commands.add_parser(
        "generate-candidates",
        help="create or reuse transcript-grounded candidate suggestions",
    )
    candidates.add_argument("--request", required=True)
    candidates.set_defaults(handler=_candidates)

    rank = commands.add_parser(
        "rank", help="score, deduplicate, and shortlist candidate suggestions",
    )
    rank.add_argument("--request", required=True)
    rank.set_defaults(handler=_rank)

    boundaries = commands.add_parser(
        "repair-boundaries", help="repair word-safe boundaries and extract local previews",
    )
    boundaries.add_argument("--request", required=True)
    boundaries.set_defaults(handler=_boundaries)

    reframe = commands.add_parser(
        "reframe", help="create single-speaker vertical previews with a safe fallback",
    )
    reframe.add_argument("--request", required=True)
    reframe.set_defaults(handler=_reframe)

    reframe_two = commands.add_parser(
        "reframe-two", help="create stable two-speaker vertical split previews",
    )
    reframe_two.add_argument("--request", required=True)
    reframe_two.set_defaults(handler=_reframe_two)

    render = commands.add_parser(
        "render", help="create local captioned masters and platform-ready exports",
    )
    render.add_argument("--request", required=True)
    render.set_defaults(handler=_render)

    doctor = commands.add_parser("doctor", help="read-only transcription model readiness")
    doctor.add_argument("--model", default=DEFAULT_MODEL)
    doctor.add_argument("--model-cache")
    doctor.set_defaults(handler=_doctor)

    model_setup = commands.add_parser(
        "setup-model", help="explicitly download and verify a transcription model"
    )
    model_setup.add_argument("--model", default=DEFAULT_MODEL)
    model_setup.add_argument("--model-cache")
    model_setup.set_defaults(handler=_setup_model)
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
