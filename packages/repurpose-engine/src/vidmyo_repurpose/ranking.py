"""Explainable transcript-only candidate ranking, deduplication, and shortlisting."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from jsonschema import Draft202012Validator

from .candidate_providers import (
    CandidateProvider,
    ProviderError,
    make_candidate_provider,
    normalize_model_id,
)
from .candidates import _atomic_json
from .contracts import ContractValidationError, RANKING_ARTIFACT_VERSION, validate_document

ENGINE_VERSION = "0.1.0"
RANKING_SCHEMA_VERSION = "ranking-artifact.v1"
PROMPT_VERSION = "ranking-prompt.v1"
SCORING_VERSION = "transcript-scoring.v1"
DEDUPE_VERSION = "candidate-dedupe.v1"
CACHE_VERSION = 1
RANKING_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "ranking-artifact.v1.json"
RANKING_CACHE_RELATIVE_PATH = Path(".cache") / "ranking" / "v1"
SEMANTIC_COMPONENTS = (
    "hook_strength",
    "standalone_coherence",
    "information_value_novelty",
    "narrative_arc_payoff",
    "context_independence",
)
WEIGHTS = {
    "hook_strength": 0.20,
    "standalone_coherence": 0.20,
    "information_value_novelty": 0.15,
    "narrative_arc_payoff": 0.15,
    "context_independence": 0.15,
    "duration_fitness": 0.10,
    "evidence_quality": 0.05,
}
HARD_GATE_THRESHOLD = 40.0
TEMPORAL_IOU_THRESHOLD = 0.70
TEMPORAL_CONTAINMENT_THRESHOLD = 0.85
SEMANTIC_SIMILARITY_THRESHOLD = 0.80
REPEATED_TOPIC_PENALTY = 12.0
NEARBY_TIME_PENALTY = 8.0
MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (0.0, 1.0, 2.0)

_WORD_ID = re.compile(r"^word_[0-9]{6}$")
_TOKEN = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class RankingError(Exception):
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
class RankingResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> RankingError:
    return RankingError(
        code,
        message[:1000],
        (
            "The completed transcript and candidate artifact, validated ranking window caches, "
            "and any earlier valid ranking artifact were preserved; no partial final artifact replaced them."
        ),
        next_action,
    )


def cancellation_error() -> RankingError:
    return _error(
        "ranking_cancelled",
        "Candidate ranking was cancelled at a safe boundary.",
        "Retry the same request to reuse validated per-window scoring caches.",
    )


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _feedback(exc: Exception) -> str:
    text = " ".join(str(exc).split())
    secret = os.environ.get("OPENROUTER_API_KEY")
    if secret:
        text = text.replace(secret, "[REDACTED]")
    return text[:400]


def _inside_project(project_dir: Path, relative: str) -> Path:
    path = (project_dir / relative).resolve()
    try:
        path.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise _error(
            "ranking_input_invalid",
            "A ranking input path escapes the selected project.",
            "Use current project artifact paths and retry.",
        ) from exc
    return path


def _descriptor(request: Mapping[str, Any], kind: str, expected_path: str) -> str:
    matches = [
        item for item in request["input_artifacts"]
        if item["kind"] == kind and item.get("version") == 1
    ]
    if len(matches) != 1 or matches[0]["path"] != expected_path:
        raise _error(
            "ranking_input_invalid",
            f"The request must name the project's completed version-1 {kind}.",
            "Rebuild the request from the current completed project stages and retry.",
        )
    return matches[0]["path"]


def _load_inputs(request: dict[str, Any]) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any]]:
    project_dir = Path(request["project_dir"]).expanduser().resolve()
    try:
        manifest = validate_document(
            "manifest", json.loads((project_dir / "repurpose.json").read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "ranking_project_invalid",
            f"The Repurpose project manifest is missing or invalid: {_feedback(exc)}.",
            "Repair the project and complete candidate generation before ranking.",
        ) from exc
    candidate_stage = manifest["stages"]["generate_candidates"]
    transcript_stage = manifest["stages"]["transcribe"]
    if candidate_stage["state"] != "completed" or not candidate_stage["artifact"]:
        raise _error(
            "ranking_candidates_not_completed",
            "The generate_candidates stage is not completed with an artifact.",
            "Complete candidate generation before ranking.",
        )
    if transcript_stage["state"] != "completed" or not transcript_stage["artifact"]:
        raise _error(
            "ranking_transcript_not_completed",
            "The transcribe stage is not completed with an artifact.",
            "Complete transcription and candidate generation before ranking.",
        )
    candidate_rel = _descriptor(request, "candidate_artifact", candidate_stage["artifact"])
    transcript_rel = _descriptor(request, "transcript_artifact", transcript_stage["artifact"])
    try:
        candidates = validate_document(
            "candidate_artifact",
            json.loads(_inside_project(project_dir, candidate_rel).read_text(encoding="utf-8")),
        )
        transcript = validate_document(
            "transcript_artifact",
            json.loads(_inside_project(project_dir, transcript_rel).read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "ranking_input_invalid",
            f"A completed ranking input artifact is missing or invalid: {_feedback(exc)}.",
            "Recreate valid transcript and candidate artifacts, then retry.",
        ) from exc
    fingerprint = manifest["source"]["fingerprint"]
    if not fingerprint or transcript["source"]["fingerprint"] != fingerprint:
        raise _error(
            "ranking_input_stale",
            "The transcript source fingerprint does not match the current project source.",
            "Rerun ingest, transcription, and candidate generation for the current source.",
        )
    if candidates["source"] != {
        "fingerprint": fingerprint,
        "transcript_cache_key": transcript["cache_key"],
    }:
        raise _error(
            "ranking_input_stale",
            "The candidate artifact does not match the current source and transcript.",
            "Rerun candidate generation from the current completed transcript.",
        )
    if candidates["outcome"] != "candidates_generated" or not candidates["candidates"]:
        raise _error(
            "ranking_candidates_empty",
            "The completed candidate artifact contains no candidate suggestions to rank.",
            "Generate at least one transcript-grounded candidate before ranking.",
        )
    if candidates["generation_settings"]["requested_clip_count"] != manifest["requested_clip_count"]:
        raise _error(
            "ranking_input_stale",
            "The candidate artifact requested clip count does not match the current project.",
            "Regenerate candidates using the current project settings.",
        )
    return project_dir, manifest, transcript, candidates


def duration_fitness(duration_seconds: float) -> float:
    if duration_seconds < 20 or duration_seconds > 120:
        raise ValueError("duration must be between 20 and 120 seconds")
    if duration_seconds < 30:
        return round(60 + (duration_seconds - 20) * 4, 3)
    if duration_seconds <= 90:
        return 100.0
    return round(100 - (duration_seconds - 90) * (40 / 30), 3)


def evidence_quality(candidate: Mapping[str, Any], transcript: Mapping[str, Any]) -> float:
    words = transcript["words"]
    positions = {word["id"]: index for index, word in enumerate(words)}
    span = candidate["proposed_span"]
    first, last = span["first_word_id"], span["last_word_id"]
    if first not in positions or last not in positions or positions[last] < positions[first]:
        raise ValueError("candidate proposed span has unknown or reversed transcript words")
    confidences = [
        word["confidence"] for word in words[positions[first]:positions[last] + 1]
        if word["confidence"] is not None
    ]
    return round(sum(confidences) / len(confidences) * 100, 3) if confidences else 50.0


def _component_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["score", "reason", "evidence_word_ids"],
        "properties": {
            "score": {"type": "number", "minimum": 0, "maximum": 100},
            "reason": {"type": "string", "minLength": 1},
            "evidence_word_ids": {
                "type": "array", "minItems": 1, "uniqueItems": True,
                "items": {"type": "string", "pattern": "^word_[0-9]{6}$"},
            },
        },
    }


def _response_schema(candidate_count: int) -> dict[str, Any]:
    properties = {name: _component_schema() for name in SEMANTIC_COMPONENTS}
    properties.update({
        "candidate_id": {"type": "string", "pattern": "^clip_[0-9]{3,}$"},
        "topic_label": {"type": "string", "minLength": 1, "maxLength": 80},
        "semantic_claim": {"type": "string", "minLength": 1, "maxLength": 500},
    })
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["scores"],
        "properties": {
            "scores": {
                "type": "array", "minItems": candidate_count, "maxItems": candidate_count,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["candidate_id", *SEMANTIC_COMPONENTS, "topic_label", "semantic_claim"],
                    "properties": properties,
                },
            }
        },
    }


def _window_request(
    candidates: list[Mapping[str, Any]],
    transcript: Mapping[str, Any],
    feedback: str | None,
) -> dict[str, Any]:
    word_by_id = {word["id"]: word for word in transcript["words"]}
    logical_candidates = []
    for candidate in candidates:
        first = int(candidate["proposed_span"]["first_word_id"].split("_")[1])
        last = int(candidate["proposed_span"]["last_word_id"].split("_")[1])
        word_ids = [f"word_{index:06d}" for index in range(first, last + 1)]
        logical_candidates.append({
            "candidate_id": candidate["id"],
            "title": candidate["title"],
            "hook": candidate["hook"],
            "summary": candidate["summary"],
            "words": [
                {"id": word_id, "text": word_by_id[word_id]["text"]}
                for word_id in word_ids if word_id in word_by_id
            ],
        })
    logical: dict[str, Any] = {
        "task": "score_transcript_candidates",
        "prompt_version": PROMPT_VERSION,
        "instructions": (
            "Score only the five named semantic components from the supplied transcript. "
            "For every component cite exact supporting word IDs inside that candidate. "
            "Return a concise normalized topic label and a factual semantic claim. "
            "Do not predict virality, approve, reject, rank, deduplicate, repair, or select candidates."
        ),
        "candidates": logical_candidates,
    }
    if feedback:
        logical["validation_feedback"] = feedback
    return {
        "schema_name": "vidmyo_candidate_ranking_v1",
        "schema": _response_schema(len(candidates)),
        "messages": [
            {"role": "system", "content": "Return only strict schema-valid transcript-grounded JSON."},
            {"role": "user", "content": json.dumps(logical, separators=(",", ":"))},
        ],
    }


def _schema_errors(schema: dict[str, Any], value: Any) -> list[str]:
    errors = sorted(
        Draft202012Validator(schema).iter_errors(value),
        key=lambda error: list(error.absolute_path),
    )
    result = []
    for error in errors[:3]:
        path = ".".join(str(part) for part in error.absolute_path)
        result.append(f"{path}: {error.message}" if path else error.message)
    return result


def _normalize_topic(value: str) -> str:
    normalized = "-".join(_TOKEN.findall(value.lower()))[:80]
    if not normalized:
        raise ValueError("topic_label: must contain letters or numbers")
    return normalized


def validate_window_scores(
    document: Any,
    candidates: list[Mapping[str, Any]],
    transcript: Mapping[str, Any],
) -> list[dict[str, Any]]:
    errors = _schema_errors(_response_schema(len(candidates)), document)
    if errors:
        raise ValueError("; ".join(errors))
    expected = {candidate["id"]: candidate for candidate in candidates}
    positions = {word["id"]: index for index, word in enumerate(transcript["words"])}
    found: dict[str, dict[str, Any]] = {}
    for item in document["scores"]:
        candidate_id = item["candidate_id"]
        if candidate_id not in expected or candidate_id in found:
            raise ValueError("candidate_id: missing, unknown, or duplicated candidate")
        candidate = expected[candidate_id]
        first = positions.get(candidate["proposed_span"]["first_word_id"])
        last = positions.get(candidate["proposed_span"]["last_word_id"])
        if first is None or last is None:
            raise ValueError("candidate proposed span references unknown transcript words")
        normalized: dict[str, Any] = {"candidate_id": candidate_id}
        for name in SEMANTIC_COMPONENTS:
            component = item[name]
            evidence = component["evidence_word_ids"]
            if any(
                word_id not in positions or positions[word_id] < first or positions[word_id] > last
                for word_id in evidence
            ):
                raise ValueError(f"{candidate_id}.{name}.evidence_word_ids: outside candidate span")
            if evidence != sorted(evidence, key=positions.__getitem__):
                raise ValueError(f"{candidate_id}.{name}.evidence_word_ids: must be transcript ordered")
            reason = " ".join(component["reason"].split())
            if not reason:
                raise ValueError(f"{candidate_id}.{name}.reason: must not be empty")
            normalized[name] = {
                "score": round(float(component["score"]), 3),
                "reason": reason,
                "evidence_word_ids": list(evidence),
            }
        claim = " ".join(item["semantic_claim"].split())
        if not claim:
            raise ValueError("semantic_claim: must not be empty")
        normalized["topic_label"] = _normalize_topic(item["topic_label"])
        normalized["semantic_claim"] = claim
        found[candidate_id] = normalized
    if set(found) != set(expected):
        raise ValueError("candidate_id: response must contain every candidate exactly once")
    return [found[candidate["id"]] for candidate in candidates]


def _reject_secret(value: Any) -> None:
    secret = os.environ.get("OPENROUTER_API_KEY")
    if secret and secret in json.dumps(value, separators=(",", ":")):
        raise ValueError("provider output contained a credential value and was rejected")


def _call_with_retry(
    *,
    target: str,
    provider: CandidateProvider,
    candidates: list[Mapping[str, Any]],
    transcript: Mapping[str, Any],
    progress: Callable[[dict[str, Any]], None],
    cancelled: Callable[[], bool],
    delay: Callable[[float], None],
) -> list[dict[str, Any]]:
    feedback: str | None = None
    last_error: Exception = ValueError("unknown provider failure")
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if cancelled():
            raise cancellation_error()
        progress({
            "phase": "provider_attempt", "target": target, "attempt": attempt,
            "max_attempts": MAX_ATTEMPTS, "provider": provider.provider_id,
            "model": provider.model_id, "cache_hit": False,
            "message": f"requesting structured ranking scores for {target}",
        })
        try:
            result = provider.structured(_window_request(candidates, transcript, feedback))
            _reject_secret(result)
            return validate_window_scores(result, candidates, transcript)
        except ProviderError as exc:
            if not exc.retryable:
                raise _error(
                    exc.code,
                    f"Ranking failed for {target} using {provider.provider_id}/{provider.model_id}: {_feedback(exc)}.",
                    "Correct provider access, credit, model, or structured-output support and retry.",
                ) from exc
            last_error = exc
            feedback = _feedback(exc)
        except (ValueError, ContractValidationError) as exc:
            last_error = exc
            feedback = _feedback(exc)
        if attempt == MAX_ATTEMPTS:
            raise _error(
                "ranking_provider_retries_exhausted",
                f"Ranking exhausted {MAX_ATTEMPTS} attempts for {target} using "
                f"{provider.provider_id}/{provider.model_id}: {_feedback(last_error)}.",
                "Retry the same request to reuse preserved valid window scores.",
            ) from last_error
        progress({
            "phase": "retry_wait", "target": target, "attempt": attempt,
            "next_attempt": attempt + 1, "provider": provider.provider_id,
            "model": provider.model_id, "cache_hit": False,
            "message": f"retrying {target} after structured-output failure",
        })
        if cancelled():
            raise cancellation_error()
        delay(RETRY_DELAYS_SECONDS[attempt])
    raise AssertionError("unreachable retry state")


def _load_cache(path: Path, key: str) -> Any | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        not isinstance(document, dict)
        or document.get("cache_version") != CACHE_VERSION
        or document.get("cache_key") != key
    ):
        return None
    return document.get("result")


def _save_cache(path: Path, key: str, result: Any) -> None:
    try:
        _atomic_json(path, {
            "cache_version": CACHE_VERSION,
            "kind": "ranking_window",
            "cache_key": key,
            "result": result,
        })
    except OSError as exc:
        raise _error(
            "ranking_cache_write_failed",
            f"A validated ranking window could not be cached atomically: {_feedback(exc)}.",
            "Check project permissions and free disk space, then retry.",
        ) from exc


def _score_candidate(
    candidate: Mapping[str, Any],
    judgment: Mapping[str, Any],
    transcript: Mapping[str, Any],
) -> dict[str, Any]:
    components = {name: dict(judgment[name]) for name in SEMANTIC_COMPONENTS}
    duration = candidate["proposed_span"]["end_seconds"] - candidate["proposed_span"]["start_seconds"]
    components["duration_fitness"] = {"score": duration_fitness(duration), "method": "deterministic"}
    components["evidence_quality"] = {
        "score": evidence_quality(candidate, transcript), "method": "deterministic"
    }
    total = round(sum(components[name]["score"] * WEIGHTS[name] for name in WEIGHTS), 1)
    exclusions = []
    if components["standalone_coherence"]["score"] < HARD_GATE_THRESHOLD:
        exclusions.append("Standalone coherence is below the 40-point shortlist gate.")
    if components["context_independence"]["score"] < HARD_GATE_THRESHOLD:
        exclusions.append("Context independence is below the 40-point shortlist gate.")
    return {
        "candidate": dict(candidate),
        "topic_label": judgment["topic_label"],
        "semantic_claim": judgment["semantic_claim"],
        "components": components,
        "clip_potential": total,
        "overall_rank": 0,
        "hard_gate": {"passed": not exclusions, "exclusion_reasons": exclusions},
        "shortlist_exclusion_reasons": list(exclusions),
        "duplicate_group_id": None,
        "near_duplicate_of": None,
        "diversity": {"adjusted_score": None, "repeated_topic_penalty": 0.0, "nearby_time_penalty": 0.0},
        "shortlist_order": None,
        "recommended": False,
    }


def _temporal_duplicate(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    a, b = left["candidate"]["proposed_span"], right["candidate"]["proposed_span"]
    intersection = max(0.0, min(a["end_seconds"], b["end_seconds"]) - max(a["start_seconds"], b["start_seconds"]))
    duration_a = a["end_seconds"] - a["start_seconds"]
    duration_b = b["end_seconds"] - b["start_seconds"]
    union = duration_a + duration_b - intersection
    iou = intersection / union if union else 1.0
    containment = intersection / min(duration_a, duration_b) if min(duration_a, duration_b) else 1.0
    return iou >= TEMPORAL_IOU_THRESHOLD or containment >= TEMPORAL_CONTAINMENT_THRESHOLD


def _claim_similarity(left: str, right: str) -> float:
    left_tokens, right_tokens = set(_TOKEN.findall(left.lower())), set(_TOKEN.findall(right.lower()))
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _semantic_duplicate(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return (
        left["topic_label"] == right["topic_label"]
        and _claim_similarity(left["semantic_claim"], right["semantic_claim"])
        >= SEMANTIC_SIMILARITY_THRESHOLD
    )


def group_duplicates(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parent = list(range(len(entries)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        a, b = find(left), find(right)
        if a != b:
            parent[max(a, b)] = min(a, b)

    for left in range(len(entries)):
        for right in range(left + 1, len(entries)):
            if _temporal_duplicate(entries[left], entries[right]) or _semantic_duplicate(
                entries[left], entries[right]
            ):
                union(left, right)
    groups: dict[int, list[dict[str, Any]]] = {}
    for index, entry in enumerate(entries):
        groups.setdefault(find(index), []).append(entry)
    output = []
    group_number = 0
    for members in sorted(
        groups.values(), key=lambda group: min(item["candidate"]["id"] for item in group)
    ):
        if len(members) == 1:
            continue
        group_number += 1
        leader = sorted(
            members, key=lambda item: (-item["clip_potential"], item["candidate"]["id"])
        )[0]
        group_id = f"duplicate_group_{group_number:03d}"
        member_ids = sorted(item["candidate"]["id"] for item in members)
        for member in members:
            member["duplicate_group_id"] = group_id
            if member is not leader:
                member["near_duplicate_of"] = leader["candidate"]["id"]
                member["shortlist_exclusion_reasons"].append(
                    f"Near-duplicate of {leader['candidate']['id']}; retained for manual review."
                )
        output.append({
            "id": group_id,
            "leader_candidate_id": leader["candidate"]["id"],
            "member_candidate_ids": member_ids,
        })
    return output


def select_shortlist(entries: list[dict[str, Any]], count: int, source_duration: float) -> list[str]:
    eligible = [
        entry for entry in entries
        if entry["hard_gate"]["passed"] and entry["near_duplicate_of"] is None
    ]
    selected: list[dict[str, Any]] = []
    nearby_threshold = max(180.0, 0.05 * source_duration)
    while eligible and len(selected) < count:
        choices = []
        for entry in eligible:
            repeated = any(item["topic_label"] == entry["topic_label"] for item in selected)
            midpoint = sum(
                entry["candidate"]["proposed_span"][key]
                for key in ("start_seconds", "end_seconds")
            ) / 2
            nearby = any(
                abs(midpoint - sum(
                    item["candidate"]["proposed_span"][key]
                    for key in ("start_seconds", "end_seconds")
                ) / 2) <= nearby_threshold
                for item in selected
            )
            repeated_penalty = REPEATED_TOPIC_PENALTY if repeated else 0.0
            nearby_penalty = NEARBY_TIME_PENALTY if nearby else 0.0
            adjusted = round(entry["clip_potential"] - repeated_penalty - nearby_penalty, 1)
            choices.append((
                adjusted, entry["candidate"]["id"], entry, repeated_penalty, nearby_penalty,
            ))
        _, _, winner, repeated_penalty, nearby_penalty = sorted(
            choices, key=lambda item: (-item[0], item[1])
        )[0]
        winner["recommended"] = True
        winner["shortlist_order"] = len(selected) + 1
        winner["diversity"] = {
            "adjusted_score": round(
                winner["clip_potential"] - repeated_penalty - nearby_penalty, 1
            ),
            "repeated_topic_penalty": repeated_penalty,
            "nearby_time_penalty": nearby_penalty,
        }
        selected.append(winner)
        eligible.remove(winner)
    return [entry["candidate"]["id"] for entry in selected]


def _matching_final(
    path: Path,
    key: str,
    candidate_artifact: Mapping[str, Any],
) -> dict[str, Any] | None:
    try:
        artifact = validate_document(
            "ranking_artifact", json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError):
        return None
    embedded = sorted(
        (item["candidate"] for item in artifact["candidates"]), key=lambda item: item["id"]
    )
    expected_candidates = sorted(candidate_artifact["candidates"], key=lambda item: item["id"])
    matches = (
        artifact["cache_key"] == key
        and artifact["source"]["candidate_cache_key"] == candidate_artifact["cache_key"]
        and artifact["source"]["candidate_content_hash"] == _canonical_hash(expected_candidates)
        and artifact["source"]["candidate_count"] == len(candidate_artifact["candidates"])
        and embedded == expected_candidates
    )
    return artifact if matches else None


def write_ranking_artifact(
    project_dir: Path,
    artifact: dict[str, Any],
    *,
    replace: Callable[
        [str | bytes | os.PathLike[str], str | bytes | os.PathLike[str]], None
    ] = os.replace,
) -> Path:
    validate_document("ranking_artifact", artifact)
    path = (project_dir / RANKING_ARTIFACT_RELATIVE_PATH).resolve()
    try:
        path.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise RuntimeError("ranking artifact path escaped the project directory") from exc
    return _atomic_json(path, artifact, replace=replace)


def rank_candidates(
    request: dict[str, Any],
    *,
    provider: CandidateProvider | None = None,
    provider_factory: Callable[..., CandidateProvider] = make_candidate_provider,
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    retry_delay: Callable[[float], None] = time.sleep,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    writer: Callable[[Path, dict[str, Any]], Path] = write_ranking_artifact,
) -> RankingResult:
    progress({
        "phase": "validating_inputs", "fraction": 0.02, "percent": 2,
        "cache_hit": False, "message": "validating completed transcript and candidates",
    })
    project_dir, manifest, transcript, candidate_artifact = _load_inputs(request)
    options = request["options"]
    if not isinstance(options, dict):
        raise ContractValidationError("options: must be an object")
    unknown = sorted(set(options) - {"model"})
    if unknown:
        raise ContractValidationError(f"options.{unknown[0]}: unsupported ranking option")
    provider_id = candidate_artifact["provider"]["id"]
    try:
        model_id = normalize_model_id(
            options.get("model", candidate_artifact["provider"]["model"])
        )
    except ValueError as exc:
        raise ContractValidationError(str(exc)) from exc
    settings = {
        "requested_clip_count": manifest["requested_clip_count"],
        "temperature": 0.0,
        "structured_output": True,
        "streaming": False,
    }
    versions = {
        "schema": RANKING_SCHEMA_VERSION,
        "prompt": PROMPT_VERSION,
        "scoring": SCORING_VERSION,
        "dedupe": DEDUPE_VERSION,
    }
    thresholds = {
        "hard_gate": HARD_GATE_THRESHOLD,
        "temporal_iou": TEMPORAL_IOU_THRESHOLD,
        "temporal_containment": TEMPORAL_CONTAINMENT_THRESHOLD,
        "semantic_similarity": SEMANTIC_SIMILARITY_THRESHOLD,
        "repeated_topic_penalty": REPEATED_TOPIC_PENALTY,
        "nearby_time_penalty": NEARBY_TIME_PENALTY,
        "nearby_time_seconds": max(180.0, 0.05 * transcript["duration_seconds"]),
    }
    key = _canonical_hash({
        "candidate_cache_key": candidate_artifact["cache_key"],
        "candidate_content": candidate_artifact["candidates"],
        "transcript_cache_key": transcript["cache_key"],
        "provider": provider_id, "model": model_id,
        "versions": versions, "weights": WEIGHTS,
        "thresholds": thresholds, "settings": settings,
    })
    artifact_path = project_dir / RANKING_ARTIFACT_RELATIVE_PATH
    cached_final = _matching_final(artifact_path, key, candidate_artifact)
    if cached_final is not None:
        progress({
            "phase": "final_cache_hit", "fraction": 1.0, "percent": 100,
            "cache_hit": True, "message": "reusing matching validated ranking artifact",
        })
        return RankingResult(cached_final, artifact_path, True)
    if cancelled():
        raise cancellation_error()
    if provider is None:
        try:
            provider = provider_factory(provider_id, model_id)
        except ProviderError as exc:
            raise _error(
                exc.code,
                f"Ranking could not start with {provider_id}/{model_id}: {_feedback(exc)}.",
                "Configure OPENROUTER_API_KEY and retry with the same explicit model.",
            ) from exc
    if provider.provider_id != provider_id or provider.model_id != model_id:
        raise ContractValidationError(
            "provider: injected provider identity must match ranking settings"
        )
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for candidate in candidate_artifact["candidates"]:
        grouped.setdefault(candidate["window_id"], []).append(candidate)
    cache_root = project_dir / RANKING_CACHE_RELATIVE_PATH / key.removeprefix("sha256:")
    judgments: dict[str, dict[str, Any]] = {}
    for index, window_id in enumerate(sorted(grouped)):
        if cancelled():
            raise cancellation_error()
        window_candidates = grouped[window_id]
        window_key = _canonical_hash({
            "final_key": key, "window_id": window_id, "candidates": window_candidates,
        })
        cache_path = cache_root / "windows" / f"{window_id}.json"
        cached = _load_cache(cache_path, window_key)
        hit = False
        try:
            normalized = validate_window_scores(
                {"scores": cached}, window_candidates, transcript
            )
            hit = True
            progress({
                "phase": "window_cache_hit", "window_id": window_id,
                "window_index": index + 1, "window_count": len(grouped),
                "fraction": 0.1 + 0.75 * ((index + 1) / len(grouped)),
                "cache_hit": True,
                "message": f"reusing validated {window_id} ranking scores",
            })
        except (ValueError, TypeError):
            normalized = _call_with_retry(
                target=window_id, provider=provider, candidates=window_candidates,
                transcript=transcript, progress=progress, cancelled=cancelled, delay=retry_delay,
            )
            _save_cache(cache_path, window_key, normalized)
        judgments.update({item["candidate_id"]: item for item in normalized})
        progress({
            "phase": "window_completed", "window_id": window_id,
            "window_index": index + 1, "window_count": len(grouped),
            "fraction": 0.1 + 0.75 * ((index + 1) / len(grouped)),
            "cache_hit": hit, "message": f"validated {window_id} ranking scores",
        })
    if cancelled():
        raise cancellation_error()
    entries = [
        _score_candidate(candidate, judgments[candidate["id"]], transcript)
        for candidate in candidate_artifact["candidates"]
    ]
    ordered = sorted(
        entries, key=lambda item: (-item["clip_potential"], item["candidate"]["id"])
    )
    for rank, entry in enumerate(ordered, 1):
        entry["overall_rank"] = rank
    duplicate_groups = group_duplicates(entries)
    shortlist = select_shortlist(
        entries, manifest["requested_clip_count"], transcript["duration_seconds"]
    )
    for entry in entries:
        if not entry["recommended"] and not entry["shortlist_exclusion_reasons"]:
            entry["shortlist_exclusion_reasons"].append(
                "Not included because the requested advisory shortlist count was reached."
            )
    entries.sort(key=lambda item: item["overall_rank"])
    artifact = {
        "artifact_version": RANKING_ARTIFACT_VERSION,
        "engine_version": ENGINE_VERSION,
        "created_at": clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "versions": versions,
        "source": {
            "fingerprint": transcript["source"]["fingerprint"],
            "transcript_cache_key": transcript["cache_key"],
            "candidate_cache_key": candidate_artifact["cache_key"],
            "candidate_content_hash": _canonical_hash(
                sorted(candidate_artifact["candidates"], key=lambda item: item["id"])
            ),
            "candidate_count": len(candidate_artifact["candidates"]),
        },
        "provider": {"id": provider_id, "model": model_id},
        "settings": settings,
        "weights": WEIGHTS,
        "thresholds": thresholds,
        "cache_key": key,
        "duplicate_groups": duplicate_groups,
        "shortlist_candidate_ids": shortlist,
        "candidates": entries,
    }
    try:
        validate_document("ranking_artifact", artifact)
        path = writer(project_dir, artifact)
    except Exception as exc:
        raise _error(
            "ranking_artifact_write_failed",
            f"The validated ranking artifact could not be written atomically: {_feedback(exc)}.",
            "Check project permissions and free disk space, then retry using preserved caches.",
        ) from exc
    progress({
        "phase": "ranking_completed", "fraction": 1.0, "percent": 100,
        "cache_hit": False, "message": "ranked candidates and built advisory shortlist",
    })
    return RankingResult(artifact, path, False)
