from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "vidmyo_repurpose.cli", *args],
        check=False,
        capture_output=True,
        text=True,
    )


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
