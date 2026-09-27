# One entry point, two ways to run PitchBend Live locally (`make help` lists everything):
#   make dev  - the app on this machine (uvicorn, arq, Vite), like the Sudoku repo.
#               Run `make setup` once first. Valkey and the /media nginx still run in
#               small Docker containers, so nothing else needs installing (ADR 0004).
#   make up   - everything in Docker Compose, built from the same images as CI (ADR 0001).
# Tests, lint and checks always run in the Docker images, the ones CI uses.

SHELL := /bin/bash

COMPOSE      := docker compose -f infra/docker-compose.dev.yml
COMPOSE_DEPS := docker compose -f infra/docker-compose.deps.yml

# Overridable: make build SVC=api, make logs SVC=worker, make api-run CMD="uv add httpx"
SVC ?=
CMD ?=
SHA ?=

# `make images` builds the production targets locally, tagged :$(IMAGE_TAG).
IMAGE_TAG ?= local
GIT_SHA   ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

# Host-native `make dev` keeps its SQLite DB and media here (git-ignored); the
# production paths under /data don't exist on a Mac. Valkey comes from the deps container.
DEV_DATA := $(CURDIR)/.data
DEV_ENV  := DB_PATH="$(DEV_DATA)/db/pitchbend-live.db" MEDIA_DIR="$(DEV_DATA)/media" TMP_DIR="$(DEV_DATA)/tmp" REDIS_URL=redis://127.0.0.1:6379/0

# Node comes from apps/web/.nvmrc through nvm when nvm is installed (it's a shell
# function, so each recipe sources it); otherwise the node on PATH, which must be 24+.
# pnpm is the exact version pinned in package.json, through corepack.
NODE_SETUP = { nvm_sh="$${NVM_DIR:-$$HOME/.nvm}/nvm.sh"; \
	if [ -s "$$nvm_sh" ]; then . "$$nvm_sh" && nvm use --silent || { echo "Node 24 isn't installed: run 'nvm install 24'" >&2; exit 1; }; fi; \
	node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "PitchBend Live needs Node 24+ (found $$(node -v))" >&2; exit 1; }; }
PNPM := COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm

.PHONY: help setup setup-api setup-web dev dev-check dev-deps dev-api dev-worker dev-web \
        dev-stop build up up-d down reset logs ps test test-api test-web lint fmt check \
        validate manifests images test-browser e2e api-shell web-shell api-run web-run check-cluster \
        deploy clean

help:
	@echo "On this machine (like the Sudoku repo):"
	@echo "  setup     - once: install the API (uv) and web (pnpm) dependencies locally"
	@echo "  dev       - run the API, worker and Vite here with hot reload (Ctrl-C stops all)"
	@echo "  dev-stop  - stop the Valkey/media containers if a dev run was killed uncleanly"
	@echo "In Docker containers (the CI images):"
	@echo "  up        - build and start everything (Ctrl-C stops); up-d runs it in the background"
	@echo "  build     - build the dev images (one service: make build SVC=api)"
	@echo "  down      - stop the containers (local data is kept)"
	@echo "  logs      - follow logs (one service: make logs SVC=worker); ps lists services"
	@echo "  reset     - stop, and wipe local data from both modes (DB + media)"
	@echo "Checks (always in Docker, same as CI):"
	@echo "  test      - API (pytest) and web (vitest) unit tests"
	@echo "  lint      - ruff, mypy --strict, eslint, prettier and tsc"
	@echo "  fmt       - auto-format Python (ruff) and web (prettier) code"
	@echo "  check     - everything CI runs: lint, test and validate"
	@echo "  validate  - render and validate the K8s manifests, offline (manifests prints them)"
	@echo "  test-browser - the audio engine on real Web Audio (Chromium, Firefox, WebKit)"
	@echo "  e2e       - full-stack happy path in Chromium against a running make up-d"
	@echo "  images    - build the production images locally at :$(IMAGE_TAG) (never pushed)"
	@echo "Containers:"
	@echo "  api-shell - a shell in the api container (web-shell for web)"
	@echo "  api-run   - a command in the api container: make api-run CMD=\"uv add httpx\""
	@echo "  web-run   - a command in the web container: make web-run CMD=\"pnpm add zod\""
	@echo "Production (asks before changing anything):"
	@echo "  check-cluster - read-only checks against the current kube context"
	@echo "  deploy    - deploy: make deploy SHA=<git sha>"
	@echo "Housekeeping:"
	@echo "  clean     - stop, remove local images, host deps and build artifacts"

# ---- On this machine ---------------------------------------------------------

setup: setup-api setup-web

setup-api:
	cd apps/api && uv sync --frozen

setup-web:
	cd apps/web && $(NODE_SETUP) && $(PNPM) install --frozen-lockfile

# Ctrl-C stops everything: the trap stops the processes and the two containers.
# The Sudoku repo's `make dev` pattern, plus the worker and the deps.
dev: dev-check dev-deps
	@echo "PitchBend Live on http://localhost:5173 (API: http://localhost:8000/api/health). Ctrl-C stops everything."
	@trap 'trap - INT TERM EXIT; $(COMPOSE_DEPS) stop >/dev/null 2>&1; kill 0' INT TERM EXIT; \
		$(MAKE) --no-print-directory dev-api & \
		$(MAKE) --no-print-directory dev-worker & \
		$(MAKE) --no-print-directory dev-web

dev-check:
	@test -x apps/web/node_modules/.bin/vite || { echo "Web dependencies missing: run 'make setup' first." >&2; exit 1; }
	@if [ -n "$$($(COMPOSE) ps -q 2>/dev/null)" ]; then echo "The Docker stack (make up) is running and holds :8000/:5173. Run 'make down' first." >&2; exit 1; fi
	@command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "make dev needs ffmpeg and ffprobe on this machine: uploads and YouTube audio go through them (Phase 1). Install them (e.g. brew install ffmpeg) or use make up." >&2; exit 1; }

dev-deps:
	@mkdir -p "$(DEV_DATA)/db" "$(DEV_DATA)/media" "$(DEV_DATA)/tmp"
	@$(COMPOSE_DEPS) up -d --wait

dev-api:
	cd apps/api && $(DEV_ENV) uv run --frozen uvicorn pitchbend_live.main:app --host 127.0.0.1 --port 8000 --reload

dev-worker:
	cd apps/api && $(DEV_ENV) uv run --frozen arq --watch pitchbend_live pitchbend_live.worker.WorkerSettings

dev-web:
	cd apps/web && $(NODE_SETUP) && $(PNPM) dev

dev-stop:
	$(COMPOSE_DEPS) down

# ---- In Docker containers ------------------------------------------------------

build:
	$(COMPOSE) build $(SVC)

# -V recreates the anonymous node_modules volume from the freshly built web image,
# so dependency changes land without extra steps. The named data volume is untouched.
up:
	$(COMPOSE) up --build -V

up-d:
	$(COMPOSE) up --build -V -d

down:
	$(COMPOSE) down

# Wipes the Compose data volume (make up) and .data (make dev).
reset:
	$(COMPOSE) down -v
	-$(COMPOSE_DEPS) down
	rm -rf .data

logs:
	$(COMPOSE) logs -f $(SVC)

ps:
	$(COMPOSE) ps

# ---- Checks (always in Docker, same as CI) -------------------------------------

test: test-api test-web

# --no-deps: the unit tests need no Valkey, so none is started.
test-api:
	$(COMPOSE) run --rm --no-deps api uv run pytest -q

test-web:
	$(COMPOSE) run --rm --no-deps web pnpm test

lint:
	$(COMPOSE) run --rm --no-deps api sh -c 'uv run ruff check . && uv run ruff format --check . && uv run mypy pitchbend_live'
	$(COMPOSE) run --rm --no-deps web sh -c 'pnpm lint && pnpm format:check && pnpm typecheck'

fmt:
	$(COMPOSE) run --rm --no-deps api uv run ruff format .
	$(COMPOSE) run --rm --no-deps web pnpm format

check: lint test validate

validate:
	infra/scripts/validate-manifests.sh

manifests:
	kubectl kustomize infra/k8s

# The production targets, built here only to catch Dockerfile breakage before a
# push. Unlike the Sudoku repo there is deliberately no `publish`: production
# images come only from CI (ADR 0001).
images:
	docker build -f infra/docker/api.Dockerfile --build-arg GIT_SHA=$(GIT_SHA) -t pitchbend-live-api:$(IMAGE_TAG) .
	docker build -f infra/docker/web.Dockerfile --build-arg GIT_SHA=$(GIT_SHA) -t pitchbend-live-web:$(IMAGE_TAG) .

# Playwright runs in the pinned image (matches @playwright/test 1.63.0); a named volume
# keeps its Linux node_modules apart from the host's.
PLAYWRIGHT := docker run --rm --init --shm-size=1g -v "$(CURDIR)":/work -v pitchbend-live-e2e-node-modules:/work/apps/web/node_modules -v pitchbend-live-e2e-pnpm-store:/pnpm-store -e PNPM_CONFIG_STORE_DIR=/pnpm-store -w /work/apps/web -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PW_IMAGE   := mcr.microsoft.com/playwright:v1.63.0-noble

# The audio engine on real Web Audio in Chromium, Firefox and WebKit (no stack needed).
test-browser:
	$(PLAYWRIGHT) $(PW_IMAGE) bash -c "corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm run test:e2e:engine"

# The full-stack happy path (upload, play, +2, export) against a running `make up-d`.
e2e:
	@curl -sf http://localhost:5173/ >/dev/null || { echo "Start the stack first: make up-d" >&2; exit 1; }
	$(PLAYWRIGHT) --network host -e PW_BROWSERS=none -e E2E_BASE_URL=http://localhost:5173 $(PW_IMAGE) bash -c "corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm exec playwright test --project=app-chromium"
# ---- Containers ----------------------------------------------------------------

api-shell:
	$(COMPOSE) run --rm --no-deps api sh

web-shell:
	$(COMPOSE) run --rm --no-deps web sh

api-run:
	$(if $(strip $(CMD)),,$(error usage: make api-run CMD="uv add httpx"))
	$(COMPOSE) run --rm --no-deps api $(CMD)

web-run:
	$(if $(strip $(CMD)),,$(error usage: make web-run CMD="pnpm add zod"))
	$(COMPOSE) run --rm --no-deps web $(CMD)

# ---- Production ------------------------------------------------------------------
# The pitchbend-live namespace is the only environment (CLAUDE.md). check-cluster is
# read-only; deploy.sh prints the kube context and asks before applying anything.

check-cluster:
	infra/scripts/check-cluster.sh

deploy:
	$(if $(strip $(SHA)),,$(error usage: make deploy SHA=<git sha>  e.g. SHA=$$(git rev-parse HEAD)))
	infra/scripts/deploy.sh $(SHA)

# ---- Housekeeping ------------------------------------------------------------------

# Frees disk (the api image alone is ~850 MB). Local data stays; see `reset`.
clean:
	$(COMPOSE) down
	-$(COMPOSE_DEPS) down
	-docker image rm pitchbend-live-api:dev pitchbend-live-web:dev pitchbend-live-api:$(IMAGE_TAG) pitchbend-live-web:$(IMAGE_TAG) 2>/dev/null
	rm -rf apps/api/.venv apps/web/node_modules apps/web/dist apps/web/coverage
	find apps -name __pycache__ -type d -prune -exec rm -rf {} +
