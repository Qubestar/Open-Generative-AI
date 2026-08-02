from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

import vidmyo_repurpose.transcribe as transcription
from vidmyo_repurpose.contracts import ContractValidationError, validate_document
from vidmyo_repurpose.ingest import fingerprint_file
from vidmyo_repurpose.transcribe import (
    MODEL_READY_MARKER,
    TRANSCRIPT_ARTIFACT_RELATIVE_PATH,
    TranscriptionError,
    inspect_model,
    normalize_segments,
    normalize_settings,
    setup_model,
    transcribe_project,
    write_transcript_artifact,
)

FIXTURES = Path(__file__).parent / "fixtures"


def make_project(tmp_path: Path, *, options: dict | None = None) -> tuple[dict, Path]:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"stable local source")
    fingerprint = fingerprint_file(source)
    manifest = json.loads((FIXTURES / "valid-project-manifest.json").read_text(encoding="utf-8"))
    manifest["source"] = {
        "type": "local_file", "uri": str(source), "fingerprint": fingerprint,
    }
    manifest["stages"] = {
        name: {"state": "pending", "artifact": None, "error": None}
        for name in manifest["stages"]
    }
    manifest["stages"]["ingest"] = {
        "state": "completed", "artifact": "artifacts/ingest-artifact.v1.json", "error": None,
    }
    manifest["candidates"] = []
    (tmp_path / "repurpose.json").write_text(json.dumps(manifest), encoding="utf-8")
    artifact = {
        "artifact_version": 1,
        "engine_version": "0.1.0",
        "source": {
            "path": str(source), "byte_size": source.stat().st_size, "fingerprint": fingerprint,
        },
        "container": {
            "format_names": ["mp4"], "format_long_name": "MP4", "duration_seconds": 10.0,
        },
        "video": {
            "codec_name": "h264", "width": 320, "height": 180,
            "average_frame_rate": 24.0, "real_frame_rate": 24.0,
            "duration_seconds": 10.0,
        },
        "audio": {
            "codec_name": "aac", "sample_rate_hz": 48000, "channels": 2,
            "channel_layout": "stereo", "duration_seconds": 10.0,
        },
    }
    artifact_path = tmp_path / "artifacts" / "ingest-artifact.v1.json"
    artifact_path.parent.mkdir(exist_ok=True)
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
    model_cache = tmp_path / "models"
    request = {
        "protocol_version": 1,
        "job_id": "job_transcribe_test",
        "project_dir": str(tmp_path),
        "stage": "transcribe",
        "input_artifacts": [{
            "kind": "ingest_artifact", "path": "artifacts/ingest-artifact.v1.json", "version": 1,
        }],
        "options": {"model_cache": str(model_cache), **(options or {})},
    }
    return request, source


def fake_segments() -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            start=0.2, end=2.0, text="  Hello   world ", avg_logprob=-0.1,
            words=[
                SimpleNamespace(start=0.2, end=0.7, word=" Hello", probability=0.95),
                SimpleNamespace(start=0.8, end=1.4, word=" world ", probability=0.9),
            ],
        ),
        SimpleNamespace(
            start=2.1, end=3.0, text="Again", avg_logprob=-0.2,
            words=[SimpleNamespace(start=2.1, end=2.8, word=" Again", probability=0.8)],
        ),
    ]


class FakeModel:
    def __init__(self, segments=None, info=None, error: Exception | None = None):
        self.segments = fake_segments() if segments is None else segments
        self.info = info or SimpleNamespace(language="pl", language_probability=0.87)
        self.error = error
        self.calls = []

    def transcribe(self, path: str, **kwargs):
        self.calls.append((path, kwargs))
        if self.error:
            raise self.error
        return iter(self.segments), self.info


def ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        transcription,
        "inspect_model",
        lambda model, cache: {
            "model_ready": True, "setup_command": None, "model": model, "model_cache": str(cache),
        },
    )


def run_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kwargs):
    request, source = make_project(tmp_path, options=kwargs.pop("options", None))
    ready(monkeypatch)
    model = kwargs.pop("model", FakeModel())
    progress = []
    result = transcribe_project(
        request,
        model_factory=lambda _path, _settings: model,
        progress=progress.append,
        clock=lambda: datetime(2026, 8, 2, tzinfo=timezone.utc),
        library_version=lambda: "1.2.1",
        **kwargs,
    )
    return request, source, model, progress, result


def test_default_and_validated_override_settings():
    defaults = normalize_settings({})
    assert defaults.cache_document() == {
        "model": "small", "language": None, "device": "cpu",
        "compute_type": "int8", "word_timestamps": True,
    }
    overrides = normalize_settings({
        "model": "medium", "language": "PL", "device": "cuda", "compute_type": "float16",
    })
    assert (overrides.model, overrides.language, overrides.device, overrides.compute_type) == (
        "medium", "pl", "cuda", "float16",
    )
    for options in (
        {"model": "../../escape"}, {"language": "?"}, {"device": "metal"},
        {"compute_type": "mystery"}, {"unexpected": True},
    ):
        with pytest.raises(ContractValidationError):
            normalize_settings(options)


def test_transcription_normalizes_multilingual_words_metadata_and_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _, source, model, progress, result = run_success(tmp_path, monkeypatch)
    artifact = result.artifact
    assert result.cache_hit is False
    assert artifact["source"] == {
        "path": str(source), "fingerprint": fingerprint_file(source),
    }
    assert artifact["transcription"] == {
        "engine": "faster-whisper", "library_version": "1.2.1", "model": "small",
        "device": "cpu", "compute_type": "int8", "word_timestamps": True,
        "requested_language": None, "detected_language": "pl", "language_confidence": 0.87,
    }
    assert [segment["id"] for segment in artifact["segments"]] == [
        "segment_000001", "segment_000002",
    ]
    assert [word["id"] for word in artifact["words"]] == [
        "word_000001", "word_000002", "word_000003",
    ]
    assert artifact["segments"][0]["word_ids"] == ["word_000001", "word_000002"]
    assert artifact["segments"][0]["text"] == "Hello world"
    assert artifact["speech_detected"] is True
    assert model.calls[0][1] == {"language": None, "word_timestamps": True}
    fractions = [event["fraction"] for event in progress]
    assert fractions == sorted(fractions)
    assert all(0 <= event["percent"] <= 100 for event in progress)
    assert all("processed_seconds" in event and "total_seconds" in event for event in progress)
    assert validate_document("transcript_artifact", artifact) is artifact


@pytest.mark.parametrize(
    "mutation,field",
    [
        (lambda value: value["segments"][0].update(end_seconds=-1), "segments.0.end_seconds"),
        (lambda value: value["segments"][1].update(start_seconds=0.1), "timestamps must be ordered"),
        (lambda value: value["words"][0].update(end_seconds=11), "exceeds source duration"),
        (lambda value: value["words"][0].update(segment_id="segment_999999"), "dangling"),
        (lambda value: value["segments"][0].update(word_ids=[]), "references"),
        (lambda value: value["segments"][1].update(id="segment_000001"), "sequential"),
    ],
)
def test_transcript_semantics_reject_bad_timestamps_ids_and_references(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation, field: str
):
    *_, result = run_success(tmp_path, monkeypatch)
    invalid = deepcopy(result.artifact)
    mutation(invalid)
    with pytest.raises(ContractValidationError, match=field):
        validate_document("transcript_artifact", invalid)


def test_doctor_is_read_only_and_provides_exact_setup_guidance(tmp_path: Path):
    cache = tmp_path / "does-not-exist"
    before = set(tmp_path.iterdir())
    result = inspect_model("small", cache)
    assert result["ok"] is False
    assert result["model"] == "small"
    assert result["model_cache"] == str(cache)
    assert result["setup_command"] in result["message"]
    assert set(tmp_path.iterdir()) == before


def test_setup_is_the_explicit_download_boundary_and_verifies_before_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    calls = []
    monkeypatch.setattr(transcription, "faster_whisper_version", lambda: "1.2.1")
    monkeypatch.setattr(transcription.importlib.util, "find_spec", lambda _name: object())

    def download(model: str, destination: Path):
        calls.append(("download", model))
        (destination / "config.json").write_text("{}", encoding="utf-8")
        (destination / "model.bin").write_bytes(b"model")

    def open_model(path: Path, **kwargs):
        calls.append(("open", path.name, kwargs))
        assert not (path / MODEL_READY_MARKER).exists()
        return object()

    progress = []
    result = setup_model(
        "small", tmp_path / "cache", download=download, open_model=open_model,
        progress=progress.append,
    )
    assert result["model_ready"] is True
    assert [call[0] for call in calls] == ["download", "open"]
    assert [event["phase"] for event in progress] == ["download", "verify", "ready"]
    assert (tmp_path / "cache" / "small" / MODEL_READY_MARKER).is_file()


def test_failed_setup_never_marks_an_incomplete_model_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(transcription, "faster_whisper_version", lambda: "1.2.1")
    monkeypatch.setattr(transcription.importlib.util, "find_spec", lambda _name: object())

    def download(_model: str, destination: Path):
        (destination / "config.json").write_text("{}", encoding="utf-8")
        raise OSError("network interrupted")

    with pytest.raises(TranscriptionError) as captured:
        setup_model("small", tmp_path / "cache", download=download)
    assert captured.value.code == "transcription_model_setup_failed"
    assert not (tmp_path / "cache" / "small" / MODEL_READY_MARKER).exists()


def test_missing_model_fails_before_factory_with_setup_guidance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    request, _ = make_project(tmp_path)
    called = False

    def factory(_path, _settings):
        nonlocal called
        called = True
        raise AssertionError("must not load")

    with pytest.raises(TranscriptionError) as captured:
        transcribe_project(request, model_factory=factory)
    assert captured.value.code == "transcription_model_not_ready"
    assert "setup-model" in captured.value.next_action
    assert called is False


def test_matching_cache_skips_model_and_does_not_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    request, _, _, _, first = run_success(tmp_path, monkeypatch)
    before = first.path.read_bytes()
    before_mtime = first.path.stat().st_mtime_ns

    def forbidden(_path, _settings):
        raise AssertionError("cache hit must not load model")

    progress = []
    second = transcribe_project(
        request, model_factory=forbidden, progress=progress.append,
        library_version=lambda: "not consulted",
    )
    assert second.cache_hit is True
    assert [event["phase"] for event in progress] == ["input_validation", "cache_hit"]
    assert second.path.read_bytes() == before
    assert second.path.stat().st_mtime_ns == before_mtime


def test_corrupt_cache_is_never_a_false_hit_and_is_replaced_only_after_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    request, _ = make_project(tmp_path)
    transcript = tmp_path / TRANSCRIPT_ARTIFACT_RELATIVE_PATH
    transcript.write_text('{"artifact_version":1', encoding="utf-8")
    ready(monkeypatch)
    progress = []
    result = transcribe_project(
        request, model_factory=lambda _path, _settings: FakeModel(),
        progress=progress.append, library_version=lambda: "1.2.1",
    )
    assert result.cache_hit is False
    assert all(event["phase"] != "cache_hit" for event in progress)
    assert validate_document(
        "transcript_artifact", json.loads(transcript.read_text(encoding="utf-8"))
    )


def test_changed_settings_miss_cache_but_failure_preserves_previous_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _, _, _, _, first = run_success(tmp_path, monkeypatch)
    before = first.path.read_bytes()
    request = json.loads(json.dumps(make_project(tmp_path, options={"language": "en"})[0]))
    ready(monkeypatch)
    with pytest.raises(TranscriptionError, match="boom") as captured:
        transcribe_project(
            request, model_factory=lambda _path, _settings: FakeModel(error=RuntimeError("boom")),
            library_version=lambda: "1.2.1",
        )
    assert captured.value.code == "transcription_inference_failed"
    assert first.path.read_bytes() == before


def test_source_drift_fails_before_model_inference(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    request, source = make_project(tmp_path)
    source.write_bytes(b"changed after ingest")
    called = False

    def factory(_path, _settings):
        nonlocal called
        called = True

    with pytest.raises(TranscriptionError) as captured:
        transcribe_project(request, model_factory=factory)
    assert captured.value.code == "source_changed_since_ingest"
    assert called is False
    assert not (tmp_path / TRANSCRIPT_ARTIFACT_RELATIVE_PATH).exists()


def test_source_change_during_inference_preserves_earlier_valid_transcript(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _, source, _, _, first = run_success(tmp_path, monkeypatch)
    previous = first.path.read_bytes()
    request, _ = make_project(tmp_path, options={"language": "en"})
    ready(monkeypatch)

    def changing_segments():
        yield fake_segments()[0]
        source.write_bytes(b"mutated during transcription")

    with pytest.raises(TranscriptionError) as captured:
        transcribe_project(
            request,
            model_factory=lambda _path, _settings: FakeModel(segments=changing_segments()),
            library_version=lambda: "1.2.1",
        )
    assert captured.value.code == "source_changed_during_transcription"
    assert first.path.read_bytes() == previous


def test_empty_speech_completes_without_inventing_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _, _, _, _, result = run_success(tmp_path, monkeypatch, model=FakeModel(segments=[]))
    assert result.artifact["speech_detected"] is False
    assert result.artifact["segments"] == []
    assert result.artifact["words"] == []


def test_model_load_backend_output_and_write_failures_have_stable_codes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    request, _ = make_project(tmp_path)
    ready(monkeypatch)
    cases = [
        (lambda _p, _s: (_ for _ in ()).throw(RuntimeError("load")), None,
         "transcription_model_load_failed"),
        (lambda _p, _s: FakeModel(segments=[SimpleNamespace(
            start=2, end=1, text="bad", words=[]
        )]), None, "transcription_backend_output_invalid"),
        (lambda _p, _s: FakeModel(), lambda _project, _artifact: (_ for _ in ()).throw(
            OSError("disk")
        ), "transcription_artifact_write_failed"),
    ]
    for factory, writer, code in cases:
        with pytest.raises(TranscriptionError) as captured:
            transcribe_project(
                request, model_factory=factory, writer=writer or write_transcript_artifact,
                library_version=lambda: "1.2.1",
            )
        assert captured.value.code == code
        assert list((tmp_path / "artifacts").glob(".*.tmp")) == []


def test_atomic_replace_failure_preserves_prior_transcript_and_removes_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    *_, result = run_success(tmp_path, monkeypatch)
    previous = result.path.read_bytes()
    changed = deepcopy(result.artifact)
    changed["created_at"] = "2026-08-03T00:00:00Z"

    def fail_replace(_source, _destination):
        raise OSError("simulated replace failure")

    with pytest.raises(OSError):
        write_transcript_artifact(tmp_path, changed, replace=fail_replace)
    assert result.path.read_bytes() == previous
    assert list(result.path.parent.glob(".*.tmp")) == []


def test_injected_cancellation_before_inference_and_between_segments_is_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    request, _ = make_project(tmp_path)
    ready(monkeypatch)
    with pytest.raises(TranscriptionError) as captured:
        transcribe_project(request, cancelled=lambda: True)
    assert captured.value.code == "transcription_cancelled"
    assert not (tmp_path / TRANSCRIPT_ARTIFACT_RELATIVE_PATH).exists()

    state = {"cancel": False}

    def backend():
        yield fake_segments()[0]
        state["cancel"] = True
        yield fake_segments()[1]

    with pytest.raises(TranscriptionError) as captured:
        normalize_segments(backend(), duration_seconds=10, cancelled=lambda: state["cancel"])
    assert captured.value.code == "transcription_cancelled"

    _, _, _, _, retry = run_success(tmp_path, monkeypatch)
    assert retry.artifact["speech_detected"] is True


def test_request_must_name_completed_current_ingest_artifact(tmp_path: Path):
    request, _ = make_project(tmp_path)
    request["input_artifacts"] = []
    with pytest.raises(TranscriptionError) as captured:
        transcribe_project(request)
    assert captured.value.code == "ingest_artifact_invalid"
