#!/usr/bin/env bash
# Launch the self-hosted Perch relay for a service manager. Its configuration (the agents it
# serves, the bind address, the limits) is ~/.perch/relay/config.json, outside any checkout.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run the relay from the deploy/relay-live target when it resolves, so a worktree's relay can be
# served (see deploy/serve-relay.sh). A missing or dangling symlink falls back to main.
TARGET="${REPO}"
LIVE="${REPO}/deploy/relay-live"
if [ -e "${LIVE}" ]; then TARGET="$(cd "${LIVE}" && pwd -P)"; fi
cd "${TARGET}"
# Service managers don't inherit an interactive PATH, so pnpm/node (managed by mise) may be
# absent. Run through mise when we can find it.
for mise_bin in "${HOME}/.local/bin/mise" /opt/homebrew/bin/mise /usr/local/bin/mise; do
  if [ -x "${mise_bin}" ]; then
    exec "${mise_bin}" exec -- pnpm --filter @perch/relay exec tsx src/main.ts
  fi
done
exec pnpm --filter @perch/relay exec tsx src/main.ts
