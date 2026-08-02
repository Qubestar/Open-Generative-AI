from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest

import vidmyo_repurpose.candidates as generation
from vidmyo_repurpose.candidate_providers import ProviderError
from vidmyo_repurpose.candidates import (
    CANDIDATE_ARTIFACT_RELATIVE_PATH,
    CandidateGenerationError,
    build_windows,
    generate_candidates,
    validate_window_response,
    write_candidate_artifact,
)
from vidmyo_repurpose.contracts import ContractValidationError, validate_document

FIXTURES = Path(__file__).parent / "fixtures"
SHA_A = "sha256:" + "a" * 64
SHA_B = "sha256:" + "b" * 64


def transcript(segment_sizes=(40,), *, speech=True, fingerprint=SHA_A, cache_key=SHA_B) -> dict:
    segments = []
    words = []
    second = 0.0
    for segment_number, size in enumerate(segment_sizes, 1):
        segment_id = f"segment_{segment_number:06d}"
        ids = []
        start = second
        for _ in range(size):
            word_id = f"word_{len(words) + 1:06d}"
            ids.append(word_id)
            words.append({
                "id": word_id, "segment_id": segment_id,
                "start_seconds": second, "end_seconds": second + 0.9,
                "text": f"word{len(words) + 1}", "confidence": 0.9,
            })
            second += 1.0
        segments.append({
            "id": segment_id, "start_seconds": start, "end_seconds": second - 0.1,
            "text": " ".join(word["text"] for word in words[-size:]),
            "confidence": 0.9, "word_ids": ids,
        })
    if not speech:
        segments, words, second = [], [], 10.0
    artifact = {
        "artifact_version": 1, "engine_version": "0.1.0",
        "created_at": "2026-08-02T00:00:00Z",
        "source": {"path": "/source.mp4", "fingerprint": fingerprint},
        "cache_key": cache_key,
        "transcription": {
            "engine": "faster-whisper", "library_version": "1.2.1", "model": "small",
            "device": "cpu", "compute_type": "int8", "word_timestamps": True,
            "requested_language": None, "detected_language": "en", "language_confidence": 0.9,
        },
        "duration_seconds": max(10.0, second), "speech_detected": speech,
        "segments": segments, "words": words,
    }
    return validate_document("transcript_artifact", artifact)


def project(
    tmp_path: Path,
    artifact: dict,
    *,
    content_type="podcast",
    requested_clip_count=5,
) -> dict:
    manifest = json.loads((FIXTURES / "valid-project-manifest.json").read_text())
    manifest["source"] = {
        "type": "local_file", "uri": artifact["source"]["path"],
        "fingerprint": artifact["source"]["fingerprint"],
    }
    manifest["requested_clip_count"] = requested_clip_count
    manifest["content_type"] = content_type
    manifest["stages"] = {
        name: {"state": "pending", "artifact": None, "error": None}
        for name in manifest["stages"]
    }
    manifest["stages"]["ingest"] = {
        "state": "completed", "artifact": "artifacts/ingest-artifact.v1.json", "error": None,
    }
    manifest["stages"]["transcribe"] = {
        "state": "completed", "artifact": "artifacts/transcript-artifact.v1.json", "error": None,
    }
    manifest["candidates"] = []
    (tmp_path / "repurpose.json").write_text(json.dumps(manifest))
    artifact_path = tmp_path / "artifacts" / "transcript-artifact.v1.json"
    artifact_path.parent.mkdir(exist_ok=True)
    artifact_path.write_text(json.dumps(artifact))
    return {
        "protocol_version": 1, "job_id": "job_candidates_test",
        "project_dir": str(tmp_path), "stage": "generate_candidates",
        "input_artifacts": [{
            "kind": "transcript_artifact",
            "path": "artifacts/transcript-artifact.v1.json", "version": 1,
        }],
        "options": {"provider": "openrouter", "model": "openai/gpt-test"},
    }


def suggestion(
    suggestion_id="provider-1",
    first="word_000001",
    last="word_000030",
    evidence_first=None,
    evidence_last=None,
) -> dict:
    return {
        "suggestion_id": suggestion_id,
        "title": "A complete title", "hook": "A clear hook",
        "summary": "A standalone summary", "selection_reason": "It reaches a payoff",
        "signal_types": ["story", "payoff"],
        "proposed_span": {"first_word_id": first, "last_word_id": last},
        "evidence_spans": [{
            "first_word_id": evidence_first or first,
            "last_word_id": evidence_last or last,
        }],
    }


class FakeProvider:
    provider_id = "openrouter"
    model_id = "openai/gpt-test"

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def structured(self, request):
        self.requests.append(deepcopy(request))
        if not self.responses:
            raise AssertionError("unexpected provider call")
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return deepcopy(value)


def run(
    tmp_path: Path,
    responses,
    *,
    artifact=None,
    content_type="podcast",
    requested_clip_count=5,
    **kwargs,
):
    artifact = artifact or transcript()
    request = project(
        tmp_path, artifact, content_type=content_type,
        requested_clip_count=requested_clip_count,
    )
    provider = FakeProvider(responses)
    progress = []
    result = generate_candidates(
        request, provider=provider, progress=progress.append,
        retry_delay=kwargs.pop("retry_delay", lambda _seconds: None),
        clock=lambda: datetime(2026, 8, 2, tzinfo=timezone.utc),
        **kwargs,
    )
    return request, provider, progress, result


def test_windowing_is_segment_aligned_overlapping_stable_and_handles_oversized():
    artifact = transcript((100,) * 18)
    first = build_windows(artifact)
    second = build_windows(deepcopy(artifact))
    assert first == second
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert [window["word_count"] for window in first] == [1500, 600]
    assert first[0]["segment_ids"] == [f"segment_{i:06d}" for i in range(1, 16)]
    assert first[1]["segment_ids"][0] == "segment_000013"
    assert first[0]["first_word_id"] == "word_000001"
    assert first[0]["last_word_id"] == "word_001500"
    assert first[1]["first_word_id"] == "word_001201"
    assert first[1]["last_word_id"] == "word_001800"

    oversized = build_windows(transcript((1600, 20)))
    assert [window["word_count"] for window in oversized] == [1600, 20]
    assert build_windows(transcript((40,)))[0]["id"] == "window_000001"


@pytest.mark.parametrize(
    "content_type",
    ["podcast", "interview", "lecture", "webinar", "commentary", "talking_head"],
)
def test_all_explicit_content_types_are_honored_without_classification(tmp_path, content_type):
    _, provider, _, result = run(
        tmp_path, [{"suggestions": []}], content_type=content_type,
    )
    assert result.artifact["classification"]["content_type"] == content_type
    assert result.artifact["classification"]["source"] == "project_override"
    assert len(provider.requests) == 1
    logical = json.loads(provider.requests[0]["messages"][1]["content"])
    assert logical["content_type"] == content_type
    assert logical["criteria"]


def test_auto_classification_uses_three_samples_and_general_fallback(tmp_path):
    classification = {
        "content_type": "general_speech", "evidence_word_ids": ["word_000001"],
        "reason": "Mixed and uncertain speech",
    }
    _, provider, _, result = run(
        tmp_path, [classification, {"suggestions": []}], content_type="auto",
    )
    assert result.artifact["classification"] == {
        **classification, "source": "auto",
    }
    logical = json.loads(provider.requests[0]["messages"][1]["content"])
    assert [sample["position"] for sample in logical["samples"]] == [
        "beginning", "middle", "ending",
    ]
    assert "general_speech" in logical["fallback_type"]


@pytest.mark.parametrize(
    "classified_type",
    [
        "podcast", "interview", "lecture", "webinar", "commentary",
        "talking_head", "general_speech",
    ],
)
def test_auto_classification_supports_every_content_family_equally(tmp_path, classified_type):
    classification = {
        "content_type": classified_type,
        "evidence_word_ids": ["word_000001"],
        "reason": f"Transcript matches {classified_type}",
    }
    _, provider, _, result = run(
        tmp_path, [classification, {"suggestions": []}], content_type="auto",
    )
    assert result.artifact["classification"]["content_type"] == classified_type
    generation_logical = json.loads(provider.requests[1]["messages"][1]["content"])
    assert generation_logical["content_type"] == classified_type
    assert generation_logical["criteria"]


def test_generation_reconstructs_exact_evidence_and_has_no_forbidden_fields(tmp_path):
    _, _, progress, result = run(
        tmp_path,
        [{"suggestions": [suggestion(), suggestion("provider-2", "word_000005", "word_000035")]}],
    )
    artifact = result.artifact
    assert [candidate["id"] for candidate in artifact["candidates"]] == ["clip_001", "clip_002"]
    candidate = artifact["candidates"][0]
    assert candidate["proposed_span"]["start_seconds"] == 0.0
    assert candidate["proposed_span"]["end_seconds"] == 29.9
    assert candidate["proposed_span"]["text"].startswith("word1 word2")
    assert candidate["evidence_spans"][0]["text"] == candidate["proposed_span"]["text"]
    serialized = json.dumps(artifact)
    for forbidden in (
        '"score"', '"rank"', '"approval"', '"selected"', '"repaired"', '"render"'
    ):
        assert forbidden not in serialized
    assert artifact["outcome"] == "candidates_generated"
    assert validate_document("candidate_artifact", artifact) is artifact
    assert [event["phase"] for event in progress][0] == "input_validation"


def test_per_window_suggestion_cap_uses_requested_count_and_window_count(tmp_path):
    artifact = transcript((100,) * 18)
    _, provider, _, result = run(
        tmp_path,
        [{"suggestions": []}, {"suggestions": []}],
        artifact=artifact,
        requested_clip_count=5,
    )
    assert len(result.artifact["windows"]) == 2
    assert result.artifact["generation_settings"]["max_suggestions_per_window"] == 8
    assert result.artifact["generation_settings"]["temperature"] == 0.0
    for request in provider.requests:
        assert request["schema"]["properties"]["suggestions"]["maxItems"] == 8
        logical = json.loads(request["messages"][1]["content"])
        assert logical["maximum_suggestions"] == 8


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda value: value["proposed_span"].update(last_word_id="word_999999"), "unknown"),
        (lambda value: value["proposed_span"].update(first_word_id="word_000030", last_word_id="word_000001"), "reversed"),
        (lambda value: value["evidence_spans"][0].update(first_word_id="word_000031", last_word_id="word_000035"), "outside"),
        (lambda value: value["proposed_span"].update(last_word_id="word_000010"), "20 and 120"),
    ],
)
def test_semantic_validation_rejects_bad_references_evidence_and_duration(mutation, match):
    artifact = transcript((40,))
    window = build_windows(artifact)[0]
    value = suggestion()
    mutation(value)
    with pytest.raises(ValueError, match=match):
        validate_window_response(
            {"suggestions": [value]}, window=window, transcript=artifact,
            max_suggestions=10,
        )


def test_overlong_cross_window_and_duplicate_provider_ids_are_rejected():
    artifact = transcript((100,) * 18)
    windows = build_windows(artifact)
    with pytest.raises(ValueError, match="120"):
        validate_window_response(
            {"suggestions": [suggestion(last="word_000130")]},
            window=windows[0], transcript=artifact, max_suggestions=10,
        )
    with pytest.raises(ValueError, match="outside the window"):
        validate_window_response(
            {"suggestions": [suggestion(first="word_000001", last="word_000030")]},
            window=windows[1], transcript=artifact, max_suggestions=10,
        )
    with pytest.raises(ValueError, match="duplicated"):
        validate_window_response(
            {"suggestions": [suggestion(), suggestion()]},
            window=windows[0], transcript=artifact, max_suggestions=10,
        )


def test_retry_is_bounded_injectable_and_feedback_is_structured(tmp_path):
    invalid = suggestion()
    invalid["proposed_span"]["last_word_id"] = "word_000010"
    delays = []
    request, provider, progress, result = run(
        tmp_path,
        [{"suggestions": [invalid]}, {"suggestions": [invalid]}, {"suggestions": [suggestion()]}],
        retry_delay=delays.append,
    )
    assert result.artifact["candidates"][0]["id"] == "clip_001"
    assert delays == [1.0, 2.0]
    assert len(provider.requests) == 3
    second = json.loads(provider.requests[1]["messages"][1]["content"])
    assert "validation_feedback" in second
    assert [event["phase"] for event in progress].count("provider_attempt") == 3
    assert request["options"] == {"provider": "openrouter", "model": "openai/gpt-test"}


def test_nonretryable_provider_failure_stops_after_one_call_and_is_redacted(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret-value")
    artifact = transcript()
    request = project(tmp_path, artifact)
    provider = FakeProvider([
        ProviderError("provider_authentication_failed", "authentication failed", False)
    ])
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "provider_authentication_failed"
    assert len(provider.requests) == 1
    assert "secret-value" not in json.dumps(captured.value.payload())


def test_api_key_never_enters_artifact_cache_progress_or_request(tmp_path, monkeypatch):
    secret = "live-shaped-secret-that-must-not-persist"
    monkeypatch.setenv("OPENROUTER_API_KEY", secret)
    request, _, progress, result = run(
        tmp_path, [{"suggestions": [suggestion()]}],
    )
    assert secret not in json.dumps(request)
    assert secret not in json.dumps(progress)
    assert secret not in json.dumps(result.artifact)
    for path in tmp_path.rglob("*.json"):
        assert secret not in path.read_text(encoding="utf-8")


def test_provider_output_containing_api_key_is_retried_redacted_and_never_persisted(
    tmp_path, monkeypatch
):
    secret = "provider-must-not-echo-this-key"
    monkeypatch.setenv("OPENROUTER_API_KEY", secret)
    leaked = suggestion()
    leaked["title"] = secret
    request = project(tmp_path, transcript())
    provider = FakeProvider([{"suggestions": [leaked]}] * 3)
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "candidate_provider_retries_exhausted"
    assert secret not in json.dumps(captured.value.payload())
    assert not (tmp_path / CANDIDATE_ARTIFACT_RELATIVE_PATH).exists()
    for path in tmp_path.rglob("*.json"):
        assert secret not in path.read_text(encoding="utf-8")


def test_cancellation_between_retry_attempts_stops_without_sleep_or_second_call(tmp_path):
    artifact = transcript()
    request = project(tmp_path, artifact)
    state = {"cancel": False, "calls": 0}

    class CancellingProvider(FakeProvider):
        def structured(self, structured_request):
            state["calls"] += 1
            state["cancel"] = True
            invalid = suggestion()
            invalid["proposed_span"]["last_word_id"] = "word_000010"
            return {"suggestions": [invalid]}

    delays = []
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(
            request, provider=CancellingProvider([]),
            cancelled=lambda: state["cancel"], retry_delay=delays.append,
        )
    assert captured.value.code == "candidate_generation_cancelled"
    assert state["calls"] == 1
    assert delays == []


def test_empty_results_complete_honestly_and_final_cache_hit_does_not_rewrite(tmp_path):
    request, provider, _, first = run(tmp_path, [{"suggestions": []}])
    assert first.artifact["outcome"] == "no_candidates_found"
    assert first.artifact["candidates"] == []
    before = first.path.read_bytes()
    mtime = first.path.stat().st_mtime_ns
    forbidden = FakeProvider([])
    second = generate_candidates(request, provider=forbidden, retry_delay=lambda _seconds: None)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert second.path.stat().st_mtime_ns == mtime
    assert forbidden.requests == []
    assert len(provider.requests) == 1


def test_per_window_resume_reuses_preserved_success_after_later_failure(tmp_path):
    artifact = transcript((100,) * 18)
    request = project(tmp_path, artifact)
    first_provider = FakeProvider([
        {"suggestions": [suggestion("first", "word_000001", "word_000030")]},
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
    ])
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=first_provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "candidate_provider_retries_exhausted"
    assert len(first_provider.requests) == 4
    assert not (tmp_path / CANDIDATE_ARTIFACT_RELATIVE_PATH).exists()

    second_provider = FakeProvider([
        {"suggestions": [suggestion("second", "word_001301", "word_001330")]},
    ])
    progress = []
    result = generate_candidates(
        request, provider=second_provider, progress=progress.append,
        retry_delay=lambda _seconds: None,
        clock=lambda: datetime(2026, 8, 2, tzinfo=timezone.utc),
    )
    assert len(second_provider.requests) == 1
    assert any(event["phase"] == "window_cache_hit" for event in progress)
    assert [item["provider_suggestion_id"] for item in result.artifact["candidates"]] == [
        "first", "second",
    ]


def test_auto_classification_cache_resumes_without_repeating_paid_call(tmp_path):
    artifact = transcript((100,) * 18)
    request = project(tmp_path, artifact, content_type="auto")
    classification = {
        "content_type": "lecture", "evidence_word_ids": ["word_000001"],
        "reason": "The speaker teaches a topic",
    }
    first_provider = FakeProvider([
        classification,
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
    ])
    with pytest.raises(CandidateGenerationError):
        generate_candidates(request, provider=first_provider, retry_delay=lambda _seconds: None)
    assert len(first_provider.requests) == 4

    second_provider = FakeProvider([
        {"suggestions": []}, {"suggestions": []},
    ])
    progress = []
    result = generate_candidates(
        request, provider=second_provider, progress=progress.append,
        retry_delay=lambda _seconds: None,
    )
    assert result.artifact["classification"]["content_type"] == "lecture"
    assert len(second_provider.requests) == 2
    assert any(event["phase"] == "classification_cache_hit" for event in progress)


def test_cache_key_changes_for_model_count_content_transcript_and_source(tmp_path):
    keys = []
    cases = [
        ("baseline", transcript(), "podcast", 5, "openai/gpt-test"),
        ("model", transcript(), "podcast", 5, "openai/other"),
        ("count", transcript(), "podcast", 6, "openai/gpt-test"),
        ("content", transcript(), "lecture", 5, "openai/gpt-test"),
        (
            "transcript", transcript(cache_key="sha256:" + "c" * 64),
            "podcast", 5, "openai/gpt-test",
        ),
        (
            "source", transcript(fingerprint="sha256:" + "d" * 64),
            "podcast", 5, "openai/gpt-test",
        ),
    ]
    for name, artifact, content_type, count, model in cases:
        case_dir = tmp_path / name
        case_dir.mkdir()
        request = project(
            case_dir, artifact, content_type=content_type,
            requested_clip_count=count,
        )
        request["options"]["model"] = model
        provider = FakeProvider([{"suggestions": []}])
        provider.model_id = model
        result = generate_candidates(
            request, provider=provider, retry_delay=lambda _seconds: None,
        )
        assert len(provider.requests) == 1
        keys.append(result.artifact["cache_key"])
    assert len(keys) == len(set(keys))


def test_missing_stale_no_speech_and_invalid_options_fail_before_provider(tmp_path):
    no_speech = transcript((), speech=False)
    request = project(tmp_path, no_speech)
    provider = FakeProvider([])
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=provider)
    assert captured.value.code == "candidate_no_speech"
    assert provider.requests == []

    factory_calls = []
    with pytest.raises(CandidateGenerationError) as no_speech_error:
        generate_candidates(
            request,
            provider_factory=lambda *_args: factory_calls.append(True),
        )
    assert no_speech_error.value.code == "candidate_no_speech"
    assert factory_calls == []

    speech = transcript()
    request = project(tmp_path, speech)
    manifest = json.loads((tmp_path / "repurpose.json").read_text())
    manifest["source"]["fingerprint"] = "sha256:" + "c" * 64
    (tmp_path / "repurpose.json").write_text(json.dumps(manifest))
    with pytest.raises(CandidateGenerationError) as stale:
        generate_candidates(request, provider=provider)
    assert stale.value.code == "candidate_transcript_stale"

    request = project(tmp_path, speech)
    request["options"].pop("model")
    with pytest.raises(ContractValidationError, match="explicit model"):
        generate_candidates(request, provider=provider)
    assert provider.requests == []


def test_cancellation_before_provider_has_stable_error_and_preserves_prior(tmp_path):
    artifact = transcript()
    request = project(tmp_path, artifact)
    prior = tmp_path / CANDIDATE_ARTIFACT_RELATIVE_PATH
    prior.write_text("prior-valid-bytes")
    provider = FakeProvider([])
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=provider, cancelled=lambda: True)
    assert captured.value.code == "candidate_generation_cancelled"
    assert prior.read_text() == "prior-valid-bytes"
    assert provider.requests == []


def test_atomic_replace_failure_preserves_prior_candidate_artifact_and_removes_temp(tmp_path):
    _, _, _, result = run(tmp_path, [{"suggestions": [suggestion()]}])
    previous = result.path.read_bytes()
    changed = deepcopy(result.artifact)
    changed["created_at"] = "2026-08-03T00:00:00Z"

    def fail_replace(_source, _destination):
        raise OSError("simulated atomic replacement failure")

    with pytest.raises(OSError):
        write_candidate_artifact(tmp_path, changed, replace=fail_replace)
    assert result.path.read_bytes() == previous
    assert list(result.path.parent.glob(".*.tmp")) == []


def test_atomic_cache_write_failure_is_terminal_and_never_creates_final_artifact(
    tmp_path, monkeypatch
):
    artifact = transcript()
    request = project(tmp_path, artifact)
    provider = FakeProvider([{"suggestions": [suggestion()]}])

    def fail_cache(_path, _document, **_kwargs):
        raise OSError("cache disk full")

    monkeypatch.setattr(generation, "_atomic_json", fail_cache)
    with pytest.raises(CandidateGenerationError) as captured:
        generate_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "candidate_cache_write_failed"
    assert not (tmp_path / CANDIDATE_ARTIFACT_RELATIVE_PATH).exists()
