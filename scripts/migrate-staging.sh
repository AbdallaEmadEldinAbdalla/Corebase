#!/usr/bin/env bash
# Milestone 0 · T3 verification — apply control-plane migrations to the staging
# control DB and assert the plan's done-signal: applies from empty, and is a
# no-op on re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
export SH_CONTROL_DATABASE_URL="${SH_CONTROL_DATABASE_URL:-postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control}"
node --experimental-strip-types packages/migrate/src/cli.ts migrations
