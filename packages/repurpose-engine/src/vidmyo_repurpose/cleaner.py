"""Conservative, review-first talking-head cleanup planning and rendering."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Mapping

from .candidate_providers import ProviderError, make_candidate_provider

PLAN_PATH = Path("artifacts") / "cleaner-plan.v1.json"
OUTPUT_PATH = Path("exports") / "cleaned-video.mp4"
MAX_SEGMENTS_PER_REQUEST = 120
RESTART_GAP_SECONDS = 0.25
# Perfect Cuts v2's waveform-boundary method and reference thresholds informed
# this local adaptation. Upstream: Systems by Vic, MIT; see models/PERFECT_CUTS_LICENSE.
WAVEFORM_IN_DB = "-30dB"
WAVEFORM_OUT_DB = "-38dB"

_CUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["cuts", "kept"],
    "properties": {
        "kept": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["segment_id", "reason"],
                "properties": {
                    "segment_id": {"type": "string"},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 240},
                },
            },
        },
        "cuts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["segment_id", "category", "reason"],
                "properties": {
                    "segment_id": {"type": "string", "pattern": "^segment_[0-9]{6}$"},
                    "category": {
                        "type": "string",
                        "enum": ["retake", "false_start", "direction", "non_speech"],
                    },
                    "reason": {"type": "string", "minLength": 1, "maxLength": 240},
                },
            },
        }
    },
}


class CleanerError(RuntimeError):
    pass


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleanerError(f"Could not read {path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise CleanerError(f"{path.name} must contain a JSON object")
    return value


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _same_source(previous: Mapping[str, Any], current: Mapping[str, Any]) -> bool:
    return previous.get('source') == current.get('source')


def _explicit_overrides(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in plan.get('decisions') or []:
        # A safety-held KEEP is not a user override. Only explicit review or a
        # saved timing edit establishes user intent across reanalysis.
        if item.get('reviewed') or item.get('timing_adjusted'):
            result.append(dict(item))
    return result


def _normalized_decision_text(value: Any) -> str:
    return ' '.join(re.findall(r"\w+", str(value or '').lower()))


def _reconcile_overrides(overrides, decisions):
    """Transfer only uniquely matched user intent; surface every doubtful map."""
    available = set(range(len(decisions)))
    pending, conflicts = [], []
    for old in overrides:
        old_start, old_end = float(old.get('start_seconds', 0)), float(old.get('end_seconds', 0))
        old_text = _normalized_decision_text(old.get('text'))
        candidates = []
        for index in available:
            new = decisions[index]
            if old.get('category') != new.get('category') or old_text != _normalized_decision_text(new.get('text')):
                continue
            new_start, new_end = float(new.get('start_seconds', 0)), float(new.get('end_seconds', 0))
            overlap = max(0., min(old_end, new_end) - max(old_start, new_start))
            shorter = max(.001, min(old_end-old_start, new_end-new_start))
            exact = abs(old_start-new_start) <= .02 and abs(old_end-new_end) <= .02
            anchored = (abs(old_start-new_start) <= .08 or abs(old_end-new_end) <= .08) and overlap/shorter >= .65
            if exact or (old_text and anchored):
                candidates.append((index, exact))
        if len(candidates) != 1:
            pending.append({**old, '_reanalysis_match': 'unmatched_override' if not candidates else 'ambiguous_override'})
            continue
        index, exact = candidates[0]
        available.remove(index)
        new = decisions[index]
        new['decision'] = old['decision']
        new['preserved_override'] = True
        if exact and old.get('reviewed') and not old.get('timing_adjusted'):
            new['reviewed'] = True
        else:
            new['needs_review'] = True
            new['reviewed'] = False
            if not exact or old.get('timing_adjusted'):
                new['override_conflict'] = 'boundary_changed'
                conflicts.append({'previous_segment_id': old.get('segment_id'),
                                  'segment_id': new.get('segment_id'), 'kind': 'boundary_changed'})
    return pending, conflicts


def _warning_blocks_segment(warning, segment):
    if warning.get('blocks_auto_cut') is False:
        return False
    boundaries = warning.get('boundary_seconds')
    if isinstance(boundaries, list) and boundaries:
        edges = (float(segment['start_seconds']), float(segment['end_seconds']))
        return any(abs(float(boundary)-edge) <= .001 for boundary in boundaries for edge in edges)
    return (float(warning['start_seconds']) < float(segment['end_seconds'])
            and float(warning['end_seconds']) > float(segment['start_seconds']))


def _warning_at_boundary(warning, boundary):
    if warning.get('blocks_auto_cut') is False:
        return False
    boundaries = warning.get('boundary_seconds')
    if isinstance(boundaries, list) and boundaries:
        return any(abs(float(value)-boundary) <= .001 for value in boundaries)
    return float(warning['start_seconds']) <= boundary <= float(warning['end_seconds'])


def repeated_takes(segments):
    hints = []
    for index, first in enumerate(segments):
        a = re.findall(r"\w+", first["text"].lower())
        if len(a) < 2:
            continue
        for second in segments[index + 1:index + 13]:
            if second['start_seconds'] - first['end_seconds'] > 30:
                break
            b = re.findall(r"\w+", second["text"].lower())
            matcher = SequenceMatcher(None, a, b, autojunk=False)
            match = matcher.find_longest_match()
            coverage = sum(m.size for m in matcher.get_matching_blocks()) / max(1, len(a))
            matched = {i for m in matcher.get_matching_blocks() for i in range(m.a, m.a+m.size)}
            extra = {word for i, word in enumerate(a) if i not in matched}
            short_restart = len(a) == 2 and b[:2] == a and len(b) > 2
            if short_restart or (match.size >= 3 and coverage >= 0.65):
                hints.append({"earlier": first["id"], "later": second["id"],
                              "shared_words": " ".join(a[match.a:match.a + match.size]),
                              "earlier_coverage": coverage,
                              "preserves_content": extra <= {'you', 'just', 'simply', 'in', 'a', 'the', 'uh', 'um', 'and', 'so'}})
    return hints


def _request(segments: list[dict[str, Any]], intake: Mapping[str, Any]) -> dict[str, Any]:
    logical = {
        "task": "identify_talking_head_cleanup_cuts",
        "rules": [
            "Return only segments that should clearly be removed.",
            "For repeated or near-repeated takes, keep the latest complete fluent take unless an earlier take connects better.",
            "Cut abandoned false starts, directions to camera, sound checks, and non-speech transcript noise.",
            "Never cut useful unique content, filler words inside an otherwise good delivery, or a segment merely because it is informal.",
            "A missing segment from cuts means KEEP. Be conservative when uncertain.",
            "Explain every kept segment in kept with a specific plain-language reason based on its content; identify uncertainty explicitly.",
            "Read adjacent segments together: a pause is not proof of an abandoned sentence. Do not remove an introduction or call to action merely because it differs from the main topic.",
            "For a retake, name the later replacement segment in the reason and verify that it preserves the information being removed.",
            "Repeated tails are split from unique lead-ins. Keep the lead-in and the later completed instruction; mark the earlier repeated tail for removal. A two-word abandoned restart is still a false start, not intentional emphasis by default.",
            "Do not invent stutters or retakes absent from the transcript. Silence is handled separately and never counts as a speech cut.",
        ],
        "script_mode": intake.get("script_mode"),
        "script": intake.get("script_text"),
        "possible_repeated_takes": repeated_takes(segments),
        "segments": [
            {
                "segment_id": item["id"],
                "start_seconds": item["start_seconds"],
                "end_seconds": item["end_seconds"],
                "text": item["text"],
            }
            for item in segments
        ],
    }
    return {
        "schema_name": "vidmyo_cleaner_cuts_v1",
        "schema": _CUT_SCHEMA,
        "messages": [
            {"role": "system", "content": "Return strict transcript-grounded JSON. Do not invent segment ids."},
            {"role": "user", "content": json.dumps(logical, separators=(",", ":"))},
        ],
    }


def analysis_units(transcript: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Split Whisper segments at meaningful internal pauses so restarts stay visible."""

    from .cleaner_transcribe import split_retake_segments
    transcript = {**transcript, "segments": split_retake_segments(transcript.get('segments', []), transcript.get('words', []))}
    words = {item["id"]: item for item in transcript.get("words") or [] if isinstance(item, dict) and item.get("id")}
    units: list[dict[str, Any]] = []

    def add(selected: list[dict[str, Any]], fallback: Mapping[str, Any] | None = None) -> None:
        if selected:
            text = " ".join(str(item.get("text") or "").strip() for item in selected).strip()
            start, end = float(selected[0]["start_seconds"]), float(selected[-1]["end_seconds"])
        else:
            text = str((fallback or {}).get("text") or "").strip()
            start = float((fallback or {}).get("start_seconds") or 0)
            end = float((fallback or {}).get("end_seconds") or start)
        if text and end > start:
            units.append({"id": f"segment_{len(units) + 1:06d}", "start_seconds": start, "end_seconds": end, "text": text})

    for segment in transcript.get("segments") or []:
        selected = [words[word_id] for word_id in segment.get("word_ids") or [] if word_id in words]
        if not selected:
            add([], segment)
            continue
        current = [selected[0]]
        for word in selected[1:]:
            if float(word["start_seconds"]) - float(current[-1]["end_seconds"]) >= RESTART_GAP_SECONDS:
                add(current)
                current = []
            current.append(word)
        add(current)
    return units


def _silences(source: Path, threshold: str) -> tuple[list[float], list[float]]:
    completed = subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-i", str(source),
        "-af", f"silencedetect=noise={threshold}:d={RESTART_GAP_SECONDS}", "-f", "null", "-",
    ], text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise CleanerError("FFmpeg could not inspect the source waveform")
    return (
        [float(value) for value in re.findall(r"silence_start: ([\d.]+)", completed.stderr)],
        [float(value) for value in re.findall(r"silence_end: ([\d.]+)", completed.stderr)],
    )


def waveform_units(source: Path, transcript: Mapping[str, Any], duration: float) -> list[dict[str, Any]]:
    """Map word evidence onto waveform speech blocks; fall back if audio is atypical."""

    sensitive_starts, sensitive_ends = _silences(source, WAVEFORM_OUT_DB)
    _hard_starts, hard_ends = _silences(source, WAVEFORM_IN_DB)
    events = sorted([(value, "start") for value in sensitive_starts] + [(value, "end") for value in sensitive_ends])
    blocks: list[tuple[float, float]] = []
    cursor, in_silence = 0.0, False
    for timestamp, kind in events:
        if kind == "start" and not in_silence:
            if timestamp - cursor > 0.05:
                blocks.append((cursor, timestamp))
            in_silence = True
        elif kind == "end":
            cursor, in_silence = timestamp, False
    if not in_silence and duration - cursor > 0.05:
        blocks.append((cursor, duration))
    speech_duration = sum(end - start for start, end in blocks)
    tiny = sum(end - start < 0.4 for start, end in blocks)
    if not blocks or speech_duration > duration * 0.95 or (len(blocks) > 10 and tiny / len(blocks) > 0.7):
        return analysis_units(transcript)
    words = sorted(transcript.get("words") or [], key=lambda item: float(item.get("start_seconds") or 0))
    units = []
    assigned = set()
    for block_start, block_end in blocks:
        selected = [word for word in words if word.get("id") not in assigned and block_start - 0.15 <= float(word.get("start_seconds") or 0) < block_end + 0.05]
        text = " ".join(str(word.get("text") or "").strip() for word in selected).strip()
        if not text:
            continue
        assigned.update(word.get("id") for word in selected)
        onset = next((value for value in hard_ends if block_start - 0.05 <= value <= block_end), block_start)
        units.append({
            "id": f"segment_{len(units) + 1:06d}",
            "start_seconds": round(min(onset, float(selected[0]["start_seconds"])), 6),
            "end_seconds": round(max(block_end, float(selected[-1]["end_seconds"])), 6),
            "text": text,
        })
    # Never silently omit quiet speech that the waveform detector missed.
    if any(word.get("id") not in assigned for word in words):
        return analysis_units(transcript)
    return units or analysis_units(transcript)


def _chunks(segments: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    if len(segments) <= MAX_SEGMENTS_PER_REQUEST:
        return [segments]
    result = []
    step = MAX_SEGMENTS_PER_REQUEST - 12
    for start in range(0, len(segments), step):
        chunk = segments[start:start + MAX_SEGMENTS_PER_REQUEST]
        if chunk:
            result.append(chunk)
        if start + MAX_SEGMENTS_PER_REQUEST >= len(segments):
            break
    return result


def build_plan(
    project_dir: Path,
    *,
    provider_factory: Callable[..., Any] = make_candidate_provider,
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
) -> dict[str, Any]:
    project_dir = project_dir.expanduser().resolve()
    manifest = _read_json(project_dir / "cleaner.json")
    previous_plan = None
    try:
        previous_plan = _read_json(project_dir / PLAN_PATH)
    except CleanerError:
        pass
    precise_path = project_dir / "artifacts/cleaner-transcript.v1.json"
    transcript = _read_json(precise_path if precise_path.is_file() else project_dir / "artifacts/transcript-artifact.v1.json")
    source = Path(manifest.get("source", {}).get("uri", "")).expanduser()
    try:
        duration = _duration(project_dir)
        if transcript.get("cleaner_strategy"):
            segments = analysis_units(transcript)
            boundary_source = "independent_speech_regions"
        else:
            segments = waveform_units(source.resolve(), transcript, duration) if source.is_file() else analysis_units(transcript)
            boundary_source = "waveform_with_safe_fallback" if source.is_file() and segments else "transcript"
    except CleanerError:
        segments = analysis_units(transcript)
        boundary_source = "transcript_fallback"
    if not segments:
        raise CleanerError("The completed transcript has no speech segments")
    analysis = manifest.get("analysis") or {}
    provider_id = analysis.get("provider")
    model = analysis.get("model") or os.environ.get("VIDMYO_AGENT_MODEL") or "configured-default"
    try:
        provider = provider_factory(provider_id, model)
    except (ProviderError, ValueError) as exc:
        raise CleanerError(str(exc)) from exc
    proposed: dict[str, dict[str, str]] = {}
    kept_reasons: dict[str, str] = {}
    batches = _chunks(segments)
    for index, batch in enumerate(batches):
        progress({"phase": "analysis", "fraction": index / len(batches), "message": f"reviewing transcript section {index + 1} of {len(batches)}"})
        try:
            response = provider.structured(_request(batch, manifest.get("intake") or {}))
        except ProviderError as exc:
            raise CleanerError(str(exc)) from exc
        if not isinstance(response, dict) or not isinstance(response.get("cuts"), list):
            raise CleanerError("The analysis provider returned an invalid cleanup plan")
        allowed = {item["id"] for item in batch}
        for item in response.get("kept", []):
            if not isinstance(item, dict) or item.get("segment_id") not in allowed or not isinstance(item.get("reason"), str) or not item["reason"].strip():
                raise CleanerError("The analysis provider returned an invalid keep explanation")
            kept_reasons[item["segment_id"]] = " ".join(item["reason"].split())[:240]
        for cut in response["cuts"]:
            if not isinstance(cut, dict) or cut.get("segment_id") not in allowed:
                raise CleanerError("The analysis provider referenced an unknown transcript segment")
            segment_id = cut["segment_id"]
            category = cut.get("category")
            reason = " ".join(str(cut.get("reason") or "").split())[:240]
            if category not in {"retake", "false_start", "direction", "non_speech"} or not reason:
                raise CleanerError("The analysis provider returned an invalid cut decision")
            proposed[segment_id] = {"category": category, "reason": reason}
    decisions = []
    hints = repeated_takes(segments)
    from .cleaner_transcribe import STRATEGY
    suggested = {hint['earlier']: hint for hint in hints
                 if hint['earlier_coverage'] >= .7 and hint['preserves_content'] and transcript.get('cleaner_strategy') == STRATEGY}
    for segment in segments:
        cut = proposed.get(segment["id"])
        suggestion = suggested.get(segment['id']) if not cut else None
        if suggestion:
            cut = {'category': 'retake', 'reason': f"Possible earlier take, repeated in {suggestion['later']}. Keep the later complete delivery; listen to both before confirming this removal."}
        uncertain = any(_warning_blocks_segment(warning, segment)
                        for warning in transcript.get("quality_warnings", []))
        decisions.append({
            "segment_id": segment["id"],
            "start_seconds": segment["start_seconds"],
            "end_seconds": segment["end_seconds"],
            "text": segment["text"],
            "proposed": "cut" if cut else "keep",
            "decision": "cut" if cut and not uncertain else "keep",
            "needs_review": uncertain or bool(suggestion),
            "category": cut["category"] if cut else None,
            "reason": cut["reason"] if cut else kept_reasons.get(segment["id"], "No confident reason to remove this speech was supplied. Play it in context before deciding."),
        })
    for warning in transcript.get("quality_warnings", []):
        if any(item["start_seconds"] < warning["end_seconds"] and item["end_seconds"] > warning["start_seconds"] for item in decisions):
            continue
        decisions.append({
            "segment_id": f"segment_{len(decisions) + 1:06d}",
            "start_seconds": warning["start_seconds"], "end_seconds": warning["end_seconds"],
            "text": "Possible cough or untranscribed sound — listen" if warning.get('kind') == 'audio_event' else "Speech could not be transcribed — listen to this section", "category": "untranscribed",
            "proposed": "keep", "decision": "keep", "needs_review": True, "reason": warning["message"],
        })
    decisions.sort(key=lambda item: item["start_seconds"])
    plan = {
        "version": 1,
        "source": manifest["source"],
        "provider": {"id": provider_id, "model": model},
        "transcript_strategy": transcript.get("cleaner_strategy"),
        "transcript_key": transcript.get("cleaner_cache_key"),
        "quality_warnings": transcript.get("quality_warnings", []),
        "repeated_takes": hints,
        "decisions": decisions,
        "summary": {
            "segments": len(decisions),
            "proposed_cuts": sum(item["proposed"] == "cut" for item in decisions),
            "applied_cuts": sum(item["decision"] == "cut" for item in decisions),
            "boundary_source": boundary_source,
        },
    }
    if previous_plan is not None:
        overrides = _explicit_overrides(previous_plan)
        if _same_source(previous_plan, plan):
            pending, conflicts = _reconcile_overrides(overrides, decisions)
        else:
            pending = []
            conflicts = [{'previous_segment_id': item.get('segment_id'), 'kind': 'source_changed'} for item in overrides]
        if pending:
            plan['_pending_reanalysis_overrides'] = pending
        if conflicts:
            plan['reanalysis_conflicts'] = conflicts
        encoded = json.dumps(previous_plan, sort_keys=True, separators=(',', ':')).encode()
        archive = project_dir / 'artifacts' / 'cleaner-plan-history' / f"cleaner-plan-{hashlib.sha256(encoded).hexdigest()[:16]}.json"
        if not archive.exists():
            _atomic_json(archive, previous_plan)
    plan['summary']['proposed_cuts'] = sum(item.get('proposed') == 'cut' for item in decisions)
    plan['summary']['applied_cuts'] = sum(item.get('decision') == 'cut' for item in decisions)
    _atomic_json(project_dir / PLAN_PATH, plan)
    progress({"phase": "analysis", "fraction": 1.0, "message": "cleanup plan ready for review"})
    return plan


def _merged_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[list[float]] = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1] + 0.03:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(item[0], item[1]) for item in merged]


def kept_ranges(plan: Mapping[str, Any], duration: float, *, remove_dead_air: bool = True) -> list[tuple[float, float]]:
    decisions = plan.get("decisions") or []
    if plan.get('review_version') == 2:
        # Reviewed intervals ARE the edit. No invisible margins, snaps, merging
        # across kept audio, or minimum-duration deletion is permitted here.
        cuts = sorted((max(0., float(d['start_seconds'])), min(duration, float(d['end_seconds'])))
                      for d in decisions if d.get('decision') == 'cut')
        cursor, kept = 0., []
        for start, end in cuts:
            if end <= start:
                continue
            if start > cursor:
                kept.append((cursor,start))
            cursor = max(cursor,end)
        if cursor < duration:
            kept.append((cursor,duration))
        return kept
    cuts = []
    for item in decisions:
        if item.get("decision") != "cut":
            continue
        padding = item.get("category") != "pause"
        start = max(0.0, float(item["start_seconds"]) - (0.04 if padding else 0))
        end = min(duration, float(item["end_seconds"]) + (0.08 if padding else 0))
        if plan.get("review_version"):
            # Manual removals must never eat adjacent retained speech.
            for neighbor in decisions:
                if neighbor.get("decision") != "keep":
                    continue
                if float(neighbor["end_seconds"]) <= float(item["start_seconds"]):
                    start = max(start, float(neighbor["end_seconds"]))
                if float(neighbor["start_seconds"]) >= float(item["end_seconds"]):
                    end = min(end, float(neighbor["start_seconds"]))
        cuts.append((0.0 if start < 0.5 else start, duration if duration - end < 0.5 else end))
    if remove_dead_air and not plan.get("review_version"):
        kept_speech = [item for item in decisions if item.get("decision") == "keep"]
        for left, right in zip(kept_speech, kept_speech[1:]):
            gap_start, gap_end = float(left["end_seconds"]), float(right["start_seconds"])
            if gap_end - gap_start > 1.5:
                cuts.append((gap_start + 0.3, gap_end - 0.3))
    cuts = _merged_ranges(cuts)
    kept = []
    cursor = 0.0
    for start, end in cuts:
        if start - cursor >= 0.08:
            kept.append((cursor, start))
        cursor = max(cursor, end)
    if duration - cursor >= 0.08:
        kept.append((cursor, duration))
    return kept


def review_plan(project_dir: Path) -> dict[str, Any]:
    """Expose exactly what export will remove, including legacy implicit pauses."""
    manifest = _read_json(project_dir / "cleaner.json")
    plan = _read_json(project_dir / PLAN_PATH)
    duration = _duration(project_dir)
    from .cleaner_transcribe import STRATEGY
    if plan.get('transcript_strategy') and plan['transcript_strategy'] != STRATEGY:
        plan['requires_reanalysis'] = True
    if not plan.get("transcript_strategy"):
        from .cleaner_transcribe import quality_warnings
        try:
            original = _read_json(project_dir / "artifacts/transcript-artifact.v1.json")
            warnings = quality_warnings(original.get("words", []))
        except CleanerError:
            warnings = []
        plan["requires_reanalysis"] = bool(warnings)
        plan["quality_warnings"] = warnings
    if not plan.get("review_version"):
        speech = sorted(plan["decisions"], key=lambda item: item["start_seconds"])
        next_id = max((int(item["segment_id"].split("_")[-1]) for item in speech), default=0)
        if manifest.get("cleanup", {}).get("remove_dead_air", True):
            gaps = [(float(left["end_seconds"]), float(right["start_seconds"])) for left, right in zip(speech, speech[1:])]
            if plan.get("transcript_strategy") and speech:
                gaps = [(0.0, float(speech[0]["start_seconds"])), *gaps, (float(speech[-1]["end_seconds"]), duration)]
            for gap_start, gap_end in gaps:
                start, end = gap_start + 0.3, gap_end - 0.3
                if end - start <= 0.9:
                    continue
                next_id += 1
                plan["decisions"].append({
                    "segment_id": f"segment_{next_id:06d}", "start_seconds": start, "end_seconds": end,
                    "text": "Pause between speech sections", "proposed": "cut", "decision": "cut",
                    "category": "pause", "reason": "Shorten this long gap, leaving 0.3 seconds beside each speech section. Listen and restore it if the pause is intentional.",
                })
        plan["decisions"].sort(key=lambda item: item["start_seconds"])
        plan["review_version"] = 1
    if plan.get("requires_reanalysis"):
        # Bad alignment can label actual speech as a gap. Never shorten it silently.
        for item in plan["decisions"]:
            if item.get("category") == "pause" and not item.get("reviewed"):
                item["decision"] = "keep"
                item["needs_review"] = True
    if plan.get('review_version') != 2:
        # Cover the whole source, not just recognized words. Legacy renderer-only
        # margins become separate restorable rows; new transcripts need no margins.
        legacy_ranges = kept_ranges(plan, duration) if plan.get('transcript_strategy') != STRATEGY else None
        original = sorted(plan['decisions'], key=lambda d:d['start_seconds'])
        next_id = max((int(d['segment_id'].split('_')[-1]) for d in original),default=0)
        cursor = 0.
        for item in [*original, {'start_seconds':duration,'end_seconds':duration}]:
            end = min(duration, float(item['start_seconds']))
            if end > cursor:
                boundaries = sorted({cursor,end,*[v for interval in (legacy_ranges or []) for v in interval if cursor < v < end]})
                for left,right in zip(boundaries,boundaries[1:]):
                    removed = legacy_ranges is not None and not any(a <= (left+right)/2 < b for a,b in legacy_ranges)
                    next_id += 1
                    plan['decisions'].append({
                        'segment_id':f'segment_{next_id:06d}', 'start_seconds':left, 'end_seconds':right,
                        'text':'Previous automatic cut margin' if removed else 'Between sections — original audio',
                        'proposed':'cut' if removed else 'keep', 'decision':'cut' if removed else 'keep',
                        'category':'cut_margin' if removed else 'gap',
                        'reason':'This interval is now explicit. Play it and restore or remove it independently. No other audio is trimmed behind the scenes.'})
            cursor = max(cursor,float(item['end_seconds']))
        plan['decisions'].sort(key=lambda d:d['start_seconds'])
        plan['review_version'] = 2
    pending = plan.pop('_pending_reanalysis_overrides', [])
    if pending:
        remaining, conflicts = _reconcile_overrides(pending, plan['decisions'])
        plan.setdefault('reanalysis_conflicts', []).extend(conflicts)
        if remaining:
            plan['unresolved_reanalysis_overrides'] = [
                {'previous_segment_id': item.get('segment_id'),
                 'text': item.get('text'), 'decision': item.get('decision'),
                 'start_seconds': item.get('start_seconds'), 'end_seconds': item.get('end_seconds'),
                 'kind': item.get('_reanalysis_match', 'unmatched_override')}
                for item in remaining
            ]
            # Do not silently discard an unmatched choice. Require a fresh
            # review of the overlapping audio (or the whole plan if unmappable).
            for old in remaining:
                affected = [item for item in plan['decisions']
                            if float(item['start_seconds']) < float(old.get('end_seconds', 0))
                            and float(item['end_seconds']) > float(old.get('start_seconds', 0))]
                for item in affected or plan['decisions']:
                    item['needs_review'] = True
                    item['reviewed'] = False
                    item['override_conflict'] = 'previous_choice_unmatched'
    if not plan.get('join_review_version'):
        # A doubtful word ending at a split makes BOTH takes uncertain. The
        # following take must not look trustworthy just because its words scored
        # well: it may still contain audio belonging to the preceding take.
        ordered = sorted(plan['decisions'], key=lambda d: d['start_seconds'])
        for left, right in zip(ordered, ordered[1:]):
            boundary = left['end_seconds']
            if abs(boundary - right['start_seconds']) > .001:
                continue
            if any(_warning_at_boundary(w, boundary) for w in plan.get('quality_warnings', [])):
                for item in (left, right):
                    if not item.get('timing_adjusted'):
                        item['needs_review'] = True
                        item['reviewed'] = False
                        item['join_warning'] = True
        plan['join_review_version'] = 1
    ranges = kept_ranges(plan, duration)
    output_duration = sum(end - start for start, end in ranges)
    plan.setdefault("summary", {}).update({
        "proposed_cuts": sum(item.get("proposed") == "cut" for item in plan["decisions"]),
        "applied_cuts": sum(item["decision"] == "cut" for item in plan["decisions"]),
        "speech_cuts": sum(item["decision"] == "cut" and item.get("category") not in {"pause", "gap", "cut_margin"} for item in plan["decisions"]),
        "pause_cuts": sum(item["decision"] == "cut" and item.get("category") == "pause" for item in plan["decisions"]),
        "source_seconds": duration, "output_seconds": output_duration,
        "removed_seconds": max(0, duration - output_duration),
        "unreviewed_uncertain": sum(bool(item.get("needs_review")) and not item.get("reviewed") for item in plan["decisions"]),
    })
    plan["kept_ranges"] = ranges
    _atomic_json(project_dir / PLAN_PATH, plan)
    return plan


def _duration(project_dir: Path) -> float:
    ingest = _read_json(project_dir / "artifacts" / "ingest-artifact.v1.json")
    value = float(ingest["container"]["duration_seconds"])
    if not math.isfinite(value) or value <= 0:
        raise CleanerError("The inspected source duration is invalid")
    return value


def preview_source(project_dir: Path) -> Path:
    """Cache a browser-compatible viewing copy; export always uses the source."""
    manifest = _read_json(project_dir / "cleaner.json")
    source = Path(manifest["source"]["uri"]).expanduser().resolve()
    stat = source.stat()
    identity = hashlib.sha256(f"{source}:{stat.st_size}:{stat.st_mtime_ns}:preview-v1".encode()).hexdigest()[:20]
    output = project_dir / "artifacts" / f"cleaner-preview-{identity}.mp4"
    if output.is_file() and output.stat().st_size > 0:
        return output
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.{os.getpid()}.tmp.mp4")
    try:
        completed = subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(temporary),
        ], text=True, capture_output=True, check=False, timeout=3600)
        if completed.returncode != 0 or not temporary.is_file() or not temporary.stat().st_size:
            raise CleanerError("Could not prepare the local playback copy. Check free disk space and FFmpeg.")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return output


def cut_filter_graph(ranges):
    filters, inputs = [], []
    for index, (start, end) in enumerate(ranges):
        filters.extend([f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[v{index}]",
                        f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[a{index}]"])
        inputs.append(f"[v{index}][a{index}]")
    return ';'.join([*filters, f"{''.join(inputs)}concat=n={len(ranges)}:v=1:a=1[v][a]"])


def preview_edit(project_dir: Path) -> Path:
    """Render actual edited media for review, without final-export approval gates."""
    plan = review_plan(project_dir)
    ranges = plan['kept_ranges']
    if not ranges:
        raise CleanerError('Keep some audio before previewing the cleaned edit.')
    source = preview_source(project_dir)
    stat = source.stat()
    key = hashlib.sha256(json.dumps([str(source),stat.st_size,stat.st_mtime_ns,ranges,'edit-preview-v1']).encode()).hexdigest()[:24]
    output = project_dir/'artifacts'/f'cleaner-edit-{key}.mp4'
    if output.is_file() and output.stat().st_size:
        return output
    temporary = output.with_name(f'.{output.stem}.{os.getpid()}.tmp.mp4')
    script = output.with_suffix('.filter.txt')
    try:
        script.write_text(cut_filter_graph(ranges),encoding='utf-8')
        completed = subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-i',str(source),
            '-filter_complex_script',str(script),'-map','[v]','-map','[a]',
            '-c:v','libx264','-preset','ultrafast','-crf','25','-pix_fmt','yuv420p',
            '-c:a','aac','-b:a','128k','-movflags','+faststart',str(temporary)],
            text=True,capture_output=True,check=False,timeout=3600)
        if completed.returncode or not temporary.is_file() or not temporary.stat().st_size:
            raise CleanerError('Could not create the cleaned preview. Your saved choices are unchanged.')
        os.replace(temporary,output)
    finally:
        temporary.unlink(missing_ok=True)
        script.unlink(missing_ok=True)
    return output


def render_plan(
    project_dir: Path,
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> Path:
    project_dir = project_dir.expanduser().resolve()
    manifest = _read_json(project_dir / "cleaner.json")
    plan = review_plan(project_dir)
    if plan.get("requires_reanalysis"):
        raise CleanerError("The earlier transcript has unreliable timings. Analyze again before export to recover missing takes.")
    if plan["summary"].get("unreviewed_uncertain"):
        raise CleanerError("Listen to the flagged sections and confirm Keep or Remove before export.")
    if not any(item.get("decision") == "keep" and item.get("category") not in {"pause", "gap", "cut_margin", "untranscribed"} for item in plan["decisions"]):
        raise CleanerError("Keep at least one speech section before export")
    source = Path(manifest["source"]["uri"]).expanduser().resolve()
    duration = _duration(project_dir)
    ranges = kept_ranges(plan, duration, remove_dead_air=bool(manifest.get("cleanup", {}).get("remove_dead_air", True)))
    if not ranges:
        raise CleanerError("Review removed the entire recording; keep at least one segment before export")
    output = (project_dir / OUTPUT_PATH).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    graph = cut_filter_graph(ranges)
    script_path = project_dir / ".cleaner-filter.txt"
    script_path.write_text(graph, encoding="utf-8")
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp.mp4")
    try:
        command = [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-filter_complex_script", str(script_path), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(temporary),
        ]
        completed = run(command, text=True, capture_output=True, check=False)
        if completed.returncode != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
            detail = " ".join((completed.stderr or completed.stdout or "ffmpeg failed").split())[:800]
            raise CleanerError(f"Cleaner export failed: {detail}")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
        script_path.unlink(missing_ok=True)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("analyze", "render", "review", "preview", "preview-edit", "prepare-transcript", "waveform"):
        command = sub.add_parser(name)
        command.add_argument("--project", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'waveform':
            from .audio_waveform import source_waveform
            print(json.dumps({'waveform': source_waveform(Path(args.project).expanduser().resolve())}), flush=True)
        elif args.command == "analyze":
            from .cleaner_transcribe import prepare_transcript
            prepare_transcript(Path(args.project), os.environ.get("VIDMYO_CLEANER_MODEL_CACHE"),
                               progress=lambda event: print(json.dumps({"event": "progress", **event}), flush=True))
            plan = build_plan(Path(args.project), progress=lambda event: print(json.dumps({"event": "progress", **event}), flush=True))
            print(json.dumps({"event": "completed", "artifact": PLAN_PATH.as_posix(), "summary": plan["summary"]}), flush=True)
        elif args.command == "prepare-transcript":
            from .cleaner_transcribe import prepare_transcript
            transcript = prepare_transcript(Path(args.project), os.environ.get("VIDMYO_CLEANER_MODEL_CACHE"),
                               progress=lambda event: print(json.dumps({"event": "progress", **event}), flush=True))
            print(json.dumps({"event": "completed", "segments": len(transcript["segments"])}), flush=True)
        elif args.command in {"preview", "preview-edit"}:
            output = (preview_edit if args.command == 'preview-edit' else preview_source)(Path(args.project).expanduser().resolve())
            print(json.dumps({"event": "completed", "preview": str(output)}), flush=True)
        elif args.command == "review":
            plan = review_plan(Path(args.project).expanduser().resolve())
            print(json.dumps({"event": "completed", "plan": plan}), flush=True)
        else:
            output = render_plan(Path(args.project))
            print(json.dumps({"event": "completed", "output": output.relative_to(Path(args.project).resolve()).as_posix()}), flush=True)
        return 0
    except CleanerError as exc:
        print(json.dumps({"event": "error", "message": str(exc)[:1000]}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
