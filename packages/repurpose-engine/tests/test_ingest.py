from __future__ import annotations

import json
import os
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest

from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.ingest import (
    INGEST_ARTIFACT_RELATIVE_PATH,
    IngestError,
    build_ingest_artifact,
    fingerprint_file,
    normalize_probe,
    write_ingest_artifact,
)


def valid_probe() -> dict:
    return {
        "format": {
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "format_long_name": "QuickTime / MOV",
            "duration": "12.5",
        },
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "30000/1001",
                "r_frame_rate": "30/1",
                "duration": "N/A",
            },
            {
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
                "channel_layout": "stereo",
                "duration": None,
            },
        ],
    }


def completed_probe(document: dict, *, returncode: int = 0, stderr: str = ""):
    return lambda _command: subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=json.dumps(document), stderr=stderr
    )


def manifest(source: Path, *, source_type: str = "local_file") -> dict:
    return {"source": {"type": source_type, "uri": str(source), "fingerprint": None}}


def test_streaming_fingerprint_depends_on_bytes_not_path_or_timestamp(tmp_path: Path):
    first = tmp_path / "first.mp4"
    first.write_bytes(b"same bytes")
    initial = fingerprint_file(first, chunk_size=3)
    renamed = tmp_path / "renamed.mp4"
    first.rename(renamed)
    os.utime(renamed, (1, 1))
    assert fingerprint_file(renamed, chunk_size=2) == initial
    renamed.write_bytes(b"different bytes")
    assert fingerprint_file(renamed) != initial


def test_successful_ingest_normalizes_probe_metadata_and_schema(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media payload")
    artifact = build_ingest_artifact(
        tmp_path,
        manifest(source),
        run_probe=completed_probe(valid_probe()),
    )
    assert artifact["artifact_version"] == 1
    assert artifact["source"]["path"] == str(source.resolve())
    assert artifact["source"]["byte_size"] == len(b"media payload")
    assert artifact["source"]["fingerprint"].startswith("sha256:")
    assert artifact["container"]["format_names"] == ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]
    assert artifact["container"]["duration_seconds"] == 12.5
    assert artifact["video"]["average_frame_rate"] == pytest.approx(29.97002997)
    assert artifact["video"]["duration_seconds"] is None
    assert artifact["audio"]["sample_rate_hz"] == 48000
    assert artifact["audio"]["duration_seconds"] is None
    assert validate_document("ingest_artifact", artifact) is artifact


def test_relative_source_resolves_from_project_directory(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    artifact = build_ingest_artifact(
        tmp_path,
        manifest(Path("source.mp4")),
        run_probe=completed_probe(valid_probe()),
    )
    assert artifact["source"]["path"] == str(source.resolve())


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda probe: probe.update({"streams": probe["streams"][1:]}), "video_stream_missing"),
        (lambda probe: probe.update({"streams": probe["streams"][:1]}), "audio_stream_missing"),
        (lambda probe: probe["format"].update({"duration": "N/A"}), "invalid_media_duration"),
        (lambda probe: probe["format"].update({"duration": "inf"}), "invalid_media_duration"),
    ],
)
def test_probe_validation_failures_have_stable_codes(tmp_path: Path, mutate, code: str):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    probe = valid_probe()
    mutate(probe)
    with pytest.raises(IngestError) as captured:
        build_ingest_artifact(tmp_path, manifest(source), run_probe=completed_probe(probe))
    assert captured.value.code == code
    assert captured.value.preserved
    assert captured.value.next_action


def test_missing_directory_and_unreadable_sources_are_rejected(tmp_path: Path):
    missing = tmp_path / "missing.mp4"
    with pytest.raises(IngestError) as captured:
        build_ingest_artifact(tmp_path, manifest(missing), run_probe=completed_probe(valid_probe()))
    assert captured.value.code == "source_missing"

    directory = tmp_path / "directory"
    directory.mkdir()
    with pytest.raises(IngestError) as captured:
        build_ingest_artifact(tmp_path, manifest(directory), run_probe=completed_probe(valid_probe()))
    assert captured.value.code == "source_not_regular_file"

    unreadable = tmp_path / "unreadable.mp4"
    unreadable.write_bytes(b"media")
    unreadable.chmod(0)
    try:
        with pytest.raises(IngestError) as captured:
            build_ingest_artifact(
                tmp_path, manifest(unreadable), run_probe=completed_probe(valid_probe())
            )
        assert captured.value.code == "source_not_readable"
    finally:
        unreadable.chmod(0o600)


def test_ffprobe_unavailable_failed_and_invalid_json_are_distinct(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")

    def unavailable(_command):
        raise FileNotFoundError("ffprobe")

    cases = [
        (unavailable, "ffprobe_not_available"),
        (completed_probe({}, returncode=1, stderr="bad media"), "ffprobe_failed"),
        (
            lambda _command: subprocess.CompletedProcess([], 0, "not-json", ""),
            "ffprobe_invalid_json",
        ),
        (completed_probe({"streams": "not-a-list", "format": {}}), "ffprobe_invalid_metadata"),
    ]
    for runner, code in cases:
        with pytest.raises(IngestError) as captured:
            build_ingest_artifact(tmp_path, manifest(source), run_probe=runner)
        assert captured.value.code == code


def test_source_mutation_during_fingerprint_is_rejected(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"before")
    calls = 0

    def mutate_after_hash(path: Path) -> str:
        nonlocal calls
        calls += 1
        result = fingerprint_file(path)
        if calls == 1:
            path.write_bytes(b"after and different")
        return result

    with pytest.raises(IngestError) as captured:
        build_ingest_artifact(
            tmp_path,
            manifest(source),
            run_probe=completed_probe(valid_probe()),
            fingerprint=mutate_after_hash,
        )
    assert captured.value.code == "source_changed_during_ingest"


def test_url_source_is_rejected_before_probe_or_file_access(tmp_path: Path):
    probed = False

    def forbidden_probe(_command):
        nonlocal probed
        probed = True
        raise AssertionError("probe must not run")

    with pytest.raises(IngestError) as captured:
        build_ingest_artifact(
            tmp_path,
            manifest(Path("https://example.com/video"), source_type="url"),
            run_probe=forbidden_probe,
        )
    assert captured.value.code == "url_ingest_not_implemented"
    assert not probed


def test_atomic_writer_validates_before_replace_and_leaves_no_partial(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    artifact = build_ingest_artifact(
        tmp_path, manifest(source), run_probe=completed_probe(valid_probe())
    )
    destination = write_ingest_artifact(tmp_path, artifact)
    assert destination == tmp_path / INGEST_ARTIFACT_RELATIVE_PATH
    assert json.loads(destination.read_text(encoding="utf-8")) == artifact
    previous = destination.read_bytes()

    invalid = deepcopy(artifact)
    invalid["source"]["fingerprint"] = "not-a-fingerprint"
    with pytest.raises(ContractValidationError):
        write_ingest_artifact(tmp_path, invalid)
    assert destination.read_bytes() == previous
    assert list(destination.parent.glob(".*.tmp")) == []


def test_optional_probe_literals_normalize_to_null():
    probe = valid_probe()
    probe["format"]["format_long_name"] = "N/A"
    probe["streams"][0].update({"codec_name": "N/A", "width": "N/A", "avg_frame_rate": "0/0"})
    probe["streams"][1].update({"sample_rate": "N/A", "channels": "N/A", "channel_layout": "N/A"})
    normalized = normalize_probe(probe)
    assert normalized["container"]["format_long_name"] is None
    assert normalized["video"]["codec_name"] is None
    assert normalized["video"]["width"] is None
    assert normalized["video"]["average_frame_rate"] is None
    assert normalized["audio"]["sample_rate_hz"] is None
    assert normalized["audio"]["channels"] is None
    assert normalized["audio"]["channel_layout"] is None
