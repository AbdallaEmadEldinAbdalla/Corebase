#!/usr/bin/env bash
# Phase 5 demo (roadmap §Phase 5): the proposal's §80 five-minute flow minus
# storage — "table + policy via SQL, insert as service_role, read as an
# authenticated user seeing only their rows."
#
# The division of labour here is the demo's actual subject. The *script* plays the
# customer's backend: it applies the migration over the project's own
# DATABASE_URL and inserts the seed rows with the service_role key. The *page*
# plays the customer's frontend and holds nothing but the anon key. That split is
# not staging convenience — a page holding a service_role key would hand every
# visitor every user's rows, and our own docs call a leaked service key a
# rotate-now incident.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${CB_DEMO_API:-http://127.0.0.1:8099}"
TOKEN="${CB_STATIC_TOKEN:-local-dev-only-not-a-production-credential}"
PORT="${CB_DEMO_PORT:-8124}"
ORIGIN="http://127.0.0.1:$PORT"
DOMAIN="${CB_PROJECT_DOMAIN:-localhost}"
NAME="${CB_DEMO_PROJECT:-data-demo}"

say() { printf '  %s\n' "$*"; }
jq_py() { python3 -c "import json,sys; $1"; }

if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ no API at $API — run ./scripts/dev.sh in another terminal" >&2; exit 1
fi
# The gateway resolves a project from the Host header, so it has to be registered
# under the domain this script will send. A mismatch here is a 404 that looks like
# a missing project rather than a missing setting.
if ! curl -fsS "$API/health" -o /dev/null; then :; fi

echo "▸ project"
ORG="$(curl -fsS "$API/v1/orgs" -H "authorization: Bearer $TOKEN" \
       | sed -n 's/.*"id":"\(org_[^"]*\)".*/\1/p' | head -1)"
[ -n "$ORG" ] || { echo "✗ the bootstrap user belongs to no organization" >&2; exit 1; }

REF="$(curl -fsS "$API/v1/projects?limit=100&org_id=$ORG" -H "authorization: Bearer $TOKEN" \
       | CB_NAME="$NAME" python3 -c "
import json, os, sys
want = os.environ['CB_NAME']
for p in json.load(sys.stdin).get('projects', []):
    if p.get('name') == want:
        print(p['ref']); break
")"

if [ -z "$REF" ]; then
  say "creating '$NAME'"
  REF="$(curl -fsS -X POST "$API/v1/projects" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "idempotency-key: data-demo-$(date +%s)" \
    -d "{\"name\":\"$NAME\",\"region\":\"eu-central\",\"org_id\":\"$ORG\"}" \
    | jq_py 'print(json.load(sys.stdin)["project"]["ref"])')"
else
  say "reusing '$NAME' ($REF)"
fi

printf '  waiting for it to be ready'
for _ in $(seq 1 120); do
  STATUS="$(curl -fsS "$API/v1/projects/$REF" -H "authorization: Bearer $TOKEN" \
            | jq_py 'print(json.load(sys.stdin)["project"]["status"])')"
  [ "$STATUS" = "ready" ] && break
  printf '.'; sleep 2
done
echo
[ "$STATUS" = "ready" ] || { echo "✗ project is '$STATUS', not ready" >&2; exit 1; }
say "✓ $REF is ready"

echo "▸ keys"
KEYS="$(curl -fsS "$API/v1/projects/$REF/keys?reveal=true" -H "authorization: Bearer $TOKEN")"
ANON="$(printf '%s' "$KEYS" | jq_py "
d=json.load(sys.stdin)
print(next((k.get('key','') for k in d['api_keys'] if k['kind']=='anon'), ''))")"
SERVICE="$(printf '%s' "$KEYS" | jq_py "
d=json.load(sys.stdin)
print(next((k.get('key','') for k in d['api_keys'] if k['kind']=='service_role'), ''))")"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || { echo "✗ could not read the project's keys" >&2; exit 1; }
say "✓ anon key (goes to the page) and service_role key (stays here)"

echo "▸ the migration, as a customer would run it"
DIRECT="$(curl -fsS "$API/v1/projects/$REF?reveal=true" -H "authorization: Bearer $TOKEN" \
          | jq_py "
d=json.load(sys.stdin)
print((d.get('database') or {}).get('connection_strings',{}).get('direct',''))")"
[ -n "$DIRECT" ] || { echo "✗ the project detail revealed no direct connection string" >&2; exit 1; }

# Printed before it runs, because "every UI mutation shows its SQL" is a promise
# the dashboard makes and a demo that hides its DDL is teaching the wrong thing.
SQL=$(cat <<'DDL'
create table if not exists public.notes (
  id        bigserial primary key,
  owner     uuid not null,
  body      text not null,
  created_at timestamptz not null default now()
);
create index if not exists notes_owner_idx on public.notes (owner);

-- RLS is already ENABLED: the project's event trigger did that when the table was
-- created (D-083 as amended by D-191), so the table is closed before any policy
-- exists. These two policies are what open it, and only for the row's owner.
create policy "read own notes"   on public.notes for select
  to authenticated using ( owner = (select auth.uid()) );
create policy "insert own notes" on public.notes for insert
  to authenticated with check ( owner = (select auth.uid()) );
DDL
)
printf '%s\n' "$SQL" | sed 's/^/      /'
printf '%s' "$SQL" | psql "$DIRECT" -q -v ON_ERROR_STOP=1 \
  2>&1 | grep -v 'already exists' || true
say "✓ table and policies applied over the project's own DATABASE_URL"

echo "▸ two users"
PROJECT_ID="$(docker exec -i cb-control-db psql -U corebase -d corebase_control -qAtc \
  "select id from projects where ref = '$REF'")"
# Autoconfirm ON here, and only here: Phase 4's demo is the one that proves a real
# address gets a real mail. This one is about RLS, and a mailbox round trip in the
# middle of it would be a different lesson.
docker exec -i cb-control-db psql -U corebase -d corebase_control -qAtc \
  "insert into project_auth_config (project_id, autoconfirm, site_url)
   values ('$PROJECT_ID', true, '$ORIGIN')
   on conflict (project_id) do update set autoconfirm = true, site_url = '$ORIGIN'" >/dev/null
say "✓ autoconfirm on (Phase 4's demo covers the email path)"

signup() {
  curl -sS -X POST "$API/auth/v1/signup" \
    -H "apikey: $ANON" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" -o /dev/null -w '%{http_code}'
}
for u in "alice@example.com" "bob@example.com"; do
  CODE="$(signup "$u" 'demo-password-123')"
  case "$CODE" in
    200|201) say "✓ $u created" ;;
    # A rerun finds them already there, which is the enumeration-resistant
    # response doing its job rather than an error.
    *) say "· $u already exists (HTTP $CODE)" ;;
  esac
done

# The user's id comes from **logging in and reading the token**, which is what a
# customer's backend does and needs no privilege at all.
#
# The first version queried `auth.users` over the project's own DATABASE_URL and
# failed with `permission denied for table users` — correctly, and the isolation
# suite's DB-3 is the test that says so. A demo that reached past a boundary this
# repository asserts elsewhere would be demonstrating the wrong thing, and there
# was never a need: `sub` is in the token.
uid_of() {
  curl -fsS -X POST "$API/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"demo-password-123\"}" \
  | jq_py "
import base64
tok = json.load(sys.stdin)['access_token']
part = tok.split('.')[1]
part += '=' * (-len(part) % 4)
print(json.loads(base64.urlsafe_b64decode(part))['sub'])"
}
ALICE="$(uid_of alice@example.com)"
BOB="$(uid_of bob@example.com)"
[ -n "$ALICE" ] && [ -n "$BOB" ] || { echo "✗ could not sign in as the demo users" >&2; exit 1; }
say "✓ ids read from their own access tokens, not from auth.users"

echo "▸ seeding as service_role, over HTTP, through the gateway"
# This is the plan's "insert as service_role" step, and it runs *here* rather than
# in the page for the reason at the top of this file. `curl` can set Host; a
# browser cannot, which is why serve.py exists.
seed() {
  curl -sS -X POST "$API/rest/v1/notes" \
    -H "Host: $REF.$DOMAIN" -H "apikey: $SERVICE" \
    -H 'content-type: application/json' -H 'prefer: return=minimal' \
    -d "$1" -o /dev/null -w '%{http_code}'
}
EXISTING="$(curl -sS "$API/rest/v1/notes?select=id" -H "Host: $REF.$DOMAIN" \
            -H "apikey: $SERVICE" | jq_py 'print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
if [ "$EXISTING" -lt 4 ]; then
  seed "[{\"owner\":\"$ALICE\",\"body\":\"Alice: buy milk\"},
         {\"owner\":\"$ALICE\",\"body\":\"Alice: renew passport\"},
         {\"owner\":\"$BOB\",\"body\":\"Bob: call the dentist\"},
         {\"owner\":\"$BOB\",\"body\":\"Bob: cancel the gym\"}]" >/dev/null
fi
TOTAL="$(curl -sS "$API/rest/v1/notes?select=id" -H "Host: $REF.$DOMAIN" \
         -H "apikey: $SERVICE" | jq_py 'print(len(json.load(sys.stdin)))')"
say "✓ $TOTAL rows exist — service_role sees all of them, because BYPASSRLS is a"
say "  role attribute (D-082) and not a policy it could have forgotten to write"

cat > "$ROOT/demo/data/config.js" <<CFGEOF
// Written by ./scripts/data-demo.sh — gitignored, regenerated on every run.
//
// The **anon** key only, and that is the whole point of this file. It is
// published in client code by design (D-029). The service_role key this script
// also holds is never written here: it bypasses RLS entirely, so a page carrying
// it would show every visitor every user's notes.
window.COREBASE_DEMO = {
  ref: '$REF',
  anonKey: '$ANON',
  users: { alice: '$ALICE', bob: '$BOB' },
  total: $TOTAL,
};
CFGEOF
say "✓ demo/data/config.js (anon key only)"

echo
echo "▸ serving  $ORIGIN"
echo
echo "  The page calls /auth/v1 and /rest/v1 on its own origin and serve.py"
echo "  forwards them to $API, adding 'Host: $REF.$DOMAIN'."
echo "  That is not a shortcut — a browser is forbidden from setting Host, so"
echo "  something in front of the gateway must do it. In production that is"
echo "  Cloudflare and Caddy; here it is 40 lines of Python."
echo
cd "$ROOT/demo/data"
exec python3 serve.py "$PORT"
