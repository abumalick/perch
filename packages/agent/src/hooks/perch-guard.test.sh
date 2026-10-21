#!/usr/bin/env bash
# Tests for perch-guard.sh, the PreToolUse hook that refuses process-killing commands which
# can reach the tmux server or the agent from inside a workspace. Table-driven: each row is a
# Bash command and whether the guard must let it through.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="${HERE}/perch-guard.sh"

fails=0

# Claude Code and Codex both send the command JSON-encoded in tool_input.command.
payload() {
  local cmd="$1"
  cmd="${cmd//\\/\\\\}"
  cmd="${cmd//\"/\\\"}"
  cmd="${cmd//$'\n'/\\n}"
  printf '{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s","description":"kill it"}}' "$cmd"
}

expect() {
  local want="$1" cmd="$2" code=0
  payload "$cmd" | TMUX_PANE=%1 bash "$GUARD" >/dev/null 2>&1 || code=$?
  local got=allow
  [ "$code" = 2 ] && got=deny
  if [ "$want" = "$got" ]; then
    echo "  ok: $want  $cmd"
  else
    echo "  FAIL: expected $want, got $got (exit $code): $cmd"
    fails=$((fails + 1))
  fi
}

echo "perch-guard.sh"
echo " refuses"
expect deny 'pkill -f "x"'
expect deny 'pkill node'
expect deny '/usr/bin/pkill -f claude'
expect deny 'killall tmux'
expect deny 'kill -9 -1'
expect deny 'kill -- -1'
expect deny 'kill -s KILL -1'
expect deny 'kill $(pgrep -f vite)'
expect deny 'kill -9 `pgrep node`'
expect deny 'kill $(pidof chromium)'
expect deny 'pgrep -f vite | xargs kill'
expect deny 'pgrep -f vite | xargs -r kill -9'
expect deny 'tmux kill-server'
expect deny 'tmux kill-ser'
expect deny 'tmux kill-session -a'
expect deny 'tmux kill-session -t foo -a'
expect deny 'cd /tmp && pkill -f x'
expect deny 'true; killall node'
expect deny 'echo hi | pkill -f x'
expect deny 'sudo pkill -f x'
expect deny 'env FOO=1 pkill -f x'
expect deny 'FOO=1 pkill -f x'
expect deny 'sh -c "pkill -f x"'
expect deny "bash -c 'killall node'"
expect deny 'timeout 5 pkill -f x'
expect deny 'nohup pkill -f x'
expect deny $'ls\npkill -f x'
expect deny 'echo $(pkill -f x)'
expect deny 'echo "$(pkill -f x)"'
expect deny 'sh -c "cd /; pkill -f x"'
expect deny "bash -c 'true && killall node'"
expect deny '"pkill" -f x'

echo " allows"
expect allow 'kill 1234'
expect allow 'kill -9 1234 5678'
expect allow 'kill -TERM %1'
expect allow 'kill $(cat server.pid)'
expect allow 'pgrep -af vite'
expect allow 'ps aux | grep node'
expect allow 'echo "use pkill carefully"'
expect allow 'git commit -m "refuse killall in workspaces"'
expect allow 'tmux -S /tmp/test.sock kill-server'
expect allow 'tmux -L test kill-server'
expect allow 'tmux kill-session -t perch-abc'
expect allow 'rg pkill packages/'
expect allow 'rg "pkill|killall" packages/'
expect allow "grep -E 'kill-server|pkill' notes.md"
expect allow 'grep -lsE "pgrep|killall|kill-server" notes.md'
expect allow $'cat > notes.md <<\'EOF\'\nuse "a|pkill|b" here\nEOF'
expect allow 'git commit -m "a; pkill b"'
expect allow 'for c in pkill killall; do type -a $c; done'
expect allow "ssh host 'cd /srv && pkill -f x'"
expect allow 'ls -la'

echo " scope"
code=0
payload 'pkill -f x' | env -u TMUX_PANE bash "$GUARD" >/dev/null 2>&1 || code=$?
if [ "$code" = 0 ]; then echo "  ok: allows anything outside a tmux pane"; else
  echo "  FAIL: refused outside a tmux pane (exit $code)"; fails=$((fails + 1)); fi

msg=$(payload 'pkill -f x' | TMUX_PANE=%1 bash "$GUARD" 2>&1 >/dev/null || true)
if [[ $msg == *"pgrep -af"* && $msg == *"kill <pid>"* ]]; then echo "  ok: says what to do instead"; else
  echo "  FAIL: refusal does not suggest pgrep -af / kill <pid>: $msg"; fails=$((fails + 1)); fi

code=0
printf 'not json' | TMUX_PANE=%1 bash "$GUARD" >/dev/null 2>&1 || code=$?
if [ "$code" = 0 ]; then echo "  ok: lets a payload without a command through"; else
  echo "  FAIL: refused a payload without a command (exit $code)"; fails=$((fails + 1)); fi

if [ "$fails" -gt 0 ]; then
  echo "${fails} failure(s)"
  exit 1
fi
echo "all passed"
