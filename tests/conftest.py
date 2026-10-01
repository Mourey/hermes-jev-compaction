"""Every test writes saved outputs under a temporary Hermes home, never the real one."""

import pytest

# A real key or endpoint override in the developer's shell would change which
# endpoint and key the engine picks.
_JEV_ENV = (
    "TYPESAFE_API_KEY",
    "OPENROUTER_API_KEY",
    "FAST_JEV_API_KEY",
    "FAST_JEV_PROVIDER",
    "FAST_JEV_BASE_URL",
    "TYPESAFE_BASE_URL",
)


@pytest.fixture(autouse=True)
def _hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    for name in _JEV_ENV:
        monkeypatch.delenv(name, raising=False)
