#!/usr/bin/env bash
# Rent a real node by the hour, and give it back.
#
# The corpus commits to Hetzner (D-023) in eu-central (D-024) with the launch SKU
# locked as CCX43 (D-140). What it does not commit to is renting one by the month
# during implementation: Hetzner Cloud bills hourly, capped at the monthly rate, so
# the gaps that need real hardware — D-209's density triplet on x86, D-070's XFS
# quotas, OQ-182's restore contention — cost about a euro per session instead of
# €100+ a month.
#
# Which is only true if creating and destroying a node is one command. By hand it
# is a dozen steps and the temptation is to leave the box running, which is how an
# hourly strategy quietly becomes a monthly bill. Hence this.
#
# The bootstrap lives in infra/hcloud/cloud-init.yaml rather than in here, because
# D-022 asks for cloud-init and a node the fleet can recreate is worth more than a
# box someone configured once.
set -euo pipefail

NAME="${SH_NODE_NAME:-steadhold-bench}"
# CCX43 is the locked launch SKU (D-140), so a measurement taken on it is the real
# number rather than a proxy that has to be retaken later.
TYPE="${SH_NODE_TYPE:-ccx43}"
LOCATION="${SH_NODE_LOCATION:-nbg1}"   # eu-central, per D-024
IMAGE="${SH_NODE_IMAGE:-ubuntu-24.04}"
VOLUME_GB="${SH_NODE_VOLUME_GB:-50}"   # D-070 needs a disk to make XFS; 1 TB is for prod
SSH_KEY="${SH_NODE_SSH_KEY:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

need() { command -v "$1" >/dev/null || { echo "✗ $1 is not installed" >&2; exit 1; }; }

# ── ARM is not a substitute, and this is the one guard that matters ────────────
# D-209 forbids re-basing the density model on ARM. Hetzner's CAX line is Ampere,
# it is cheaper, and it is exactly the wrong thing to accidentally rent for the
# measurement this script exists to make possible — the whole cost model rests on
# that number, and an ARM figure would look like data.
assert_x86() {
  case "$TYPE" in
    cax*) echo "✗ $TYPE is ARM (Ampere). D-209 forbids density measurements on ARM —" >&2
          echo "  the cost model rests on an x86 number. Use ccx43/cpx41/cx32." >&2
          exit 1 ;;
  esac
}

cmd_up() {
  need hcloud; assert_x86
  : "${HCLOUD_TOKEN:?set HCLOUD_TOKEN (Hetzner Cloud console → Security → API tokens, read+write)}"
  if hcloud server describe "$NAME" >/dev/null 2>&1; then
    echo "▸ $NAME already exists — reusing it"
  else
    local keyarg=()
    if [ -n "$SSH_KEY" ]; then keyarg=(--ssh-key "$SSH_KEY"); else
      echo "  ! no SH_NODE_SSH_KEY set — Hetzner will email a root password instead" >&2
    fi
    echo "▸ creating $NAME ($TYPE, $LOCATION, $IMAGE)"
    hcloud server create --name "$NAME" --type "$TYPE" --location "$LOCATION" \
      --image "$IMAGE" --user-data-from-file "$HERE/infra/hcloud/cloud-init.yaml" \
      "${keyarg[@]}" >/dev/null
    echo "▸ attaching a ${VOLUME_GB}G volume for the XFS data disk (D-070)"
    hcloud volume create --name "${NAME}-data" --size "$VOLUME_GB" \
      --location "$LOCATION" --format xfs >/dev/null 2>&1 || true
    hcloud volume attach "${NAME}-data" --server "$NAME" --automount=false >/dev/null 2>&1 || true
  fi
  local ip; ip="$(hcloud server ip "$NAME")"
  echo "  ✓ $NAME at $ip"
  echo
  echo "  Wait for cloud-init, then check the thing that silently does not work:"
  echo "    ssh root@$ip 'cloud-init status --wait && findmnt -no OPTIONS /var/lib/steadhold-data'"
  echo "  It must contain prjquota. A filesystem mounted without it accepts every"
  echo "  quota command and enforces nothing (D-070)."
  echo
  echo "  When you are done — and this is the point of the whole script:"
  echo "    $0 down"
}

cmd_down() {
  need hcloud
  : "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}"
  hcloud server describe "$NAME" >/dev/null 2>&1 || { echo "▸ $NAME does not exist"; return 0; }
  # Deleting the server does not delete the volume, and a forgotten 1 TB volume
  # costs more per month than the hours the server ran.
  hcloud volume detach "${NAME}-data" >/dev/null 2>&1 || true
  hcloud volume delete "${NAME}-data" >/dev/null 2>&1 || true
  hcloud server delete "$NAME" >/dev/null
  echo "  ✓ $NAME and its volume are gone"
}

cmd_status() {
  need hcloud
  : "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}"
  if ! hcloud server describe "$NAME" -o json >/dev/null 2>&1; then
    echo "▸ no node — nothing is being billed"; return 0
  fi
  hcloud server describe "$NAME" -o json | python3 -c '
import json, sys, datetime
s = json.load(sys.stdin)
created = datetime.datetime.fromisoformat(s["created"].replace("Z", "+00:00"))
hours = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() / 3600
print(f"  {s[\"name\"]}  {s[\"server_type\"][\"name\"]}  {s[\"status\"]}  up {hours:.1f}h")
# Hourly billing is capped at the monthly price, so the warning is about the cap
# rather than about the money: past a few days there is no saving left to lose.
if hours > 48:
    print(f"  ! up {hours/24:.1f} days. Hourly billing caps at the monthly rate, so an")
    print( "    hourly strategy has stopped saving anything. Destroy it or accept the month.")
'
}

cmd_ssh() { need hcloud; ssh "root@$(hcloud server ip "$NAME")" "$@"; }

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  ssh) shift; cmd_ssh "$@" ;;
  *) cat <<USAGE
usage: $0 {up|down|status|ssh}

  up      create the node (cloud-init does the baseline) and attach an XFS volume
  down    destroy the node AND its volume — the volume is the one people forget
  status  what is running and for how long
  ssh     shell in

env:
  HCLOUD_TOKEN         required. Hetzner console → Security → API tokens (read+write)
  SH_NODE_TYPE         default ccx43 (the D-140 launch SKU). cax* is refused: ARM.
  SH_NODE_SSH_KEY      name of a key already uploaded to Hetzner
  SH_NODE_VOLUME_GB    default 50. Prod is 1 TB; a bench does not need it.
USAGE
     exit 2 ;;
esac
