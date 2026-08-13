from __future__ import annotations

import json
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest

from test_ranking import FakeProvider, candidate, judgment, response, setup_project
from vidmyo_repurpose.boundaries import (
    BOUNDARY_ARTIFACT_RELATIVE_PATH,
    BoundaryError,
    parse_silences,
    repair_and_extract,
    repair_span,
)
from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.ingest import fingerprint_file
from vidmyo_repurpose.ranking import rank_candidates


class MediaRunner:
    def __init__(self, silence: str = ""):
        self.silence = silence
        self.ffmpeg_calls: list[list[str]] = []
        self.ffprobe_calls: list[list[str]] = []
        self.durations: dict[str, float] = {}

    def ffmpeg(self, command: list[str]):
        self.ffmpeg_calls.append(command)
        if any("silencedetect=" in item for item in command):
            return subprocess.CompletedProcess(command, 0, "", self.silence)
        output = Path(command[-1])
        output.write_bytes(b"preview-media")
        self.durations[str(output)] = float(command[command.index("-t") + 1])
        return subprocess.CompletedProcess(command, 0, "", "")

    def ffprobe(self, command: list[str]):
        self.ffprobe_calls.append(command)
        path = str(Path(command[-1]))
        duration = self.durations.get(path)
        if duration is None:
            # Reused final files have the same candidate name as their prior temp file.
            candidate = Path(path).name.split(".")[0]
            duration = next(
                (value for key, value in self.durations.items() if candidate in Path(key).name),
                30.0,
            )
        document = {
            "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
            "format": {"duration": str(duration)},
        }
        return subprocess.CompletedProcess(command, 0, json.dumps(document), "")


def _ingest(source: Path, fingerprint: str) -> dict:
    return {
        "artifact_version": 1, "engine_version": "0.1.0",
        "source": {"path": str(source), "byte_size": source.stat().st_size, "fingerprint": fingerprint},
        "container": {"format_names": ["mp4"], "format_long_name": "MP4", "duration_seconds": 500.0},
        "video": {"codec_name": "h264", "width": 1920, "height": 1080, "average_frame_rate": 30.0, "real_frame_rate": 30.0, "duration_seconds": 500.0},
        "audio": {"codec_name": "aac", "sample_rate_hz": 48000, "channels": 2, "channel_layout": "stereo", "duration_seconds": 500.0},
    }


def prepared_project(tmp_path: Path, scores=(90, 20)):
    items = [candidate(f"clip_{index:03d}", 1 + (index - 1) * 100, 30 + (index - 1) * 100) for index in range(1, len(scores) + 1)]
    ranking_request, _ = setup_project(tmp_path, items)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"local-source-media")
    fingerprint = fingerprint_file(source)

    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["source"] = {"type": "local_file", "uri": str(source), "fingerprint": fingerprint}
    manifest["stages"]["ingest"] = {"state": "completed", "artifact": "artifacts/ingest-artifact.v1.json", "error": None}
    manifest_path.write_text(json.dumps(manifest))

    transcript_path = tmp_path / "artifacts" / "transcript-artifact.v1.json"
    transcript = json.loads(transcript_path.read_text())
    transcript["source"] = {"path": str(source), "fingerprint": fingerprint}
    transcript_path.write_text(json.dumps(transcript))
    candidate_path = tmp_path / "artifacts" / "candidate-artifact.v1.json"
    candidate_doc = json.loads(candidate_path.read_text())
    candidate_doc["source"]["fingerprint"] = fingerprint
    candidate_path.write_text(json.dumps(candidate_doc))
    ingest_path = tmp_path / "artifacts" / "ingest-artifact.v1.json"
    ingest_path.write_text(json.dumps(_ingest(source, fingerprint)))

    provider = FakeProvider([response(*[
        judgment(item, score=score, coherence=score, context=score)
        for item, score in zip(items, scores)
    ])])
    ranked = rank_candidates(ranking_request, provider=provider, retry_delay=lambda _seconds: None)
    manifest = json.loads(manifest_path.read_text())
    manifest["stages"]["rank"] = {"state": "completed", "artifact": "artifacts/ranking-artifact.v1.json", "error": None}
    manifest_path.write_text(json.dumps(manifest))
    request = {
        "protocol_version": 1, "job_id": "job_boundary_test", "project_dir": str(tmp_path),
        "stage": "repair_boundaries",
        "input_artifacts": [
            {"kind": "ingest_artifact", "path": "artifacts/ingest-artifact.v1.json", "version": 1},
            {"kind": "transcript_artifact", "path": "artifacts/transcript-artifact.v1.json", "version": 1},
            {"kind": "ranking_artifact", "path": "artifacts/ranking-artifact.v1.json", "version": 1},
        ],
        "options": {},
    }
    return request, items, ranked


def test_parse_silences_handles_complete_and_trailing_intervals():
    stderr = "silence_start: 1.0\nsilence_end: 2.25\nsilence_start: 9.5\n"
    assert parse_silences(stderr, 10.0) == [
        {"start_seconds": 1.0, "end_seconds": 2.25},
        {"start_seconds": 9.5, "end_seconds": 10.0},
    ]


def test_repair_uses_nearby_silence_without_losing_words():
    item = candidate("clip_001", 2, 31)
    ranked = {"candidate": item}
    words = {
        f"word_{index:06d}": {"start_seconds": float(index - 1), "end_seconds": index - 0.1}
        for index in range(1, 40)
    }
    span, evidence = repair_span(
        ranked, words,
        [{"start_seconds": 0.0, "end_seconds": 0.75}, {"start_seconds": 31.0, "end_seconds": 31.4}],
        100.0,
    )
    assert span["start_seconds"] == 0.75
    assert span["end_seconds"] == 31.0
    assert evidence["start_reason"] == evidence["end_reason"] == "nearby_silence"


def test_manual_word_override_is_exact_and_duration_checked():
    item = {"candidate": candidate("clip_001", 1, 30)}
    words = {f"word_{index:06d}": {"start_seconds": float(index - 1), "end_seconds": index - 0.1} for index in range(1, 60)}
    span, evidence = repair_span(item, words, [], 100.0, {"first_word_id": "word_000002", "last_word_id": "word_000032"})
    assert span["start_seconds"] == 1.0 and span["end_seconds"] == 31.9
    assert evidence["override_applied"] is True
    with pytest.raises(ContractValidationError, match="20–120"):
        repair_span(item, words, [], 100.0, {"first_word_id": "word_000002", "last_word_id": "word_000005"})


def test_default_extracts_only_recommended_and_records_every_candidate(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()
    result = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == ["clip_001"]
    assert [item["candidate_id"] for item in result.artifact["candidates"]] == ["clip_001", "clip_002"]
    by_id = {item["candidate_id"]: item for item in result.artifact["candidates"]}
    assert by_id["clip_001"]["extraction"]["state"] == "completed"
    assert by_id["clip_002"]["extraction"]["state"] == "not_requested"
    assert validate_document("boundary_artifact", result.artifact) is result.artifact


def test_explicit_nonrecommended_candidate_extracts_on_demand(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    request["options"] = {"candidate_ids": ["clip_002"]}
    media = MediaRunner()
    result = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == ["clip_002"]
    assert (tmp_path / "artifacts" / "preview-clips" / "clip_002.source.mp4").is_file()


def test_exact_retry_reuses_without_extraction_or_rewrite(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()
    first = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    before = first.path.read_bytes()
    second = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert len([call for call in media.ffmpeg_calls if any("silencedetect=" in item for item in call)]) == 2
    assert len([call for call in media.ffmpeg_calls if "-t" in call]) == 1


def test_schema_valid_cache_tampering_is_recomputed_not_reused(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()
    first = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    document = json.loads(first.path.read_text())
    document["settings"]["duration_tolerance_seconds"] = 999.0
    first.path.write_text(json.dumps(document))

    second = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is False
    assert second.artifact["settings"]["duration_tolerance_seconds"] < 1.0
    assert json.loads(first.path.read_text())["settings"] == second.artifact["settings"]


def test_unknown_duplicate_and_invalid_override_fail_before_ffmpeg(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()
    for options in (
        {"candidate_ids": ["clip_999"]},
        {"candidate_ids": ["clip_001", "clip_001"]},
        {"boundary_overrides": {"clip_999": {"first_word_id": "word_000001", "last_word_id": "word_000030"}}},
    ):
        request["options"] = options
        with pytest.raises(ContractValidationError):
            repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert media.ffmpeg_calls == []


def test_changed_source_fails_before_ffmpeg_and_preserves_prior_artifact(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()
    first = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    before = first.path.read_bytes()
    (tmp_path / "source.mp4").write_bytes(b"changed")
    with pytest.raises(BoundaryError) as captured:
        repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert captured.value.code == "boundary_source_changed"
    assert first.path.read_bytes() == before


def test_cancellation_preserves_completed_clip_and_resumes(tmp_path):
    request, _, _ = prepared_project(tmp_path, scores=(90, 80))
    media = MediaRunner()
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks > 1

    with pytest.raises(BoundaryError, match="cancelled"):
        repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe, cancelled=cancelled)
    partial = validate_document("boundary_artifact", json.loads((tmp_path / BOUNDARY_ARTIFACT_RELATIVE_PATH).read_text()))
    assert partial["candidates"][0]["extraction"]["state"] == "completed"
    result = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert all(item["extraction"]["state"] == "completed" for item in result.artifact["candidates"])


def test_ffmpeg_failure_leaves_no_temp_or_false_artifact(tmp_path):
    request, _, _ = prepared_project(tmp_path)
    media = MediaRunner()

    def fail(command):
        if any("silencedetect=" in item for item in command):
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 1, "", "failed")

    with pytest.raises(BoundaryError) as captured:
        repair_and_extract(request, ffmpeg=fail, ffprobe=media.ffprobe)
    assert captured.value.code == "preview_extraction_failed"
    assert not (tmp_path / BOUNDARY_ARTIFACT_RELATIVE_PATH).exists()
    assert list((tmp_path / "artifacts" / "preview-clips").glob(".*.tmp.mp4")) == []


def test_empty_shortlist_writes_valid_artifact_without_preview(tmp_path):
    request, _, _ = prepared_project(tmp_path, scores=(20, 20))
    media = MediaRunner()
    result = repair_and_extract(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == []
    assert not (tmp_path / "artifacts" / "preview-clips").exists()
    assert validate_document("boundary_artifact", result.artifact)


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="FFmpeg and ffprobe are required for the disposable media smoke test",
)
def test_real_ffmpeg_extracts_valid_disposable_h264_aac_preview(tmp_path):
    request, _, _ = prepared_project(tmp_path, scores=(90,))
    source = tmp_path / "source.mp4"
    generated = subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=15:d=40",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=40",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(source),
    ], check=False, capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr

    fingerprint = fingerprint_file(source)
    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["source"]["fingerprint"] = fingerprint
    manifest_path.write_text(json.dumps(manifest))
    for name in (
        "ingest-artifact.v1.json", "transcript-artifact.v1.json",
        "ranking-artifact.v1.json",
    ):
        path = tmp_path / "artifacts" / name
        document = json.loads(path.read_text())
        document["source"]["fingerprint"] = fingerprint
        if name == "ingest-artifact.v1.json":
            document["source"]["byte_size"] = source.stat().st_size
        path.write_text(json.dumps(document))

    result = repair_and_extract(request)
    extraction = result.artifact["candidates"][0]["extraction"]
    assert extraction["state"] == "completed"
    preview = tmp_path / extraction["path"]
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_type,codec_name", "-of", "json", str(preview),
    ], check=True, capture_output=True, text=True)
    streams = json.loads(probe.stdout)["streams"]
    assert {item["codec_type"]: item["codec_name"] for item in streams} == {
        "video": "h264", "audio": "aac",
    }
