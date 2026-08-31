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
KEK_DIR="$STAGING_DIR/kek.d"
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

cmd_kek() {
  # The control plane refuses to start without a master key (D-035/D-075). In
  # production this is generated offline with two sealed offline copies; locally
  # it is one throwaway file, gitignored, and losing it means losing every stored
  # credential in staging — which is exactly the property we want to rehearse.
  mkdir -p "$KEK_DIR"
  local id="kek_$(date +%Y_%m)"
  if [ -f "$KEK_DIR/$id.key" ]; then
    echo "  ✓ KEK $id already present"
  else
    head -c 32 /dev/urandom > "$KEK_DIR/$id.key"
    chmod 600 "$KEK_DIR/$id.key"
    echo "  ✓ generated KEK $id (32 bytes)"
  fi
  echo "    export CB_KEK_DIR=$KEK_DIR"
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

  printf '  %-36s' "project port range reachable"
  # The control plane opens direct admin connections to project databases, so the
  # allocator's range has to be published from the node — not just allocated in
  # the control plane (D-192).
  if docker port cb-data-node | grep -q '^5433/tcp'; then echo "PASS"; else
    echo "FAIL (publish PROJECT_PORT_MIN-MAX)"; fail=1; fi

  printf '  %-36s' "master key present"
  if ls "$KEK_DIR"/*.key >/dev/null 2>&1; then echo "PASS"; else echo "SKIP (run kek)"; fi

  printf '  %-36s' "node can run a project container"
  if node_docker run --rm --name cb-smoke -e POSTGRES_PASSWORD=smoke -d corebase/postgres:17.5 >/dev/null 2>&1; then
    ok=0
    for _ in $(seq 1 30); do
      if node_docker exec cb-smoke pg_isready -U postgres -q >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    # -v matters: the project image declares VOLUME /var/lib/postgresql/data, so a
    # container started without a mount gets an anonymous volume. Without -v this
    # check leaked ~60 MB of unreferenced volume every time it ran, which is
    # exactly the slow disk leak T8 exists to catch.
    node_docker rm -f -v cb-smoke >/dev/null 2>&1 || true
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
cmd_nuke()  { echo "▸ destroying including volumes"; $DC down -v; rm -rf "$CERTS" "$KEK_DIR"; }
cmd_status(){ $DC ps; }

cmd_monitoring() {
  # The T9 stack. Reported separately because these are the URLs someone actually
  # wants during a drill.
  echo "▸ monitoring"
  printf '  %-12s %s\n' prometheus "http://127.0.0.1:${PROMETHEUS_PORT:-9090}"
  printf '  %-12s %s\n' loki       "http://127.0.0.1:${LOKI_PORT:-3100}/ready"
  printf '  %-12s %s\n' grafana    "http://127.0.0.1:${GRAFANA_PORT:-3001}/d/corebase-provisioning"
  printf '  %-12s ' "prometheus up"
  curl -sf "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/-/healthy" >/dev/null && echo PASS || echo FAIL
  printf '  %-12s ' "loki ready"
  curl -sf "http://127.0.0.1:${LOKI_PORT:-3100}/ready" >/dev/null && echo PASS || echo "not yet"
  printf '  %-12s ' "grafana up"
  curl -sf "http://127.0.0.1:${GRAFANA_PORT:-3001}/api/health" >/dev/null && echo PASS || echo FAIL
  printf '  %-12s ' "scrape targets"
  curl -sf "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/api/v1/targets?state=active" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin)['data']['activeTargets'];print(' '.join(f\"{t['labels'].get('job')}={t['health']}\" for t in d))" \
    || echo "unavailable"
}

case "${1:-}" in
  up) cmd_up ;;
  kek) cmd_kek ;;
  seed-images) cmd_seed_images ;;
  verify) cmd_verify ;;
  idempotent) cmd_idempotent ;;
  down) cmd_down ;;
  nuke) cmd_nuke ;;
  status) cmd_status ;;
  monitoring) cmd_monitoring ;;
  all) cmd_up && cmd_kek && cmd_seed_images && cmd_verify && cmd_idempotent ;;
  *) echo "usage: $0 {up|kek|seed-images|verify|idempotent|down|nuke|status|monitoring|all}"; exit 2 ;;
esac
