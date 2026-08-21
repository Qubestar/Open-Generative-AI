"""Offline five-scenario benchmark evidence and reporting.

Synthetic fixtures validate mechanics only. They are deliberately incapable of
turning ranking/transcription/tracking quality gates green.
"""

from __future__ import annotations

import json
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .contracts import ContractValidationError, validate_document

CATEGORIES = ("talking_head", "two_speaker", "lecture", "webinar", "visually_active")
STAGES = ("ingest", "transcribe", "generate_candidates", "rank", "repair_boundaries", "reframe_v1", "reframe_v2", "render")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _inside(root: Path, value: str) -> Path:
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ContractValidationError(f"benchmark path escapes project: {value}") from exc
    return candidate


def _run(command: list[str], run_command: Callable[..., Any]) -> float:
    started = time.perf_counter()
    result = run_command(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "command failed").strip()[-1000:]
        raise RuntimeError(detail)
    return time.perf_counter() - started


def _media_command(path: Path, *, vertical: bool, color: str, duration: int = 20) -> list[str]:
    width, height = ((1080, 1920) if vertical else (320, 180))
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c={color}:s={width}x{height}:r=5:d={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", str(path),
    ]


def generate_fixture_corpus(output_dir: str | Path, *, run_command: Callable[..., Any] = subprocess.run) -> Path:
    root = Path(output_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    scenarios: list[dict[str, Any]] = []
    colors = ("0x355070", "0x6d597a", "0xb56576", "0xe56b6f", "0xeaac8b")
    for index, category in enumerate(CATEGORIES, start=1):
        project = root / f"scenario_{index}_{category}"
        evidence = project / "benchmark-evidence"
        export_dir = project / "artifacts" / "platform-exports"
        evidence.mkdir(parents=True, exist_ok=True)
        export_dir.mkdir(parents=True, exist_ok=True)
        source = project / "source.mp4"
        export = export_dir / "clip_001.clean.youtube_shorts.mp4"
        source_seconds = _run(_media_command(source, vertical=False, color=colors[index - 1]), run_command)
        export_seconds = _run(_media_command(export, vertical=True, color=colors[index - 1]), run_command)
        words = [f"word_{number:06d}" for number in range(1, 101)]
        shortlist = [f"clip_{number:03d}" for number in range(1, 6)]
        _write(evidence / "transcript.json", {"word_ids": words})
        _write(evidence / "ranking.json", {"shortlist_candidate_ids": shortlist, "duplicate_groups": []})
        _write(evidence / "boundary.json", {"candidates": [
            {"candidate_id": candidate, "first_word_id": words[(number - 1) * 20], "last_word_id": words[number * 20 - 1]}
            for number, candidate in enumerate(shortlist, start=1)
        ]})
        mode = "two_speaker_split" if category == "two_speaker" else ("single_speaker_reuse" if category == "talking_head" else "fallback_reuse")
        _write(evidence / "reframe.json", {"candidates": [{
            "candidate_id": "clip_001", "mode": mode,
            "safe_zone_fraction": 0.98 if mode != "fallback_reuse" else 1.0,
            "fallback_reason": None if mode != "fallback_reuse" else "synthetic_no_faces",
        }]})
        _write(evidence / "render.json", {"candidates": [{
            "candidate_id": "clip_001", "exports": [{"path": export.relative_to(project).as_posix()}],
        }]})
        scenarios.append({
            "id": f"fixture_{index}_{category}", "category": category,
            "evidence_kind": "synthetic_fixture", "project_dir": str(project),
            "source": {
                "path": str(source),
                "provenance": "Generated locally by vidmyo-repurpose benchmark-fixtures from FFmpeg color+sine sources",
                "license": "CC0-1.0 (generated fixture; no third-party expressive content)",
            },
            "evidence_files": {
                "transcript": "benchmark-evidence/transcript.json",
                "ranking": "benchmark-evidence/ranking.json",
                "boundary": "benchmark-evidence/boundary.json",
                "reframe": "benchmark-evidence/reframe.json",
                "render": "benchmark-evidence/render.json",
            },
            "human_review": {
                "reviewer": "synthetic-fixture-policy",
                "candidates": [
                    {"candidate_id": candidate, "approved": True, "complete_sentence": True}
                    for candidate in shortlist
                ],
            },
            "timings": {
                **{stage: None for stage in STAGES},
                "fixture_source_generation": round(source_seconds, 6),
                "fixture_export_generation": round(export_seconds, 6),
            },
        })
    manifest = {"schema_version": "repurpose-benchmark.v1", "created_at": _now(), "scenarios": scenarios}
    validate_document("benchmark_corpus", manifest)
    destination = root / "benchmark-corpus.v1.json"
    _write(destination, manifest)
    return destination


def _probe(file: Path, run_command: Callable[..., Any]) -> dict[str, Any]:
    result = run_command([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(file),
    ], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return {"ok": False, "path": str(file), "error": (result.stderr or "ffprobe failed").strip()[-500:]}
    try:
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        video = next(item for item in streams if item.get("codec_type") == "video")
        audio = next(item for item in streams if item.get("codec_type") == "audio")
        duration = float(data["format"]["duration"])
        ok = video.get("codec_name") == "h264" and audio.get("codec_name") == "aac" and video.get("width") == 1080 and video.get("height") == 1920 and duration > 0
        return {"ok": ok, "path": str(file), "duration_seconds": duration, "video_codec": video.get("codec_name"), "audio_codec": audio.get("codec_name"), "width": video.get("width"), "height": video.get("height")}
    except (KeyError, StopIteration, TypeError, ValueError, json.JSONDecodeError) as exc:
        return {"ok": False, "path": str(file), "error": f"invalid ffprobe result: {exc}"}


def _scenario_result(entry: dict[str, Any], *, run_command: Callable[..., Any]) -> dict[str, Any]:
    project = Path(entry["project_dir"]).expanduser().resolve()
    source = Path(entry["source"]["path"]).expanduser().resolve()
    if not source.is_file():
        raise ContractValidationError(f"source.path: file is missing for {entry['id']}")
    files = {name: _read(_inside(project, value)) for name, value in entry["evidence_files"].items()}
    word_ids = set(files["transcript"].get("word_ids", []))
    shortlist = list(files["ranking"].get("shortlist_candidate_ids", []))[:5]
    reviews = {item["candidate_id"]: item for item in entry["human_review"]["candidates"]}
    approved = sum(reviews.get(candidate, {}).get("approved") is True for candidate in shortlist)
    complete_values = [reviews.get(candidate, {}).get("complete_sentence") for candidate in shortlist]
    boundary_candidates = files["boundary"].get("candidates", [])
    mid_word = [item["candidate_id"] for item in boundary_candidates if item.get("first_word_id") not in word_ids or item.get("last_word_id") not in word_ids]
    duplicate_groups = files["ranking"].get("duplicate_groups", [])
    duplicate_shortlist_pairs = sum(
        max(0, len(set(group.get("member_candidate_ids", [])) & set(shortlist)) - 1)
        for group in duplicate_groups
    )
    reframes = files["reframe"].get("candidates", [])
    fallbacks = sum(item.get("mode") == "fallback_reuse" for item in reframes)
    safe_values = [float(item["safe_zone_fraction"]) for item in reframes if isinstance(item.get("safe_zone_fraction"), (int, float))]
    export_paths = [
        _inside(project, export["path"])
        for candidate in files["render"].get("candidates", [])
        for export in candidate.get("exports", [])
    ]
    probes = [_probe(file, run_command) for file in export_paths]
    mechanical_pass = not mid_word and duplicate_shortlist_pairs == 0 and bool(probes) and all(item["ok"] for item in probes)
    real_evidence = entry["evidence_kind"] == "human_real" and bool(entry["human_review"].get("reviewer"))
    complete_status = "pass" if complete_values and all(value is True for value in complete_values) else ("fail" if any(value is False for value in complete_values) else "unknown")
    quality_status = "pass" if real_evidence and approved >= 3 and complete_status == "pass" else ("fail" if real_evidence else "unknown")
    return {
        "id": entry["id"], "category": entry["category"], "evidence_kind": entry["evidence_kind"],
        "source": entry["source"], "shortlist_count": len(shortlist), "approved_top5": approved,
        "complete_sentence_status": complete_status, "mid_word_violations": mid_word,
        "duplicate_shortlist_pairs": duplicate_shortlist_pairs,
        "reframe": {"sampled_candidates": len(reframes), "fallback_count": fallbacks, "minimum_safe_zone_fraction": min(safe_values) if safe_values else None},
        "exports": probes, "timings_seconds": entry["timings"],
        "mechanical_status": "pass" if mechanical_pass else "fail", "quality_status": quality_status,
    }


def run_benchmark(manifest_path: str | Path, *, run_command: Callable[..., Any] = subprocess.run) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = validate_document("benchmark_corpus", _read(manifest_file))
    categories = [entry["category"] for entry in manifest["scenarios"]]
    if sorted(categories) != sorted(CATEGORIES):
        raise ContractValidationError("scenarios: must contain each required category exactly once")
    started = time.perf_counter()
    scenarios = [_scenario_result(entry, run_command=run_command) for entry in manifest["scenarios"]]
    real_count = sum(item["evidence_kind"] == "human_real" for item in scenarios)
    mechanical_status = "pass" if all(item["mechanical_status"] == "pass" for item in scenarios) else "fail"
    qualifying_real = sum(item["quality_status"] == "pass" and item["approved_top5"] >= 3 for item in scenarios)
    quality_status = "pass" if real_count == 5 and qualifying_real >= 4 else ("fail" if real_count == 5 else "unknown")
    return {
        "report_version": "repurpose-benchmark-report.v1", "generated_at": _now(),
        "corpus": str(manifest_file),
        "machine": {"platform": platform.platform(), "python": platform.python_version(), "processor": platform.machine()},
        "scenario_count": len(scenarios), "real_scenario_count": real_count,
        "scenarios": scenarios,
        "aggregate": {
            "mechanical_status": mechanical_status, "quality_status": quality_status,
            "qualifying_real_projects": qualifying_real,
            "mid_word_violations": sum(len(item["mid_word_violations"]) for item in scenarios),
            "duplicate_shortlist_pairs": sum(item["duplicate_shortlist_pairs"] for item in scenarios),
            "exports_probed": sum(len(item["exports"]) for item in scenarios),
            "benchmark_wall_seconds": round(time.perf_counter() - started, 6),
        },
        "warning": "Synthetic fixtures validate contracts and packaging mechanics only; they do not establish ranking, transcription, sentence, speaker-tracking, or creator-release quality." if real_count < 5 else None,
    }


def report_markdown(report: dict[str, Any]) -> str:
    aggregate = report["aggregate"]
    lines = [
        "# Vidmyo Repurpose benchmark report", "",
        f"- Mechanical status: **{aggregate['mechanical_status'].upper()}**",
        f"- Human real-corpus quality status: **{aggregate['quality_status'].upper()}**",
        f"- Evidence: {report['real_scenario_count']} real / {report['scenario_count'] - report['real_scenario_count']} synthetic scenarios",
        f"- Mid-word violations: {aggregate['mid_word_violations']}",
        f"- Duplicate shortlist pairs: {aggregate['duplicate_shortlist_pairs']}",
        f"- Exports probed: {aggregate['exports_probed']}", "",
    ]
    if report.get("warning"):
        lines += [f"> **Evidence boundary:** {report['warning']}", ""]
    lines += ["| Scenario | Evidence | Approved top 5 | Sentence | Mechanical | Quality |", "|---|---|---:|---|---|---|"]
    for item in report["scenarios"]:
        lines.append(f"| {item['category']} | {item['evidence_kind']} | {item['approved_top5']} | {item['complete_sentence_status']} | {item['mechanical_status']} | {item['quality_status']} |")
    lines += ["", "Per-stage timings remain `null` unless they came from an observed pipeline run. Fixture media-generation timings are labeled separately and must not be used as long-video throughput claims.", ""]
    return "\n".join(lines)


def write_report(report: dict[str, Any], output_dir: str | Path) -> tuple[Path, Path]:
    root = Path(output_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    json_path = root / "benchmark-report.v1.json"
    markdown_path = root / "benchmark-report.md"
    _write(json_path, report)
    markdown_path.write_text(report_markdown(report), encoding="utf-8")
    return json_path, markdown_path
