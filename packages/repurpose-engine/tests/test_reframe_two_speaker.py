from __future__ import annotations

import json
import shutil
import subprocess
from argparse import Namespace
from pathlib import Path

import pytest

import vidmyo_repurpose.cli as cli
from test_reframe import FakeDetector, ReframeMedia, face, prepared_reframe
from vidmyo_repurpose.boundaries import BOUNDARY_ARTIFACT_RELATIVE_PATH
from vidmyo_repurpose.contracts import ContractValidationError, validate_document, validate_event_stream
from vidmyo_repurpose.reframe import REFRAME_ARTIFACT_RELATIVE_PATH, reframe_previews
from vidmyo_repurpose.reframe_two import (
    REFRAME_V2_ARTIFACT_RELATIVE_PATH,
    TwoSpeakerReframeError,
    TwoSpeakerReframeResult,
    _render_split,
    plan_two_speaker_layout,
    upgrade_reframe_previews,
)


def pair(left=420.0, right=1280.0, confidence=0.95):
    return [face(left, confidence), face(right, confidence)]


def prepared_two_speaker(
    tmp_path: Path, *, detector=None, scores=(90, 20), candidate_ids=None,
):
    request = prepared_reframe(tmp_path, scores=scores, candidate_ids=candidate_ids)
    media = ReframeMedia()
    reframe_previews(
        request,
        detector=detector or FakeDetector(lambda _time: pair()),
        ffmpeg=media.ffmpeg,
        ffprobe=media.ffprobe,
    )
    return {
        "protocol_version": 1,
        "job_id": "job_two_speaker_test",
        "project_dir": str(tmp_path),
        "stage": "reframe",
        "input_artifacts": [
            {"kind": "reframe_artifact", "path": REFRAME_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1},
            {"kind": "boundary_artifact", "path": BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1},
        ],
        "options": {},
    }


def test_stable_pair_is_assigned_left_to_upper_and_right_to_lower():
    times = [index * 0.5 for index in range(20)]
    detections = [pair(420 + index * 2, 1280 + index * 2) for index in range(20)]
    plan = plan_two_speaker_layout(detections, times, 1920, 1080, 10.0)
    assert plan["mode"] == "two_speaker_split"
    assert plan["paired_coverage"] == 1.0
    assert plan["safe_zone_fraction"] >= 0.95
    assert all(sample["assignment"] == {"upper_face_index": 0, "lower_face_index": 1} for sample in plan["samples"])
    assert all(segment["upper"]["width"] == 1214 and segment["upper"]["height"] == 1080 for segment in plan["segments"])


def test_both_panel_tracks_obey_movement_limit():
    times = [index * 0.5 for index in range(20)]
    detections = [pair(360 + index * 10, 1120 + index * 10) for index in range(20)]
    plan = plan_two_speaker_layout(detections, times, 1920, 1080, 10.0)
    assert plan["mode"] == "two_speaker_split"
    for panel in ("upper", "lower"):
        positions = [segment[panel]["x"] for segment in plan["segments"]]
        crop_width = plan["segments"][0][panel]["width"]
        assert max(abs(right - left) for left, right in zip(positions, positions[1:])) <= crop_width * 0.08 + 1


@pytest.mark.parametrize(("detections", "reason"), [
    ([pair() if index < 7 else [] for index in range(10)], "insufficient_pair_coverage"),
    ([pair(confidence=0.5) for _ in range(10)], "insufficient_pair_coverage"),
    ([pair() + [face(850)] for _ in range(10)], "extra_faces"),
    ([pair(400, 1300), pair(790, 830)] + [pair(790, 830) for _ in range(8)], "ambiguous_crossing"),
])
def test_uncertain_pair_uses_named_fallback(detections, reason):
    times = [index * 0.5 for index in range(10)]
    plan = plan_two_speaker_layout(detections, times, 1920, 1080, 5.0)
    assert plan["mode"] == "fallback_reuse"
    assert plan["fallback_reason"] == reason
    assert plan["segments"] == []


def test_upgrade_renders_top_bottom_split_and_records_v2_artifact(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    item = result.artifact["candidates"][0]
    assert item["mode"] == "two_speaker_split"
    assert item["output"]["origin"] == "v2_render"
    assert item["output"]["state"] == "completed"
    graph = media.ffmpeg_calls[-1][media.ffmpeg_calls[-1].index("-filter_complex") + 1]
    assert "vstack=inputs=2" in graph
    assert "scale=1080:960" in graph
    assert validate_document("reframe_artifact_v2", result.artifact)


def test_single_speaker_output_is_reused_byte_for_byte(tmp_path):
    request = prepared_two_speaker(tmp_path, detector=FakeDetector())
    v1 = json.loads((tmp_path / REFRAME_ARTIFACT_RELATIVE_PATH).read_text())
    old_output = tmp_path / v1["candidates"][0]["output"]["path"]
    before = old_output.read_bytes()
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    item = result.artifact["candidates"][0]
    assert item["mode"] == "single_speaker_reuse"
    assert item["output"]["path"] == v1["candidates"][0]["output"]["path"]
    assert old_output.read_bytes() == before
    assert media.ffmpeg_calls == []


def test_unstable_pair_reuses_validated_v1_fallback(tmp_path):
    detector = FakeDetector(lambda timestamp: pair() if timestamp < 5 else [])
    request = prepared_two_speaker(tmp_path, detector=detector)
    v1 = json.loads((tmp_path / REFRAME_ARTIFACT_RELATIVE_PATH).read_text())
    old_output = tmp_path / v1["candidates"][0]["output"]["path"]
    before = old_output.read_bytes()
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    item = result.artifact["candidates"][0]
    assert item["mode"] == "fallback_reuse"
    assert item["fallback_reason"] == "insufficient_pair_coverage"
    assert item["output"]["origin"] == "v1_reuse"
    assert old_output.read_bytes() == before
    assert media.ffmpeg_calls == []


def test_exact_retry_is_no_rewrite_final_cache_hit(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    first = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    before = first.path.read_bytes()
    second = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert len(media.ffmpeg_calls) == 1


def test_schema_valid_cache_tampering_is_not_reused(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    first = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    tampered = json.loads(first.path.read_text())
    tampered["candidates"][0]["safe_zone_fraction"] = 0.96
    first.path.write_text(json.dumps(tampered))
    second = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is False
    assert second.artifact["candidates"][0]["safe_zone_fraction"] == 1.0


def test_cancellation_preserves_first_output_and_resumes(tmp_path):
    request = prepared_two_speaker(tmp_path, scores=(90, 80), candidate_ids=["clip_001", "clip_002"])
    media = ReframeMedia()
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks > 1

    with pytest.raises(TwoSpeakerReframeError, match="cancelled"):
        upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe, cancelled=cancelled)
    partial = validate_document("reframe_artifact_v2", json.loads((tmp_path / REFRAME_V2_ARTIFACT_RELATIVE_PATH).read_text()))
    assert partial["candidates"][0]["output"]["state"] == "completed"
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert all(item["output"]["state"] == "completed" for item in result.artifact["candidates"])
    assert len(media.ffmpeg_calls) == 2


def test_invalid_or_stale_inputs_fail_without_rendering(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    request["input_artifacts"][0]["path"] = "../reframe-artifact.v1.json"
    with pytest.raises(TwoSpeakerReframeError):
        upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert media.ffmpeg_calls == []


def test_render_failure_is_atomic_and_never_false_completes(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    with pytest.raises(TwoSpeakerReframeError, match="did not create"):
        upgrade_reframe_previews(
            request,
            ffmpeg=lambda command: subprocess.CompletedProcess(command, 1, "", "failed"),
            ffprobe=media.ffprobe,
        )
    assert not (tmp_path / REFRAME_V2_ARTIFACT_RELATIVE_PATH).exists()
    output_dir = tmp_path / "artifacts" / "reframed-previews-v2"
    assert list(output_dir.glob(".*.tmp.mp4")) == []


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg required")
def test_real_disposable_media_renders_valid_h264_aac_split(tmp_path):
    source = tmp_path / "source.mp4"
    generated = subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=s=320x180:r=15:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(source),
    ], capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr
    times = [0.0, 0.5]
    detections = [[
        {"x": 45.0, "y": 35.0, "width": 35.0, "height": 45.0, "confidence": 0.95},
        {"x": 235.0, "y": 35.0, "width": 35.0, "height": 45.0, "confidence": 0.95},
    ] for _ in times]
    plan = plan_two_speaker_layout(detections, times, 320, 180, 1.0)
    assert plan["mode"] == "two_speaker_split"
    destination = tmp_path / "split.vertical.mp4"
    output = _render_split(
        source, destination, plan, 1.0, 0.2,
        ffmpeg=lambda command: subprocess.run(command, capture_output=True, text=True),
        ffprobe=lambda command: subprocess.run(command, capture_output=True, text=True),
    )
    assert output["state"] == "completed"
    checked = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height",
        "-of", "json", str(destination),
    ], check=True, capture_output=True, text=True)
    streams = json.loads(checked.stdout)["streams"]
    video = next(item for item in streams if item["codec_type"] == "video")
    audio = next(item for item in streams if item["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 1080, 1920)
    assert audio["codec_name"] == "aac"


def test_reused_output_tampering_fails_semantic_validation(tmp_path):
    request = prepared_two_speaker(tmp_path, detector=FakeDetector())
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    tampered = json.loads(result.path.read_text())
    tampered["candidates"][0]["output"]["path"] = "artifacts/other.mp4"
    with pytest.raises(ContractValidationError, match="preserve the exact v1 output"):
        validate_document("reframe_artifact_v2", tampered)


def test_v2_output_path_tampering_fails_semantic_validation(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    tampered = json.loads(result.path.read_text())
    tampered["candidates"][0]["output"]["path"] = "artifacts/reframed-previews-v2/other.mp4"
    with pytest.raises(ContractValidationError, match="deterministic candidate path"):
        validate_document("reframe_artifact_v2", tampered)


def test_split_threshold_and_crop_tampering_fails_semantic_validation(tmp_path):
    request = prepared_two_speaker(tmp_path)
    media = ReframeMedia()
    result = upgrade_reframe_previews(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    threshold_tamper = json.loads(result.path.read_text())
    threshold_tamper["candidates"][0]["safe_zone_fraction"] = 0.94
    with pytest.raises(ContractValidationError, match="required threshold"):
        validate_document("reframe_artifact_v2", threshold_tamper)
    crop_tamper = json.loads(result.path.read_text())
    crop_tamper["candidates"][0]["segments"][0]["upper"]["x"] = 1919
    with pytest.raises(ContractValidationError, match="exceeds the source frame"):
        validate_document("reframe_artifact_v2", crop_tamper)


def test_cli_emits_ordered_v2_artifact_and_completion(tmp_path, monkeypatch, capsys):
    request = {
        "protocol_version": 1, "job_id": "job_cli_reframe_two", "project_dir": str(tmp_path),
        "stage": "reframe", "input_artifacts": [], "options": {},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request))
    artifact_path = tmp_path / REFRAME_V2_ARTIFACT_RELATIVE_PATH

    def runner(_request, *, progress, cancelled):
        assert cancelled() is False
        progress({"phase": "validating_inputs", "fraction": 0.1, "message": "valid"})
        return TwoSpeakerReframeResult({
            "cache_key": "sha256:" + "a" * 64,
            "candidates": [{"output": {"state": "completed"}}],
        }, artifact_path, False)

    monkeypatch.setattr(cli, "upgrade_reframe_previews", runner)
    assert cli._reframe_two(Namespace(request=str(request_path))) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "artifact", "completed"]
    assert events[-2]["payload"]["version"] == 2
    assert validate_event_stream(events) == events


def test_cli_failure_is_terminal_without_false_completion(tmp_path, monkeypatch, capsys):
    request = {
        "protocol_version": 1, "job_id": "job_cli_reframe_two_fail", "project_dir": str(tmp_path),
        "stage": "reframe", "input_artifacts": [], "options": {},
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request))

    def runner(_request, *, progress, cancelled):
        progress({"phase": "validating_inputs", "message": "valid"})
        raise TwoSpeakerReframeError("two_speaker_reframe_cancelled", "cancelled", "preserved", "retry")

    monkeypatch.setattr(cli, "upgrade_reframe_previews", runner)
    assert cli._reframe_two(Namespace(request=str(request_path))) != 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "error"]
    assert validate_event_stream(events) == events
