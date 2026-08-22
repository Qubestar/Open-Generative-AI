from __future__ import annotations

import json
import subprocess

import pytest

from vidmyo_repurpose.candidate_providers import (
    HttpResponse,
    LocalAgentCandidateProvider,
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
        make_candidate_provider("opencode", "configured-default")
    with pytest.raises(ValueError, match="explicit model"):
        make_candidate_provider("openrouter", None)


@pytest.mark.parametrize(
    ("provider_id", "stdout"),
    [
        ("codex", ""),
        ("claude_code", json.dumps({"structured_output": {"ok": True}})),
        ("gemini", json.dumps({"response": json.dumps({"ok": True})})),
        ("hermes", json.dumps({"ok": True})),
    ],
)
def test_local_agents_are_tool_restricted_structured_and_prompt_free_in_argv(tmp_path, provider_id, stdout):
    cli = tmp_path / provider_id
    if provider_id == "hermes":
        runtime = tmp_path / "hermes-runtime"
        runtime.write_text("#!/tmp/hermes-python\n", encoding="utf-8")
        cli.write_text(f'#!/bin/sh\nexec "{runtime}" "$@"\n', encoding="utf-8")
    else:
        cli.write_text("#!/bin/sh\n", encoding="utf-8")
    captured = {}

    class Process:
        pid = 12345
        returncode = 0

        def communicate(self, input=None, timeout=None):
            captured["prompt"] = input
            if provider_id == "codex":
                output = captured["args"][captured["args"].index("--output-last-message") + 1]
                __import__("pathlib").Path(output).write_text(json.dumps({"ok": True}))
            return stdout, ""

    def popen(args, **kwargs):
        captured.update(args=args, kwargs=kwargs)
        return Process()

    provider = LocalAgentCandidateProvider(
        provider_id, "configured-default", cli_path=str(cli), popen=popen,
    )
    assert provider.structured(structured_request()) == {"ok": True}
    assert captured["kwargs"]["shell"] is False
    assert json.dumps(structured_request()["messages"], ensure_ascii=False) not in " ".join(captured["args"])
    assert captured["prompt"] and "JSON SCHEMA" in captured["prompt"]
    if provider_id == "codex":
        assert ["--sandbox", "read-only"] == captured["args"][4:6]
        assert "--ephemeral" in captured["args"]
    elif provider_id == "claude_code":
        assert ["--tools", ""] == captured["args"][captured["args"].index("--tools"):][:2]
        assert "--no-session-persistence" in captured["args"]
    elif provider_id == "gemini":
        assert "--sandbox" in captured["args"]
        assert ["-p", ""] == captured["args"][-2:]
    else:
        assert captured["args"][0] == "/tmp/hermes-python"
        assert "get_fallback_chain = lambda _cfg: []" in captured["args"][2]
        assert "__vidmyo_no_tools__" in captured["args"][2]


def test_local_agent_requires_an_absolute_detected_cli():
    with pytest.raises(ProviderError) as captured:
        LocalAgentCandidateProvider("codex", "configured-default", cli_path="codex")
    assert captured.value.code == "provider_not_installed"


def test_local_agent_cancellation_terminates_its_isolated_process(tmp_path, monkeypatch):
    cli = tmp_path / "codex"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    signals = []

    class WaitingProcess:
        pid = 4242
        returncode = None

        def communicate(self, input=None, timeout=None):
            raise subprocess.TimeoutExpired("codex", timeout)

        def wait(self, timeout=None):
            self.returncode = -15
            return self.returncode

    monkeypatch.setattr("vidmyo_repurpose.candidate_providers.os.killpg", lambda pid, sig: signals.append((pid, sig)))
    provider = LocalAgentCandidateProvider(
        "codex", "configured-default", cli_path=str(cli), cancelled=lambda: True,
        popen=lambda *_args, **_kwargs: WaitingProcess(),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == "provider_cancelled"
    assert signals and signals[0][0] == 4242


@pytest.mark.parametrize(
    ("stdout", "code"),
    [
        ("not-json", "provider_malformed_response"),
        ("x" * (2 * 1024 * 1024 + 1), "provider_response_too_large"),
    ],
)
def test_local_agent_rejects_malformed_and_oversized_output(tmp_path, stdout, code):
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")

    class Process:
        pid = 1
        returncode = 0

        def communicate(self, input=None, timeout=None):
            return stdout, ""

    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli),
        popen=lambda *_args, **_kwargs: Process(),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == code
