# 0001. Containerized local development; Kubernetes for production only
Date: 2026-09-26
Status: Accepted; amended by [ADR 0004](0004-host-native-make-dev.md) (optional host-native `make dev`)

## Context
D17 already chose Docker Compose over a local cluster for development, but left open whether the host needs a Python/Node toolchain (uv, pnpm) and whether the Vite dev server runs on the host. Host toolchains drift between machines and agents, and "works on my machine" bugs are expensive to find on a single production environment with no staging.

## Decision
- The host needs only Docker (with Compose), git, and make (on macOS, make and git both come with the Xcode Command Line Tools), plus `kubectl` for the manual production deploy. Python, uv, pip, Node, and pnpm are never installed on the host.
- Local development builds images locally and runs every service in containers via `infra/docker-compose.dev.yml`: `api`, `worker`, `valkey`, and `web` (Vite dev server).
- Each Dockerfile in `infra/docker/` is multi-stage: a `dev` target (dev dependencies, hot reload, bind-mounted source) that Compose uses, and a final production target that CI builds for `linux/arm64`, pushes to GHCR by git SHA, and Kubernetes runs.
- Lint, type-check, tests, and dependency changes run inside containers (`docker compose ... run --rm api uv run pytest`, `... run --rm web pnpm test`, `... run --rm api uv add <pkg>`). Lockfiles (`uv.lock`, `pnpm-lock.yaml`) are committed and installed frozen.
- `infra/k8s/` is production-only. Locally built images are never pushed or deployed; production images come only from CI.

## Alternatives considered
- **Host toolchains (uv + pnpm on the Mac) with only Valkey in Docker:** fastest editor integration, but toolchain drift and a second setup path to document and keep working.
- **Local Kubernetes (kind/k3d/minikube):** closest to production, but slow inner loop and extra resource use; the Phase 0 acceptance tests already catch topology drift.
- **Run the production images locally with no dev targets:** maximum parity, but no hot reload, so every code change needs an image rebuild.

## Consequences
- Onboarding is "install Docker, clone, `docker compose -f infra/docker-compose.dev.yml up --build`."
- The development machine is Apple Silicon, so local images are natively `linux/arm64`, matching the Oracle A1 VM.
- The first build is slower, and bind-mount file watching is slower on macOS than native.
- Editors can't resolve Python/TS imports without container-aware setup (e.g., VS Code Dev Containers attached to the `api`/`web` service). This is optional and not required to build or test.
- Build contexts on a developer machine contain `apps/api/.env`, so every build context needs a `.dockerignore` that excludes `.env` files. Secrets reach containers only at runtime via `env_file`, never as build args.
