"""Transcript-grounded candidate generation with deterministic windows and caches."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from jsonschema import Draft202012Validator

from .candidate_providers import (
    CandidateProvider,
    ProviderError,
    make_candidate_provider,
    normalize_model_id,
    normalize_provider_id,
)
from .contracts import (
    CANDIDATE_ARTIFACT_VERSION,
    ContractValidationError,
    validate_document,
)

ENGINE_VERSION = "0.1.0"
CANDIDATE_SCHEMA_VERSION = "candidate-artifact.v1"
PROMPT_VERSION = "candidate-prompt.v1"
CLASSIFICATION_VERSION = "content-classification.v1"
WINDOWING_VERSION = "transcript-windowing.v1"
CACHE_VERSION = 1
CANDIDATE_ARTIFACT_RELATIVE_PATH = Path("artifacts") / "candidate-artifact.v1.json"
CANDIDATE_CACHE_RELATIVE_PATH = Path(".cache") / "candidates" / "v1"
TARGET_WINDOW_WORDS = 1500
OVERLAP_WORDS = 300
MIN_DURATION_SECONDS = 20.0
MAX_DURATION_SECONDS = 120.0
TEMPERATURE = 0.0
MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (0.0, 1.0, 2.0)

SUPPORTED_CONTENT_TYPES = (
    "podcast",
    "interview",
    "lecture",
    "webinar",
    "commentary",
    "talking_head",
)
FALLBACK_CONTENT_TYPE = "general_speech"
CONTENT_TYPES = (*SUPPORTED_CONTENT_TYPES, FALLBACK_CONTENT_TYPE)
SIGNAL_TYPES = (
    "story", "claim", "tip", "conflict", "revelation", "quote", "payoff",
)
CONTENT_CRITERIA = {
    "podcast": "Prioritize self-contained conversational stories, claims, insight, tension, and payoff.",
    "interview": "Prioritize questions and answers that stand alone, reveal something, and reach a payoff.",
    "lecture": "Prioritize complete explanations, surprising claims, memorable examples, and useful lessons.",
    "webinar": "Prioritize actionable demonstrations, clear advice, resolved objections, and concrete takeaways.",
    "commentary": "Prioritize comprehensible positions, sharp analysis, supporting reasoning, and conclusions.",
    "talking_head": "Prioritize direct hooks, concise stories, useful claims, and a clear spoken payoff.",
    "general_speech": "Prioritize any complete, standalone spoken moment with a clear opening and payoff.",
}

_CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["content_type", "evidence_word_ids", "reason"],
    "properties": {
        "content_type": {"enum": list(CONTENT_TYPES)},
        "evidence_word_ids": {
            "type": "array", "minItems": 1, "uniqueItems": True,
            "items": {"type": "string", "pattern": "^word_[0-9]{6}$"},
        },
        "reason": {"type": "string", "minLength": 1},
    },
}

_SPAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["first_word_id", "last_word_id"],
    "properties": {
        "first_word_id": {"type": "string", "pattern": "^word_[0-9]{6}$"},
        "last_word_id": {"type": "string", "pattern": "^word_[0-9]{6}$"},
    },
}

_SUGGESTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "suggestion_id", "title", "hook", "summary", "selection_reason",
        "signal_types", "proposed_span", "evidence_spans",
    ],
    "properties": {
        "suggestion_id": {"type": "string", "minLength": 1},
        "title": {"type": "string", "minLength": 1},
        "hook": {"type": "string", "minLength": 1},
        "summary": {"type": "string", "minLength": 1},
        "selection_reason": {"type": "string", "minLength": 1},
        "signal_types": {
            "type": "array", "minItems": 1, "uniqueItems": True,
            "items": {"enum": list(SIGNAL_TYPES)},
        },
        "proposed_span": _SPAN_SCHEMA,
        "evidence_spans": {"type": "array", "minItems": 1, "items": _SPAN_SCHEMA},
    },
}


@dataclass(frozen=True)
class CandidateGenerationError(Exception):
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
class CandidateSettings:
    provider_id: str
    model_id: str
    requested_clip_count: int
    content_type_setting: str

    def cache_document(self) -> dict[str, Any]:
        window_count_independent = {
            "provider": self.provider_id,
            "model": self.model_id,
            "requested_clip_count": self.requested_clip_count,
            "content_type": self.content_type_setting,
            "duration_policy_seconds": {
                "minimum": MIN_DURATION_SECONDS,
                "maximum": MAX_DURATION_SECONDS,
            },
            "generation": {
                "temperature": TEMPERATURE,
                "structured_output": True,
                "streaming": False,
            },
            "windowing": {
                "version": WINDOWING_VERSION,
                "target_words": TARGET_WINDOW_WORDS,
                "overlap_words": OVERLAP_WORDS,
            },
            "versions": {
                "engine": ENGINE_VERSION,
                "schema": CANDIDATE_SCHEMA_VERSION,
                "prompt": PROMPT_VERSION,
                "classification": CLASSIFICATION_VERSION,
            },
        }
        return window_count_independent


@dataclass(frozen=True)
class CandidateResult:
    artifact: dict[str, Any]
    path: Path
    cache_hit: bool


def _error(code: str, message: str, next_action: str) -> CandidateGenerationError:
    return CandidateGenerationError(
        code=code,
        message=message[:1000],
        preserved=(
            "The completed transcript, validated candidate window caches, and any earlier valid "
            "candidate artifact were preserved; no partial final artifact replaced them."
        ),
        next_action=next_action,
    )


def cancellation_error() -> CandidateGenerationError:
    return _error(
        "candidate_generation_cancelled",
        "Candidate generation was cancelled at a safe boundary.",
        "Retry the same request to reuse validated classification and window caches.",
    )


def _canonical_hash(document: Any) -> str:
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _inside_project(project_dir: Path, relative_path: str, code: str) -> Path:
    candidate = (project_dir / relative_path).resolve()
    try:
        candidate.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise _error(
            code,
            "A candidate input path escapes the selected project.",
            "Use the current project artifact path and retry.",
        ) from exc
    return candidate


def _load_inputs(request: dict[str, Any]) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    project_dir = Path(request["project_dir"]).expanduser().resolve()
    manifest_path = project_dir / "repurpose.json"
    try:
        manifest = validate_document("manifest", json.loads(manifest_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "candidate_project_invalid",
            f"The Repurpose project manifest is missing or invalid: {exc}.",
            "Repair or recreate the project, complete transcription, and retry candidate generation.",
        ) from exc
    stage = manifest["stages"]["transcribe"]
    if stage["state"] != "completed" or not stage["artifact"]:
        raise _error(
            "candidate_transcript_not_completed",
            "The project's transcribe stage is not completed with an artifact.",
            "Complete transcription before generating candidates.",
        )
    descriptors = [
        item for item in request["input_artifacts"]
        if item["kind"] == "transcript_artifact" and item.get("version") == 1
    ]
    if len(descriptors) != 1 or descriptors[0]["path"] != stage["artifact"]:
        raise _error(
            "candidate_transcript_invalid",
            "The request must name the project's completed version-1 transcript artifact.",
            "Rebuild the request from the current completed transcribe stage and retry.",
        )
    transcript_path = _inside_project(project_dir, descriptors[0]["path"], "candidate_transcript_invalid")
    try:
        transcript = validate_document(
            "transcript_artifact", json.loads(transcript_path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError) as exc:
        raise _error(
            "candidate_transcript_invalid",
            f"The completed transcript artifact is missing or invalid: {exc}.",
            "Recreate a valid transcript artifact and retry candidate generation.",
        ) from exc
    fingerprint = manifest["source"]["fingerprint"]
    if not fingerprint or transcript["source"]["fingerprint"] != fingerprint:
        raise _error(
            "candidate_transcript_stale",
            "The transcript source fingerprint does not match the project's current source.",
            "Rerun ingest and transcription for the current source, then retry.",
        )
    if not transcript["speech_detected"]:
        raise _error(
            "candidate_no_speech",
            "The completed transcript reports no speech, so no candidates can be generated.",
            "Use a source with detectable speech or choose ranges manually in a later workflow.",
        )
    if not transcript["words"]:
        raise _error(
            "candidate_transcript_invalid",
            "The speech transcript has no word-level evidence for candidate generation.",
            "Recreate the word-level transcript and retry candidate generation.",
        )
    return project_dir, manifest, transcript


def normalize_settings(manifest: Mapping[str, Any], options: Any) -> CandidateSettings:
    if not isinstance(options, dict):
        raise ContractValidationError("options: must be an object")
    unknown = sorted(set(options) - {"provider", "model"})
    if unknown:
        raise ContractValidationError(f"options.{unknown[0]}: unsupported candidate option")
    try:
        provider_id = normalize_provider_id(options.get("provider", "openrouter"))
        model_id = normalize_model_id(options.get("model"))
    except ValueError as exc:
        raise ContractValidationError(str(exc)) from exc
    content_type = manifest["content_type"].strip().lower()
    return CandidateSettings(
        provider_id=provider_id,
        model_id=model_id,
        requested_clip_count=int(manifest["requested_clip_count"]),
        content_type_setting=content_type,
    )


def build_windows(
    transcript: Mapping[str, Any],
    *,
    target_words: int = TARGET_WINDOW_WORDS,
    overlap_words: int = OVERLAP_WORDS,
) -> list[dict[str, Any]]:
    """Build deterministic, segment-aligned windows without splitting oversized segments."""

    if target_words < 1 or overlap_words < 0:
        raise ValueError("windowing sizes must be non-negative and target_words must be positive")
    words_by_id = {word["id"]: word for word in transcript["words"]}
    segments = list(transcript["segments"])
    if not segments:
        return []
    counts = [len(segment["word_ids"]) for segment in segments]
    windows: list[dict[str, Any]] = []
    start_index = 0
    while start_index < len(segments):
        end_index = start_index
        total = counts[start_index]
        if total <= target_words:
            while end_index + 1 < len(segments) and (
                total == 0 or total + counts[end_index + 1] <= target_words
            ):
                end_index += 1
                total += counts[end_index]
        selected = segments[start_index:end_index + 1]
        word_ids = [word_id for segment in selected for word_id in segment["word_ids"]]
        first = words_by_id[word_ids[0]]
        last = words_by_id[word_ids[-1]]
        windows.append({
            "id": f"window_{len(windows) + 1:06d}",
            "segment_ids": [segment["id"] for segment in selected],
            "first_word_id": first["id"],
            "last_word_id": last["id"],
            "word_count": len(word_ids),
            "start_seconds": first["start_seconds"],
            "end_seconds": last["end_seconds"],
        })
        if end_index == len(segments) - 1:
            break
        if total > target_words and sum(count > 0 for count in counts[start_index:end_index + 1]) == 1:
            start_index = end_index + 1
            continue
        overlap_total = 0
        next_start = end_index + 1
        for index in range(end_index, start_index - 1, -1):
            overlap_total += counts[index]
            next_start = index
            if overlap_total >= overlap_words:
                break
        if next_start <= start_index:
            next_start = end_index + 1
        start_index = next_start
    return windows


def _window_word_ids(window: Mapping[str, Any], transcript: Mapping[str, Any]) -> list[str]:
    segment_ids = set(window["segment_ids"])
    return [word["id"] for word in transcript["words"] if word["segment_id"] in segment_ids]


def classification_sample(transcript: Mapping[str, Any], sample_words: int = 120) -> list[dict[str, Any]]:
    words = transcript["words"]
    if not words:
        return []
    starts = [0, max(0, len(words) // 2 - sample_words // 2), max(0, len(words) - sample_words)]
    labels = ["beginning", "middle", "ending"]
    samples = []
    for label, start in zip(labels, starts):
        selected = words[start:start + sample_words]
        samples.append({
            "position": label,
            "first_word_id": selected[0]["id"],
            "last_word_id": selected[-1]["id"],
            "words": [{"id": word["id"], "text": word["text"]} for word in selected],
        })
    return samples


def _schema_errors(schema: dict[str, Any], value: Any) -> list[str]:
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.absolute_path))
    result = []
    for error in errors[:3]:
        path = ".".join(str(part) for part in error.absolute_path)
        result.append(f"{path}: {error.message}" if path else error.message)
    return result


def _classification_request(samples: list[dict[str, Any]], feedback: str | None) -> dict[str, Any]:
    logical = {
        "task": "classify_speech_content",
        "version": CLASSIFICATION_VERSION,
        "supported_types": list(SUPPORTED_CONTENT_TYPES),
        "fallback_type": FALLBACK_CONTENT_TYPE,
        "instructions": (
            "Classify all six supported speech formats equally. Use general_speech for uncertain, "
            "mixed, or unsupported material. Cite ordered exact word IDs from the samples."
        ),
        "samples": samples,
    }
    if feedback:
        logical["validation_feedback"] = feedback
    return {
        "schema_name": "vidmyo_content_classification_v1",
        "schema": _CLASSIFICATION_SCHEMA,
        "messages": [
            {"role": "system", "content": "Return only strict schema-valid transcript-grounded JSON."},
            {"role": "user", "content": json.dumps(logical, separators=(",", ":"))},
        ],
    }


def _suggestion_response_schema(max_suggestions: int) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["suggestions"],
        "properties": {
            "suggestions": {
                "type": "array", "maxItems": max_suggestions,
                "items": _SUGGESTION_SCHEMA,
            }
        },
    }


def _window_request(
    window: Mapping[str, Any],
    transcript: Mapping[str, Any],
    content_type: str,
    max_suggestions: int,
    feedback: str | None,
) -> dict[str, Any]:
    word_ids = set(_window_word_ids(window, transcript))
    words = [
        {"id": word["id"], "start_seconds": word["start_seconds"],
         "end_seconds": word["end_seconds"], "text": word["text"]}
        for word in transcript["words"] if word["id"] in word_ids
    ]
    logical = {
        "task": "generate_transcript_candidates",
        "prompt_version": PROMPT_VERSION,
        "window_id": window["id"],
        "content_type": content_type,
        "criteria": CONTENT_CRITERIA[content_type],
        "common_requirements": (
            "Every suggestion must have standalone meaning, a comprehensible opening, and a payoff. "
            "Propose an inclusive exact-word span lasting 20 to 120 seconds. Return fewer or zero "
            "suggestions when no worthwhile moment exists. Do not score, rank, deduplicate, repair, or select."
        ),
        "maximum_suggestions": max_suggestions,
        "words": words,
    }
    if feedback:
        logical["validation_feedback"] = feedback
    return {
        "schema_name": "vidmyo_candidate_suggestions_v1",
        "schema": _suggestion_response_schema(max_suggestions),
        "messages": [
            {"role": "system", "content": "Return only strict schema-valid transcript-grounded JSON."},
            {"role": "user", "content": json.dumps(logical, separators=(",", ":"))},
        ],
    }


def _validate_classification(
    document: Any,
    samples: list[dict[str, Any]],
) -> dict[str, Any]:
    errors = _schema_errors(_CLASSIFICATION_SCHEMA, document)
    if errors:
        raise ValueError("; ".join(errors))
    allowed_ids = {
        word["id"] for sample in samples for word in sample["words"]
    }
    evidence = document["evidence_word_ids"]
    if any(word_id not in allowed_ids for word_id in evidence):
        raise ValueError("evidence_word_ids: must reference deterministic classification samples")
    if evidence != sorted(evidence):
        raise ValueError("evidence_word_ids: must be in transcript order")
    reason = " ".join(document["reason"].split())
    if not reason:
        raise ValueError("reason: must not be empty")
    selected = document["content_type"]
    if selected not in CONTENT_TYPES:
        selected = FALLBACK_CONTENT_TYPE
    return {
        "content_type": selected,
        "source": "auto",
        "evidence_word_ids": evidence,
        "reason": reason,
    }


def _validate_cached_classification(
    document: Any,
    samples: list[dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("cached classification must be an object")
    normalized = _validate_classification(
        {key: document.get(key) for key in ("content_type", "evidence_word_ids", "reason")},
        samples,
    )
    if document.get("source") != "auto":
        raise ValueError("cached classification source must be auto")
    return normalized


def _text(words: list[dict[str, Any]]) -> str:
    return " ".join(word["text"] for word in words).strip()


def _normalized_span(
    span: Mapping[str, Any],
    *,
    positions: Mapping[str, int],
    words: Mapping[str, dict[str, Any]],
    candidate_bounds: tuple[int, int] | None = None,
) -> dict[str, Any]:
    first_id = span["first_word_id"]
    last_id = span["last_word_id"]
    if first_id not in positions or last_id not in positions:
        raise ValueError("word reference is unknown, dangling, or outside the window")
    first_index, last_index = positions[first_id], positions[last_id]
    if last_index < first_index:
        raise ValueError("word references are reversed")
    if candidate_bounds and (first_index < candidate_bounds[0] or last_index > candidate_bounds[1]):
        raise ValueError("evidence lies outside the proposed candidate span")
    selected = [words[word_id] for word_id, index in positions.items() if first_index <= index <= last_index]
    return {
        "first_word_id": first_id,
        "last_word_id": last_id,
        "start_seconds": words[first_id]["start_seconds"],
        "end_seconds": words[last_id]["end_seconds"],
        "text": _text(selected),
    }


def validate_window_response(
    document: Any,
    *,
    window: Mapping[str, Any],
    transcript: Mapping[str, Any],
    max_suggestions: int,
    seen_provider_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    schema = _suggestion_response_schema(max_suggestions)
    errors = _schema_errors(schema, document)
    if errors:
        raise ValueError("; ".join(errors))
    word_ids = _window_word_ids(window, transcript)
    positions = {word_id: index for index, word_id in enumerate(word_ids)}
    all_words = {word["id"]: word for word in transcript["words"]}
    words = {word_id: all_words[word_id] for word_id in word_ids}
    used_ids = set(seen_provider_ids)
    normalized: list[dict[str, Any]] = []
    for suggestion in document["suggestions"]:
        provider_id = suggestion["suggestion_id"].strip()
        if not provider_id or provider_id in used_ids:
            raise ValueError("suggestion_id: duplicated or empty provider suggestion id")
        used_ids.add(provider_id)
        text_fields = {}
        for field in ("title", "hook", "summary", "selection_reason"):
            value = " ".join(suggestion[field].split())
            if not value:
                raise ValueError(f"{field}: must not be empty")
            text_fields[field] = value
        proposed = _normalized_span(
            suggestion["proposed_span"], positions=positions, words=words,
        )
        first_index = positions[proposed["first_word_id"]]
        last_index = positions[proposed["last_word_id"]]
        duration = proposed["end_seconds"] - proposed["start_seconds"]
        if duration < MIN_DURATION_SECONDS or duration > MAX_DURATION_SECONDS:
            raise ValueError("proposed_span: duration must be between 20 and 120 seconds")
        evidence = []
        previous_start = -1
        for span in suggestion["evidence_spans"]:
            normalized_span = _normalized_span(
                span, positions=positions, words=words,
                candidate_bounds=(first_index, last_index),
            )
            current_start = positions[normalized_span["first_word_id"]]
            if current_start < previous_start:
                raise ValueError("evidence_spans: references must be in transcript order")
            previous_start = current_start
            evidence.append(normalized_span)
        normalized.append({
            "provider_suggestion_id": provider_id,
            "window_id": window["id"],
            **text_fields,
            "signal_types": list(suggestion["signal_types"]),
            "proposed_span": proposed,
            "evidence_spans": evidence,
        })
    return normalized


def _validate_cached_window(
    cached: Any,
    *,
    window: Mapping[str, Any],
    transcript: Mapping[str, Any],
    max_suggestions: int,
    seen_provider_ids: Iterable[str],
) -> list[dict[str, Any]]:
    if not isinstance(cached, list):
        raise ValueError("cached window result must be an array")
    suggestions = []
    for item in cached:
        if not isinstance(item, dict):
            raise ValueError("cached suggestion must be an object")
        suggestions.append({
            "suggestion_id": item.get("provider_suggestion_id"),
            "title": item.get("title"),
            "hook": item.get("hook"),
            "summary": item.get("summary"),
            "selection_reason": item.get("selection_reason"),
            "signal_types": item.get("signal_types"),
            "proposed_span": {
                "first_word_id": (item.get("proposed_span") or {}).get("first_word_id"),
                "last_word_id": (item.get("proposed_span") or {}).get("last_word_id"),
            },
            "evidence_spans": [
                {
                    "first_word_id": span.get("first_word_id"),
                    "last_word_id": span.get("last_word_id"),
                }
                for span in (item.get("evidence_spans") or []) if isinstance(span, dict)
            ],
        })
    return validate_window_response(
        {"suggestions": suggestions}, window=window, transcript=transcript,
        max_suggestions=max_suggestions, seen_provider_ids=seen_provider_ids,
    )


def _atomic_json(
    path: Path,
    document: Any,
    *,
    replace: Callable[[str | bytes | os.PathLike[str], str | bytes | os.PathLike[str]], None] = os.replace,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(document, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path


def write_candidate_artifact(
    project_dir: Path,
    artifact: dict[str, Any],
    *,
    replace: Callable[[str | bytes | os.PathLike[str], str | bytes | os.PathLike[str]], None] = os.replace,
) -> Path:
    validate_document("candidate_artifact", artifact)
    path = (project_dir / CANDIDATE_ARTIFACT_RELATIVE_PATH).resolve()
    try:
        path.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise RuntimeError("candidate artifact path escaped the project directory") from exc
    return _atomic_json(path, artifact, replace=replace)


def _cache_path(root: Path, name: str) -> Path:
    return root / f"{name}.json"


def _load_cache(path: Path, expected_key: str) -> Any | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict) or document.get("cache_version") != CACHE_VERSION:
        return None
    if document.get("cache_key") != expected_key or "result" not in document:
        return None
    return document["result"]


def _save_cache(path: Path, key: str, kind: str, result: Any) -> None:
    try:
        _atomic_json(path, {
            "cache_version": CACHE_VERSION,
            "kind": kind,
            "cache_key": key,
            "result": result,
        })
    except OSError as exc:
        raise _error(
            "candidate_cache_write_failed",
            f"The validated {kind} result could not be cached atomically: {_feedback(exc)}.",
            "Check project permissions and free disk space, then retry the same request.",
        ) from exc


def _feedback(exc: Exception) -> str:
    value = " ".join(str(exc).split())
    secret = os.environ.get("OPENROUTER_API_KEY")
    if secret:
        value = value.replace(secret, "[REDACTED]")
    return value[:400]


def _reject_secret(value: Any) -> None:
    secret = os.environ.get("OPENROUTER_API_KEY")
    if not secret:
        return
    try:
        encoded = json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return
    if secret in encoded:
        raise ValueError("provider output contained a credential value and was rejected")


def _call_with_retry(
    *,
    target: str,
    provider: CandidateProvider,
    build_request: Callable[[str | None], dict[str, Any]],
    validate: Callable[[Any], Any],
    progress: Callable[[dict[str, Any]], None],
    cancelled: Callable[[], bool],
    delay: Callable[[float], None],
) -> Any:
    feedback: str | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if cancelled():
            raise cancellation_error()
        progress({
            "phase": "provider_attempt", "target": target, "attempt": attempt,
            "max_attempts": MAX_ATTEMPTS, "provider": provider.provider_id,
            "model": provider.model_id, "cache_hit": False,
            "message": f"requesting structured output for {target}",
        })
        try:
            result = provider.structured(build_request(feedback))
            _reject_secret(result)
            validated = validate(result)
            return validated
        except CandidateGenerationError:
            raise
        except ProviderError as exc:
            if not exc.retryable:
                raise _error(
                    exc.code,
                    f"Candidate generation failed for {target} using "
                    f"{provider.provider_id}/{provider.model_id}: {_feedback(exc)}",
                    "Correct provider access, credit, model, or structured-output support and retry.",
                ) from exc
            feedback = _feedback(exc)
            last_error: Exception = exc
        except (ValueError, ContractValidationError) as exc:
            feedback = _feedback(exc)
            last_error = exc
        if attempt == MAX_ATTEMPTS:
            raise _error(
                "candidate_provider_retries_exhausted",
                f"Candidate generation exhausted {MAX_ATTEMPTS} attempts for {target} using "
                f"{provider.provider_id}/{provider.model_id}: {_feedback(last_error)}.",
                "Retry the same request to reuse preserved valid work, or choose a supported explicit model.",
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


def _matching_final(
    path: Path,
    expected_key: str,
    *,
    transcript: Mapping[str, Any],
    settings: CandidateSettings,
) -> dict[str, Any] | None:
    try:
        artifact = validate_document(
            "candidate_artifact", json.loads(path.read_text(encoding="utf-8"))
        )
    except (OSError, json.JSONDecodeError, ContractValidationError):
        return None
    generation = artifact["generation_settings"]
    matches = (
        artifact["cache_key"] == expected_key
        and artifact["engine_version"] == ENGINE_VERSION
        and artifact["source"] == {
            "fingerprint": transcript["source"]["fingerprint"],
            "transcript_cache_key": transcript["cache_key"],
        }
        and artifact["provider"] == {
            "id": settings.provider_id, "model": settings.model_id,
        }
        and generation["requested_clip_count"] == settings.requested_clip_count
        and generation["content_type"] == settings.content_type_setting
    )
    return artifact if matches else None


def generate_candidates(
    request: dict[str, Any],
    *,
    provider: CandidateProvider | None = None,
    provider_factory: Callable[[str, str], CandidateProvider] = make_candidate_provider,
    progress: Callable[[dict[str, Any]], None] = lambda _event: None,
    cancelled: Callable[[], bool] = lambda: False,
    retry_delay: Callable[[float], None] = lambda seconds: __import__("time").sleep(seconds),
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    writer: Callable[[Path, dict[str, Any]], Path] = write_candidate_artifact,
) -> CandidateResult:
    request = validate_document("request", request)
    if request["stage"] != "generate_candidates":
        raise ContractValidationError("stage: candidates command requires stage 'generate_candidates'")
    if cancelled():
        raise cancellation_error()
    progress({"phase": "input_validation", "fraction": 0.02, "percent": 2, "cache_hit": False,
              "message": "validating completed transcript and current project source"})
    project_dir, manifest, transcript = _load_inputs(request)
    settings = normalize_settings(manifest, request["options"])
    windows = build_windows(transcript)
    if not windows:
        raise _error(
            "candidate_transcript_invalid",
            "The transcript has no segment-aligned word windows.",
            "Recreate the word-level transcript and retry candidate generation.",
        )
    key_document = {
        "transcript_cache_key": transcript["cache_key"],
        "source_fingerprint": transcript["source"]["fingerprint"],
        "settings": settings.cache_document(),
    }
    final_key = _canonical_hash(key_document)
    artifact_path = project_dir / CANDIDATE_ARTIFACT_RELATIVE_PATH
    cached_final = _matching_final(
        artifact_path, final_key, transcript=transcript, settings=settings,
    )
    if cached_final is not None:
        progress({"phase": "final_cache_hit", "fraction": 1.0, "percent": 100,
                  "cache_hit": True, "message": "reusing matching validated candidate artifact"})
        return CandidateResult(cached_final, artifact_path, True)
    if cancelled():
        raise cancellation_error()
    if provider is None:
        try:
            provider = provider_factory(settings.provider_id, settings.model_id)
        except ProviderError as exc:
            raise _error(
                exc.code,
                f"Candidate generation could not start with {settings.provider_id}/{settings.model_id}: "
                f"{_feedback(exc)}.",
                "Configure OPENROUTER_API_KEY and retry with the same explicit model.",
            ) from exc
    if provider.provider_id != settings.provider_id or provider.model_id != settings.model_id:
        raise ContractValidationError(
            "provider: injected provider identity must match normalized request settings"
        )
    cache_root = project_dir / CANDIDATE_CACHE_RELATIVE_PATH / final_key.removeprefix("sha256:")
    content_setting = settings.content_type_setting
    classification: dict[str, Any]
    if content_setting in SUPPORTED_CONTENT_TYPES:
        classification = {
            "content_type": content_setting,
            "source": "project_override",
            "evidence_word_ids": [],
            "reason": "Explicit supported project content type honored without classification.",
        }
        progress({"phase": "classification_skipped", "fraction": 0.08, "percent": 8,
                  "content_type": content_setting, "cache_hit": False,
                  "message": "honoring explicit project content type"})
    elif content_setting != "auto":
        classification = {
            "content_type": FALLBACK_CONTENT_TYPE,
            "source": "project_fallback",
            "evidence_word_ids": [],
            "reason": "Unsupported or mixed explicit project content uses general_speech.",
        }
        progress({"phase": "classification_skipped", "fraction": 0.08, "percent": 8,
                  "content_type": FALLBACK_CONTENT_TYPE, "cache_hit": False,
                  "message": "using general_speech fallback"})
    else:
        samples = classification_sample(transcript)
        classification_key = _canonical_hash({"final_key": final_key, "samples": samples})
        classification_path = _cache_path(cache_root, "classification")
        cached_classification = _load_cache(classification_path, classification_key)
        try:
            classification = _validate_cached_classification(cached_classification, samples)
            progress({"phase": "classification_cache_hit", "fraction": 0.12, "percent": 12,
                      "content_type": classification["content_type"], "cache_hit": True,
                      "message": "reusing validated content classification"})
        except (ValueError, TypeError):
            classification = _call_with_retry(
                target="classification", provider=provider,
                build_request=lambda feedback: _classification_request(samples, feedback),
                validate=lambda value: _validate_classification(value, samples),
                progress=progress, cancelled=cancelled, delay=retry_delay,
            )
            _save_cache(classification_path, classification_key, "classification", classification)
    selected_type = classification["content_type"]
    max_per_window = min(
        10,
        max(1, math.ceil((settings.requested_clip_count * 3) / len(windows))),
    )
    candidates: list[dict[str, Any]] = []
    provider_ids: set[str] = set()
    for index, window in enumerate(windows):
        if cancelled():
            raise cancellation_error()
        window_key = _canonical_hash({
            "final_key": final_key,
            "classification": classification,
            "window": window,
            "max_suggestions": max_per_window,
        })
        window_path = _cache_path(cache_root / "windows", window["id"])
        cached_window = _load_cache(window_path, window_key)
        window_cache_hit = False
        try:
            normalized = _validate_cached_window(
                cached_window, window=window, transcript=transcript,
                max_suggestions=max_per_window, seen_provider_ids=provider_ids,
            )
            progress({
                "phase": "window_cache_hit", "window_id": window["id"],
                "window_index": index + 1, "window_count": len(windows),
                "fraction": 0.15 + 0.8 * ((index + 1) / len(windows)),
                "percent": round((0.15 + 0.8 * ((index + 1) / len(windows))) * 100, 3),
                "cache_hit": True, "message": f"reusing validated {window['id']}",
            })
            window_cache_hit = True
        except (ValueError, TypeError):
            normalized = _call_with_retry(
                target=window["id"], provider=provider,
                build_request=lambda feedback, active=window: _window_request(
                    active, transcript, selected_type, max_per_window, feedback,
                ),
                validate=lambda value, active=window: validate_window_response(
                    value, window=active, transcript=transcript,
                    max_suggestions=max_per_window, seen_provider_ids=provider_ids,
                ),
                progress=progress, cancelled=cancelled, delay=retry_delay,
            )
            _save_cache(window_path, window_key, "window", normalized)
        for candidate in normalized:
            provider_ids.add(candidate["provider_suggestion_id"])
            candidate["id"] = f"clip_{len(candidates) + 1:03d}"
            candidates.append(candidate)
        progress({
            "phase": "window_completed", "window_id": window["id"],
            "window_index": index + 1, "window_count": len(windows),
            "suggestion_count": len(normalized),
            "fraction": 0.15 + 0.8 * ((index + 1) / len(windows)),
            "percent": round((0.15 + 0.8 * ((index + 1) / len(windows))) * 100, 3),
            "cache_hit": window_cache_hit, "message": f"validated {window['id']}",
        })
    if cancelled():
        raise cancellation_error()
    artifact = {
        "artifact_version": CANDIDATE_ARTIFACT_VERSION,
        "engine_version": ENGINE_VERSION,
        "created_at": clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "versions": {
            "schema": CANDIDATE_SCHEMA_VERSION,
            "prompt": PROMPT_VERSION,
            "classification": CLASSIFICATION_VERSION,
            "windowing": WINDOWING_VERSION,
        },
        "source": {
            "fingerprint": transcript["source"]["fingerprint"],
            "transcript_cache_key": transcript["cache_key"],
        },
        "provider": {"id": settings.provider_id, "model": settings.model_id},
        "generation_settings": {
            "requested_clip_count": settings.requested_clip_count,
            "content_type": settings.content_type_setting,
            "minimum_duration_seconds": MIN_DURATION_SECONDS,
            "maximum_duration_seconds": MAX_DURATION_SECONDS,
            "target_window_words": TARGET_WINDOW_WORDS,
            "overlap_words": OVERLAP_WORDS,
            "max_suggestions_per_window": max_per_window,
            "temperature": TEMPERATURE,
            "structured_output": True,
            "streaming": False,
        },
        "cache_key": final_key,
        "classification": classification,
        "windows": windows,
        "outcome": "candidates_generated" if candidates else "no_candidates_found",
        "candidates": candidates,
    }
    try:
        validate_document("candidate_artifact", artifact)
        path = writer(project_dir, artifact)
    except Exception as exc:
        raise _error(
            "candidate_artifact_write_failed",
            f"The validated candidate artifact could not be written atomically: {_feedback(exc)}.",
            "Check project permissions and free disk space, then retry using preserved caches.",
        ) from exc
    return CandidateResult(artifact, path, False)
