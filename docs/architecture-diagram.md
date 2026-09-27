# PitchBend Live architecture diagrams

These diagrams show how PitchBend Live fits together. `ARCHITECTURE.md` is the source of truth: §4 covers the topology, §6 the contracts, and §9–12 the phases. If a diagram and the document disagree, the document wins; fix the diagram.

**Legend:** solid boxes exist after **Phase 0** (infrastructure and skeletons). Dashed boxes arrive in **Phase 1+**.

---

## 1. System context

Who talks to whom. The core principle (§4, D1): the server fetches and analyzes each song **once**. Every dial move is handled **in the browser**.

```mermaid
flowchart LR
    user(["Musician / singer"])

    subgraph browser["Browser (static SPA)"]
        ui["UI<br/>URL / upload, key dial, key readout"]
        engine["Audio engine<br/>AudioWorklet + Signalsmith Stretch (WASM)"]
        offline["Offline render<br/>OfflineAudioContext to WAV"]
    end

    subgraph vm["Oracle Always-Free A1 VM (arm64): single-node Kubernetes"]
        ingress["Ingress controller<br/>+ cert-manager TLS"]
        app["pitchbend-live namespace<br/>web, api, worker, valkey"]
    end

    yt[("YouTube")]
    duck[("DuckDNS<br/>pitchbend-live.duckdns.org")]
    le[("Let's Encrypt")]
    ghcr[("GHCR<br/>public arm64 images")]
    sentry[("Sentry<br/>free tier")]

    user --> ui
    ui --> engine
    engine --> offline
    ui -- "HTTPS, same origin" --> ingress
    ingress --> app
    app -- "yt-dlp, audio only" --> yt
    app -- "IP update every 5 min" --> duck
    ingress -- "HTTP-01 challenge" --> le
    vm -- "pull images by git SHA" --> ghcr
    app -.-> sentry

    classDef later stroke-dasharray: 5 5
    class engine,offline,yt,sentry later
```

---

## 2. Runtime topology: `pitchbend-live` namespace

Every workload runs on the one node. The ReadWriteOnce PVC pins them there on purpose (D7). `api` and `worker` are the only SQLite writers, so each runs as **exactly 1 replica with `strategy: Recreate`**.

```mermaid
flowchart TB
    client(["Browser"])

    subgraph ing["Ingress: host pitchbend-live.duckdns.org, TLS pitchbend-live-tls"]
        rApi["/api<br/>buffering OFF, 3600 s timeouts"]
        rMedia["/media"]
        rRoot["/"]
    end

    subgraph ns["Namespace pitchbend-live"]
        subgraph webPod["Deployment web (nginx-unprivileged :8080)"]
            spa["SPA<br/>try_files to index.html"]
            mediaSrv["/media/ from /data/media/<br/>autoindex off, 24 h cache"]
        end

        subgraph apiPod["Deployment api: 1 replica, Recreate"]
            fastapi["FastAPI / uvicorn :8000<br/>/api/health, /api/health/stream"]
        end

        subgraph workerPod["Deployment worker: 1 replica, Recreate"]
            arq["ARQ worker<br/>(same image as api, D16)"]
        end

        valkey[("Deployment valkey :6379<br/>queue + pub/sub<br/>no persistence")]

        subgraph pvc["PVC pitchbend-live-data: RWO 50Gi, mounted at /data"]
            media[("/data/media/uuid4.m4a")]
            db[("/data/db/pitchbend-live.db<br/>SQLite")]
        end

        subgraph cfg["Config, injected with envFrom"]
            cm[/"ConfigMap pitchbend-live-config<br/>§6.2 non-secret keys"/]
            sec[/"Secret pitchbend-live-secrets<br/>DUCKDNS_TOKEN, SENTRY_DSN<br/>created by hand, never in git"/]
        end

        kuma["Deployment uptime-kuma :3001<br/>own 1Gi PVC, no Ingress"]
        duck["CronJob duckdns<br/>every 5 min"]
    end

    client --> ing
    rApi --> fastapi
    rMedia --> mediaSrv
    rRoot --> spa

    fastapi -- "enqueue / subscribe" --> valkey
    valkey -- "jobs" --> arq
    arq -- "progress events" --> valkey

    fastapi -- "read / write" --> db
    arq -- "read / write" --> db
    arq -- "write" --> media
    mediaSrv -. "read-only mount" .-> media

    cfg -. envFrom .-> apiPod
    cfg -. envFrom .-> workerPod
    sec -. "DUCKDNS_TOKEN only" .-> duck
    kuma -. "HTTP checks" .-> fastapi
```

---

## 2b. Shared cluster: PitchBend Live and the Sudoku Solver

The 1 OCPU / 6 GB VM also runs the Sudoku Solver. Traefik routes by hostname, and cert-manager and the ClusterIssuer (installed by the Sudoku repo) serve both apps. PitchBend Live owns only its namespace (§3.7, ADR 0003). The requests below add up to ~630m of the node's 1000m CPU, and at least 250m must stay free for Sudoku's rolling updates.

```mermaid
flowchart TB
    net(["Internet :80 / :443<br/>VM public IP"])

    subgraph node["Oracle A1 Flex VM: 1 OCPU / 6 GB, single-node k3s"]
        subgraph kube["kube-system (cluster, shared)"]
            traefik["Traefik<br/>IngressClass traefik<br/>bootstrap: externalTrafficPolicy Local, readTimeout 300 s"]
            sys["coredns, metrics-server, local-path<br/>~200m requested"]
        end

        subgraph cmns["cert-manager (installed by Sudoku repo, shared)"]
            cm["cert-manager"]
            issuer["ClusterIssuer letsencrypt-prod<br/>HTTP-01, class traefik"]
        end

        subgraph sudoku["sudoku-prod (Sudoku repo, never touched from here)"]
            sapi["api ×1<br/>200m / 256Mi"]
            sweb["web ×2<br/>25m / 32Mi each"]
        end

        subgraph ks["pitchbend-live (this repo)"]
            kweb["web 10m"]
            kapi["api 50m"]
            kworker["worker 100m<br/>concurrency 1"]
            kother["valkey 10m, uptime-kuma 10m"]
        end
    end

    net --> traefik
    traefik -- "Host: sudoku-csp.duckdns.org" --> sweb
    traefik -- "Host: sudoku-csp.duckdns.org /api" --> sapi
    traefik -- "Host: pitchbend-live.duckdns.org" --> kweb
    traefik -- "Host: pitchbend-live.duckdns.org /api" --> kapi
    cm --> issuer
    issuer -. "sudoku-tls" .-> sudoku
    issuer -. "pitchbend-live-tls" .-> ks
```

---

## 3. A dial move never touches the server

This is the North-star UX path: under 100 ms, with no playback restart. Pitch changes; tempo stays at 1.0 (§6.8, §10 B3).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant D as Key dial (React)
    participant E as AudioEngine
    participant W as AudioWorklet (Signalsmith WASM)

    U->>D: Drag or press arrow key (+2)
    D->>E: setSemitones(2)
    E->>W: Ramp pitch param over 30 to 50 ms
    W-->>U: Same song, 2 semitones higher, same tempo
    D->>D: Readout "G major to A major (+2)"
    Note over D,W: No network request. The server is never on the hot path (D1).
```

---

## 4. Ingest: paste URL, then first sound (Phase 1)

The server rebuilds the URL, applies the rate limit, and checks dedup. `audio_ready` is emitted **before** key analysis starts, so the player works before the key is known (§6.5).

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as api
    participant V as valkey
    participant K as worker
    participant Y as YouTube
    participant S as PVC (/data)

    B->>A: POST /api/jobs {url}
    A->>A: Extract 11-char id, rebuild watch?v=id
    A->>V: Rate-limit bucket (real client IP via X-Forwarded-For)
    A->>S: Dedup lookup by source_key yt:id
    alt Cache hit: ready and not expired
        A-->>B: 200 {job_id, track_id, status: done}
        B->>A: GET /api/tracks/{track_id}
        A-->>B: audio_url /media/uuid.m4a
    else Cache miss
        A->>S: Insert track + job rows
        A->>V: Enqueue fetch_youtube
        A-->>B: 202 {job_id, track_id, status: queued}
        B->>A: GET /api/jobs/{job_id}/events (SSE)
        A-->>B: Current state first (late subscribers catch up)
        V->>K: fetch_youtube
        K->>Y: yt-dlp --dump-json (probe duration, livestream, blocked)
        K->>Y: Download bestaudio[ext=m4a], --no-playlist
        K->>V: progress {stage: fetching, pct}
        V-->>A: pub/sub job:job_id
        A-->>B: event: progress
        K->>S: Write /data/media/uuid4.m4a (AAC)
        K->>V: audio_ready
        A-->>B: event: audio_ready (player usable now)
        K->>K: librosa key detection
        alt Key found
            K->>V: key_ready
            A-->>B: event: key_ready
        else Detection failed (non-fatal)
            K->>V: error KEY_DETECTION_FAILED
            A-->>B: event: error (track stays playable)
        end
        A-->>B: event: done
    end
    B->>B: Fetch /media/uuid.m4a from nginx, decode, play
```

Uploads (`POST /api/uploads`) follow the same path. The input is streamed with the `MAX_UPLOAD_MB` limit enforced, MIME-sniffed, checked with `ffprobe`, deduplicated by `up:<sha256[:16]>`, and normalized to AAC `.m4a`.

---

## 5. Track lifecycle and 24 h retention

The TTL is a deliberate YouTube ToS mitigation, not a cache setting (D10–D12, §14).

```mermaid
stateDiagram-v2
    [*] --> queued: POST /api/jobs or /api/uploads
    queued --> fetching: worker picks up job
    fetching --> ready: audio_ready emitted
    fetching --> error: INVALID / TOO_LONG / LIVESTREAM / UNAVAILABLE / BLOCKED
    ready --> ready: key_ready or KEY_DETECTION_FAILED (still playable)
    ready --> expired: expires_at passes (24 h)
    error --> expired: expires_at passes
    expired --> [*]: hourly ARQ cleanup deletes media file + rows
```

---

## 6. Local development vs production

The same Dockerfiles serve both environments (ADR 0001). The `dev` target runs under Docker Compose on your Mac. The `prod` target is built by CI and runs on Kubernetes. The host needs only Docker and git.

```mermaid
flowchart LR
    subgraph local["Local: Docker Compose (infra/docker-compose.dev.yml)"]
        vite["web (dev target)<br/>Vite :5173, HMR"]
        lapi["api (dev target)<br/>uvicorn --reload :8000"]
        lworker["worker (dev target)<br/>arq --watch"]
        lvalkey[("valkey")]
        lmedia["media<br/>nginx + real nginx.conf"]
        lvol[("named volume<br/>pitchbend-live-data at /data")]
        vite -- "/api proxy" --> lapi
        vite -- "/media proxy" --> lmedia
        lapi --> lvalkey
        lworker --> lvalkey
        lapi --> lvol
        lworker --> lvol
        lmedia -. read-only .-> lvol
    end

    subgraph prod["Production: Kubernetes (infra/k8s/)"]
        pweb["web (prod target)<br/>nginx :8080, built SPA"]
        papi["api (prod target)"]
        pworker["worker (prod target)"]
        pvalkey[("valkey")]
        ppvc[("PVC pitchbend-live-data")]
        pweb --- ppvc
        papi --- ppvc
        pworker --- ppvc
        papi --- pvalkey
        pworker --- pvalkey
    end

    dockerfiles{{"infra/docker/*.Dockerfile<br/>dev + prod targets"}}
    dockerfiles -- "docker compose build (local only, never pushed)" --> local
    dockerfiles -- "CI build, GHCR, deploy.sh" --> prod
```

**Two local modes (ADR 0004):**
- **`make up`** runs the Compose stack shown above.
- **`make dev`** runs `api`, `worker` and Vite as native processes on your machine instead. Only `valkey` and `media` stay in Docker (`infra/docker-compose.deps.yml`, ports 6379/8081 on localhost). Data goes to the git-ignored `.data/` in place of the named volume.

Either way, `make check` runs lint and tests in the `dev` images, the same ones CI uses.

---

## 7. Build and deploy pipeline

Deployment is **manual only**. CI never holds cluster credentials (§7). The `pitchbend-live` namespace is the only environment; there is no staging.

```mermaid
flowchart LR
    dev["Developer<br/>docker compose up / run --rm"] --> pr["PR on branch<br/>phase N/workstream-task"]
    pr --> ci["CI workflow (pull_request)<br/>build dev images, ruff, mypy, pytest,<br/>eslint, tsc, vitest, render manifests"]
    ci -- "green" --> main["merge to main"]
    main --> images["Images workflow<br/>linux/arm64 prod targets<br/>packages: write only here"]
    images --> ghcr[("GHCR<br/>pitchbend-live-api:SHA<br/>pitchbend-live-web:SHA<br/>public")]
    main -.-> human(["You: infra/scripts/deploy.sh SHA"])
    human -- "checks images are public,<br/>Secret exists, then kubectl apply -k<br/>(temp overlay pins the SHA)" --> cluster["Oracle VM cluster<br/>namespace pitchbend-live"]
    ghcr -- "image pull" --> cluster
```

---

## 8. Source → artifact map

| Source | Built / applied by | Runs as |
|---|---|---|
| `apps/api/` + `infra/docker/api.Dockerfile` | Compose (`dev`) · CI Images (`prod`) | `api` and `worker` (uid 10001) |
| `apps/web/` + `infra/docker/web.Dockerfile` + `nginx.conf` | Compose (`dev`) · CI Images (`prod`) | `web` (uid 101) |
| `infra/k8s/` (Kustomize) | `infra/scripts/deploy.sh <sha>` (manual) | Everything in namespace `pitchbend-live` |
| `infra/docker-compose.dev.yml` | `docker compose` on your machine | Local only |
| `.github/workflows/` | GitHub Actions (arm64 runners) | CI checks, GHCR pushes |
