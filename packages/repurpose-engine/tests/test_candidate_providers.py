from __future__ import annotations

import json
import subprocess
import sys

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
    ("provider_id", "stdout", "model_id"),
    [
        ("codex", "", "configured-default"),
        ("codex", "", "vendor/codex-model"),
        ("claude_code", json.dumps({"structured_output": {"ok": True}}), "configured-default"),
        ("claude_code", json.dumps({"structured_output": {"ok": True}}), "vendor/claude-model"),
        ("gemini", json.dumps({"response": json.dumps({"ok": True})}), "configured-default"),
        ("gemini", json.dumps({"response": json.dumps({"ok": True})}), "vendor/gemini-model"),
        ("hermes", json.dumps({"ok": True}), "configured-default"),
        ("hermes", json.dumps({"ok": True}), "vendor/hermes-model"),
    ],
)
def test_local_agents_are_tool_restricted_structured_and_prompt_free_in_argv(
    tmp_path, monkeypatch, provider_id, stdout, model_id,
):
    monkeypatch.setenv("UNRELATED_SECRET", "must-not-reach-agent")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-agent")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-reach-agent")
    monkeypatch.setenv("GEMINI_API_KEY", "must-not-reach-agent")
    monkeypatch.setenv("GOOGLE_API_KEY", "must-not-reach-agent")
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
        settings_path = kwargs["env"].get("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
        if settings_path:
            captured["gemini_settings"] = json.loads(__import__("pathlib").Path(settings_path).read_text())
        return Process()

    provider = LocalAgentCandidateProvider(
        provider_id, model_id, cli_path=str(cli), popen=popen,
    )
    assert provider.structured(structured_request()) == {"ok": True}
    assert captured["kwargs"]["shell"] is False
    assert json.dumps(structured_request()["messages"], ensure_ascii=False) not in " ".join(captured["args"])
    assert captured["prompt"] and "JSON SCHEMA" in captured["prompt"]
    if provider_id == "codex":
        assert ["--sandbox", "read-only"] == captured["args"][captured["args"].index("--sandbox"):][:2]
        assert "--ephemeral" in captured["args"]
        assert "--ignore-user-config" in captured["args"]
        assert ["--disable", "shell_tool"] == captured["args"][captured["args"].index("shell_tool") - 1:][:2]
    elif provider_id == "claude_code":
        assert ["--tools", ""] == captured["args"][captured["args"].index("--tools"):][:2]
        assert "--safe-mode" in captured["args"]
        assert "--no-session-persistence" in captured["args"]
        assert "--strict-mcp-config" in captured["args"]
        assert ["--setting-sources", ""] == captured["args"][captured["args"].index("--setting-sources"):][:2]
    elif provider_id == "gemini":
        assert "--sandbox" not in captured["args"]
        assert "-p" not in captured["args"]
        assert "--prompt" not in captured["args"]
        assert captured["args"][-2:] == ["--approval-mode", "default"]
        settings = captured["gemini_settings"]
        assert settings["tools"]["core"] == []
        assert settings["admin"]["mcp"]["enabled"] is False
    else:
        assert captured["args"][0] == "/tmp/hermes-python"
        assert "get_fallback_chain = lambda _cfg: []" in captured["args"][2]
        assert "__vidmyo_no_tools__" in captured["args"][2]
    if provider_id in {"codex", "claude_code", "gemini"}:
        if model_id == "configured-default":
            assert "--model" not in captured["args"]
        else:
            assert captured["args"][captured["args"].index("--model") + 1] == model_id
    if provider_id == "hermes":
        expected = None if model_id == "configured-default" else model_id
        assert captured["kwargs"]["env"].get("HERMES_INFERENCE_MODEL") == expected
    assert "UNRELATED_SECRET" not in captured["kwargs"]["env"]
    assert "OPENAI_API_KEY" not in captured["kwargs"]["env"]
    assert "ANTHROPIC_API_KEY" not in captured["kwargs"]["env"]
    assert "GEMINI_API_KEY" not in captured["kwargs"]["env"]
    assert "GOOGLE_API_KEY" not in captured["kwargs"]["env"]


def test_claude_ignores_user_api_routing_settings(tmp_path, monkeypatch):
    home = tmp_path / "home"
    config_dir = home / ".claude"
    config_dir.mkdir(parents=True)
    (config_dir / "settings.json").write_text(json.dumps({
        "env": {
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
            "UNRELATED_API_KEY": "must-not-reach-agent",
        },
        "hooks": {"PreToolUse": [{"command": "must-not-run"}]},
        "enabledPlugins": {"must-not-load": True},
    }), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    captured = {}

    class Process:
        pid = 1
        returncode = 0

        def communicate(self, input=None, timeout=None):
            return json.dumps({"structured_output": {"ok": True}}), ""

    def popen(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs["env"]
        return Process()

    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli), popen=popen,
    )

    assert provider.structured(structured_request()) == {"ok": True}
    assert "--settings" not in captured["args"]
    assert captured["args"][captured["args"].index("--setting-sources") + 1] == ""
    assert "ANTHROPIC_BASE_URL" not in captured["env"]
    assert "UNRELATED_API_KEY" not in captured["env"]


def test_codex_uses_cli_default_instead_of_desktop_configured_model(tmp_path, monkeypatch):
    home = tmp_path / "home"
    config_dir = home / ".codex"
    config_dir.mkdir(parents=True)
    (config_dir / "config.toml").write_text(
        'model = "gpt-5.6-sol"\n[mcp_servers.must_not_load]\nurl = "https://example.invalid"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(home))
    cli = tmp_path / "codex"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    captured = {}

    class Process:
        pid = 1
        returncode = 0

        def communicate(self, input=None, timeout=None):
            output = captured["args"][captured["args"].index("--output-last-message") + 1]
            __import__("pathlib").Path(output).write_text(json.dumps({"ok": True}))
            return "", ""

    def popen(args, **kwargs):
        captured["args"] = args
        return Process()

    provider = LocalAgentCandidateProvider(
        "codex", "configured-default", cli_path=str(cli), popen=popen,
    )

    assert provider.structured(structured_request()) == {"ok": True}
    assert "--model" not in captured["args"]
    assert "--ignore-user-config" in captured["args"]
    assert "gpt-5.6-sol" not in captured["args"]
    assert "example.invalid" not in " ".join(captured["args"])


def test_codex_omits_unsupported_unique_items_but_keeps_local_schema(tmp_path):
    cli = tmp_path / "codex"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    request = structured_request()
    request["schema"]["properties"]["ids"] = {
        "type": "array",
        "uniqueItems": True,
        "items": {"type": "string"},
    }
    original_schema = json.loads(json.dumps(request["schema"]))
    captured = {}

    class Process:
        pid = 1
        returncode = 0

        def communicate(self, input=None, timeout=None):
            output = captured["args"][captured["args"].index("--output-last-message") + 1]
            __import__("pathlib").Path(output).write_text(json.dumps({"ok": True}))
            return "", ""

    def popen(args, **kwargs):
        captured["args"] = args
        schema_path = args[args.index("--output-schema") + 1]
        captured["provider_schema"] = json.loads(__import__("pathlib").Path(schema_path).read_text())
        return Process()

    provider = LocalAgentCandidateProvider(
        "codex", "configured-default", cli_path=str(cli), popen=popen,
    )

    assert provider.structured(request) == {"ok": True}
    assert "uniqueItems" not in captured["provider_schema"]["properties"]["ids"]
    assert request["schema"] == original_schema


def test_local_agent_requires_an_absolute_detected_cli():
    with pytest.raises(ProviderError) as captured:
        LocalAgentCandidateProvider("codex", "configured-default", cli_path="codex")
    assert captured.value.code == "provider_not_installed"


@pytest.mark.parametrize(
    ("stderr", "code", "message"),
    [
        (
            "Your credit balance is too low to access the Anthropic API.",
            "provider_insufficient_credit",
            "claude_code reports insufficient credit or quota.",
        ),
        (
            "RESOURCE_EXHAUSTED: free tier quota",
            "provider_insufficient_credit",
            "claude_code reports insufficient credit or quota.",
        ),
        ("You've hit your usage limit", "provider_rate_limited", "claude_code subscription usage limit reached."),
        ("Model gpt-test is not supported", "provider_model_unsupported", "claude_code could not use that model. Choose Automatic or another model in VFX."),
        ("Please login to continue", "provider_authentication_failed", "claude_code needs authentication. Sign in from the Agents page."),
        (
            "OpenAI Codex\nsandbox: read-only\nERROR request failed: 401 Unauthorized",
            "provider_authentication_failed",
            "claude_code needs authentication. Sign in from the Agents page.",
        ),
        (
            "sandbox-exec failed to start",
            "provider_isolation_unavailable",
            "claude_code could not start its restricted planning environment. Update the CLI and try again.",
        ),
        (
            "unknown option --old-flag",
            "provider_cli_incompatible",
            "claude_code rejected Vidmyo's CLI options. Update Vidmyo or the CLI and try again.",
        ),
        (
            "fetch failed: ECONNRESET",
            "provider_network_failed",
            "claude_code could not reach its service. Check the connection and try again.",
        ),
        (
            "unexpected local failure",
            "provider_request_failed",
            "claude_code exited before returning a beat plan (exit 1). Sign in from the Agents page, then try again.",
        ),
    ],
)
def test_local_agent_classifies_bounded_nonzero_exit(stderr, code, message, tmp_path):
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")

    class Process:
        pid = 1
        returncode = 1

        def communicate(self, input=None, timeout=None):
            return "", stderr

    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli),
        popen=lambda *_args, **_kwargs: Process(),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == code
    assert str(captured.value) == message


def test_local_agent_classifies_account_failure_from_stdout(tmp_path):
    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")

    class Process:
        pid = 1
        returncode = 1

        def communicate(self, input=None, timeout=None):
            return '{"is_error":true,"result":"You have no active subscription"}', ""

    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli),
        popen=lambda *_args, **_kwargs: Process(),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == "provider_subscription_required"
    assert str(captured.value) == "claude_code has no active subscription."


def test_gemini_exit_41_is_always_authentication_failure(tmp_path):
    cli = tmp_path / "gemini"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")

    class Process:
        pid = 1
        returncode = 41

        def communicate(self, input=None, timeout=None):
            return '{"error":{"code":41,"message":"No auth method configured"}}', ""

    provider = LocalAgentCandidateProvider(
        "gemini", "configured-default", cli_path=str(cli),
        popen=lambda *_args, **_kwargs: Process(),
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == "provider_authentication_failed"
    assert str(captured.value) == (
        "Gemini CLI is not signed in. Open the Agents page, sign in to Gemini, then try again."
    )


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
    assert captured.value.retryable is False


def test_hermes_resolves_standard_polyglot_console_wrapper(tmp_path):
    runtime = tmp_path / "python3"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    cli = tmp_path / "hermes"
    cli.write_text(
        "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n",
        encoding="utf-8",
    )
    captured = {}

    class Process:
        pid = 1
        returncode = 0

        def communicate(self, input=None, timeout=None):
            return json.dumps({"ok": True}), ""

    provider = LocalAgentCandidateProvider(
        "hermes", "configured-default", cli_path=str(cli),
        popen=lambda args, **_kwargs: captured.setdefault("args", args) and Process(),
    )
    assert provider.structured(structured_request()) == {"ok": True}
    assert captured["args"][0] == str(runtime)


def test_hermes_resolves_env_python_shebang_to_adjacent_runtime(tmp_path):
    runtime = tmp_path / "python3"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    cli = tmp_path / "hermes"
    cli.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    provider = LocalAgentCandidateProvider(
        "hermes", "configured-default", cli_path=str(cli),
        popen=lambda args, **_kwargs: (_ for _ in ()).throw(AssertionError(args)),
    )
    assert provider._command(tmp_path / "schema", tmp_path / "output")[0] == str(runtime)


def test_local_agent_output_is_bounded_while_process_is_running(tmp_path):
    cli = tmp_path / "claude"
    cli.write_text(
        f"#!{sys.executable}\n"
        "import sys, time\n"
        "sys.stderr.write('x' * (2 * 1024 * 1024 + 1))\n"
        "sys.stderr.flush()\n"
        "time.sleep(2)\n",
        encoding="utf-8",
    )
    cli.chmod(0o700)
    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli), timeout_seconds=5,
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == "provider_response_too_large"
    assert captured.value.retryable is False


def test_local_agent_real_process_uses_file_backed_prompt_and_output(tmp_path):
    cli = tmp_path / "claude"
    cli.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "assert 'JSON SCHEMA' in sys.stdin.read()\n"
        "print(json.dumps({'structured_output': {'ok': True}}))\n",
        encoding="utf-8",
    )
    cli.chmod(0o700)
    provider = LocalAgentCandidateProvider("claude_code", "configured-default", cli_path=str(cli))
    assert provider.structured(structured_request()) == {"ok": True}


def test_local_agent_real_process_cancellation_is_nonretryable(tmp_path):
    cli = tmp_path / "claude"
    cli.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(10)\n", encoding="utf-8")
    cli.chmod(0o700)
    provider = LocalAgentCandidateProvider(
        "claude_code", "configured-default", cli_path=str(cli), cancelled=lambda: True,
    )
    with pytest.raises(ProviderError) as captured:
        provider.structured(structured_request())
    assert captured.value.code == "provider_cancelled"
    assert captured.value.retryable is False
