"""Provider-neutral structured-output boundary for Repurpose candidates."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

OPENROUTER_PROVIDER_ID = "openrouter"
LOCAL_AGENT_PROVIDER_IDS = frozenset({"codex", "claude_code", "gemini", "hermes"})
SUPPORTED_PROVIDER_IDS = frozenset({OPENROUTER_PROVIDER_ID, *LOCAL_AGENT_PROVIDER_IDS})
CONFIGURED_DEFAULT_MODEL = "configured-default"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_CHAT_PATH = "/chat/completions"
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_MAX_ERROR_DETAIL = 500
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class ProviderError(Exception):
    """A bounded, credential-free provider failure."""

    code: str
    message: str
    retryable: bool

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


class CandidateProvider(Protocol):
    provider_id: str
    model_id: str

    def structured(self, request: Mapping[str, Any]) -> dict[str, Any]: ...


def normalize_provider_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("options.provider: must be a non-empty string")
    provider_id = value.strip().lower()
    if provider_id not in SUPPORTED_PROVIDER_IDS:
        raise ValueError(f"options.provider: unsupported candidate provider {provider_id!r}")
    return provider_id


def normalize_model_id(value: Any) -> str:
    if not isinstance(value, str) or not _MODEL_RE.fullmatch(value.strip()):
        raise ValueError(
            "options.model: an explicit model using letters, digits, dots, underscores, "
            "colons, slashes, or hyphens is required"
        )
    return value.strip()


def _bounded_text(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return " ".join(value.split())[:_MAX_ERROR_DETAIL]


def _redact(value: str, secrets: tuple[str, ...]) -> str:
    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    return result[:_MAX_ERROR_DETAIL]


def _default_http(
    url: str,
    *,
    headers: Mapping[str, str],
    body: bytes,
    timeout: float,
) -> HttpResponse:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResponse(int(response.status), response.read(_MAX_RESPONSE_BYTES + 1))
    except urllib.error.HTTPError as exc:
        return HttpResponse(int(exc.code), exc.read(4096))


def _status_error(status: int, detail: str) -> ProviderError:
    suffix = f" Detail: {detail}" if detail else ""
    lowered = detail.lower()
    if status == 401:
        return ProviderError("provider_authentication_failed", "OpenRouter authentication failed.", False)
    if status == 403:
        return ProviderError("provider_permission_denied", "OpenRouter denied this request.", False)
    if status == 402:
        return ProviderError("provider_insufficient_credit", "OpenRouter reports insufficient credit.", False)
    if status == 404 or (
        status in {400, 422}
        and "model" in lowered
        and any(term in lowered for term in ("unsupported", "not found", "invalid"))
    ):
        return ProviderError(
            "provider_model_unsupported",
            "OpenRouter could not use the explicit model.",
            False,
        )
    if status == 408:
        return ProviderError("provider_timeout", "OpenRouter timed out.", True)
    if status == 429:
        return ProviderError("provider_rate_limited", "OpenRouter rate-limited the request.", True)
    if status in {400, 409, 413, 415, 422}:
        parameter_terms = ("parameter", "response_format", "structured output", "json schema")
        code = (
            "provider_parameter_unsupported"
            if any(term in lowered for term in parameter_terms)
            else "provider_invalid_request"
        )
        return ProviderError(code, f"OpenRouter rejected the structured request.{suffix}", False)
    if status >= 500:
        return ProviderError(
            "provider_temporary_failure",
            f"OpenRouter returned HTTP {status}.{suffix}",
            True,
        )
    return ProviderError("provider_request_failed", f"OpenRouter returned HTTP {status}.{suffix}", False)


class OpenRouterCandidateProvider:
    """Strict, non-streaming OpenRouter adapter with an injectable HTTP boundary."""

    provider_id = OPENROUTER_PROVIDER_ID

    def __init__(
        self,
        model_id: str,
        *,
        api_key: str | None = None,
        http: Callable[..., HttpResponse] = _default_http,
        timeout_seconds: float = 60.0,
        base_url: str = OPENROUTER_BASE_URL,
    ) -> None:
        self.model_id = normalize_model_id(model_id)
        self._api_key = api_key if api_key is not None else os.environ.get("OPENROUTER_API_KEY")
        if not self._api_key:
            raise ProviderError(
                "provider_api_key_missing",
                "OPENROUTER_API_KEY is required for candidate generation.",
                False,
            )
        self._http = http
        self._timeout_seconds = float(timeout_seconds)
        self._url = f"{base_url.rstrip('/')}{OPENROUTER_CHAT_PATH}"

    def structured(self, request: Mapping[str, Any]) -> dict[str, Any]:
        schema = request.get("schema")
        messages = request.get("messages")
        name = request.get("schema_name")
        if not isinstance(schema, dict) or not isinstance(messages, list) or not isinstance(name, str):
            raise ProviderError(
                "provider_invalid_request",
                "The normalized structured request is invalid.",
                False,
            )
        payload = {
            "model": self.model_id,
            "messages": messages,
            "stream": False,
            "temperature": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema},
            },
            "provider": {"require_parameters": True, "allow_fallbacks": False},
        }
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            response = self._http(
                self._url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
                body=encoded,
                timeout=self._timeout_seconds,
            )
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            detail = _redact(_bounded_text(str(exc)), (self._api_key,))
            raise ProviderError(
                "provider_timeout" if isinstance(exc, TimeoutError) else "provider_temporary_failure",
                f"OpenRouter could not complete the request. {detail}".strip(),
                True,
            ) from exc
        detail = _redact(_bounded_text(response.body), (self._api_key,))
        if response.status < 200 or response.status >= 300:
            raise _status_error(response.status, detail)
        if len(response.body) > _MAX_RESPONSE_BYTES:
            raise ProviderError(
                "provider_response_too_large",
                "OpenRouter returned a structured response larger than the safe limit.",
                True,
            )
        if not response.body.strip():
            raise ProviderError("provider_empty_response", "OpenRouter returned an empty response.", True)
        try:
            envelope = json.loads(response.body)
            content = envelope["choices"][0]["message"]["content"]
            document = content if isinstance(content, dict) else json.loads(content)
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(
                "provider_malformed_response",
                "OpenRouter returned a malformed structured response.",
                True,
            ) from exc
        if not isinstance(document, dict):
            raise ProviderError(
                "provider_malformed_response",
                "OpenRouter structured output was not a JSON object.",
                True,
            )
        return document


def _structured_prompt(request: Mapping[str, Any]) -> str:
    schema = request.get("schema")
    messages = request.get("messages")
    if not isinstance(schema, dict) or not isinstance(messages, list):
        raise ProviderError("provider_invalid_request", "The normalized structured request is invalid.", False)
    return (
        "Return exactly one JSON object matching the JSON Schema below. "
        "Do not use tools, inspect files, browse, or add markdown fences.\n\n"
        f"MESSAGES:\n{json.dumps(messages, ensure_ascii=False)}\n\n"
        f"JSON SCHEMA:\n{json.dumps(schema, ensure_ascii=False)}\n"
    )


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise ValueError("response was not text or an object")
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1]).strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("response JSON was not an object")
    return parsed


def _extract_local_document(provider_id: str, stdout: str, output_file: Path) -> dict[str, Any]:
    if provider_id == "codex" and output_file.exists():
        if output_file.stat().st_size > _MAX_RESPONSE_BYTES:
            raise ProviderError("provider_response_too_large", "Local agent response exceeded the safe limit.", False)
        return _json_object(output_file.read_text(encoding="utf-8"))
    envelope = json.loads(stdout) if provider_id in {"claude_code", "gemini"} else stdout
    if provider_id == "claude_code" and isinstance(envelope, dict):
        return _json_object(envelope.get("structured_output", envelope.get("result")))
    if provider_id == "gemini" and isinstance(envelope, dict):
        return _json_object(envelope.get("response", envelope.get("result")))
    return _json_object(envelope)


_HERMES_SCRIPT = """import sys
import hermes_cli.oneshot as oneshot
original = oneshot._normalize_toolsets
oneshot._normalize_toolsets = lambda value: [] if value == '__vidmyo_no_tools__' else original(value)
oneshot.get_fallback_chain = lambda _cfg: []
response, _result = oneshot._run_agent(
    sys.stdin.read(), toolsets='__vidmyo_no_tools__', use_config_toolsets=False
)
sys.stdout.write(response or '')
"""


def _hermes_python(cli_path: str) -> str:
    current = Path(cli_path)
    for _ in range(3):
        try:
            text = current.read_text(encoding="utf-8")[:4096]
        except (OSError, UnicodeError):
            break
        first = text.splitlines()[0] if text else ""
        if first.startswith("#!") and "python" in first.lower():
            interpreter = first[2:].strip().split()
            if Path(interpreter[0]).name == "env" and len(interpreter) > 1:
                adjacent = current.parent / interpreter[-1]
                return str(adjacent) if adjacent.is_file() else (shutil.which(interpreter[-1]) or interpreter[-1])
            return interpreter[0]
        if "'''exec'" in text and "'python3'" in text:
            runtime = current.parent / "python3"
            if runtime.is_file():
                return str(runtime)
        match = re.search(r'^exec\s+["\']([^"\']+)["\']\s+"\$@"', text, re.MULTILINE)
        if not match:
            break
        current = Path(match.group(1))
    raise ProviderError(
        "provider_isolation_unavailable",
        "Hermes is installed, but Vidmyo could not resolve its isolated Python runtime.",
        False,
    )


class LocalAgentCandidateProvider:
    """Tool-free structured requests through an already-authenticated local agent CLI."""

    def __init__(
        self,
        provider_id: str,
        model_id: str,
        *,
        cli_path: str | None = None,
        timeout_seconds: float = 180.0,
        cancelled: Callable[[], bool] = lambda: False,
        popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
    ) -> None:
        self.provider_id = normalize_provider_id(provider_id)
        if self.provider_id not in LOCAL_AGENT_PROVIDER_IDS:
            raise ValueError(f"unsupported local candidate provider {self.provider_id!r}")
        self.model_id = normalize_model_id(model_id)
        self.cli_path = cli_path or os.environ.get("VIDMYO_AGENT_CLI", "")
        if not self.cli_path or not Path(self.cli_path).is_absolute():
            raise ProviderError("provider_not_installed", f"{self.provider_id} CLI is not installed.", False)
        self._timeout_seconds = float(timeout_seconds)
        self._cancelled = cancelled
        self._popen = popen

    def _command(self, schema_path: Path, output_path: Path) -> list[str]:
        if self.provider_id == "codex":
            disabled = [
                "apps", "browser_use", "browser_use_external", "code_mode_host",
                "computer_use", "hooks", "image_generation", "in_app_browser",
                "multi_agent", "plugins", "shell_tool", "skill_mcp_dependency_install",
                "skill_search", "tool_call_mcp_elicitation",
            ]
            flags = [flag for feature in disabled for flag in ("--disable", feature)]
            return [self.cli_path, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
                    "--strict-config", *flags, "--sandbox", "read-only",
                    "--skip-git-repo-check", "--output-schema", str(schema_path),
                    "--output-last-message", str(output_path), "-"]
        if self.provider_id == "claude_code":
            schema = schema_path.read_text(encoding="utf-8")
            mcp_config = schema_path.parent / "claude-mcp.json"
            return [self.cli_path, "--print", "--output-format", "json", "--json-schema", schema,
                    "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
                    "--disable-slash-commands", "--mcp-config", str(mcp_config),
                    "--strict-mcp-config", "--setting-sources", ""]
        if self.provider_id == "gemini":
            return [self.cli_path, "--output-format", "json", "--sandbox", "--approval-mode", "default", "-p", ""]
        return [_hermes_python(self.cli_path), "-c", _HERMES_SCRIPT]

    def structured(self, request: Mapping[str, Any]) -> dict[str, Any]:
        prompt = _structured_prompt(request)
        schema = request.get("schema")
        with tempfile.TemporaryDirectory(prefix="vidmyo-agent-") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            schema_path = root / "schema.json"
            output_path = root / "response.json"
            prompt_path = root / "prompt.txt"
            stdout_path = root / "stdout.txt"
            stderr_path = root / "stderr.txt"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            schema_path.chmod(0o600)
            claude_mcp_path = root / "claude-mcp.json"
            claude_mcp_path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
            claude_mcp_path.chmod(0o600)
            prompt_path.write_text(prompt, encoding="utf-8")
            prompt_path.chmod(0o600)
            common = {
                "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
                "LANG", "LANGUAGE", "SSL_CERT_FILE", "SSL_CERT_DIR",
                "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
                "NODE_EXTRA_CA_CERTS",
            }
            provider_auth = {
                "codex": {"CODEX_HOME", "OPENAI_API_KEY"},
                "claude_code": {"CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"},
                "gemini": {
                    "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
                    "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
                },
                "hermes": {"HERMES_HOME"},
            }[self.provider_id]
            allowed = common | provider_auth
            env = {key: value for key, value in os.environ.items() if key in allowed or key.startswith("LC_")}
            env.update({"HERMES_SAFE_MODE": "1", "HERMES_IGNORE_RULES": "1"})
            if self.provider_id == "gemini":
                gemini_settings = root / "gemini-system-settings.json"
                gemini_settings.write_text(json.dumps({
                    "tools": {"core": []},
                    "admin": {
                        "mcp": {"enabled": False},
                        "extensions": {"enabled": False},
                        "skills": {"enabled": False},
                    },
                    "hooks": {"enabled": False},
                    "context": {"includeDirectories": [], "loadMemoryFromIncludeDirectories": False},
                }), encoding="utf-8")
                gemini_settings.chmod(0o600)
                env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = str(gemini_settings)
            try:
                with prompt_path.open("r", encoding="utf-8") as prompt_stream, \
                        stdout_path.open("w+", encoding="utf-8", errors="replace") as stdout_stream, \
                        stderr_path.open("w+", encoding="utf-8", errors="replace") as stderr_stream:
                    process = self._popen(
                        self._command(schema_path, output_path), cwd=root, env=env, shell=False,
                        stdin=prompt_stream, stdout=stdout_stream, stderr=stderr_stream,
                        text=True, start_new_session=True,
                    )

                    def terminate() -> None:
                        try:
                            if hasattr(os, "killpg"):
                                os.killpg(process.pid, signal.SIGTERM)
                            else:
                                process.terminate()
                            process.wait(timeout=2)
                        except (OSError, subprocess.TimeoutExpired):
                            try:
                                if hasattr(os, "killpg"):
                                    os.killpg(process.pid, signal.SIGKILL)
                                else:
                                    process.kill()
                            except (OSError, AttributeError):
                                pass

                    if callable(getattr(process, "poll", None)):
                        started = time.monotonic()
                        while process.poll() is None:
                            oversized = any(
                                candidate.exists() and candidate.stat().st_size > _MAX_RESPONSE_BYTES
                                for candidate in (stdout_path, stderr_path, output_path)
                            )
                            if oversized:
                                terminate()
                                raise ProviderError(
                                    "provider_response_too_large",
                                    "Local agent response exceeded the safe limit.", False,
                                )
                            if self._cancelled() or time.monotonic() - started > self._timeout_seconds:
                                terminate()
                                code = "provider_cancelled" if self._cancelled() else "provider_timeout"
                                message = "Local agent request was cancelled." if code == "provider_cancelled" else "Local agent timed out."
                                raise ProviderError(code, message, False)
                            time.sleep(0.05)
                        stdout_stream.seek(0)
                        stderr_stream.seek(0)
                        stdout = stdout_stream.read(_MAX_RESPONSE_BYTES + 1)
                        stderr = stderr_stream.read(_MAX_RESPONSE_BYTES + 1)
                    else:
                        # Test doubles use communicate(); production Popen instances take the bounded file path above.
                        started = time.monotonic()
                        while True:
                            try:
                                stdout, stderr = process.communicate(input=prompt, timeout=0.2)
                                break
                            except subprocess.TimeoutExpired:
                                prompt = None
                                if self._cancelled() or time.monotonic() - started > self._timeout_seconds:
                                    terminate()
                                    code = "provider_cancelled" if self._cancelled() else "provider_timeout"
                                    message = "Local agent request was cancelled." if code == "provider_cancelled" else "Local agent timed out."
                                    raise ProviderError(code, message, False)
                if process.returncode:
                    detail = _bounded_text(stderr)
                    needs_auth = "auth" in detail.lower() or "login" in detail.lower()
                    raise ProviderError(
                        "provider_authentication_failed" if needs_auth else "provider_request_failed",
                        f"{self.provider_id} needs authentication." if needs_auth else f"{self.provider_id} could not complete the request.",
                        False,
                    )
                if len(stdout.encode("utf-8")) > _MAX_RESPONSE_BYTES or len(stderr.encode("utf-8")) > _MAX_RESPONSE_BYTES:
                    raise ProviderError("provider_response_too_large", "Local agent response exceeded the safe limit.", False)
                return _extract_local_document(self.provider_id, stdout, output_path)
            except ProviderError:
                raise
            except (OSError, json.JSONDecodeError, ValueError, KeyError, TypeError) as exc:
                raise ProviderError(
                    "provider_malformed_response",
                    f"{self.provider_id} returned invalid structured output: {_bounded_text(str(exc))}",
                    False,
                ) from exc


def make_candidate_provider(
    provider_id: Any,
    model_id: Any,
    **kwargs: Any,
) -> CandidateProvider:
    normalized_provider = normalize_provider_id(provider_id)
    normalized_model = normalize_model_id(model_id)
    if normalized_provider == OPENROUTER_PROVIDER_ID:
        return OpenRouterCandidateProvider(normalized_model, **kwargs)
    if normalized_provider in LOCAL_AGENT_PROVIDER_IDS:
        return LocalAgentCandidateProvider(normalized_provider, normalized_model, **kwargs)
    raise ValueError(f"unsupported candidate provider {normalized_provider!r}")
