#!/usr/bin/env bash
# Perch hook for Claude Code and Codex: notify the local agent of an attention event.
# Usage: perch-hook.sh <Event> <port> [agent]   (the CLI's JSON payload arrives on stdin)
# `agent` names a CLI other than Claude Code (`codex`). It is spliced into the JSON body without
# escaping, so only a plain lowercase name is passed on.
event="$1"
port="${2:-8787}"
agent_field=""
[[ "${3:-}" =~ ^[a-z]+$ ]] && agent_field=",\"agent\":\"$3\""
# The workspace is the tmux session of the pane this hook runs in, and the hook posts nothing
# unless it can prove which one that is. TMUX and TMUX_PANE alone prove nothing: Codex runs its
# hooks in a shared background server that kept the environment of whichever pane started it,
# and an untargeted `tmux display-message` falls back to the most recently active session. Either
# would stamp the status onto an unrelated workspace, so the pane's own process must be one of
# this script's ancestors.
[ -z "${TMUX:-}" ] || [ -z "${TMUX_PANE:-}" ] && exit 0
read -r pane_pid session < <(tmux display-message -p -t "${TMUX_PANE}" '#{pane_pid} #S' 2>/dev/null)
[ -z "${session:-}" ] && exit 0
pid=$$
for _ in $(seq 1 32); do
  [ "${pid}" = "${pane_pid}" ] && break
  pid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')"
  [ -z "${pid}" ] || [ "${pid}" -le 1 ] && exit 0
done
[ "${pid}" = "${pane_pid}" ] || exit 0
# Claude's payload is forwarded verbatim as a nested object so the agent can read
# `background_tasks` without this script needing jq (not installed on every agent machine) or
# any bash JSON parsing. The tty check keeps a hand-run hook from blocking forever on stdin.
payload=null
[ -t 0 ] || payload="$(cat)"
[ -z "$payload" ] && payload=null
token=""
[ -r "${HOME}/.perch/token" ] && token="$(cat "${HOME}/.perch/token")"
# Every local user can read a process's argv, so the secret goes in as a header file and the body
# on stdin: `printf` is a shell builtin and puts neither on any command line.
printf '{"sessionName":"%s","event":"%s"%s,"claude":%s}' "${session}" "${event}" "${agent_field}" "${payload}" |
  curl -s -m 2 -X POST "http://127.0.0.1:${port}/hooks" \
    -H 'content-type: application/json' \
    -H @<(printf 'authorization: Bearer %s\n' "${token}") \
    --data-binary @- >/dev/null 2>&1 || true
exit 0
