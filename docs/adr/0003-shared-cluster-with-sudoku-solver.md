# 0003. Share the 1 OCPU / 6 GB VM with the Sudoku Solver
Date: 2026-09-26
Status: Accepted

## Context
KeyShift was designed for the full Oracle Always-Free A1 allowance (4 OCPU / 24 GB, ARCHITECTURE.md §3.6). The real target is different:
- **The VM is smaller.** It's a `VM.Standard.A1.Flex` with **1 OCPU / 6 GB**.
- **The cluster is shared.** The VM already runs another app, the **Sudoku Solver** (repo `edwinargueta/Sudoku-Solver-Google-OR-tools`), on default k3s. That app lives in namespace `sudoku-prod` at `sudoku-csp.duckdns.org`. Its api requests 200m/256Mi (limit 1 CPU/640Mi), and its two web pods request 25m/32Mi each (limit 200m/128Mi).
- **Shared components come from the Sudoku repo.** Its `deploy/k8s/bootstrap` step installed cert-manager and the `letsencrypt-prod` ClusterIssuer (HTTP-01, class `traefik`). k3s's bundled Traefik routes both apps.

Resizing the VM to 4 OCPU / 24 GB would be free. The user chose to stay at 1 OCPU / 6 GB.

## Decision

1. **Shrink KeyShift to fit next to Sudoku and k3s.** Values are sized from measured idle usage: api 48 MiB, worker 34 MiB (about 250 MiB once librosa loads in Phase 1), Uptime Kuma 133 MiB, Valkey 9 MiB.

   | Workload | CPU request / limit | Memory request / limit |
   |---|---|---|
   | api | 50m / 500m | 96Mi / 384Mi |
   | worker | 100m / 1 | 256Mi / 2Gi |
   | web | 10m / 200m | 16Mi / 64Mi |
   | valkey (`--maxmemory 64mb`) | 10m / 200m | 32Mi / 128Mi |
   | uptime-kuma | 10m / 250m | 160Mi / 320Mi |
   | **Total** | **180m** | **560Mi / ~2.9Gi** |

   The node then has about 630m of its 1000m requested, which leaves ~370m of headroom. At least 250m must stay free so Sudoku's RollingUpdate (200m surge), cert-manager's HTTP-01 solver pods, and CronJobs can schedule.
2. **Change `WORKER_CONCURRENCY` from 2 to 1.** This is a §6.2 contract change. Two concurrent ingests on one shared core would only context-switch.
3. **Enforce the budget.** `infra/scripts/validate-manifests.sh` fails CI if KeyShift's total requests exceed **200m CPU / 640Mi**, total memory limits exceed **3Gi**, or any single memory limit exceeds **2Gi**. `check-cluster.sh` compares live allocatable capacity with every namespace's requests plus KeyShift's.
4. **Treat shared components as not ours:**
   - The Ingress sets `ingressClassName: traefik` explicitly, matching Sudoku and the issuer's solver class. The ingress-nginx annotations stay, inactive, for portability.
   - KeyShift references the `letsencrypt-prod` ClusterIssuer and never installs, upgrades, or edits cert-manager or the issuer.
   - The KeyShift Kustomization may contain only objects in namespace `keyshift` (plus that Namespace). CI rejects cluster-scoped kinds.
5. **One-time, cluster-wide Traefik bootstrap:** `infra/k8s-bootstrap/traefik-config.yaml` is a k3s `HelmChartConfig` that the user applies by hand with sign-off. deploy.sh never applies it. It sets:
   - `externalTrafficPolicy: Local`, so real client IPs reach the rate limiter (§3.3)
   - a web/websecure `readTimeout` of 300 s instead of 60 s, so slow 50 MB uploads aren't cut off

   It also applies to Sudoku, with harmless effects: real client IPs and longer read timeouts.

## Alternatives considered
- **Resize to 4 OCPU / 24 GB** (free): keeps the original design, including Phase 3 Demucs. The user declined for now. It remains the upgrade path: an ADR plus restoring the larger budget, with no code change.
- **Resize to 2 OCPU / 12 GB:** a middle ground. Declined along with resizing in general.
- **Drop Uptime Kuma** to save ~150 MiB: kept, because §3.3 relies on it and Phase 2 observability builds on it. Its request is small.
- **Point KeyShift's Ingress at the default IngressClass:** rejected. The class is known now, and explicit matches Sudoku and the issuer.

## Consequences
- **Slower processing.** A Sudoku solve and a KeyShift ingest compete for one core. Phase 1 targets are expected to hold but have less margin: key detection under 5 s for 4 min of audio, and `audio_ready` under 10 s on a cache miss.
- **Phase 2 is at risk:** studio export under 20 s is unlikely on one shared core. Resize or re-plan before starting Phase 2 (§11).
- **Phase 3 Demucs is blocked** until the VM is resized (§12).
- **Traefik changes affect both apps.** A Traefik pod restart during the bootstrap apply briefly interrupts both.
- **Operator access** is through an SSH tunnel to the k3s API, as in the Sudoku setup. `deploy.sh` and `check-cluster.sh` use whatever kubectl context is current, and print it.
- **DNS:** Sudoku has no DuckDNS updater, so KeyShift's CronJob updates only `keyshift`. If the VM's public IP changes, only KeyShift's record heals. A reserved public IP (§3.3) protects both apps.
