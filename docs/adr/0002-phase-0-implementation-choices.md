# 0002. Phase 0 implementation choices
Date: 2026-09-26
Status: Accepted

## Context
Building Phase 0 (ARCHITECTURE.md §9) required choices that §9 leaves open, a few small departures from its wording, and some additions to the §6.1 repo layout. CLAUDE.md requires recording these, not improvising silently. None of them changes a REST shape, SSE event, identifier, DB schema, or §6.2 ConfigMap/Secret key.

## Decision

**Build and images**
- **Build context is the repo root**, filtered by BuildKit's Dockerfile-specific ignore files (`infra/docker/<name>.Dockerfile.dockerignore`). They are allowlists: exclude everything, re-include only what the image needs, then re-exclude `.env*`, caches, `node_modules`, and `dist`. This lets `web.Dockerfile` copy `infra/docker/nginx.conf` without widening the context.
- **Stage names:** `api.Dockerfile` has `runtime → dev`, `build → prod`. `web.Dockerfile` has `deps → dev → build → prod`. `prod` is always last, so a plain `docker build` produces the production image.
- **`GIT_SHA` build arg / env var** carries the image's git SHA into `GET /api/health` (`version`). It is build metadata baked into the image, not a §6.2 ConfigMap key. Images are tagged with the full and short (7-char) SHA, never `latest`.
- **Node 24 LTS** replaces "Node 20+" because Node 20 reached end-of-life in April 2026. **TypeScript 6.0.x**, because typescript-eslint doesn't support TS 7 yet.
- **Dev tooling runs as the images' non-root users** (10001 for api, `node` for web). Tool caches live in `/tmp` so bind mounts stay clean. `WATCHFILES_FORCE_POLLING` / `CHOKIDAR_USEPOLLING` are on, because file events don't cross the macOS virtiofs bind mount.
- **The Python dev group uses `httpx2`**, which Starlette 1.7's TestClient now requires. It's a test-only dependency.

**API skeleton**
- **Secrets are `SecretStr`** in `Settings`, so they stay out of `repr()` and logs. Settings read only from the environment; Compose `env_file` and K8s `envFrom` supply the values.
- **OpenAPI docs are served at `/api/docs`** (`/api/openapi.json`), because only `/api` is routed to the api Service.
- **The ARQ `health_check_interval` is 30 s** (the default is 3600 s), so `arq --check` can serve as the worker's exec probe.

**Local development (refines ADR 0001)**
- **Compose adds a `media` service:** the pinned nginx-unprivileged image with the real `infra/docker/nginx.conf`, serving the shared volume read-only. Vite proxies `/media` to it. Dev exercises the exact production `/media` config, and the API never serves media files.
- **Fresh named volumes:** the api image pre-creates `/data/{media,db}` owned by 10001, so a fresh Compose named volume inherits that ownership. `worker` and `media` start after `api`.

**Kubernetes**
- **`deploy.sh` pins image tags with a temporary Kustomize overlay.** It copies `infra/k8s` into a `mktemp -d` directory as `./base`, because kubectl's built-in kustomize rejects absolute base paths, and adds an `images:` override. This replaces §9's `kustomize edit set image`: no standalone kustomize binary is needed, and the committed `kustomization.yaml` never changes.
  - The base uses the placeholder tag `set-by-deploy-sh`, so a bare `kubectl apply -k infra/k8s` fails safely with ImagePullBackOff.
  - `deploy.sh` refuses a render that contains a Secret, a placeholder tag, an untagged image, or `latest`. It then applies **exactly the checked render** (`kubectl apply -f`).
- **`deploy.sh` checks GHCR anonymously** that both images exist, are public, and include linux/arm64 before applying. New GHCR packages are private by default, and the cluster pulls anonymously.
- **The api/worker init container sets permissions.** It creates `/data/media` (0755) and `/data/db` (0750), so the web pod (uid 101) can read media but not the SQLite file at the filesystem level. This is defense in depth on top of the nginx config.
- **Every pod sets `enableServiceLinks: false`.** Uptime Kuma requires it: the injected `UPTIME_KUMA_PORT=tcp://…` would otherwise override its listen port.
- **Uptime Kuma uses the `2.5.5-slim-rootless` image** (uid 1000) with `UPTIME_KUMA_DB_TYPE=sqlite`, so a rebuilt cluster needs no manual database-setup step.
- **The namespace has Pod Security labels** `enforce: baseline` and `warn`/`audit: restricted`. `restricted` isn't enforced because some cert-manager versions create HTTP-01 solver pods in the namespace that don't meet it.
- **The Secret is created with `--from-file=KEY=<(printf …)`** after `read -rsp`, so values never appear in shell history or any process's argv. The DuckDNS CronJob passes the token to curl through `--config -` on stdin, for the same reason.
- **`FORWARDED_ALLOW_IPS`**, uvicorn's own env var, is set in `api.yaml` to the pod CIDR (default `10.42.0.0/16`, the k3s default). `check-cluster.sh` prints the real CIDR. It is not a §6.2 key.
- **The Ingress supports Traefik and ingress-nginx.** It carries the §9 ingress-nginx annotations, which Traefik ignores, and uses the cluster's default IngressClass unless `ingressClassName` is uncommented. `check-cluster.sh` fails if the cluster has no default IngressClass. *(Superseded in part by [ADR 0003](0003-shared-cluster-with-sudoku-solver.md): the cluster is known to run Traefik, so the class is now set explicitly to `traefik`.)*
- **Valkey runs with `--maxmemory` below its 512Mi limit and `--maxmemory-policy noeviction`,** so it rejects writes instead of being OOM-killed or silently evicting queued jobs.
- **The DuckDNS CronJob gets only `DUCKDNS_SUBDOMAIN` and `DUCKDNS_TOKEN`** (key refs, not `envFrom`), and never prints the URL or token.
- **All pods set `automountServiceAccountToken: false`, `seccompProfile: RuntimeDefault`, and drop all capabilities.**

**CI**
- **CI runs lint, type-check, and tests inside the `dev` images** on native arm64 runners, the same images used locally. It uses `pull_request` (never `pull_request_target`) with a read-only token. Only the `main` image workflow gets `packages: write`. Third-party actions are pinned to commit SHAs.
- **`infra/scripts/validate-manifests.sh`** renders `infra/k8s` and validates it (kustomize, kubeconform, shellcheck) in pinned containers, both locally and in CI. It never contacts a cluster.

**Repo additions to §6.1**
- `Makefile` (local entry point wrapping `docker compose -f infra/docker-compose.dev.yml`, modeled on the Sudoku repo, with no `publish` target), `README.md`, `LICENSE` (GPL-3.0-or-later), `.gitignore`, `.github/workflows/{ci,images}.yml`, `docs/architecture-diagram.md`, `infra/docker/*.Dockerfile.dockerignore`, `infra/scripts/validate-manifests.sh`, `apps/api/uv.lock`, `apps/web/pnpm-lock.yaml`.

**Deferred**
- The weekly image rebuild that keeps yt-dlp current (§14) moves to Phase 1, when yt-dlp is first installed.
- JSON logging (§7) moves to Phase 1, alongside the first real log producers.

## Alternatives considered
- **`kustomize edit set image` on the committed file:** it needs a kustomize binary on the host, which ADR 0001 rules out, and it leaves a dirty working tree after every deploy.
- **A Vite plugin to serve `/media` in dev:** less code, but it would skip the production nginx config, including the alias and autoindex rules that protect the SQLite DB.
- **Mounting only `/data/media` into the web pod (`subPath`):** this removes the risk of nginx exposing the DB. It was rejected for now: kubelet creates a missing subPath directory as root, which races with the api init container on local-path storage. The nginx config is instead tested against traversal instead. Revisit it with an ADR if the storage class changes.
- **An echo endpoint for the 50 MB Ingress test:** that would be a §6.4 change. `POST /api/health` with `Expect:` disabled is enough to prove the Ingress doesn't return 413.

## Verification
Before any production deploy, the manifests were smoke-tested once on a local throwaway cluster (Rancher Desktop k3s v1.35.4 with Traefik and local-path storage, namespace `keyshift-smoke`, deleted afterward). The overlay used locally built images and plain HTTP. With it:
- All five Deployments became Ready as non-root with no restarts, including Uptime Kuma as uid 1000.
- SSE ticks arrived 1 s apart through Traefik.
- A 50 MB POST returned 405, not 413.
- `/media` served with the 24 h immutable header, and traversal attempts never returned the DB.
- The web pod was denied reading `/data/db/keyshift.db`.
- A `rollout restart` of api never ran two api pods at once.

## Consequences
- **Operator steps:** after the first image push, make both GHCR packages public once. Set `FORWARDED_ALLOW_IPS` and, if needed, `ingressClassName` from `check-cluster.sh` output.
- **Ingress class:** if the cluster runs Traefik v3, slow uploads may hit its default 60 s entrypoint `readTimeout`. The README documents raising it.
- **Image sizes:** the api image is about 850 MB unpacked, mostly ffmpeg and its Debian dependencies. The web image is about 82 MB.
- **pnpm 12's default one-day `minimumReleaseAge`:** `pnpm add` of a package published less than a day ago silently writes an exclusion into `pnpm-workspace.yaml`. Review that file before committing dependency changes.
