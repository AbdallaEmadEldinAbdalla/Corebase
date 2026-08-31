#!/usr/bin/env bash
# Corebase, end to end, in one script.
#
# Milestone 0 · T10. Create a project through the API, wait for it, connect to the
# database it made with the credentials it handed back, do real SQL, then delete
# it. Nothing here reaches past the public surface: curl and psql only, no
# database poking, no internal helpers — because that is exactly what a customer
# has, and a demo that needs more than a customer has is not a demo.
#
# This is also the seed of the golden-path e2e test (13-quality/01), so it is
# written to be read: every step says what it is proving, not just what it runs.
#
#   ./scripts/demo.sh                 create, use, delete
#   ./scripts/demo.sh --keep          leave the project running to poke at
#   ./scripts/demo.sh --purge         also destroy it (what CI should run)
set -euo pipefail

API="${CB_API:-http://127.0.0.1:8099}"
TOKEN="${CB_STATIC_TOKEN:-dev-token}"
NAME="${CB_DEMO_NAME:-demo-$(date +%s)}"
KEEP=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --keep)  KEEP=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REF=""
say()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Even a failed demo cleans up after itself. A script that leaves a running
# database behind every time it breaks teaches people to distrust it.
cleanup() {
  local code=$?
  if [ -n "$REF" ] && [ "$KEEP" -eq 0 ] && [ "$code" -ne 0 ]; then
    printf '\n  cleaning up %s after a failure\n' "$REF"
    curl -s -X DELETE "$API/v1/projects/$REF" -H "authorization: Bearer $TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

api() { curl -sS -H "authorization: Bearer $TOKEN" "$@"; }

# ── preflight ───────────────────────────────────────────────────────────────
say "preflight"
command -v jq   >/dev/null || die "jq is not installed (brew install jq)"
command -v psql >/dev/null || die "psql is not installed (brew install libpq)"
api "$API/health" >/dev/null 2>&1 \
  || die "no API at $API — run ./scripts/staging.sh up, then ./scripts/dev.sh"
ok "API is up at $API"

# ── 1. create ───────────────────────────────────────────────────────────────
# Name the organization explicitly rather than relying on the API's
# single-organization convenience. That default disappears the moment the account
# belongs to two orgs — which happens as soon as the test suite has run, since it
# creates orgs with the same static token — and the API is right to refuse to
# guess. A real client resolves the org; so does this.
say "resolving the organization"
ORGS=$(api "$API/v1/orgs")
ORG_ID=$(echo "$ORGS" | jq -r '(.orgs[] | select(.slug == "dev") | .id) // (.orgs[0].id) // empty')
[ -n "$ORG_ID" ] || die "no organization for this token: $ORGS"
ok "$(echo "$ORGS" | jq -r --arg id "$ORG_ID" '.orgs[] | select(.id == $id) | .name') · $ORG_ID"

say "creating a project"
START=$(date +%s)
CREATED=$(api -X POST "$API/v1/projects" \
  -H 'content-type: application/json' \
  -H "idempotency-key: demo-$(date +%s)-$$" \
  -d "{\"name\":\"$NAME\",\"region\":\"eu-central\",\"org_id\":\"$ORG_ID\"}")
# { project, job } per the platform-API contract (OQ-175 closed in P1b).
REF=$(echo "$CREATED" | jq -r '.project.ref // empty')
[ -n "$REF" ] || die "create failed: $CREATED"
ok "$REF · status $(echo "$CREATED" | jq -r .project.status) · id $(echo "$CREATED" | jq -r .project.id)"
info "the API answered before the database existed; provisioning is a job"

# ── 2. wait ─────────────────────────────────────────────────────────────────
say "waiting for it to be ready"
DEADLINE=$((SECONDS + 120))
while :; do
  DETAIL=$(api "$API/v1/projects/$REF")
  STATUS=$(echo "$DETAIL" | jq -r '.project.status')
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "failed" ] && die "provisioning failed"
  [ "$SECONDS" -gt "$DEADLINE" ] && die "still $STATUS after 120s"
  sleep 0.5
done
ok "ready in $(( $(date +%s) - START ))s"

URL=$(echo "$DETAIL" | jq -r '.database.connection_strings.direct // empty')
[ -n "$URL" ] || die "ready but no connection string — the API should have one by now"
info "host  $(echo "$DETAIL" | jq -r .database.host)"
info "url   $(echo "$URL" | sed -E 's#(://[^:]+:)[^@]+@#\1********@#')"

# ── 3. use it ───────────────────────────────────────────────────────────────
# The part that matters. Everything above is the control plane talking about
# itself; this is a customer's psql against a real Postgres.
say "using the database as a customer would"
psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE hello (
  id      bigserial PRIMARY KEY,
  body    text NOT NULL,
  created timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hello (body) VALUES ('hello from Corebase'), ('the second row');
SQL
ok "created a table and inserted two rows"

ROWS=$(psql "$URL" -tAX -c 'SELECT count(*) FROM hello')
[ "$ROWS" = "2" ] || die "expected 2 rows, got $ROWS"
ok "read them back: $ROWS rows"

psql "$URL" -X -c 'SELECT id, body FROM hello ORDER BY id' | sed 's/^/    /'

# Two facts about the database itself, both of which the plan promises and
# neither of which a customer should have to take on trust.
VERSION=$(psql "$URL" -tAX -c "SELECT current_setting('server_version')")
WHOAMI=$(psql "$URL" -tAX -c 'SELECT current_user')
RLS=$(psql "$URL" -tAX -c "SELECT relrowsecurity FROM pg_class WHERE relname = 'hello'")
ok "Postgres $VERSION, connected as \"$WHOAMI\""
if [ "$RLS" = "t" ]; then
  ok "row-level security is already on for the new table (D-083)"
  info "no policies yet, so the API roles see nothing — the owner still does"
else
  die "RLS was not enabled on a new table; the event trigger did not fire"
fi

SUPER=$(psql "$URL" -tAX -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
[ "$SUPER" = "f" ] || die "the customer role is a superuser; it must not be"
ok "the customer role is not a superuser (D-080)"

if [ "$KEEP" -eq 1 ]; then
  say "keeping $REF"
  info "psql \"\$(curl -s $API/v1/projects/$REF -H 'authorization: Bearer $TOKEN' | jq -r .database.connection_strings.direct)\""
  info "delete it with: curl -X DELETE $API/v1/projects/$REF -H 'authorization: Bearer $TOKEN'"
  exit 0
fi

# ── 4. delete ───────────────────────────────────────────────────────────────
say "deleting it"
DELETED=$(api -X DELETE "$API/v1/projects/$REF")
echo "$DELETED" | jq -e '.job.type == "delete_project"' >/dev/null \
  || die "delete did not schedule a teardown: $DELETED"
ok "teardown scheduled"

DEADLINE=$((SECONDS + 60))
while :; do
  STATUS=$(api "$API/v1/projects/$REF" | jq -r '.project.status')
  [ "$STATUS" = "soft_deleted" ] && break
  [ "$SECONDS" -gt "$DEADLINE" ] && die "still $STATUS after 60s"
  sleep 0.5
done
PURGE_AT=$(api "$API/v1/projects/$REF" | jq -r '.project.restorable_until // "unknown"')
ok "soft-deleted — the container is stopped and the volume is kept"
info "the data survives until $PURGE_AT (D-038), then a purge destroys it"

# ── 5. optionally destroy it ────────────────────────────────────────────────
if [ "$PURGE" -eq 1 ]; then
  say "closing the recovery window (test-only shortcut)"
  # The only step in this script that reaches past the public API, and it is
  # marked as such: there is no customer-facing "purge now", because seven days
  # of undo is the product. CI wants the residue gone, so it expires the window
  # by hand and lets the ordinary scheduled purge do the work.
  CTRL="${CB_CONTROL_DATABASE_URL:-postgres://corebase:controlpass@127.0.0.1:55433/corebase_control}"
  psql "$CTRL" -tAX -c \
    "UPDATE projects SET purge_after = now() - interval '1 second' WHERE ref = '$REF'" >/dev/null
  info "waiting for the purge scan to notice"
  DEADLINE=$((SECONDS + 180))
  while :; do
    STATUS=$(psql "$CTRL" -tAX -c "SELECT status FROM projects WHERE ref = '$REF'")
    [ "$STATUS" = "deleted" ] && break
    [ "$SECONDS" -gt "$DEADLINE" ] && die "still $STATUS after 180s — is CB_PURGE_SCAN_MS long?"
    sleep 1
  done
  ok "purged — container, volume, credentials and capacity all released"
  LEFT=$(psql "$CTRL" -tAX -c \
    "SELECT count(*) FROM project_databases d JOIN projects p ON p.id = d.project_id WHERE p.ref = '$REF'")
  [ "$LEFT" = "0" ] || die "$LEFT placement row(s) left behind"
  ok "no placement row left, so the port is reusable"
fi

say "done in $(( $(date +%s) - START ))s"
printf '  A project was created, provisioned, used with real SQL, and %s.\n' \
  "$([ "$PURGE" -eq 1 ] && echo 'destroyed' || echo 'soft-deleted')"
[ "$PURGE" -eq 0 ] && printf '  Run with --purge to close the recovery window too.\n'
exit 0
