from __future__ import annotations

import json

import pytest

from vidmyo_repurpose.candidate_providers import (
    HttpResponse,
    OpenRouterCandidateProvider,
    ProviderError,
    make_candidate_provider,
)


def structured_request() -> dict:
    return {
        "schema_name": "test_schema",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["ok"],
            "properties": {"ok": {"type": "boolean"}},
        },
        "messages": [{"role": "user", "content": "test"}],
    }


def test_openrouter_request_is_strict_non_streaming_and_secret_free():
    captured = {}

    def http(url, *, headers, body, timeout):
        captured.update(url=url, headers=headers, body=body, timeout=timeout)
        response = {"choices": [{"message": {"content": json.dumps({"ok": True})}}]}
        return HttpResponse(200, json.dumps(response).encode())

    provider = OpenRouterCandidateProvider(
        "anthropic/claude-3.5-sonnet", api_key="secret-live-key", http=http,
    )
    assert provider.structured(structured_request()) == {"ok": True}
    payload = json.loads(captured["body"])
    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer secret-live-key"
    assert payload["model"] == "anthropic/claude-3.5-sonnet"
    assert payload["stream"] is False
    assert payload["response_format"] == {
        "type": "json_schema",
        "json_schema": {
            "name": "test_schema", "strict": True,
            "schema": structured_request()["schema"],
        },
    }
    assert payload["provider"] == {"require_parameters": True, "allow_fallbacks": False}
    assert "secret-live-key" not in captured["body"].decode()


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [
        (401, "provider_authentication_failed", False),
        (402, "provider_insufficient_credit", False),
        (403, "provider_permission_denied", False),
        (404, "provider_model_unsupported", False),
        (422, "provider_parameter_unsupported", False),
        (429, "provider_rate_limited", True),
        (503, "provider_temporary_failure", True),
    ],
)
def test_openrouter_statuses_are_bounded_redacted_and_classified(status, code, retryable):
    key = "do-not-leak-this-key"
    provider = OpenRouterCandidateProvider(
        "openai/gpt-test",
        api_key=key,
        http=lambda *_args, **_kwargs: HttpResponse(
            status, (f"unsupported parameter {key} " + "x" * 2000).encode(),
        ),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == code
    assert captured.value.retryable is retryable
    assert key not in str(captured.value)
    assert len(str(captured.value)) < 700


@pytest.mark.parametrize(
    ("detail", "code"),
    [
        ("invalid model: unsupported model id", "provider_model_unsupported"),
        ("response_format json schema unsupported", "provider_parameter_unsupported"),
        ("bad request body", "provider_invalid_request"),
    ],
)
def test_openrouter_400_detail_distinguishes_nonretryable_failures(detail, code):
    provider = OpenRouterCandidateProvider(
        "openai/gpt-test", api_key="fake",
        http=lambda *_args, **_kwargs: HttpResponse(400, detail.encode()),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == code
    assert captured.value.retryable is False


def test_empty_malformed_timeout_and_missing_key_are_stable(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(ProviderError) as missing:
        OpenRouterCandidateProvider("openai/gpt-test")
    assert missing.value.code == "provider_api_key_missing"

    cases = [
        (lambda *_a, **_k: HttpResponse(200, b""), "provider_empty_response"),
        (lambda *_a, **_k: HttpResponse(200, b"not-json"), "provider_malformed_response"),
        (lambda *_a, **_k: (_ for _ in ()).throw(TimeoutError("late")), "provider_timeout"),
    ]
    for http, code in cases:
        provider = OpenRouterCandidateProvider("openai/gpt-test", api_key="fake", http=http)
        with pytest.raises(ProviderError) as captured:
            provider.structured(structured_request())
        assert captured.value.code == code
        assert captured.value.retryable is True


def test_unsupported_provider_and_invalid_or_implicit_model_never_fallback():
    with pytest.raises(ValueError, match="unsupported"):
        make_candidate_provider("gemini", "gemini-2")
    with pytest.raises(ValueError, match="explicit model"):
        make_candidate_provider("openrouter", None)
