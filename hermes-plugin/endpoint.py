"""Which Jev endpoint to call, and which key to send it (mirrors src/endpoint.ts).

Endpoint: an explicit base URL, else the provider (``typesafe`` | ``openrouter``),
else TypeSafe when a TypeSafe key is present, else OpenRouter when only an
OpenRouter key is, else TypeSafe. Key: an explicit key, else the endpoint's own
key name first and the other as a fallback, so the TypeSafe key never reaches
OpenRouter while an OpenRouter key exists.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import NamedTuple
from urllib.parse import urlsplit

SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone"
# OpenRouter's Decisions endpoint: same request body and ``answers`` as System One.
OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
PROVIDERS = ("typesafe", "openrouter")


class JevEndpoint(NamedTuple):
    base_url: str
    provider: str  # typesafe | openrouter | custom
    key_name: str  # the name the key is expected under, for "not configured" errors
    api_key: str  # "" when no key was found


def _clean(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_provider(value: object) -> str:
    """``typesafe`` or ``openrouter`` (any case), else ""."""
    normalized = _clean(value).lower()
    return normalized if normalized in PROVIDERS else ""


def host_of(url: str) -> str:
    """Lower-case host only: no credentials, path or query."""
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _provider_of(url: str) -> str:
    host = host_of(url)
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        return "openrouter"
    if host == host_of(SYSTEM_ONE_URL):
        return "typesafe"
    return "custom"


def resolve_endpoint(
    *,
    api_key: str = "",
    base_url: str = "",
    provider: str = "",
    typesafe_key: str = "",
    openrouter_key: str = "",
) -> JevEndpoint:
    typesafe_key, openrouter_key = _clean(typesafe_key), _clean(openrouter_key)
    explicit_url = _clean(base_url)
    chosen = parse_provider(provider) or (
        "typesafe" if typesafe_key else "openrouter" if openrouter_key else "typesafe"
    )
    if explicit_url:
        url, kind = explicit_url, _provider_of(explicit_url)
    else:
        url = OPENROUTER_DECISIONS_URL if chosen == "openrouter" else SYSTEM_ONE_URL
        kind = chosen
    if kind == "openrouter":
        key_name, named = "OPENROUTER_API_KEY", openrouter_key or typesafe_key
    else:
        key_name, named = "TYPESAFE_API_KEY", typesafe_key or openrouter_key
    return JevEndpoint(url, kind, key_name, _clean(api_key) or named)


_PATCH_PIN = re.compile(r"^jev-(\d+\.\d+)\.\d+$")


def model_for(provider: str, model: str) -> str:
    """OpenRouter serves Jev by minor version only (``jev-latest``, ``jev-1.13``,
    ``typesafe/jev-1.13``) and rejects TypeSafe's patch pins: ``jev-1.13.0`` is
    sent there as ``typesafe/jev-1.13``."""
    if provider != "openrouter" or not isinstance(model, str):
        return model
    pin = _PATCH_PIN.match(model.strip())
    return f"typesafe/jev-{pin.group(1)}" if pin else model


def endpoint_from(
    lookup: Callable[[str], str | None],
    *,
    api_key: str = "",
    base_url: str = "",
    provider: str = "",
) -> JevEndpoint:
    """Engine settings first, then the variables ``lookup`` resolves:
    FAST_JEV_API_KEY, FAST_JEV_BASE_URL (or TYPESAFE_BASE_URL), FAST_JEV_PROVIDER,
    TYPESAFE_API_KEY and OPENROUTER_API_KEY. ``lookup`` may raise; callers fail closed."""
    return resolve_endpoint(
        api_key=_clean(api_key) or _clean(lookup("FAST_JEV_API_KEY")),
        base_url=_clean(base_url)
        or _clean(lookup("FAST_JEV_BASE_URL"))
        or _clean(lookup("TYPESAFE_BASE_URL")),
        provider=_clean(provider) or _clean(lookup("FAST_JEV_PROVIDER")),
        typesafe_key=_clean(lookup("TYPESAFE_API_KEY")),
        openrouter_key=_clean(lookup("OPENROUTER_API_KEY")),
    )
