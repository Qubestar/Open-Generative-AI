from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from test_boundaries import MediaRunner, prepared_project
from vidmyo_repurpose.boundaries import BOUNDARY_ARTIFACT_RELATIVE_PATH, repair_and_extract
from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.ingest import fingerprint_file
from vidmyo_repurpose.reframe import (
    REFRAME_ARTIFACT_RELATIVE_PATH,
    ReframeError,
    YuNetDetector,
    plan_tracking,
    reframe_previews,
)


class FakeDetector:
    def __init__(self, factory=None):
        self.factory = factory or (lambda _time: [{
            "x": 700.0, "y": 220.0, "width": 180.0, "height": 220.0,
            "confidence": 0.95,
        }])
        self.calls = 0

    def detect(self, _path, times):
        self.calls += 1
        return [self.factory(time) for time in times]


class ReframeMedia:
    def __init__(self):
        self.ffmpeg_calls = []
        self.ffprobe_calls = []
        self.output_durations = {}

    def ffmpeg(self, command):
        self.ffmpeg_calls.append(command)
        output = Path(command[-1])
        output.write_bytes(b"vertical-preview")
        self.output_durations[str(output)] = 29.9
        return subprocess.CompletedProcess(command, 0, "", "")

    def ffprobe(self, command):
        self.ffprobe_calls.append(command)
        path = Path(command[-1])
        is_output = "vertical" in path.name or ".tmp" in path.name
        duration = self.output_durations.get(str(path), 29.9)
        document = {
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1080 if is_output else 1920, "height": 1920 if is_output else 1080},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
            "format": {"duration": str(duration)},
        }
        return subprocess.CompletedProcess(command, 0, json.dumps(document), "")


def prepared_reframe(tmp_path: Path, scores=(90, 20), candidate_ids=None):
    boundary_request, _, _ = prepared_project(tmp_path, scores=scores)
    if candidate_ids is not None:
        boundary_request["options"] = {"candidate_ids": candidate_ids}
    boundary_media = MediaRunner()
    repair_and_extract(boundary_request, ffmpeg=boundary_media.ffmpeg, ffprobe=boundary_media.ffprobe)
    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["stages"]["repair_boundaries"] = {
        "state": "completed", "artifact": BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(), "error": None,
    }
    manifest_path.write_text(json.dumps(manifest))
    return {
        "protocol_version": 1, "job_id": "job_reframe_test", "project_dir": str(tmp_path),
        "stage": "reframe",
        "input_artifacts": [{"kind": "boundary_artifact", "path": BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1}],
        "options": {},
    }


def face(x=700.0, confidence=0.95):
    return {"x": x, "y": 220.0, "width": 180.0, "height": 220.0, "confidence": confidence}


def test_single_face_plan_is_stable_bounded_and_safe():
    times = [index * 0.5 for index in range(20)]
    detections = [[face(680 + index * 4)] for index in range(20)]
    plan = plan_tracking(detections, times, 1920, 1080, 10.0)
    assert plan["mode"] == "track"
    assert plan["safe_zone_fraction"] >= 0.95
    positions = [item["crop_x"] for item in plan["samples"]]
    crop_width = plan["segments"][0]["width"]
    assert max(abs(right - left) for left, right in zip(positions, positions[1:])) <= crop_width * 0.08
    assert all(0 <= item["x"] <= 1920 - item["width"] for item in plan["segments"])


@pytest.mark.parametrize(("factory", "reason"), [
    (lambda _time: [], "no_face"),
    (lambda _time: [face(), face(1000)], "multiple_faces"),
    (lambda _time: [face(confidence=0.5)], "low_confidence"),
])
def test_uncertain_detection_uses_named_fallback(factory, reason):
    times = [0.0, 0.5, 1.0]
    plan = plan_tracking([factory(time) for time in times], times, 1920, 1080, 1.5)
    assert plan["mode"] == "fallback"
    assert plan["fallback_reason"] == reason
    assert plan["segments"] == []


def test_missing_samples_below_coverage_threshold_fall_back():
    times = [index * 0.5 for index in range(10)]
    detections = [[face()] if index < 7 else [] for index in range(10)]
    plan = plan_tracking(detections, times, 1920, 1080, 5.0)
    assert plan["fallback_reason"] == "insufficient_face_coverage"


def test_default_reframes_completed_recommended_preview_and_records_artifact(tmp_path):
    request = prepared_reframe(tmp_path)
    media = ReframeMedia()
    result = reframe_previews(request, detector=FakeDetector(), ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == ["clip_001"]
    item = result.artifact["candidates"][0]
    assert item["mode"] == "track"
    assert item["output"]["state"] == "completed"
    assert item["output"]["width"] == 1080 and item["output"]["height"] == 1920
    assert validate_document("reframe_artifact", result.artifact)


def test_explicit_completed_nonrecommended_preview_reframes_on_demand(tmp_path):
    request = prepared_reframe(tmp_path, scores=(90, 80), candidate_ids=["clip_001", "clip_002"])
    request["options"] = {"candidate_ids": ["clip_002"]}
    media = ReframeMedia()
    result = reframe_previews(request, detector=FakeDetector(), ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == ["clip_002"]
    assert (tmp_path / "artifacts" / "reframed-previews" / "clip_002.vertical.mp4").is_file()


def test_fallback_filter_preserves_complete_foreground_over_blur(tmp_path):
    request = prepared_reframe(tmp_path)
    media = ReframeMedia()
    result = reframe_previews(request, detector=FakeDetector(lambda _time: []), ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["candidates"][0]["fallback_reason"] == "no_face"
    filter_graph = media.ffmpeg_calls[-1][media.ffmpeg_calls[-1].index("-filter_complex") + 1]
    assert "boxblur" in filter_graph
    assert "force_original_aspect_ratio=decrease" in filter_graph


def test_exact_retry_is_no_rewrite_cache_hit(tmp_path):
    request = prepared_reframe(tmp_path)
    media = ReframeMedia()
    detector = FakeDetector()
    first = reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    before = first.path.read_bytes()
    second = reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert len(media.ffmpeg_calls) == 1


def test_schema_valid_cache_tampering_is_not_reused(tmp_path):
    request = prepared_reframe(tmp_path)
    media = ReframeMedia()
    detector = FakeDetector()
    first = reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    artifact = json.loads(first.path.read_text())
    artifact["settings"]["duration_tolerance_seconds"] = 999.0
    first.path.write_text(json.dumps(artifact))
    second = reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is False
    assert second.artifact["settings"]["duration_tolerance_seconds"] < 1


def test_invalid_candidate_and_escaping_artifact_fail_before_detection(tmp_path):
    request = prepared_reframe(tmp_path)
    detector = FakeDetector()
    media = ReframeMedia()
    request["options"] = {"candidate_ids": ["clip_999"]}
    with pytest.raises(ContractValidationError):
        reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    request["options"] = {}
    request["input_artifacts"][0]["path"] = "../boundary-artifact.v1.json"
    with pytest.raises(ReframeError) as captured:
        reframe_previews(request, detector=detector, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert captured.value.code == "reframe_input_invalid"
    assert detector.calls == 0


def test_cancellation_checkpoints_and_resumes_between_candidates(tmp_path):
    request = prepared_reframe(tmp_path, scores=(90, 80), candidate_ids=["clip_001", "clip_002"])
    media = ReframeMedia()
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks > 1

    with pytest.raises(ReframeError, match="cancelled"):
        reframe_previews(request, detector=FakeDetector(), ffmpeg=media.ffmpeg, ffprobe=media.ffprobe, cancelled=cancelled)
    partial = validate_document("reframe_artifact", json.loads((tmp_path / REFRAME_ARTIFACT_RELATIVE_PATH).read_text()))
    assert partial["candidates"][0]["output"]["state"] == "completed"
    result = reframe_previews(request, detector=FakeDetector(), ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert all(item["output"]["state"] == "completed" for item in result.artifact["candidates"])


def test_render_failure_removes_temp_and_never_false_completes(tmp_path):
    request = prepared_reframe(tmp_path)
    media = ReframeMedia()
    with pytest.raises(ReframeError) as captured:
        reframe_previews(
            request, detector=FakeDetector(),
            ffmpeg=lambda command: subprocess.CompletedProcess(command, 1, "", "failed"),
            ffprobe=media.ffprobe,
        )
    assert captured.value.code == "reframe_render_failed"
    assert not (tmp_path / REFRAME_ARTIFACT_RELATIVE_PATH).exists()
    assert list((tmp_path / "artifacts" / "reframed-previews").glob(".*.tmp.mp4")) == []


def test_bundled_yunet_model_has_expected_checksum():
    detector = YuNetDetector()
    assert fingerprint_file(detector.model_path) == "sha256:8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


def test_corrupt_yunet_model_is_rejected_before_detection(tmp_path):
    model = tmp_path / "yunet.onnx"
    model.write_bytes(b"corrupt")
    with pytest.raises(ReframeError) as captured:
        YuNetDetector(model)
    assert captured.value.code == "reframe_model_invalid"


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg required")
def test_real_disposable_media_fallback_renders_valid_vertical_h264_aac(tmp_path):
    request = prepared_reframe(tmp_path)
    boundary_path = tmp_path / BOUNDARY_ARTIFACT_RELATIVE_PATH
    boundary = json.loads(boundary_path.read_text())
    preview = tmp_path / boundary["candidates"][0]["extraction"]["path"]
    generated = subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=15:d=29.9",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=29.9",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(preview),
    ], check=False, capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-of", "json", str(preview)], check=True, capture_output=True, text=True)
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    boundary["candidates"][0]["extraction"]["fingerprint"] = fingerprint_file(preview)
    boundary["candidates"][0]["extraction"]["duration_seconds"] = duration
    boundary_path.write_text(json.dumps(boundary))

    result = reframe_previews(request, detector=YuNetDetector())
    assert result.artifact["candidates"][0]["fallback_reason"] == "no_face"
    output = tmp_path / result.artifact["candidates"][0]["output"]["path"]
    checked = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", str(output),
    ], check=True, capture_output=True, text=True)
    streams = json.loads(checked.stdout)["streams"]
    video = next(item for item in streams if item["codec_type"] == "video")
    audio = next(item for item in streams if item["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 1080, 1920)
    assert audio["codec_name"] == "aac"

    tracked = reframe_previews(
        request,
        detector=FakeDetector(lambda _time: [{
            "x": 60.0, "y": 25.0, "width": 20.0, "height": 30.0,
            "confidence": 0.95,
        }]),
    )
    assert tracked.artifact["candidates"][0]["mode"] == "track"
    tracked_output = tmp_path / tracked.artifact["candidates"][0]["output"]["path"]
    tracked_probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", str(tracked_output),
    ], check=True, capture_output=True, text=True)
    tracked_video = next(item for item in json.loads(tracked_probe.stdout)["streams"] if item["codec_type"] == "video")
    assert (tracked_video["width"], tracked_video["height"]) == (1080, 1920)
