"""Runtime configuration.

Every key and default below is the contract in ARCHITECTURE.md §6.2. In production the
values come from the ConfigMap ``keyshift-config`` and the Secret ``keyshift-secrets``
(injected with ``envFrom``); locally from ``apps/api/.env`` via Docker Compose ``env_file``.
Only environment variables are read; this module never opens a ``.env`` file itself.
"""

from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=True, frozen=True)

    # ConfigMap keyshift-config (§6.2)
    PUBLIC_HOST: str = "keyshift.duckdns.org"
    DUCKDNS_SUBDOMAIN: str = "keyshift"
    REDIS_URL: str = "redis://valkey:6379/0"
    DB_PATH: str = "/data/db/keyshift.db"
    MEDIA_DIR: str = "/data/media"
    MEDIA_BASE_URL: str = "/media"
    MAX_DURATION_S: int = 720
    MAX_UPLOAD_MB: int = 50
    MEDIA_TTL_HOURS: int = 24
    RATE_LIMIT_JOBS_PER_HOUR: int = 10
    WORKER_CONCURRENCY: int = 1  # 1 OCPU VM shared with Sudoku (ADR 0003)
    TMP_DIR: str = "/data/tmp"  # upload/download staging on the shared PVC (ADR 0005 §10)

    # Secret keyshift-secrets (§6.2). SecretStr keeps values out of repr() and logs.
    DUCKDNS_TOKEN: SecretStr = SecretStr("")
    SENTRY_DSN: SecretStr = SecretStr("")

    # Build metadata baked into the image (ARG/ENV GIT_SHA); not a ConfigMap key.
    GIT_SHA: str = "dev"


@lru_cache
def get_settings() -> Settings:
    return Settings()
