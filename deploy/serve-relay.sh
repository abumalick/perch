#!/usr/bin/env bash
# Temporarily run the self-hosted relay service from a worktree's source, so a relay change can
# be tried against the real agent and phone without merging — the relay equivalent of
# serve-agent.sh. Flips the deploy/relay-live symlink (which run-relay.sh runs the relay from)
# and restarts the service. The configuration stays ~/.perch/relay/config.json whichever
# checkout runs, so a flip never changes the agents served. See docs/relay-cf-runbook.md.
#
#   pnpm serve:relay <worktree-path>   # run that worktree's relay live
#   pnpm serve:relay-restore           # point back at main's relay
#   pnpm serve:relay-heal              # restore main only if relay-live dangles
#
# Set PERCH_SKIP_RESTART=1 to flip the symlink without restarting (used by the tests).
set -euo pipefail
# The main checkout, wherever this copy runs from: the live symlinks the services read are main's.
REPO="$(cd "$(dirname "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)")" && pwd)"
LIVE="${REPO}/deploy/relay-live"

# A restart drops every relayed connection; the agent's control link and the phone both
# reconnect on their own.
restart_relay() {
  if [ -n "${PERCH_SKIP_RESTART:-}" ]; then return 0; fi
  if command -v systemctl >/dev/null 2>&1 \
     && systemctl --user list-unit-files perch-relay.service >/dev/null 2>&1; then
    systemctl --user restart perch-relay
  else
    echo "warning: no perch-relay user service found; restart the relay manually." >&2
  fi
}

restore_main() { ln -sfn "${REPO}" "${LIVE}"; }

if [ "${1:-}" = "--restore" ]; then
  restore_main
  restart_relay
  echo "Restored: relay running from main."
  exit 0
fi

if [ "${1:-}" = "--heal" ]; then
  # A symlink that exists but resolves to nothing means its worktree was removed out from
  # under the live relay. Fall back to main so the next (re)start runs a valid checkout.
  if [ -L "${LIVE}" ] && [ ! -e "${LIVE}" ]; then
    restore_main
    restart_relay
    echo "Healed: relay-live was dangling; restored main."
  else
    echo "relay-live is healthy; nothing to heal."
  fi
  exit 0
fi

WT_ARG="${1:?usage: serve-relay.sh <worktree-path> | --restore | --heal}"
WT="$(cd "${WT_ARG}" && pwd)"   # absolutize; fails loudly if the path is missing
SLUG="$(basename "${WT}")"

ln -sfn "${WT}" "${LIVE}"
restart_relay
echo "Now running the relay from '${SLUG}'. Restore main with: pnpm serve:relay-restore"
