#!/usr/bin/env bash
# Run the API and worker against the local staging stack.
#
# Exists for two reasons: the environment is eleven variables that are easy to get
# subtly wrong, and Alloy ships logs by tailing files (in production it tails
# Docker json-file logs instead, which needs no cooperation from the app). Output
# is tee'd so it is both on your terminal and in Loki.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/infra/docker/staging/monitoring/logs"
mkdir -p "$LOGS"

# The services connect as the least-privilege app role (P1b), never as the schema
# owner. Running them as the owner would mean the local stack has privileges
# production does not, which is how a missing grant reaches production first.
APP_ROLE_ENV="$ROOT/infra/docker/staging/app-role.env"
if [ -z "${CB_CONTROL_DATABASE_URL:-}" ]; then
  if [ -f "$APP_ROLE_ENV" ]; then
    # shellcheck disable=SC1090
    . "$APP_ROLE_ENV"
    export CB_CONTROL_DATABASE_URL="postgres://corebase_app:${CB_APP_DB_PASSWORD}@127.0.0.1:55433/corebase_control"
  else
    echo "✗ no app-role credentials — run ./scripts/staging.sh app-role" >&2
    echo "  (or set CB_CONTROL_DATABASE_URL yourself to override)" >&2
    exit 1
  fi
fi
export CB_REDIS_URL="${CB_REDIS_URL:-redis://127.0.0.1:56379}"
export CB_DOCKER_HOST="${CB_DOCKER_HOST:-127.0.0.1}"
export CB_DOCKER_PORT="${CB_DOCKER_PORT:-2376}"
export CB_DOCKER_CERT_DIR="${CB_DOCKER_CERT_DIR:-$ROOT/infra/docker/staging/certs}"
export CB_KEK_DIR="${CB_KEK_DIR:-$ROOT/infra/docker/staging/kek.d}"
export CB_BOOTSTRAP_SECRET="${CB_BOOTSTRAP_SECRET:-local-bootstrap-secret-0123456789}"
export CB_PROJECT_DOMAIN="${CB_PROJECT_DOMAIN:-localhost}"
export CB_PG_PORT_MIN="${CB_PG_PORT_MIN:-5433}"
export CB_PG_PORT_MAX="${CB_PG_PORT_MAX:-5462}"
export CB_NODE_RAM_MB="${CB_NODE_RAM_MB:-16384}"
export CB_NODE_HOSTNAME="${CB_NODE_HOSTNAME:-data-1}"
export CB_STATIC_TOKEN="${CB_STATIC_TOKEN:-dev-token}"
export PORT="${PORT:-8099}"
export CB_METRICS_PORT="${CB_METRICS_PORT:-9101}"
# Local dev is plain HTTP, and a Secure cookie is never sent over http:// —
# the failure looks like "login silently does nothing".
export CB_SECURE_COOKIES="${CB_SECURE_COOKIES:-false}"
# The dashboard runs on its own origin, so every call it makes is cross-origin
# and carries the session cookie. Set explicitly here rather than defaulted in
# the service — see services/api/src/kernel/cors.ts.
export CB_DASHBOARD_ORIGINS="${CB_DASHBOARD_ORIGINS:-http://localhost:3000,http://127.0.0.1:3000}"
export CB_RECONCILE_INTERVAL_MS="${CB_RECONCILE_INTERVAL_MS:-30000}"
# The purge scan defaults to an hour, which is right in production and wrong for a
# dev loop: `demo.sh --purge` expires the recovery window and then waits for this
# scan, so an hour makes the flag look broken. Fifteen seconds here.
export CB_PURGE_SCAN_MS="${CB_PURGE_SCAN_MS:-15000}"

if [ ! -d "$CB_KEK_DIR" ] || ! ls "$CB_KEK_DIR"/*.key >/dev/null 2>&1; then
  echo "✗ no master key in $CB_KEK_DIR — run ./scripts/staging.sh kek" >&2
  exit 1
fi

pids=()
cleanup() { echo; echo "▸ stopping"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "▸ api      http://127.0.0.1:$PORT      (bearer $CB_STATIC_TOKEN)"
( cd "$ROOT/services/api" && exec node --experimental-strip-types src/main.ts ) \
  | tee -a "$LOGS/api.log" & pids+=($!)

echo "▸ worker   metrics on :$CB_METRICS_PORT"
( cd "$ROOT/services/worker" && exec node --experimental-strip-types src/main.ts ) \
  | tee -a "$LOGS/worker.log" & pids+=($!)

echo "▸ grafana  http://127.0.0.1:${GRAFANA_PORT:-3001}/d/corebase-provisioning"
echo "▸ logs     $LOGS  (tailed by Alloy → Loki)"
echo
wait
