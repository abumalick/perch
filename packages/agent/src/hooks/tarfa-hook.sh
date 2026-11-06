#!/usr/bin/env bash
# Tarfa hook for Claude Code and Codex: notify the local agent of an attention event.
# Usage: tarfa-hook.sh <Event> <port> [agent]   (the CLI's JSON payload arrives on stdin)
# `agent` names a CLI other than Claude Code (`codex`). It is spliced into the JSON body without
# escaping, so only a plain lowercase name is passed on.
event="$1"
port="${2:-8787}"
agent_field=""
[[ "${3:-}" =~ ^[a-z]+$ ]] && agent_field=",\"agent\":\"$3\""
# The workspace is the tmux session of the pane this hook runs in, and the hook names no session
# unless it can prove which one that is. TMUX and TMUX_PANE alone prove nothing: Codex runs its
# hooks in a shared background server that kept the environment of whichever pane started it,
# and an untargeted `tmux display-message` falls back to the most recently active session. Either
# would stamp the status onto an unrelated workspace, so the pane's own process must be one of
# this script's ancestors.
pane_session() {
  [ -z "${TMUX:-}" ] || [ -z "${TMUX_PANE:-}" ] && return 1
  local pane_pid session pid
  read -r pane_pid session < <(tmux display-message -p -t "${TMUX_PANE}" '#{pane_pid} #S' 2>/dev/null)
  [ -z "${session:-}" ] && return 1
  pid=$$
  for _ in $(seq 1 32); do
    [ "${pid}" = "${pane_pid}" ] && break
    pid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    [ -z "${pid}" ] || [ "${pid}" -le 1 ] && return 1
  done
  [ "${pid}" = "${pane_pid}" ] || return 1
  printf '%s' "${session}"
}
# Claude's payload is forwarded verbatim as a nested object so the agent can read
# `background_tasks` without this script needing jq (not installed on every agent machine) or
# any bash JSON parsing. The tty check keeps a hand-run hook from blocking forever on stdin.
payload=null
[ -t 0 ] || payload="$(cat)"
[ -z "$payload" ] && payload=null
if session="$(pane_session)"; then
  target="\"sessionName\":\"${session}\""
elif [ "${3:-}" = codex ] && [[ "${payload}" =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([0-9A-Za-z-]+)\" ]]; then
  # A Codex bound to the app-server daemon runs hooks in the daemon, under no pane; its
  # session_id is the thread id the agent recorded for the workspace, and the agent maps it.
  # Only id characters are taken, since the value is spliced into the body unescaped.
  target="\"thread\":\"${BASH_REMATCH[1]}\""
else
  exit 0
fi
token=""
[ -r "${HOME}/.tarfa/token" ] && token="$(cat "${HOME}/.tarfa/token")"
# Every local user can read a process's argv, so the secret goes in as a header file and the body
# on stdin: `printf` is a shell builtin and puts neither on any command line.
printf '{%s,"event":"%s"%s,"claude":%s}' "${target}" "${event}" "${agent_field}" "${payload}" |
  curl -s -m 2 -X POST "http://127.0.0.1:${port}/hooks" \
    -H 'content-type: application/json' \
    -H @<(printf 'authorization: Bearer %s\n' "${token}") \
    --data-binary @- >/dev/null 2>&1 || true
exit 0
