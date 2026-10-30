#!/usr/bin/env bash
# Tests for deploy/install-cli.sh and the deploy/perch-cli.sh shim it links.
# install-cli.sh runs under a fake HOME, so the real ~/.local/bin is never touched. The shim runs
# under the real HOME (mise needs it to find node) but only on paths that fail before any file
# or tmux server is touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
mkdir -p "${REPO}/.tmp"
SANDBOX="$(mktemp -d "${REPO}/.tmp/perch-cli-test.XXXXXX")"
trap 'rm -rf "${SANDBOX}"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ok: $1"
  else
    echo "  FAIL: $1"
    echo "    expected: $2"
    echo "    actual:   $3"
    fails=$((fails + 1))
  fi
}

echo "install-cli.sh"
FAKE_HOME="${SANDBOX}/home"
mkdir -p "${FAKE_HOME}"
install() { HOME="${FAKE_HOME}" bash "${HERE}/install-cli.sh" > /dev/null 2>&1; }
LINK="${FAKE_HOME}/.local/bin/perch"

install
check "links ~/.local/bin/perch to the shim" "${HERE}/perch-cli.sh" "$(readlink "${LINK}")"
status=0; install || status=$?
check "re-running succeeds" "0" "${status}"
check "re-running keeps the link" "${HERE}/perch-cli.sh" "$(readlink "${LINK}")"

ln -sfn /nowhere "${LINK}"
install
check "replaces a stale link" "${HERE}/perch-cli.sh" "$(readlink "${LINK}")"

rm "${LINK}"
printf 'mine\n' > "${LINK}"
status=0; install || status=$?
check "refuses to replace a file that is not a link" "1" "${status}"
check "leaves that file untouched" "mine" "$(cat "${LINK}")"

echo "perch-cli.sh"
mkdir -p "${SANDBOX}/bin" "${SANDBOX}/cwd"
ln -s "${HERE}/perch-cli.sh" "${SANDBOX}/bin/perch"
NO_ENV="${SANDBOX}/no-agent.env"

status=0
out="$(cd "${SANDBOX}/cwd" && PERCH_AGENT_ENV="${NO_ENV}" "${SANDBOX}/bin/perch" peek 2>&1)" || status=$?
check "runs the CLI through a symlink, from another directory" "usage: perch peek <workspace id> [-n <lines>]" "${out}"
check "a CLI error exits 1" "1" "${status}"

# The shim must not cd: a relative path is the caller's, so the error names it under the cwd.
status=0
out="$(cd "${SANDBOX}/cwd" && PERCH_AGENT_ENV="${NO_ENV}" "${SANDBOX}/bin/perch" spawn nope < /dev/null 2>&1)" || status=$?
check "resolves a spawn path against the caller's directory" "not a directory: ${SANDBOX}/cwd/nope" "${out}"

if [ "${fails}" -gt 0 ]; then
  echo "${fails} check(s) failed"
  exit 1
fi
echo "all perch-cli checks passed"
