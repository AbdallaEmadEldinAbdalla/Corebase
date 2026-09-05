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
  # `cat` through a host redirection rather than `docker cp`, so the *host* shell
  # creates each file under the invoking user and umask.
  #
  # `docker cp` carries the container's ownership and mode out with the archive.
  # Docker Desktop remaps that to the local user, so this worked on macOS for
  # months; on a Linux runner the files landed as root-owned and the Docker CLI
  # then failed with `open .../ca.pem: permission denied` on its own --tlscacert.
  # Redirection has no ownership to preserve, which removes the difference rather
  # than papering over it with sudo.
  for f in ca.pem cert.pem key.pem; do
    docker exec cb-data-node cat "/certs/client/$f" > "$CERTS/$f"
    [ -s "$CERTS/$f" ] || { echo "  ✗ $f came back empty from the data node"; exit 1; }
  done
  chmod 644 "$CERTS/ca.pem" "$CERTS/cert.pem"
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
  # Before compose, deliberately. Any directory compose needs and does not find,
  # the Docker daemon creates as root on Linux — which then locks this script out
  # of a directory it is about to write. Creating it first is the whole fix.
  mkdir -p "$CERTS"
  # The object store's cert directory too, and for the same reason as $CERTS
  # (D-227): compose bind-mounts it, and any directory the Docker daemon has to
  # create for a bind mount is created **as root** on Linux — which then locks this
  # script out of a directory it is about to write a certificate into. It worked on
  # Docker Desktop for macOS, where ownership is remapped, and would have failed on
  # the first Linux runner.
  mkdir -p "$STAGING_DIR/object-store-certs"
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

cmd_app_role() {
  # Enables the least-privilege application role and sets its password.
  #
  # Separate from the migration on purpose: a password in a migration is a
  # password in git. Locally the secret is generated once and written to a
  # gitignored file; in production it comes from the secret store and this script
  # is not what does it.
  local secret_file="$STAGING_DIR/app-role.env"
  if [ -f "$secret_file" ]; then
    # shellcheck disable=SC1090
    . "$secret_file"
    echo "  ✓ reusing the existing app-role password"
  else
    CB_APP_DB_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
    printf 'CB_APP_DB_PASSWORD=%s\n' "$CB_APP_DB_PASSWORD" > "$secret_file"
    chmod 600 "$secret_file"
    echo "  ✓ generated an app-role password → $(basename "$secret_file") (gitignored)"
  fi
  docker exec -e PW="$CB_APP_DB_PASSWORD" cb-control-db \
    psql -U corebase -d corebase_control -v ON_ERROR_STOP=1 -qc \
    "ALTER ROLE corebase_app LOGIN PASSWORD '$CB_APP_DB_PASSWORD'" >/dev/null
  echo "  ✓ corebase_app can log in"
  printf '    export CB_CONTROL_DATABASE_URL=postgres://corebase_app:%s@127.0.0.1:%s/corebase_control\n' \
    "$CB_APP_DB_PASSWORD" "$CONTROL_DB_PORT"
}

cmd_backup_store() {
  # Creates the backup bucket and writes the endpoint the worker will use.
  #
  # The endpoint is *discovered*, not configured: project containers reach the
  # object store through the data node's NAT egress, and inside the node the
  # compose service name does not resolve — the node's embedded DNS has never
  # heard of it. An IP is what a project container can actually dial, and the
  # same field in production holds `<account>.r2.cloudflarestorage.com`, so the
  # shape of the config is identical either way.
  local bucket="${BACKUP_BUCKET:-corebase-backups-eu-central}"
  local key="${BACKUP_ACCESS_KEY:-corebase-backup}"
  local secret="${BACKUP_SECRET_KEY:-corebase-backup-secret}"

  # Self-signed TLS for the store, generated once. pgBackRest talks S3 over HTTPS
  # and has no plain-HTTP mode, so the substitute has to serve TLS the way R2 does.
  # Verification is switched off on the client side instead of building a CA chain
  # into every project container — the property under test is that backups reach
  # object storage, not that we can operate a PKI twice in one stack.
  local cert_dir="$STAGING_DIR/object-store-certs"
  if [ ! -s "$cert_dir/public.crt" ]; then
    mkdir -p "$cert_dir"
    docker run --rm -v "$cert_dir:/out" alpine/openssl:latest \
      req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout /out/private.key -out /out/public.crt \
      -subj "/CN=cb-object-store" \
      -addext "subjectAltName=DNS:cb-object-store,DNS:object-store,DNS:localhost,IP:127.0.0.1" \
      >/dev/null 2>&1
    [ -s "$cert_dir/public.crt" ] || { echo "  ✗ could not generate the store's certificate"; return 1; }
    # openssl ran as root inside that container, so the key landed root-owned and
    # 0600. MinIO runs as its own unprivileged user and would simply fail to read
    # it — a TLS handshake error with nothing to say about permissions.
    chmod 0644 "$cert_dir/public.crt" "$cert_dir/private.key" 2>/dev/null \
      || sudo chmod 0644 "$cert_dir/public.crt" "$cert_dir/private.key"
    echo "  ✓ generated a self-signed certificate for the object store"
    docker restart cb-object-store >/dev/null
    sleep 4
  fi

  # `--insecure` throughout: the store's certificate is self-signed, and mc
  # verifying it would only be testing our own CA plumbing rather than the store.
  docker exec cb-object-store mc --insecure alias set local https://127.0.0.1:9000 "$key" "$secret" >/dev/null 2>&1 \
    || { echo "  ✗ cannot reach the object store over TLS"; return 1; }
  if docker exec cb-object-store mc --insecure ls "local/$bucket" >/dev/null 2>&1; then
    echo "  ✓ bucket $bucket already exists"
  else
    docker exec cb-object-store mc --insecure mb "local/$bucket" >/dev/null
    echo "  ✓ created bucket $bucket"
  fi

  local ip
  ip="$(docker inspect cb-object-store \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' | head -c 32)"
  if [ -z "$ip" ]; then echo "  ✗ could not resolve the object store's address"; return 1; fi

  local env_file="$STAGING_DIR/backup-store.env"
  cat > "$env_file" <<EOF
CB_BACKUP_S3_ENDPOINT=$ip
CB_BACKUP_S3_PORT=9000
# The *control plane's* view of the same store, which is not the projects' view.
#
# A project container reaches it through the node's NAT egress, so its endpoint is
# the address above — on the compose network. The control plane runs on the host,
# which cannot route to a container IP at all, so it uses the published port. In
# production both are R2 over the internet and these two are identical, which is
# why the control-plane pair falls back to the project pair when unset.
CB_BACKUP_S3_CONTROL_ENDPOINT=127.0.0.1
CB_BACKUP_S3_CONTROL_PORT=${OBJECT_STORE_PORT:-59000}
CB_BACKUP_S3_BUCKET=$bucket
CB_BACKUP_S3_KEY=$key
CB_BACKUP_S3_SECRET=$secret
CB_BACKUP_S3_REGION=auto
CB_BACKUP_S3_URI_STYLE=path
CB_BACKUP_S3_VERIFY_TLS=n
EOF
  chmod 600 "$env_file"
  echo "  ✓ endpoint https://$ip:9000 → $(basename "$env_file") (gitignored)"

  # Proves the path a project container will actually take: its own private
  # network inside the node, out through NAT. A green check here and a failure at
  # archive-push time would otherwise be indistinguishable from a bad cipher-pass.
  # The probe needs the project image on the node, so say so rather than blaming
  # the network. The first CI run of this step failed with "NOT reachable from a
  # project network" when the real cause was that `backup-store` ran before
  # `seed-images` and the image simply was not there — a misleading diagnostic
  # pointing at the one thing that was working.
  if ! node_docker image inspect corebase/postgres:17.5 >/dev/null 2>&1; then
    echo "  ⚠ skipping the egress probe: corebase/postgres:17.5 is not on the node yet."
    echo "    Run ./scripts/staging.sh seed-images first, then this again, to check it."
    return 0
  fi

  # `bash`, not `sh`: /dev/tcp is a bash builtin and the image's /bin/sh is dash,
  # where the redirect is a syntax error — which fails the probe for a reason that
  # has nothing to do with routing and reads exactly like a routing failure.
  local probe_out
  if probe_out="$(docker exec cb-data-node sh -c \
      "docker network create cb-egress-probe >/dev/null 2>&1; \
       docker run --rm --network cb-egress-probe --entrypoint bash corebase/postgres:17.5 \
         -c 'exec 3<>/dev/tcp/${ip}/9000' 2>&1; r=\$?; \
       docker network rm cb-egress-probe >/dev/null 2>&1; exit \$r" 2>&1)"; then
    echo "  ✓ reachable from a project's private network (NAT egress, as in production)"
  else
    echo "  ✗ NOT reachable from a project network — archiving would fail silently"
    # Printed, because the previous version swallowed it and left the operator with
    # a conclusion and no evidence.
    [ -n "$probe_out" ] && echo "    $probe_out" | head -5
    return 1
  fi
}

# The local stand-in for Postmark (P4d). Same shape as backup-store: emit the
# environment the services need, and prove the path they will actually take.
cmd_mail_sink() {
  echo "▸ email sink"
  if ! docker ps --filter name=cb-mailpit --filter status=running -q | grep -q .; then
    echo "  ✗ cb-mailpit is not running — run ./scripts/staging.sh up"; return 1
  fi

  local env_file="$STAGING_DIR/mail-sink.env"
  cat > "$env_file" <<EOF
# The worker runs on the host here, so it reaches the sink on the published port.
# In production these are the provider's own host and 587 with STARTTLS.
CB_SMTP_HOST=127.0.0.1
CB_SMTP_PORT=${MAILPIT_SMTP_PORT:-51025}
# Plaintext, and only ever correct for a local sink. The worker refuses this in
# production, and refuses to send credentials over it anywhere.
CB_SMTP_TLS=off
CB_MAIL_FROM=auth@mail.corebase.co
# Where the tests read what arrived. Not used by the services.
CB_MAILPIT_API=http://127.0.0.1:${MAILPIT_HTTP_PORT:-58025}
EOF
  chmod 600 "$env_file"
  echo "  ✓ smtp 127.0.0.1:${MAILPIT_SMTP_PORT:-51025} → $(basename "$env_file") (gitignored)"

  # An actual SMTP conversation, not a port check. A listening socket that rejects
  # EHLO looks identical to a working sink until the first send fails, and the
  # difference between "the sink is up" and "the sink will accept mail" is the
  # whole reason this step exists rather than a `nc -z`.
  printf '  %-36s' "sink accepts a message"
  local before after
  before="$(curl -fsS "http://127.0.0.1:${MAILPIT_HTTP_PORT:-58025}/api/v1/messages"             | sed -n 's/.*"messages_count":\([0-9]*\).*/\1/p')"
  if printf 'EHLO probe\r\nMAIL FROM:<probe@corebase.test>\r\nRCPT TO:<sink@corebase.test>\r\nDATA\r\nSubject: staging probe\r\n\r\nprobe\r\n.\r\nQUIT\r\n' \
     | nc -w 5 127.0.0.1 "${MAILPIT_SMTP_PORT:-51025}" >/dev/null 2>&1; then
    # Polled, not read once. The sink accepts the message on the SMTP socket and
    # indexes it a moment later, so a single read immediately after `nc` returns
    # sees the old count and reports a working sink as broken — which is exactly
    # what the first run of this check did.
    after="${before:-0}"
    for _ in $(seq 1 20); do
      after="$(curl -fsS "http://127.0.0.1:${MAILPIT_HTTP_PORT:-58025}/api/v1/messages" \
               | sed -n 's/.*"messages_count":\([0-9]*\).*/\1/p')"
      [ "${after:-0}" -gt "${before:-0}" ] && break
      sleep 0.25
    done
    if [ "${after:-0}" -gt "${before:-0}" ]; then echo "PASS"; else
      echo "FAIL (SMTP accepted the message but the sink never showed it)"; return 1; fi
  else
    echo "FAIL (could not talk SMTP to the sink)"; return 1
  fi
}

cmd_seed_images() {
  # Production pre-pulls images onto every node so provisioning is a claim, not a
  # download (D-071). Locally the data node has its own image store, so we push
  # the built images across explicitly — same intent, same effect on create time.
  #
  # Three images, because a project is three containers as of P5b: Postgres, its
  # pooler (D-015) and its PostgREST (D-011). A node missing one of them fails
  # provisioning at the step that starts it rather than at create time, which is a
  # much worse diagnostic.
  for image in corebase/postgres:17.5 corebase/pgbouncer:1.23 corebase/postgrest:12.2; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "  ✗ $image is not built locally — build it first:"
      # postgrest before postgres: "postgrest" *contains* "postgres", so the
      # looser arm first makes the specific one dead code and tells you to build
      # the wrong image.
      case "$image" in
        *postgrest*) echo "      docker build -t $image infra/docker/postgrest" ;;
        *postgres*)  echo "      docker build -t $image infra/docker/postgres" ;;
        *pgbouncer*) echo "      docker build -t $image infra/docker/pgbouncer" ;;
      esac
      exit 1
    fi
    echo "▸ loading $image into the data node"
    docker save "$image" | node_docker load >/dev/null
  done
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
  if node_docker image inspect corebase/postgres:17.5 >/dev/null 2>&1 \
     && node_docker image inspect corebase/pgbouncer:1.23 >/dev/null 2>&1; then echo "PASS"; else echo "SKIP (run seed-images)"; fi

  printf '  %-36s' "host ports published"
  if nc -z 127.0.0.1 "$CONTROL_DB_PORT" >/dev/null 2>&1 && nc -z 127.0.0.1 "$CONTROL_REDIS_PORT" >/dev/null 2>&1; then echo "PASS"; else echo "FAIL"; fail=1; fi

  printf '  %-36s' "project port range reachable"
  # The control plane opens direct admin connections to project databases, so the
  # allocator's range has to be published from the node — not just allocated in
  # the control plane (D-192).
  if docker port cb-data-node | grep -q '^5433/tcp'; then echo "PASS"; else
    echo "FAIL (publish PROJECT_PORT_MIN-MAX)"; fail=1; fi

  printf '  %-36s' "pooler port range reachable"
  # Same rule, second listener (P2b). A pooler on an unpublished port is a pooler
  # the health gate cannot reach and a DATABASE_URL that cannot connect.
  if docker port cb-data-node | grep -q '^6433/tcp'; then echo "PASS"; else
    echo "FAIL (publish POOLER_PORT_MIN-MAX)"; fail=1; fi

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
cmd_nuke()  { echo "▸ destroying including volumes"; $DC down -v; rm -rf "$CERTS" "$KEK_DIR" "$STAGING_DIR/app-role.env"; }
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
  app-role) cmd_app_role ;;
  backup-store) cmd_backup_store ;;
  mail-sink) cmd_mail_sink ;;
  seed-images) cmd_seed_images ;;
  verify) cmd_verify ;;
  idempotent) cmd_idempotent ;;
  down) cmd_down ;;
  nuke) cmd_nuke ;;
  status) cmd_status ;;
  monitoring) cmd_monitoring ;;
  # seed-images before backup-store: the egress probe runs a container from the
  # project image on the node, so the image has to be there first.
  all) cmd_up && cmd_kek && cmd_app_role && cmd_seed_images && cmd_backup_store && cmd_mail_sink && cmd_verify && cmd_idempotent ;;
  *) echo "usage: $0 {up|kek|app-role|seed-images|backup-store|mail-sink|verify|idempotent|down|nuke|status|monitoring|all}"; exit 2 ;;
esac
