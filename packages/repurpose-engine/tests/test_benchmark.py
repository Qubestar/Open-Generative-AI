from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from vidmyo_repurpose.benchmark import (
    CATEGORIES,
    generate_fixture_corpus,
    report_markdown,
    run_benchmark,
    write_report,
)
from vidmyo_repurpose.contracts import ContractValidationError, validate_document


def fake_media(command: list[str], **_kwargs: object) -> SimpleNamespace:
    Path(command[-1]).write_bytes(b"fixture")
    return SimpleNamespace(returncode=0, stdout="", stderr="")


def fake_probe(command: list[str], **_kwargs: object) -> SimpleNamespace:
    if command[0] == "ffprobe":
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
            "format": {"duration": "20.0"},
        }))
    return fake_media(command)


def test_fixture_generator_creates_exact_versioned_five_scenario_contract(tmp_path: Path) -> None:
    manifest_path = generate_fixture_corpus(tmp_path, run_command=fake_media)
    manifest = validate_document("benchmark_corpus", json.loads(manifest_path.read_text()))
    assert manifest["schema_version"] == "repurpose-benchmark.v1"
    assert [item["category"] for item in manifest["scenarios"]] == list(CATEGORIES)
    assert {item["evidence_kind"] for item in manifest["scenarios"]} == {"synthetic_fixture"}
    assert all(Path(item["source"]["path"]).is_file() for item in manifest["scenarios"])


def test_synthetic_report_passes_mechanics_but_quality_is_unknown(tmp_path: Path) -> None:
    manifest_path = generate_fixture_corpus(tmp_path / "corpus", run_command=fake_media)
    report = run_benchmark(manifest_path, run_command=fake_probe)
    assert report["scenario_count"] == 5
    assert report["real_scenario_count"] == 0
    assert report["aggregate"]["mechanical_status"] == "pass"
    assert report["aggregate"]["quality_status"] == "unknown"
    assert report["aggregate"]["mid_word_violations"] == 0
    assert report["aggregate"]["exports_probed"] == 5
    assert "do not establish ranking" in report["warning"]
    markdown = report_markdown(report)
    assert "Human real-corpus quality status: **UNKNOWN**" in markdown
    assert "Evidence boundary" in markdown
    json_path, markdown_path = write_report(report, tmp_path / "report")
    assert json.loads(json_path.read_text())["aggregate"]["quality_status"] == "unknown"
    assert markdown_path.is_file()


def test_real_five_scenario_evidence_can_pass_only_with_human_thresholds(tmp_path: Path) -> None:
    manifest_path = generate_fixture_corpus(tmp_path, run_command=fake_media)
    manifest = json.loads(manifest_path.read_text())
    for scenario in manifest["scenarios"]:
        scenario["evidence_kind"] = "human_real"
        scenario["human_review"]["reviewer"] = "reviewer@example.test"
    manifest_path.write_text(json.dumps(manifest))
    report = run_benchmark(manifest_path, run_command=fake_probe)
    assert report["aggregate"]["quality_status"] == "pass"
    manifest["scenarios"][0]["human_review"]["candidates"][0]["complete_sentence"] = False
    manifest["scenarios"][1]["human_review"]["candidates"][0]["complete_sentence"] = False
    manifest_path.write_text(json.dumps(manifest))
    assert run_benchmark(manifest_path, run_command=fake_probe)["aggregate"]["quality_status"] == "fail"


def test_category_drift_and_project_escape_fail_closed(tmp_path: Path) -> None:
    manifest_path = generate_fixture_corpus(tmp_path, run_command=fake_media)
    manifest = json.loads(manifest_path.read_text())
    manifest["scenarios"][4]["category"] = "talking_head"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ContractValidationError, match="each required category"):
        run_benchmark(manifest_path, run_command=fake_probe)

    manifest = json.loads(generate_fixture_corpus(tmp_path / "second", run_command=fake_media).read_text())
    manifest["scenarios"][0]["evidence_files"]["ranking"] = "../../outside.json"
    escaped = tmp_path / "escaped.json"
    escaped.write_text(json.dumps(manifest))
    with pytest.raises(ContractValidationError, match="escapes project"):
        run_benchmark(escaped, run_command=fake_probe)
