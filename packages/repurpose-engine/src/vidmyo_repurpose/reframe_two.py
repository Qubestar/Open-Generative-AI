"""Deterministic two-speaker vertical split layouts built from reframe v1 evidence."""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .candidates import _atomic_json
from .contracts import ContractValidationError, REFRAME_ARTIFACT_V2_VERSION, validate_document
from .ingest import fingerprint_file
from .reframe import (
    CONFIDENCE_THRESHOLD,
    COVERAGE_THRESHOLD,
    DEAD_ZONE_FRACTION,
    MAXIMUM_STEP_FRACTION,
    MINIMUM_HOLD_SECONDS,
    OUTPUT_HEIGHT,
    OUTPUT_WIDTH,
    REFRAME_ARTIFACT_RELATIVE_PATH,
    ReframeError,
    SAFE_ZONE_MARGIN,
    SAFE_ZONE_TARGET,
    SMOOTHING_ALPHA,
    _inside,
    _probe,
    _step_expression,
)

ENGINE_VERSION = "0.1.0"
REFRAME_V2_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "reframe-artifact.v2.json"
REFRAME_V2_DIRECTORY = Path("artifacts") / "reframed-previews-v2"
PANEL_HEIGHT = OUTPUT_HEIGHT // 2
PANEL_WIDTH = OUTPUT_WIDTH
ASSOCIATION_AMBIGUITY_FRACTION = 0.05
VERSIONS = {
    "schema": "reframe-artifact.v2",
    "detector": "yunet-2023mar.v1",
    "association": "spatial-pair.v1",
    "tracker": "two-speaker-panel-tracker.v1",
    "renderer": "vertical-split-preview.v1",
}


@dataclass(frozen=True)
class TwoSpeakerReframeError(Exception):
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
class TwoSpeakerReframeResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> TwoSpeakerReframeError:
    return TwoSpeakerReframeError(
        code,
        message[:1000],
        "The source media, Issue 6 previews, reframe v1 artifact, and every earlier valid output were preserved.",
        next_action,
    )


def cancellation_error() -> TwoSpeakerReframeError:
    return _error(
        "two_speaker_reframe_cancelled",
        "Two-speaker reframing was cancelled at a safe candidate boundary.",
        "Retry the same request to reuse completed validated outputs.",
    )


def _hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _center(face: dict[str, float]) -> tuple[float, float]:
    return face["x"] + face["width"] / 2, face["y"] + face["height"] / 2


def _distance(left: dict[str, float], right: dict[str, float]) -> float:
    lx, ly = _center(left)
    rx, ry = _center(right)
    return math.hypot(lx - rx, ly - ry)


def _panel_crop_size(width: int, height: int) -> tuple[int, int]:
    ratio = PANEL_WIDTH / PANEL_HEIGHT
    if width / height >= ratio:
        return max(2, int(height * ratio) // 2 * 2), height // 2 * 2
    return width // 2 * 2, max(2, int(width / ratio) // 2 * 2)


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _protected(face: dict[str, float]) -> tuple[float, float, float, float]:
    return (
        face["x"] - face["width"] * 0.2,
        face["y"] - face["height"] * 0.35,
        face["width"] * 1.4,
        face["height"] * 1.55,
    )


def _initial_crop(face: dict[str, float], crop_width: int, crop_height: int, width: int, height: int) -> tuple[float, float]:
    return (
        _clamp(face["x"] + face["width"] / 2 - crop_width / 2, 0, width - crop_width),
        _clamp(face["y"] + face["height"] * 0.45 - crop_height / 2, 0, height - crop_height),
    )


def _move_crop(
    face: dict[str, float], current: tuple[float, float], last_move: float, timestamp: float,
    crop_width: int, crop_height: int, width: int, height: int,
) -> tuple[tuple[float, float], float]:
    target_x, target_y = _initial_crop(face, crop_width, crop_height, width, height)
    dx, dy = target_x - current[0], target_y - current[1]
    outside = abs(dx) > crop_width * DEAD_ZONE_FRACTION or abs(dy) > crop_height * DEAD_ZONE_FRACTION
    if not outside or timestamp - last_move < MINIMUM_HOLD_SECONDS:
        return current, last_move
    next_x = current[0] + _clamp(dx * SMOOTHING_ALPHA, -crop_width * MAXIMUM_STEP_FRACTION, crop_width * MAXIMUM_STEP_FRACTION)
    next_y = current[1] + _clamp(dy * SMOOTHING_ALPHA, -crop_height * MAXIMUM_STEP_FRACTION, crop_height * MAXIMUM_STEP_FRACTION)
    return (
        _clamp(next_x, 0, width - crop_width),
        _clamp(next_y, 0, height - crop_height),
    ), timestamp


def _safe(face: dict[str, float], crop: tuple[int, int, int, int]) -> bool:
    protected_x, protected_y, protected_w, protected_h = _protected(face)
    crop_x, crop_y, crop_width, crop_height = crop
    margin_x, margin_y = crop_width * SAFE_ZONE_MARGIN, crop_height * SAFE_ZONE_MARGIN
    return (
        protected_x >= crop_x + margin_x
        and protected_y >= crop_y + margin_y
        and protected_x + protected_w <= crop_x + crop_width - margin_x
        and protected_y + protected_h <= crop_y + crop_height - margin_y
    )


def plan_two_speaker_layout(
    detections: list[list[dict[str, float]]], times: list[float], width: int, height: int, duration: float,
) -> dict[str, Any]:
    """Associate a stable source-left/source-right pair and plan two panel crops."""
    if len(detections) != len(times) or not times:
        raise ContractValidationError("detections: must match sampled timestamps")
    if width < 2 or height < 2 or duration <= 0:
        raise ContractValidationError("input: dimensions and duration must be positive")
    confident = [
        [face for face in faces if face["confidence"] >= CONFIDENCE_THRESHOLD]
        for faces in detections
    ]
    extra_faces = any(len(faces) > 2 for faces in detections)
    paired_count = sum(len(faces) == 2 for faces in confident)
    paired_coverage = round(paired_count / len(times), 6)
    reason = "extra_faces" if extra_faces else None
    if reason is None and paired_coverage < COVERAGE_THRESHOLD:
        reason = "insufficient_pair_coverage"

    crop_width, crop_height = _panel_crop_size(width, height)
    diagonal = math.hypot(width, height)
    previous: tuple[dict[str, float], dict[str, float]] | None = None
    upper_position = lower_position = (0.0, 0.0)
    upper_last_move = lower_last_move = -MINIMUM_HOLD_SECONDS
    safe_pairs = 0
    confidence_total = 0.0
    samples: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []

    for index, (timestamp, all_faces, faces) in enumerate(zip(times, detections, confident)):
        assigned: tuple[dict[str, float], dict[str, float]] | None = None
        ambiguous = False
        if len(faces) == 2:
            if previous is None:
                ordered = sorted(faces, key=lambda face: _center(face)[0])
                assigned = ordered[0], ordered[1]
                upper_position = _initial_crop(assigned[0], crop_width, crop_height, width, height)
                lower_position = _initial_crop(assigned[1], crop_width, crop_height, width, height)
            else:
                direct = _distance(previous[0], faces[0]) + _distance(previous[1], faces[1])
                swapped = _distance(previous[0], faces[1]) + _distance(previous[1], faces[0])
                if abs(direct - swapped) <= diagonal * ASSOCIATION_AMBIGUITY_FRACTION:
                    ambiguous = True
                assigned = (faces[0], faces[1]) if direct < swapped else (faces[1], faces[0])
                if _center(assigned[0])[0] >= _center(assigned[1])[0]:
                    ambiguous = True
            if ambiguous:
                reason = reason or "ambiguous_crossing"
            previous = assigned
            upper_position, upper_last_move = _move_crop(
                assigned[0], upper_position, upper_last_move, timestamp,
                crop_width, crop_height, width, height,
            )
            lower_position, lower_last_move = _move_crop(
                assigned[1], lower_position, lower_last_move, timestamp,
                crop_width, crop_height, width, height,
            )
            upper_crop = (int(round(upper_position[0])), int(round(upper_position[1])), crop_width, crop_height)
            lower_crop = (int(round(lower_position[0])), int(round(lower_position[1])), crop_width, crop_height)
            protected_too_large = any(
                _protected(face)[2] > crop_width * (1 - 2 * SAFE_ZONE_MARGIN)
                or _protected(face)[3] > crop_height * (1 - 2 * SAFE_ZONE_MARGIN)
                for face in assigned
            )
            pair_safe = not protected_too_large and _safe(assigned[0], upper_crop) and _safe(assigned[1], lower_crop)
            safe_pairs += int(pair_safe)
            confidence_total += (assigned[0]["confidence"] + assigned[1]["confidence"]) / 2
            if protected_too_large:
                reason = reason or "unsafe_panel_crop"
            upper_index = next(index for index, face in enumerate(all_faces) if face is assigned[0])
            lower_index = next(index for index, face in enumerate(all_faces) if face is assigned[1])
            assignment = {"upper_face_index": upper_index, "lower_face_index": lower_index}
            upper = {"x": upper_crop[0], "y": upper_crop[1], "width": crop_width, "height": crop_height}
            lower = {"x": lower_crop[0], "y": lower_crop[1], "width": crop_width, "height": crop_height}
            end = times[index + 1] if index + 1 < len(times) else duration
            segments.append({"start_seconds": timestamp, "end_seconds": round(end, 6), "upper": upper, "lower": lower})
        else:
            assignment = None
            upper = lower = None
            if previous is not None:
                end = times[index + 1] if index + 1 < len(times) else duration
                segments.append({
                    "start_seconds": timestamp,
                    "end_seconds": round(end, 6),
                    "upper": {"x": int(round(upper_position[0])), "y": int(round(upper_position[1])), "width": crop_width, "height": crop_height},
                    "lower": {"x": int(round(lower_position[0])), "y": int(round(lower_position[1])), "width": crop_width, "height": crop_height},
                })
        samples.append({
            "time_seconds": timestamp,
            "faces": all_faces,
            "assignment": assignment,
            "upper_crop": upper,
            "lower_crop": lower,
            "association_ambiguous": ambiguous,
        })

    safe_fraction = round(safe_pairs / paired_count, 6) if paired_count else 0.0
    mean_confidence = round(confidence_total / paired_count, 6) if paired_count else 0.0
    if reason is None and mean_confidence < CONFIDENCE_THRESHOLD:
        reason = "low_pair_confidence"
    if reason is None and safe_fraction < SAFE_ZONE_TARGET:
        reason = "unsafe_panel_crop"
    return {
        "mode": "fallback_reuse" if reason else "two_speaker_split",
        "fallback_reason": reason,
        "paired_coverage": paired_coverage,
        "mean_pair_confidence": mean_confidence,
        "safe_zone_fraction": safe_fraction,
        "samples": samples,
        "segments": [] if reason else segments,
    }


def _load(
    request: dict[str, Any], ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]],
) -> tuple[Path, dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    project = Path(request["project_dir"]).expanduser().resolve()
    descriptors = request["input_artifacts"]
    reframe_descriptors = [item for item in descriptors if item["kind"] == "reframe_artifact" and item.get("version") == 1]
    boundary_descriptors = [item for item in descriptors if item["kind"] == "boundary_artifact" and item.get("version") == 1]
    if len(reframe_descriptors) != 1 or len(boundary_descriptors) != 1 or len(descriptors) != 2:
        raise _error(
            "two_speaker_input_invalid",
            "Two-speaker reframing requires exactly the current reframe v1 and boundary v1 artifacts.",
            "Provide the completed Issue 7 and Issue 6 artifact descriptors and retry.",
        )
    if reframe_descriptors[0]["path"] != REFRAME_ARTIFACT_RELATIVE_PATH.as_posix():
        raise _error("two_speaker_input_invalid", "The reframe v1 descriptor is not current.", "Use the current completed reframe v1 artifact.")
    try:
        reframe_v1_path = _inside(project, reframe_descriptors[0]["path"])
        boundary_path = _inside(project, boundary_descriptors[0]["path"])
        reframe_v1 = validate_document("reframe_artifact", json.loads(reframe_v1_path.read_text()))
        boundary = validate_document("boundary_artifact", json.loads(boundary_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error("two_speaker_input_invalid", f"The required artifacts are missing, stale, or invalid: {exc}.", "Complete Issues 6 and 7 for the current source and retry.") from exc
    if (
        boundary_descriptors[0]["path"] != (Path("artifacts") / "boundary-artifact.v1.json").as_posix()
        or reframe_v1["source"]["fingerprint"] != boundary["source"]["fingerprint"]
        or reframe_v1["source"]["boundary_cache_key"] != boundary["cache_key"]
    ):
        raise _error("two_speaker_input_stale", "The reframe v1 and boundary artifacts do not describe the same source work.", "Rerun Issue 7 for the current boundary artifact.")
    boundary_by_id = {item["candidate_id"]: item for item in boundary["candidates"]}
    v1_by_id = {item["candidate_id"]: item for item in reframe_v1["candidates"]}
    incomplete_requested = [
        candidate_id for candidate_id in reframe_v1["requested_candidate_ids"]
        if candidate_id not in v1_by_id or v1_by_id[candidate_id]["output"]["state"] != "completed"
    ]
    if incomplete_requested:
        raise _error(
            "two_speaker_input_incomplete",
            f"The current reframe v1 artifact has incomplete requested outputs: {', '.join(incomplete_requested)}.",
            "Complete Issue 7 for every requested candidate and retry.",
        )
    validated: list[dict[str, Any]] = []
    for item in reframe_v1["candidates"]:
        old_output = item["output"]
        if old_output["state"] != "completed":
            continue
        boundary_item = boundary_by_id.get(item["candidate_id"])
        if not boundary_item or boundary_item["extraction"]["state"] != "completed":
            raise _error("two_speaker_input_stale", f"The Issue 6 preview for {item['candidate_id']} is not completed.", "Recreate the affected preview and rerun Issue 7.")
        extraction = boundary_item["extraction"]
        expected_v1_output = (Path("artifacts") / "reframed-previews" / f"{item['candidate_id']}.vertical.mp4").as_posix()
        if (
            item["input"]["path"] != extraction["path"]
            or item["input"]["fingerprint"] != extraction["fingerprint"]
            or abs(item["input"]["duration_seconds"] - extraction["duration_seconds"]) > float(boundary["settings"]["duration_tolerance_seconds"])
            or old_output["path"] != expected_v1_output
        ):
            raise _error(
                "two_speaker_input_stale",
                f"The Issue 6 and Issue 7 records for {item['candidate_id']} do not match.",
                "Recreate the affected Issue 7 output from the current Issue 6 preview.",
            )
        source_path = _inside(project, item["input"]["path"])
        output_path = _inside(project, old_output["path"])
        if (
            not source_path.is_file() or fingerprint_file(source_path) != item["input"]["fingerprint"]
            or not output_path.is_file() or fingerprint_file(output_path) != old_output["fingerprint"]
        ):
            raise _error("two_speaker_input_stale", f"A validated input or v1 output for {item['candidate_id']} is missing or changed.", "Recreate the affected Issue 6/7 output and retry.")
        try:
            source_probe = _probe(source_path, ffprobe)
            probe = _probe(output_path, ffprobe)
        except ReframeError as exc:
            raise _error(
                "two_speaker_input_stale",
                f"The v1 output for {item['candidate_id']} failed media validation: {exc}.",
                "Recreate the affected Issue 7 output and retry.",
            ) from exc
        tolerance = float(boundary["settings"]["duration_tolerance_seconds"])
        if (
            source_probe["width"] != item["input"]["width"]
            or source_probe["height"] != item["input"]["height"]
            or abs(source_probe["duration"] - item["input"]["duration_seconds"]) > tolerance
        ):
            raise _error("two_speaker_input_stale", f"The Issue 6 preview for {item['candidate_id']} failed media validation.", "Re-extract the affected Issue 6 preview and retry.")
        if (
            probe["width"] != OUTPUT_WIDTH
            or probe["height"] != OUTPUT_HEIGHT
            or probe["video_codec"] != "h264"
            or probe["audio_codec"] != "aac"
            or abs(probe["duration"] - old_output["duration_seconds"]) > tolerance
        ):
            raise _error("two_speaker_input_stale", f"The v1 output for {item['candidate_id']} failed media validation.", "Recreate the affected Issue 7 output and retry.")
        validated.append({"v1": item, "source_path": source_path, "output_path": output_path})
    return project, boundary, reframe_v1, validated


def _render_split(
    source_path: Path, destination: Path, plan: dict[str, Any], duration: float, tolerance: float,
    *, ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]],
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]],
) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.stem}.{os.getpid()}.tmp.mp4"
    segments = plan["segments"]
    upper_segments = [{**segment["upper"], "end_seconds": segment["end_seconds"]} for segment in segments]
    lower_segments = [{**segment["lower"], "end_seconds": segment["end_seconds"]} for segment in segments]
    upper_x, upper_y = _step_expression(upper_segments, "x"), _step_expression(upper_segments, "y")
    lower_x, lower_y = _step_expression(lower_segments, "x"), _step_expression(lower_segments, "y")
    first_upper, first_lower = upper_segments[0], lower_segments[0]
    graph = (
        "[0:v]split=2[upper_input][lower_input];"
        f"[upper_input]crop={first_upper['width']}:{first_upper['height']}:{upper_x}:{upper_y},scale={PANEL_WIDTH}:{PANEL_HEIGHT}:flags=lanczos,setsar=1[upper];"
        f"[lower_input]crop={first_lower['width']}:{first_lower['height']}:{lower_x}:{lower_y},scale={PANEL_WIDTH}:{PANEL_HEIGHT}:flags=lanczos,setsar=1[lower];"
        "[upper][lower]vstack=inputs=2[v]"
    )
    command = [
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(source_path),
        "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(temporary),
    ]
    try:
        try:
            result = ffmpeg(command)
        except (FileNotFoundError, OSError) as exc:
            raise _error("ffmpeg_not_available", f"FFmpeg could not start: {exc}.", "Install FFmpeg and retry.") from exc
        if result.returncode != 0 or not temporary.is_file():
            raise _error("two_speaker_render_failed", "FFmpeg did not create a complete two-speaker preview.", "Check FFmpeg, codecs, and disk space, then retry.")
        probe = _probe(temporary, ffprobe)
        if (
            probe["width"] != OUTPUT_WIDTH
            or probe["height"] != OUTPUT_HEIGHT
            or probe["video_codec"] != "h264"
            or probe["audio_codec"] != "aac"
            or abs(probe["duration"] - duration) > tolerance
        ):
            raise _error("two_speaker_output_invalid", "The two-speaker preview codecs, dimensions, or duration are invalid.", "Retry with a working FFmpeg build.")
        os.replace(temporary, destination)
        return {
            "origin": "v2_render",
            "requested": True,
            "state": "completed",
            "path": destination.as_posix(),
            "fingerprint": fingerprint_file(destination),
            "duration_seconds": round(probe["duration"], 6),
            "width": probe["width"],
            "height": probe["height"],
        }
    finally:
        temporary.unlink(missing_ok=True)


def upgrade_reframe_previews(
    request: dict[str, Any], *,
    ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> TwoSpeakerReframeResult:
    progress({"phase": "validating_inputs", "fraction": 0.02, "cache_hit": False, "message": "validating completed Issue 6 and Issue 7 artifacts"})
    project, boundary, reframe_v1, validated = _load(request, ffprobe)
    options = request["options"]
    if not isinstance(options, dict) or set(options) - {"candidate_ids"}:
        raise ContractValidationError("options: only candidate_ids is supported")
    validated_by_id = {item["v1"]["candidate_id"]: item for item in validated}
    default_ids = [item for item in reframe_v1["requested_candidate_ids"] if item in validated_by_id]
    requested = options.get("candidate_ids", default_ids)
    if not isinstance(requested, list) or len(requested) != len(set(requested)) or any(item not in validated_by_id for item in requested):
        raise ContractValidationError("options.candidate_ids: must be unique completed reframe v1 candidate ids")
    tolerance = float(boundary["settings"]["duration_tolerance_seconds"])
    settings = {
        "output_width": OUTPUT_WIDTH,
        "output_height": OUTPUT_HEIGHT,
        "panel_width": PANEL_WIDTH,
        "panel_height": PANEL_HEIGHT,
        "confidence_threshold": CONFIDENCE_THRESHOLD,
        "paired_coverage_threshold": COVERAGE_THRESHOLD,
        "safe_zone_margin": SAFE_ZONE_MARGIN,
        "safe_zone_target": SAFE_ZONE_TARGET,
        "dead_zone_fraction": DEAD_ZONE_FRACTION,
        "smoothing_alpha": SMOOTHING_ALPHA,
        "maximum_step_fraction": MAXIMUM_STEP_FRACTION,
        "minimum_hold_seconds": MINIMUM_HOLD_SECONDS,
        "association_ambiguity_fraction": ASSOCIATION_AMBIGUITY_FRACTION,
        "duration_tolerance_seconds": tolerance,
    }
    reframe_v1_path = project / REFRAME_ARTIFACT_RELATIVE_PATH
    source = {
        "fingerprint": reframe_v1["source"]["fingerprint"],
        "boundary_cache_key": boundary["cache_key"],
        "reframe_v1_cache_key": reframe_v1["cache_key"],
        "reframe_v1_fingerprint": fingerprint_file(reframe_v1_path),
    }
    cache_key = _hash({"source": source, "versions": VERSIONS, "settings": settings, "requested": requested})
    artifact_path = project / REFRAME_V2_ARTIFACT_RELATIVE_PATH
    previous = None
    try:
        previous = validate_document("reframe_artifact_v2", json.loads(artifact_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError):
        pass
    previous_by_id = {item["candidate_id"]: item for item in previous["candidates"]} if previous else {}
    entries: list[dict[str, Any]] = []
    for record in validated:
        v1 = record["v1"]
        candidate_id = v1["candidate_id"]
        is_requested = candidate_id in requested
        input_record = {
            "path": v1["input"]["path"],
            "fingerprint": v1["input"]["fingerprint"],
            "duration_seconds": v1["input"]["duration_seconds"],
            "width": v1["input"]["width"],
            "height": v1["input"]["height"],
            "v1_mode": v1["mode"],
            "v1_fallback_reason": v1["fallback_reason"],
            "v1_output_path": v1["output"]["path"],
            "v1_output_fingerprint": v1["output"]["fingerprint"],
        }
        if v1["mode"] == "track":
            plan = {
                "mode": "single_speaker_reuse", "fallback_reason": None,
                "paired_coverage": 0.0, "mean_pair_confidence": 0.0, "safe_zone_fraction": v1["safe_zone_fraction"],
                "samples": [], "segments": [],
            }
        elif v1["fallback_reason"] == "multiple_faces":
            times = [sample["time_seconds"] for sample in v1["samples"]]
            detections = [sample["faces"] for sample in v1["samples"]]
            plan = plan_two_speaker_layout(detections, times, v1["input"]["width"], v1["input"]["height"], v1["input"]["duration_seconds"])
        else:
            plan = {
                "mode": "fallback_reuse", "fallback_reason": f"v1_{v1['fallback_reason']}",
                "paired_coverage": 0.0, "mean_pair_confidence": 0.0, "safe_zone_fraction": 0.0,
                "samples": [], "segments": [],
            }
        output_key = _hash({"input": input_record, "versions": VERSIONS, "settings": settings, "plan": plan})
        if plan["mode"] in {"single_speaker_reuse", "fallback_reuse"}:
            output = {
                "origin": "v1_reuse", "requested": is_requested,
                "state": "completed" if is_requested else "not_requested",
                "path": v1["output"]["path"] if is_requested else None,
                "fingerprint": v1["output"]["fingerprint"] if is_requested else None,
                "duration_seconds": v1["output"]["duration_seconds"] if is_requested else None,
                "width": v1["output"]["width"] if is_requested else None,
                "height": v1["output"]["height"] if is_requested else None,
            }
        else:
            output = {
                "origin": "v2_render", "requested": is_requested,
                "state": "pending" if is_requested else "not_requested",
                "path": None, "fingerprint": None, "duration_seconds": None, "width": None, "height": None,
            }
            destination = project / REFRAME_V2_DIRECTORY / f"{candidate_id}.two-speaker.vertical.mp4"
            old = previous_by_id.get(candidate_id)
            if is_requested and old and old["output_key"] == output_key and old["output"]["state"] == "completed" and destination.is_file():
                try:
                    probe = _probe(destination, ffprobe)
                    if (
                        old["output"]["path"] == destination.relative_to(project).as_posix()
                        and probe["width"] == OUTPUT_WIDTH
                        and probe["height"] == OUTPUT_HEIGHT
                        and probe["video_codec"] == "h264"
                        and probe["audio_codec"] == "aac"
                        and abs(probe["duration"] - v1["input"]["duration_seconds"]) <= tolerance
                        and fingerprint_file(destination) == old["output"]["fingerprint"]
                    ):
                        output = dict(old["output"])
                        output["requested"] = True
                except (OSError, ReframeError):
                    pass
        entries.append({"candidate_id": candidate_id, "input": input_record, **plan, "output_key": output_key, "output": output})

    created_at = clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def document() -> dict[str, Any]:
        return {
            "artifact_version": REFRAME_ARTIFACT_V2_VERSION,
            "engine_version": ENGINE_VERSION,
            "created_at": created_at,
            "versions": VERSIONS,
            "source": source,
            "settings": settings,
            "cache_key": cache_key,
            "requested_candidate_ids": list(requested),
            "candidates": entries,
        }

    expected = document()
    if previous:
        fields = ("artifact_version", "engine_version", "versions", "source", "settings", "cache_key", "requested_candidate_ids", "candidates")
        all_complete = all(item["output"]["state"] == "completed" for item in entries if item["candidate_id"] in requested)
        if all_complete and all(previous[field] == expected[field] for field in fields):
            progress({"phase": "final_cache_hit", "fraction": 1.0, "percent": 100, "cache_hit": True, "message": "reusing matching validated reframe v2 artifact and outputs"})
            return TwoSpeakerReframeResult(previous, artifact_path, True)

    targets = [next(item for item in entries if item["candidate_id"] == candidate_id) for candidate_id in requested]
    for index, entry in enumerate(targets):
        if cancelled():
            raise cancellation_error()
        if entry["mode"] == "two_speaker_split" and entry["output"]["state"] != "completed":
            source_record = validated_by_id[entry["candidate_id"]]
            destination = project / REFRAME_V2_DIRECTORY / f"{entry['candidate_id']}.two-speaker.vertical.mp4"
            entry["output"] = _render_split(
                source_record["source_path"], destination, entry,
                entry["input"]["duration_seconds"], tolerance,
                ffmpeg=ffmpeg, ffprobe=ffprobe,
            )
            entry["output"]["path"] = destination.relative_to(project).as_posix()
        validate_document("reframe_artifact_v2", document())
        _atomic_json(artifact_path, document())
        progress({
            "phase": "two_speaker_candidate_completed",
            "candidate_id": entry["candidate_id"],
            "fraction": 0.15 + 0.8 * ((index + 1) / max(1, len(targets))),
            "cache_hit": entry["output"]["origin"] == "v1_reuse",
            "message": f"validated {entry['candidate_id']} reframe v2 output",
        })
    artifact = document()
    validate_document("reframe_artifact_v2", artifact)
    _atomic_json(artifact_path, artifact)
    progress({"phase": "two_speaker_reframe_completed", "fraction": 1.0, "percent": 100, "cache_hit": False, "message": "prepared stable two-speaker vertical layouts"})
    return TwoSpeakerReframeResult(artifact, artifact_path, False)
