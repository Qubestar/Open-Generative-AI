"""Provider-neutral structured-output boundary for Repurpose candidates."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

OPENROUTER_PROVIDER_ID = "openrouter"
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
    if provider_id != OPENROUTER_PROVIDER_ID:
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


def make_candidate_provider(
    provider_id: Any,
    model_id: Any,
    **kwargs: Any,
) -> CandidateProvider:
    normalized_provider = normalize_provider_id(provider_id)
    normalized_model = normalize_model_id(model_id)
    if normalized_provider == OPENROUTER_PROVIDER_ID:
        return OpenRouterCandidateProvider(normalized_model, **kwargs)
    raise ValueError(f"unsupported candidate provider {normalized_provider!r}")
