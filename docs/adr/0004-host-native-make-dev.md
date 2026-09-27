# 0004. Host-native `make dev` alongside containerized `make up`
Date: 2026-09-26
Status: Accepted (amends ADR 0001)

## Context
ADR 0001 made Docker Compose the only way to run PitchBend Live locally, with no Python or Node toolchain on the host. The user asked for the workflow they use in the Sudoku Solver repo: `make dev` runs the app directly on the Mac, and `make up` keeps running the Docker containers. Native processes start faster, reload without bind-mount polling, and give the editor real import resolution. That last one was a consequence ADR 0001 accepted.

The Mac already has uv, and nvm with Node 24. It has no Valkey or Redis, and no nginx.

## Decision
- **`make dev` runs the three app processes natively:** uvicorn (API, `--reload`, `127.0.0.1:8000`), arq (worker, `--watch`), and Vite (`127.0.0.1:5173`). `make setup` installs their dependencies once:
  - `uv sync --frozen` into `apps/api/.venv`. uv downloads its own Python 3.12, leaving the system Python alone.
  - `pnpm install --frozen-lockfile` into `apps/web/node_modules`, with Node from `apps/web/.nvmrc` via nvm and the `packageManager`-pinned pnpm via corepack.
- **Backing services stay in Docker** (`infra/docker-compose.deps.yml`, project `pitchbend-live-deps`): Valkey on `127.0.0.1:6379`, and the `/media` nginx with the real `infra/docker/nginx.conf` on `127.0.0.1:8081`. Nothing else needs installing, and `/media` keeps the production config. `make dev` starts them, and its Ctrl-C trap stops them together with the three processes.
- **Host-native paths:** the production paths under `/data` don't exist on a Mac, so `make dev` sets `DB_PATH` / `MEDIA_DIR` to the git-ignored `.data/` and `REDIS_URL` to the Valkey container. These are the same §6.2 **keys** with dev-only **values**; nothing in §6 changes.
- **Vite config reads its host and proxy targets from the environment** (`DEV_SERVER_HOST`, `API_PROXY_TARGET`, `MEDIA_PROXY_TARGET`). They default to the host-native setup: localhost only, so the dev server isn't exposed to the local network. Compose sets `0.0.0.0` and the service names.
- **`apps/web/.npmrc` pins the public npm registry** (as in the Sudoku repo), so a machine-level registry override doesn't break installs. The lockfile resolves from the public registry.
- **Unchanged from ADR 0001:**
  - `make up` is the containerized stack.
  - Tests, lint, type-check and manifest validation (`make test`, `make lint`, `make check`) always run in the Docker `dev` images, exactly as CI does.
  - Production images come only from CI.
  - pip is never used.

## Alternatives considered
- **Fully native, including Valkey and nginx via Homebrew:** closer to "no Docker for dev", but it adds two host installs and serves `/media` with a config that isn't the production one.
- **Serve `/media` from Vite or FastAPI in native mode:** less machinery, but it skips the nginx rules that keep the SQLite DB unreachable (ADR 0002). An API media route could also leak into production.
- **Keep container-only dev (ADR 0001 as written):** rejected by the user in favor of Sudoku parity.

## Consequences
- **Two local modes to keep working.** `make check` still gates everything through the containers, so CI parity holds. `make dev` can drift if host tool versions drift. `.nvmrc`, uv's managed Python, and the frozen lockfiles limit that.
- **One mode at a time.** Both use `:5173` and `:8000`, and `make dev` refuses to start while `make up` is running.
- **Separate data.** Host-native data lives in `.data/`, and Compose data in the `pitchbend-live-data` volume. `make reset` wipes both.
- **Host tooling is now opt-in, not forbidden.** Agents still use the containers for checks, and don't install host toolchains without asking (CLAUDE.md).
