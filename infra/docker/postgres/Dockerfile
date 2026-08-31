# corebase/postgres — the per-project database image (D-009, D-054).
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
      build-essential=12.9 \
      ca-certificates \
    ; \
    apt-get purge -y --auto-remove build-essential; \
    rm -rf /var/lib/apt/lists/*

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
ENV POSTGRES_INITDB_ARGS="--auth-local=peer --auth-host=scram-sha-256"

# Config template. Small-tenant defaults: max_connections is 20 because the
# pooler multiplexes in front of it (D-074's 3 reserved / 7 PostgREST / 8 pooler
# / 2 direct budget). Sized for the Free-tier 512 MiB cgroup.
COPY postgresql.base.conf /etc/corebase/postgresql.base.conf
COPY init/ /docker-entrypoint-initdb.d/

# archive_command target; the pgBackRest sidecar consumes this directory.
RUN mkdir -p /var/lib/postgresql/wal_archive \
    && chown -R postgres:postgres /var/lib/postgresql/wal_archive /etc/corebase

USER postgres
CMD ["postgres", "-c", "config_file=/etc/corebase/postgresql.base.conf"]
