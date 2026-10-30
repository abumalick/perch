#!/usr/bin/env bash
# `perch` on PATH (deploy/install-cli.sh links it into ~/.local/bin): runs this checkout's agent
# CLI from the caller's own directory, so `perch spawn .` means the caller's project. Never cd.
set -euo pipefail

# Follow the symlink chain to the real script (no `readlink -f`: macOS's lacks it before 12.3).
src="${BASH_SOURCE[0]}"
while [ -L "${src}" ]; do
  dir="$(cd -P "$(dirname "${src}")" && pwd)"
  src="$(readlink "${src}")"
  case "${src}" in /*) ;; *) src="${dir}/${src}" ;; esac
done
REPO="$(cd -P "$(dirname "${src}")/.." && pwd)"

# The node this checkout pins, found the way run-agent.sh finds mise (a service or a fresh shell
# may not have it on PATH). `mise where` reads the checkout's config without running anything
# there; `mise exec` would take the caller's directory's config instead.
node_bin=""
for mise_bin in "${HOME}/.local/bin/mise" /opt/homebrew/bin/mise /usr/local/bin/mise; do
  if [ -x "${mise_bin}" ]; then
    node_dir="$("${mise_bin}" where node --cd "${REPO}" 2>/dev/null || true)"
    if [ -n "${node_dir}" ] && [ -x "${node_dir}/bin/node" ]; then node_bin="${node_dir}/bin/node"; fi
    break
  fi
done
if [ -z "${node_bin}" ]; then node_bin="$(command -v node || true)"; fi
if [ -z "${node_bin}" ]; then
  echo "perch: no node found (install it with mise in ${REPO})" >&2
  exit 1
fi

# tsx by absolute path: a bare `--import tsx` would resolve from the caller's directory.
exec "${node_bin}" --import "file://${REPO}/packages/agent/node_modules/tsx/dist/loader.mjs" \
  "${REPO}/packages/agent/src/cli.ts" "$@"
