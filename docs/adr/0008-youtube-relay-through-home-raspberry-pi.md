# 0008. Route YouTube fetches through a Raspberry Pi at home
Date: 2026-09-27
Status: Proposed. **Nothing here is built.** This is a design for later. Accepting it needs the user's explicit sign-off on each rule it changes (see "If accepted"), because it touches CLAUDE.md §4 (free tiers), §5 (secrets) and §7 (YouTube ToS posture).

## Context
- **YouTube blocks the VM.** On the first production deploy (2026-09-27, `a18ecc3`), every YouTube link failed with `SOURCE_BLOCKED`. Running yt-dlp inside the worker pod showed why: `Sign in to confirm you're not a bot`. It fails the same way for the default player clients and for `player_client=tv,web_embedded,mweb`. YouTube is blocking the Oracle datacenter IP itself, which is the first risk in §14. The app behaved as designed (D10): the error suggests uploading, and upload works fully.
- **The obvious workarounds are ruled out or unlikely to work:**
  - Account cookies are banned (CLAUDE.md §5).
  - Paid proxies break $0/month (CLAUDE.md §4).
  - PO-token and other bot-check workarounds weaken the ToS posture and rarely beat an IP block.
  - A new VM IP, IPv6, a free VPN exit, or another free cloud all still use datacenter ranges. IPv6 would also mean reinstalling k3s in dual-stack mode, which affects Sudoku.
  - Spotify links don't help. The audio is DRM-protected, and "Spotify downloaders" just search YouTube.
- **The user has a Raspberry Pi 3 at home.** YouTube doesn't treat a home broadband IP as a datacenter.

This ADR records how the Pi could carry **only yt-dlp's traffic**, so YouTube links work on the live site, while everything else stays on Oracle. Facts about Tailscale, yt-dlp and Raspberry Pi OS were checked against their docs and source on 2026-09-27. Re-check versions and free-plan limits before building.

## Decision (proposed)

### How it works
```
 Browser ─ paste link ─▶ api ─ queue ─▶ worker pod, on the Oracle VM
                                         ┌──────────────────────────────┐
                                         │ worker: yt-dlp               │
                                         │   │ proxy at 127.0.0.1:1055  │
                                         │   ▼                          │
                                         │ tailscale sidecar            │
                                         └───┬──────────────────────────┘
                                             │ WireGuard tunnel, outbound only
                                             ▼
                              Raspberry Pi at home (exit node)
                                             │ your home IP
                                             ▼
                                          YouTube
```
- **Tailscale** (free Personal plan) builds an encrypted WireGuard network between the Pi and the worker pod. Both ends connect *outward* to Tailscale's coordination server, so no port opens on the home router or the VM. When a direct path can't be punched through NAT, traffic goes through Tailscale's free DERP relays: slower, but it still works.
- **The Pi is an exit node** tagged `tag:pitchbend-relay`. Tailnet devices that are allowed to use it send their internet traffic out through the home connection. A firewall rule on the Pi stops that traffic from reaching the home network.
- **A `tailscale` sidecar in the worker pod** runs in userspace-networking mode. It needs no `NET_ADMIN`, no privileges and no TUN device, and it doesn't change the pod's routing.
  - It joins the tailnet as `pitchbend-worker`, tagged `tag:pitchbend-worker`, with the Pi as its exit node.
  - It offers an HTTP proxy on `127.0.0.1:1055`.
  - Proxied connections to public addresses go through the exit node. That's confirmed in Tailscale's source (`net/tsdial`), not its docs, and verification step 2 checks it.
- **Only yt-dlp uses the proxy.** The worker passes `YTDLP_PROXY` to yt-dlp's `proxy` option. Valkey, SQLite, ffmpeg transcodes, key detection and Sentry stay direct. Media, playback and uploads never touch the Pi. The audio comes back through the tunnel, and the worker then processes it exactly as it does today.
- **An HTTP proxy, not SOCKS5,** for two reasons:
  - yt-dlp passes only HTTP proxies to ffmpeg, through `http_proxy`, when ffmpeg does a download such as an HLS format. With a SOCKS proxy, it warns that the download "is likely to fail".
  - With an HTTP proxy, tailscaled resolves hostnames itself, through the exit node's DNS. With plain `socks5://`, the pod would resolve them.

### Contract changes (§6.2)
Add two ConfigMap keys:
```
YTDLP_PROXY=http://127.0.0.1:1055          # empty = connect directly (make dev, make up, and prod with the relay off)
RATE_LIMIT_YOUTUBE_FETCHES_PER_DAY=20      # all visitors combined; cache hits, in-flight joins and uploads don't count
```
- **One new Secret, `pitchbend-live-tailscale`,** with key `TS_AUTHKEY`, read **only** by the sidecar. It's deliberately separate from `pitchbend-live-secrets`: the worker container loads that Secret whole with `envFrom`, so a key added there would leak into the yt-dlp process's environment. It holds a **single-use auth key that expires after 1 day**. After the first successful registration, the Secret holds nothing usable.
- **No new error codes.** A reached cap is `RATE_LIMITED` with `retry_after_s`. An unreachable relay is `SOURCE_BLOCKED`, which already tells the user to upload.
- **Compose stays direct.** `YTDLP_PROXY` is empty in `apps/api/.env`, a deliberate exception to "Compose mirrors production config" (CLAUDE.md §3).

### Worker (workstream A)
1. `ydl_params()` adds `"proxy": settings.YTDLP_PROXY` only when it's non-empty.
2. **A relay check before each fetch.** The worker makes one request through the proxy with a 5 s timeout, for example to `https://www.youtube.com/generate_204`. If it fails, the job fails right away with `SOURCE_BLOCKED` and logs `event=relay_unreachable`. Without this check, a Pi that's off would make each fetch hang until yt-dlp's 30 s `socket_timeout` expires, repeated for every retry.
3. **Log a cleaned-up yt-dlp reason on every fetch failure**, with the video ID and URLs removed. This is worth doing even without the relay, since today's logs say only `job failed`.
4. **Tests:** `proxy` is set only when configured; the relay check fails fast and maps to `SOURCE_BLOCKED`; no real network is used, matching the existing mocked-yt-dlp tests.

### API (workstream A) and web (workstream C)
- **A global daily cap on YouTube fetches.** The site is public, and every cache-miss YouTube job would run over the user's home connection. The per-IP limit (10/hour) doesn't bound the total. The existing limiter already supports this: `TokenBucketLimiter(redis, RATE_LIMIT_YOUTUBE_FETCHES_PER_DAY, window_s=86400, prefix="ratelimit:youtube:")`, with a single key.
  - `POST /api/jobs` spends a token **after** the dedup lookup, so cache hits and joins of in-flight jobs are free, and **before** the job is created.
  - Valkey is ephemeral (D5), so a Valkey restart refills the bucket. That's acceptable for a soft cap.
- **Web:** when `RATE_LIMITED` comes with a long `retry_after_s` (for example over 10 minutes), the error panel should suggest uploading instead of showing an hours-long countdown.

### Kubernetes (`infra/k8s/worker.yaml`)
**1. The init container** also creates the state directory. It runs as uid 10001, so the directory is owned by the worker's user:
```sh
mkdir -p /data/media /data/db /data/tmp /data/tailscale && chmod 0755 /data/media && chmod 0750 /data/db /data/tmp && chmod 0700 /data/tailscale
```
**2. A second container** in the worker pod. It inherits the pod's `runAsNonRoot` / `runAsUser: 10001` and `automountServiceAccountToken: false`.
```yaml
        - name: tailscale
          image: ghcr.io/tailscale/tailscale:v1.102.5   # latest stable on 2026-09-27; pin a tag, never latest/stable
          imagePullPolicy: IfNotPresent
          env:
            - name: TS_AUTHKEY
              valueFrom:
                secretKeyRef: {name: pitchbend-live-tailscale, key: TS_AUTHKEY}
            - {name: TS_AUTH_ONCE, value: "true"}      # log in only if the saved state isn't already logged in
            - {name: TS_STATE_DIR, value: /var/lib/tailscale}
            - {name: TS_KUBE_SECRET, value: ""}        # the default ("tailscale") needs RBAC and an API token
            - {name: TS_USERSPACE, value: "true"}      # the default; explicit because the design depends on it
            - {name: TS_SOCKET, value: /tmp/tailscaled.sock}  # explicit: the docs and the code disagree on the default
            - {name: TS_HOSTNAME, value: pitchbend-worker}
            - {name: TS_OUTBOUND_HTTP_PROXY_LISTEN, value: "127.0.0.1:1055"}
            - {name: TS_EXTRA_ARGS, value: "--advertise-tags=tag:pitchbend-worker --exit-node=<Pi's 100.x address>"}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests: {cpu: 10m, memory: 48Mi}
            limits: {cpu: 100m, memory: 96Mi}
          volumeMounts:
            - name: data
              mountPath: /var/lib/tailscale
              subPath: tailscale                       # only /data/tailscale, never media or the DB
```
- **Why saved state:** once the node has registered, restarts reuse its saved identity. Tagged nodes' keys don't expire, and `TS_AUTH_ONCE` skips the spent auth key. Pods can restart and the VM can reboot without any manual steps (CLAUDE.md §8), and no long-lived credential sits in the Secret.
- **Who can read the state:**
  - The web pod mounts `/data` read-only, but runs as a different user, so the `0700` directory is closed to it.
  - The api pod runs as the same user and could read the state. That's acceptable, because an attacker who controls the worker can use the proxy directly anyway.
  - A dedicated PVC would be the stricter option.
- **`replicas: 1` and `strategy: Recreate` stay unchanged.** That also guarantees two pods never use the same node identity at once. The sidecar doesn't write SQLite (CLAUDE.md §8).
- **The Tailscale Kubernetes operator is not used.** It installs cluster-scoped CRDs, which this repo may not create (§3.7).

### VM budget (§3.6; `validate-manifests.sh` counts long-running containers)
| | CPU requests | Memory requests | Memory limits |
|---|---|---|---|
| Today | 180m | 560Mi | 2,944Mi |
| With the sidecar | **190m** | **608Mi** | **3,040Mi** |
| Ceiling (ADR 0003) | 200m | 640Mi | 3,072Mi (3Gi) |

It fits without raising any ceiling, but it leaves almost no headroom: 10m of CPU, 32Mi of requests and 32Mi of limits. Measure the sidecar's real memory after deploying, and lower its limit if it's well under 96Mi.

### Operator setup (the user, one-time)
**0. Free test first.** Before anything else, confirm YouTube doesn't block the home IP. On the Pi:
```bash
curl -fLo yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64
chmod +x yt-dlp
./yt-dlp --simulate --no-playlist "https://www.youtube.com/watch?v=s4ftEdW2wdo"
rm yt-dlp
```
A warning about a missing JavaScript runtime is fine. If it prints `Sign in to confirm you're not a bot`, the home IP is blocked too: stop here.

**1. Tailscale account and access policy.** Sign up for the free Personal plan. In the admin console, under **Access controls**, replace the default allow-all rule, which would let the worker reach every device, with:
```jsonc
{
  "tagOwners": {
    "tag:pitchbend-relay":  ["autogroup:admin"],
    "tag:pitchbend-worker": ["autogroup:admin"],
  },
  "acls": [
    // You (and anyone you invite) can reach every device, including the Pi's SSH.
    {"action": "accept", "src": ["autogroup:member"], "dst": ["*:*"]},
    // The worker may only use exit nodes to reach the internet, never a tailnet
    // device. (The Pi's firewall in step 2 keeps it off the home LAN.)
    {"action": "accept", "src": ["tag:pitchbend-worker"], "dst": ["autogroup:internet:*"]},
  ],
  "autoApprovers": {"exitNode": ["tag:pitchbend-relay"]},
}
```

**2. Prepare the Pi.** Use Raspberry Pi Imager to flash **Raspberry Pi OS Lite (64-bit)**. It's currently based on Debian 13 and supports the Pi 3 B and 3 B+. In Imager's settings:
- Set the hostname to `pitchbend-relay`.
- Create your user.
- Enable SSH with **public-key authentication only**.

Plug the Pi into the router with **Ethernet**, then SSH in:
```bash
sudo apt update && sudo apt full-upgrade -y && sudo apt install -y unattended-upgrades nftables
curl -fsSL https://tailscale.com/install.sh | sh
```
Next, add a firewall rule. Tailnet traffic may leave for the internet over IPv4, but it must never reach the home LAN or the Pi's own non-tailnet addresses. Tailscale's docs don't promise that an exit node keeps its users off its own LAN, so the Pi enforces it:
```bash
sudo tee /etc/pitchbend-relay.nft >/dev/null <<'EOF'
table inet pitchbend_relay
delete table inet pitchbend_relay
table inet pitchbend_relay {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "tailscale0" ip daddr != 100.64.0.0/10 drop
    iifname "tailscale0" ip6 daddr != fd7a:115c:a1e0::/48 drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "tailscale0" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    iifname "tailscale0" meta nfproto ipv6 drop
  }
}
EOF
sudo tee /etc/systemd/system/pitchbend-relay-firewall.service >/dev/null <<'EOF'
[Unit]
Description=PitchBend Live relay firewall
Before=tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/pitchbend-relay.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now pitchbend-relay-firewall
```
- **The rule file replaces only its own table,** so it never flushes Tailscale's rules.
- **Don't enable `nftables.service`:** its default config starts with `flush ruleset`.
- **The Pi forwards IPv4 only.** Home devices usually have public IPv6 addresses that a prefix list can't cover, so IPv6 forwarding stays off. Tailscale falls back to IPv4 when an exit node can reach only one address family.

Now turn on IPv4 forwarding and advertise the exit node:
```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
sudo tailscale up --advertise-exit-node --advertise-tags=tag:pitchbend-relay
```
- **Warnings you can ignore:** `tailscale up` may warn that IPv6 forwarding is disabled, which is intended. It may also warn about "UDP GRO forwarding", a throughput tweak that doesn't matter at a few MB per song.
- **Finish in the admin console:** open the login link it prints. Under **Machines**, `pitchbend-relay` should show **Exit node** and **Expiry disabled**. Note its `100.x.y.z` address; it goes in `TS_EXTRA_ARGS`.

**3. An auth key for the worker.** In **Settings → Keys**, generate an auth key with these settings:
- **not** reusable
- **not** ephemeral
- **expires after 1 day**
- tagged `tag:pitchbend-worker`
- pre-approved

It's used once, when the sidecar first registers, and is worthless after that. Deploy within the day, or generate a fresh key.

**4. Create the Secret** on the VM, in bash. The value never appears on screen or in shell history:
```bash
read -rsp 'Tailscale auth key: ' T; echo
kubectl -n pitchbend-live create secret generic pitchbend-live-tailscale \
  --from-file=TS_AUTHKEY=<(printf '%s' "$T")
unset T
```

**5. Deploy** the commit that contains the change with `infra/scripts/deploy.sh <sha>`, as usual.

### Verification (after deploy)
1. **The tunnel is up.** `kubectl -n pitchbend-live logs deploy/worker -c tailscale --tail=30` shows the node logged in, and `pitchbend-worker` appears as online under **Machines**.
2. **Traffic leaves from home.** This should print your home IP, not `170.9.225.68`:
   ```bash
   kubectl -n pitchbend-live exec deploy/worker -c worker -- python -c \
     "import urllib.request as u; print(u.build_opener(u.ProxyHandler({'https': 'http://127.0.0.1:1055'})).open('https://api.ipify.org', timeout=10).read().decode())"
   ```
3. **The home network is unreachable.** The same command against your router's address must fail with a timeout or a refused connection. Try `http://192.168.1.1` (or `192.168.0.1`), passing `{'http': 'http://127.0.0.1:1055'}` as the proxy.
4. **yt-dlp works through it.** Run the same `yt-dlp --simulate` command as in the Context, adding `--proxy http://127.0.0.1:1055`. It should print no bot error.
5. **End to end.** Paste a link on the live site. It should play, and a cache miss should reach `audio_ready` in under 10 s (§10 acceptance A). If it's slower, `tailscale status` on the Pi shows whether the connection is `direct` or `relay`.
6. **The Pi going offline is handled.** Run `sudo tailscale down` on the Pi. A new link should fail within a few seconds with the "blocked, try uploading" message, and uploads should still work. Then run `sudo tailscale up` again.
7. **`make check`** passes, including the budget check in `validate-manifests.sh`.

### Turning it off, and recovery
- **Immediately:** turn the Pi off, or disable its exit node in the admin console. YouTube links fall back to today's "blocked" message, and nothing else is affected.
- **Permanently:** set `YTDLP_PROXY=` in the ConfigMap, remove the sidecar, the `pitchbend-live-tailscale` Secret and `/data/tailscale`, and redeploy. Delete both machines in the admin console.
- **If the worker's node is deleted, or `/data/tailscale` is lost** (for example, a rebuilt cluster):
  1. Generate a new auth key (step 3).
  2. Replace the Secret: add `--dry-run=client -o yaml | kubectl apply -f -` to the step 4 command.
  3. Empty `/data/tailscale`.
  4. Restart the worker.

  These are production actions: the user runs them.

## Alternatives considered
- **A Tailscale OAuth client with an ephemeral, in-memory node.** No state lives on the PVC. But a long-lived credential that can mint auth keys would sit in the Secret forever, and every pod start would register a new node. The docs also don't confirm that OAuth clients are included in the Personal plan. Workload identity federation avoids stored secrets, but it needs a publicly reachable OIDC issuer, which k3s doesn't provide by default.
- **Plain WireGuard to the Pi**, with a userspace WireGuard-to-SOCKS client in the pod. No third-party service is involved, but it needs a port forward on the home router plus dynamic DNS for the home IP, which is more exposure at home. It would also lose Tailscale's NAT traversal and relay fallback.
- **A SOCKS or HTTP proxy daemon on the Pi**, reached over the tailnet, with no exit node. The access rule could then be narrowed to one port on the Pi. But it's one more service to install and patch on the Pi, and the exit node with the firewall rule already does the job.
- **Run the worker, or just the fetch step, on the Pi.** A Pi 3 has 1 GB of RAM, not enough for the worker's ffmpeg and librosa. A second writer would also break the single-SQLite-writer rule (CLAUDE.md §8), and a fetch-only helper would need new authenticated API endpoints.
- **Tailscale on the VM host**, outside Kubernetes. The cluster would no longer be rebuildable from `infra/k8s/` alone (CLAUDE.md §8), it changes the host that Sudoku also uses, and the worker would need `hostNetwork`.
- **The Tailscale Kubernetes operator.** It installs cluster-scoped CRDs and RBAC, which are forbidden here (§3.7).
- **A paid residential proxy.** The worker change is the same with no Pi, but it breaks $0/month.
- **Live tab capture** in the browser, with no download at all. It's a separate idea for a later phase, worth its own ADR. It works only in Chrome and Edge on desktop.

## Consequences
- **Pro:** YouTube links work on the live site whenever the Pi is online, for $0. The server's ToS mitigations are unchanged: 24 h retention, UUID filenames, no library, and upload-first messaging.
- **Pro:** it degrades safely. If the Pi or Tailscale is down, users see today's `SOURCE_BLOCKED` message, and the rest of the app is unaffected.
- **Con: downloads come from the user's home IP.** That includes downloads requested by strangers, because the site is public. The daily cap bounds how many. If YouTube flags the home IP, the household may start seeing bot checks on its own YouTube use. The legal exposure also moves from an Oracle IP to the user's home connection.
- **Con: it routes around a block YouTube chose to apply.** This is a ToS-posture decision (CLAUDE.md §7) that the user must sign off on.
- **Con: it depends on Tailscale's free plan.** As of 2026-09-27, Personal is $0 for up to 6 users with 50 tagged resources included, and each one beyond that costs $1/month. This design uses 2 (the Pi and the worker). Stale machines count until they're deleted, so delete old `pitchbend-worker` entries after a rebuild. If the plan changes, the relay stops and links fall back to "blocked".
- **Con: more to maintain.** The Pi needs power, OS updates (unattended-upgrades covers most) and an SD card that doesn't fail. The sidecar image needs periodic tag bumps; add it to Dependabot.
- **Con: slower and bandwidth-bound.** Each song crosses the home connection twice: down from YouTube, then up to the VM. About 4 MB each way per song, and at most `RATE_LIMIT_YOUTUBE_FETCHES_PER_DAY` × 8 MB a day in total. Home upload speed sets the pace.
- **Con: VM headroom is almost gone** (see the budget). Anything added later needs an ADR, or a VM resize (free).

## If accepted
- **Rule changes that need the user's sign-off:**
  - CLAUDE.md §5: add `TS_AUTHKEY`, in its own Secret, to the list of secrets.
  - CLAUDE.md §7 and ARCHITECTURE.md §14: record the relay as a YouTube-block mitigation.
  - CLAUDE.md §4 and ARCHITECTURE.md §3.1: add the Tailscale Personal plan as a free tier. Verify its current limits first.
- **Docs:**
  - ARCHITECTURE.md §5: add a row, D24.
  - §6.2: the two new keys and the new Secret.
  - §3.6: a sidecar row and the new totals.
  - §3.4 and §3.5: the `tailscale/tailscale` image (multi-arch including arm64, BSD-3-Clause).
  - §6.1: the `/data/tailscale` directory.
  - README: operator setup and known limitations.
- **Repo:**
  - A `pitchbend-live-tailscale` placeholder in `infra/k8s/secret.example.yaml`.
  - `deploy.sh`: check that the new Secret exists and print how to create it.
  - A Dependabot entry for the sidecar image.
- **Scheduling:** this isn't in any phase's task list (§8). Schedule it after Phase 1's acceptance criteria pass on the cluster.
