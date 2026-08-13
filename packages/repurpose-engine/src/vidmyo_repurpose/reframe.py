"""Deterministic single-speaker 9:16 reframing with a safe blurred fallback."""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sysconfig
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

from .candidates import _atomic_json
from .contracts import ContractValidationError, REFRAME_ARTIFACT_VERSION, validate_document
from .ingest import fingerprint_file

ENGINE_VERSION = "0.1.0"
REFRAME_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "reframe-artifact.v1.json"
REFRAME_DIRECTORY = Path("artifacts") / "reframed-previews"
MODEL_RELATIVE_PATH = Path("models") / "face_detection_yunet_2023mar.onnx"
MODEL_FINGERPRINT = "sha256:8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
VERSIONS = {
    "schema": "reframe-artifact.v1",
    "detector": "yunet-2023mar.v1",
    "tracker": "single-speaker-tracker.v1",
    "renderer": "vertical-preview.v1",
}
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
SAMPLE_INTERVAL = 0.5
CONFIDENCE_THRESHOLD = 0.75
COVERAGE_THRESHOLD = 0.8
SAFE_ZONE_MARGIN = 0.1
SAFE_ZONE_TARGET = 0.95
DEAD_ZONE_FRACTION = 0.05
SMOOTHING_ALPHA = 0.35
MAXIMUM_STEP_FRACTION = 0.08
MINIMUM_HOLD_SECONDS = 1.0


@dataclass(frozen=True)
class ReframeError(Exception):
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
class ReframeResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


class FaceDetector(Protocol):
    def detect(self, media_path: Path, times: list[float]) -> list[list[dict[str, float]]]: ...


class YuNetDetector:
    """Local OpenCV wrapper; imports heavy dependencies only when actually used."""

    def __init__(self, model_path: Path | None = None) -> None:
        repository_model = Path(__file__).resolve().parents[2] / MODEL_RELATIVE_PATH
        installed_model = Path(sysconfig.get_path("data")) / "share" / "vidmyo-repurpose" / MODEL_RELATIVE_PATH
        self.model_path = model_path or (repository_model if repository_model.is_file() else installed_model)
        if not self.model_path.is_file():
            raise _error(
                "reframe_model_missing",
                f"The bundled YuNet model is missing: {self.model_path}.",
                "Reinstall Vidmyo Repurpose from a complete package and retry.",
            )
        if fingerprint_file(self.model_path) != MODEL_FINGERPRINT:
            raise _error(
                "reframe_model_invalid",
                "The bundled YuNet model failed its integrity check.",
                "Reinstall Vidmyo Repurpose from a trusted complete package and retry.",
            )

    def detect(self, media_path: Path, times: list[float]) -> list[list[dict[str, float]]]:
        try:
            import cv2
        except (ImportError, OSError) as exc:
            raise _error(
                "reframe_detector_unavailable",
                f"OpenCV could not be loaded: {exc}.",
                "Install the complete Vidmyo Repurpose package and retry.",
            ) from exc
        capture = cv2.VideoCapture(str(media_path))
        if not capture.isOpened():
            raise _error("reframe_input_unreadable", "OpenCV could not open the preview.", "Recreate the Issue 6 preview and retry.")
        results: list[list[dict[str, float]]] = []
        detector = None
        try:
            for timestamp in times:
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
                ok, frame = capture.read()
                if not ok:
                    results.append([])
                    continue
                height, width = frame.shape[:2]
                if detector is None:
                    detector = cv2.FaceDetectorYN.create(
                        str(self.model_path), "", (width, height),
                        CONFIDENCE_THRESHOLD, 0.3, 5000,
                    )
                else:
                    detector.setInputSize((width, height))
                _, faces = detector.detect(frame)
                normalized = []
                if faces is not None:
                    for face in faces:
                        normalized.append({
                            "x": round(max(0.0, float(face[0])), 3),
                            "y": round(max(0.0, float(face[1])), 3),
                            "width": round(max(1.0, float(face[2])), 3),
                            "height": round(max(1.0, float(face[3])), 3),
                            "confidence": round(min(1.0, max(0.0, float(face[14]))), 6),
                        })
                results.append(normalized)
        except ReframeError:
            raise
        except Exception as exc:
            raise _error("reframe_detection_failed", f"Local face detection failed: {exc}.", "Retry or use the safe fallback after reinstalling OpenCV.") from exc
        finally:
            capture.release()
        return results


def _error(code: str, message: str, next_action: str) -> ReframeError:
    return ReframeError(
        code,
        message[:1000],
        "The Issue 6 previews, completed reframed previews, and any earlier valid reframe artifact were preserved.",
        next_action,
    )


def cancellation_error() -> ReframeError:
    return _error("reframe_cancelled", "Reframing was cancelled at a safe candidate boundary.", "Retry the same request to reuse completed validated previews.")


def _hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _inside(project: Path, relative: str) -> Path:
    path = (project / relative).resolve()
    try:
        path.relative_to(project.resolve())
    except ValueError as exc:
        raise ContractValidationError(f"path: escapes project: {relative}") from exc
    return path


def _probe(path: Path, runner: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> dict[str, Any]:
    command = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    try:
        result = runner(command)
        document = json.loads(result.stdout)
        video = next(item for item in document["streams"] if item.get("codec_type") == "video")
        audio = next(item for item in document["streams"] if item.get("codec_type") == "audio")
        duration = float(document["format"]["duration"])
        width, height = int(video["width"]), int(video["height"])
    except (FileNotFoundError, OSError, StopIteration, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise _error("reframe_probe_failed", f"The preview could not be validated: {exc}.", "Check FFmpeg and recreate the Issue 6 preview.") from exc
    if result.returncode != 0 or not audio:
        raise _error("reframe_probe_failed", "The preview does not contain readable video and audio.", "Recreate the Issue 6 preview and retry.")
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name"),
    }


def _load(request: dict[str, Any], ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> tuple[Path, dict[str, Any], list[dict[str, Any]]]:
    project = Path(request["project_dir"]).expanduser().resolve()
    try:
        manifest = validate_document("manifest", json.loads((project / "repurpose.json").read_text()))
        stage = manifest["stages"]["repair_boundaries"]
        descriptors = [item for item in request["input_artifacts"] if item["kind"] == "boundary_artifact" and item.get("version") == 1]
        if stage["state"] != "completed" or not stage["artifact"] or len(descriptors) != 1 or descriptors[0]["path"] != stage["artifact"]:
            raise ContractValidationError("input_artifacts: must name the current completed boundary artifact")
        boundary = validate_document("boundary_artifact", json.loads(_inside(project, descriptors[0]["path"]).read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error("reframe_input_invalid", f"Reframe inputs are missing, stale, or invalid: {exc}.", "Complete boundary repair for the current local project and retry.") from exc
    if manifest["source"]["type"] != "local_file" or boundary["source"]["fingerprint"] != manifest["source"]["fingerprint"]:
        raise _error("reframe_input_stale", "The boundary artifact does not match the current local source.", "Rerun the earlier stages for the current source.")
    completed: list[dict[str, Any]] = []
    for item in boundary["candidates"]:
        extraction = item["extraction"]
        if extraction["state"] != "completed":
            continue
        path = _inside(project, extraction["path"])
        if not path.is_file() or fingerprint_file(path) != extraction["fingerprint"]:
            raise _error("reframe_input_stale", f"The validated preview for {item['candidate_id']} is missing or changed.", "Re-extract the affected preview and retry.")
        probe = _probe(path, ffprobe)
        tolerance = float(boundary["settings"]["duration_tolerance_seconds"])
        if abs(probe["duration"] - extraction["duration_seconds"]) > tolerance:
            raise _error("reframe_input_stale", f"The preview duration for {item['candidate_id']} changed.", "Re-extract the affected preview and retry.")
        completed.append({
            "candidate_id": item["candidate_id"], "path": path,
            "relative_path": extraction["path"], "fingerprint": extraction["fingerprint"],
            "duration": probe["duration"], "width": probe["width"], "height": probe["height"],
        })
    return project, boundary, completed


def _sample_times(duration: float) -> list[float]:
    count = max(1, int(math.ceil(duration / SAMPLE_INTERVAL)))
    return [round(min(index * SAMPLE_INTERVAL, max(0.0, duration - 0.001)), 6) for index in range(count)]


def _crop_size(width: int, height: int) -> tuple[int, int]:
    ratio = OUTPUT_WIDTH / OUTPUT_HEIGHT
    if width / height >= ratio:
        return max(2, int(height * ratio) // 2 * 2), height // 2 * 2
    return width // 2 * 2, max(2, int(width / ratio) // 2 * 2)


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def plan_tracking(detections: list[list[dict[str, float]]], times: list[float], width: int, height: int, duration: float) -> dict[str, Any]:
    if len(detections) != len(times) or not times:
        raise ContractValidationError("detections: must match sampled timestamps")
    multiple = any(len(faces) > 1 for faces in detections)
    present = [faces[0] for faces in detections if len(faces) == 1]
    coverage = round(len(present) / len(times), 6)
    mean_confidence = round(sum(face["confidence"] for face in present) / len(present), 6) if present else 0.0
    reason = None
    if multiple:
        reason = "multiple_faces"
    elif not present:
        reason = "no_face"
    elif coverage < COVERAGE_THRESHOLD:
        reason = "insufficient_face_coverage"
    elif mean_confidence < CONFIDENCE_THRESHOLD:
        reason = "low_confidence"
    crop_width, crop_height = _crop_size(width, height)
    samples = []
    segments = []
    safe = 0
    confident_observed = 0
    max_x, max_y = width - crop_width, height - crop_height
    if present:
        first_face = present[0]
        last_x = _clamp(first_face["x"] + first_face["width"] / 2 - crop_width / 2, 0, max_x)
        last_y = _clamp(first_face["y"] + first_face["height"] * 0.45 - crop_height / 2, 0, max_y)
    else:
        last_x = max_x / 2
        last_y = max_y / 2
    last_move = -MINIMUM_HOLD_SECONDS
    max_step_x = crop_width * MAXIMUM_STEP_FRACTION
    max_step_y = crop_height * MAXIMUM_STEP_FRACTION
    current_face = None
    for index, (timestamp, faces) in enumerate(zip(times, detections)):
        if len(faces) == 1:
            current_face = faces[0]
        face = current_face
        crop_x = crop_y = None
        if face is not None:
            protected_x = face["x"] - face["width"] * 0.2
            protected_y = face["y"] - face["height"] * 0.35
            protected_w = face["width"] * 1.4
            protected_h = face["height"] * 1.55
            if protected_w > crop_width * (1 - 2 * SAFE_ZONE_MARGIN) or protected_h > crop_height * (1 - 2 * SAFE_ZONE_MARGIN):
                reason = reason or "unsafe_crop"
            target_x = _clamp(face["x"] + face["width"] / 2 - crop_width / 2, 0, max_x)
            target_y = _clamp(face["y"] + face["height"] * 0.45 - crop_height / 2, 0, max_y)
            dx, dy = target_x - last_x, target_y - last_y
            outside_dead_zone = abs(dx) > crop_width * DEAD_ZONE_FRACTION or abs(dy) > crop_height * DEAD_ZONE_FRACTION
            if outside_dead_zone and timestamp - last_move >= MINIMUM_HOLD_SECONDS:
                last_x += _clamp(dx * SMOOTHING_ALPHA, -max_step_x, max_step_x)
                last_y += _clamp(dy * SMOOTHING_ALPHA, -max_step_y, max_step_y)
                last_x, last_y, last_move = _clamp(last_x, 0, max_x), _clamp(last_y, 0, max_y), timestamp
            crop_x, crop_y = int(round(last_x)), int(round(last_y))
            margin_x, margin_y = crop_width * SAFE_ZONE_MARGIN, crop_height * SAFE_ZONE_MARGIN
            confidently_detected = len(faces) == 1 and face["confidence"] >= CONFIDENCE_THRESHOLD
            if confidently_detected:
                confident_observed += 1
            if confidently_detected and (
                protected_x >= crop_x + margin_x and protected_y >= crop_y + margin_y
                and protected_x + protected_w <= crop_x + crop_width - margin_x
                and protected_y + protected_h <= crop_y + crop_height - margin_y
            ):
                safe += 1
        samples.append({"time_seconds": timestamp, "faces": faces, "crop_x": crop_x, "crop_y": crop_y})
        if crop_x is not None:
            end = times[index + 1] if index + 1 < len(times) else duration
            segments.append({
                "start_seconds": timestamp, "end_seconds": round(end, 6),
                "x": crop_x, "y": crop_y, "width": crop_width, "height": crop_height,
            })
    safe_fraction = round(safe / confident_observed, 6) if confident_observed else 0.0
    if reason is None and safe_fraction < SAFE_ZONE_TARGET:
        reason = "unsafe_crop"
    return {
        "mode": "fallback" if reason else "track", "fallback_reason": reason,
        "coverage": coverage, "mean_confidence": mean_confidence,
        "safe_zone_fraction": safe_fraction, "samples": samples,
        "segments": [] if reason else segments,
    }


def _step_expression(segments: list[dict[str, Any]], field: str) -> str:
    expression = str(segments[-1][field])
    for segment in reversed(segments[:-1]):
        expression = f"if(lt(t\\,{segment['end_seconds']:.6f})\\,{segment[field]}\\,{expression})"
    return expression


def _render(input_path: Path, destination: Path, plan: dict[str, Any], duration: float, tolerance: float, *, ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]], ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]]) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.stem}.{os.getpid()}.tmp.mp4"
    if plan["mode"] == "track":
        segments = plan["segments"]
        x_expr, y_expr = _step_expression(segments, "x"), _step_expression(segments, "y")
        crop = segments[0]
        filter_complex = f"[0:v]crop={crop['width']}:{crop['height']}:{x_expr}:{y_expr},scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:flags=lanczos,setsar=1[v]"
    else:
        filter_complex = (
            f"[0:v]split=2[background][foreground];"
            f"[background]scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT},boxblur=20:10[blurred];"
            f"[foreground]scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fit];"
            f"[blurred][fit]overlay=(W-w)/2:(H-h)/2,setsar=1[v]"
        )
    command = [
        "ffmpeg", "-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(input_path),
        "-filter_complex", filter_complex, "-map", "[v]", "-map", "0:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(temporary),
    ]
    try:
        try:
            result = ffmpeg(command)
        except (FileNotFoundError, OSError) as exc:
            raise _error("ffmpeg_not_available", f"FFmpeg could not start: {exc}.", "Install FFmpeg and retry reframing.") from exc
        if result.returncode != 0 or not temporary.is_file():
            raise _error("reframe_render_failed", "FFmpeg did not create a complete reframed preview.", "Check FFmpeg, codecs, and disk space, then retry.")
        probe = _probe(temporary, ffprobe)
        if probe["width"] != OUTPUT_WIDTH or probe["height"] != OUTPUT_HEIGHT or abs(probe["duration"] - duration) > tolerance:
            raise _error("reframe_output_invalid", "The reframed preview dimensions or duration are invalid.", "Retry with a working FFmpeg build.")
        os.replace(temporary, destination)
        return {
            "requested": True, "state": "completed", "path": destination.as_posix(),
            "fingerprint": fingerprint_file(destination), "duration_seconds": round(probe["duration"], 6),
            "width": probe["width"], "height": probe["height"],
        }
    finally:
        temporary.unlink(missing_ok=True)


def reframe_previews(
    request: dict[str, Any], *, detector: FaceDetector | None = None,
    ffmpeg: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    ffprobe: Callable[[list[str]], subprocess.CompletedProcess[str]] = lambda command: subprocess.run(command, capture_output=True, text=True),
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> ReframeResult:
    progress({"phase": "validating_inputs", "fraction": 0.02, "cache_hit": False, "message": "validating completed Issue 6 previews"})
    project, boundary, completed = _load(request, ffprobe)
    options = request["options"]
    if not isinstance(options, dict) or set(options) - {"candidate_ids"}:
        raise ContractValidationError("options: only candidate_ids is supported")
    completed_by_id = {item["candidate_id"]: item for item in completed}
    default_ids = [item for item in boundary["requested_candidate_ids"] if item in completed_by_id]
    requested = options.get("candidate_ids", default_ids)
    if not isinstance(requested, list) or len(requested) != len(set(requested)) or any(item not in completed_by_id for item in requested):
        raise ContractValidationError("options.candidate_ids: must be unique completed retained preview ids")
    tolerance = float(boundary["settings"]["duration_tolerance_seconds"])
    settings = {
        "output_width": OUTPUT_WIDTH, "output_height": OUTPUT_HEIGHT,
        "sample_interval_seconds": SAMPLE_INTERVAL, "confidence_threshold": CONFIDENCE_THRESHOLD,
        "coverage_threshold": COVERAGE_THRESHOLD, "safe_zone_margin": SAFE_ZONE_MARGIN,
        "safe_zone_target": SAFE_ZONE_TARGET, "dead_zone_fraction": DEAD_ZONE_FRACTION,
        "smoothing_alpha": SMOOTHING_ALPHA, "maximum_step_fraction": MAXIMUM_STEP_FRACTION,
        "minimum_hold_seconds": MINIMUM_HOLD_SECONDS, "duration_tolerance_seconds": tolerance,
    }
    source = {"fingerprint": boundary["source"]["fingerprint"], "boundary_cache_key": boundary["cache_key"]}
    cache_key = _hash({"source": source, "versions": VERSIONS, "settings": settings, "requested": requested})
    artifact_path = project / REFRAME_ARTIFACT_RELATIVE_PATH
    previous = None
    try:
        previous = validate_document("reframe_artifact", json.loads(artifact_path.read_text()))
    except (OSError, json.JSONDecodeError, ContractValidationError):
        pass
    previous_by_id = {item["candidate_id"]: item for item in previous["candidates"]} if previous else {}
    detector_instance = detector
    entries = []
    for source_item in completed:
        candidate_id = source_item["candidate_id"]
        is_requested = candidate_id in requested
        input_record = {
            "path": source_item["relative_path"], "fingerprint": source_item["fingerprint"],
            "duration_seconds": round(source_item["duration"], 6),
            "width": source_item["width"], "height": source_item["height"],
        }
        times = _sample_times(source_item["duration"])
        if detector_instance is None:
            detector_instance = YuNetDetector()
        detections = detector_instance.detect(source_item["path"], times)
        plan = plan_tracking(detections, times, source_item["width"], source_item["height"], source_item["duration"])
        output_key = _hash({"input": input_record, "versions": VERSIONS, "settings": settings, "plan": plan})
        output = {"requested": is_requested, "state": "pending" if is_requested else "not_requested", "path": None, "fingerprint": None, "duration_seconds": None, "width": None, "height": None}
        destination = project / REFRAME_DIRECTORY / f"{candidate_id}.vertical.mp4"
        old = previous_by_id.get(candidate_id)
        if is_requested and old and old["output_key"] == output_key and old["output"]["state"] == "completed" and destination.is_file():
            try:
                probe = _probe(destination, ffprobe)
                if probe["width"] == OUTPUT_WIDTH and probe["height"] == OUTPUT_HEIGHT and abs(probe["duration"] - source_item["duration"]) <= tolerance and fingerprint_file(destination) == old["output"]["fingerprint"]:
                    output = dict(old["output"])
                    output["requested"] = True
            except ReframeError:
                pass
        entries.append({"candidate_id": candidate_id, "input": input_record, **plan, "output_key": output_key, "output": output})
    created_at = clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    def document() -> dict[str, Any]:
        return {
            "artifact_version": REFRAME_ARTIFACT_VERSION, "engine_version": ENGINE_VERSION,
            "created_at": created_at, "versions": VERSIONS, "source": source,
            "settings": settings, "cache_key": cache_key,
            "requested_candidate_ids": list(requested), "candidates": entries,
        }

    expected = document()
    if previous:
        fields = ("artifact_version", "engine_version", "versions", "source", "settings", "cache_key", "requested_candidate_ids", "candidates")
        all_complete = all(item["output"]["state"] == "completed" for item in entries if item["candidate_id"] in requested)
        if all_complete and all(previous[field] == expected[field] for field in fields):
            progress({"phase": "final_cache_hit", "fraction": 1.0, "percent": 100, "cache_hit": True, "message": "reusing matching validated reframe artifact and previews"})
            return ReframeResult(previous, artifact_path, True)
    targets = [next(item for item in entries if item["candidate_id"] == candidate_id) for candidate_id in requested]
    for index, entry in enumerate(targets):
        if cancelled():
            raise cancellation_error()
        if entry["output"]["state"] != "completed":
            source_item = completed_by_id[entry["candidate_id"]]
            destination = project / REFRAME_DIRECTORY / f"{entry['candidate_id']}.vertical.mp4"
            entry["output"] = _render(source_item["path"], destination, entry, source_item["duration"], tolerance, ffmpeg=ffmpeg, ffprobe=ffprobe)
            entry["output"]["path"] = destination.relative_to(project).as_posix()
            validate_document("reframe_artifact", document())
            _atomic_json(artifact_path, document())
        progress({"phase": "reframe_completed", "candidate_id": entry["candidate_id"], "fraction": 0.15 + 0.8 * ((index + 1) / max(1, len(targets))), "cache_hit": False, "message": f"validated {entry['candidate_id']} vertical preview"})
    artifact = document()
    validate_document("reframe_artifact", artifact)
    _atomic_json(artifact_path, artifact)
    progress({"phase": "reframe_stage_completed", "fraction": 1.0, "percent": 100, "cache_hit": False, "message": "prepared single-speaker vertical previews"})
    return ReframeResult(artifact, artifact_path, False)
