from __future__ import annotations

import json

import pytest

from vidmyo_repurpose.creative import generate


def _request(*, phase="script", provider="codex", style="documentary-map"):
    value = {
        "phase": phase,
        "brief": {
            "kind": "animation",
            "style": style,
            "topic": "Routes across Europe",
            "details": "A concise historical explainer",
            "durationSec": 30,
            "language": "English",
            "provider": {
                "id": provider,
                "model": "openai/gpt-5.1" if provider == "openrouter" else "configured-default",
            },
        },
    }
    if phase == "plan":
        value.update(script="A route joins two cities.", beats=[], direction="Use real geography.")
    return value


class _Provider:
    def __init__(self, result):
        self.result = result
        self.payload = None

    def structured(self, payload):
        self.payload = payload
        return self.result


def test_agent_payload_excludes_private_and_unrelated_request_fields():
    request = _request()
    request["direction"] = "PRIVATE_TEMPLATE"
    request["token"] = "PRIVATE_TOKEN"
    request["brief"]["sourceSheet"] = {"id": "PRIVATE_SHEET"}
    request["brief"]["provider"]["secret"] = "PRIVATE_KEY"
    provider = _Provider({"script": "A complete narration."})
    generate(request, provider_factory=lambda *args, **kwargs: provider)
    encoded = json.dumps(provider.payload)
    assert "PRIVATE_" not in encoded
    task = json.loads(provider.payload["messages"][1]["content"])
    assert "provider" not in task["brief"]
    assert task["brief"]["topic"] == "Routes across Europe"


def test_script_uses_selected_local_provider_and_tool_free_schema():
    provider = _Provider({"script": "A complete narration."})
    captured = {}

    def factory(provider_id, model, **kwargs):
        captured.update(provider_id=provider_id, model=model, kwargs=kwargs)
        return provider

    assert generate(_request(), provider_factory=factory) == {"script": "A complete narration."}
    assert captured["provider_id"] == "codex"
    assert captured["model"] == "configured-default"
    assert callable(captured["kwargs"]["cancelled"])
    assert provider.payload["schema_name"] == "creative_script"
    assert provider.payload["schema"]["additionalProperties"] is False
    assert "do not browse or use tools" in provider.payload["messages"][0]["content"]
    assert json.loads(provider.payload["messages"][1]["content"])["brief"]["topic"] == "Routes across Europe"


def test_openrouter_uses_explicit_model_without_local_callback():
    provider = _Provider({"script": "API narration."})
    captured = {}

    def factory(provider_id, model, **kwargs):
        captured.update(provider_id=provider_id, model=model, kwargs=kwargs)
        return provider

    generate(_request(provider="openrouter"), provider_factory=factory)
    assert captured == {"provider_id": "openrouter", "model": "openai/gpt-5.1", "kwargs": {}}


def test_map_plan_requires_locations_and_rejects_layers():
    valid = {
        "scenes": [{
            "id": "s001", "headline": "Across Europe", "visual": "A route on a map",
            "durationSec": 30, "locations": [{"name": "Warsaw", "lat": 52.23, "lon": 21.01}],
            "layers": [],
        }],
    }
    assert generate(_request(phase="plan"), provider_factory=lambda *_a, **_k: _Provider(valid)) == valid
    invalid = {"scenes": [{**valid["scenes"][0], "locations": []}]}
    with pytest.raises(ValueError, match="requires locations"):
        generate(_request(phase="plan"), provider_factory=lambda *_a, **_k: _Provider(invalid))


@pytest.mark.parametrize("style", ["editorial-collage", "paper-stop-motion"])
def test_layered_styles_require_one_hero_and_support(style):
    valid = {
        "scenes": [{
            "id": "s001", "headline": "Ideas take shape", "visual": "Layered paper scene",
            "durationSec": 30, "locations": [],
            "layers": [
                {"kind": "hero", "description": "A paper rocket"},
                {"kind": "support", "description": "A layered cloud"},
            ],
        }],
    }
    assert generate(_request(phase="plan", style=style), provider_factory=lambda *_a, **_k: _Provider(valid)) == valid
    invalid = {"scenes": [{**valid["scenes"][0], "layers": valid["scenes"][0]["layers"][:1]}]}
    with pytest.raises(ValueError, match="one hero and at least one supporting"):
        generate(_request(phase="plan", style=style), provider_factory=lambda *_a, **_k: _Provider(invalid))


def test_unexpected_response_fields_and_invalid_coordinates_are_rejected():
    with pytest.raises(ValueError, match="unexpected fields"):
        generate(_request(), provider_factory=lambda *_a, **_k: _Provider({"script": "Narration", "tool_call": "browse"}))
    invalid = {
        "scenes": [{
            "id": "s001", "headline": "Bad map", "visual": "Impossible location",
            "durationSec": 30, "locations": [{"name": "Nowhere", "lat": 96, "lon": 0}], "layers": [],
        }],
    }
    with pytest.raises(ValueError, match="invalid location"):
        generate(_request(phase="plan"), provider_factory=lambda *_a, **_k: _Provider(invalid))


def test_cancellation_stops_before_and_after_provider_work():
    calls = 0

    def factory(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return _Provider({"script": "Should not continue"})

    with pytest.raises(ValueError, match="cancelled"):
        generate(_request(), provider_factory=factory, cancelled=lambda: True)
    assert calls == 0

    states = iter([False, True])
    with pytest.raises(ValueError, match="cancelled"):
        generate(_request(), provider_factory=factory, cancelled=lambda: next(states))
    assert calls == 1


@pytest.mark.parametrize("field,value", [("durationSec", 4), ("topic", ""), ("provider", None)])
def test_invalid_request_fails_before_provider_selection(field, value):
    candidate = _request()
    candidate["brief"][field] = value
    with pytest.raises(ValueError):
        generate(candidate, provider_factory=lambda *_a, **_k: pytest.fail("provider should not run"))


def test_animated_stickman_director_produces_separate_background_and_validated_characters():
    request = _request(phase="plan", style="doodle-v1")
    request["brief"].update(kind="story", characterAnimation="animated", aspect="9:16")
    character = dict(id="host", x=.3, endX=.3, y=.8, scale=.35, action="talk", expression="happy", facing="right", shirt="blue", skin="paper")
    result = {"scenes":[dict(id="s001", headline="Hello", visual="An empty room", durationSec=30, locations=[], layers=[], characters=[character])]}
    provider = _Provider(result)
    assert generate(request, provider_factory=lambda *_a, **_k: provider) == result
    payload = json.dumps(provider.payload)
    assert "still background" in payload
    assert "9:16" in payload
    assert "characters" in provider.payload["schema"]["properties"]["scenes"]["items"]["required"]
    for changes in ({"x":float("nan")}, {"scale":9}, {"action":"execute"}, {"id":"../host"}):
        broken = {"scenes":[{**result["scenes"][0], "characters":[{**character, **changes}]}]}
        with pytest.raises(ValueError, match="character"):
            generate(request, provider_factory=lambda *_a, **_k: _Provider(broken))
    missing = {"scenes":[{**result["scenes"][0], "characters":[]}]}
    with pytest.raises(ValueError, match="characters"):
        generate(request, provider_factory=lambda *_a, **_k: _Provider(missing))
