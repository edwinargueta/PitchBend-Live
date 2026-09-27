# KeyShift

Paste a YouTube link or upload a song, hear it right away, and transpose it up or down by semitones **without changing tempo**. KeyShift detects the original key, shows the new key live as you turn the dial, and lets you download the transposed audio.

It's built to run at **$0/month** on a single Oracle Always-Free Ampere A1 (arm64) VM with single-node Kubernetes.

> **Status: Phase 0 (infrastructure).** The repo contains the skeleton API and web app, container images, Kubernetes manifests, and CI. Audio features arrive in Phase 1. See [`ARCHITECTURE.md`](ARCHITECTURE.md) §8.

| Doc | What it's for |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full design, contracts (§6), phase plan |
| [`docs/architecture-diagram.md`](docs/architecture-diagram.md) | Mermaid diagrams of the topology, request flows, and pipeline |
| [`CLAUDE.md`](CLAUDE.md) | Guardrails for anyone (human or agent) working in the repo |
| [`docs/adr/`](docs/adr/) | Architecture decision records |

---

## Local development

The `Makefile` is the entry point, in the same style as the Sudoku repo. Run `make help` to see every target. There are two ways to run the app; pick one, because both use ports 5173 and 8000.

| | `make dev`: on your machine | `make up`: in Docker |
|---|---|---|
| What runs where | API (uvicorn), worker (arq) and Vite natively. Only Valkey and the `/media` nginx in Docker. | Everything in Docker Compose, built from the same images as CI |
| Needs | Docker, git, make, **uv**, and **Node 24** (via nvm; `apps/web/.nvmrc`) | Docker, git, make |
| First time | `make setup` (installs the API deps into `apps/api/.venv` and the web deps into `apps/web/node_modules`) | nothing; the first run builds the images |
| Local data | `.data/` (git-ignored) | the `keyshift-data` Docker volume |
| Good for | the fastest reloads, and editor autocomplete/imports | exactly what CI and production run |

```sh
make setup       # once, for make dev
make dev         # run on this machine; Ctrl-C stops everything, including the two containers
# or
make up          # run everything in Docker; Ctrl-C stops (make up-d for the background)
```

On macOS, `make` and `git` both come with the Xcode Command Line Tools. uv installs its own Python 3.12, so your system Python isn't touched. pnpm comes from corepack at the version pinned in `package.json`. `apps/web/.npmrc` pins the public npm registry, so a machine-wide registry setting (e.g. a corporate mirror) doesn't break installs.

> **macOS + Rancher Desktop:** if the repo is under `~/Documents`, `~/Desktop`, or `~/Downloads`, grant Rancher Desktop access in *System Settings → Privacy & Security → Files & Folders*. Otherwise the first bind mount can hang the Docker VM.

| URL | What |
|---|---|
| http://localhost:5173 | The app (Vite dev server with hot reload) |
| http://localhost:8000/api/health | API health (`{"status":"ok","version":"dev"}`) |
| http://localhost:5173/api/health/stream | SSE test stream through the Vite proxy: 5 ticks, 1 s apart |
| http://localhost:8000/api/docs | OpenAPI docs |

Both modes run the same pieces: the API with auto-reload, the ARQ worker with `--watch`, Valkey, nginx serving `/media` with the real production `nginx.conf`, and Vite. Edits reload automatically in both. Tests, lint, and checks (`make test`, `make lint`, `make check`) **always run in the Docker images**, the same ones CI uses, whichever mode you develop in.

### Everyday commands

Run these from the repo root.

| Task | Command |
|---|---|
| Build the dev images | `make build` (or one service: `make build SVC=api`) |
| Start the app | `make dev` (on this machine; `make setup` once first) · `make up` / `make up-d` (in Docker, foreground / background) |
| Follow logs / list services | `make logs` (or `make logs SVC=worker`) · `make ps` |
| Stop | Ctrl-C (`make dev` or `make up`) · `make down` (after `make up-d`) · `make dev-stop` (Valkey/media left over from a killed `make dev`) |
| Stop and wipe local data (DB, media; both modes) | `make reset` |
| Run all tests (pytest + Vitest) | `make test` (or `make test-api` / `make test-web`) |
| Run all linters (ruff, mypy `--strict`, ESLint, Prettier, tsc) | `make lint` |
| Auto-format code | `make fmt` |
| Everything CI runs (lint, tests, K8s manifest validation) | `make check` |
| Add a Python dependency | `make api-run CMD="uv add <pkg>"` (updates `pyproject.toml` + `uv.lock`), then `make up` and `make setup` |
| Add a web dependency | `make web-run CMD="pnpm add <pkg>"` (updates `package.json` + `pnpm-lock.yaml`), then `make up` (rebuilds and refreshes the container's `node_modules`) and `make setup` (refreshes the host deps for `make dev`) |
| A shell / any command in a container | `make api-shell` · `make web-shell` · `make api-run CMD="…"` · `make web-run CMD="…"` |
| Build the production images locally | `make images` (tags `keyshift-{api,web}:local`; never pushed, and there's deliberately no `publish` target) |
| Free disk (remove local images and artifacts) | `make clean` (local data stays; `make reset` wipes it) |

Under the hood, each target is plain `docker compose -f infra/docker-compose.dev.yml …`. For example, `make test-api` runs `docker compose … run --rm --no-deps api uv run pytest -q`, so the raw commands still work.

Commit the updated lockfile with every dependency change. Images install from lockfiles with `uv sync --frozen` and `pnpm install --frozen-lockfile`. Every new dependency must be GPL-3.0-compatible and have a linux/arm64 build.

### Local configuration

The API reads the [§6.2](ARCHITECTURE.md) keys from its environment, and its defaults match the §6.2 values, so local dev needs no config file. To override something, create `apps/api/.env`. It's git-ignored and Compose injects it at runtime, never at build time. Use the same keys as `infra/k8s/configmap.yaml`.

---

## Production (Oracle VM)

The `keyshift` namespace on the Oracle VM is KeyShift's **only** environment. There is no staging, so every command below is a production action. Deploys are manual: CI builds images but never holds cluster credentials.

**The VM is shared.** It's a 1 OCPU / 6 GB k3s node that also runs the **Sudoku Solver** (namespace `sudoku-prod`, `sudoku-csp.duckdns.org`). The two apps share Traefik, cert-manager, the `letsencrypt-prod` ClusterIssuer (installed by the Sudoku repo), and the single core. KeyShift is sized to fit ([ARCHITECTURE.md §3.6–3.7](ARCHITECTURE.md), [ADR 0003](docs/adr/0003-shared-cluster-with-sudoku-solver.md)). Never install or upgrade cert-manager or edit the issuer from this repo, and never touch `sudoku-prod`.

**Cluster access:** the k3s API isn't exposed publicly. If you already reach it for Sudoku, reuse that setup. Otherwise, open an SSH tunnel to the VM and use its kubeconfig, which holds cluster-admin credentials: keep it in `~/.kube/`, never in the repo.

```sh
# One time. k3s.yaml is root-only (0600); its server already points at https://127.0.0.1:6443.
ssh ubuntu@<vm-ip> sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/oracle-k3s.yaml && chmod 600 ~/.kube/oracle-k3s.yaml
# Each session: keep the tunnel open while you work.
ssh -N -L 6443:127.0.0.1:6443 ubuntu@<vm-ip> &
export KUBECONFIG=~/.kube/oracle-k3s.yaml
```

### 1. One-time: check the cluster

```sh
infra/scripts/check-cluster.sh
```

It's read-only. It checks:
- kubectl access, and that the node is `arm64`
- IngressClass `traefik`
- the shared cert-manager and `letsencrypt-prod` ClusterIssuer
- the default StorageClass
- the pod CIDR
- whether the node has room for KeyShift next to Sudoku and k3s: it compares allocatable capacity with every namespace's requests, and wants ≥ 250m CPU left free so Sudoku's rollouts don't hang
- whether the shared Traefik config (step 2) is applied

- **Pod CIDR:** `FORWARDED_ALLOW_IPS` in `infra/k8s/api.yaml` must cover it. The default is `10.42.0.0/16`, k3s's default. Without it, rate limiting in Phase 1 would see the Ingress pod's IP instead of the user's.
- **Oracle firewalls:** ports 80 and 443 must be open in both the VCN Security List and the VM's iptables (§3.3). They already are if the Sudoku site works.

### 2. One-time: shared Traefik config (affects Sudoku too)

`infra/k8s-bootstrap/traefik-config.yaml` is a k3s `HelmChartConfig`. It keeps real client IPs (`externalTrafficPolicy: Local`, needed for rate limiting) and raises Traefik's request read timeout from 60 s to 300 s, so slow 50 MB uploads aren't cut off. It's **cluster-wide**: Sudoku gets the same (harmless) settings, and both sites blip for a few seconds while Traefik restarts. Read the file's header first. If a `HelmChartConfig` named `traefik` already exists, merge instead of overwriting.

```sh
kubectl -n kube-system get helmchartconfig traefik -o yaml    # expect NotFound; otherwise merge
kubectl apply -f infra/k8s-bootstrap/traefik-config.yaml
kubectl -n kube-system rollout status deploy/traefik
curl -sI https://sudoku-csp.duckdns.org | head -1              # Sudoku still up
```

### 3. One-time: GitHub and GHCR

1. Create the public repo `edwinargueta/PitchBend-Live` and push `main`. The *Images* workflow builds `linux/arm64` images and pushes `ghcr.io/edwinargueta/keyshift-api:<sha>` and `keyshift-web:<sha>`.
2. GHCR creates new packages as **private**. Make both packages **public**: GitHub → your profile → *Packages* → package → *Package settings* → *Change visibility*. The cluster pulls anonymously, and `deploy.sh` refuses to deploy until both are public.

### 4. Namespace and Secret

These steps are needed the first time, and again after the namespace is deleted. The Secret is never in git.

Run these in **bash** (in zsh, `read -p` means something else; type `bash` first):

```bash
kubectl apply -f infra/k8s/namespace.yaml
read -rsp 'DUCKDNS_TOKEN: ' DUCKDNS_TOKEN; echo
read -rsp 'SENTRY_DSN (Enter for none): ' SENTRY_DSN; echo
kubectl -n keyshift create secret generic keyshift-secrets \
  --from-file=DUCKDNS_TOKEN=<(printf '%s' "$DUCKDNS_TOKEN") \
  --from-file=SENTRY_DSN=<(printf '%s' "$SENTRY_DSN")
unset DUCKDNS_TOKEN SENTRY_DSN
```

The values never appear on screen, in shell history, or in any command line visible to `ps`. `infra/k8s/secret.example.yaml` is a template only and is deliberately left out of the Kustomization. `deploy.sh` refuses to apply anything that contains a Secret.

### 5. Deploy

```sh
infra/scripts/deploy.sh "$(git rev-parse HEAD)"   # the SHA must have images in GHCR
```

`deploy.sh` prints the current kubectl context and asks for confirmation. It checks that both images exist, are publicly pullable, and include linux/arm64, and that the Secret exists. Then it renders `infra/k8s` through a temporary Kustomize overlay that pins both image tags to that SHA (nothing in git changes). It refuses the render if it contains a Secret, a placeholder tag, or `latest`, applies exactly the checked render, and waits for every rollout. Running `kubectl apply -k infra/k8s` by itself deploys a placeholder tag that fails safely with `ImagePullBackOff`.

### 6. Verify (Phase 0 acceptance)

```sh
curl -I https://keyshift.duckdns.org                        # 200, valid Let's Encrypt cert
kubectl -n keyshift get certificate                          # READY=True
curl -s https://keyshift.duckdns.org/api/health              # {"status":"ok","version":"<sha>"}
curl -N https://keyshift.duckdns.org/api/health/stream       # ticks arrive ~1 s apart, not all at the end
head -c 52428800 /dev/urandom > /tmp/50mb.bin
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Expect:' --data-binary @/tmp/50mb.bin \
  https://keyshift.duckdns.org/api/health                    # anything but 413 (405 is expected)
# -H 'Expect:' stops curl waiting for "100 Continue", so the full 50 MB is actually sent.
kubectl -n keyshift get pods                                 # all Ready
kubectl -n keyshift get jobs                                 # latest duckdns job Complete
curl -sI https://sudoku-csp.duckdns.org | head -1            # the neighbor is still healthy
kubectl -n sudoku-prod get pods                              # read-only look: all Ready, none Pending
```

Also confirm that rebooting the VM brings everything back with no manual steps. Then confirm that `kubectl delete namespace keyshift` followed by steps 4–5 rebuilds everything. **Deleting the namespace also deletes the Secret and all data.**

Uptime Kuma has no Ingress. Reach it with `kubectl -n keyshift port-forward svc/uptime-kuma 3001:3001` and open http://localhost:3001.

### Ingress controller notes

The cluster runs k3s's bundled **Traefik**, shared with Sudoku, and `infra/k8s/ingress.yaml` sets `ingressClassName: traefik`. Traefik routes each request by hostname, so the two apps never see each other's traffic.

- **SSE:** Traefik streams responses without buffering, so progress events arrive live. Never attach a Buffering middleware.
- **Uploads:** Traefik has no default body limit. Its 60 s read timeout is raised to 300 s by step 2.
- **Leftover annotations:** the `nginx.ingress.kubernetes.io/*` annotations do nothing on Traefik. They stay so the file remains safe if the controller ever changes. (Note: the ingress-nginx project was retired in March 2026.)

Any change to `ingress.yaml` must keep these properties and be re-verified with the stream and 50 MB tests above.

---

## CI

- **CI** (`.github/workflows/ci.yml`, on every PR and on `main`) builds the `dev` images on native arm64 runners and runs ruff, mypy `--strict`, pytest, ESLint, Prettier, tsc, and Vitest inside them. It also builds the `prod` images without pushing and validates the rendered manifests.
- **Images** (`.github/workflows/images.yml`, on `main`) builds the `prod` targets for `linux/arm64` and pushes them to GHCR, tagged with the full and short git SHA. Tags are never `latest`.

## Known limitations

- YouTube often blocks datacenter IPs such as Oracle's. When that happens, KeyShift says so and suggests uploading the file instead.
- Songs and data are deleted after **24 hours** (a deliberate retention policy).
- There is one node and no redundancy. The cluster is rebuildable from `infra/k8s/` plus a re-created Secret.

## License

[GPL-3.0-or-later](LICENSE). Required by the Rubber Band dependency (GPL-2.0+) planned for Phase 2. See `ARCHITECTURE.md` §3.5.
