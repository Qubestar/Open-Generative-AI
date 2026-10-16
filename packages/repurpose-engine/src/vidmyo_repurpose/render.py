"""Deterministic local captions and platform-ready Repurpose exports."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import queue
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .candidates import _atomic_json
from .caption_styles import (
    STYLE_NAMES, animate_cues, build_studio_overlay,
    normalize_caption_color, normalize_caption_font,
)
from .contracts import ContractValidationError, RENDER_ARTIFACT_VERSION, validate_document
from .ingest import fingerprint_file
from .reframe import OUTPUT_HEIGHT, OUTPUT_WIDTH, REFRAME_ARTIFACT_RELATIVE_PATH, ReframeError, _inside, _probe
from .reframe_two import REFRAME_V2_ARTIFACT_RELATIVE_PATH

ENGINE_VERSION = "0.1.0"
RENDER_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "render-artifact.v1.json"
TRANSCRIPT_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "transcript-artifact.v1.json"
BOUNDARY_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "boundary-artifact.v1.json"
CAPTION_DIRECTORY = Path("artifacts") / "captions"
MASTER_DIRECTORY = Path("artifacts") / "rendered-masters"
EXPORT_DIRECTORY = Path("artifacts") / "platform-exports"
MAX_WORDS_PER_CUE = 7
MAX_CHARACTERS_PER_CUE = 34
DURATION_TOLERANCE_SECONDS = 0.25
VERSIONS = {
    "schema": "render-artifact.v1",
    "captioner": "word-phrase-overlay.v2",
    "backing": "local-caption-styles.v2",
    "renderer": "ffmpeg-caption-stream-h264-aac.v2",
    "prober": "ffprobe-media-contract.v1",
}
CAPTION_STYLES = {
    "clean": {
        "font_scale": 2.0, "thickness": 4, "text_bgra": (255, 255, 255, 255),
        "back_bgra": (0, 0, 0, 205), "padding_x": 34, "padding_y": 22, "baseline_y": 1650,
    },
    "bold": {
        "font_scale": 2.5, "thickness": 6, "text_bgra": (0, 255, 255, 255),
        "back_bgra": (0, 0, 0, 230), "padding_x": 44, "padding_y": 28, "baseline_y": 1600,
    },
    "clean_lower": {
        "font_scale": 2.0, "thickness": 4, "text_bgra": (255, 255, 255, 255),
        "back_bgra": (0, 0, 0, 205), "padding_x": 34, "padding_y": 22, "baseline_y": 1580,
    },
    "clean_middle": {
        "font_scale": 2.0, "thickness": 4, "text_bgra": (255, 255, 255, 255),
        "back_bgra": (0, 0, 0, 205), "padding_x": 34, "padding_y": 22, "baseline_y": 1380,
    },
    "clean_upper": {
        "font_scale": 2.0, "thickness": 4, "text_bgra": (255, 255, 255, 255),
        "back_bgra": (0, 0, 0, 205), "padding_x": 34, "padding_y": 22, "baseline_y": 1160,
    },
    "bold_lower": {
        "font_scale": 2.5, "thickness": 6, "text_bgra": (0, 255, 255, 255),
        "back_bgra": (0, 0, 0, 230), "padding_x": 44, "padding_y": 28, "baseline_y": 1540,
    },
    "bold_middle": {
        "font_scale": 2.5, "thickness": 6, "text_bgra": (0, 255, 255, 255),
        "back_bgra": (0, 0, 0, 230), "padding_x": 44, "padding_y": 28, "baseline_y": 1340,
    },
    "bold_upper": {
        "font_scale": 2.5, "thickness": 6, "text_bgra": (0, 255, 255, 255),
        "back_bgra": (0, 0, 0, 230), "padding_x": 44, "padding_y": 28, "baseline_y": 1120,
    },
}
PLATFORM_PRESETS = {
    "youtube_shorts": {"label": "YouTube Shorts", "crf": 18, "video_bitrate": "12M", "audio_bitrate": "192k"},
    "tiktok": {"label": "TikTok", "crf": 20, "video_bitrate": "10M", "audio_bitrate": "192k"},
    "instagram_reels": {"label": "Instagram Reels", "crf": 20, "video_bitrate": "10M", "audio_bitrate": "192k"},
}


@dataclass(frozen=True)
class RenderError(Exception):
    code: str
    message: str
    preserved: str
    next_action: str

    def __str__(self) -> str:
        return self.message

    def payload(self) -> dict[str, str]:
        return {
            "code": self.code,
            "message": self.message,
            "preserved": self.preserved,
            "next_action": self.next_action,
        }


@dataclass(frozen=True)
class RenderResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> RenderError:
    return RenderError(
        code,
        message[:1000],
        "The source, transcript, boundaries, reframed previews, approvals, and every earlier valid render were preserved.",
        next_action,
    )


def cancellation_error() -> RenderError:
    return _error(
        "render_cancelled",
        "Rendering was cancelled at a safe output boundary.",
        "Retry the same request to reuse every completed validated output.",
    )


def _hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def build_caption_cues(
    words: list[dict[str, Any]], *, clip_start: float, clip_duration: float,
    max_words: int = MAX_WORDS_PER_CUE, max_characters: int = MAX_CHARACTERS_PER_CUE,
) -> list[dict[str, Any]]:
    """Group authoritative words into deterministic, non-overlapping phrase cues."""
    if max_words < 1 or max_characters < 1 or clip_duration <= 0:
        raise ContractValidationError("caption settings: limits and duration must be positive")
    normalized: list[dict[str, Any]] = []
    for word in words:
        start = max(0.0, min(clip_duration, float(word["start_seconds"]) - clip_start))
        end = max(start, min(clip_duration, float(word["end_seconds"]) - clip_start))
        if end > start:
            normalized.append({**word, "relative_start": start, "relative_end": end})
    cues: list[dict[str, Any]] = []
    group: list[dict[str, Any]] = []

    def flush() -> None:
        if not group:
            return
        text = " ".join(item["text"].strip() for item in group).strip()
        cues.append({
            "id": f"cue_{len(cues) + 1:04d}",
            "start_seconds": round(group[0]["relative_start"], 6),
            "end_seconds": round(group[-1]["relative_end"], 6),
            "text": text,
            "word_ids": [item["id"] for item in group],
        })
        group.clear()

    for word in normalized:
        prospective = " ".join([*(item["text"].strip() for item in group), word["text"].strip()]).strip()
        if group and (len(group) >= max_words or len(prospective) > max_characters):
            flush()
        group.append(word)
        if word["text"].rstrip().endswith((".", "!", "?", ":", ";")):
            flush()
    flush()
    return cues


def build_caption_overlay(text: str, style_name: str, destination: Path, active_word_index: int | None = None,
                          caption_color: str = "preset", caption_font: str = "preset") -> dict[str, Any]:
    """Render one transparent phrase image and return measured symmetric padding."""
    if style_name in STYLE_NAMES:
        try:
            return build_studio_overlay(
                text, style_name, destination, active_word_index,
                caption_color=caption_color, caption_font=caption_font,
            )
        except (ImportError, OSError) as exc:
            raise _error("caption_renderer_unavailable", f"The local caption renderer could not load its fonts or Pillow: {exc}.", "Install the updated Vidmyo Repurpose package and retry.") from exc
    try:
        style = CAPTION_STYLES[style_name]
    except KeyError as exc:
        raise ContractValidationError(f"options.caption_style: unsupported style {style_name!r}") from exc
    try:
        import cv2
        import numpy as np
    except (ImportError, OSError) as exc:
        raise _error("caption_renderer_unavailable", f"OpenCV could not render captions: {exc}.", "Install the complete Vidmyo Repurpose package and retry.") from exc
    font = cv2.FONT_HERSHEY_DUPLEX
    scale = float(style["font_scale"])
    thickness = int(style["thickness"])
    maximum_width = OUTPUT_WIDTH - 180
    while scale > 0.6:
        (text_width, text_height), baseline = cv2.getTextSize(text, font, scale, thickness)
        if text_width <= maximum_width:
            break
        scale = round(scale - 0.1, 2)
    if text_width > maximum_width:
        raise ContractValidationError("caption text: phrase cannot fit inside the horizontal safe zone")
    measurement = np.zeros((text_height + baseline + 100, text_width + 200, 4), dtype=np.uint8)
    measurement_origin = (100, text_height + 50)
    cv2.putText(
        measurement, text, measurement_origin, font, scale,
        style["text_bgra"], thickness, cv2.LINE_AA,
    )
    visible_y, visible_x = np.where(measurement[:, :, 3] > 0)
    if not len(visible_x):
        raise ContractValidationError("caption text: phrase produced no visible pixels")
    measured_left, measured_right = int(visible_x.min()), int(visible_x.max())
    measured_top, measured_bottom = int(visible_y.min()), int(visible_y.max())
    visible_width = measured_right - measured_left + 1
    visible_height = measured_bottom - measured_top + 1
    pad_x, pad_y = int(style["padding_x"]), int(style["padding_y"])
    left = (OUTPUT_WIDTH - visible_width) // 2
    right = left + visible_width - 1
    bottom = int(style["baseline_y"])
    top = bottom - visible_height + 1
    origin = (
        left - (measured_left - measurement_origin[0]),
        top - (measured_top - measurement_origin[1]),
    )
    canvas = np.zeros((OUTPUT_HEIGHT, OUTPUT_WIDTH, 4), dtype=np.uint8)
    cv2.rectangle(
        canvas, (left - pad_x, top - pad_y),
        (right + pad_x, bottom + pad_y),
        style["back_bgra"], thickness=-1,
    )
    cv2.putText(canvas, text, origin, font, scale, style["text_bgra"], thickness, cv2.LINE_AA)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.{os.getpid()}.tmp.png"
    try:
        if not cv2.imwrite(str(temporary), canvas):
            raise _error("caption_render_failed", "OpenCV did not create a caption overlay.", "Check local disk space and retry.")
        os.replace(temporary, destination)
    except RenderError:
        raise
    except OSError as exc:
        raise _error("caption_render_failed", f"The caption overlay could not be stored: {exc}.", "Check local disk space and permissions, then retry.") from exc
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "path": destination.as_posix(), "fingerprint": fingerprint_file(destination),
        "text_left": left, "text_right": right,
        "backing_left": left - pad_x, "backing_right": right + pad_x,
        "visible_padding_left": pad_x, "visible_padding_right": pad_x,
    }


def _descriptor_map(request: dict[str, Any]) -> dict[tuple[str, int], dict[str, Any]]:
    descriptors = request["input_artifacts"]
    mapped: dict[tuple[str, int], dict[str, Any]] = {}
    for descriptor in descriptors:
        key = (descriptor["kind"], descriptor.get("version"))
        if key in mapped:
            raise _error("render_input_invalid", f"Duplicate input artifact descriptor {key}.", "Provide each required current artifact exactly once.")
        mapped[key] = descriptor
    expected = {
        ("transcript_artifact", 1), ("boundary_artifact", 1),
        ("reframe_artifact", 1), ("reframe_artifact", 2),
    }
    if set(mapped) != expected:
        raise _error(
            "render_input_invalid",
            "Rendering requires exactly the current transcript v1, boundary v1, reframe v1, and reframe v2 artifacts.",
            "Complete the current Repurpose analysis and reframing stages, then retry.",
        )
    fixed = {
        ("transcript_artifact", 1): TRANSCRIPT_ARTIFACT_RELATIVE_PATH.as_posix(),
        ("boundary_artifact", 1): BOUNDARY_ARTIFACT_RELATIVE_PATH.as_posix(),
        ("reframe_artifact", 1): REFRAME_ARTIFACT_RELATIVE_PATH.as_posix(),
        ("reframe_artifact", 2): REFRAME_V2_ARTIFACT_RELATIVE_PATH.as_posix(),
    }
    if any(mapped[key]["path"] != relative for key, relative in fixed.items()):
        raise _error("render_input_invalid", "An input artifact path is not the deterministic current project path.", "Use the current project-owned artifact descriptors and retry.")
    return mapped


def _load_inputs(
    request: dict[str, Any], ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]],
) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    project = Path(request["project_dir"]).expanduser().resolve()
    mapped = _descriptor_map(request)
    try:
        manifest = validate_document("manifest", json.loads((project / "repurpose.json").read_text()))
        transcript = validate_document("transcript_artifact", json.loads(_inside(project, mapped[("transcript_artifact", 1)]["path"]).read_text()))
        boundary = validate_document("boundary_artifact", json.loads(_inside(project, mapped[("boundary_artifact", 1)]["path"]).read_text()))
        reframe_v1_path = _inside(project, mapped[("reframe_artifact", 1)]["path"])
        reframe_v1 = validate_document("reframe_artifact", json.loads(reframe_v1_path.read_text()))
        reframe_v2_path = _inside(project, mapped[("reframe_artifact", 2)]["path"])
        reframe_v2 = validate_document("reframe_artifact_v2", json.loads(reframe_v2_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError, ReframeError) as exc:
        raise _error("render_input_invalid", f"A required current project artifact is missing or invalid: {exc}.", "Recreate the affected local stage and retry.") from exc
    fingerprint = transcript["source"]["fingerprint"]
    if (
        manifest["source"]["fingerprint"] != fingerprint
        or boundary["source"]["fingerprint"] != fingerprint
        or reframe_v1["source"]["fingerprint"] != fingerprint
        or reframe_v2["source"]["fingerprint"] != fingerprint
        or boundary["source"]["transcript_cache_key"] != transcript["cache_key"]
        or reframe_v1["source"]["boundary_cache_key"] != boundary["cache_key"]
        or reframe_v2["source"]["boundary_cache_key"] != boundary["cache_key"]
        or reframe_v2["source"]["reframe_v1_cache_key"] != reframe_v1["cache_key"]
        or reframe_v2["source"]["reframe_v1_fingerprint"] != fingerprint_file(reframe_v1_path)
    ):
        raise _error("render_input_stale", "The manifest and input artifacts do not share one current provenance chain.", "Rerun the first stale Repurpose stage and retry rendering.")
    if manifest["render_mode"] != "manual_approval" or manifest["render_defaults"]["captions"]["translation_target_language"] is not None:
        raise _error("render_settings_unsupported", "Rendering requires manual approval and does not support translation in this stage.", "Use manual approval with no translation target and retry.")
    if manifest["stages"]["reframe"]["state"] != "completed":
        raise _error("render_input_incomplete", "The project manifest does not record completed reframing.", "Complete and apply the reframe-v2 stage before rendering.")
    for item in reframe_v2["candidates"]:
        if item["output"]["state"] != "completed":
            continue
        try:
            media_path = _inside(project, item["output"]["path"])
            probe = _probe(media_path, ffprobe)
        except (OSError, ReframeError) as exc:
            raise _error("render_input_stale", f"The reframed preview for {item['candidate_id']} is missing or invalid: {exc}.", "Recreate the affected reframed preview and retry.") from exc
        if (
            fingerprint_file(media_path) != item["output"]["fingerprint"]
            or probe["width"] != OUTPUT_WIDTH or probe["height"] != OUTPUT_HEIGHT
            or probe["video_codec"] != "h264" or probe["audio_codec"] != "aac"
            or abs(probe["duration"] - item["output"]["duration_seconds"]) > DURATION_TOLERANCE_SECONDS
        ):
            raise _error("render_input_stale", f"The reframed preview for {item['candidate_id']} no longer matches its artifact.", "Recreate the affected reframed preview and retry.")
    return project, manifest, transcript, boundary, reframe_v1, reframe_v2


def _caption_stream(overlays: list[dict[str, Any]], directory: Path, duration: float) -> Path:
    """One sparse PNG stream, not one looping HD decoder/filter per phrase.

    Transparent frames explicitly clear gaps and the tail. The concat demuxer's
    millisecond timebase keeps cue timing independent of the source frame rate.
    """
    import cv2
    import numpy as np

    blank = directory / "blank.png"
    if not cv2.imwrite(str(blank), np.zeros((OUTPUT_HEIGHT, OUTPUT_WIDTH, 4), dtype=np.uint8)):
        raise _error("render_failed", "Could not create the transparent caption frame.", "Check local disk space and retry.")
    lines = ["ffconcat version 1.0"]

    def frame(path: Path, seconds: float | None = None) -> None:
        name = str(path.resolve())
        if "\n" in name or "\r" in name:
            raise _error("render_input_invalid", "Caption paths cannot contain newlines.", "Rename the project folder and retry.")
        lines.append("file '" + name.replace("'", "'\\''") + "'")
        lines.append("option framerate 1000")
        if seconds is not None:
            lines.append(f"duration {seconds:.6f}")

    cursor = 0.0
    for index, overlay in enumerate(overlays):
        start = max(cursor, min(duration, float(overlay["start_seconds"])))
        end = min(duration, float(overlay["end_seconds"]))
        if index + 1 < len(overlays):
            end = min(end, float(overlays[index + 1]["start_seconds"]))
        if start > cursor:
            frame(blank, start - cursor)
            cursor = start
        if end > start:
            frame(Path(overlay["path"]), end - start)
            cursor = end
    if duration > cursor:
        frame(blank, duration - cursor)
    frame(blank)  # Clear the last phrase even if FFmpeg repeats the final frame.
    timeline = directory / "captions.ffconcat"
    timeline.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return timeline


def _encode(command: list[str], duration: float, progress: Callable[[float], None],
            cancelled: Callable[[], bool], stall_seconds: float = 180) -> subprocess.CompletedProcess[str]:
    """Read real encoder progress, bound silence, and reap children on cancellation."""
    command = [command[0], "-progress", "pipe:1", "-nostats", *command[1:]]
    with tempfile.TemporaryFile(mode="w+b") as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        updates: queue.Queue[bytes | None] = queue.Queue()
        assert process.stdout is not None

        def read_progress() -> None:
            try:
                for line in process.stdout:
                    updates.put(line)
            finally:
                updates.put(None)

        # Windows selectors cannot monitor anonymous pipes. Keep blocking reads
        # off the cancellation/watchdog thread on every supported platform.
        reader = threading.Thread(target=read_progress, daemon=True)
        reader.start()
        try:
            last_advance = time.monotonic()
            latest = -1.0
            finished = False
            while True:
                if cancelled():
                    raise cancellation_error()
                if time.monotonic() - last_advance > stall_seconds:
                    raise _error("render_stalled", "FFmpeg made no encoding progress for three minutes.", "Check local resources, then retry; completed outputs are retained.")
                try:
                    line = updates.get(timeout=0.25)
                    if line is None:
                        finished = True
                    elif line.startswith(b"out_time_us="):
                        try:
                            seconds = int(line.split(b"=", 1)[1]) / 1_000_000
                        except ValueError:
                            continue
                        if seconds > latest:
                            latest = seconds
                            last_advance = time.monotonic()
                            progress(max(0.0, min(0.99, seconds / duration)))
                except queue.Empty:
                    pass
                if finished and process.poll() is not None:
                    break
            errors.seek(0)
            return subprocess.CompletedProcess(command, process.returncode, "", errors.read(4000).decode("utf-8", errors="replace"))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if process.stdout is not None:
                reader.join(timeout=3)
                process.stdout.close()


def _run_output(
    source: Path, destination: Path, duration: float, tolerance: float, *,
    ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]] | None,
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]],
    video_args: list[str], overlays: list[dict[str, Any]] | None = None,
    progress: Callable[[float], None] = lambda _fraction: None,
    cancelled: Callable[[], bool] = lambda: False,
    output_size: tuple[int, int] = (OUTPUT_WIDTH, OUTPUT_HEIGHT),
) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.stem}.{os.getpid()}.tmp.mp4"
    workspace = tempfile.TemporaryDirectory(prefix=".caption-stream-", dir=destination.parent)
    try:
        command = ["ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "2", "-i", str(source)]
        if overlays:
            timeline = _caption_stream(overlays, Path(workspace.name), duration)
            command.extend(["-threads", "1", "-f", "concat", "-safe", "0", "-i", str(timeline),
                            "-filter_complex_threads", "2", "-filter_complex",
                            "[0:v][1:v]overlay=0:0:eof_action=repeat[v]", "-map", "[v]"])
        else:
            command.extend(["-map", "0:v:0"])
        command.extend(["-map", "0:a:0", *video_args, "-threads", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{duration:.6f}", str(temporary)])
        progress(0.0)
        try:
            result = ffmpeg(command) if ffmpeg is not None else _encode(command, duration, progress, cancelled)
        except (FileNotFoundError, OSError) as exc:
            raise _error("ffmpeg_not_available", f"FFmpeg could not start: {exc}.", "Install FFmpeg and retry.") from exc
        if result.returncode != 0 or not temporary.is_file():
            detail = (result.stderr or f"FFmpeg exited with code {result.returncode} without a complete output")[:500]
            raise _error("render_failed", f"FFmpeg failed to create a complete output: {detail}", "Check FFmpeg, codecs, and disk space, then retry.")
        try:
            probe = _probe(temporary, ffprobe)
        except ReframeError as exc:
            raise _error("render_output_invalid", f"The rendered output could not be probed: {exc}.", "Check FFmpeg/FFprobe and retry.") from exc
        if (
            probe["width"] != output_size[0] or probe["height"] != output_size[1]
            or probe["video_codec"] != "h264" or probe["audio_codec"] != "aac"
            or abs(probe["duration"] - duration) > tolerance
        ):
            raise _error("render_output_invalid", "A rendered output failed codec, dimension, audio, or duration validation.", "Retry with a working H.264/AAC FFmpeg build.")
        os.replace(temporary, destination)
        progress(1.0)
        return {
            "state": "completed",
            "path": destination.as_posix(),
            "fingerprint": fingerprint_file(destination),
            "duration_seconds": round(probe["duration"], 6),
            "width": probe["width"], "height": probe["height"],
            "video_codec": probe["video_codec"], "audio_codec": probe["audio_codec"],
        }
    finally:
        temporary.unlink(missing_ok=True)
        workspace.cleanup()


def _validate_cached_output(
    project: Path, record: dict[str, Any], expected: Path, duration: float,
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]],
    output_size: tuple[int, int] = (OUTPUT_WIDTH, OUTPUT_HEIGHT),
) -> bool:
    try:
        if record["state"] != "completed" or record["path"] != expected.relative_to(project).as_posix():
            return False
        if not expected.is_file() or fingerprint_file(expected) != record["fingerprint"]:
            return False
        probe = _probe(expected, ffprobe)
        return (
            probe["width"] == output_size[0] and probe["height"] == output_size[1]
            and probe["video_codec"] == "h264" and probe["audio_codec"] == "aac"
            and abs(probe["duration"] - duration) <= DURATION_TOLERANCE_SECONDS
        )
    except (OSError, KeyError, ReframeError):
        return False


def render_platform_outputs(
    request: dict[str, Any], *,
    ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]] | None = None,
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> RenderResult:
    progress({"phase": "validating_inputs", "fraction": 0.02, "cache_hit": False, "message": "validating current approvals and reframe provenance"})
    project, manifest, transcript, boundary, reframe_v1, reframe_v2 = _load_inputs(request, ffprobe)
    options = request["options"]
    if not isinstance(options, dict) or set(options) - {"candidate_ids", "caption_style", "caption_color", "caption_font", "captions_enabled", "platforms", "upscale_mode"}:
        raise ContractValidationError("options: only candidate_ids, caption_style, caption_color, caption_font, captions_enabled, platforms, and upscale_mode are supported")
    style = options.get("caption_style", manifest["render_defaults"]["captions"]["style"])
    if style not in CAPTION_STYLES and style not in STYLE_NAMES:
        raise ContractValidationError(f"options.caption_style: unsupported style {style!r}")
    caption_color = normalize_caption_color(options.get("caption_color", "preset"))
    caption_font = normalize_caption_font(options.get("caption_font", "preset"))
    upscale_mode = options.get("upscale_mode", "off")
    if upscale_mode not in {"off", "lanczos_4k", "lanczos_4k_sharp"}:
        raise ContractValidationError("options.upscale_mode: must be off, lanczos_4k, or lanczos_4k_sharp")
    export_size = (2160, 3840) if upscale_mode != "off" else (OUTPUT_WIDTH, OUTPUT_HEIGHT)
    export_suffix = f".{upscale_mode}" if upscale_mode != "off" else ""
    captions_enabled = options.get("captions_enabled", manifest["render_defaults"]["captions"]["enabled"])
    if not isinstance(captions_enabled, bool):
        raise ContractValidationError("options.captions_enabled: must be a boolean")
    platforms = options.get("platforms", manifest["target_platforms"])
    if not isinstance(platforms, list) or not platforms or len(platforms) != len(set(platforms)) or any(item not in PLATFORM_PRESETS for item in platforms):
        raise ContractValidationError("options.platforms: must contain unique supported platform ids")

    manifest_by_id = {item["id"]: item for item in manifest["candidates"]}
    v2_by_id = {item["candidate_id"]: item for item in reframe_v2["candidates"] if item["output"]["state"] == "completed"}
    default_ids = [
        candidate_id for candidate_id in reframe_v2["requested_candidate_ids"]
        if candidate_id in v2_by_id and candidate_id in manifest_by_id
        and manifest_by_id[candidate_id]["decision"] == "approved" and manifest_by_id[candidate_id]["selected"]
    ]
    requested = options.get("candidate_ids", default_ids)
    if not isinstance(requested, list) or not requested or len(requested) != len(set(requested)):
        raise ContractValidationError("options.candidate_ids: at least one unique manually approved completed candidate is required")
    invalid = [
        candidate_id for candidate_id in requested
        if candidate_id not in v2_by_id or candidate_id not in manifest_by_id or manifest_by_id[candidate_id]["decision"] != "approved"
    ]
    if invalid:
        raise ContractValidationError(f"options.candidate_ids: candidates must be completed and manually approved: {', '.join(invalid)}")

    boundary_by_id = {item["candidate_id"]: item for item in boundary["candidates"]}
    word_by_id = {word["id"]: word for word in transcript["words"]}
    ordered_word_ids = [word["id"] for word in transcript["words"]]
    settings = {
        "caption_style": style, "caption_color": caption_color, "caption_font": caption_font,
        "captions_enabled": captions_enabled,
        "max_words_per_cue": MAX_WORDS_PER_CUE, "max_characters_per_cue": MAX_CHARACTERS_PER_CUE,
        "output_width": OUTPUT_WIDTH, "output_height": OUTPUT_HEIGHT,
        "safe_margin_left_right": 90, "duration_tolerance_seconds": DURATION_TOLERANCE_SECONDS,
        "encoder": "libx264-yuv420p-aac-faststart.v1",
        "upscale_mode": upscale_mode,
    }
    brand_suffix = "" if caption_color == caption_font == "preset" else "." + hashlib.sha256(
        f"{caption_color}:{caption_font}".encode()
    ).hexdigest()[:8]
    presets = [
        {
            "id": preset_id, "label": PLATFORM_PRESETS[preset_id]["label"], "container": "mp4",
            "video_codec": "h264", "audio_codec": "aac", "width": export_size[0], "height": export_size[1],
            "frame_rate_policy": "preserve", "crf": PLATFORM_PRESETS[preset_id]["crf"],
            "video_bitrate": "40M" if upscale_mode != "off" else PLATFORM_PRESETS[preset_id]["video_bitrate"],
            "audio_bitrate": PLATFORM_PRESETS[preset_id]["audio_bitrate"],
        }
        for preset_id in platforms
    ]
    source = {
        "fingerprint": transcript["source"]["fingerprint"],
        "transcript_cache_key": transcript["cache_key"], "boundary_cache_key": boundary["cache_key"],
        "reframe_v1_cache_key": reframe_v1["cache_key"], "reframe_v2_cache_key": reframe_v2["cache_key"],
        "reframe_v2_fingerprint": fingerprint_file(project / REFRAME_V2_ARTIFACT_RELATIVE_PATH),
        "manifest_decisions_hash": _hash([
            {"id": candidate_id, "decision": manifest_by_id[candidate_id]["decision"], "selected": manifest_by_id[candidate_id]["selected"]}
            for candidate_id in requested
        ]),
    }
    cache_key = _hash({"source": source, "versions": VERSIONS, "settings": settings, "presets": presets, "requested": requested})
    artifact_path = project / RENDER_ARTIFACT_RELATIVE_PATH
    previous = None
    try:
        previous = validate_document("render_artifact", json.loads(artifact_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError):
        pass
    previous_by_id = {item["candidate_id"]: item for item in previous["candidates"]} if previous else {}

    entries: list[dict[str, Any]] = []
    for candidate_id in requested:
        reframe_item = v2_by_id[candidate_id]
        boundary_item = boundary_by_id.get(candidate_id)
        if not boundary_item or boundary_item["extraction"]["state"] != "completed":
            raise _error("render_input_stale", f"The completed boundary preview for {candidate_id} is missing.", "Recreate the affected boundary/reframe chain and retry.")
        span = boundary_item["repaired_span"]
        try:
            first = ordered_word_ids.index(span["first_word_id"])
            last = ordered_word_ids.index(span["last_word_id"])
        except ValueError as exc:
            raise _error("render_input_stale", f"The repaired word span for {candidate_id} is absent from the transcript.", "Recreate the affected transcript and downstream artifacts.") from exc
        if last < first:
            raise _error("render_input_stale", f"The repaired word span for {candidate_id} is reversed.", "Recreate the affected boundary artifact.")
        clip_duration = float(reframe_item["output"]["duration_seconds"])
        words = [word_by_id[word_id] for word_id in ordered_word_ids[first:last + 1]]
        cues = build_caption_cues(words, clip_start=float(span["start_seconds"]), clip_duration=clip_duration)
        if style in STYLE_NAMES:
            cues = animate_cues(cues, words, style, float(span["start_seconds"]))
        enabled = captions_enabled and bool(cues)
        caption_path = project / CAPTION_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.json"
        caption = {
            "enabled": enabled, "style": style, "state": "pending" if enabled else "not_required",
            "path": None, "fingerprint": None, "overlays": [],
            "fallback_reason": None if enabled else ("captions_disabled" if not captions_enabled else "no_usable_speech"),
            "backing_model": VERSIONS["backing"],
        }
        input_record = {
            "path": reframe_item["output"]["path"], "fingerprint": reframe_item["output"]["fingerprint"],
            "duration_seconds": clip_duration, "reframe_mode": reframe_item["mode"],
            "boundary_first_word_id": span["first_word_id"], "boundary_last_word_id": span["last_word_id"],
            "boundary_start_seconds": span["start_seconds"], "boundary_end_seconds": span["end_seconds"],
        }
        # Upscaling reuses a validated captioned master instead of burning captions
        # twice or re-encoding the source unnecessarily. Style/background changes
        # still invalidate that master; resolution/preset changes do not.
        caption_settings = {key: value for key, value in settings.items() if key != "upscale_mode"}
        cue_key = _hash({"input": input_record, "words": words, "settings": caption_settings, "versions": VERSIONS})
        output_key = _hash({"input": input_record, "cue_key": cue_key, "versions": VERSIONS, "settings": settings, "presets": presets})
        entry = {
            "candidate_id": candidate_id, "state": "pending", "input": input_record,
            "cue_key": cue_key, "cues": cues, "caption": caption, "output_key": output_key,
            "master": None, "exports": [],
        }
        old = previous_by_id.get(candidate_id)
        master_path = project / MASTER_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.master.mp4"
        export_paths = {preset_id: project / EXPORT_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.{preset_id}{export_suffix}.mp4" for preset_id in platforms}
        if old and old["cue_key"] == cue_key:
            old_exports = {item["preset_id"]: item["output"] for item in old["exports"]}
            caption_ok = True
            if enabled:
                caption_ok = (
                    old["caption"]["state"] == "completed" and old["caption"]["path"] == caption_path.relative_to(project).as_posix()
                    and caption_path.is_file() and fingerprint_file(caption_path) == old["caption"]["fingerprint"]
                )
                if caption_ok:
                    try:
                        caption_ok = len(old["caption"]["overlays"]) == len(cues) and all(
                            (project / overlay["path"]).is_file()
                            and fingerprint_file(project / overlay["path"]) == overlay["fingerprint"]
                            for overlay in old["caption"]["overlays"]
                        )
                    except (KeyError, OSError):
                        caption_ok = False
            master_ok = old["master"] is not None and _validate_cached_output(project, old["master"], master_path, clip_duration, ffprobe)
            valid_export_ids: list[str] = []
            for preset_id in platforms:
                if old["output_key"] != output_key or preset_id not in old_exports or not _validate_cached_output(project, old_exports[preset_id], export_paths[preset_id], clip_duration, ffprobe, export_size):
                    break
                valid_export_ids.append(preset_id)
            if caption_ok and master_ok:
                entry["caption"] = old["caption"]
                entry["master"] = old["master"]
                entry["exports"] = [next(item for item in old["exports"] if item["preset_id"] == preset_id) for preset_id in valid_export_ids]
                if len(valid_export_ids) == len(platforms):
                    entry["state"] = "completed"
        entries.append(entry)

    created_at = clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def document() -> dict[str, Any]:
        return {
            "artifact_version": RENDER_ARTIFACT_VERSION, "engine_version": ENGINE_VERSION,
            "created_at": created_at, "versions": VERSIONS, "source": source,
            "settings": settings, "presets": presets, "cache_key": cache_key,
            "requested_candidate_ids": list(requested), "candidates": entries,
        }

    expected = document()
    if previous:
        fields = ("artifact_version", "engine_version", "versions", "source", "settings", "presets", "cache_key", "requested_candidate_ids", "candidates")
        if all(item["state"] == "completed" for item in entries) and all(previous[field] == expected[field] for field in fields):
            progress({"phase": "final_cache_hit", "fraction": 1.0, "percent": 100, "cache_hit": True, "message": "reusing matching validated captioned masters and platform exports"})
            return RenderResult(previous, artifact_path, True)

    for index, entry in enumerate(entries):
        if entry["state"] == "completed":
            continue
        if cancelled():
            raise cancellation_error()
        candidate_id = entry["candidate_id"]
        def encoding_progress(part: int, message: str) -> Callable[[float], None]:
            return lambda fraction: progress({
                "phase": "encoding_output", "candidate_id": candidate_id, "cache_hit": False,
                "fraction": 0.1 + 0.85 * (index + (part + fraction) / (1 + len(presets))) / max(1, len(entries)),
                "message": f"{candidate_id}: {message} ({round(fraction * 100)}%)",
            })

        progress({"phase": "preparing_captions", "candidate_id": candidate_id, "cache_hit": False,
                  "fraction": 0.1 + 0.85 * index / max(1, len(entries)), "message": f"preparing captions for {candidate_id}"})
        input_path = _inside(project, entry["input"]["path"])
        style = entry["caption"]["style"]
        caption_path = project / CAPTION_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.json"
        if entry["caption"]["enabled"] and entry["caption"]["state"] != "completed":
            overlays = []
            overlay_directory = project / CAPTION_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}"
            for cue in entry["cues"]:
                if cancelled():
                    raise cancellation_error()
                overlay_path = overlay_directory / f"{cue['id']}.png"
                overlay = build_caption_overlay(
                    cue["text"], style, overlay_path, cue.get("active_word_index"),
                    caption_color=caption_color, caption_font=caption_font,
                )
                overlay.update({
                    "cue_id": cue["id"],
                    "path": overlay_path.relative_to(project).as_posix(),
                    "start_seconds": cue["start_seconds"],
                    "end_seconds": cue["end_seconds"],
                })
                overlays.append(overlay)
            _atomic_json(caption_path, {
                "version": 1, "style": style, "caption_color": caption_color,
                "caption_font": caption_font, "backing_model": VERSIONS["backing"],
                "overlays": overlays,
            })
            entry["caption"].update({
                "state": "completed", "path": caption_path.relative_to(project).as_posix(),
                "fingerprint": fingerprint_file(caption_path), "overlays": overlays,
            })
        overlays_for_ffmpeg = [
            {**overlay, "path": project / overlay["path"]}
            for overlay in entry["caption"]["overlays"]
        ] if entry["caption"]["enabled"] else None
        master_path = project / MASTER_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.master.mp4"
        if entry["master"] is None:
            master = _run_output(
                input_path, master_path, entry["input"]["duration_seconds"], DURATION_TOLERANCE_SECONDS,
                ffmpeg=ffmpeg, ffprobe=ffprobe, overlays=overlays_for_ffmpeg,
                progress=encoding_progress(0, "encoding captioned master"), cancelled=cancelled,
                video_args=["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"],
            )
            master["path"] = master_path.relative_to(project).as_posix()
            entry["master"] = master
            validate_document("render_artifact", document())
            _atomic_json(artifact_path, document())
        completed_exports = {item["preset_id"] for item in entry["exports"]}
        for preset_index, preset in enumerate(presets, 1):
            if preset["id"] in completed_exports:
                continue
            if cancelled():
                validate_document("render_artifact", document())
                _atomic_json(artifact_path, document())
                raise cancellation_error()
            export_path = project / EXPORT_DIRECTORY / f"{candidate_id}.{style}{brand_suffix}.{preset['id']}{export_suffix}.mp4"
            scale_args = []
            if upscale_mode != "off":
                scale_filter = "scale=2160:3840:flags=lanczos,setsar=1"
                if upscale_mode == "lanczos_4k_sharp":
                    scale_filter += ",unsharp=5:5:0.35:5:5:0"
                scale_args = ["-vf", scale_filter, "-filter_threads", "2"]
            output = _run_output(
                master_path, export_path, entry["input"]["duration_seconds"], DURATION_TOLERANCE_SECONDS,
                ffmpeg=ffmpeg, ffprobe=ffprobe, overlays=None,
                progress=encoding_progress(preset_index, f"encoding {preset['id']} export"), cancelled=cancelled,
                output_size=export_size,
                video_args=[*scale_args, "-c:v", "libx264", "-preset", "medium", "-crf", str(preset["crf"]), "-maxrate", preset["video_bitrate"], "-bufsize", "80M" if upscale_mode != "off" else "20M", "-pix_fmt", "yuv420p"],
            )
            output["path"] = export_path.relative_to(project).as_posix()
            entry["exports"].append({"preset_id": preset["id"], "output": output})
            validate_document("render_artifact", document())
            _atomic_json(artifact_path, document())
        entry["state"] = "completed"
        validate_document("render_artifact", document())
        _atomic_json(artifact_path, document())
        progress({
            "phase": "candidate_render_completed", "candidate_id": candidate_id,
            "fraction": 0.1 + 0.85 * ((index + 1) / max(1, len(entries))), "cache_hit": False,
            "message": f"rendered {candidate_id} master and {len(presets)} platform exports",
        })
    artifact = document()
    validate_document("render_artifact", artifact)
    _atomic_json(artifact_path, artifact)
    progress({"phase": "render_completed", "fraction": 1.0, "percent": 100, "cache_hit": False, "message": "prepared validated local captioned platform exports"})
    return RenderResult(artifact, artifact_path, False)
