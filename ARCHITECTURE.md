# KeyShift — Architecture & Phased Build Plan

> **Audience:** human developers and AI coding subagents.
> **Status:** Living document. Phase 0 and Phase 1 are built and verified locally (Compose, Playwright end to end, the production image). Neither is deployed yet. Later phases are scoped but may be revised.
> **Platform:** Existing single-node k3s cluster on the Oracle VM (1 OCPU / 6 GB), with Traefik already routing traffic. The cluster is shared with the Sudoku Solver app (§3.7).
> **Hard constraint:** $0/month running cost. Every component is self-hosted on the Oracle Always Free VM or uses a free tier. Each choice lists its tradeoff (see 3.2 and Section 5).

---

## 1. Product summary

KeyShift is a web app where a musician or singer pastes a YouTube URL (or uploads an audio file), hears the song immediately, and transposes it up or down by semitones **without changing tempo**. The app detects the original key, shows the new key live as the user moves a dial, and lets them download the transposed audio.

**North-star UX goals**
1. Moving the key dial is heard in **< 100 ms** with no playback restart.
2. Time from "paste URL" to "first sound" is **< 10 s** on a cache miss and **< 1 s** on a cache hit.
3. The app shows real progress stages, never a silent spinner.
4. Every failure has a clear, actionable message (e.g. "YouTube blocked this request — try uploading the file instead").

---

## 2. How subagents should use this document

1. Read **Sections 1–7** in full before starting any task. They are global and apply to every phase.
2. Then read **only the phase you are assigned** (Section 9+). Do not build features from later phases.
3. **Section 6 (Contracts)** is the source of truth for anything crossing a boundary (API shapes, SSE events, file paths, env vars). If you need to change a contract, stop and flag it. Do not change it silently, because other agents are building against it in parallel.
4. Each phase lists **workstreams** that can run in parallel, **tasks**, **acceptance criteria**, and **out of scope**. A task is done only when its acceptance criteria pass.
5. Record any significant new decision as an ADR in `docs/adr/NNNN-title.md` (template in Section 13) and add a one-line entry to Section 5.

---

## 3. Zero-cost infrastructure

### 3.1 What we have

| Resource | Free allowance | Our use |
|---|---|---|
| Oracle Cloud Always Free — Ampere A1 (ARM64) | Up to 4 OCPU / 24 GB RAM total across A1 instances | One `VM.Standard.A1.Flex` with **1 OCPU / 6 GB**, shared with the Sudoku Solver app (3.6, 3.7) |
| Oracle block storage | 200 GB total (boot + block volumes) | OS, container images, PersistentVolumes |
| Oracle outbound data | 10 TB/month | Serving audio directly, so no CDN is needed |
| Oracle Object Storage | ~20 GB combined (Always Free) | Optional; **not used in Phase 1** |
| DuckDNS | Free `*.duckdns.org` subdomain | Public hostname |
| Let's Encrypt (via cert-manager) | Free TLS certs, auto-renew | HTTPS on the Ingress |
| GitHub Container Registry (ghcr.io) | Free for public images | Hosts our arm64 container images |
| GitHub (public repo) | Free Actions minutes, including arm64 runners for public repos | CI (lint/test) |
| Sentry Developer plan | Free tier, single user | Error tracking (optional) |

> Free-tier limits change. Verify current Oracle and Sentry limits before relying on exact numbers.

### 3.2 Free stack and its tradeoffs

| Component | Choice | Tradeoff to be aware of |
|---|---|---|
| Hosting | **Existing single-node Kubernetes cluster** on the Oracle A1 VM | Self-healing restarts and declarative deploys, but k3s itself uses ~1 GB of the 6 GB VM, the single core is shared with the Sudoku Solver (3.6), and one node means no real redundancy. |
| Manifests | **Kustomize** (built into `kubectl`) | Less templating power than Helm; fine for one environment. |
| Routing / TLS | **Existing Ingress controller + cert-manager** (Let's Encrypt) | SSE streaming and large uploads need controller-specific settings (see Phase 0). |
| Domain | **DuckDNS** subdomain | Less professional URL; depends on DuckDNS uptime for DNS resolution. |
| Frontend | **Vite + React + TS** static SPA served by an **nginx-unprivileged** pod | No server-side rendering, so link previews/SEO are basic. Not needed for this app. |
| Live pitch shifting | **Signalsmith Stretch (WASM) in an AudioWorklet**, in the user's browser | Quality and smoothness depend on the user's device; very old phones may stutter. In exchange, the server does zero work per dial move. |
| Quick export | **OfflineAudioContext** render in the browser, WAV only | Slower on weak devices; WAV files are large (~40 MB for 4 min). MP3 and studio quality come in Phase 2. |
| API | **Python 3.12 + FastAPI** | Python is slower than Go/Rust for request handling, but the API is not the bottleneck here. |
| Job queue | **ARQ + Valkey** as in-cluster Deployments | No managed durability; queued jobs are lost if Valkey restarts. Clients see an error and can retry. |
| Database | **SQLite** on the block volume | Single writer and single node. Fine at portfolio scale; would need migration if the app ever scales horizontally. |
| Audio storage | **One ReadWriteOnce PersistentVolume** shared by web, api and worker pods, 24 h TTL | Works only because all pods run on the same node; adding nodes later would need ReadWriteMany storage. No CDN, so distant users get slower first loads. |
| Key detection | **librosa** chroma + Krumhansl-Kessler | Less accurate than state-of-the-art models, especially for modal songs or key changes. Mitigated by showing confidence and alternates. |
| Studio export (Phase 2) | **Rubber Band** CLI on the VM | Takes 5–20 s of server CPU per render on ARM; mitigated with caching and pre-rendering. |
| Vocal isolation (Phase 3) | **Demucs** on CPU | Minutes per song on 4 ARM cores with no GPU. Runs as a background job so it never blocks playback. **Not feasible on the current 1 OCPU / 6 GB VM** (see §12). |
| CI | **GitHub Actions** (public repo) | Repo must be public for free arm64 runners and generous minutes. |
| Container registry | **GHCR** public images, built for arm64 in GitHub Actions | Images are public (no secrets may be baked in). |
| Monitoring | `kubectl logs` + **Uptime Kuma** (in-cluster) + **Sentry** Developer plan | No long-term metrics dashboards; Sentry free tier has event limits. |
| YouTube fetching | **yt-dlp** from the VM | Oracle datacenter IPs are frequently blocked by YouTube. File upload is a first-class fallback. |

### 3.3 Oracle VM gotchas (Phase 0 must handle these)

- **Two firewalls.** Open TCP 80 and 443 in the VCN **Security List** (or NSG) *and* in the VM's own firewall. Oracle's Ubuntu images ship with restrictive `iptables` rules; add ACCEPT rules for 80/443 and persist them (`netfilter-persistent save`). This is the #1 reason cert-manager's HTTP-01 challenge fails. Since your Ingress already works, this is likely done; just confirm 443 is open too.
- **ARM64 architecture.** Every Docker image and Python wheel must support `linux/arm64`. Verify before adopting any new native dependency (see 3.4).
- **Idle reclamation.** Oracle may reclaim Always Free instances that are idle for an extended period (low CPU/network/memory over ~7 days). Mitigation: keep real traffic and Uptime Kuma checks running so the VM never looks idle. Tradeoff: there is no free way to fully guarantee the instance won't be reclaimed, so the cluster must be rebuildable from the manifests in `infra/k8s/` quickly.
- **Real client IP.** Rate limiting needs the user's real IP. If the API sees only cluster/node IPs in `X-Forwarded-For`, set `externalTrafficPolicy: Local` on the Ingress controller's Service. On this cluster, that's `infra/k8s-bootstrap/traefik-config.yaml`, a shared change (3.7). Run uvicorn with `--proxy-headers --forwarded-allow-ips=<pod CIDR>`.
- **Shared node.** The cluster also runs the Sudoku Solver (3.7). Cluster-wide components are shared, and so is the single core (3.6).
- **Single-node storage.** The shared ReadWriteOnce volume (see 3.2) means pods must stay on this node. Don't add worker nodes without first switching to ReadWriteMany storage.
- **Public IP.** Use a reserved public IP if available in your tenancy. Also run a DuckDNS updater CronJob so the DNS record self-heals if the IP ever changes.

### 3.4 ARM64 compatibility status

| Dependency | ARM64 status | Decision |
|---|---|---|
| ffmpeg, yt-dlp | ✅ apt / PyPI (installed in the api image) | Use |
| librosa, numpy, scipy, soundfile | ✅ wheels available | **Use for key detection in Phase 1** |
| Rubber Band (`rubberband-cli`) | ✅ Ubuntu/Debian apt package | Use in Phase 2 (server export) |
| Essentia | ⚠️ Verify arm64 wheel for chosen version | Optional Phase 2 upgrade; librosa is baseline |
| Demucs / PyTorch (CPU) | ✅ CPU works, slow (minutes per song on 4 cores) | Phase 3, background only |
| Valkey, nginx-unprivileged, cert-manager, curl | ✅ official arm64 images | Use |

### 3.5 Licensing (keep the repo open source)

- **Signalsmith Stretch** — MIT. Client-side pitch shifting.
- **Rubber Band** — GPL-2.0+. Fine because the repo is open source (license the repo GPL-3.0 or AGPL-3.0 to stay compatible).
- **librosa** — ISC. **yt-dlp** — Unlicense. **nginx** — BSD-2-Clause.
- **lamejs** (optional MP3 encode) — LGPL.
- Tradeoff: using GPL libraries for free means the whole repo must stay open source under a GPL-compatible license.

### 3.6 VM resource budget (1 OCPU / 6 GB, shared with the Sudoku Solver)

The VM is a `VM.Standard.A1.Flex` with **1 OCPU and 6 GB**. It's shared with the Sudoku Solver app (namespace `sudoku-prod`; see 3.7), so KeyShift runs on a small slice. This was an explicit choice over resizing to the free 4 OCPU / 24 GB ([ADR 0003](docs/adr/0003-shared-cluster-with-sudoku-solver.md)). The requests below are **scheduling reservations**, sized from measured idle usage. Limits let a busy pod burst into the idle CPU.

| Workload | CPU request / limit | Memory request / limit |
|---|---|---|
| k3s system: coredns, metrics-server, Traefik, local-path (not ours) | ~200m | ~140Mi requested (~1 GB actual, incl. the k3s server) |
| cert-manager (shared, not ours) | — | ~150 MB actual |
| Sudoku Solver: api ×1, web ×2 (not ours) | 250m / 1.4 | 320Mi / 896Mi |
| **KeyShift** web (nginx-unprivileged) | 10m / 200m | 16Mi / 64Mi |
| **KeyShift** api (FastAPI/uvicorn) | 50m / 500m | 96Mi / 384Mi |
| **KeyShift** worker (ARQ, concurrency **1**) | 100m / 1 | 256Mi / 2Gi |
| **KeyShift** valkey (`--maxmemory 64mb`) | 10m / 200m | 32Mi / 128Mi |
| **KeyShift** uptime-kuma | 10m / 250m | 160Mi / 320Mi |
| **KeyShift** duckdns CronJob (transient) | 10m / 50m | 16Mi / 32Mi |
| **KeyShift total** (long-running) | **180m** | **560Mi / ~2.9Gi** |
| **Headroom** after everything | **~370m** (≥ 250m must stay free) | ~4.5 GiB of requests, ~1 GiB against limits |

- **KeyShift must fit in 200m CPU and 640Mi of memory requests.** No single memory limit may exceed 2Gi, and the total of limits must stay at or below 3Gi. `infra/scripts/validate-manifests.sh` enforces these ceilings in CI, and raising them needs an ADR.
- **Keep ≥ 250m CPU unrequested.** Sudoku's api uses a RollingUpdate that needs 200m of surge room, or its rollouts hang Pending. `check-cluster.sh` checks the live headroom.
- **Tradeoff:** one core is shared by everything. A Sudoku solve and a KeyShift ingest compete for the same core, so cache-miss processing and key detection are slower than on a dedicated VM. Phase 2 server exports and Phase 3 Demucs are at risk (see §11, §12). The design still allows resizing the VM to 4 OCPU / 24 GB for free later. That would be an ADR plus a restore of the larger budget, with no code change.

### 3.7 Shared cluster: Sudoku Solver

The same single-node k3s cluster also runs the **Sudoku Solver** app (repo `edwinargueta/Sudoku-Solver-Google-OR-tools`, host `sudoku-csp.duckdns.org`, namespace `sudoku-prod`).

| Component | Owner | KeyShift's relationship |
|---|---|---|
| k3s (default install: Traefik, ServiceLB, local-path, pod CIDR `10.42.0.0/16`) | Cluster | Uses it. Never reinstall or upgrade k3s from this repo. |
| Traefik (`kube-system`) | Cluster, shared | KeyShift's Ingress sets `ingressClassName: traefik`. The one-time `infra/k8s-bootstrap/traefik-config.yaml` (externalTrafficPolicy Local, 300 s readTimeout) changes it for **both** apps (ADR 0003). |
| cert-manager + ClusterIssuer `letsencrypt-prod` | Sudoku repo (`deploy/k8s/bootstrap`) | KeyShift references the issuer. Never install a second cert-manager or edit the issuer from this repo. |
| Namespace `sudoku-prod` | Sudoku repo | Never touch it. |
| Node CPU/memory | Shared | See the budget in 3.6. |

Hostnames, namespaces, TLS Secrets, Service names, and GHCR packages don't collide: every KeyShift object lives in `keyshift`. Let's Encrypt limits are per subdomain, because `duckdns.org` is on the Public Suffix List. The cluster API isn't exposed publicly: `kubectl` reaches it through an SSH tunnel to the VM, as in the Sudoku setup.

---

## 4. Architecture overview

```
 Browser (static SPA)
 ├─ UI: URL/upload input, key dial, key readout, waveform, export
 ├─ Audio engine: Web Audio + AudioWorklet + Signalsmith Stretch (WASM)   ← live pitch shift, no server round-trip
 └─ Offline render: OfflineAudioContext + same engine → WAV download
            │  HTTPS (same origin)
            ▼
 Ingress controller (existing) + cert-manager TLS, host keyshift.duckdns.org
 ├─ /api    → Service api:8000   (FastAPI; response buffering OFF for SSE)
 ├─ /media  → Service web:8080   (nginx serves /data/media from the PVC, cache headers)
 └─ /       → Service web:8080   (nginx serves the SPA, fallback to index.html)

 Namespace: keyshift
 ├─ Deployment api ──enqueue──▶ Deployment valkey ──▶ Deployment worker
 │                                                    ├─ yt-dlp (audio-only) / upload normalize (ffmpeg)
 │                                                    ├─ write /data/media/<uuid>.m4a
 │                                                    └─ key detection (librosa)
 ├─ PVC keyshift-data (RWO) mounted at /data by api, worker, web (read-only)
 │   ├─ /data/media/*.m4a
 │   └─ /data/db/keyshift.db   (SQLite: tracks, jobs, exports)
 ├─ Deployment uptime-kuma (own PVC, no Ingress; kubectl port-forward)
 └─ CronJob duckdns (updates DNS every 5 min)
 Cleanup cron (inside worker, ARQ): delete media + rows older than 24 h
```

The same cluster also runs the Sudoku Solver (namespace `sudoku-prod`, host `sudoku-csp.duckdns.org`). The two apps share Traefik, cert-manager with the `letsencrypt-prod` ClusterIssuer, and the node's single OCPU. Traefik routes each request by hostname (§3.7).

**Core principle:** the server fetches and analyzes each song **once**. All interactive pitch shifting happens **in the browser**. The server is never on the hot path of a dial move.

---

## 5. Decision log (summary)

| # | Decision | Rationale | Tradeoff |
|---|---|---|---|
| D1 | Live pitch shifting runs client-side in an AudioWorklet (Signalsmith Stretch WASM) | Sub-100 ms response; zero server CPU per dial move | Depends on the user's device; the full decoded song is held in memory (~85 MB for 4 min) |
| D2 | Deploy to the existing single-node Kubernetes cluster with Kustomize | Reuses the existing setup; declarative, self-healing, strong portfolio signal | k3s overhead (~1 GB RAM) on a small shared VM (3.6); more YAML than Compose; still one node |
| D3 | Existing Ingress controller + cert-manager for routing and TLS | Already running; standard Kubernetes pattern | SSE and upload limits need controller-specific annotations |
| D4 | Vite + React + TypeScript static SPA, served by an nginx-unprivileged pod that also serves `/media` | No SSR needed; one small pod handles all static files | Basic link previews/SEO |
| D5 | Python 3.12 + FastAPI for API; ARQ + Valkey for jobs | Audio ecosystem is Python; async; lightweight queue | Queue isn't durable across Valkey restarts |
| D6 | SQLite for persistence | Single node, low write volume, zero ops | Single writer; can't scale across multiple servers |
| D7 | Audio and SQLite on one RWO PersistentVolume shared by api, worker and web | Free, fast local disk; 10 TB egress; 24 h TTL keeps disk small | Ties all pods to one node; no CDN |
| D8 | Store playback audio as AAC in `.m4a` | Decodes in every browser, including Safari; prefer yt-dlp `bestaudio[ext=m4a]`, else transcode | Occasional transcode adds 1–3 s on a cache miss |
| D9 | Key detection = librosa chroma + Krumhansl-Kessler profiles in Phase 1 | Works on ARM, understandable, good-enough accuracy; upgrade path to Essentia | Lower accuracy on modal songs and songs with key changes |
| D10 | File upload is a first-class input from Phase 1 | YouTube often blocks datacenter IPs; reduces ToS/legal exposure | Extra upload handling and validation work |
| D11 | Media files named by random UUID, never by video ID | Prevents building a guessable public library | None significant |
| D12 | Tracks deduplicated by `source_key` (`yt:<videoId>` or `up:<sha256[:16]>`) | Cache hits load near-instantly | Cache only lasts 24 h, so repeat visits after that pay the full fetch cost again |
| D13 | Progress delivered via Server-Sent Events | One-way, simple, works through the Ingress with buffering disabled | Each open job holds a connection; fine at this scale |
| D14 | Repo is open source under GPL-3.0 | Compatible with Rubber Band; portfolio visibility | Code can't be closed-source later without replacing GPL dependencies |
| D15 | Images published to GHCR, built for arm64 by GitHub Actions | Free; avoids building on the VM and competing with the app for CPU | Images are public |
| D16 | The worker reuses the api image with a different command | One Python image to build and version | Worker image carries API code it doesn't need (small) |
| D17 | Local development runs entirely in Docker Compose (`infra/docker-compose.dev.yml`), building images locally from the same Dockerfiles as production; the host needs only Docker. Kubernetes manifests are production-only ([ADR 0001](docs/adr/0001-containerized-local-development.md)) | No Python/Node toolchain drift between machines; fastest inner loop; one set of Dockerfiles | Slower first build; bind-mount file watching is slower on macOS; editors need container-aware setup for import resolution; dev and prod topologies differ slightly (the Phase 0 acceptance tests catch drift) |
| D18 | Phase 0 implementation choices: repo-root build context with Dockerfile-specific allowlist ignores, `GIT_SHA` build metadata, Node 24 LTS, a temp Kustomize overlay in `deploy.sh`, dual Traefik/ingress-nginx Ingress, and a `media` nginx service in Compose ([ADR 0002](docs/adr/0002-phase-0-implementation-choices.md)) | Fills gaps in §9 without changing any §6 contract | See ADR 0002 (operator must make GHCR packages public and set the pod CIDR) |
| D19 | Share the 1 OCPU / 6 GB VM with the Sudoku Solver instead of resizing: KeyShift shrinks to 180m / 560Mi of requests, `WORKER_CONCURRENCY=1`, and shares Traefik, cert-manager and `letsencrypt-prod` ([ADR 0003](docs/adr/0003-shared-cluster-with-sudoku-solver.md)) | Uses the existing VM as-is; no resize or reboot; stays $0 | Slower processing on one shared core; Phase 2 export target at risk; Phase 3 Demucs blocked until a (free) resize |
| D20 | `make dev` runs the API, worker and Vite natively on the host (like the Sudoku repo), with Valkey and the `/media` nginx in Docker; `make up` stays fully containerized; checks always run in containers ([ADR 0004](docs/adr/0004-host-native-make-dev.md), amends ADR 0001) | Fast native reloads and real editor import resolution; Sudoku-repo muscle memory | Two local modes to keep working; host needs uv + Node 24 for `make dev`; `make check` keeps CI parity |
| D21 | Phase 1 contract clarifications: `NOT_FOUND` 404, `retry_after_s` in the error body, dedup joins in-flight jobs, SSE replay from `job_state`, `TMP_DIR` staging, sharps-only key names from the API ([ADR 0005](docs/adr/0005-phase-1-contract-clarifications.md)) | Settles every cross-boundary gap once, before parallel workstreams build against §6 | One new config key and one new error code |
| D22 | Phase 1 implementation notes: dedup and replay refinements, MiB upload unit, a shared YouTube URL table, harmonic separation off, `NUMBA_CACHE_DIR`, Signalsmith Blob-URL worklet (CSP note), Dependabot for yt-dlp, host ffmpeg for `make dev`, typed engine errors with cause-specific copy (embedded browsers such as VS Code's lack the AAC decoder; use Chrome, Firefox or Safari) ([ADR 0006](docs/adr/0006-phase-1-implementation-notes.md)) | Records what integration found, so nothing changes silently | Engine memory ~2x the decoded track; Firefox realtime specs skip in CI |

---

## 6. Contracts (source of truth)

### 6.1 Repository layout

```
/
├─ ARCHITECTURE.md  CLAUDE.md  README.md  LICENSE  .gitignore
├─ Makefile               # local entry point: make up, build, test, lint, check (wraps docker compose)
├─ .github/workflows/      # ci.yml (checks, coverage gates, engine-browser, e2e), images.yml (arm64 → GHCR on main)
├─ .github/dependabot.yml  # weekly yt-dlp bumps (ADR 0006)
├─ docs/
│  ├─ adr/
│  └─ architecture-diagram.md   # Mermaid diagrams of this document
├─ apps/
│  ├─ web/                 # Vite + React + TS SPA
│  │  ├─ src/audio/        # AudioEngine, worklet, offline render, WAV encoder
│  │  ├─ src/features/     # input, player, key-dial, export
│  │  ├─ src/lib/          # api client, sse client, music theory utils
│  │  ├─ public/worklets/  # unused: Signalsmith inlines its WASM and worklet (ADR 0006)
│  │  └─ e2e/              # Playwright: engine/ (real Web Audio) and happy-path.spec.ts; fixtures/
│  └─ api/                 # FastAPI + ARQ worker (one Python package)
│     ├─ keyshift/
│     │  ├─ main.py        # FastAPI app
│     │  ├─ routes/        # jobs.py, tracks.py, uploads.py, health.py
│     │  ├─ worker/        # arq settings, tasks: fetch_youtube, ingest_upload, detect_key, cleanup
│     │  ├─ audio/         # ffmpeg helpers, key_detection.py
│     │  ├─ db.py          # SQLite (SQLModel or plain sqlite3)
│     │  ├─ events.py      # Redis pub/sub → SSE
│     │  └─ settings.py    # pydantic-settings, env vars
│     └─ tests/
└─ infra/
   ├─ k8s/                 # Kustomize base, applied with kubectl apply -k
   │  ├─ kustomization.yaml
   │  ├─ namespace.yaml
   │  ├─ configmap.yaml
   │  ├─ secret.example.yaml   # template only; real Secret created with kubectl, never committed
   │  ├─ pvc.yaml
   │  ├─ web.yaml  api.yaml  worker.yaml  valkey.yaml  uptime-kuma.yaml
   │  ├─ duckdns-cronjob.yaml
   │  └─ ingress.yaml
   ├─ k8s-bootstrap/       # one-time, cluster-wide, applied by hand (never by deploy.sh)
   │  └─ traefik-config.yaml   # shared Traefik HelmChartConfig: externalTrafficPolicy Local, 300 s readTimeout
   ├─ docker/              # web.Dockerfile, api.Dockerfile (+ .dockerignore allowlists), nginx.conf
   ├─ docker-compose.dev.yml   # `make up`: the full stack in containers (local only)
   ├─ docker-compose.deps.yml  # `make dev`: only Valkey + /media nginx; app runs on the host
   └─ scripts/             # check-cluster.sh, deploy.sh, validate-manifests.sh
```

### 6.2 Configuration (ConfigMap `keyshift-config` + Secret `keyshift-secrets`)

Non-secret values go in the ConfigMap; `DUCKDNS_TOKEN` and `SENTRY_DSN` go in the Secret. Both are injected with `envFrom`. For local development, the same keys live in `apps/api/.env` (git-ignored).

```
# ConfigMap
PUBLIC_HOST=keyshift.duckdns.org
DUCKDNS_SUBDOMAIN=keyshift
REDIS_URL=redis://valkey:6379/0
DB_PATH=/data/db/keyshift.db
MEDIA_DIR=/data/media
MEDIA_BASE_URL=/media
MAX_DURATION_S=720
MAX_UPLOAD_MB=50
MEDIA_TTL_HOURS=24
RATE_LIMIT_JOBS_PER_HOUR=10
WORKER_CONCURRENCY=1          # 1 OCPU VM shared with the Sudoku Solver (ADR 0003)
TMP_DIR=/data/tmp              # upload/download staging on the shared PVC, never served (ADR 0005)

# Secret
DUCKDNS_TOKEN=changeme
SENTRY_DSN=
```

### 6.3 Identifiers

- `track_id`: UUIDv4 (public, used in URLs).
- `source_key`: `yt:<11-char videoId>` or `up:<first 16 hex of sha256(file bytes)>`. Unique index; used for dedup. **Never exposed as a media filename.**
- `job_id`: UUIDv4.
- Media path: `${MEDIA_DIR}/<uuid4>.m4a`, served at `${MEDIA_BASE_URL}/<uuid4>.m4a`.

### 6.4 REST API (all JSON, prefix `/api`)

```
GET  /api/health
  200 {"status":"ok","version":"<git sha>"}

POST /api/jobs
  body {"url":"<youtube url>"}
  200 {"job_id":"...","track_id":"...","status":"done"}      # cache hit
  202 {"job_id":"...","track_id":"...","status":"queued"}    # cache miss
  4xx {"error":{"code":"INVALID_URL","message":"..."}}

POST /api/uploads            (multipart/form-data, field "file")
  same responses as POST /api/jobs

GET  /api/jobs/{job_id}/events      (text/event-stream, see 6.5)

GET  /api/tracks/{track_id}
  200 {
    "track_id":"...",
    "source":"youtube"|"upload",
    "title":"...",
    "duration_s":213.4,
    "status":"queued"|"fetching"|"ready"|"error",
    "audio_url":"/media/<uuid>.m4a"|null,
    "key": null | {
      "tonic":"G", "mode":"major", "confidence":0.82,
      "alternates":[{"tonic":"E","mode":"minor","confidence":0.71}],
      "tuning_cents":-12
    },
    "expires_at":"2026-09-26T12:00:00Z"
  }
```

URL validation (server-side, authoritative): accept `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`, `music.youtube.com/watch?v=`; extract the 11-char ID with regex `[A-Za-z0-9_-]{11}`; **rebuild** `https://www.youtube.com/watch?v=<id>` and pass only that to yt-dlp. Reject playlists-only URLs and anything else.

### 6.5 SSE events (`/api/jobs/{job_id}/events`)

On connect, the server first emits the current state (so late subscribers catch up), then live events. Send a `: ping` comment every 15 s.

```
event: progress
data: {"stage":"queued"|"fetching"|"processing"|"analyzing","pct":0-100|null}

event: audio_ready
data: {"track_id":"...","audio_url":"/media/<uuid>.m4a","duration_s":213.4,"title":"..."}

event: key_ready
data: {"tonic":"G","mode":"major","confidence":0.82,"alternates":[...],"tuning_cents":-12}

event: done
data: {}

event: error
data: {"code":"SOURCE_BLOCKED","message":"..."}
```

`audio_ready` **must** be emitted before key analysis starts. `key_ready` failure is non-fatal: emit `error` with code `KEY_DETECTION_FAILED`, and the track remains playable.

### 6.6 Error codes

| Code | HTTP | User-facing meaning |
|---|---|---|
| `INVALID_URL` | 400 | Not a recognizable YouTube video link |
| `UNSUPPORTED_FILE` | 400 | Not a supported audio file |
| `FILE_TOO_LARGE` | 413 | Over `MAX_UPLOAD_MB` |
| `VIDEO_TOO_LONG` | 422 | Over `MAX_DURATION_S` |
| `LIVESTREAM` | 422 | Live streams not supported |
| `SOURCE_UNAVAILABLE` | 422 | Private, removed, or region-locked |
| `SOURCE_BLOCKED` | 502 | YouTube blocked the server; suggest upload |
| `RATE_LIMITED` | 429 | Too many requests. The body includes `"retry_after_s": <int>` inside `error`, plus a `Retry-After` header (ADR 0005) |
| `KEY_DETECTION_FAILED` | — (SSE only) | Key unknown; playback still works |
| `NOT_FOUND` | 404 | Unknown, malformed, or expired `track_id` / `job_id` (ADR 0005) |
| `INTERNAL` | 500 | Unexpected error |

### 6.7 Database schema (SQLite)

```sql
CREATE TABLE tracks (
  track_id      TEXT PRIMARY KEY,
  source_key    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL CHECK (source IN ('youtube','upload')),
  title         TEXT,
  duration_s    REAL,
  status        TEXT NOT NULL,
  media_file    TEXT,              -- '<uuid>.m4a'
  key_tonic     TEXT,
  key_mode      TEXT,
  key_confidence REAL,
  key_alternates TEXT,             -- JSON
  tuning_cents  INTEGER,
  error_code    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE TABLE jobs (
  job_id     TEXT PRIMARY KEY,
  track_id   TEXT NOT NULL REFERENCES tracks(track_id),
  kind       TEXT NOT NULL,        -- 'ingest' (Phase 2 adds 'export')
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 6.8 Frontend audio engine interface

```ts
interface AudioEngine {
  load(url: string, onProgress?: (pct: number) => void): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setSemitones(n: number): void;       // integer -12..+12, applied live, click-free
  setCents(n: number): void;           // -50..+50 (Phase 1: tuning correction only)
  readonly currentTime: number;
  readonly duration: number;
  readonly isPlaying: boolean;
  readonly audioBuffer: AudioBuffer | null; // decoded source for the waveform (ADR 0005)
  renderOffline(opts: { semitones: number; cents: number; onProgress?: (pct: number) => void }): Promise<AudioBuffer>;
  on(event: 'timeupdate' | 'ended' | 'error', cb: (...a: unknown[]) => void): () => void;
  dispose(): void;                     // stop and release the AudioContext (ADR 0005)
}
```

Music-theory utilities (`src/lib/music.ts`) must provide: `transposeKey(tonic, mode, semitones)`, correct enharmonic spelling (prefer the spelling with fewer accidentals; flats for F, B♭, E♭, A♭, D♭, G♭ majors and their relative minors), `capoHint(semitones)`, and a formatter like `"G major → A major (+2)"`.

---

## 7. Global engineering conventions

- **Local development (D17, D20):** the `Makefile` is the entry point, with two ways to run the app (the host also needs `kubectl` for production deploys):
  - **`make up`** runs everything in Docker Compose (`infra/docker-compose.dev.yml`). It needs only Docker, git, and make.
  - **`make dev`** runs the API, worker, and Vite natively, like the Sudoku repo, with only Valkey and the `/media` nginx in Docker (`infra/docker-compose.deps.yml`). It additionally needs uv and Node 24; run `make setup` once (ADR 0004).
  - **Checks always run in containers.** Lint, type-check, tests, and manifest validation run via `make check` in the Docker `dev` images, exactly as CI does.
  - **One set of Dockerfiles.** Each has a `dev` target (dev dependencies, hot reload, source bind-mounted) used by Compose, and a final production target that CI builds and Kubernetes runs.
  - **Local images never ship.** Locally built images are never pushed or deployed. pip is never used.
- **Python:** 3.12, `uv` for deps (inside the api image only; `uv.lock` committed and installed with `uv sync --frozen`), `ruff` (lint + format), `pytest`, type hints everywhere, `mypy --strict` on `keyshift/`.
- **TypeScript:** Node 24 LTS (Node 20 reached end-of-life in April 2026), `pnpm` (inside the web image only; `pnpm-lock.yaml` committed and installed with `pnpm install --frozen-lockfile`), strict TS, ESLint + Prettier, `vitest` for unit tests, Playwright for one happy-path E2E (Phase 1 end).
- **Containers & Kubernetes:** all images build for `linux/arm64` and are tagged with the git SHA (never deploy `latest`). Pin base image tags. Every workload runs as non-root with `allowPrivilegeEscalation: false`, has CPU/memory requests and limits (3.6), and has readiness and liveness probes.
- **Git:** trunk-based; feature branches `phase1/<workstream>-<task>`; conventional commits; every PR passes CI.
- **CI (GitHub Actions):** lint + type-check + tests for `apps/web` and `apps/api` on every PR. A second workflow builds and pushes arm64 images to GHCR on `main`. Deployment is manual (`infra/scripts/deploy.sh <sha>`: renders `infra/k8s` through a temporary overlay that pins both image tags to the SHA, checks the render, then applies it; ADR 0002). Tradeoff: no automated deploys, but no cluster credentials stored in GitHub.
- **Logging:** JSON logs to stdout with `job_id` / `track_id` fields. No secrets or cookies in logs.
- **Security baseline:** server-side URL rebuild (6.4), upload MIME sniffing + ffprobe validation, size limits, rate limiting, non-root containers, no shell string interpolation (use argv lists for subprocess).
- **Accessibility:** the dial must be keyboard-operable and expose `role="slider"` with `aria-valuetext` like "Plus 2 semitones, A major".

---

## 8. Phase map

| Phase | Theme | Outcome |
|---|---|---|
| **0** | Infrastructure | HTTPS "hello world" at `https://<sub>.duckdns.org` with every workload Ready in the `keyshift` namespace |
| **1** | MVP | Paste URL or upload → hear it → transpose live → see detected key → download WAV |
| **2** | Quality & practice tools | Studio-quality server export, loop regions, tempo control, vocal presets, better key UX |
| **3** | Vocal intelligence | Melody-range analysis, voice-type fitting, hum-your-range test, saved songs |

Each phase must be deployed and working before the next begins.

---

## 9. Phase 0 — Infrastructure

**Goal:** Reproducible Kubernetes manifests that serve a placeholder SPA and `/api/health` over HTTPS on the existing cluster.

**Assumptions to verify first** (task 1): Traefik is running (IngressClass `traefik`), cert-manager is installed with the `letsencrypt-prod` ClusterIssuer, a default StorageClass exists, and the node has room for KeyShift's requests (§3.6). On this cluster, cert-manager and the issuer were installed by the Sudoku Solver repo (§3.7). Don't install or upgrade them from this repo. If they're ever missing, reinstall them through that repo's bootstrap step. Apply `infra/k8s-bootstrap/traefik-config.yaml` once, with sign-off, because it also changes Traefik for Sudoku.

### Tasks

1. `infra/scripts/check-cluster.sh`: confirm `kubectl` access, node architecture is `arm64`, the Ingress controller pods are Running (print the IngressClass name), cert-manager and the ClusterIssuer exist, and a default StorageClass exists. Print a clear pass/fail for each check.
2. `namespace.yaml` (`keyshift`), `configmap.yaml`, and `secret.example.yaml` per 6.2. Document the `kubectl create secret generic keyshift-secrets --from-literal=...` command in the README.
3. `pvc.yaml`: `keyshift-data`, ReadWriteOnce, 50Gi, default StorageClass. Worker and api mount it read-write at `/data`; web mounts it read-only at `/data`. Add an init container (or `fsGroup`) so `/data/media` and `/data/db` exist with correct ownership.
4. Images (`infra/docker/`), each multi-stage with a `dev` target for local Compose and a final production target for CI/Kubernetes (D17). Add a `.dockerignore` for each build context that excludes `.env` files, `.git`, `node_modules`, and `.venv`.
   - `api.Dockerfile`: Python 3.12 slim, ffmpeg, a pinned `uv` binary, dependencies installed with `uv sync --frozen` (no dev dependencies in the production target), and the `keyshift` package. The default command runs uvicorn with `--proxy-headers`. The worker Deployment overrides the command to `arq keyshift.worker.WorkerSettings`. The `dev` target adds dev dependencies (ruff, mypy, pytest) and runs uvicorn with `--reload`.
   - `web.Dockerfile`: the `dev` target runs the Vite dev server (Node 24 LTS, `pnpm install --frozen-lockfile`); the build stage runs the Vite build; the final stage copies `dist/` into `nginxinc/nginx-unprivileged` (listens on 8080).
   - `nginx.conf`: `/` serves the SPA with `try_files $uri /index.html`; `/media/` serves `/data/media/` with `Cache-Control: public, max-age=86400, immutable`; gzip on.
5. Workloads: `web.yaml`, `api.yaml`, `worker.yaml` (Deployment, 1 replica each, `strategy: Recreate` for api and worker so two pods never write SQLite during a rollout), `valkey.yaml` (Deployment + Service, no persistence, `--save "" --appendonly no`), `uptime-kuma.yaml` (Deployment + its own 1Gi PVC, ClusterIP Service only). Apply resources from 3.6 and probes: api `GET /api/health`; web `GET /`; valkey `valkey-cli ping`; worker exec probe using ARQ's health check.
6. `duckdns-cronjob.yaml`: every 5 minutes, `curlimages/curl` calls `https://www.duckdns.org/update?domains=$DUCKDNS_SUBDOMAIN&token=$DUCKDNS_TOKEN&ip=` and fails the Job if the response isn't `OK`. `successfulJobsHistoryLimit: 1`.
7. `ingress.yaml`: host `$PUBLIC_HOST`, `cert-manager.io/cluster-issuer: letsencrypt-prod`, TLS secret `keyshift-tls`, and path rules `/api` → `api:8000`, `/media` → `web:8080`, `/` → `web:8080` (all `pathType: Prefix`). Controller-specific settings:
   - **ingress-nginx:** `nginx.ingress.kubernetes.io/proxy-buffering: "off"`, `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`, `proxy-body-size: "55m"`.
   - **Traefik:** streams responses without buffering by default; confirm no buffering middleware is attached and that request body limits allow 55 MB.
   - **Other controllers:** find the equivalent of "disable response buffering," "long read timeout," and "max body size," and record them in an ADR.
8. `kustomization.yaml` listing all resources with an `images:` block for `ghcr.io/<user>/keyshift-api` and `ghcr.io/<user>/keyshift-web`.
9. Skeleton `apps/api` with `/api/health` plus `/api/health/stream` (an SSE endpoint that sends 5 ticks, one per second, used to verify the Ingress doesn't buffer), and a no-op ARQ worker. Skeleton `apps/web` Vite app showing "KeyShift".
10. GitHub Actions: CI (lint + tests) on every PR; image build and push to GHCR for `linux/arm64` on `main`, tagged with the git SHA.
11. `infra/scripts/deploy.sh <sha>`: set image tags (temporary Kustomize overlay, ADR 0002), apply `infra/k8s`, then `kubectl rollout status` for each Deployment.
12. `infra/docker-compose.dev.yml` for local development, built locally from the `dev` targets in task 4:
   - `api` (source bind-mounted, uvicorn `--reload`), `worker` (same image, `arq` command), `valkey` (the same pinned image as production), and `web` (the Vite dev server in a container, with a proxy for `/api` and `/media`).
   - A named volume mounted at `/data` with the same `/data/media` and `/data/db` layout as the PVC.
   - Runtime env from `apps/api/.env` (`env_file`), using the §6.2 key names and values. Never pass secrets as build args.
   - The README documents the one-command start (`docker compose -f infra/docker-compose.dev.yml up --build`) and the containerized lint, type-check, test, and dependency commands (e.g. `docker compose -f infra/docker-compose.dev.yml run --rm api uv run pytest`).

### Acceptance criteria

- `check-cluster.sh` passes all checks.
- `curl -I https://<sub>.duckdns.org` returns 200 with a valid Let's Encrypt certificate (`kubectl get certificate -n keyshift` shows Ready).
- `curl https://<sub>.duckdns.org/api/health` returns `{"status":"ok",...}`.
- `curl -N https://<sub>.duckdns.org/api/health/stream` prints each tick about one second apart, not all at once at the end. This proves SSE isn't buffered.
- A 50 MB test POST to `/api/health` (or a temporary echo endpoint) isn't rejected by the Ingress with 413.
- `kubectl get pods -n keyshift` shows every pod Ready; rebooting the VM brings everything back without manual steps.
- Deleting the namespace and re-running `deploy.sh` rebuilds everything (except Secrets, which are re-created per the README).
- The duckdns CronJob's latest run succeeded.
- CI is green on `main`, and images for the current SHA exist in GHCR.
- On a machine with only Docker and git installed, `docker compose -f infra/docker-compose.dev.yml up --build` serves the SPA and `/api/health` locally, and lint, type-check, and tests pass via `docker compose ... run --rm`.

### Out of scope

Any audio processing, multi-node setup, Helm charts, automated deploys from CI.

---

## 10. Phase 1 — MVP

**Goal:** The complete core loop working end-to-end on the VM.

### Workstream A — Backend ingest pipeline (`apps/api`)

1. **SQLite layer** implementing schema 6.7, with a migration-on-startup approach (simple versioned SQL files).
2. **`POST /api/jobs`**: validate/rebuild URL → rate-limit check (Valkey token bucket per IP, from `X-Forwarded-For` set by the Ingress controller; see "Real client IP" in 3.3) → dedup lookup by `source_key` → if `ready` and not expired, return 200; else create track + job, enqueue `fetch_youtube`, return 202.
3. **`fetch_youtube` task:**
   - Probe first with yt-dlp `--dump-json` (no download). Reject livestreams, `duration > MAX_DURATION_S`, unavailable videos, mapping errors to 6.6 codes. Detect bot/sign-in challenges → `SOURCE_BLOCKED`.
   - Download with format `bestaudio[ext=m4a]/bestaudio`, `--no-playlist`, to a temp dir. Emit `progress` using yt-dlp progress hooks.
   - If not AAC/m4a, transcode: `ffmpeg -i in -vn -c:a aac -b:a 192k -movflags +faststart out.m4a`.
   - Move to `${MEDIA_DIR}/<uuid>.m4a`, update track → `ready`, emit `audio_ready`.
   - Then run key detection (below) and emit `key_ready`, then `done`.
4. **`POST /api/uploads`**: stream to temp file enforcing `MAX_UPLOAD_MB`, validate with `ffprobe` (must have an audio stream; accept mp3, wav, m4a/aac, flac, ogg/opus), hash for `source_key`, dedup, enqueue `ingest_upload` (normalize to m4a as above, then the same ready → key flow). Title = sanitized original filename.
5. **Key detection** (`audio/key_detection.py`):
   - Decode to mono 22,050 Hz float with ffmpeg → numpy.
   - `tuning = librosa.estimate_tuning(y, sr)` → `tuning_cents = round(tuning * 100)`.
   - `chroma = librosa.feature.chroma_cqt(y=y, sr=sr, tuning=tuning)`; optionally apply harmonic separation (`librosa.effects.harmonic`) first for accuracy if CPU time allows (target < 5 s for a 4-minute song).
   - Average chroma over time; Pearson-correlate against the 24 rotated Krumhansl-Kessler major/minor profiles.
   - Confidence: softmax over correlations with a temperature tuned on test fixtures; return top result + top 2 alternates.
   - Unit tests with synthetic fixtures (generated triads/scales in known keys) must detect the correct key; allow relative major/minor confusion only as an alternate.
6. **SSE endpoint** backed by Valkey pub/sub channel `job:<job_id>`; also store latest state in `job_state:<job_id>` so reconnecting clients get it immediately.
7. **Cleanup task** (ARQ cron, hourly): delete media files and track/job rows past `expires_at`; also delete orphaned files in `MEDIA_DIR`.
8. **`GET /api/tracks/{id}`** per 6.4.

**Acceptance (A)**
- Cache-miss YouTube job reaches `audio_ready` in < 10 s for a typical 4-minute song (when not blocked).
- A cache hit returns `200 {job_id, track_id, status:"done"}` in < 200 ms (§6.4; the client then reads `audio_url` from `GET /api/tracks/{id}`, ADR 0005).
- Upload of a 5 MB MP3 reaches `audio_ready` in < 5 s.
- Blocked, too long, livestream, and invalid inputs each return the correct 6.6 code.
- Key detection passes synthetic fixture tests; runs < 5 s on the VM for 4 minutes of audio.
- Cleanup removes expired files and rows (tested with a short TTL).
- pytest coverage ≥ 80% for `routes/`, `audio/`, `worker/`.

### Workstream B — Browser audio engine (`apps/web/src/audio`)

1. Integrate **Signalsmith Stretch** (npm `signalsmith-stretch`; verify its current API and asset loading). Run it inside an AudioWorklet. If integration blocks for more than a day, fall back to SoundTouchJS in a worklet and log an ADR.
2. Implement `AudioEngine` (6.8): fetch with progress → `decodeAudioData` → feed buffer to the stretch node; playback, pause, and seek with accurate `currentTime`.
3. `setSemitones` / `setCents` update the node's pitch parameters live. Ramp changes over ~30–50 ms to avoid clicks. Tempo stays 1.0.
4. `renderOffline`: same graph in an `OfflineAudioContext` at the source sample rate; return the rendered buffer.
5. `encodeWav(buffer): Blob` — 16-bit PCM stereo, pure TS, unit-tested header correctness.
6. Handle browser autoplay policy (resume `AudioContext` on first user gesture) and Safari quirks.

**Acceptance (B)**
- Dial changes audible in < 100 ms, with no audible clicks or playback restart (manual test on Chrome, Firefox, Safari desktop, and one mobile browser).
- Tempo is unchanged at ±12 semitones (a 4-minute song still ends at 4:00 ± 0.1 s).
- Offline render of a 4-minute song completes in < 15 s on a mid-range laptop and matches what was heard.
- WAV files open correctly in Audacity and the OS player.

### Workstream C — UI/UX (`apps/web/src/features`)

1. **Input screen:** single field that accepts a YouTube URL, plus a drag-and-drop/upload button. Client-side URL validation with inline errors. Paste auto-submits when valid.
2. **Progress:** subscribe via `EventSource`; show named stages ("Fetching audio…", "Analyzing key…"). The player appears as soon as `audio_ready` arrives, even if the key is still loading (show a skeleton for the key badge).
3. **Player:** play/pause, seek bar with time, waveform (wavesurfer.js fed from the decoded buffer, not a second download).
4. **Key dial:** −12…+12, snaps to integers, large touch target, center "reset to original" affordance. Keyboard: ←/→ = ±1, `0` = reset, `Space` = play/pause.
5. **Key readout:** "Original: G major (82%)" with a tap-to-switch between detected alternates; live "Now: A major (+2)"; capo hint; show "Tuning: −12 cents" with a toggle to auto-correct (applies `setCents(-tuning_cents)`).
6. **Export:** "Download WAV" button → `renderOffline` → `encodeWav` → download named `<title> (<newKey>, +2).wav`. Show progress while rendering.
7. **Errors:** map every 6.6 code to friendly copy. `SOURCE_BLOCKED` prominently suggests upload.
8. **Responsive and themed:** works at 360 px width; light/dark mode.
9. **E2E:** one Playwright test covering upload → play → shift +2 → export, using a small fixture file.

**Acceptance (C)**
- A new user completes paste → listen → transpose → download without instructions.
- Lighthouse: Performance ≥ 90 and Accessibility ≥ 95 on the input screen.
- Keyboard-only operation works for the whole flow.

### Phase 1 out of scope

Server-side export, MP3 export, loop regions, tempo control, male/female presets, vocal range analysis, accounts, Essentia, Demucs.

### Phase 1 definition of done

Deployed to the cluster; all workstream acceptance criteria pass; README documents setup, local development (`docker compose -f infra/docker-compose.dev.yml up --build`), and known limitations (YouTube blocking, 24 h retention).

---

## 11. Phase 2 — Quality & practice tools

**Goal:** Make it a tool musicians return to.

> **Capacity check before starting Phase 2:** the acceptance target "studio export of a 4-minute song in < 20 s" was sized for 4 OCPU. On the current 1 OCPU VM shared with Sudoku (§3.6), Rubber Band R3 exports will likely miss it. Before Phase 2 begins, either resize the VM to the free 4 OCPU / 24 GB or write an ADR that changes the export approach. Don't quietly loosen the criterion.

- **Studio-quality export (server):** `POST /api/tracks/{id}/exports {semitones, cents, format:"wav"|"mp3"}` → ARQ task using `rubberband -3 --pitch <semitones + cents/100>` (R3 engine, formant option exposed later) → store as `<uuid>.<ext>`, TTL 24 h, cached by `(track_id, semitones, cents, format)`. New SSE event `export_ready`. The client offers both "Quick WAV" (local) and "Studio quality".
- **Speculative pre-render:** when the dial rests on a non-zero value for 2 s, fire a low-priority export request for WAV so it's often ready at click time. Cap at 3 speculative renders per track per session.
- **MP3 export:** server-side via ffmpeg `libmp3lame`, 320 kbps.
- **Loop regions:** drag on the waveform to set A/B loop; loop is seamless in the engine; practice mode "count-in" optional.
- **Tempo control:** 50–150% independent of pitch (the same Signalsmith engine supports time-stretching). Rubber Band `--tempo` for exports.
- **Vocal presets (heuristic):** "Originally sung by: male / female" toggle. Show preset chips such as "Female voice: +4, +5 or −7 (sing up an octave)" and "Male voice: −4, −5 or +7". Chips are suggestions, not rules; always label them as starting points.
- **Key UX upgrades:** optional Essentia `KeyExtractor` if arm64 wheels are confirmed (ADR required), compare accuracy with librosa on a 20-song labeled set, and choose the better one.
- **Mobile memory:** for tracks > 6 min on devices with low `navigator.deviceMemory`, stream decoded chunks to the worklet instead of holding the whole buffer.
- **Observability:** Sentry in web + api; Uptime Kuma monitors on `/api/health` and a synthetic cache-hit job.

**Acceptance:** studio export of a 4-minute song completes in < 20 s on the VM; loop playback has no audible gap; tempo changes don't alter pitch; export cache hit is instant.

---

## 12. Phase 3 — Vocal intelligence

**Goal:** Recommend the best key for *this* singer.

> **Blocked on capacity:** Demucs (`htdemucs`) needs several GB of RAM and minutes of CPU per song even on 4 cores. It is **not feasible on the current 1 OCPU / 6 GB VM shared with Sudoku** (§3.6, ADR 0003). Phase 3 vocal isolation requires resizing the VM to the free 4 OCPU / 24 GB first, recorded in an ADR. The pYIN / voice-type / hum-your-range parts could run without Demucs on the full mix, at lower accuracy. Decide that at Phase 3 planning.

- **Vocal isolation (background job):** Demucs (`htdemucs`, CPU) runs after `key_ready`, low priority, concurrency 1. Expect minutes per song on the A1; the UI shows "Analyzing vocal range…" and remains fully usable meanwhile.
- **Melody range:** pYIN (`librosa.pyin`) on the isolated vocal stem → robust low/high (5th and 95th percentile of voiced frames) plus a "tessitura" (where the melody spends most time). Store `vocal_low_midi`, `vocal_high_midi`, `tessitura_midi`.
- **Voice-type fitting:** user selects a voice type (bass, baritone, tenor, alto, mezzo-soprano, soprano) with typical ranges, or enters a custom low/high. Score each shift −12…+12 by how well the shifted range and tessitura fit; show the top 3 as "Best fit: +3".
- **Hum-your-range:** client-side mic pitch detection (e.g. the MIT-licensed `pitchy` library) guides the user from their lowest to highest comfortable note; the result is stored locally.
- **Stems practice mode (stretch goal):** play the instrumental stem only, with the same live pitch shifting.
- **Saved songs:** anonymous device ID + `localStorage` history first (free, no auth). GitHub OAuth is optional later if accounts are needed.

**Acceptance:** vocal range estimates are within ±2 semitones of hand-labeled ranges on a 10-song test set; recommendations appear without blocking playback; the VM stays responsive (API p95 < 300 ms) while Demucs runs.

---

## 13. ADR template (`docs/adr/NNNN-title.md`)

```md
# NNNN. Title
Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN

## Context
What problem or constraint forced a decision?

## Decision
What we chose.

## Alternatives considered
Options and why they were rejected.

## Consequences
Trade-offs, follow-up work, risks.
```

---

## 14. Known risks

| Risk | Impact | Mitigation |
|---|---|---|
| YouTube blocks the Oracle datacenter IP | URL input fails | Clear `SOURCE_BLOCKED` UX, upload path, keep yt-dlp updated (weekly Dependabot PR bumps yt-dlp; merging ships a new SHA-tagged image, ADR 0006). Avoid using personal account cookies on the server. |
| YouTube ToS | Takedown / blocking | Personal-practice framing, 24 h retention, random media names, no public library, upload-first messaging |
| Oracle reclaims idle instance | Downtime | Uptime checks and real usage; the cluster is rebuildable from `infra/k8s/` |
| ARM64 native dependency missing | Build failure | Check 3.4 before adopting; ADR for any new native dependency |
| Single VM failure | Full outage | Everything is reproducible from the manifests; data is ephemeral by design |
| Ingress buffers SSE or rejects uploads | Progress appears frozen; uploads fail with 413 | Controller annotations in Phase 0 task 7, verified by the `/api/health/stream` and 50 MB tests |
| Cluster overhead squeezes the free VM | Slower processing | Requests/limits in 3.6, enforced in CI; Demucs is blocked until the VM is resized (§12) |
| The one OCPU is shared with the Sudoku Solver | A Sudoku solve and a KeyShift ingest compete for CPU, and Pending pods if requests grow | 3.6 budget ceilings enforced by `validate-manifests.sh`; `check-cluster.sh` checks live headroom (≥ 250m for Sudoku's rollout surge); resizing to 4 OCPU / 24 GB stays free |
| A shared component changes under us (Traefik, cert-manager, ClusterIssuer) | Certificates stop renewing, or SSE buffering/timeouts regress for both apps | Ownership table in 3.7; KeyShift manifests may only contain `keyshift`-namespaced objects (CI-enforced); Traefik changes only through the reviewed `infra/k8s-bootstrap/` file |
| Key detection mistakes | User confusion | Show confidence + alternates; one-tap override |
