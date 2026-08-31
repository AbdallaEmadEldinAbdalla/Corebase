#!/bin/sh
# Render the pooler's config from the environment, then drop privileges and exec.
#
# Two files are written, both from values the control plane supplies:
#
#   pgbouncer.ini   the template with nothing substituted today, kept as a render
#                   step so a per-plan pool size (docs: "larger plans scale
#                   default_pool_size and max_connections together") is a value
#                   change rather than a new image.
#   userlist.txt    exactly one line: pgbouncer_auth and its password. This is the
#                   only secret on the pooler, and it resolves nothing on its own —
#                   the lookup function it may call returns `developer` and nothing
#                   else (D-074).
#
# The password arrives as an env var, which `docker inspect` can read. That is the
# same exposure the Postgres container's bootstrap password already has, and the
# alternative — writing the file in after create — trades it for a start-order
# problem in exchange for hiding it from a caller who can already read every
# secret on the node.
set -eu

: "${PGBOUNCER_AUTH_PASSWORD:?PGBOUNCER_AUTH_PASSWORD is required}"

CONF_DIR=/etc/pgbouncer
install -d -m 0750 -o "$PGB_UID" -g "$PGB_UID" "$CONF_DIR"

cp "$CONF_DIR/pgbouncer.ini.template" "$CONF_DIR/pgbouncer.ini"

# SCRAM verifiers contain '$'; plain text avoids a quoting class of bug here, and
# the file is 0600 owned by the pooler user inside a container that holds nothing
# else. PgBouncer reads it once at startup.
umask 077
printf '"%s" "%s"\n' pgbouncer_auth "$PGBOUNCER_AUTH_PASSWORD" > "$CONF_DIR/userlist.txt"
chown "$PGB_UID:$PGB_UID" "$CONF_DIR/userlist.txt" "$CONF_DIR/pgbouncer.ini"
chmod 0600 "$CONF_DIR/userlist.txt"

# Never as root.
exec su-exec "$PGB_UID" pgbouncer "$CONF_DIR/pgbouncer.ini"
