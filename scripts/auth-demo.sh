#!/usr/bin/env bash
# Phase 4 demo (roadmap §Phase 4): "a plain HTML page signs a user up against a
# project, verifies email, logs in, shows the JWT claims."
#
# This stands the page up against a real project on the local stack. It does the
# three things a customer would otherwise do by hand — create a project, tell it
# where its auth links may land, and hand the page the project's anon key — and
# nothing else. The page itself is plain HTML with no build step, because it is
# the auth API's first browser client and anything that fails in it is a thing a
# customer's own frontend would hit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${CB_DEMO_API:-http://127.0.0.1:8099}"
TOKEN="${CB_STATIC_TOKEN:-local-dev-only-not-a-production-credential}"
PORT="${CB_DEMO_PORT:-8123}"
ORIGIN="http://127.0.0.1:$PORT"
MAILPIT="${CB_MAILPIT_API:-http://127.0.0.1:58025}"
DB="${CB_CONTROL_DATABASE_URL:-postgres://corebase:controlpass@127.0.0.1:55433/corebase_control}"
NAME="${CB_DEMO_PROJECT:-auth-demo}"

say() { printf '  %s\n' "$*"; }

# ── preconditions, named rather than discovered ────────────────────────────
# Each of these is a thing that fails much later and much less clearly.
if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ no API at $API — run ./scripts/dev.sh in another terminal" >&2; exit 1
fi
if ! curl -fsS "$MAILPIT/api/v1/messages" >/dev/null 2>&1; then
  echo "✗ no mail sink at $MAILPIT — run ./scripts/staging.sh mail-sink" >&2; exit 1
fi
# The page is served from its own origin, so every call it makes is cross-origin.
# Without the origin allowlisted the browser refuses the preflight and the console
# says only "CORS", which is a long way from "add this to CB_DASHBOARD_ORIGINS".
PREFLIGHT="$(curl -sS -X OPTIONS "$API/auth/v1/signup" \
             -H "origin: $ORIGIN" -H 'access-control-request-method: POST' \
             -o /dev/null -w '%{http_code}' 2>/dev/null || echo 000)"
if [ "$PREFLIGHT" != "204" ]; then
  echo "✗ $API will not accept browser calls from $ORIGIN (preflight $PREFLIGHT)." >&2
  echo "  Add it to CB_DASHBOARD_ORIGINS and restart the API:" >&2
  echo "    CB_DASHBOARD_ORIGINS=\"\$CB_DASHBOARD_ORIGINS,$ORIGIN\" ./scripts/dev.sh" >&2
  exit 1
fi

echo "▸ project"
# Reuse rather than pile up. Running the demo twice should not leave two
# projects behind, and the second run wants the first one's keys anyway.
ORG="$(curl -fsS "$API/v1/orgs" -H "authorization: Bearer $TOKEN" \
       | sed -n 's/.*"id":"\(org_[^"]*\)".*/\1/p' | head -1)"
[ -n "$ORG" ] || { echo "✗ the bootstrap user belongs to no organization" >&2; exit 1; }

# `org_id` on the *list* as well as the create. Both refuse to guess when the
# caller belongs to several organizations — correctly, and it is the same trap
# the nightly harnesses fell into: omitting it works right up until some other
# suite creates an org.
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
  CREATED="$(curl -fsS -X POST "$API/v1/projects" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "idempotency-key: demo-$(date +%s)" \
    -d "{\"name\":\"$NAME\",\"region\":\"eu-central\",\"org_id\":\"$ORG\"}")"
  REF="$(printf '%s' "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["ref"])')"
else
  say "reusing '$NAME' ($REF)"
fi

printf '  waiting for it to be ready'
for _ in $(seq 1 90); do
  STATUS="$(curl -fsS "$API/v1/projects/$REF" -H "authorization: Bearer $TOKEN" \
            | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["status"])')"
  [ "$STATUS" = "ready" ] && break
  printf '.'; sleep 2
done
echo
[ "$STATUS" = "ready" ] || { echo "✗ project is '$STATUS', not ready" >&2; exit 1; }
say "✓ $REF is ready"

echo "▸ auth config"
# `site_url` is the only place a verification link is allowed to land, and the
# demo page is that place. Without it `GET /verify` has nowhere to redirect and
# answers in JSON instead — correct, and not the flow being demonstrated.
psql_c() { docker exec -i cb-control-db psql -U corebase -d corebase_control -qAtc "$1"; }
PROJECT_ID="$(psql_c "select id from projects where ref = '$REF'")"
psql_c "insert into project_auth_config (project_id, site_url, additional_redirects)
        values ('$PROJECT_ID', '$ORIGIN', '{}')
        on conflict (project_id) do update set site_url = '$ORIGIN'" >/dev/null
say "✓ auth links may land on $ORIGIN"
say "  autoconfirm is OFF, which is the default and the point — the demo verifies"
say "  a real address rather than skipping the step"

echo "▸ keys"
ANON="$(curl -fsS "$API/v1/projects/$REF/keys?reveal=true" -H "authorization: Bearer $TOKEN" \
        | python3 -c "
import json,sys
for k in json.load(sys.stdin)['api_keys']:
    if k['kind'] == 'anon':
        print(k.get('key') or ''); break
")"
[ -n "$ANON" ] || { echo "✗ could not read the project's anon key" >&2; exit 1; }
say "✓ anon key read (service_role is deliberately not on this page)"

cat > "$ROOT/demo/auth/config.js" <<CFGEOF
// Written by ./scripts/auth-demo.sh — gitignored, and regenerated on every run.
//
// The **anon** key only. It is published in client code by design (D-029), so a
// browser holding it is the intended state. A service_role key here would hand
// every visitor the ability to read every user's row, which is why nothing on
// this page ever sees one.
window.COREBASE_DEMO = {
  apiBase: '$API',
  ref: '$REF',
  anonKey: '$ANON',
  mailpit: '$MAILPIT',
};
CFGEOF
say "✓ demo/auth/config.js"

echo
echo "▸ serving  $ORIGIN"
echo "  inbox    $MAILPIT"
echo "  Sign up, then press \"Find it in the inbox\" — the page reads the message"
echo "  the worker actually delivered over SMTP and pulls the token out of it."
echo
echo "  The link inside that mail points at https://$REF.<domain>/auth/v1/verify,"
echo "  which is correct for production and not reachable from a laptop without"
echo "  wildcard DNS and a TLS terminator. The token is the same either way — an"
echo "  SDK posts it to /verify exactly as the page does."
echo
cd "$ROOT/demo/auth"
# serve.py rather than http.server: it also proxies the sink's read API under
# `/inbox`, because the sink sends no CORS headers and a page on another origin
# cannot otherwise read its own confirmation mail. One origin makes step 2 a
# single click on a genuinely delivered message.
exec python3 serve.py "$PORT"
