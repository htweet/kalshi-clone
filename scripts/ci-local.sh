#!/usr/bin/env bash
# Local CI (owner decision 2026-11-12, PLAN ground rule 7): the checks of .github/workflows/ci.yml, run on a developer
# machine instead of GitHub Actions, before `main` is moved. Same commands and the same gates:
#   test    npm ci · npm audit (high / critical) · lint · secret scan of tracked files · build · performance budgets ·
#           the full end-to-end suite
#   image   docker build · Trivy (fail on fixable high / critical) · CycloneDX SBOM · container smoke · load smoke
#   secrets gitleaks over the whole history
#   zap     OWASP ZAP baseline against a fresh server, gated by scripts/zap-gate.js and .zap/rules.tsv
# CodeQL has no local equivalent here; the lead's security review of each change stands in for it (PLAN ground rule 7).
#
# Usage: scripts/ci-local.sh [--skip-e2e] [--skip-docker] [--no-install]
#   Docker stages need a running Docker daemon; without one they are reported as NOT RUN and the result is "incomplete".
#   Behind an intercepting proxy set CI_LOCAL_CA to its CA bundle (default: /root/.ccr/ca-bundle.crt when present):
#   builds then use the host network, the proxy variables and the bundle as a build secret (never stored in the image).
# Reports go to $CI_LOCAL_OUT (default: a new temporary folder). Exit status: 0 only when every stage ran and passed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/clone"
OUT="${CI_LOCAL_OUT:-$(mktemp -d -t parlance-ci-local-XXXXXX)}"
mkdir -p "$OUT"
SKIP_E2E=0; SKIP_DOCKER=0; INSTALL=1
for a in "$@"; do
  case "$a" in
    --skip-e2e) SKIP_E2E=1 ;;
    --skip-docker) SKIP_DOCKER=1 ;;
    --no-install) INSTALL=0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done
TRIVY_IMAGE="aquasec/trivy:0.65.0@sha256:a22415a38938a56c379387a8163fcb0ce38b10ace73e593475d3658d578b2436"
GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-ghcr.io/gitleaks/gitleaks:v8.30.1}" # the version CI pins (GITLEAKS_VERSION)
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
ZAP_PORT="${ZAP_PORT:-3998}"
CA="${CI_LOCAL_CA:-}"
if [ -z "$CA" ] && [ -s /root/.ccr/ca-bundle.crt ]; then CA=/root/.ccr/ca-bundle.crt; fi

declare -a NAMES=(); declare -a RESULTS=()
record() { NAMES+=("$1"); RESULTS+=("$2"); printf '\n=== %-55s %s\n' "$1" "$2"; }
stage() { # stage "name" command...
  local name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@" > "$OUT/$(echo "$name" | tr ' /' '__').log" 2>&1; then record "$name" PASS; else record "$name" FAIL; tail -40 "$OUT/$(echo "$name" | tr ' /' '__').log"; fi
}

cd "$APP" || exit 2
export SKIP_GIT_HOOKS=1
# ---------------------------------------------------------------- test job
if [ "$INSTALL" = 1 ]; then stage "npm ci" npm ci; fi
stage "npm audit (high and critical)" npm audit --audit-level=high
stage "lint" npm run lint
stage "secret scan (tracked files)" node ../scripts/secret-scan.js --all
stage "build" npm run build
stage "performance budgets" npm run perf:budget
if [ "$SKIP_E2E" = 0 ]; then
  if pgrep -f 'node --no-warnings --test' > /dev/null; then record "end-to-end suite" "NOT RUN (another suite is running)"; else
    stage "end-to-end suite" npm run test:e2e
    grep -E '^# (tests|pass|fail)' "$OUT/end-to-end_suite.log" || true
  fi
else record "end-to-end suite" "NOT RUN (--skip-e2e)"; fi

# ---------------------------------------------------------------- docker jobs
docker_ok=0
if [ "$SKIP_DOCKER" = 0 ] && docker version > /dev/null 2>&1; then docker_ok=1; fi
if [ "$docker_ok" = 1 ]; then
  build_args=()
  run_net=()
  if [ -n "$CA" ]; then
    build_args+=(--network host --secret "id=ca,src=$CA")
    for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do [ -n "${!v:-}" ] && build_args+=(--build-arg "$v=${!v}"); done
    run_net=(-e "HTTPS_PROXY=${HTTPS_PROXY:-}" -e "HTTP_PROXY=${HTTP_PROXY:-}" -e "NO_PROXY=${NO_PROXY:-}" -e SSL_CERT_FILE=/ca.crt -v "$CA:/ca.crt:ro" --network host)
  fi
  stage "image: docker build" env DOCKER_BUILDKIT=1 docker build "${build_args[@]}" -t parlance:ci-local "$ROOT"
  stage "image: Trivy (fixable high / critical)" docker run --rm "${run_net[@]}" -v /var/run/docker.sock:/var/run/docker.sock -v "$OUT:/out" "$TRIVY_IMAGE" image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed --format table parlance:ci-local
  stage "image: CycloneDX SBOM" docker run --rm "${run_net[@]}" -v /var/run/docker.sock:/var/run/docker.sock -v "$OUT:/out" "$TRIVY_IMAGE" image --format cyclonedx --output /out/sbom.cdx.json parlance:ci-local
  stage "image: container smoke" node --no-warnings scripts/container-smoke.js parlance:ci-local
  stage "image: load smoke" node --no-warnings scripts/load.js --profile smoke --report "$OUT/load-smoke.json"
  # The repository and its git directory are mounted at their own paths (a worktree's history lives in the main checkout).
  GIT_COMMON="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  stage "secrets: gitleaks (full history)" docker run --rm "${run_net[@]}" -v "$ROOT:$ROOT:ro" -v "$GIT_COMMON:$GIT_COMMON:ro" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' "$GITLEAKS_IMAGE" git "$ROOT" --config "$ROOT/.gitleaks.toml" --redact --no-banner --exit-code 1
  # ZAP baseline against a fresh server (sports simulation off), gated by the reviewed rules file.
  zap() {
    local db; db="$(mktemp -d)/zap.db"
    PORT="$ZAP_PORT" SPORTS=0 DB_FILE="$db" node --no-warnings server/index.js > "$OUT/zap-server.log" 2>&1 &
    local pid=$!
    for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://localhost:$ZAP_PORT/v1/session" && break; sleep 1; done
    cp "$ROOT/.zap/rules.tsv" "$OUT/rules.tsv"
    chmod 777 "$OUT"
    docker run --rm --network host -v "$OUT:/zap/wrk:rw" "$ZAP_IMAGE" zap-baseline.py -t "http://localhost:$ZAP_PORT" -c rules.tsv -J report_json.json -a -j -m 3 -I
    kill "$pid" 2> /dev/null; wait "$pid" 2> /dev/null
    (cd "$ROOT" && node scripts/zap-gate.js "$OUT/report_json.json" .zap/rules.tsv)
  }
  stage "zap: baseline scan + gate" zap
else
  for n in "image: docker build" "image: Trivy (fixable high / critical)" "image: CycloneDX SBOM" "image: container smoke" "image: load smoke" "secrets: gitleaks (full history)" "zap: baseline scan + gate"; do
    record "$n" "NOT RUN (no Docker daemon)"
  done
fi
record "CodeQL" "NOT RUN (no local equivalent; security review instead)"

# ---------------------------------------------------------------- summary
echo; echo "Local CI summary ($(git -C "$ROOT" rev-parse --short HEAD), reports in $OUT)"
fail=0; incomplete=0
for i in "${!NAMES[@]}"; do
  printf '  %-45s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
  case "${RESULTS[$i]}" in FAIL) fail=1 ;; NOT\ RUN*) [ "${NAMES[$i]}" != "CodeQL" ] && incomplete=1 ;; esac
done
if [ "$fail" = 1 ]; then echo "RESULT: FAILED"; exit 1; fi
if [ "$incomplete" = 1 ]; then echo "RESULT: INCOMPLETE (some stages did not run)"; exit 3; fi
echo "RESULT: PASSED"; exit 0
