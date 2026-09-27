# CLAUDE.md — KeyShift guardrails

**KeyShift** (repo `PitchBend-Live`) lets a musician paste a YouTube URL or upload audio, then transpose it live in the browser without changing tempo. It runs at **$0/month** on one Oracle Always-Free Ampere A1 (arm64) VM with single-node Kubernetes.

`ARCHITECTURE.md` holds the full design, contracts, and phase plan. This file does **not** summarize it. It lists the rules that cause **silent, costly, or hard-to-reverse** damage when broken, and explains how to find things in the design doc. Here, `§N` means a section of ARCHITECTURE.md and `DN` means a row in its §5 decision log. Sections of *this* file are referred to by name.

---

## 1. Working with ARCHITECTURE.md

- **Read first:** read §1–7 in full before any task, because they apply to every phase. Then read **only** your assigned phase's section.
- **Current phase: Phase 1, MVP (§10).** If nobody assigned you a phase, work in this one. Phase 0 is built and verified locally but not yet deployed; on 2026-09-26 the user chose to start Phase 1 anyway. Phase 1 is done only when its acceptance criteria pass on the cluster, and that includes deploying Phase 0. Normally Phase N must be deployed and working before Phase N+1 starts (§8).
- **Stay in phase.** Don't build later-phase features, even when it would be convenient. Each phase's *Out of scope* list is binding.
- **Done means the acceptance criteria pass** (§2). Never loosen a test, threshold, or acceptance criterion to reach that.
- **Stay in your workstream.** Workstreams run in parallel. In Phase 1 (§10) they are A = `apps/api/`, B = `apps/web/src/audio/`, and C = `apps/web/src/features/`. Shared code (`apps/web/src/lib/` and anything defined in §6) is a coordination point, so flag changes to it instead of making them on your own.
- **Precedence:** §6 (Contracts) overrides all other ARCHITECTURE.md text, including phase tasks and acceptance criteria. If two sections contradict each other, or this file contradicts ARCHITECTURE.md, **stop and ask**. Never resolve it silently.
- **Uncovered decisions:** if a choice isn't covered and it touches §6 or any rule here, write an ADR in `docs/adr/NNNN-title.md` (template in §13), add a one-line row to §5, and flag it. When in doubt, take the more conservative reading.

| Need | Look in |
|---|---|
| Free-tier allowances; stack choices and their tradeoffs | §3.1, §3.2 |
| Oracle VM gotchas (two firewalls, idle reclamation, real client IP) | §3.3 |
| arm64 status and licenses of known dependencies | §3.4, §3.5 |
| VM size (1 OCPU / 6 GB), per-workload requests and limits | §3.6, ADR 0003 |
| Shared cluster with the Sudoku Solver (Traefik, cert-manager, issuer) | §3.7, ADR 0003 |
| Topology diagram and the core principle | §4 |
| Why a decision was made (D1–D22) | §5 |
| Repo layout, env vars, identifiers | §6.1–6.3 |
| REST API, SSE events, error codes | §6.4–6.6 |
| SQLite schema; `AudioEngine` interface and music-theory utils | §6.7, §6.8 |
| Local dev setup, toolchain, CI/deploy, logging, security baseline, accessibility | §7, D17, ADR 0001 |
| Dockerfile targets and Compose services | §9 tasks 4 and 12 |
| Tasks, acceptance criteria, and out-of-scope items per phase | §9 (P0) · §10 (P1) · §11 (P2) · §12 (P3) |
| Known risks and their mitigations | §14 |

---

## 2. Ask the user before you act

These actions touch production, publish something, or break the project's premise. Approval for one of them does not cover the next.

- **Anything that touches the cluster.** The `keyshift` namespace on the Oracle VM is the **only** environment. There is no staging. Running `infra/scripts/deploy.sh`, `kubectl apply -k infra/k8s`, or any `kubectl delete/edit/patch/scale/rollout restart` in `keyshift` changes production. Deleting the namespace or PVC also destroys `keyshift-secrets`, which is stored nowhere else.
- **Anything outside the `keyshift` namespace.** The cluster is shared with the Sudoku Solver (§3.7). Treat each of these as another app's production:
  - `sudoku-prod`
  - `kube-system` (Traefik, including applying `infra/k8s-bootstrap/`)
  - `cert-manager` and the `letsencrypt-prod` ClusterIssuer
  - any cluster-scoped resource
- **Creating the GitHub repo or making the first push.** The repo is public by design, and the first push publishes the entire history.
- **Anything that could cost money:** a paid service, a new cloud resource, or a paid tier of a free one.
- **Changing a §6 contract** beyond what your phase already specifies (see *Contracts*).
- **Anything under *Project constraints* or *YouTube ToS posture*.** These also need an ADR.

---

## 3. Local = `make dev` or `make up`, production = Kubernetes

(D17, D20, ADR 0001, ADR 0004.) You can build, run, and test everything locally without touching the VM. The Makefile is the entry point, with two ways to run the app:

- **`make dev`** runs the app **on the host**, like the Sudoku repo:
  - The API (uvicorn), the worker (arq), and Vite run natively. Only Valkey and the `/media` nginx run in Docker (`infra/docker-compose.deps.yml`).
  - It needs uv and Node 24 (via nvm and `apps/web/.nvmrc`). Run `make setup` once.
  - Host data lives in the git-ignored `.data/`.
- **`make up`** runs everything **in Docker Compose**, using the same images CI builds.
- **The two can't run at once:** both use `:5173` and `:8000`.
- **Host toolchains are opt-in.** The user has uv and Node 24 for `make dev`, but don't install or upgrade host tools yourself without asking, and never use pip. Run anything that must match CI in the containers:
  - `make check` runs everything CI runs: lint, type-check, tests, and manifest validation. Use it, not host tools, to verify a change.
  - `make api-run CMD="…"` / `make web-run CMD="…"` runs any command in a container, e.g. `make api-run CMD="uv add <pkg>"`.
  - `make help` lists every target. The Makefile is a thin wrapper around `docker compose -f infra/docker-compose.dev.yml`, so the raw commands also work, e.g. `docker compose -f infra/docker-compose.dev.yml run --rm api uv run pytest`.
  - `make deploy` runs `deploy.sh` against production, and `make check-cluster` touches the live cluster. Both fall under *Ask the user before you act*.
- **Use one set of Dockerfiles for both environments.** Each file in `infra/docker/` has a `dev` target (dev dependencies, hot reload, bind-mounted source) for Compose, and a final production target that CI builds and Kubernetes runs. Don't add separate dev-only Dockerfiles; they drift.
- **Local images never ship.** Production images come only from CI: built for `linux/arm64`, tagged with the git SHA, pushed to GHCR, then deployed with `deploy.sh`. Never push or deploy an image you built locally.
- **`infra/k8s/` is production-only.** Don't run a local cluster (kind, k3d, minikube), and never point Compose at the VM.
- **Compose mirrors production config.** Use the same §6.2 env var names and values from `apps/api/.env`, a volume at `/data` with the `/data/media` and `/data/db` layout, and the same pinned Valkey image.
- **Local build contexts contain your `.env`.** Every build context needs a `.dockerignore` that excludes `.env` files, `.git`, `node_modules`, and `.venv`. Secrets reach containers only at runtime through `env_file`, never as build args.
- **Lockfiles are committed and honored.** Install with `uv sync --frozen` and `pnpm install --frozen-lockfile`. Change dependencies inside the container (`make api-run CMD="uv add <pkg>"`, `make web-run CMD="pnpm add <pkg>"`) and commit the updated lockfile. Then `make up` rebuilds the images, and `make setup` refreshes the host deps for `make dev`.
- **The Vite config serves both modes.** `DEV_SERVER_HOST` / `API_PROXY_TARGET` / `MEDIA_PROXY_TARGET` default to host-native, localhost-only values, and Compose overrides them. Never default the host to `0.0.0.0`, because that exposes the dev server to the local network. `apps/web/.npmrc` pins the public npm registry.

---

## 4. Project constraints (non-negotiable)

Breaking any of these invalidates the project's premise. Each one requires an ADR **and** explicit user sign-off before it changes.

- **$0/month.** Everything runs on the one Oracle A1 VM or on a free tier listed in §3.1. Free-tier limits change, so verify current numbers before relying on them.
- **Open source under GPL-3.0 (D14).** Rubber Band (GPL-2.0+, Phase 2) needs a GPL-compatible repo, and free arm64 Actions minutes need a public repo. Check each new dependency's license *before* adding it:
  - Fine: MIT, BSD, ISC, Apache-2.0, LGPL, Unlicense.
  - Not allowed: GPL-2.0-*only*, SSPL, BSL, non-commercial licenses, closed source.
  - AGPL-3.0 (for example Essentia, a Phase 2 option) can be combined with GPL-3.0 but adds network-use obligations. Note this in the ADR.
- **arm64 only.** The VM is an Ampere A1 and there is no other architecture. Before adopting a new base image, Python wheel, or native npm module, confirm that a `linux/arm64` build exists (§3.4). A new native dependency needs an ADR (§14).

---

## 5. Secrets and the public boundary

The repo, every GHCR image, and CI logs are **public by design**. A leaked secret stays public forever.

- The only secrets are **`DUCKDNS_TOKEN`** and **`SENTRY_DSN`** (§6.2). They live only in the K8s Secret `keyshift-secrets` or in the git-ignored `apps/api/.env`. Create the Secret with `kubectl create secret generic` and never commit it. `infra/k8s/secret.example.yaml` holds placeholders only.
- A secret must never enter git, not even "temporarily," because pushing publishes the whole history. `.gitignore` must exclude `apps/api/.env` **before the first commit**.
- Never put a secret in a Dockerfile, build arg, or build context, and never log one. Logs are JSON on stdout, keyed by `job_id`/`track_id`, and never include secrets, cookies, or raw request headers (§7).
- Because the repo is public, PR workflows must trigger on `pull_request`, never `pull_request_target`. Only the image-push workflow on `main` gets `packages: write`.
- **Never put YouTube or Google account cookies on the server** (§14). They are a credential sitting next to public images and logs, and they raise the ToS risk. Handle YouTube blocking with the upload fallback, not by authenticating.

---

## 6. Untrusted input (§7 security baseline)

- **Pass argv lists to every subprocess**: `yt-dlp`, `ffmpeg`, `ffprobe`, and later `rubberband` and Demucs. Never use `shell=True` or build a command string by interpolation. This is the app's main injection surface.
- **Rebuild YouTube URLs server-side** (§6.4):
  - Accept only the four URL forms listed in §6.4.
  - Extract the 11-character ID (`[A-Za-z0-9_-]{11}`).
  - Pass **only** `https://www.youtube.com/watch?v=<id>` to yt-dlp, with `--no-playlist`.
  - Reject playlist-only URLs and anything else you don't recognize. A `watch?v=…&list=…` link is fine, because the rebuild drops `list`.
- **Validate every upload** server-side before any processing:
  - Enforce `MAX_UPLOAD_MB` *while streaming*, not after the upload finishes.
  - MIME-sniff the file.
  - Confirm with `ffprobe` that it has an audio stream.
- **Titles are untrusted.** This covers both YouTube metadata and upload filenames. Sanitize them (§10 A4), never insert them as HTML, and never use them in a server filesystem path.
- **Rate-limit on the real client IP** (§3.3). Use `X-Forwarded-For` as set by the Ingress, run uvicorn with `--proxy-headers --forwarded-allow-ips=<pod CIDR>`, and set `externalTrafficPolicy: Local`. Never rate-limit on a node or pod IP, which puts every user in one shared bucket, and never trust a header the client supplies.

---

## 7. YouTube ToS posture (legal exposure: do not weaken)

These are deliberate mitigations (D10–D12, §14), not incidental behavior.

- **24-hour retention.** `MEDIA_TTL_HOURS=24`. The hourly ARQ cleanup deletes expired media, their DB rows, and orphaned files. Never extend the TTL, disable cleanup, or make media durable. Phase 2 exports follow the same TTL.
- **Media files are named by UUID only** (§6.3, D11). Playback files are `<uuid4>.m4a`, and Phase 2 exports are `<uuid4>.wav` or `<uuid4>.mp3`. `source_key` (`yt:<id>` / `up:<sha>`) exists only for dedup. Never use it as a filename, put it in a URL, or return it in an API response.
- **No enumerable library.**
  - Don't add a listing, search, or index endpoint. Tracks are reachable only by their unguessable `track_id`.
  - Keep nginx `autoindex` off for `/media/`, and serve nothing outside `/data/media/`.
  - The web pod mounts all of `/data` read-only, including `/data/db/keyshift.db`. Give both the `location` and the `alias` a trailing slash (`location /media/ { alias /data/media/; }`) so a request can't traverse into the DB.
- **Upload is a first-class input**, not a degraded mode (D10). Keep the personal-practice framing. The `SOURCE_BLOCKED` error must prominently suggest uploading.
- **Keep yt-dlp current** by rebuilding the api image weekly. The worker reuses that image (D16).
- There are no accounts or PII today, so the SQLite DB is low-sensitivity. If Phase 3 adds accounts, revisit data classification and retention *before* building them.

---

## 8. Single node, single environment

- **Exactly two processes write SQLite: one `api` pod and one `worker` pod.** Both run with **`replicas: 1`** and **`strategy: Recreate`** (§9 task 5), so two writer pods never overlap during a rollout. Never raise replicas, add an HPA, or switch either one to RollingUpdate, because that can corrupt the DB. Any new writer, such as a Phase 3 Demucs Job, needs an ADR.
- **Valkey is ephemeral** (D5; `--save "" --appendonly no`). Queued jobs disappear when it restarts, and clients retry. Never store anything in Valkey that has to survive a restart. SQLite is the system of record.
- **The `keyshift-data` PVC is ReadWriteOnce.** Web, api, and worker all share it, which pins every pod to this one node **on purpose** (D7). Don't add a node without first migrating to ReadWriteMany storage (§3.3).
- **The cluster must be rebuildable from `infra/k8s/` alone.** Oracle can reclaim idle instances (§3.3, §14), so the manifests plus a re-created Secret must be enough to bring everything back. A VM reboot must recover without manual steps. Never depend on state that can't be reproduced that way.
- **Respect the VM budget** (§3.6, ADR 0003). The VM is only **1 OCPU / 6 GB**, shared with k3s and the Sudoku Solver.
  - Every workload sets both CPU/memory requests **and** limits, taken from the §3.6 table.
  - KeyShift's total must stay within **200m CPU / 640Mi** of requests, with no memory limit above 2Gi and ≤ 3Gi of limits in total. CI (`validate-manifests.sh`) enforces this, and raising it needs an ADR.
  - At least 250m CPU must stay unrequested on the node, or Sudoku's rollouts hang Pending.
- **The cluster is shared, and only `keyshift` is ours** (§3.7):
  - KeyShift manifests may contain only objects in namespace `keyshift` (plus that Namespace); CI rejects cluster-scoped kinds.
  - Traefik, cert-manager, and the `letsencrypt-prod` issuer belong to the cluster or the Sudoku repo. Reference them; never install, upgrade, or edit them from here.
  - The only sanctioned Traefik change is the reviewed, hand-applied `infra/k8s-bootstrap/traefik-config.yaml`.
- **Deployment is manual only** (§7). The user runs `infra/scripts/deploy.sh <sha>`. Never add a CD step, and never store cluster credentials in GitHub.

---

## 9. Contracts (§6 is the source of truth)

Workstreams build against §6 **in parallel**. The boundaries are REST shapes, SSE events, error codes, identifiers, DB schema, env-var names and values, and repo layout. To change any of them, **stop, flag it, write an ADR, and add a row to §5**. Additions your assigned phase already specifies don't count as changes (for example, Phase 2's exports endpoint and `export_ready` event in §11). Schema changes go in a new versioned migration file (§10 A1). Never edit a migration that has already shipped.

Behavioral invariants that are easy to break without touching a schema:

- **The server is never on the hot path of a dial move** (§4, D1). All live pitch shifting runs client-side in the AudioWorklet. Never add a server request per dial move.
- **Pitch and tempo are independent.**
  - `setSemitones` (integer −12…+12) and `setCents` (−50…+50) change pitch only. Ramp each change over about 30–50 ms to avoid clicks.
  - Phase 1 fixes tempo at 1.0, so a 4:00 song still ends at 4:00 (§10 B3).
  - Phase 2 tempo control must not change pitch (§11).
- **SSE ordering and replay** (§6.5):
  - When a client connects, emit the current state first (from `job_state:<job_id>`) so late subscribers catch up.
  - Send a `: ping` comment every 15 s.
  - Emit `audio_ready` **before** key analysis starts, so the player works before the key is known.
- **Key-detection failure is non-fatal** (§6.5). Emit `error` with `KEY_DETECTION_FAILED` and keep the track playable. Never fail the ingest job because of it.
- **Playback audio is AAC in `.m4a`** (D8) so Safari can decode it. Prefer `bestaudio[ext=m4a]` and transcode otherwise (§10 A3). Never serve opus or webm as the playback file.
- **Dedup by `source_key`** (unique index, D12). A track that is `ready` **and not expired** is a cache hit: `POST /api/jobs` returns `200` with `status:"done"` and enqueues nothing. Never serve an expired track as a cache hit.
- **Error codes and HTTP statuses follow §6.6 exactly**, in the `{"error":{"code","message"}}` shape. `RATE_LIMITED` includes `retry_after_s`.
- **Config keys and their values are part of the contract** (§6.2): `MAX_DURATION_S=720`, `MAX_UPLOAD_MB=50`, `MEDIA_TTL_HOURS=24`, `RATE_LIMIT_JOBS_PER_HOUR=10`, `WORKER_CONCURRENCY=1` (ADR 0003). Read them from settings. Never hardcode different numbers.

---

## 10. Toolchain and conventions

These are defaults, not suggestions (§7).

- **Python:** 3.12, `uv` (in the api image; on the host only for `make dev`; never pip), `ruff` for lint and format, `pytest`, type hints everywhere, and `mypy --strict` on `keyshift/`.
- **TypeScript:** Node 24 LTS (Node 20 is end-of-life), `pnpm` via corepack (in the web image; on the host only for `make dev`; never npm or yarn), strict TS, ESLint + Prettier, and `vitest`. Add one Playwright happy-path E2E test at the end of Phase 1.
- **Images and K8s:**
  - Build for `linux/arm64`.
  - Tag images with the **git SHA, never `latest`**, and pin base-image tags.
  - Use one Python image for both api and worker (D16).
  - Run as non-root with `allowPrivilegeEscalation: false`.
  - Set requests and limits (§3.6) and add readiness and liveness probes.
- **Keep the Ingress settings intact; they're fragile** (§9 task 7, §14):
  - Response buffering stays **off**. Otherwise SSE progress silently freezes.
  - Read and send timeouts stay long (3600 s).
  - Max body size stays at **≥ 55 MB**. Otherwise uploads fail with 413.
  - Any change to `ingress.yaml` must keep all three, then be re-verified two ways: `curl -N …/api/health/stream` must print ticks about 1 s apart, and the 50 MB upload test must pass.
- **Git:** trunk-based on `main`, branches named `phase<N>/<workstream>-<task>`, and conventional commits. Every PR passes CI (lint, type-check, tests) before merge.
- **Accessibility:** the key dial is keyboard-operable (←/→ for ±1, `0` to reset) and exposes `role="slider"` with an `aria-valuetext` such as "Plus 2 semitones, A major" (§7, §10 C4).
