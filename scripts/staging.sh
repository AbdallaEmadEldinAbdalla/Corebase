#!/usr/bin/env bash
# Milestone 0 · T2 — bring up / verify / tear down the Docker staging substitute.
# Done-signal (adapted from the plan): `up` from zero produces a reachable control
# DB, a reachable Redis, and a data node whose Engine API answers over TLS — and
# re-running `up` is a no-op.
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/infra/docker/staging/docker-compose.yml"
STAGING_DIR="$(dirname "$COMPOSE_FILE")"
DC="docker compose -f $COMPOSE_FILE"
CERTS="$STAGING_DIR/certs"
DATA_NODE_PORT="${DATA_NODE_PORT:-2376}"
CONTROL_DB_PORT="${CONTROL_DB_PORT:-55433}"
CONTROL_REDIS_PORT="${CONTROL_REDIS_PORT:-56379}"

# Talking to the data node the way the worker will: TLS client certs, no 2375.
node_docker() {
  docker --host "tcp://127.0.0.1:${DATA_NODE_PORT}" --tlsverify \
    --tlscacert "$CERTS/ca.pem" --tlscert "$CERTS/cert.pem" --tlskey "$CERTS/key.pem" "$@"
}

pull_certs() {
  mkdir -p "$CERTS"
  for f in ca.pem cert.pem key.pem; do
    docker cp "cb-data-node:/certs/client/$f" "$CERTS/$f" >/dev/null
  done
  chmod 600 "$CERTS/key.pem"
}

wait_for() {  # wait_for <name> <seconds> <command...>
  local name="$1" limit="$2"; shift 2
  for ((i=1; i<=limit; i++)); do
    if "$@" >/dev/null 2>&1; then echo "  ✓ $name ready (${i}s)"; return 0; fi
    sleep 1
  done
  echo "  ✗ $name did not come up in ${limit}s"; return 1
}

cmd_up() {
  echo "▸ starting staging (control node + data node)"
  $DC up -d
  wait_for "control-db"    60 docker exec cb-control-db pg_isready -U corebase -d corebase_control
  wait_for "control-redis" 30 docker exec cb-control-redis redis-cli ping
  wait_for "dockerd"       90 docker exec cb-data-node docker info
  pull_certs
  wait_for "data-node TLS API" 30 node_docker info
  echo "▸ up"
}

cmd_seed_images() {
  # Production pre-pulls images onto every node so provisioning is a claim, not a
  # download (D-071). Locally the data node has its own image store, so we push
  # the built image across explicitly — same intent, same effect on create time.
  echo "▸ loading corebase/postgres:17.5 into the data node"
  docker save corebase/postgres:17.5 | node_docker load
  node_docker images --format '  {{.Repository}}:{{.Tag}} ({{.Size}})' | grep corebase || true
}

cmd_verify() {
  local fail=0
  echo "▸ T2 done-signal checks"

  printf '  %-36s' "control-db accepts SQL"
  if docker exec cb-control-db psql -U corebase -d corebase_control -tAXc 'select 1' | grep -q '^1$'; then
    echo "PASS"; else echo "FAIL"; fail=1; fi

  printf '  %-36s' "control-redis responds"
  if [ "$(docker exec cb-control-redis redis-cli ping)" = "PONG" ]; then echo "PASS"; else echo "FAIL"; fail=1; fi

  printf '  %-36s' "data-node Engine API over TLS"
  if node_docker info >/dev/null 2>&1; then echo "PASS"; else echo "FAIL"; fail=1; fi

  printf '  %-36s' "plaintext :2375 refused"
  if docker --host "tcp://127.0.0.1:2375" info >/dev/null 2>&1; then echo "FAIL (open!)"; fail=1; else echo "PASS"; fi

  printf '  %-36s' "TLS required (no certs -> denied)"
  if docker --host "tcp://127.0.0.1:${DATA_NODE_PORT}" info >/dev/null 2>&1; then
    echo "FAIL (unauthenticated access!)"; fail=1; else echo "PASS"; fi

  printf '  %-36s' "project image present on node"
  if node_docker image inspect corebase/postgres:17.5 >/dev/null 2>&1; then echo "PASS"; else echo "SKIP (run seed-images)"; fi

  printf '  %-36s' "host ports published"
  if nc -z 127.0.0.1 "$CONTROL_DB_PORT" >/dev/null 2>&1 && nc -z 127.0.0.1 "$CONTROL_REDIS_PORT" >/dev/null 2>&1; then echo "PASS"; else echo "FAIL"; fail=1; fi

  printf '  %-36s' "node can run a project container"
  if node_docker run --rm --name cb-smoke -e POSTGRES_PASSWORD=smoke -d corebase/postgres:17.5 >/dev/null 2>&1; then
    ok=0
    for _ in $(seq 1 30); do
      if node_docker exec cb-smoke pg_isready -U postgres -q >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    node_docker rm -f cb-smoke >/dev/null 2>&1 || true
    [ "$ok" -eq 1 ] && echo "PASS" || { echo "FAIL (never became ready)"; fail=1; }
  else echo "FAIL (could not start)"; fail=1; fi

  [ "$fail" -eq 0 ] && echo "▸ T2 checks passed" || { echo "▸ T2 checks FAILED"; return 1; }
}

cmd_idempotent() {
  echo "▸ re-apply must be a no-op"
  local before after
  before=$($DC ps -q | sort | md5)
  $DC up -d >/dev/null
  after=$($DC ps -q | sort | md5)
  if [ "$before" = "$after" ]; then echo "  ✓ same container set after re-apply"; else
    echo "  ✗ containers were recreated"; return 1; fi
}

cmd_down()  { echo "▸ stopping (volumes kept)"; $DC down; }
cmd_nuke()  { echo "▸ destroying including volumes"; $DC down -v; rm -rf "$CERTS"; }
cmd_status(){ $DC ps; }

case "${1:-}" in
  up) cmd_up ;;
  seed-images) cmd_seed_images ;;
  verify) cmd_verify ;;
  idempotent) cmd_idempotent ;;
  down) cmd_down ;;
  nuke) cmd_nuke ;;
  status) cmd_status ;;
  all) cmd_up && cmd_seed_images && cmd_verify && cmd_idempotent ;;
  *) echo "usage: $0 {up|seed-images|verify|idempotent|down|nuke|status|all}"; exit 2 ;;
esac
