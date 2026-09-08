#!/usr/bin/env bash
# Phase 6 demo (roadmap §Phase 6): "avatar upload from the phase-4 demo page,
# public URL renders, signed URL expires."
#
# Built on Phase 4's flow rather than beside it: a signed-in user uploads *their
# own* avatar, which is the only version of this demo that shows anything. The
# whole point of the avatars pattern is that the path carries the owner's id and
# the policy enforces it — with no user there is nothing for a policy to be about.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${SH_DEMO_API:-http://127.0.0.1:8099}"
TOKEN="${SH_STATIC_TOKEN:-local-dev-only-not-a-production-credential}"
PORT="${SH_DEMO_PORT:-8125}"
ORIGIN="http://127.0.0.1:$PORT"
DOMAIN="${SH_PROJECT_DOMAIN:-localhost}"
NAME="${SH_DEMO_PROJECT:-storage-demo}"

say() { printf '  %s\n' "$*"; }
jq_py() { python3 -c "import json,sys; $1"; }

if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ no API at $API — run ./scripts/dev.sh in another terminal" >&2; exit 1
fi
# The object store is the one precondition whose absence is invisible until an
# upload fails, so it is checked here rather than discovered later.
if ! curl -fsS "$API/health" -o /dev/null; then :; fi
if [ ! -f "$ROOT/infra/docker/staging/backup-store.env" ]; then
  echo "✗ no object store — run ./scripts/staging.sh backup-store" >&2
  echo "  Without it the API registers no /storage/v1/object routes at all," >&2
  echo "  and every upload on the page would 404 for a reason the page cannot see." >&2
  exit 1
fi

echo "▸ project"
ORG="$(curl -fsS "$API/v1/orgs" -H "authorization: Bearer $TOKEN" \
       | sed -n 's/.*"id":"\(org_[^"]*\)".*/\1/p' | head -1)"
[ -n "$ORG" ] || { echo "✗ the bootstrap user belongs to no organization" >&2; exit 1; }

REF="$(curl -fsS "$API/v1/projects?limit=100&org_id=$ORG" -H "authorization: Bearer $TOKEN" \
       | SH_NAME="$NAME" python3 -c "
import json, os, sys
want = os.environ['SH_NAME']
for p in json.load(sys.stdin).get('projects', []):
    if p.get('name') == want:
        print(p['ref']); break
")"
if [ -z "$REF" ]; then
  say "creating '$NAME'"
  REF="$(curl -fsS -X POST "$API/v1/projects" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H "idempotency-key: storage-demo-$(date +%s)" \
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

echo "▸ buckets and the avatar policy, as a customer would write them"
DIRECT="$(curl -fsS "$API/v1/projects/$REF?reveal=true" -H "authorization: Bearer $TOKEN" \
          | jq_py "
d=json.load(sys.stdin)
print((d.get('database') or {}).get('connection_strings',{}).get('direct',''))")"
[ -n "$DIRECT" ] || { echo "✗ the project detail revealed no direct connection string" >&2; exit 1; }

# Printed before it runs. The policy *is* the demo: everything the page can and
# cannot do below follows from these six lines.
SQL=$(cat <<'DDL'
insert into storage.buckets (name, public) values ('avatars', false)
  on conflict (name) do nothing;
insert into storage.buckets (name, public) values ('signage', true)
  on conflict (name) do nothing;

-- The documented avatars pattern. `prefix_owner` is the first path segment, so
-- `avatars/<uid>/photo.png` belongs to <uid> and nobody else can write there.
-- `bucket_id` is a SECURITY DEFINER lookup because a policy's subselect runs as
-- the caller, and storage.buckets is closed to them (D-392).
create policy "avatars are readable by signed-in users"
  on storage.objects for select to authenticated
  using (bucket_id = storage.bucket_id('avatars'));

create policy "users manage their own avatar folder"
  on storage.objects for all to authenticated
  using (bucket_id = storage.bucket_id('avatars')
         and storage.prefix_owner(name) = auth.uid()::text)
  with check (bucket_id = storage.bucket_id('avatars')
              and storage.prefix_owner(name) = auth.uid()::text);

-- The public bucket needs no policy for reads: a public bucket *is* the ACL.
DDL
)
printf '%s\n' "$SQL" | sed 's/^/      /'
printf '%s' "$SQL" | psql "$DIRECT" -q -v ON_ERROR_STOP=1 2>&1 | grep -v 'already exists' || true
say "✓ applied over the project's own DATABASE_URL"

echo "▸ two users"
PROJECT_ID="$(docker exec -i sh-control-db psql -U steadhold -d steadhold_control -qAtc \
  "select id from projects where ref = '$REF'")"
docker exec -i sh-control-db psql -U steadhold -d steadhold_control -qAtc \
  "insert into project_auth_config (project_id, autoconfirm, site_url)
   values ('$PROJECT_ID', true, '$ORIGIN')
   on conflict (project_id) do update set autoconfirm = true, site_url = '$ORIGIN'" >/dev/null
for u in "alice@example.com" "bob@example.com"; do
  CODE="$(curl -sS -X POST "$API/auth/v1/signup" -H "apikey: $ANON" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$u\",\"password\":\"demo-password-123\"}" -o /dev/null -w '%{http_code}')"
  case "$CODE" in 200|201) say "✓ $u created" ;; *) say "· $u already exists" ;; esac
done

echo "▸ a poster in the public bucket, uploaded by the backend"
# service_role, from here, exactly as Phase 5's demo seeded rows: the page never
# holds a key that bypasses RLS.
POSTER="$ROOT/demo/storage/poster.png"
python3 - "$POSTER" <<'PY'
import struct, sys, zlib
# A 64×64 PNG written by hand rather than committed as a binary blob: a demo
# asset should be reproducible from the script that uses it.
w = h = 64
rows = b''.join(
    b'\x00' + bytes(v for x in range(w) for v in (
        40 + (x * 3) % 200, 90, 200 - (y * 2) % 150))
    for y in range(h))
def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(rows, 9))
       + chunk(b'IEND', b''))
open(sys.argv[1], 'wb').write(png)
PY
UP="$(curl -sS -X POST "$API/storage/v1/object/signage/poster.png" \
  -H "Host: $REF.$DOMAIN" -H "apikey: $SERVICE" -H 'content-type: image/png' \
  -H 'x-upsert: true' --data-binary "@$POSTER" -o /dev/null -w '%{http_code}')"
say "✓ poster.png uploaded (HTTP $UP)"

cat > "$ROOT/demo/storage/config.js" <<CFGEOF
// Written by ./scripts/storage-demo.sh — gitignored, regenerated on every run.
//
// The **anon** key only, and for storage that matters more than anywhere else: a
// service_role key here would let any visitor read every user's private files,
// because service_role bypasses RLS by role attribute (D-082).
window.STEADHOLD_DEMO = {
  ref: '$REF',
  anonKey: '$ANON',
};
CFGEOF
say "✓ demo/storage/config.js (anon key only)"

echo
echo "▸ serving  $ORIGIN"
echo
echo "  Log in as alice or bob, upload an avatar, then try to write into the"
echo "  other user's folder. The last one is the policy doing its job."
echo
cd "$ROOT/demo/storage"
exec python3 serve.py "$PORT"
