# 0007. Rename KeyShift to PitchBend Live
Date: 2026-09-27
Status: Accepted

## Context
The product is renamed from "KeyShift" to **PitchBend Live**, matching the repository (`edwinargueta/PitchBend-Live`) and the new DuckDNS hostname **`pitchbend-live.duckdns.org`**, which already points at the VM (`170.9.225.68`). Nothing had been committed, pushed or deployed yet, so the rename costs no migration: no data, images, certificates or cluster objects exist under the old names.

## Decision
Rename everything, using one form per kind of identifier:

| Kind | Old | New |
|---|---|---|
| Display name (UI, docs) | KeyShift | PitchBend Live |
| Public host (`PUBLIC_HOST`) | `keyshift.duckdns.org` | `pitchbend-live.duckdns.org` |
| DuckDNS subdomain (`DUCKDNS_SUBDOMAIN`) | `keyshift` | `pitchbend-live` |
| Kubernetes namespace, labels, Ingress | `keyshift` | `pitchbend-live` |
| ConfigMap / Secret / PVC / TLS Secret | `keyshift-config` / `keyshift-secrets` / `keyshift-data` / `keyshift-tls` | `pitchbend-live-config` / `pitchbend-live-secrets` / `pitchbend-live-data` / `pitchbend-live-tls` |
| GHCR images | `ghcr.io/edwinargueta/keyshift-{api,web}` | `ghcr.io/edwinargueta/pitchbend-live-{api,web}` |
| SQLite file (`DB_PATH`) | `/data/db/keyshift.db` | `/data/db/pitchbend-live.db` |
| Compose projects | `keyshift`, `keyshift-deps` | `pitchbend-live`, `pitchbend-live-deps` |
| Python distribution / package | `keyshift` / `keyshift` | `pitchbend-live` / `pitchbend_live` (hyphens aren't valid in module names) |
| Web package | `@keyshift/web` | `@pitchbend-live/web` |
| Test env var | `KEYSHIFT_TEST_REDIS_URL` | `PITCHBEND_LIVE_TEST_REDIS_URL` |
| Container unix user | `keyshift` (uid 10001) | `pitchbend` (uid 10001, unchanged) |

- **§6.2 values change:** `PUBLIC_HOST`, `DUCKDNS_SUBDOMAIN` and `DB_PATH`. The keys themselves don't change.
- **ADRs 0001–0006 were updated in place.** Only product and identifier names changed; no decisions did.

## Consequences
- **Operators:**
  - Create the Secret as `pitchbend-live-secrets` in namespace `pitchbend-live`.
  - After the first image push, make the GHCR packages `pitchbend-live-api` and `pitchbend-live-web` public.
  - The certificate is issued for `pitchbend-live.duckdns.org`.
- **Local Docker leftovers:** old images and volumes named `keyshift*` were removed. Local test data from before the rename was discarded; it would have expired within 24 h anyway.
- **Local Claude Code config:** `.claude/settings.local.json` (the git-ignored auto-mode environment) still names the old namespace. The user should update it so the production-namespace protection covers `pitchbend-live`.
