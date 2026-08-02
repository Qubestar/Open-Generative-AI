from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import vidmyo_repurpose.cli as cli
from vidmyo_repurpose.candidates import (
    CandidateGenerationError,
    CandidateResult,
)
from vidmyo_repurpose.contracts import validate_event_stream
from vidmyo_repurpose.transcribe import (
    TranscriptionResult,
    cancellation_error,
)

FIXTURES = Path(__file__).parent / "fixtures"


def run_cli(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "vidmyo_repurpose.cli", *args],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def write_project(project_dir: Path, source: dict) -> Path:
    manifest = json.loads((FIXTURES / "valid-project-manifest.json").read_text(encoding="utf-8"))
    manifest["source"] = source
    manifest["candidates"] = []
    path = project_dir / "repurpose.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    request = {
        "protocol_version": 1,
        "job_id": "job_ingest_test",
        "project_dir": str(project_dir),
        "stage": "ingest",
        "input_artifacts": [],
        "options": {},
    }
    request_path = project_dir / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    return request_path


def fake_ffprobe(tmp_path: Path) -> dict[str, str]:
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    probe = {
        "format": {"format_name": "mov,mp4", "format_long_name": "MP4", "duration": "2.0"},
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 320,
                "height": 180,
                "avg_frame_rate": "24/1",
                "r_frame_rate": "24/1",
                "duration": "2.0",
            },
            {
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
                "channel_layout": "stereo",
                "duration": "2.0",
            },
        ],
    }
    script = binary_dir / "ffprobe"
    script.write_text(
        "#!/bin/sh\n" + "printf '%s\\n' '" + json.dumps(probe) + "'\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = str(binary_dir)
    return env


def test_validate_returns_zero_for_valid_request():
    result = run_cli(
        "validate",
        "--kind",
        "request",
        str(FIXTURES / "valid-worker-request.json"),
    )
    assert result.returncode == 0
    assert result.stderr == ""


def test_validate_returns_nonzero_with_field_specific_error():
    result = run_cli(
        "validate",
        "--kind",
        "request",
        str(FIXTURES / "invalid-worker-request-missing-project-dir.json"),
    )
    assert result.returncode != 0
    assert "project_dir" in result.stderr


def test_smoke_emits_valid_ordered_jsonl_without_media_artifacts():
    result = run_cli("smoke", "--request", str(FIXTURES / "valid-worker-request.json"))
    assert result.returncode == 0
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "completed"]
    assert [event["sequence"] for event in events] == [1, 2, 3]
    assert {event["job_id"] for event in events} == {"job_contract_smoke"}
    assert events[-1]["payload"]["artifacts"] == []


def test_invalid_smoke_input_never_emits_completed(tmp_path: Path):
    malformed = tmp_path / "malformed.json"
    malformed.write_text('{"protocol_version": 1,', encoding="utf-8")
    result = run_cli("smoke", "--request", str(malformed))
    assert result.returncode != 0
    assert '"completed"' not in result.stdout
    assert "contract error" in result.stderr


def test_ingest_emits_ordered_success_events_and_atomic_artifact(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"local media bytes")
    request = write_project(
        tmp_path,
        {"type": "local_file", "uri": str(source), "fingerprint": None},
    )
    result = run_cli("ingest", "--request", str(request), env=fake_ffprobe(tmp_path))
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert [event["event"] for event in events] == [
        "accepted", "progress", "artifact", "completed"
    ]
    assert [event["sequence"] for event in events] == [1, 2, 3, 4]
    artifact_event = events[2]["payload"]
    assert artifact_event["kind"] == "ingest_artifact"
    assert artifact_event["version"] == 1
    artifact_path = tmp_path / artifact_event["path"]
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert artifact["source"]["path"] == str(source.resolve())
    assert list(artifact_path.parent.glob("*.tmp")) == []


def test_ingest_failure_is_terminal_observable_and_preserves_manifest(tmp_path: Path):
    source = tmp_path / "missing.mp4"
    request = write_project(
        tmp_path,
        {"type": "local_file", "uri": str(source), "fingerprint": "sha256:" + "a" * 64},
    )
    manifest_before = (tmp_path / "repurpose.json").read_bytes()
    result = run_cli("ingest", "--request", str(request))
    assert result.returncode != 0
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "error"]
    error = events[-1]["payload"]
    assert error["code"] == "source_missing"
    assert error["message"]
    assert error["preserved"]
    assert error["next_action"]
    assert "completed" not in [event["event"] for event in events]
    assert not (tmp_path / "artifacts" / "ingest-artifact.v1.json").exists()
    assert (tmp_path / "repurpose.json").read_bytes() == manifest_before


def test_reserved_url_ingest_fails_without_invoking_any_binary(tmp_path: Path):
    request = write_project(
        tmp_path,
        {"type": "url", "uri": "https://example.com/video", "fingerprint": None},
    )
    env = os.environ.copy()
    env["PATH"] = ""
    result = run_cli("ingest", "--request", str(request), env=env)
    assert result.returncode != 0
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "error"]
    assert events[-1]["payload"]["code"] == "url_ingest_not_implemented"
    assert "local file" in events[-1]["payload"]["next_action"].lower()
    assert not (tmp_path / "artifacts").exists()


def test_doctor_empty_cache_is_machine_readable_read_only_and_defaults_small(tmp_path: Path):
    cache = tmp_path / "empty-model-cache"
    result = run_cli("doctor", "--model-cache", str(cache))
    assert result.returncode != 0
    document = json.loads(result.stdout)
    assert document["model"] == "small"
    assert document["model_ready"] is False
    assert document["setup_command"] in document["message"]
    assert not cache.exists()


def test_transcribe_cli_emits_ordered_schema_valid_success_events(
    tmp_path: Path, monkeypatch, capsys
):
    request = {
        "protocol_version": 1,
        "job_id": "job_cli_transcribe",
        "project_dir": str(tmp_path),
        "stage": "transcribe",
        "input_artifacts": [],
        "options": {},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    artifact_path = tmp_path / "artifacts" / "transcript-artifact.v1.json"

    def runner(_request, *, progress, cancelled):
        assert cancelled() is False
        progress({
            "phase": "input_validation", "fraction": 0.1, "percent": 10,
            "processed_seconds": 0, "total_seconds": 5, "cache_hit": False,
            "message": "valid",
        })
        return TranscriptionResult({"cache_key": "sha256:" + "a" * 64}, artifact_path, False)

    monkeypatch.setattr(cli, "transcribe_project", runner)
    assert cli._transcribe(Namespace(request=str(request_path))) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == [
        "accepted", "progress", "artifact", "completed",
    ]
    assert validate_event_stream(events) == events


def test_transcribe_cli_signal_cancellation_is_terminal(
    tmp_path: Path, monkeypatch, capsys
):
    request = {
        "protocol_version": 1,
        "job_id": "job_cli_cancel",
        "project_dir": str(tmp_path),
        "stage": "transcribe",
        "input_artifacts": [],
        "options": {},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")

    def runner(_request, *, progress, cancelled):
        progress({
            "phase": "input_validation", "fraction": 0.1, "percent": 10,
            "processed_seconds": 0, "total_seconds": 5, "cache_hit": False,
            "message": "valid",
        })
        os.kill(os.getpid(), signal.SIGTERM)
        assert cancelled() is True
        raise cancellation_error()

    monkeypatch.setattr(cli, "transcribe_project", runner)
    assert cli._transcribe(Namespace(request=str(request_path))) != 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "error"]
    assert events[-1]["payload"]["code"] == "transcription_cancelled"
    assert validate_event_stream(events) == events


def test_candidates_cli_emits_ordered_artifact_and_no_candidates_outcome(
    tmp_path: Path, monkeypatch, capsys
):
    request = {
        "protocol_version": 1, "job_id": "job_cli_candidates",
        "project_dir": str(tmp_path), "stage": "generate_candidates",
        "input_artifacts": [], "options": {"model": "openai/gpt-test"},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    artifact_path = tmp_path / "artifacts" / "candidate-artifact.v1.json"

    def runner(_request, *, progress, cancelled):
        assert cancelled() is False
        progress({
            "phase": "input_validation", "fraction": 0.1, "percent": 10,
            "cache_hit": False, "message": "valid",
        })
        return CandidateResult({
            "cache_key": "sha256:" + "a" * 64,
            "outcome": "no_candidates_found", "candidates": [],
        }, artifact_path, False)

    monkeypatch.setattr(cli, "generate_candidates", runner)
    assert cli._candidates(Namespace(request=str(request_path))) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == [
        "accepted", "progress", "artifact", "completed",
    ]
    assert events[-1]["payload"]["outcome"] == "no_candidates_found"
    assert events[-2]["payload"]["candidate_count"] == 0
    assert validate_event_stream(events) == events


def test_candidates_cli_cancellation_is_terminal_without_false_completion(
    tmp_path: Path, monkeypatch, capsys
):
    request = {
        "protocol_version": 1, "job_id": "job_cli_candidates_cancel",
        "project_dir": str(tmp_path), "stage": "generate_candidates",
        "input_artifacts": [], "options": {"model": "openai/gpt-test"},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")

    def runner(_request, *, progress, cancelled):
        progress({"phase": "input_validation", "message": "valid"})
        raise CandidateGenerationError(
            "candidate_generation_cancelled", "cancelled", "preserved", "retry",
        )

    monkeypatch.setattr(cli, "generate_candidates", runner)
    assert cli._candidates(Namespace(request=str(request_path))) != 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "error"]
    assert events[-1]["payload"]["code"] == "candidate_generation_cancelled"
    assert validate_event_stream(events) == events
