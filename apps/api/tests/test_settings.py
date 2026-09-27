"""Contract tests: Settings must match ARCHITECTURE.md §6.2 exactly.

A failure here means a §6.2 key or value drifted. Changing §6.2 is a contract change:
write an ADR and update ARCHITECTURE.md, this file, and .env.example together.
"""

from pathlib import Path

import pytest
from pydantic import SecretStr

from keyshift.settings import Settings

# ARCHITECTURE.md §6.2, ConfigMap keyshift-config (verbatim).
CONFIGMAP: dict[str, str | int] = {
    "PUBLIC_HOST": "keyshift.duckdns.org",
    "DUCKDNS_SUBDOMAIN": "keyshift",
    "REDIS_URL": "redis://valkey:6379/0",
    "DB_PATH": "/data/db/keyshift.db",
    "MEDIA_DIR": "/data/media",
    "MEDIA_BASE_URL": "/media",
    "MAX_DURATION_S": 720,
    "MAX_UPLOAD_MB": 50,
    "MEDIA_TTL_HOURS": 24,
    "RATE_LIMIT_JOBS_PER_HOUR": 10,
    "WORKER_CONCURRENCY": 1,
    "TMP_DIR": "/data/tmp",
}
# ARCHITECTURE.md §6.2, Secret keyshift-secrets. The code defaults to empty strings;
# the placeholder values below appear only in .env.example / secret.example.yaml.
SECRET_PLACEHOLDERS: dict[str, str] = {"DUCKDNS_TOKEN": "changeme", "SENTRY_DSN": ""}
BUILD_METADATA = {"GIT_SHA"}

ENV_EXAMPLE = Path(__file__).resolve().parents[1] / ".env.example"


def test_settings_declares_exactly_the_contract_keys() -> None:
    assert set(Settings.model_fields) == set(CONFIGMAP) | set(SECRET_PLACEHOLDERS) | BUILD_METADATA


@pytest.mark.parametrize(("key", "value"), CONFIGMAP.items())
def test_configmap_defaults_match_contract(key: str, value: str | int) -> None:
    default = Settings.model_fields[key].default
    assert default == value
    assert type(default) is type(value)


@pytest.mark.parametrize("key", sorted(SECRET_PLACEHOLDERS))
def test_secret_defaults_are_empty(key: str) -> None:
    default = Settings.model_fields[key].default
    assert isinstance(default, SecretStr)
    assert default.get_secret_value() == ""


def test_git_sha_defaults_to_dev() -> None:
    assert Settings.model_fields["GIT_SHA"].default == "dev"


def test_empty_environment_yields_contract_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in Settings.model_fields:
        monkeypatch.delenv(key, raising=False)

    settings = Settings()

    assert {key: getattr(settings, key) for key in CONFIGMAP} == CONFIGMAP
    assert settings.DUCKDNS_TOKEN.get_secret_value() == ""
    assert settings.SENTRY_DSN.get_secret_value() == ""
    assert settings.GIT_SHA == "dev"


def test_environment_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("MAX_UPLOAD_MB", "60")
    monkeypatch.setenv("GIT_SHA", "abc1234")

    settings = Settings()

    assert settings.REDIS_URL == "redis://localhost:6379/1"
    assert settings.MAX_UPLOAD_MB == 60
    assert settings.GIT_SHA == "abc1234"


def test_secrets_are_masked_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DUCKDNS_TOKEN", "not-a-real-token")

    settings = Settings()

    assert settings.DUCKDNS_TOKEN.get_secret_value() == "not-a-real-token"
    assert "not-a-real-token" not in repr(settings)
    assert "not-a-real-token" not in str(settings)


@pytest.mark.skipif(
    not ENV_EXAMPLE.exists(),
    reason=".env.example not found (it is never copied into the image)",
)
def test_env_example_matches_contract() -> None:
    parsed: dict[str, str] = {}
    for raw in ENV_EXAMPLE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        parsed[key] = value

    assert parsed == {k: str(v) for k, v in CONFIGMAP.items()} | SECRET_PLACEHOLDERS
