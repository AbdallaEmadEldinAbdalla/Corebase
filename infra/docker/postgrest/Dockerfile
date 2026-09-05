# corebase/postgrest — the per-project data API (D-011, D-101).
#
# Our own image for the same reason the Postgres and pooler images are ours: the
# configuration *is* the security boundary. `db-anon-role`, the JWKS path, the
# role-claim key and `db-max-rows` are decisions with rationale recorded in
# docs/04-data-api/01-rest-api-design.md, and an image whose entrypoint accepted
# arbitrary config from the environment would let any of them be changed by
# accident. Everything that varies per project is a value; every rule is baked in.
#
# One version fleet-wide (D-102), mirroring D-037's one-Postgres-version rule: a
# PostgREST upgrade is *our* migration project, never a customer's surprise.
# **The binary is copied out of the official image rather than built on top of
# it, because that image is not the same thing on every architecture.** On arm64
# it is Ubuntu-based with a full userland; on amd64 it is a single scratch layer
# holding the static binary and nothing else — no shell, no `/etc/passwd`, no
# apt. A `FROM` here therefore built cleanly on an arm64 laptop and failed on
# CI's amd64 runners with `unable to find user root`, which names neither the
# cause nor the architecture.
#
# Copying the binary onto a base we choose makes the image identical everywhere
# and gives the entrypoint the shell, `envsubst` and `gosu` it needs. PostgREST
# is a statically linked Haskell binary, so it has no runtime dependency on the
# distribution it sits on.
FROM postgrest/postgrest:v12.2.3 AS upstream

FROM debian:bookworm-slim

# Not decorative. PostgREST reads its config file with the *locale's* encoding,
# and the default is ASCII — so a single non-ASCII character anywhere in the
# file, including in a comment, kills startup with `hGetContents: invalid
# argument (cannot decode byte sequence starting from 226)`. That is 0xE2, the
# first byte of an em dash, and the message says nothing about which file or
# which line. The config below is heavily commented and those comments are worth
# keeping legible, so the locale changes rather than the prose.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# `postgrest` is created explicitly rather than inherited, because the uid the
# entrypoint drops to must be the same on every architecture — it is the uid that
# owns nothing and can write nothing, and a base-image default that differs by
# arch would make that guarantee arch-dependent too.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gosu gettext-base ca-certificates libpq5; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 postgrest; \
    useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin postgrest; \
    mkdir -p /etc/postgrest; \
    gosu nobody true

COPY --from=upstream /bin/postgrest /usr/local/bin/postgrest
RUN postgrest --version

COPY postgrest.conf.template /etc/postgrest/postgrest.conf.template
COPY entrypoint.sh /usr/local/bin/corebase-entrypoint.sh
RUN chmod +x /usr/local/bin/corebase-entrypoint.sh

# 3000 serves the API; 3001 is the admin server, which is where `/live` and
# `/ready` live. The reconciler wants a liveness answer that does not touch the
# database and a readiness answer that does — the admin server is the only place
# that distinction exists.
EXPOSE 3000 3001

# No HEALTHCHECK, for the same reason the pooler has none: the provisioning saga's
# gate asks the admin server's `/ready`, which proves PostgREST reached Postgres
# and built a schema cache. A container-local check could only prove the process
# is listening, which is the least interesting half.
ENTRYPOINT ["/usr/local/bin/corebase-entrypoint.sh"]
