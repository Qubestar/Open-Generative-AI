from __future__ import annotations

import json
import shutil
import subprocess
from argparse import Namespace
from pathlib import Path

import pytest

import vidmyo_repurpose.cli as cli
from test_reframe import ReframeMedia
from test_reframe_two_speaker import prepared_two_speaker
from vidmyo_repurpose.boundaries import BOUNDARY_ARTIFACT_RELATIVE_PATH
from vidmyo_repurpose.contracts import ContractValidationError, validate_document, validate_event_stream
from vidmyo_repurpose.reframe import REFRAME_ARTIFACT_RELATIVE_PATH
from vidmyo_repurpose.reframe_two import REFRAME_V2_ARTIFACT_RELATIVE_PATH, upgrade_reframe_previews
from vidmyo_repurpose.render import (
    RENDER_ARTIFACT_RELATIVE_PATH,
    TRANSCRIPT_ARTIFACT_RELATIVE_PATH,
    RenderError,
    RenderResult,
    _run_output,
    build_caption_overlay,
    build_caption_cues,
    render_platform_outputs,
)


class RenderMedia:
    def __init__(self):
        self.ffmpeg_calls: list[list[str]] = []
        self.ffprobe_calls: list[list[str]] = []

    def ffmpeg(self, command):
        self.ffmpeg_calls.append(command)
        Path(command[-1]).write_bytes(f"render-{len(self.ffmpeg_calls)}".encode())
        return subprocess.CompletedProcess(command, 0, "", "")

    def ffprobe(self, command):
        self.ffprobe_calls.append(command)
        document = {
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
            "format": {"duration": "29.9"},
        }
        return subprocess.CompletedProcess(command, 0, json.dumps(document), "")


def prepared_render(tmp_path: Path, *, style="clean", selected=True):
    two_request = prepared_two_speaker(tmp_path)
    reframe_media = ReframeMedia()
    v2 = upgrade_reframe_previews(two_request, ffmpeg=reframe_media.ffmpeg, ffprobe=reframe_media.ffprobe)
    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    for stage in ("ingest", "transcribe", "generate_candidates", "rank", "repair_boundaries", "reframe"):
        manifest["stages"][stage] = {"state": "completed", "artifact": f"artifacts/{stage}.json", "error": None}
    manifest["stages"]["reframe"]["artifact"] = REFRAME_V2_ARTIFACT_RELATIVE_PATH.as_posix()
    manifest["target_platforms"] = ["youtube_shorts", "tiktok", "instagram_reels"]
    manifest["render_defaults"]["captions"] = {"enabled": True, "style": style, "translation_target_language": None}
    manifest["candidates"] = [
        {
            "id": candidate_id, "decision": "approved", "selected": selected,
            "proposed_start_sec": None, "proposed_end_sec": None, "metadata": {},
        }
        for candidate_id in v2.artifact["requested_candidate_ids"]
    ]
    manifest_path.write_text(json.dumps(manifest))
    return {
        "protocol_version": 1, "job_id": "job_render_test", "project_dir": str(tmp_path),
        "stage": "render",
        "input_artifacts": [
            {"kind": "transcript_artifact", "path": TRANSCRIPT_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1},
            {"kind": "boundary_artifact", "path": BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1},
            {"kind": "reframe_artifact", "path": REFRAME_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 1},
            {"kind": "reframe_artifact", "path": REFRAME_V2_ARTIFACT_RELATIVE_PATH.as_posix(), "version": 2},
        ],
        "options": {},
    }


def test_caption_cues_preserve_every_word_once_and_respect_phrase_limits():
    words = [
        {"id": f"word_{index:06d}", "text": text, "start_seconds": index - 1.0, "end_seconds": index - 0.2}
        for index, text in enumerate(("One", "complete", "idea.", "Another", "short", "useful", "idea!"), 1)
    ]
    cues = build_caption_cues(words, clip_start=0.0, clip_duration=10.0, max_words=4, max_characters=24)
    assert [word_id for cue in cues for word_id in cue["word_ids"]] == [word["id"] for word in words]
    assert all(len(cue["word_ids"]) <= 4 and len(cue["text"]) <= 24 for cue in cues)
    assert cues[0]["text"] == "One complete idea."


def test_clean_and_bold_overlays_measure_visible_phrase_with_symmetric_padding(tmp_path):
    import cv2
    import numpy as np

    for style in ("clean", "bold"):
        path = tmp_path / f"{style}.png"
        overlay = build_caption_overlay("Whole phrase", style, path)
        image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        text_y, text_x = np.where(np.any(image[:, :, :3] != 0, axis=2))
        backing_y, backing_x = np.where(image[:, :, 3] != 0)
        assert (int(text_x.min()), int(text_x.max())) == (overlay["text_left"], overlay["text_right"])
        assert (int(backing_x.min()), int(backing_x.max())) == (overlay["backing_left"], overlay["backing_right"])
        assert overlay["visible_padding_left"] == overlay["visible_padding_right"]
        assert overlay["text_left"] - overlay["backing_left"] == overlay["visible_padding_left"]
        assert overlay["backing_right"] - overlay["text_right"] == overlay["visible_padding_right"]


def test_no_usable_words_produce_no_fabricated_caption_cues():
    assert build_caption_cues([], clip_start=20.0, clip_duration=30.0) == []


def test_render_creates_captioned_master_and_all_platform_exports(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    item = result.artifact["candidates"][0]
    assert item["state"] == "completed"
    assert item["caption"]["state"] == "completed"
    assert [entry["preset_id"] for entry in item["exports"]] == ["youtube_shorts", "tiktok", "instagram_reels"]
    assert len(media.ffmpeg_calls) == 4
    assert "overlay=0:0:enable=" in media.ffmpeg_calls[0][media.ffmpeg_calls[0].index("-filter_complex") + 1]
    assert validate_document("render_artifact", result.artifact) is result.artifact


def test_bold_style_uses_separate_deterministic_paths(tmp_path):
    request = prepared_render(tmp_path, style="bold")
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    item = result.artifact["candidates"][0]
    assert item["master"]["path"].endswith("clip_001.bold.master.mp4")
    assert item["caption"]["path"].endswith("clip_001.bold.json")


def test_disabled_captions_create_valid_uncaptioned_outputs_with_reason(tmp_path):
    request = prepared_render(tmp_path)
    request["options"] = {"captions_enabled": False, "platforms": ["youtube_shorts"]}
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    caption = result.artifact["candidates"][0]["caption"]
    assert caption["state"] == "not_required" and caption["fallback_reason"] == "captions_disabled"
    assert "-filter_complex" not in media.ffmpeg_calls[0]


def test_default_requires_selected_manual_approval(tmp_path):
    request = prepared_render(tmp_path, selected=False)
    with pytest.raises(ContractValidationError, match="at least one"):
        render_platform_outputs(request, ffprobe=RenderMedia().ffprobe)


def test_explicit_retained_candidate_may_be_approved_but_unselected(tmp_path):
    request = prepared_render(tmp_path, selected=False)
    request["options"] = {"candidate_ids": ["clip_001"], "platforms": ["youtube_shorts"]}
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["requested_candidate_ids"] == ["clip_001"]
    assert len(result.artifact["candidates"][0]["exports"]) == 1


def test_pending_or_rejected_candidate_is_never_rendered(tmp_path):
    request = prepared_render(tmp_path)
    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["candidates"][0]["decision"] = "rejected"
    manifest["candidates"][0]["selected"] = False
    manifest_path.write_text(json.dumps(manifest))
    request["options"] = {"candidate_ids": ["clip_001"]}
    media = RenderMedia()
    with pytest.raises(ContractValidationError, match="manually approved"):
        render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert media.ffmpeg_calls == []


def test_exact_retry_is_final_cache_hit_without_rewrite(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    first = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    before = first.path.read_bytes()
    second = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert len(media.ffmpeg_calls) == 4


def test_tampered_export_is_rebuilt_to_deterministic_path(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    first = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    export_path = tmp_path / first.artifact["candidates"][0]["exports"][1]["output"]["path"]
    export_path.write_bytes(b"tampered")
    second = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is False
    assert export_path.read_bytes() != b"tampered"
    assert second.artifact["candidates"][0]["exports"][1]["output"]["path"].endswith("tiktok.mp4")


def test_tampered_caption_overlay_invalidates_and_rebuilds_its_master(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    first = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    overlay_path = tmp_path / first.artifact["candidates"][0]["caption"]["overlays"][0]["path"]
    overlay_path.write_bytes(b"tampered")
    second = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert second.cache_hit is False
    assert overlay_path.read_bytes() != b"tampered"
    assert len(media.ffmpeg_calls) == 8


def test_cancellation_checkpoints_and_resumes_missing_exports(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks > 2

    with pytest.raises(RenderError, match="cancelled"):
        render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe, cancelled=cancelled)
    partial = validate_document("render_artifact", json.loads((tmp_path / RENDER_ARTIFACT_RELATIVE_PATH).read_text()))
    assert partial["candidates"][0]["state"] == "pending"
    assert partial["candidates"][0]["master"] is not None
    assert len(partial["candidates"][0]["exports"]) == 1
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["candidates"][0]["state"] == "completed"
    assert len(media.ffmpeg_calls) == 4


def test_render_failure_is_atomic_and_leaves_no_temporary_output(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    with pytest.raises(RenderError, match="failed to create"):
        render_platform_outputs(
            request,
            ffmpeg=lambda command: subprocess.CompletedProcess(command, 1, "", "failed"),
            ffprobe=media.ffprobe,
        )
    assert not (tmp_path / RENDER_ARTIFACT_RELATIVE_PATH).exists()
    assert list((tmp_path / "artifacts" / "rendered-masters").glob(".*.tmp.mp4")) == []


def test_output_probe_failure_becomes_stable_render_error(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    media = RenderMedia()
    with pytest.raises(RenderError, match="could not be probed") as failure:
        _run_output(
            source, tmp_path / "output.mp4", 29.9, 0.25,
            ffmpeg=media.ffmpeg,
            ffprobe=lambda command: subprocess.CompletedProcess(command, 1, "{}", "failed"),
            video_args=["-c:v", "libx264"],
        )
    assert failure.value.code == "render_output_invalid"
    assert list(tmp_path.glob(".*.tmp.mp4")) == []


def test_export_failure_checkpoints_valid_master_for_retry(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()

    def fail_first_export(command):
        if len(media.ffmpeg_calls) == 1:
            media.ffmpeg_calls.append(command)
            return subprocess.CompletedProcess(command, 1, "", "failed export")
        return media.ffmpeg(command)

    with pytest.raises(RenderError, match="failed to create"):
        render_platform_outputs(request, ffmpeg=fail_first_export, ffprobe=media.ffprobe)
    partial = validate_document("render_artifact", json.loads((tmp_path / RENDER_ARTIFACT_RELATIVE_PATH).read_text()))
    assert partial["candidates"][0]["master"] is not None
    assert partial["candidates"][0]["exports"] == []
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    assert result.artifact["candidates"][0]["state"] == "completed"


def test_render_semantics_reject_path_escape(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    tampered = json.loads(result.path.read_text())
    tampered["candidates"][0]["master"]["path"] = "../../outside.mp4"
    with pytest.raises(ContractValidationError, match="deterministic project path"):
        validate_document("render_artifact", tampered)


def test_render_semantics_reject_overlay_escape_in_partial_checkpoint(tmp_path):
    request = prepared_render(tmp_path)
    media = RenderMedia()
    result = render_platform_outputs(request, ffmpeg=media.ffmpeg, ffprobe=media.ffprobe)
    tampered = json.loads(result.path.read_text())
    tampered["candidates"][0]["state"] = "pending"
    tampered["candidates"][0]["caption"]["overlays"][0]["path"] = "../../outside.png"
    with pytest.raises(ContractValidationError, match="deterministic project path"):
        validate_document("render_artifact", tampered)


def test_cli_emits_ordered_render_artifact_and_completion(tmp_path, monkeypatch, capsys):
    request = {"protocol_version": 1, "job_id": "job_cli_render", "project_dir": str(tmp_path), "stage": "render", "input_artifacts": [], "options": {}}
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request))
    artifact_path = tmp_path / RENDER_ARTIFACT_RELATIVE_PATH

    def runner(_request, *, progress, cancelled):
        assert cancelled() is False
        progress({"phase": "validating_inputs", "fraction": 0.1, "message": "valid"})
        return RenderResult({"cache_key": "sha256:" + "a" * 64, "candidates": [{"state": "completed", "exports": [{}, {}, {}]}]}, artifact_path, False)

    monkeypatch.setattr(cli, "render_platform_outputs", runner)
    assert cli._render(Namespace(request=str(request_path))) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "progress", "artifact", "completed"]
    assert events[-1]["payload"]["export_count"] == 3
    assert validate_event_stream(events) == events


def test_cli_converts_local_io_failure_to_ordered_error_event(tmp_path, monkeypatch, capsys):
    request = {"protocol_version": 1, "job_id": "job_cli_render", "project_dir": str(tmp_path), "stage": "render", "input_artifacts": [], "options": {}}
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request))
    monkeypatch.setattr(cli, "render_platform_outputs", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk unavailable")))
    assert cli._render(Namespace(request=str(request_path))) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["accepted", "error"]
    assert events[-1]["payload"]["code"] == "render_local_io_failed"
    assert validate_event_stream(events) == events


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg required")
def test_real_disposable_vertical_media_passes_h264_aac_contract(tmp_path):
    source = tmp_path / "source.mp4"
    generated = subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=5:d=0.4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.4",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source),
    ], capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr
    caption_path = tmp_path / "caption.png"
    overlay = build_caption_overlay("Visible phrase box", "clean", caption_path)
    overlay.update({"start_seconds": 0.0, "end_seconds": 0.35})
    destination = tmp_path / "output.mp4"
    output = _run_output(
        source, destination, 0.4, 0.25,
        ffmpeg=lambda command: subprocess.run(command, capture_output=True, text=True),
        ffprobe=lambda command: subprocess.run(command, capture_output=True, text=True),
        video_args=["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p"],
        overlays=[overlay],
    )
    assert output["state"] == "completed"
    assert (output["width"], output["height"], output["video_codec"], output["audio_codec"]) == (1080, 1920, "h264", "aac")
