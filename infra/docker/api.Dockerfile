# PitchBend Live api + worker image (the worker runs the same image with
# `arq pitchbend_live.worker.WorkerSettings`, D16).
#
# Build context is the REPO ROOT; only paths allowlisted in
# infra/docker/api.Dockerfile.dockerignore are sent:
#   docker build -f infra/docker/api.Dockerfile --target dev  -t pitchbend-live-api:dev .
#   docker build -f infra/docker/api.Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t pitchbend-live-api:<sha> .
#
# Targets: `dev` (Docker Compose, CI lint/tests) and `prod` (last stage = default; CI → GHCR → K8s).
# Never pass secrets as build args: GHCR images are public (CLAUDE.md §2).

ARG PYTHON_IMAGE=python:3.12.14-slim-trixie

FROM ghcr.io/astral-sh/uv:0.12.19 AS uv

# ---------------------------------------------------------------------------
# runtime: OS layer shared by dev and prod (Python, ffmpeg, user, /data layout)
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Fixed uid/gid 10001 so K8s securityContext/fsGroup and Compose named volumes agree.
# /data/{media,db} are pre-created so a fresh named volume inherits 10001 ownership.
RUN groupadd --system --gid 10001 pitchbend \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin pitchbend \
    && mkdir -p /data/media /data/db /data/tmp \
    && chown -R 10001:10001 /data

WORKDIR /app

# ---------------------------------------------------------------------------
# dev: dev dependency group, editable install, hot reload (Compose + CI checks)
# ---------------------------------------------------------------------------
FROM runtime AS dev

COPY --from=uv /uv /uvx /usr/local/bin/

# The venv lives outside /app so a bind mount of apps/api -> /app doesn't hide it.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/tmp/uv-cache \
    RUFF_CACHE_DIR=/tmp/.ruff_cache \
    MYPY_CACHE_DIR=/tmp/.mypy_cache \
    WATCHFILES_FORCE_POLLING=true
# ^ Host file events don't reach containers through the macOS (virtiofs) bind mount,
#   so `uvicorn --reload` must poll to notice edits.

# Owned by 10001 so `uv add` / `uv run` inside the dev container can update the venv.
RUN mkdir -p /opt/venv && chown 10001:10001 /opt/venv /app
USER 10001

COPY --chown=10001:10001 apps/api/pyproject.toml apps/api/uv.lock ./
RUN --mount=type=cache,target=/tmp/uv-cache,uid=10001,gid=10001 \
    uv sync --frozen --no-install-project

COPY --chown=10001:10001 apps/api/pitchbend_live ./pitchbend_live
COPY --chown=10001:10001 apps/api/tests ./tests
RUN --mount=type=cache,target=/tmp/uv-cache,uid=10001,gid=10001 \
    uv sync --frozen

EXPOSE 8000
CMD ["uvicorn", "pitchbend_live.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--reload"]

# ---------------------------------------------------------------------------
# build: resolve the production venv (no dev group, non-editable) for prod
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS build

COPY --from=uv /uv /usr/local/bin/uv

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_CACHE_DIR=/tmp/uv-cache

WORKDIR /app

COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN --mount=type=cache,target=/tmp/uv-cache \
    uv sync --frozen --no-dev --no-install-project

COPY apps/api/pitchbend_live ./pitchbend_live
RUN --mount=type=cache,target=/tmp/uv-cache \
    uv sync --frozen --no-dev --no-editable

# ---------------------------------------------------------------------------
# prod: runtime + venv only (no uv, no dev tools, no tests). Must stay LAST.
# ---------------------------------------------------------------------------
FROM runtime AS prod

COPY --from=build /opt/venv /opt/venv

# Declared after the COPY so a new SHA doesn't invalidate the venv layer.
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.title="pitchbend-live-api" \
      org.opencontainers.image.source="https://github.com/edwinargueta/PitchBend-Live" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.revision="${GIT_SHA}"

USER 10001
EXPOSE 8000
# --forwarded-allow-ips is deliberately not set here: uvicorn reads FORWARDED_ALLOW_IPS
# from the environment (set to the pod CIDR by the K8s manifest, CLAUDE.md §5).
CMD ["uvicorn", "pitchbend_live.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
