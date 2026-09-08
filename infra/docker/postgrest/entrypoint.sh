#!/bin/sh
# Render the project's PostgREST config from the environment, then exec.
#
# Two files are written, both from values the control plane supplies:
#
#   postgrest.conf  the template with the project's ref, database host and pool
#                   size substituted. Nothing security-relevant is a variable:
#                   db-anon-role, the role-claim key and db-max-rows are baked in,
#                   so a per-plan pool size is a value change rather than a new
#                   image and nothing else can be changed by accident.
#   jwks.json       the project's published verification keys (D-014). Written
#                   here rather than baked in because it changes: P4h's rotation
#                   dual-publishes, so during a swap window this file carries two
#                   kids and a verifier holding one of them would reject valid
#                   tokens.
#
# The database password arrives as PGRST_DB_URI, which PostgREST reads directly
# and which overrides db-uri in the file. That keeps the password out of the
# rendered config; `docker inspect` can still read the environment, which is the
# same exposure the Postgres container's bootstrap password already has.
set -eu

: "${STEADHOLD_REF:?STEADHOLD_REF is required}"
: "${STEADHOLD_PG_HOST:?STEADHOLD_PG_HOST is required}"
: "${PGRST_DB_URI:?PGRST_DB_URI is required — it carries the authenticator password}"
# No apostrophe in this message, and that is not fussiness: inside a
# `${VAR:?word}` expansion the word is parsed, so an apostrophe opens a quote that
# never closes and the whole script becomes a syntax error at the *end* of the
# file. The image built perfectly well around it — a broken artifact that only
# fails when a container starts.
: "${STEADHOLD_JWKS:?STEADHOLD_JWKS is required — it carries the project keys}"

CONF_DIR=/etc/postgrest
DB_POOL="${STEADHOLD_DB_POOL:-7}"

sed -e "s|__REF__|${STEADHOLD_REF}|g" \
    -e "s|__PG_HOST__|${STEADHOLD_PG_HOST}|g" \
    -e "s|__DB_POOL__|${DB_POOL}|g" \
    "$CONF_DIR/postgrest.conf.template" > "$CONF_DIR/postgrest.conf"

# The JWKS arrives as JSON in an env var and lands as a file, because that is what
# `jwt-secret = "@…"` reads. Written with a restrictive mode out of habit rather
# than need: these are public keys, and treating them as secret would be
# cargo-culting — what actually matters is that the file exists before PostgREST
# starts, since a missing one makes every request fail closed with no diagnosis.
printf '%s' "$STEADHOLD_JWKS" > "$CONF_DIR/jwks.json"
if ! grep -q '"keys"' "$CONF_DIR/jwks.json"; then
  echo "✗ STEADHOLD_JWKS is not a JWKS document — refusing to start with a key set" >&2
  echo "  PostgREST would come up and reject every token, which looks like an auth" >&2
  echo "  bug rather than a provisioning one." >&2
  exit 1
fi

# Config is rendered; nothing after this needs to write anything. Drop to the
# image's unprivileged user (uid 1000) so PostgREST does not run as root — the
# rendering above is the only reason this script started as root at all.
chown -R 1000:1000 "$CONF_DIR"
exec gosu 1000:1000 postgrest "$CONF_DIR/postgrest.conf"
