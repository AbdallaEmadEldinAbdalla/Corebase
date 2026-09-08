# steadhold/postgres — the per-project database image (D-009, D-054).
#
# Pinned to one major fleet-wide (D-037). Extensions are allowlisted by being
# the only ones present in the image: enforcement-by-image-contents cannot be
# misconfigured, which is the point of D-078. dblink / postgres_fdw / file_fdw
# are absent on purpose — they reach the filesystem and network and would break
# tenant isolation without needing a container escape.
FROM postgres:17.5-bookworm

ARG PGVECTOR_VERSION=v0.8.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      postgresql-17-pgvector \
      pgbackrest \
      build-essential=12.9 \
      ca-certificates \
    ; \
    apt-get purge -y --auto-remove build-essential; \
    rm -rf /var/lib/apt/lists/*; \
    pgbackrest version

# D-078 is "denied by absence", so absence has to be real: the base image's
# contrib set includes extensions that reach the filesystem and the network.
# Left installed they are one `CREATE EXTENSION` away from breaking tenant
# isolation without any container escape, so the files are deleted outright.
RUN set -eux; \
    for ext in dblink postgres_fdw file_fdw; do \
      rm -f /usr/share/postgresql/17/extension/$ext*; \
      rm -f /usr/lib/postgresql/17/lib/$ext.so; \
    done; \
    # fail the build if any of them survived
    for ext in dblink postgres_fdw file_fdw; do \
      if ls /usr/share/postgresql/17/extension/ | grep -q "^$ext"; then \
        echo "FATAL: forbidden extension $ext still present (D-078)"; exit 1; \
      fi; \
    done

# Auth hardening (D-185). initdb's defaults trust the local socket and loopback,
# which makes any code execution inside the container an unauthenticated
# superuser login. `peer` keeps in-container maintenance working (OS postgres →
# db postgres) without handing that out to any other process; every host
# connection, including 127.0.0.1, needs scram. init/40-auth-hardening.sql fails
# the boot if this ever regresses.
#
# `--data-checksums` is the third argument and it was missing. Provisioning §3
# says initdb runs with it and the restore-verification checks in backups & PITR
# §7 *require* it — page-level corruption is invisible without it, so a
# verification pass would have reported a healthy restore of a rotting cluster.
# Postgres 18 turns checksums on by default; 17 does not, and the difference is
# silent in both directions.
ENV POSTGRES_INITDB_ARGS="--auth-local=peer --auth-host=scram-sha-256 --data-checksums"

# Config template. Small-tenant defaults: max_connections is 20 because the
# pooler multiplexes in front of it (D-074's 3 reserved / 7 PostgREST / 8 pooler
# / 2 direct budget). Sized for the Free-tier 512 MiB cgroup.
COPY postgresql.base.conf /etc/steadhold/postgresql.base.conf
COPY init/ /docker-entrypoint-initdb.d/

# pgBackRest's working directories (P3a).
#
# `/etc/pgbackrest` holds the per-project stanza config, rendered at provision
# time and carrying the repo cipher-pass — so it is 0600 and owned by postgres.
# The doc says "root-only", which is a node-side statement: here the process that
# must read it *is* postgres (archive_command runs as the server's own user), and
# a file only root can read is a file archiving cannot use. Container-per-project
# already gives the isolation that root ownership would buy on a shared node.
#
# `spool` is for `archive-async=y`. It lives on the project's volume mount point
# rather than in the image so the spool counts against the tenant's disk quota: a
# runaway spool has to be the tenant's ceiling, not the node's (backups §1).
#
# The old local `wal_archive` directory stays for now — nothing writes to it once
# archive_command points at pgBackRest, and removing it is a separate change from
# the one that makes archiving real.
RUN mkdir -p /var/lib/postgresql/wal_archive /etc/pgbackrest /var/log/pgbackrest \
    && chown -R postgres:postgres \
         /var/lib/postgresql/wal_archive /etc/steadhold /etc/pgbackrest /var/log/pgbackrest \
    && chmod 700 /etc/pgbackrest

USER postgres
CMD ["postgres", "-c", "config_file=/etc/steadhold/postgresql.base.conf"]
