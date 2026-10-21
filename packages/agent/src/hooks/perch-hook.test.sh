#!/usr/bin/env bash
# Tests for perch-hook.sh, the Claude Code hook that reports attention events to the
# local agent. Hermetic: fake `tmux` and `curl` on PATH, no network, no real tmux server.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${HERE}/perch-hook.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "${SANDBOX}"' EXIT

BIN="${SANDBOX}/bin"
mkdir -p "${BIN}"

# The fake answers for any pane it is asked about, as tmux does for a pane that still exists,
# naming FAKE_PANE_PID as the pane's process: the hook must check it is really running there.
cat > "${BIN}/tmux" <<'EOF'
#!/usr/bin/env bash
echo "${FAKE_PANE_PID} perch-somesession"
EOF
cat > "${BIN}/curl" <<'EOF'
#!/usr/bin/env bash
# Records what the hook gave curl: its argv (what every local user can read in /proc), the
# headers it read from a file, and the body it read from stdin.
printf '%s\n' "$@" > "${CURL_LOG}.argv"
: > "${CURL_LOG}.headers"
prev=""
for arg in "$@"; do
  if [ "$prev" = "-H" ] && [ "${arg#@}" != "$arg" ]; then cat "${arg#@}" >> "${CURL_LOG}.headers"; fi
  if [ "$prev" = "--data-binary" ] && [ "$arg" = "@-" ]; then cat > "${CURL_LOG}"; fi
  prev="$arg"
done
EOF
chmod +x "${BIN}/tmux" "${BIN}/curl"
export PATH="${BIN}:${PATH}"
export HOME="${SANDBOX}"

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

STOP_PAYLOAD='{"hook_event_name":"Stop","background_tasks":[{"id":"x","type":"shell","status":"running"}]}'

# A nested `claude -p` run by the agent (a systemd/launchd service) has no TMUX, yet the fake
# tmux above still names a session. Without the guard the hook would stamp a status onto an
# unrelated workspace — and, once the agent shells out to claude, recurse.
echo "perch-hook.sh"
export CURL_LOG="${SANDBOX}/no-tmux.txt"
: > "${CURL_LOG}"
env -u TMUX CURL_LOG="${CURL_LOG}" bash "${HOOK}" Stop 8787 <<< "${STOP_PAYLOAD}"
check "posts nothing when TMUX is unset" "" "$(cat "${CURL_LOG}")"

# Inside a real Claude session (always under tmux) the hook posts, forwarding Claude's stdin
# payload verbatim so the agent can read background_tasks.
export CURL_LOG="${SANDBOX}/with-tmux.txt"
: > "${CURL_LOG}"
TMUX="/tmp/tmux-1000/default,1,0" TMUX_PANE=%1 FAKE_PANE_PID=$$ CURL_LOG="${CURL_LOG}" bash "${HOOK}" Stop 8787 <<< "${STOP_PAYLOAD}"
body="$(cat "${CURL_LOG}")"
check "posts the session name" "perch-somesession" "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionName"])' <<< "${body}")"
check "posts the event" "Stop" "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["event"])' <<< "${body}")"
check "forwards background_tasks" "running" \
  "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["claude"]["background_tasks"][0]["status"])' <<< "${body}")"

# Codex runs its hooks in a shared background server whose environment came from whichever pane
# started it, so TMUX and TMUX_PANE can name a pane the hook is not running in. Posting then would
# stamp the status onto another workspace; the hook must post nothing instead.
sleep 30 &
stranger=$!
export CURL_LOG="${SANDBOX}/other-pane.txt"
: > "${CURL_LOG}"
TMUX="/tmp/tmux-1000/default,1,0" TMUX_PANE=%1 FAKE_PANE_PID="${stranger}" CURL_LOG="${CURL_LOG}" bash "${HOOK}" Stop 8787 codex <<< "${STOP_PAYLOAD}"
kill "${stranger}"
check "posts nothing when not running inside the pane" "" "$(cat "${CURL_LOG}")"

export CURL_LOG="${SANDBOX}/no-pane.txt"
: > "${CURL_LOG}"
env -u TMUX_PANE TMUX="/tmp/tmux-1000/default,1,0" FAKE_PANE_PID=$$ CURL_LOG="${CURL_LOG}" bash "${HOOK}" Stop 8787 <<< "${STOP_PAYLOAD}"
check "posts nothing without TMUX_PANE" "" "$(cat "${CURL_LOG}")"

# /proc/<pid>/cmdline is readable by every local user, so neither the secret nor anything Claude
# put in the payload (prompts, tool output) may reach curl's argv.
mkdir -p "${SANDBOX}/.perch"
printf 'HOOKSECRET123' > "${SANDBOX}/.perch/token"
export CURL_LOG="${SANDBOX}/argv.txt"
: > "${CURL_LOG}"
TMUX="/tmp/tmux-1000/default,1,0" TMUX_PANE=%1 FAKE_PANE_PID=$$ CURL_LOG="${CURL_LOG}" bash "${HOOK}" UserPromptSubmit 8787 <<< '{"prompt":"PROMPTMARKER"}'
argv="$(cat "${CURL_LOG}.argv")"
check "keeps the secret out of argv" "no" "$(grep -q HOOKSECRET123 <<< "${argv}" && echo yes || echo no)"
check "keeps the payload out of argv" "no" "$(grep -q PROMPTMARKER <<< "${argv}" && echo yes || echo no)"
check "sends the secret as a header" "authorization: Bearer HOOKSECRET123" "$(grep -i '^authorization' "${CURL_LOG}.headers")"
check "sends the payload as the body" "PROMPTMARKER" \
  "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["claude"]["prompt"])' < "${CURL_LOG}")"

# Claude Code always supplies stdin, but a hand-run hook or a future event might not; the body
# must stay valid JSON so the agent parses it instead of 400-ing.
export CURL_LOG="${SANDBOX}/empty-stdin.txt"
: > "${CURL_LOG}"
TMUX="/tmp/tmux-1000/default,1,0" TMUX_PANE=%1 FAKE_PANE_PID=$$ CURL_LOG="${CURL_LOG}" bash "${HOOK}" Stop 8787 < /dev/null
check "sends valid JSON with empty stdin" "null" \
  "$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["claude"]))' <<< "$(cat "${CURL_LOG}")")"

# Codex runs the same script with a third argument naming it, which the agent needs to tell a
# Codex session id from a Claude one. Claude's hooks pass none, and their body carries no agent.
export CURL_LOG="${SANDBOX}/codex.txt"
: > "${CURL_LOG}"
TMUX="/tmp/tmux-1000/default,1,0" TMUX_PANE=%1 FAKE_PANE_PID=$$ CURL_LOG="${CURL_LOG}" bash "${HOOK}" PermissionRequest 8787 codex <<< '{"tool_name":"Bash"}'
check "posts the agent when one is given" "codex" \
  "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent"])' < "${CURL_LOG}")"
check "still forwards the payload with an agent" "Bash" \
  "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["claude"]["tool_name"])' < "${CURL_LOG}")"
check "posts no agent when none is given" "None" \
  "$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("agent"))' < "${SANDBOX}/with-tmux.txt")"

if [ "${fails}" -gt 0 ]; then
  echo "${fails} check(s) failed"
  exit 1
fi
echo "all perch-hook.sh checks passed"
