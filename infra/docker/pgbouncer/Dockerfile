# corebase/pgbouncer — the per-project connection pooler (D-015, D-074).
#
# Our own image rather than a community one, for the same reason the Postgres
# image is ours: the configuration *is* the security boundary here. The pool mode,
# the auth_query wiring and the pool arithmetic are decisions with rationale
# recorded in docs/03-database-platform/02-connection-pooling.md, and an image
# whose entrypoint accepts arbitrary config from the environment would let any of
# them be changed by accident. Everything that varies per project is a value; every
# rule is baked in.
#
# Pinned to a version ≥ 1.21 on purpose: that is where protocol-level prepared
# statement tracking (`max_prepared_statements`) arrived, and without it
# transaction pooling breaks node-postgres, psycopg and most ORMs out of the box.
FROM alpine:3.21

# pgbouncer 1.23 on Alpine 3.21. `--no-cache` keeps the layer small; there is no
# build step, so nothing needs purging afterwards.
RUN set -eux; \
    apk add --no-cache pgbouncer=1.23.1-r0 postgresql17-client su-exec; \
    pgbouncer --version

# Our own service user, created here rather than inherited from the package —
# Alpine's pgbouncer package creates none, and relying on a package to provide a
# uid is a dependency on something that is not part of its contract. The
# entrypoint renders config as root, then drops to this user to exec the daemon:
# the pooler never runs as root and never writes anything after startup.
RUN addgroup -S pgbouncer && adduser -S -D -H -G pgbouncer -s /sbin/nologin pgbouncer
ENV PGB_UID=pgbouncer

COPY pgbouncer.ini.template /etc/pgbouncer/pgbouncer.ini.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 6432

# No HEALTHCHECK here on purpose. The provisioning saga's gate connects *through*
# the pooler to Postgres and runs a query, which proves the whole chain —
# pooler → auth_query → database. A container-local healthcheck could only prove
# the process is listening, which is the least interesting half.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
