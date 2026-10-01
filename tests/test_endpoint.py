"""Endpoint and key selection: TypeSafe System One or OpenRouter, mirroring src/endpoint.ts."""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

TS_URL = "https://api.typesafe.ai/v1/systemone"
OR_URL = "https://openrouter.ai/api/alpha/decisions"


@pytest.fixture
def plugin(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("jev_endpoint_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def endpoint() -> ModuleType:
    """The resolver alone: it has no Hermes imports."""
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "endpoint.py"
    spec = importlib.util.spec_from_file_location("jev_endpoint_resolver_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scope(monkeypatch: pytest.MonkeyPatch, secrets: dict[str, str]) -> None:
    """Stand in for Hermes' profile secret scope."""
    from agent import secret_scope

    monkeypatch.setattr(secret_scope, "get_secret", lambda name: secrets.get(name))


def capture_http(plugin: ModuleType, monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    def fake_post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> dict[str, Any]:
        payload = json.loads(body.decode("utf-8"))
        sent.append({"url": url, "auth": headers["Authorization"], "model": payload["model"]})
        return {"answers": {key: {"noul": 1.0} for key in payload["questions"]}}

    monkeypatch.setattr(plugin, "_http_post_json", fake_post)
    return sent


def transcript() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "fix the test"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "x" * 4000},
        {"role": "user", "content": "go on"},
    ]


def engine(plugin: ModuleType) -> Any:
    value = plugin.JevEngine()
    value.protect_last_n = 0
    return value


def test_defaults_to_typesafe_and_to_openrouter_when_only_its_key_is_present(endpoint: ModuleType) -> None:
    resolve = endpoint.resolve_endpoint
    assert resolve() == (TS_URL, "typesafe", "TYPESAFE_API_KEY", "")
    assert resolve(openrouter_key="or") == (OR_URL, "openrouter", "OPENROUTER_API_KEY", "or")
    assert resolve(typesafe_key="ts", openrouter_key="or") == (TS_URL, "typesafe", "TYPESAFE_API_KEY", "ts")


def test_sends_each_endpoint_its_own_key(endpoint: ModuleType) -> None:
    resolve = endpoint.resolve_endpoint
    keys = {"typesafe_key": "ts", "openrouter_key": "or"}
    assert resolve(provider="openrouter", **keys).api_key == "or"
    assert resolve(provider=" OpenRouter ", **keys).base_url == OR_URL
    assert resolve(base_url=OR_URL, **keys)[1:] == ("openrouter", "OPENROUTER_API_KEY", "or")
    # A key stored under the other name still reaches its endpoint.
    assert resolve(base_url=OR_URL, typesafe_key="only").api_key == "only"


def test_explicit_url_and_key_win(endpoint: ModuleType) -> None:
    resolve = endpoint.resolve_endpoint
    local = resolve(base_url="http://localhost:8080/v1/systemone", provider="openrouter")
    assert local == ("http://localhost:8080/v1/systemone", "custom", "TYPESAFE_API_KEY", "")
    assert resolve(api_key="explicit", typesafe_key="ts").api_key == "explicit"
    assert resolve(base_url="  ", provider="bogus").base_url == TS_URL


def test_lookup_names_and_settings_precedence(endpoint: ModuleType) -> None:
    endpoint_from = endpoint.endpoint_from
    env = {"FAST_JEV_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "or", "TYPESAFE_API_KEY": "ts"}
    assert endpoint_from(env.get)[::3] == (OR_URL, "or")
    assert endpoint_from(env.get, provider="typesafe")[::3] == (TS_URL, "ts")
    urls = {"FAST_JEV_BASE_URL": "http://a", "TYPESAFE_BASE_URL": "http://b", "FAST_JEV_API_KEY": "k"}
    assert endpoint_from(urls.get)[::3] == ("http://a", "k")
    assert endpoint_from(urls.get, base_url="http://c", api_key="own")[::3] == ("http://c", "own")
    assert endpoint_from({"TYPESAFE_BASE_URL": "http://b"}.get).base_url == "http://b"


def test_patch_pins_become_openrouter_minor_ids(endpoint: ModuleType) -> None:
    assert endpoint.model_for("openrouter", "jev-1.13.0") == "typesafe/jev-1.13"
    assert endpoint.model_for("openrouter", "jev-latest") == "jev-latest"
    assert endpoint.model_for("openrouter", "typesafe/jev-1.13") == "typesafe/jev-1.13"
    assert endpoint.model_for("typesafe", "jev-1.13.0") == "jev-1.13.0"
    assert endpoint.model_for("custom", "jev-1.13.0") == "jev-1.13.0"


def test_engine_reaches_openrouter_with_only_an_openrouter_key(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent = capture_http(plugin, monkeypatch)
    scope(monkeypatch, {"OPENROUTER_API_KEY": "or-key"})
    value = engine(plugin)

    value.compress(transcript())

    assert value.last_stats["mode"] == "jev"
    assert value.last_stats["endpoint"] == "openrouter.ai"
    assert sent and all(s["url"] == OR_URL and s["auth"] == "Bearer or-key" for s in sent)
    # The default TypeSafe pin (jev-1.13.0) does not exist on OpenRouter.
    assert value.model == "jev-1.13.0"
    assert {s["model"] for s in sent} == {"typesafe/jev-1.13"}


def test_outcome_is_logged_with_host_and_status_but_no_secrets(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    import urllib.error

    capture_http(plugin, monkeypatch)
    scope(monkeypatch, {"OPENROUTER_API_KEY": "or-key"})
    caplog.set_level("INFO")
    engine(plugin).compress(transcript())

    def refuse(url: str, body: bytes, headers: dict[str, str], timeout: float) -> dict[str, Any]:
        raise urllib.error.HTTPError(url, 402, "Payment Required", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(plugin, "_http_post_json", refuse)
    failed = engine(plugin)
    failed.compress(transcript())

    logs = caplog.text
    assert "Jev via openrouter.ai answered 1 request(s)" in logs
    assert "Jev via openrouter.ai failed (HTTPError HTTP 402), local fallback" in logs
    assert failed.last_stats["mode"] == "fallback"
    assert "or-key" not in logs


def test_engine_never_sends_the_typesafe_key_to_openrouter(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent = capture_http(plugin, monkeypatch)
    scope(monkeypatch, {"TYPESAFE_API_KEY": "ts-key", "OPENROUTER_API_KEY": "or-key"})
    routed = engine(plugin)
    routed.provider = "openrouter"
    routed.compress(transcript())
    default = engine(plugin)
    default.compress(transcript())

    assert [(s["url"], s["auth"]) for s in sent] == [
        (OR_URL, "Bearer or-key"),
        (TS_URL, "Bearer ts-key"),
    ]


def test_missing_key_names_the_expected_variable_and_prohibits_http(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent = capture_http(plugin, monkeypatch)
    scope(monkeypatch, {"FAST_JEV_PROVIDER": "openrouter"})
    value = engine(plugin)

    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY is not configured"):
        value._endpoint()
    value.compress(transcript())

    assert value.last_stats["mode"] == "fallback"
    assert sent == []


def test_endpoint_settings_survive_the_session_copy_and_stay_out_of_status(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    value = engine(plugin)
    value.provider = "openrouter"
    value.base_url = "https://openrouter.ai/api/alpha/decisions?credential=marker"
    value.api_key = "secret"
    clone = copy.deepcopy(value)
    clone.on_session_start("s1")

    assert (clone.provider, clone.base_url, clone.api_key) == ("openrouter", value.base_url, "")
    status = json.dumps(clone.get_status())
    assert "marker" not in status and "secret" not in status


def test_register_reads_provider_and_base_url_from_config(
    plugin: ModuleType, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hermes_cli import config

    cfg = {"context": {"jev": {"provider": "openrouter", "base_url": "http://local/jev", "model": "jev-latest"}}}
    monkeypatch.setattr(config, "load_config_readonly", lambda: cfg)
    registered: list[Any] = []
    plugin.register(SimpleNamespace(register_context_engine=registered.append))

    (value,) = registered
    assert (value.provider, value.base_url, value.model) == ("openrouter", "http://local/jev", "jev-latest")
