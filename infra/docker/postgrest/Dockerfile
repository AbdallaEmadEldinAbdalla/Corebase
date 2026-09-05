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
FROM postgrest/postgrest:v12.2.3

# Root only to lay out the config directory and install gosu; the entrypoint
# renders config as root and then drops back to the image's own unprivileged user
# before exec, so PostgREST itself never runs as root and never writes anything
# after startup. The upstream image is Ubuntu-based and runs as uid 1000
# (`ubuntu`), which is the user dropped to.
# Not decorative. PostgREST reads its config file with the *locale's* encoding,
# and the base image's default is ASCII — so a single non-ASCII character
# anywhere in the file, including in a comment, kills startup with
# `hGetContents: invalid argument (cannot decode byte sequence starting from
# 226)`. That is 0xE2, the first byte of an em dash, and the message says nothing
# about which file or which line. The config below is heavily commented and those
# comments are worth keeping legible, so the locale changes rather than the prose.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gosu; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /etc/postgrest; \
    gosu nobody true

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
