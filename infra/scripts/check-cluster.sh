#!/usr/bin/env bash
# infra/scripts/check-cluster.sh: read-only pre-flight checks for the PitchBend Live
# cluster (ARCHITECTURE.md §9 task 1). Run it before the first deploy, after
# rebuilding the cluster, and whenever a deploy misbehaves.
#
# SAFE TO RUN AGAINST PRODUCTION: it only uses read-only kubectl commands
# (version, get, config view/current-context) plus `kubectl kustomize`, which
# renders infra/k8s locally without contacting the cluster. That render is read
# by yq in a throwaway Docker container (no kubeconfig mounted). It never
# creates, changes or deletes anything, and never prints Secret values, only
# whether the Secret and its keys exist.
#
# The cluster is shared with the Sudoku Solver (ADR 0003): Traefik, cert-manager
# and the ClusterIssuer are shared components that this script only inspects.
#
# Usage:  infra/scripts/check-cluster.sh
# Exit:   0 if no check FAILs (WARN lines are advisory), 1 otherwise.
# Needs:  bash 3.2+ (the macOS default works), kubectl, awk. Docker (or
#         mikefarah yq v4 on PATH) for PitchBend Live's exact requests in the capacity
#         check; without it, the ADR 0003 budget ceilings are used instead.
set -euo pipefail

readonly NAMESPACE=pitchbend-live
readonly SECRET=pitchbend-live-secrets
readonly CLUSTER_ISSUER=letsencrypt-prod
readonly INGRESS_CLASS=traefik # shared k3s Traefik; ingress.yaml sets it explicitly
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly K8S_DIR="$SCRIPT_DIR/../k8s"
readonly API_YAML="$K8S_DIR/api.yaml"
readonly INGRESS_YAML="$K8S_DIR/ingress.yaml"
readonly TRAEFIK_BOOTSTRAP=infra/k8s-bootstrap/traefik-config.yaml
readonly YQ_IMAGE="mikefarah/yq:4.53.6" # same pin as validate-manifests.sh (MIT, linux/arm64)

# Capacity thresholds (ADR 0003, ARCHITECTURE.md §3.6).
readonly MIN_CPU_HEADROOM_M=250 # Sudoku's api RollingUpdate surges 200m; keep room for it
readonly MIN_MEMORY_HEADROOM_MI=512
# ADR 0003 ceilings on PitchBend Live's own totals (CI enforces them in
# validate-manifests.sh). Used only if the render can't be measured.
readonly BUDGET_CPU_REQUESTS_M=200 BUDGET_MEMORY_REQUESTS_MI=640 BUDGET_MEMORY_LIMITS_MI=3072

if [[ -t 1 ]]; then
  C_PASS=$'\033[32m' C_FAIL=$'\033[31m' C_WARN=$'\033[33m' C_BOLD=$'\033[1m' C_OFF=$'\033[0m'
else
  C_PASS='' C_FAIL='' C_WARN='' C_BOLD='' C_OFF=''
fi

n_pass=0 n_fail=0 n_warn=0
pass()    { n_pass=$((n_pass + 1)); printf '%s[PASS]%s %s\n' "$C_PASS" "$C_OFF" "$*"; }
fail()    { n_fail=$((n_fail + 1)); printf '%s[FAIL]%s %s\n' "$C_FAIL" "$C_OFF" "$*"; }
warn()    { n_warn=$((n_warn + 1)); printf '%s[WARN]%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
info()    { printf '       %s\n' "$*"; }
hint()    { printf '       -> %s\n' "$*"; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

# Indent every line of a (possibly multi-line) string.
info_lines() {
  local line
  while IFS= read -r line; do [[ -n "$line" ]] && info "$line"; done <<<"$1"
  return 0
}

# Read-only kubectl, with a timeout so an unreachable API server can't hang the script.
k() { kubectl --request-timeout=20s "$@"; }

summary() {
  printf '\n%sSummary:%s %d passed, %d warning(s), %d failed\n' \
    "$C_BOLD" "$C_OFF" "$n_pass" "$n_warn" "$n_fail"
  if ((n_fail > 0)); then
    echo "Fix every FAIL before running infra/scripts/deploy.sh."
    exit 1
  fi
  echo "All required checks passed."
  exit 0
}

# One line per pod: "namespace/name<TAB>phase<TAB>ready flags of each container".
readonly POD_FMT='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .status.containerStatuses[*]}{.ready}{" "}{end}{"\n"}{end}'

# Prints each pod from POD_FMT lines. Succeeds only if there is at least one
# pod and every pod is Running with all containers ready. Completed Job pods
# (phase Succeeded, e.g. cert-manager's startupapicheck) are ignored.
pods_healthy() {
  local name phase ready ok=0 bad=0
  while IFS=$'\t' read -r name phase ready; do
    [[ -n "$name" ]] || continue
    if [[ "$phase" == Succeeded ]]; then
      info "$name: completed Job pod (ignored)"
    elif [[ "$phase" == Running && -n "$ready" && "$ready" != *false* ]]; then
      info "$name: Running, ready"
      ok=$((ok + 1))
    else
      info "$name: phase=$phase ready=[${ready% }]"
      bad=$((bad + 1))
    fi
  done <<<"$1"
  ((ok > 0 && bad == 0))
}

# --- IPv4 CIDR helpers (pure bash; inputs are validated before any arithmetic) ---
is_ipv4_cidr() {
  local re='^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$'
  [[ "$1" =~ $re ]]
}
ip_to_int() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  echo $(((10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d))
}
# cidr_contains OUTER INNER: true if INNER lies entirely inside OUTER.
cidr_contains() {
  local o_ip=${1%/*} o_len=${1#*/} i_ip=${2%/*} i_len=${2#*/} mask
  ((i_len >= o_len)) || return 1
  mask=$((o_len == 0 ? 0 : (0xFFFFFFFF << (32 - o_len)) & 0xFFFFFFFF))
  [[ $(($(ip_to_int "$o_ip") & mask)) -eq $(($(ip_to_int "$i_ip") & mask)) ]]
}

# --- Resource quantities (used by the capacity check) ---
# Kubernetes quantity parsing for awk (POSIX awk; tested with macOS awk, busybox, mawk, gawk).
# cpu_m: "250m" | "1" | "0.5" -> millicores. mem_b: Ki/Mi/Gi/Ti, k/K/M/G/T or
# plain bytes -> bytes. Both return -1 for anything else.
# Keep in sync with the copy in validate-manifests.sh.
readonly AWK_QUANTITY='
function cpu_m(q) {
  if (q ~ /^([0-9]+|[0-9]*\.[0-9]+)m$/) return substr(q, 1, length(q) - 1) + 0
  if (q ~ /^([0-9]+|[0-9]*\.[0-9]+|[0-9]+\.)$/) return int(q * 1000 + 0.5)
  return -1
}
function mem_b(q,   num, suf) {
  if (!match(q, /^([0-9]+|[0-9]*\.[0-9]+)/)) return -1
  num = substr(q, 1, RLENGTH) + 0
  suf = substr(q, RLENGTH + 1)
  if (suf == "") return num
  if (suf == "Ki") return num * 1024
  if (suf == "Mi") return num * 1048576
  if (suf == "Gi") return num * 1073741824
  if (suf == "Ti") return num * 1099511627776
  if (suf == "k" || suf == "K") return num * 1000
  if (suf == "M") return num * 1000000
  if (suf == "G") return num * 1000000000
  if (suf == "T") return num * 1000000000000
  return -1
}
'
# Bytes -> "<n>Mi", rounded to the nearest MiB (bash integers are 64-bit).
fmt_mi() {
  local b=$1 sign=""
  if ((b < 0)); then sign="-" b=$((-b)); fi
  printf '%s%dMi' "$sign" $(((b + 524288) / 1048576))
}

# One line per container of the rendered manifests: kind, workload, init|main,
# container, replicas, requests.cpu, requests.memory, limits.cpu, limits.memory
# ("-" if unset). Keep in sync with the copy in validate-manifests.sh.
# shellcheck disable=SC2016 # $kind, $name, ... are yq variables, not shell ones
readonly CONTAINER_ROWS='select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "ReplicaSet" or .kind == "DaemonSet" or .kind == "Pod" or .kind == "Job" or .kind == "CronJob")
  | .kind as $kind | .metadata.name as $name | (.spec.replicas // 1) as $replicas
  | (.spec.jobTemplate.spec.template.spec // .spec.template.spec // .spec) as $pod
  | ((($pod.initContainers // [])[] | {"type": "init", "c": .}), (($pod.containers // [])[] | {"type": "main", "c": .}))
  | [$kind, $name, .type, .c.name, $replicas,
     (.c.resources.requests.cpu // "-"), (.c.resources.requests.memory // "-"),
     (.c.resources.limits.cpu // "-"), (.c.resources.limits.memory // "-")]
  | @tsv'

# Sets ks_rows (CONTAINER_ROWS lines for the rendered infra/k8s) and ks_how.
# `kubectl kustomize` renders locally and never contacts the cluster; yq runs in
# a throwaway container that gets the render on stdin and nothing else.
measure_pitchbend_live() {
  local rendered
  ks_rows="" ks_how=""
  if ! rendered=$(kubectl kustomize "$K8S_DIR" 2>&1); then
    ks_how="kubectl kustomize infra/k8s failed: $(head -n 1 <<<"$rendered")"
    return 1
  fi
  if command -v docker >/dev/null 2>&1 &&
    ks_rows=$(docker run --rm -i -q "$YQ_IMAGE" "$CONTAINER_ROWS" <<<"$rendered" 2>/dev/null); then
    ks_how="kubectl kustomize + yq in Docker"
    return 0
  fi
  if command -v yq >/dev/null 2>&1 && yq --version 2>&1 | grep -q 'mikefarah/yq.* v4\.' &&
    ks_rows=$(yq "$CONTAINER_ROWS" <<<"$rendered" 2>/dev/null); then
    ks_how="kubectl kustomize + yq on PATH"
    return 0
  fi
  ks_how="neither Docker nor mikefarah yq v4 could read the render"
  return 1
}

# One line per pod: namespace, name, phase, then "req.cpu,req.memory,lim.memory;"
# per container, "req.cpu,req.memory,lim.memory,restartPolicy;" per init
# container, and "overhead.cpu,overhead.memory". Unset values are empty.
readonly POD_RES_FMT='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .spec.containers[*]}{.resources.requests.cpu}{","}{.resources.requests.memory}{","}{.resources.limits.memory}{";"}{end}{"\t"}{range .spec.initContainers[*]}{.resources.requests.cpu}{","}{.resources.requests.memory}{","}{.resources.limits.memory}{","}{.restartPolicy}{";"}{end}{"\t"}{.spec.overhead.cpu}{","}{.spec.overhead.memory}{"\n"}{end}'

echo "PitchBend Live cluster pre-flight (read-only; nothing is changed)"

# -----------------------------------------------------------------------------
section "1. Cluster access"
if ! command -v kubectl >/dev/null 2>&1; then
  fail "kubectl is not on PATH"
  summary
fi
ctx=$(kubectl config current-context 2>/dev/null) || ctx=""
if [[ -z "$ctx" ]]; then
  fail "No current kubectl context is set"
  hint "Point kubectl at the Oracle VM cluster (kubectl config use-context <name>)."
  summary
fi
server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null) || server="?"
info "context: $ctx"
info "server:  $server"
# `kubectl version` exits non-zero when it can't reach the API server.
if ver=$(k version 2>&1); then
  sv=$(sed -n 's/^Server Version: //p' <<<"$ver")
  pass "kubectl reaches the cluster (server ${sv:-version unknown})"
else
  fail "kubectl cannot reach the cluster for context '$ctx'"
  info_lines "$ver"
  summary
fi

# -----------------------------------------------------------------------------
section "2. Node architecture"
# One line per node: name<TAB>architecture<TAB>podCIDR (reused by check 8).
if ! nodes=$(k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\t"}{.spec.podCIDR}{"\n"}{end}' 2>&1); then
  fail "Could not list nodes"
  info_lines "$nodes"
  nodes=""
else
  n_nodes=0 non_arm=""
  while IFS=$'\t' read -r name arch _; do
    [[ -n "$name" ]] || continue
    n_nodes=$((n_nodes + 1))
    info "$name: $arch"
    [[ "$arch" == arm64 ]] || non_arm+=" $name($arch)"
  done <<<"$nodes"
  if ((n_nodes == 0)); then
    fail "The cluster reports no nodes"
  elif [[ -n "$non_arm" ]]; then
    fail "Not every node is arm64:$non_arm (images are built for linux/arm64 only, CLAUDE.md §1)"
  else
    pass "All $n_nodes node(s) are arm64"
  fi
  if ((n_nodes > 1)); then
    warn "$n_nodes nodes: the ReadWriteOnce PVC ties every PitchBend Live pod to one node (CLAUDE.md §5)"
    hint "Don't add nodes without first moving to ReadWriteMany storage."
  fi
fi

# -----------------------------------------------------------------------------
section "3. Ingress controller"
# Known controller labels: Traefik (k3s default, old and new charts) and ingress-nginx.
readonly IC_SELECTORS='app.kubernetes.io/name=traefik
app=traefik
app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/component=controller
app.kubernetes.io/name=rke2-ingress-nginx,app.kubernetes.io/component=controller'
ic_pods="" ic_svcs=""
while IFS= read -r sel; do
  out=$(k get pods -A -l "$sel" -o jsonpath="$POD_FMT" 2>/dev/null) || out=""
  ic_pods+="$out"
  out=$(k get services -A -l "$sel" -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.type}{"\t"}{.spec.externalTrafficPolicy}{"\n"}{end}' 2>/dev/null) || out=""
  ic_svcs+="$out"
done <<<"$IC_SELECTORS"
ic_pods=$(printf '%s' "$ic_pods" | sort -u)
ic_svcs=$(printf '%s' "$ic_svcs" | sort -u)

if [[ -z "$ic_pods" ]]; then
  fail "No Traefik or ingress-nginx controller pods found"
  hint "Look for it manually: kubectl get pods -A | grep -i -E 'ingress|traefik'"
  hint "For another controller, find its equivalents of 'no response buffering', 'long read"
  hint "timeout' and 'max body size >= 55m' and record them in an ADR (ARCHITECTURE.md §9 task 7)."
elif pods_healthy "$ic_pods"; then
  pass "Ingress controller pods are Running and ready"
else
  fail "Some Ingress controller pods are not Running/ready (see above)"
fi

# -----------------------------------------------------------------------------
section "4. Shared Traefik configuration"
# Traefik serves every app on this cluster, the Sudoku Solver included (ADR 0003).
# PitchBend Live's only sanctioned change to it is $TRAEFIK_BOOTSTRAP, applied by hand.
traefik_needs_bootstrap=0

if hcc=$(k -n kube-system get helmchartconfig traefik -o name 2>&1); then
  info "HelmChartConfig kube-system/traefik exists (k3s merges its values into Traefik's chart)"
elif grep -q NotFound <<<"$hcc"; then
  info "HelmChartConfig kube-system/traefik does not exist (Traefik runs with k3s's defaults)"
elif grep -q "resource type" <<<"$hcc"; then
  info "This cluster has no HelmChartConfig resource type (not k3s?)"
else
  warn "Could not check HelmChartConfig kube-system/traefik"
  info_lines "$hcc"
fi

# Real client IP for rate limiting (ARCHITECTURE.md §3.3, CLAUDE.md §5).
etp_cluster="" etp_local=""
while IFS=$'\t' read -r svc type etp; do
  [[ -n "$svc" ]] || continue
  case "$type" in
    LoadBalancer | NodePort)
      info "Service $svc: type=$type externalTrafficPolicy=${etp:-?}"
      if [[ "$etp" == Local ]]; then etp_local+=" $svc"; else etp_cluster+=" $svc"; fi
      ;;
    *) ;; # ClusterIP etc.: not exposed outside the cluster, so the policy is irrelevant
  esac
done <<<"$ic_svcs"
if [[ -n "$etp_cluster" ]]; then
  warn "Ingress controller Service(s) use externalTrafficPolicy: Cluster:$etp_cluster"
  hint "Client IPs get SNATed, so every user shares one rate-limit bucket (ARCHITECTURE.md §3.3)."
  traefik_needs_bootstrap=1
elif [[ -n "$etp_local" ]]; then
  pass "Ingress controller Service preserves client IPs (externalTrafficPolicy: Local)"
else
  info "No LoadBalancer/NodePort Service found for the controller (hostNetwork setup?)."
  info "After deploying, confirm the API sees real client IPs in X-Forwarded-For."
fi

# Traefik v3 closes a request that takes longer than readTimeout (60 s by default)
# to arrive, body included, which cuts off slow 50 MB uploads (ingress.yaml header).
# One line per Deployment: namespace/name<TAB>space-separated container args.
traefik_deps=$(k get deployments -A -l app.kubernetes.io/name=traefik -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{range .spec.template.spec.containers[*]}{range .args[*]}{@}{" "}{end}{end}{"\n"}{end}' 2>/dev/null) || traefik_deps=""
if [[ -z "$traefik_deps" ]]; then
  info "No Traefik Deployment found (label app.kubernetes.io/name=traefik); readTimeout not checked."
else
  rt_missing=""
  while IFS=$'\t' read -r dep args; do
    [[ -n "$dep" ]] || continue
    found=""
    for ep in web websecure; do
      val=$(tr ' ' '\n' <<<"$args" | grep -i -- "^--entrypoints\.$ep\.transport\.respondingtimeouts\.readtimeout=" | tail -n 1) || val=""
      if [[ -n "$val" ]]; then found+=" $ep=${val#*=}"; else rt_missing+=" $dep:$ep"; fi
    done
    info "Deployment $dep: respondingTimeouts.readTimeout${found:- not set (60s default in Traefik v3)}"
  done <<<"$traefik_deps"
  if [[ -n "$rt_missing" ]]; then
    warn "Traefik entrypoint(s) without respondingTimeouts.readTimeout:$rt_missing"
    hint "With the 60 s default, a 50 MB upload over a link slower than ~7 Mbit/s is cut off."
    traefik_needs_bootstrap=1
  else
    pass "Traefik sets respondingTimeouts.readTimeout for the web and websecure entrypoints"
  fi
fi
if ((traefik_needs_bootstrap)); then
  hint "Fix for the WARN(s) above: apply $TRAEFIK_BOOTSTRAP by hand, once, with sign-off"
  hint "(see its header). It is CLUSTER-WIDE: it reconfigures the Traefik the Sudoku Solver also"
  hint "uses, and restarting Traefik briefly interrupts both apps. deploy.sh never applies it."
fi

# -----------------------------------------------------------------------------
section "5. IngressClass"
# ingress.yaml names INGRESS_CLASS explicitly (ADR 0003; validate-manifests.sh
# enforces it): the class Sudoku and the shared ClusterIssuer's solver use.
file_class=$(awk '/^[[:space:]]*ingressClassName:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/["\047[:space:]]/, ""); print; exit }' \
  "$INGRESS_YAML" 2>/dev/null) || file_class=""
if [[ "$file_class" != "$INGRESS_CLASS" ]]; then
  fail "infra/k8s/ingress.yaml sets ingressClassName: ${file_class:-<none>}, expected $INGRESS_CLASS (ADR 0003)"
fi
if ! classes=$(k get ingressclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.controller}{"\t"}{.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class}{"\n"}{end}' 2>&1); then
  fail "Could not list IngressClasses"
  info_lines "$classes"
else
  while IFS=$'\t' read -r name controller is_default; do
    [[ -n "$name" ]] || continue
    if [[ "$is_default" == true ]]; then
      info "$name (controller $controller) [default]"
    else
      info "$name (controller $controller)"
    fi
  done <<<"$classes"
  if cut -f1 <<<"$classes" | grep -qxF -- "$INGRESS_CLASS"; then
    pass "IngressClass $INGRESS_CLASS exists (infra/k8s/ingress.yaml sets ingressClassName: $INGRESS_CLASS)"
  else
    fail "IngressClass $INGRESS_CLASS not found, so the PitchBend Live Ingress would be ignored"
    hint "k3s creates it with its bundled Traefik (unless the server runs with --disable traefik)."
    hint "Traefik is shared with the Sudoku Solver: fix the cluster, not ingress.yaml."
  fi
fi

# -----------------------------------------------------------------------------
section "6. cert-manager and ClusterIssuer $CLUSTER_ISSUER (shared)"
shared_cm_hint() {
  hint "cert-manager and the '$CLUSTER_ISSUER' ClusterIssuer are SHARED with the Sudoku Solver."
  hint "They are normally installed by the Sudoku Solver repo's deploy/k8s/bootstrap step: run"
  hint "or repair it there. Never install cert-manager a second time or upgrade it from this repo."
}
if ! k get crd clusterissuers.cert-manager.io -o name >/dev/null 2>&1; then
  fail "cert-manager is not installed (CRD clusterissuers.cert-manager.io not found)"
  shared_cm_hint
else
  cm_pods=$(k get pods -A -l app.kubernetes.io/instance=cert-manager -o jsonpath="$POD_FMT" 2>/dev/null) || cm_pods=""
  if [[ -z "$cm_pods" ]]; then
    cm_pods=$(k get pods -n cert-manager -o jsonpath="$POD_FMT" 2>/dev/null) || cm_pods=""
  fi
  if [[ -z "$cm_pods" ]]; then
    fail "cert-manager CRDs exist but no cert-manager pods were found"
    shared_cm_hint
  elif pods_healthy "$cm_pods"; then
    pass "cert-manager is installed and its pods are Running and ready"
  else
    fail "Some cert-manager pods are not Running/ready (see above)"
    shared_cm_hint
  fi

  if ! issuer_ready=$(k get clusterissuer "$CLUSTER_ISSUER" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null); then
    fail "ClusterIssuer '$CLUSTER_ISSUER' not found"
    shared_cm_hint
  else
    acme_server=$(k get clusterissuer "$CLUSTER_ISSUER" -o jsonpath='{.spec.acme.server}' 2>/dev/null) || acme_server=""
    solver_classes=$(k get clusterissuer "$CLUSTER_ISSUER" -o jsonpath='{range .spec.acme.solvers[*]}{.http01.ingress.ingressClassName}{.http01.ingress.class}{" "}{end}' 2>/dev/null) || solver_classes=""
    info "ACME server: ${acme_server:-?}"
    info "HTTP-01 solver ingress class(es): ${solver_classes:-none set (uses the default class)}"
    if [[ "$issuer_ready" == True ]]; then
      pass "ClusterIssuer '$CLUSTER_ISSUER' exists and is Ready"
    else
      reason=$(k get clusterissuer "$CLUSTER_ISSUER" -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}' 2>/dev/null) || reason=""
      fail "ClusterIssuer '$CLUSTER_ISSUER' is not Ready (Ready=${issuer_ready:-unknown}) ${reason}"
      shared_cm_hint
    fi
    if [[ "$acme_server" == *staging* ]]; then
      warn "'$CLUSTER_ISSUER' points at the Let's Encrypt STAGING server; browsers won't trust its certificates"
    fi
  fi
fi

# -----------------------------------------------------------------------------
section "7. Default StorageClass"
if ! scs=$(k get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.provisioner}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{.metadata.annotations.storageclass\.beta\.kubernetes\.io/is-default-class}{"\n"}{end}' 2>&1); then
  fail "Could not list StorageClasses"
  info_lines "$scs"
else
  sc_defaults=""
  while IFS=$'\t' read -r name provisioner is_default; do
    [[ -n "$name" ]] || continue
    if [[ "$is_default" == true* ]]; then
      sc_defaults+=" $name"
      info "$name (provisioner $provisioner) [default]"
    else
      info "$name (provisioner $provisioner)"
    fi
  done <<<"$scs"
  n_sc_defaults=$(wc -w <<<"$sc_defaults" | tr -d ' ')
  if ((n_sc_defaults == 0)); then
    fail "No default StorageClass, so the pitchbend-live-data and uptime-kuma-data PVCs would stay Pending"
    hint "Mark one as default: storageclass.kubernetes.io/is-default-class=true"
  elif ((n_sc_defaults == 1)); then
    pass "Default StorageClass:$sc_defaults"
  else
    warn "More than one default StorageClass:$sc_defaults (Kubernetes picks the newest one)"
  fi
fi

# -----------------------------------------------------------------------------
section "8. Pod CIDR vs FORWARDED_ALLOW_IPS"
fai=$(awk '
  /name:[[:space:]]*FORWARDED_ALLOW_IPS/ { found = 1; next }
  found && /value:/ { sub(/^[^:]*value:[[:space:]]*/, ""); gsub(/["\047[:space:]]/, ""); print; exit }
' "$API_YAML" 2>/dev/null) || fai=""
info "FORWARDED_ALLOW_IPS in infra/k8s/api.yaml: ${fai:-<not found>}"
covered=0 uncovered="" no_cidr="" star=0
if [[ ",$fai," == *",*,"* ]]; then star=1; fi
while IFS=$'\t' read -r name _ cidr; do
  [[ -n "$name" ]] || continue
  info "node $name: spec.podCIDR=${cidr:-<none>}"
  if [[ -z "$cidr" ]]; then
    no_cidr+=" $name"
    continue
  fi
  if [[ "$cidr" == *:* ]] || ! is_ipv4_cidr "$cidr"; then
    info "  (not an IPv4 CIDR; compare it with FORWARDED_ALLOW_IPS by hand)"
    continue
  fi
  hit=0
  IFS=, read -r -a entries <<<"$fai"
  for entry in ${entries[@]+"${entries[@]}"}; do
    [[ "$entry" == */* ]] || entry="$entry/32"
    if is_ipv4_cidr "$entry" && cidr_contains "$entry" "$cidr"; then
      hit=1
      break
    fi
  done
  if ((hit)); then covered=$((covered + 1)); else uncovered+=" $name($cidr)"; fi
done <<<"$nodes"

if [[ -z "$fai" ]]; then
  warn "Could not read FORWARDED_ALLOW_IPS from $API_YAML"
elif ((star)); then
  warn "FORWARDED_ALLOW_IPS contains '*': any client can spoof X-Forwarded-For (CLAUDE.md §5)"
elif [[ -n "$uncovered" ]]; then
  warn "FORWARDED_ALLOW_IPS ($fai) does NOT cover:$uncovered"
  hint "Edit FORWARDED_ALLOW_IPS in infra/k8s/api.yaml to the cluster pod CIDR (k3s: --cluster-cidr),"
  hint "or uvicorn will ignore X-Forwarded-For and rate limiting will see the Ingress pod's IP."
elif ((covered > 0)) && [[ -z "$no_cidr" ]]; then
  pass "FORWARDED_ALLOW_IPS ($fai) covers every node's podCIDR"
else
  warn "Could not verify FORWARDED_ALLOW_IPS automatically${no_cidr:+ (no spec.podCIDR on:$no_cidr)}"
  hint "Some CNIs (e.g. Calico, Cilium) allocate pod IPs themselves; find the pod CIDR there."
fi
info "Reminder: FORWARDED_ALLOW_IPS in infra/k8s/api.yaml must cover the pod CIDR that the"
info "Ingress controller's pods use (use the node IP instead if the controller runs hostNetwork)."

# -----------------------------------------------------------------------------
section "9. Namespace $NAMESPACE and Secret $SECRET"
if ns_out=$(k get namespace "$NAMESPACE" -o name 2>&1); then
  info "Namespace $NAMESPACE exists"
  # Key NAMES only. The go-template never outputs values. ($k is template
  # syntax for kubectl, not a shell variable, hence the single quotes.)
  # shellcheck disable=SC2016
  if keys=$(k -n "$NAMESPACE" get secret "$SECRET" -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}' 2>&1); then
    info "Secret $SECRET keys: $(tr '\n' ' ' <<<"$keys")(values not shown)"
    if ! grep -qx DUCKDNS_TOKEN <<<"$keys"; then
      fail "Secret $SECRET has no DUCKDNS_TOKEN key (the duckdns CronJob requires it)"
    else
      pass "Secret $SECRET exists with DUCKDNS_TOKEN"
    fi
    if ! grep -qx SENTRY_DSN <<<"$keys"; then
      warn "Secret $SECRET has no SENTRY_DSN key (optional; ARCHITECTURE.md §6.2 expects it, empty is fine)"
    fi
  elif grep -q NotFound <<<"$keys"; then
    fail "Secret $SECRET does not exist in namespace $NAMESPACE"
    hint "Create it before deploying: see the commands in infra/k8s/secret.example.yaml"
    hint "(deploy.sh prints them too). Never commit it."
  else
    fail "Could not check Secret $SECRET"
    info_lines "$keys"
  fi
elif grep -q NotFound <<<"$ns_out"; then
  info "Namespace $NAMESPACE does not exist yet. deploy.sh creates it, then asks you to"
  info "create Secret $SECRET before anything else is applied."
else
  warn "Could not check namespace $NAMESPACE"
  info_lines "$ns_out"
fi

# -----------------------------------------------------------------------------
section "10. Node capacity (shared with other apps, ADR 0003)"
# The scheduler places pods by their requests, so everything must fit in the
# node's allocatable CPU and memory. PitchBend Live is counted from the rendered
# infra/k8s rather than its live pods, so the result is the same before and
# after a deploy; live pods in namespace $NAMESPACE are skipped.
cap_ok=1 alloc_cpu=0 alloc_mem=0 n_alloc=0
if ! alloc=$(k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.cpu}{"\t"}{.status.allocatable.memory}{"\n"}{end}' 2>&1); then
  fail "Could not read the nodes' allocatable capacity"
  info_lines "$alloc"
  alloc="" cap_ok=0
fi
alloc_rows=$(awk -F'\t' "$AWK_QUANTITY"'
  NF == 0 { next }
  { printf "%s\t%d\t%.0f\t%s\t%s\n", $1, cpu_m($2), mem_b($3), $2, $3 }' <<<"$alloc")
while IFS=$'\t' read -r name cpu mem raw_cpu raw_mem; do
  [[ -n "$name" ]] || continue
  if ((cpu < 0 || mem < 0)); then
    fail "Unrecognized allocatable quantity on node $name: cpu=$raw_cpu memory=$raw_mem"
    cap_ok=0
    continue
  fi
  info "node $name allocatable: ${cpu}m CPU, $(fmt_mi "$mem") memory"
  alloc_cpu=$((alloc_cpu + cpu)) alloc_mem=$((alloc_mem + mem)) n_alloc=$((n_alloc + 1))
done <<<"$alloc_rows"
if ((n_alloc > 1)); then
  info "($n_alloc nodes: capacity is summed, but every PitchBend Live pod lands on the node holding its RWO PVC)"
fi

# Requests of every other pod, per namespace. A pod's effective request is
# max(sum of its containers + native sidecars, largest init container) plus
# its RuntimeClass overhead, as the scheduler counts it. Output lines:
#   NS<TAB>namespace<TAB>pods<TAB>cpu m<TAB>memory B<TAB>memory limits B<TAB>containers without a memory limit
#   BAD<TAB>number of unrecognized quantities (counted as 0)
if ! pods_res=$(k get pods -A -o jsonpath="$POD_RES_FMT" 2>&1); then
  fail "Could not list pods"
  info_lines "$pods_res"
  pods_res="" cap_ok=0
fi
others=$(awk -F'\t' -v skip="$NAMESPACE" "$AWK_QUANTITY"'
  function q(kind, s,   v) {
    if (s == "") return 0
    v = (kind == "cpu") ? cpu_m(s) : mem_b(s)
    if (v < 0) { badq++; return 0 }
    return v
  }
  function max(a, b) { return a > b ? a : b }
  NF == 0 || $1 == skip || $3 == "Succeeded" || $3 == "Failed" { next }
  {
    cpu = 0; mem = 0; lim = 0; icpu = 0; imem = 0; ilim = 0; unl = 0
    n = split($4, cs, ";")
    for (i = 1; i <= n; i++) {
      if (cs[i] == "") continue
      split(cs[i], f, ",")
      cpu += q("cpu", f[1]); mem += q("mem", f[2])
      if (f[3] == "") unl++; else lim += q("mem", f[3])
    }
    n = split($5, cs, ";")
    for (i = 1; i <= n; i++) {
      if (cs[i] == "") continue
      split(cs[i], f, ",")
      if (f[4] == "Always") {
        cpu += q("cpu", f[1]); mem += q("mem", f[2])
        if (f[3] == "") unl++; else lim += q("mem", f[3])
      } else {
        icpu = max(icpu, q("cpu", f[1])); imem = max(imem, q("mem", f[2]))
        if (f[3] != "") ilim = max(ilim, q("mem", f[3]))
      }
    }
    split($6, f, ",")
    ns = $1; pods[ns]++; nunl[ns] += unl
    ncpu[ns] += max(cpu, icpu) + q("cpu", f[1])
    nmem[ns] += max(mem, imem) + q("mem", f[2])
    nlim[ns] += max(lim, ilim) + q("mem", f[2])
  }
  END {
    for (ns in pods) printf "NS\t%s\t%d\t%d\t%.0f\t%.0f\t%d\n", ns, pods[ns], ncpu[ns], nmem[ns], nlim[ns], nunl[ns]
    printf "BAD\t%d\n", badq
  }' <<<"$pods_res" | sort)

# One table row: label, count, CPU m, memory B, memory limits B, [note].
cap_row() {
  info "$(printf '  %-20s %8s  CPU %6s  memory %7s  memory limits %7s%s' \
    "$1" "$2" "${3}m" "$(fmt_mi "$4")" "$(fmt_mi "$5")" "${6:-}")"
}

info "Requests by namespace (Succeeded/Failed pods skipped):"
other_cpu=0 other_mem=0 other_lim=0 pod_namespaces=""
while IFS=$'\t' read -r tag ns npods cpu mem lim unl; do
  case "$tag" in
    NS)
      note=""
      if ((unl > 0)); then note=" (+$unl container(s) without a limit)"; fi
      cap_row "$ns" "$npods pod(s)" "$cpu" "$mem" "$lim" "$note"
      other_cpu=$((other_cpu + cpu)) other_mem=$((other_mem + mem)) other_lim=$((other_lim + lim))
      pod_namespaces+=" $ns "
      ;;
    BAD)
      if ((ns > 0)); then warn "$ns unrecognized resource quantities in other pods were counted as 0"; fi
      ;;
    *) ;;
  esac
done <<<"$others"

# PitchBend Live's long-running containers (x replicas; init containers and the
# duckdns CronJob are transient), exactly as validate-manifests.sh counts them.
if measure_pitchbend_live; then
  ks=$(awk -F'\t' "$AWK_QUANTITY"'
    NF == 0 { next }
    $3 == "main" && $1 != "Job" && $1 != "CronJob" {
      r = $5 + 0; n += r
      c = ($6 == "-") ? 0 : cpu_m($6); m = ($7 == "-") ? 0 : mem_b($7); l = ($9 == "-") ? 0 : mem_b($9)
      if (c < 0 || m < 0 || l < 0) bad++
      cpu += c * r; mem += m * r; lim += l * r
    }
    END { printf "%d\t%.0f\t%.0f\t%d\t%d\n", cpu, mem, lim, n, bad }' <<<"$ks_rows")
  IFS=$'\t' read -r ks_cpu ks_mem ks_lim ks_n ks_bad <<<"$ks"
  if ((ks_n == 0 || ks_bad > 0)); then
    ks_how="the render had no containers or unrecognized quantities (run validate-manifests.sh)"
    ks_n=0
  fi
else
  ks_n=0
fi
if ((ks_n > 0)); then
  cap_row "$NAMESPACE (rendered)" "$ks_n ctr(s)" "$ks_cpu" "$ks_mem" "$ks_lim"
  info "  ($NAMESPACE measured from infra/k8s via $ks_how)"
else
  ks_cpu=$BUDGET_CPU_REQUESTS_M
  ks_mem=$((BUDGET_MEMORY_REQUESTS_MI * 1048576)) ks_lim=$((BUDGET_MEMORY_LIMITS_MI * 1048576))
  cap_row "$NAMESPACE (budget)" "ADR 0003" "$ks_cpu" "$ks_mem" "$ks_lim"
  warn "Could not measure PitchBend Live's requests from the render: $ks_how"
  hint "Counted PitchBend Live at its ADR 0003 ceilings instead (an upper bound; CI enforces them)."
fi

if ((cap_ok && n_alloc > 0)); then
  used_cpu=$((other_cpu + ks_cpu)) used_mem=$((other_mem + ks_mem)) used_lim=$((other_lim + ks_lim))
  head_cpu=$((alloc_cpu - used_cpu)) head_mem=$((alloc_mem - used_mem))
  info "Total requests: CPU ${used_cpu}m of ${alloc_cpu}m (headroom ${head_cpu}m),"
  info "                memory $(fmt_mi "$used_mem") of $(fmt_mi "$alloc_mem") (headroom $(fmt_mi "$head_mem"))"
  over=""
  if ((head_cpu < 0)); then over+=" CPU"; fi
  if ((head_mem < 0)); then over+=" memory"; fi
  if [[ -n "$over" ]]; then
    fail "Requests exceed the node's allocatable$over: pods would stay Pending"
    hint "Shrink requests or resize the VM (free up to 4 OCPU / 24 GB); both need an ADR (ARCHITECTURE.md §3.6)."
  else
    pass "Other namespaces' requests plus PitchBend Live's fit in the node's allocatable CPU and memory"
  fi
  if ((head_cpu >= 0 && head_cpu < MIN_CPU_HEADROOM_M)); then
    warn "CPU headroom ${head_cpu}m is below ${MIN_CPU_HEADROOM_M}m"
    hint "Sudoku's api Deployment uses RollingUpdate and needs 200m of surge room, or its rollouts hang Pending."
  fi
  if ((head_mem >= 0 && head_mem < MIN_MEMORY_HEADROOM_MI * 1048576)); then
    warn "Memory headroom $(fmt_mi "$head_mem") is below ${MIN_MEMORY_HEADROOM_MI}Mi"
    hint "Rollout surges, cert-manager's HTTP-01 solver pods and CronJobs need room to schedule."
  fi
  if ((used_lim > alloc_mem)); then
    warn "Memory limits of all pods plus PitchBend Live ($(fmt_mi "$used_lim")) exceed allocatable memory ($(fmt_mi "$alloc_mem"))"
    hint "Informational: fine while pods stay near their requests, but if several burst at once"
    hint "the node runs out of memory and the kernel OOM-kills containers."
  else
    info "Memory limits of all pods plus PitchBend Live: $(fmt_mi "$used_lim") of $(fmt_mi "$alloc_mem") allocatable"
  fi
fi

# Other apps on this node: anything that isn't Kubernetes/k3s, cert-manager or
# PitchBend Live (and "default" only if it has pods).
if all_ns=$(k get namespaces -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); then
  apps=""
  while IFS= read -r ns; do
    case "$ns" in
      "" | kube-* | cert-manager | "$NAMESPACE") continue ;;
      default) [[ "$pod_namespaces" == *" default "* ]] || continue ;;
      *) ;;
    esac
    apps+=" $ns"
  done <<<"$all_ns"
  if [[ -n "$apps" ]]; then
    info "Shares the node with:$apps"
  else
    info "No other app namespaces found"
  fi
fi

summary
