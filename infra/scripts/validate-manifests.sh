#!/usr/bin/env bash
# Render infra/k8s and validate it offline in pinned containers. Never contacts a
# cluster (no kubeconfig is mounted). Used by CI's `manifests` job and runnable
# locally with only Docker:
#
#   infra/scripts/validate-manifests.sh
#
# Checks: kustomize render, kubeconform -strict, KeyShift guardrails (CLAUDE.md):
# no Secret, pinned image tags, SQLite single writer, Ingress settings, namespace
# scoping, Ingress class, the ADR 0003 resource budget, and isolation of the
# cluster-wide infra/k8s-bootstrap. Then shellcheck on infra/scripts/*.sh.
# Needs: bash 3.2+ (the macOS default works), Docker, awk and grep.
set -euo pipefail

KUBECTL_IMAGE="registry.k8s.io/kubectl:v1.36.1"       # bundles kustomize v5.8.1
KUBECONFORM_IMAGE="ghcr.io/yannh/kubeconform:v0.8.0"
SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0"
YQ_IMAGE="mikefarah/yq:4.53.6"                         # MIT; linux/arm64 build verified

# KeyShift's resource budget on the shared 1 OCPU / 6 GB node. Source of truth:
# docs/adr/0003-shared-cluster-with-sudoku-solver.md (and ARCHITECTURE.md §3.6).
# Raising any ceiling needs a new ADR. The totals count long-running containers
# (Deployment/StatefulSet/ReplicaSet containers x replicas; DaemonSet/Pod x 1).
# initContainers and Job/CronJob containers are transient and not counted, but
# they still must set requests and limits, and the per-container ceiling applies.
BUDGET_CPU_REQUESTS="200m"                  # total CPU requests
BUDGET_MEMORY_REQUESTS="640Mi"              # total memory requests
BUDGET_MEMORY_LIMITS="3Gi"                  # total memory limits
BUDGET_MAX_CONTAINER_MEMORY_LIMIT="2Gi"     # memory limit of any single container

NAMESPACE="keyshift"        # the only namespace KeyShift may touch (ADR 0003)
INGRESS_CLASS="traefik"     # k3s's bundled Traefik, shared with the Sudoku Solver

# Kinds KeyShift must never create: cluster-scoped objects, and objects that
# configure components shared by every app on the cluster (k3s HelmChart/
# HelmChartConfig reconfigure Traefik and friends). Anything whose kind starts
# with "Cluster", and anything in CLUSTER_API_GROUPS, is rejected as well.
# A Namespace other than $NAMESPACE is rejected separately.
CLUSTER_SCOPED_KINDS="ClusterRole ClusterRoleBinding ClusterIssuer IngressClass
StorageClass PersistentVolume CustomResourceDefinition PriorityClass
ValidatingWebhookConfiguration MutatingWebhookConfiguration
ValidatingAdmissionPolicy ValidatingAdmissionPolicyBinding MutatingAdmissionPolicy
MutatingAdmissionPolicyBinding APIService RuntimeClass CSIDriver CSINode
VolumeAttachment VolumeAttributesClass Node CertificateSigningRequest FlowSchema
PriorityLevelConfiguration IPAddress ServiceCIDR DeviceClass ResourceSlice
HelmChart HelmChartConfig Addon"
CLUSTER_API_GROUPS="apiextensions.k8s.io admissionregistration.k8s.io
apiregistration.k8s.io scheduling.k8s.io node.k8s.io flowcontrol.apiserver.k8s.io
helm.cattle.io k3s.cattle.io"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bootstrap_rel="infra/k8s-bootstrap/traefik-config.yaml"
kustomization_rel="infra/k8s/kustomization.yaml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rendered="$tmp/rendered.yaml"
failures=0

fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
pass() { echo "  PASS: $*"; }
note() { echo "        $*"; }

# yq reads YAML on stdin; no files or kubeconfig are mounted. -q keeps the
# first pull's progress out of captured output.
yq_run() { docker run --rm -i -q "$YQ_IMAGE" "$@"; }

# The awk checkers below print "PASS|FAIL|INFO<TAB>message" lines; this turns
# them into the same output (and failure count) as the checks above.
report() {
  local status msg
  while IFS=$'\t' read -r status msg; do
    case "$status" in
      PASS) pass "$msg" ;;
      FAIL) fail "$msg" ;;
      INFO) note "$msg" ;;
      "") ;;
      *) fail "unexpected checker output: $status $msg" ;;
    esac
  done <<<"$1"
}

# Kubernetes quantity parsing for awk (POSIX awk; tested with macOS awk, busybox, mawk, gawk).
# cpu_m: "250m" | "1" | "0.5" -> millicores. mem_b: Ki/Mi/Gi/Ti, k/K/M/G/T or
# plain bytes -> bytes. Both return -1 for anything else. mi/cpu format them.
# Keep in sync with the copy in check-cluster.sh.
AWK_QUANTITY='
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
function mi(b) {
  if (b > 0 && b % 1073741824 == 0) return sprintf("%dGi", b / 1073741824)
  if (b % 1048576 == 0) return sprintf("%dMi", b / 1048576)
  return sprintf("%.1fMi", b / 1048576)
}
function cpu(m) { return sprintf("%dm", m) }
'

echo "==> Bootstrap isolation ($bootstrap_rel)"
# The cluster-wide Traefik HelmChartConfig is applied by hand, once, with sign-off
# (ADR 0003). It must stay exactly that object and out of the deploy.sh render.
# Checked before rendering: a reference to it from infra/k8s breaks the render
# (only infra/k8s is mounted), and this names the actual problem first.
bootstrap="$repo_root/$bootstrap_rel"
if [ ! -f "$bootstrap" ]; then
  fail "$bootstrap_rel is missing"
elif ! n_docs="$(yq_run ea '[.] | map(select(. != null)) | length' <"$bootstrap" 2>&1)"; then
  fail "$bootstrap_rel does not parse: $n_docs"
elif ! boot_id="$(yq_run 'select(. != null) | [.apiVersion, .kind, .metadata.name, (.metadata.namespace // "-")] | @tsv' <"$bootstrap" | awk 'NF > 0')"; then
  fail "$bootstrap_rel: yq could not read it"
elif [ "$n_docs" != 1 ]; then
  fail "$bootstrap_rel must contain exactly one object, found $n_docs"
elif [ "$boot_id" != "$(printf 'helm.cattle.io/v1\tHelmChartConfig\ttraefik\tkube-system')" ]; then
  fail "$bootstrap_rel must be HelmChartConfig traefik in kube-system (helm.cattle.io/v1), found: $(tr '\t' ' ' <<<"$boot_id")"
elif ! values_err="$(yq_run '.spec.valuesContent | from_yaml' <"$bootstrap" 2>&1 >/dev/null)"; then
  fail "$bootstrap_rel: spec.valuesContent is not valid YAML: $values_err"
else
  pass "$bootstrap_rel parses and is exactly one HelmChartConfig kube-system/traefik"
fi

# Comments are stripped first so a note that mentions the directory is fine.
if ! kustomization="$(yq_run '... comments=""' <"$repo_root/$kustomization_rel")"; then
  fail "yq could not read $kustomization_rel"
elif grep -q 'k8s-bootstrap' <<<"$kustomization"; then
  fail "$kustomization_rel references k8s-bootstrap: deploy.sh would apply cluster-wide Traefik config"
else
  pass "$kustomization_rel does not reference k8s-bootstrap"
fi

echo "==> Render infra/k8s (kubectl kustomize, offline)"
docker run --rm -v "$repo_root/infra/k8s:/k8s:ro" "$KUBECTL_IMAGE" kustomize /k8s >"$rendered"
pass "$(grep -c '^kind:' "$rendered") objects rendered"

echo "==> kubeconform -strict"
docker run --rm -i "$KUBECONFORM_IMAGE" -strict -summary <"$rendered"

echo "==> Guardrails"
if grep -q '^kind: Secret' "$rendered"; then
  fail "render contains a Secret (secret.example.yaml must not be in kustomization.yaml)"
else
  pass "no Secret in the render"
fi

if grep -E '^[[:space:]]*(- )?image:' "$rendered" | grep -qE ':latest[[:space:]]*$'; then
  fail "an image uses :latest"
else
  pass "no image uses :latest"
fi

untagged="$(grep -E '^[[:space:]]*(- )?image:' "$rendered" | sed -E 's/.*image:[[:space:]]*//' | grep -vE ':[A-Za-z0-9._-]+$' || true)"
if [ -n "$untagged" ]; then
  fail "untagged image(s): $untagged"
else
  pass "every image has an explicit tag"
fi

# SQLite has exactly one writer set: api and worker must be 1 replica + Recreate.
for name in api worker; do
  doc="$(awk -v want="$name" '
    /^---/ { if (isdep && found) print buf; buf=""; isdep=0; found=0; next }
    { buf = buf $0 "\n" }
    /^kind: Deployment$/ { isdep=1 }
    $0 ~ "^  name: " want "$" { found=1 }
    END { if (isdep && found) print buf }
  ' "$rendered")"
  if [ -z "$doc" ]; then
    fail "Deployment $name not found"
  elif grep -qE '^  replicas: 1$' <<<"$doc" && grep -qE '^    type: Recreate$' <<<"$doc"; then
    pass "Deployment $name is replicas: 1 with strategy Recreate"
  else
    fail "Deployment $name must be replicas: 1 with strategy: Recreate (SQLite single writer)"
  fi
done

if grep -q 'proxy-buffering: "off"' "$rendered" && grep -q 'proxy-body-size: 55m' "$rendered"; then
  pass "Ingress keeps buffering off and a 55m body limit (ingress-nginx annotations, kept for portability)"
else
  fail "Ingress lost proxy-buffering off / proxy-body-size 55m (SSE freezes or uploads 413)"
fi

# The cluster runs Traefik (ADR 0003): it streams SSE only while no Buffering
# middleware is attached. Any router middleware on this Ingress needs review.
if grep -qE 'traefik\.ingress\.kubernetes\.io/router\.middlewares' "$rendered"; then
  fail "Ingress attaches Traefik router middlewares; a Buffering middleware silently freezes SSE and caps uploads (review, then update this check)"
else
  pass "Ingress attaches no Traefik middlewares (SSE streams unbuffered)"
fi

echo "==> Namespace scoping (ADR 0003: only namespace $NAMESPACE is ours)"
# One line per rendered object: kind, apiVersion, name, namespace ("-" if unset).
if ! objects="$(yq_run '[.kind, .apiVersion, .metadata.name, (.metadata.namespace // "-")] | @tsv' <"$rendered")"; then
  fail "yq could not read the render"
else
  report "$(awk -v want="$NAMESPACE" -v kinds="$(tr -s "[:space:]" " " <<<"$CLUSTER_SCOPED_KINDS")" \
    -v groups="$(tr -s "[:space:]" " " <<<"$CLUSTER_API_GROUPS")" '
    BEGIN {
      FS = "\t"
      n = split(kinds, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") deny_kind[a[i]] = 1
      n = split(groups, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") deny_group[a[i]] = 1
    }
    NF == 0 { next }
    {
      kind = $1; api = $2; name = $3; ns = $4; objs++
      group = (index(api, "/") > 0) ? substr(api, 1, index(api, "/") - 1) : ""
      if (kind == "Namespace") {
        if (name != want) { print "FAIL\tNamespace " name ": the only Namespace allowed is " want; bad++ }
        next
      }
      if ((kind in deny_kind) || kind ~ /^Cluster/ || (group in deny_group)) {
        print "FAIL\t" kind "/" name " (" api ") is cluster-scoped or shared-cluster config; deploy.sh must never apply it"
        bad++
        next
      }
      if (ns == "-") { print "FAIL\t" kind "/" name " has no metadata.namespace (cluster-scoped kind?)"; bad++ }
      else if (ns != want) { print "FAIL\t" kind "/" name " is in namespace " ns ", not " want; bad++ }
    }
    END {
      if (objs == 0) print "FAIL\tno objects found in the render"
      else if (!bad) print "PASS\tall " objs " objects are in namespace " want " (or are that Namespace); no cluster-scoped kinds"
    }' <<<"$objects")"
fi

echo "==> Ingress class"
if ! ingresses="$(yq_run 'select(.kind == "Ingress") | [.metadata.name, (.spec.ingressClassName // "-")] | @tsv' <"$rendered")"; then
  fail "yq could not read the render"
else
  report "$(awk -v want="$INGRESS_CLASS" '
    BEGIN { FS = "\t" }
    NF == 0 { next }
    { n++ }
    $2 == want { print "PASS\tIngress " $1 " has spec.ingressClassName: " want; next }
    $2 == "-"  { print "FAIL\tIngress " $1 " sets no spec.ingressClassName (must be " want ", ADR 0003)"; next }
    { print "FAIL\tIngress " $1 " has spec.ingressClassName: " $2 " (must be " want ", ADR 0003)" }
    END { if (n == 0) print "FAIL\tno Ingress found in the render" }' <<<"$ingresses")"
fi

echo "==> Resource budget (ADR 0003)"
# One line per container: kind, workload, init|main, container, replicas,
# requests.cpu, requests.memory, limits.cpu, limits.memory ("-" if unset).
# Keep in sync with the copy in check-cluster.sh.
# shellcheck disable=SC2016 # $kind, $name, ... are yq variables, not shell ones
CONTAINER_ROWS='select(.kind == "Deployment" or .kind == "StatefulSet" or .kind == "ReplicaSet" or .kind == "DaemonSet" or .kind == "Pod" or .kind == "Job" or .kind == "CronJob")
  | .kind as $kind | .metadata.name as $name | (.spec.replicas // 1) as $replicas
  | (.spec.jobTemplate.spec.template.spec // .spec.template.spec // .spec) as $pod
  | ((($pod.initContainers // [])[] | {"type": "init", "c": .}), (($pod.containers // [])[] | {"type": "main", "c": .}))
  | [$kind, $name, .type, .c.name, $replicas,
     (.c.resources.requests.cpu // "-"), (.c.resources.requests.memory // "-"),
     (.c.resources.limits.cpu // "-"), (.c.resources.limits.memory // "-")]
  | @tsv'
if ! containers="$(yq_run "$CONTAINER_ROWS" <"$rendered")"; then
  fail "yq could not read the render"
else
  report "$(awk -v max_cpu_req="$BUDGET_CPU_REQUESTS" -v max_mem_req="$BUDGET_MEMORY_REQUESTS" \
    -v max_mem_lim="$BUDGET_MEMORY_LIMITS" -v max_one_lim="$BUDGET_MAX_CONTAINER_MEMORY_LIMIT" "$AWK_QUANTITY"'
    function qty(kind, q, id, field,   v) {
      if (q == "-") return 0
      v = (kind == "cpu") ? cpu_m(q) : mem_b(q)
      if (v < 0) { print "FAIL\t" id ": unrecognized " field " quantity \"" q "\""; badq++; return 0 }
      return v
    }
    BEGIN {
      FS = "\t"
      c_req = cpu_m(max_cpu_req); m_req = mem_b(max_mem_req); m_lim = mem_b(max_mem_lim); one_lim = mem_b(max_one_lim)
      if (c_req < 0 || m_req < 0 || m_lim < 0 || one_lim < 0) { print "FAIL\tinvalid BUDGET_* value in validate-manifests.sh"; broken = 1; exit }
    }
    NF == 0 { next }
    {
      n++
      id = $1 "/" $2 " " ($3 == "init" ? "initContainer" : "container") " " $4
      missing = ""
      if ($6 == "-") missing = missing " requests.cpu"
      if ($7 == "-") missing = missing " requests.memory"
      if ($8 == "-") missing = missing " limits.cpu"
      if ($9 == "-") missing = missing " limits.memory"
      if (missing != "") { print "FAIL\t" id " does not set" missing; incomplete++ }
      rc = qty("cpu", $6, id, "requests.cpu"); rm = qty("mem", $7, id, "requests.memory")
      lc = qty("cpu", $8, id, "limits.cpu");   lm = qty("mem", $9, id, "limits.memory")
      if (lm > one_lim) { print "FAIL\t" id " memory limit " mi(lm) " exceeds the per-container ceiling " mi(one_lim); big++ }
      if (lm > biggest) { biggest = lm; biggest_id = id }
      if ($3 == "main" && $1 != "Job" && $1 != "CronJob") {
        r = $5 + 0; long_running += r
        t_rc += rc * r; t_rm += rm * r; t_lc += lc * r; t_lm += lm * r
      }
    }
    END {
      if (broken) exit
      if (n == 0) { print "FAIL\tno containers found in the render"; exit }
      if (!incomplete && !badq) print "PASS\tall " n " containers (incl. init and CronJob) set cpu+memory requests and limits"
      print "INFO\t" long_running " long-running containers (x replicas; init and CronJob excluded):"
      print "INFO\t  requests: CPU " cpu(t_rc) ", memory " mi(t_rm) "   limits: CPU " cpu(t_lc) ", memory " mi(t_lm)
      if (t_rc <= c_req) print "PASS\ttotal CPU requests " cpu(t_rc) " <= " cpu(c_req)
      else print "FAIL\ttotal CPU requests " cpu(t_rc) " exceed the ADR 0003 budget of " cpu(c_req)
      if (t_rm <= m_req) print "PASS\ttotal memory requests " mi(t_rm) " <= " mi(m_req)
      else print "FAIL\ttotal memory requests " mi(t_rm) " exceed the ADR 0003 budget of " mi(m_req)
      if (t_lm <= m_lim) print "PASS\ttotal memory limits " mi(t_lm) " <= " mi(m_lim)
      else print "FAIL\ttotal memory limits " mi(t_lm) " exceed the ADR 0003 budget of " mi(m_lim)
      if (!big) print "PASS\tno container memory limit exceeds " mi(one_lim) " (largest: " mi(biggest) ", " biggest_id ")"
    }' <<<"$containers")"
fi

echo "==> Shared contract fixtures"
# The YouTube URL table is run against both the server and browser parsers; each
# app's test suite loads its own copy (Docker build contexts can't share files).
url_api="$repo_root/apps/api/tests/fixtures/youtube_urls.json"
url_web="$repo_root/apps/web/src/lib/fixtures/youtube_urls.json"
if cmp -s "$url_api" "$url_web"; then
  pass "YouTube URL contract table is identical in apps/api and apps/web"
else
  fail "apps/api/tests/fixtures/youtube_urls.json and apps/web/src/lib/fixtures/youtube_urls.json differ; edit both"
fi

echo "==> shellcheck infra/scripts/*.sh"
scripts=()
while IFS= read -r f; do scripts+=("$f"); done < <(cd "$repo_root" && ls infra/scripts/*.sh)
docker run --rm -v "$repo_root:/mnt:ro" -w /mnt "$SHELLCHECK_IMAGE" "${scripts[@]}"
pass "shellcheck clean (${#scripts[@]} scripts)"

echo
if [ "$failures" -gt 0 ]; then
  echo "FAILED: $failures check(s)"
  exit 1
fi
echo "All manifest checks passed."
