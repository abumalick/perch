#!/usr/bin/env bash
# Tests for deploy/install-cli.sh and the deploy/tarfa-cli.sh shim it links.
# install-cli.sh runs under a fake HOME, so the real ~/.local/bin is never touched. The shim runs
# under the real HOME (mise needs it to find node) but only on paths that fail before any file
# or tmux server is touched, and should one reach tmux, it finds an empty sandbox instead of the
# server of the pane this test runs in.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
mkdir -p "${REPO}/.tmp"
SANDBOX="$(mktemp -d "${REPO}/.tmp/tarfa-cli-test.XXXXXX")"
trap 'rm -rf "${SANDBOX}"' EXIT
unset TMUX TMUX_PANE
export TMUX_TMPDIR="${SANDBOX}"

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
LINK="${FAKE_HOME}/.local/bin/tarfa"
OLD="${FAKE_HOME}/.local/bin/perch"

install
check "links ~/.local/bin/tarfa to the shim" "${HERE}/tarfa-cli.sh" "$(readlink "${LINK}")"
check "keeps ~/.local/bin/perch as a link to tarfa" "tarfa" "$(readlink "${OLD}")"
status=0; install || status=$?
check "re-running succeeds" "0" "${status}"
check "re-running keeps the link" "${HERE}/tarfa-cli.sh" "$(readlink "${LINK}")"

ln -sfn /nowhere "${LINK}"
install
check "replaces a stale link" "${HERE}/tarfa-cli.sh" "$(readlink "${LINK}")"

rm "${LINK}"
printf 'mine\n' > "${LINK}"
status=0; install || status=$?
check "refuses to replace a file that is not a link" "1" "${status}"
check "leaves that file untouched" "mine" "$(cat "${LINK}")"
rm "${LINK}" "${OLD}"
printf 'mine\n' > "${OLD}"
status=0; install || status=$?
check "refuses to replace a perch that is not a link" "1" "${status}"
check "and creates no tarfa link then" "absent" "$([ -e "${LINK}" ] || [ -L "${LINK}" ] && echo present || echo absent)"
rm "${OLD}"

echo "tarfa-cli.sh"
mkdir -p "${SANDBOX}/bin" "${SANDBOX}/cwd"
ln -s "${HERE}/tarfa-cli.sh" "${SANDBOX}/bin/tarfa"
# The old name, a link to the link, as install-cli.sh leaves it.
ln -s tarfa "${SANDBOX}/bin/perch"
NO_ENV="${SANDBOX}/no-agent.env"

status=0
out="$(cd "${SANDBOX}/cwd" && TARFA_AGENT_ENV="${NO_ENV}" "${SANDBOX}/bin/perch" peek 2>&1)" || status=$?
check "runs the CLI through its old name, two links deep, from another directory" "usage: tarfa peek <workspace id> [-n <lines>]" "${out}"
check "a CLI error exits 1" "1" "${status}"

# The shim must not cd: a relative path is the caller's, so the error names it under the cwd.
status=0
out="$(cd "${SANDBOX}/cwd" && TARFA_AGENT_ENV="${NO_ENV}" "${SANDBOX}/bin/tarfa" spawn nope < /dev/null 2>&1)" || status=$?
check "resolves a spawn path against the caller's directory" "not a directory: ${SANDBOX}/cwd/nope" "${out}"

# A ~/.local/bin/perch installed before the rename names deploy/perch-cli.sh, kept as a link.
ln -s "${HERE}/perch-cli.sh" "${SANDBOX}/bin/old-perch"
status=0
out="$(cd "${SANDBOX}/cwd" && TARFA_AGENT_ENV="${NO_ENV}" "${SANDBOX}/bin/old-perch" peek 2>&1)" || status=$?
check "an install from before the rename still runs through deploy/perch-cli.sh" "usage: tarfa peek <workspace id> [-n <lines>]" "${out}"

if [ "${fails}" -gt 0 ]; then
  echo "${fails} check(s) failed"
  exit 1
fi
echo "all tarfa-cli checks passed"
