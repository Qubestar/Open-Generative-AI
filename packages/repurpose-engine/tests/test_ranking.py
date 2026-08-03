from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest

import vidmyo_repurpose.ranking as ranking
from vidmyo_repurpose.candidate_providers import ProviderError
from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.ranking import (
    RANKING_ARTIFACT_RELATIVE_PATH,
    RankingError,
    duration_fitness,
    evidence_quality,
    group_duplicates,
    rank_candidates,
    select_shortlist,
    validate_window_scores,
    write_ranking_artifact,
)

FIXTURES = Path(__file__).parent / "fixtures"
SHA_A = "sha256:" + "a" * 64
SHA_B = "sha256:" + "b" * 64
SHA_C = "sha256:" + "c" * 64


class FakeProvider:
    provider_id = "openrouter"
    model_id = "openai/gpt-test"

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def structured(self, request):
        self.requests.append(deepcopy(request))
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return deepcopy(value)


def transcript(word_count=500, *, confidence=0.8):
    words = []
    ids = []
    for index in range(1, word_count + 1):
        word_id = f"word_{index:06d}"
        ids.append(word_id)
        words.append({
            "id": word_id, "segment_id": "segment_000001",
            "start_seconds": float(index - 1), "end_seconds": index - 0.1,
            "text": f"word{index}", "confidence": confidence,
        })
    artifact = {
        "artifact_version": 1, "engine_version": "0.1.0", "created_at": "2026-08-03T00:00:00Z",
        "source": {"path": "/source.mp4", "fingerprint": SHA_A}, "cache_key": SHA_B,
        "transcription": {
            "engine": "faster-whisper", "library_version": "1.2.1", "model": "small",
            "device": "cpu", "compute_type": "int8", "word_timestamps": True,
            "requested_language": None, "detected_language": "en", "language_confidence": 0.9,
        },
        "duration_seconds": float(word_count), "speech_detected": True,
        "segments": [{
            "id": "segment_000001", "start_seconds": 0.0, "end_seconds": word_count - 0.1,
            "text": " ".join(word["text"] for word in words), "confidence": confidence,
            "word_ids": ids,
        }],
        "words": words,
    }
    return validate_document("transcript_artifact", artifact)


def candidate(candidate_id, first, last, *, window="window_000001", title=None):
    start, end = float(first - 1), last - 0.1
    span = {
        "first_word_id": f"word_{first:06d}", "last_word_id": f"word_{last:06d}",
        "start_seconds": start, "end_seconds": end,
        "text": " ".join(f"word{index}" for index in range(first, last + 1)),
    }
    return {
        "id": candidate_id, "provider_suggestion_id": f"provider-{candidate_id}",
        "window_id": window, "title": title or candidate_id, "hook": "Clear hook",
        "summary": "Standalone summary", "selection_reason": "Complete payoff",
        "signal_types": ["claim"], "proposed_span": span, "evidence_spans": [dict(span)],
    }


def candidate_artifact(items):
    windows = []
    for window_id in sorted({item["window_id"] for item in items}):
        members = [item for item in items if item["window_id"] == window_id]
        first = min(int(item["proposed_span"]["first_word_id"].split("_")[1]) for item in members)
        last = max(int(item["proposed_span"]["last_word_id"].split("_")[1]) for item in members)
        windows.append({
            "id": window_id, "segment_ids": ["segment_000001"],
            "first_word_id": f"word_{first:06d}", "last_word_id": f"word_{last:06d}",
            "word_count": last - first + 1, "start_seconds": float(first - 1),
            "end_seconds": last - 0.1,
        })
    artifact = {
        "artifact_version": 1, "engine_version": "0.1.0", "created_at": "2026-08-03T00:00:00Z",
        "versions": {
            "schema": "candidate-artifact.v1", "prompt": "candidate-prompt.v1",
            "classification": "content-classification.v1", "windowing": "transcript-windowing.v1",
        },
        "source": {"fingerprint": SHA_A, "transcript_cache_key": SHA_B},
        "provider": {"id": "openrouter", "model": "openai/gpt-test"},
        "generation_settings": {
            "requested_clip_count": 3, "content_type": "podcast",
            "minimum_duration_seconds": 20.0, "maximum_duration_seconds": 120.0,
            "target_window_words": 1500, "overlap_words": 300,
            "max_suggestions_per_window": 10, "temperature": 0.0,
            "structured_output": True, "streaming": False,
        },
        "cache_key": SHA_C,
        "classification": {
            "content_type": "podcast", "source": "project_override",
            "evidence_word_ids": [], "reason": "Explicit type",
        },
        "windows": windows, "outcome": "candidates_generated", "candidates": items,
    }
    return validate_document("candidate_artifact", artifact)


def setup_project(tmp_path: Path, items):
    tx = transcript()
    artifact = candidate_artifact(items)
    manifest = json.loads((FIXTURES / "valid-project-manifest.json").read_text())
    manifest["source"] = {"type": "local_file", "uri": "/source.mp4", "fingerprint": SHA_A}
    manifest["requested_clip_count"] = 3
    for name in manifest["stages"]:
        manifest["stages"][name] = {"state": "pending", "artifact": None, "error": None}
    manifest["stages"]["ingest"] = {
        "state": "completed", "artifact": "artifacts/ingest-artifact.v1.json", "error": None,
    }
    manifest["stages"]["transcribe"] = {
        "state": "completed", "artifact": "artifacts/transcript-artifact.v1.json", "error": None,
    }
    manifest["stages"]["generate_candidates"] = {
        "state": "completed", "artifact": "artifacts/candidate-artifact.v1.json", "error": None,
    }
    manifest["candidates"] = []
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir(parents=True)
    (tmp_path / "repurpose.json").write_text(json.dumps(manifest))
    (artifact_dir / "transcript-artifact.v1.json").write_text(json.dumps(tx))
    (artifact_dir / "candidate-artifact.v1.json").write_text(json.dumps(artifact))
    request = {
        "protocol_version": 1, "job_id": "job_ranking_test", "project_dir": str(tmp_path),
        "stage": "rank",
        "input_artifacts": [
            {"kind": "transcript_artifact", "path": "artifacts/transcript-artifact.v1.json", "version": 1},
            {"kind": "candidate_artifact", "path": "artifacts/candidate-artifact.v1.json", "version": 1},
        ],
        "options": {},
    }
    return request, tx


def judgment(item, score=80, *, topic="topic", claim=None, coherence=None, context=None):
    evidence = [item["proposed_span"]["first_word_id"]]
    result = {"candidate_id": item["id"]}
    for name in (
        "hook_strength", "standalone_coherence", "information_value_novelty",
        "narrative_arc_payoff", "context_independence",
    ):
        value = score
        if name == "standalone_coherence" and coherence is not None:
            value = coherence
        if name == "context_independence" and context is not None:
            value = context
        result[name] = {"score": value, "reason": f"Evidence for {name}", "evidence_word_ids": evidence}
    result["topic_label"] = topic
    result["semantic_claim"] = claim or f"Distinct claim for {item['id']}"
    return result


def response(*judgments):
    return {"scores": list(judgments)}


def run(tmp_path, items, responses):
    request, tx = setup_project(tmp_path, items)
    provider = FakeProvider(responses)
    progress = []
    result = rank_candidates(
        request, provider=provider, progress=progress.append,
        retry_delay=lambda _seconds: None,
        clock=lambda: datetime(2026, 8, 3, tzinfo=timezone.utc),
    )
    return request, tx, provider, progress, result


def test_duration_and_evidence_formulas_are_deterministic():
    assert duration_fitness(20) == 60
    assert duration_fitness(25) == 80
    assert duration_fitness(30) == 100
    assert duration_fitness(90) == 100
    assert duration_fitness(105) == 80
    assert duration_fitness(120) == 60
    with pytest.raises(ValueError):
        duration_fitness(121)
    item = candidate("clip_001", 1, 30)
    assert evidence_quality(item, transcript(confidence=0.8)) == 80
    missing = transcript(confidence=None)
    assert evidence_quality(item, missing) == 50


def test_structured_validation_requires_every_candidate_and_in_span_ordered_evidence():
    tx = transcript()
    item = candidate("clip_001", 1, 30)
    valid = judgment(item)
    assert validate_window_scores(response(valid), [item], tx)[0]["topic_label"] == "topic"
    invalid = deepcopy(valid)
    invalid["hook_strength"]["evidence_word_ids"] = ["word_000031"]
    with pytest.raises(ValueError, match="outside candidate span"):
        validate_window_scores(response(invalid), [item], tx)
    with pytest.raises(ValueError, match="too short|every candidate"):
        validate_window_scores(response(valid), [item, candidate("clip_002", 40, 70)], tx)


def test_end_to_end_weights_ranks_gates_duplicates_and_retains_every_candidate(tmp_path):
    items = [
        candidate("clip_001", 1, 40),
        candidate("clip_002", 5, 44),
        candidate("clip_003", 200, 239),
        candidate("clip_004", 300, 339),
    ]
    request, _, provider, progress, result = run(tmp_path, items, [response(
        judgment(items[0], 90, topic="AI News", claim="models improve coding quality quickly"),
        judgment(items[1], 95, topic="ai news", claim="models improve coding quality quickly"),
        judgment(items[2], 80, topic="AI News", claim="a separate product launch story"),
        judgment(items[3], 75, topic="business", coherence=39),
    )])
    artifact = result.artifact
    assert len(artifact["candidates"]) == 4
    assert artifact["candidates"][0]["candidate"]["id"] == "clip_002"
    assert artifact["candidates"][0]["clip_potential"] == 94.8
    by_id = {item["candidate"]["id"]: item for item in artifact["candidates"]}
    assert by_id["clip_001"]["near_duplicate_of"] == "clip_002"
    assert by_id["clip_004"]["hard_gate"]["passed"] is False
    assert "clip_001" not in artifact["shortlist_candidate_ids"]
    assert "clip_004" not in artifact["shortlist_candidate_ids"]
    assert artifact["shortlist_candidate_ids"][0] == "clip_002"
    assert by_id["clip_003"]["diversity"]["repeated_topic_penalty"] == 12
    assert validate_document("ranking_artifact", artifact) is artifact
    serialized = json.dumps(artifact)
    for forbidden in ('"approved"', '"selected"', '"render_output"', '"boundary_repair"'):
        assert forbidden not in serialized
    assert request["options"] == {}
    assert len(provider.requests) == 1
    assert any(event["phase"] == "ranking_completed" for event in progress)


def test_overall_rank_tie_breaks_by_candidate_id(tmp_path):
    items = [candidate("clip_001", 1, 30), candidate("clip_002", 300, 329)]
    _, _, _, _, result = run(
        tmp_path, items, [response(judgment(items[0], 80), judgment(items[1], 80))]
    )
    assert [item["candidate"]["id"] for item in result.artifact["candidates"]] == [
        "clip_001", "clip_002",
    ]
    assert [item["overall_rank"] for item in result.artifact["candidates"]] == [1, 2]


def test_transitive_temporal_duplicates_and_leader_tie_break_are_stable():
    def entry(candidate_id, first, last):
        item = candidate(candidate_id, first, last)
        return {
            "candidate": item, "topic_label": candidate_id, "semantic_claim": candidate_id,
            "clip_potential": 80.0, "hard_gate": {"passed": True, "exclusion_reasons": []},
            "shortlist_exclusion_reasons": [],
            "duplicate_group_id": None, "near_duplicate_of": None,
        }
    entries = [entry("clip_001", 1, 40), entry("clip_002", 6, 45), entry("clip_003", 11, 50)]
    groups = group_duplicates(entries)
    assert groups == [{
        "id": "duplicate_group_001", "leader_candidate_id": "clip_001",
        "member_candidate_ids": ["clip_001", "clip_002", "clip_003"],
    }]
    assert entries[1]["near_duplicate_of"] == "clip_001"
    assert entries[2]["near_duplicate_of"] == "clip_001"


def test_semantic_duplicate_threshold_and_shortlist_diversity_are_fixed():
    def entry(candidate_id, first, topic, claim, potential):
        return {
            "candidate": candidate(candidate_id, first, first + 29),
            "topic_label": topic, "semantic_claim": claim, "clip_potential": potential,
            "hard_gate": {"passed": True, "exclusion_reasons": []},
            "shortlist_exclusion_reasons": [],
            "duplicate_group_id": None, "near_duplicate_of": None,
            "diversity": {}, "shortlist_order": None, "recommended": False,
        }
    duplicates = [
        entry("clip_001", 1, "ai", "one two three four five", 90),
        entry("clip_002", 300, "ai", "one two three four five six", 89),
    ]
    assert group_duplicates(duplicates)[0]["leader_candidate_id"] == "clip_001"
    choices = [
        entry("clip_001", 1, "ai", "first", 90),
        entry("clip_002", 400, "ai", "second", 89),
        entry("clip_003", 410, "business", "third", 88),
    ]
    assert select_shortlist(choices, 2, 1000) == ["clip_001", "clip_003"]
    assert choices[2]["diversity"]["nearby_time_penalty"] == 0


def test_retry_feedback_is_bounded_and_invalid_evidence_is_not_silently_repaired(tmp_path):
    item = candidate("clip_001", 1, 30)
    invalid = judgment(item)
    invalid["hook_strength"]["evidence_word_ids"] = ["word_000031"]
    _, _, provider, progress, result = run(
        tmp_path, [item], [response(invalid), response(invalid), response(judgment(item))]
    )
    assert result.artifact["candidates"][0]["candidate"]["id"] == "clip_001"
    assert len(provider.requests) == 3
    logical = json.loads(provider.requests[1]["messages"][1]["content"])
    assert "validation_feedback" in logical
    assert [event["phase"] for event in progress].count("provider_attempt") == 3


def test_nonretryable_provider_error_and_secret_output_are_redacted(tmp_path, monkeypatch):
    item = candidate("clip_001", 1, 30)
    request, _ = setup_project(tmp_path, [item])
    provider = FakeProvider([ProviderError("provider_authentication_failed", "no access", False)])
    with pytest.raises(RankingError) as captured:
        rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "provider_authentication_failed"
    assert len(provider.requests) == 1

    secret = "ranking-secret-must-not-persist"
    monkeypatch.setenv("OPENROUTER_API_KEY", secret)
    leaked = judgment(item)
    leaked["semantic_claim"] = secret
    provider = FakeProvider([response(leaked)] * 3)
    with pytest.raises(RankingError) as leaked_error:
        rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert leaked_error.value.code == "ranking_provider_retries_exhausted"
    assert secret not in json.dumps(leaked_error.value.payload())
    assert not (tmp_path / RANKING_ARTIFACT_RELATIVE_PATH).exists()


def test_final_cache_hit_reuses_without_provider_call_or_rewrite(tmp_path):
    item = candidate("clip_001", 1, 30)
    request, _, _, _, first = run(tmp_path, [item], [response(judgment(item))])
    before, mtime = first.path.read_bytes(), first.path.stat().st_mtime_ns
    provider = FakeProvider([])
    second = rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert second.cache_hit is True
    assert second.path.read_bytes() == before
    assert second.path.stat().st_mtime_ns == mtime
    assert provider.requests == []

    tampered = json.loads(second.path.read_text())
    tampered["candidates"][0]["candidate"]["title"] = "tampered"
    second.path.write_text(json.dumps(tampered))
    rebuilt = rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert rebuilt.cache_hit is False
    assert rebuilt.artifact["candidates"][0]["candidate"]["title"] == "clip_001"
    assert provider.requests == []


def test_final_cache_rejects_schema_valid_but_wrong_shortlist(tmp_path):
    items = [
        candidate("clip_001", 1, 30),
        candidate("clip_002", 200, 229),
    ]
    request, _ = setup_project(tmp_path, items)
    manifest_path = tmp_path / "repurpose.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["requested_clip_count"] = 1
    manifest_path.write_text(json.dumps(manifest))
    candidate_path = tmp_path / "artifacts" / "candidate-artifact.v1.json"
    candidate_document = json.loads(candidate_path.read_text())
    candidate_document["generation_settings"]["requested_clip_count"] = 1
    candidate_path.write_text(json.dumps(candidate_document))
    provider = FakeProvider([
        response(judgment(items[0], score=90), judgment(items[1], score=70)),
    ])
    first = rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert first.artifact["shortlist_candidate_ids"] == ["clip_001"]

    tampered = json.loads(first.path.read_text())
    by_id = {item["candidate"]["id"]: item for item in tampered["candidates"]}
    stronger, weaker = by_id["clip_001"], by_id["clip_002"]
    stronger["recommended"] = False
    stronger["shortlist_order"] = None
    stronger["diversity"] = {
        "adjusted_score": None,
        "repeated_topic_penalty": 0.0,
        "nearby_time_penalty": 0.0,
    }
    stronger["shortlist_exclusion_reasons"] = [
        "Not included because the requested advisory shortlist count was reached."
    ]
    weaker["recommended"] = True
    weaker["shortlist_order"] = 1
    weaker["diversity"] = {
        "adjusted_score": weaker["clip_potential"],
        "repeated_topic_penalty": 0.0,
        "nearby_time_penalty": 0.0,
    }
    weaker["shortlist_exclusion_reasons"] = []
    tampered["shortlist_candidate_ids"] = ["clip_002"]
    validate_document("ranking_artifact", tampered)
    first.path.write_text(json.dumps(tampered))

    cached_provider = FakeProvider([])
    rebuilt = rank_candidates(
        request, provider=cached_provider, retry_delay=lambda _seconds: None
    )
    assert rebuilt.cache_hit is False
    assert rebuilt.artifact["shortlist_candidate_ids"] == ["clip_001"]
    assert cached_provider.requests == []

def test_per_window_resume_reuses_success_and_semantic_change_invalidates(tmp_path):
    items = [
        candidate("clip_001", 1, 30, window="window_000001"),
        candidate("clip_002", 200, 229, window="window_000002"),
    ]
    request, _ = setup_project(tmp_path, items)
    first_provider = FakeProvider([
        response(judgment(items[0])),
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
        ProviderError("provider_temporary_failure", "temporary", True),
    ])
    with pytest.raises(RankingError):
        rank_candidates(request, provider=first_provider, retry_delay=lambda _seconds: None)
    second_provider = FakeProvider([response(judgment(items[1]))])
    progress = []
    result = rank_candidates(
        request, provider=second_provider, progress=progress.append,
        retry_delay=lambda _seconds: None,
    )
    assert len(result.artifact["candidates"]) == 2
    assert len(second_provider.requests) == 1
    assert any(event["phase"] == "window_cache_hit" for event in progress)

    request["options"] = {"model": "openai/other"}
    other = FakeProvider([response(judgment(items[0])), response(judgment(items[1]))])
    other.model_id = "openai/other"
    changed = rank_candidates(request, provider=other, retry_delay=lambda _seconds: None)
    assert changed.artifact["cache_key"] != result.artifact["cache_key"]
    assert len(other.requests) == 2


def test_changed_candidate_content_invalidates_final_and_window_scores(tmp_path):
    item = candidate("clip_001", 1, 30)
    request, _, _, _, first = run(tmp_path, [item], [response(judgment(item))])
    candidate_path = tmp_path / "artifacts" / "candidate-artifact.v1.json"
    artifact = json.loads(candidate_path.read_text())
    artifact["candidates"][0]["title"] = "Changed candidate title"
    candidate_path.write_text(json.dumps(artifact))
    provider = FakeProvider([response(judgment(artifact["candidates"][0]))])
    second = rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert second.cache_hit is False
    assert second.artifact["cache_key"] != first.artifact["cache_key"]
    assert len(provider.requests) == 1


def test_missing_stale_empty_and_bad_options_fail_before_provider(tmp_path):
    item = candidate("clip_001", 1, 30)
    request, _ = setup_project(tmp_path, [item])
    provider = FakeProvider([])
    request["input_artifacts"] = request["input_artifacts"][:1]
    with pytest.raises(RankingError, match="must name"):
        rank_candidates(request, provider=provider)
    assert provider.requests == []

    request, _ = setup_project(tmp_path / "stale", [item])
    candidate_path = tmp_path / "stale" / "artifacts" / "candidate-artifact.v1.json"
    artifact = json.loads(candidate_path.read_text())
    artifact["source"]["transcript_cache_key"] = "sha256:" + "d" * 64
    candidate_path.write_text(json.dumps(artifact))
    with pytest.raises(RankingError) as stale:
        rank_candidates(request, provider=provider)
    assert stale.value.code == "ranking_input_stale"

    request, _ = setup_project(tmp_path / "options", [item])
    request["options"] = {"provider": "other"}
    with pytest.raises(ContractValidationError, match="unsupported ranking option"):
        rank_candidates(request, provider=provider)
    assert provider.requests == []


def test_cancellation_and_writer_failure_preserve_prior_artifact(tmp_path):
    item = candidate("clip_001", 1, 30)
    request, _ = setup_project(tmp_path, [item])
    prior = tmp_path / RANKING_ARTIFACT_RELATIVE_PATH
    prior.write_text("prior bytes")
    provider = FakeProvider([])
    with pytest.raises(RankingError) as captured:
        rank_candidates(request, provider=provider, cancelled=lambda: True)
    assert captured.value.code == "ranking_cancelled"
    assert prior.read_text() == "prior bytes"
    assert provider.requests == []

    provider = FakeProvider([response(judgment(item))])
    with pytest.raises(RankingError) as write_error:
        rank_candidates(
            request, provider=provider, retry_delay=lambda _seconds: None,
            writer=lambda *_args: (_ for _ in ()).throw(OSError("disk full")),
        )
    assert write_error.value.code == "ranking_artifact_write_failed"
    assert prior.read_text() == "prior bytes"


def test_atomic_replace_and_cache_write_failures_preserve_prior_state(tmp_path, monkeypatch):
    item = candidate("clip_001", 1, 30)
    _, _, _, _, result = run(tmp_path, [item], [response(judgment(item))])
    before = result.path.read_bytes()
    changed = deepcopy(result.artifact)
    changed["created_at"] = "2026-08-04T00:00:00Z"

    def fail_replace(_source, _destination):
        raise OSError("simulated atomic replacement failure")

    with pytest.raises(OSError):
        write_ranking_artifact(tmp_path, changed, replace=fail_replace)
    assert result.path.read_bytes() == before
    assert list(result.path.parent.glob(".*.tmp")) == []

    cache_dir = tmp_path / "cache-failure"
    request, _ = setup_project(cache_dir, [item])
    provider = FakeProvider([response(judgment(item))])
    original_atomic = ranking._atomic_json

    def fail_cache(path, document, **kwargs):
        if ".cache" in path.parts:
            raise OSError("cache disk full")
        return original_atomic(path, document, **kwargs)

    monkeypatch.setattr(ranking, "_atomic_json", fail_cache)
    with pytest.raises(RankingError) as captured:
        rank_candidates(request, provider=provider, retry_delay=lambda _seconds: None)
    assert captured.value.code == "ranking_cache_write_failed"
    assert not (cache_dir / RANKING_ARTIFACT_RELATIVE_PATH).exists()
