#!/usr/bin/env bash
# Spawn one Perch workspace: a detached tmux session running Claude Code on a brief.
#
# usage: spawn.sh [--title NAME] [--parent SESSION] <projectPath> [modelAlias]   # brief on stdin
# prints: the workspace id (e.g. perch-a1b2c3), which is also the Claude session's
# name, so other sessions can SendMessage it by that id
#
# The brief arrives on stdin and is written to a file; the tmux command string
# contains only that fixed path. This is what makes arbitrary prose safe: the
# login shell expands "$(cat …)" and hands the bytes to claude as one argv
# element, and command-substitution output is never re-parsed. Quotes,
# apostrophes, backticks, $ and newlines in the brief all survive untouched.
# Do NOT "simplify" this by interpolating the brief into the command string.
set -eu

title=""
parent=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) title="${2:-}"; shift 2 || true ;;
    --title=*) title="${1#--title=}"; shift ;;
    --parent) parent="${2:-}"; shift 2 || true ;;
    --parent=*) parent="${1#--parent=}"; shift ;;
    *) break ;;
  esac
done

project="${1:-}"
model="${2:-opus[1m]}"
if [ -z "$project" ]; then
  echo "usage: spawn.sh [--title NAME] [--parent SESSION] <projectPath> [modelAlias]   (brief on stdin)" >&2
  exit 2
fi

# `tmux new-session -c` silently runs in $HOME when the cwd is missing, which
# would create a workspace pointing at the wrong directory. Reject up front.
resolved="$(cd "$project" 2>/dev/null && pwd -P)" || {
  echo "not a directory: $project" >&2
  exit 2
}

brief="$(cat)"
case "$brief" in
  *[![:space:]]*) ;;
  *) echo "empty brief on stdin" >&2; exit 2 ;;
esac

# The settings path lands unquoted in @perch_command, which resumeCommand splits
# on whitespace and tmux runs through a login shell. The parent name never
# reaches a command line, only the hook JSON and the brief, so spaces are fine
# there (sessions the user named often have them); quotes and backslashes are not.
if [ -n "$parent" ]; then
  case "$parent" in
    *[!A-Za-z0-9\ ._-]*) echo "unsafe parent session name: $parent" >&2; exit 2 ;;
  esac
  case "$HOME/.perch/spawn" in
    *[!A-Za-z0-9._/-]*) echo "--parent needs a HOME without spaces or quotes: $HOME" >&2; exit 2 ;;
  esac
fi

id="perch-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
dir="$HOME/.perch/spawn"
mkdir -p "$dir"
if [ -n "$parent" ]; then
  brief="$brief

---
You were launched by the orchestrator session \"$parent\", and you report to it, not to the
user. Ask it your questions with the SendMessage tool (to: \"$parent\"), then end your turn:
its reply arrives as a message and wakes you. A permission prompt is the exception: a yes
relayed by the orchestrator never answers it, so when you hit one, tell the orchestrator what
it is for and leave it open for the user to answer in this pane. As your last action, send it
your final report the same way: what you did, what you verified, and anything left open."
fi
printf '%s\n' "$brief" > "$dir/$id.md"

base="claude --model '$model' --name $id"

# A child must not block on a question its orchestrator could answer: a peer message can
# never answer a pending AskUserQuestion, and none can take a child out of plan mode. The
# hook denies the question and plan-mode tools, and its reason redirects the model to
# SendMessage. The parent lives in this file rather than an
# env var because unpark runs `<base> --resume <sid> || exec <base>`, where an env prefix
# breaks the `exec`. Both values are validated above, so neither needs escaping.
if [ -n "$parent" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"You are run by the orchestrator session %s. Do not ask the user or use plan mode. Send any question to %s with the SendMessage tool, then end your turn; its reply will arrive as a message."}}\n' \
    "$parent" "$parent" > "$dir/$id.deny.json"
  printf '{"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion|EnterPlanMode|ExitPlanMode","hooks":[{"type":"command","command":"cat >/dev/null; cat %s"}]}]}}\n' \
    "$dir/$id.deny.json" > "$dir/$id.settings.json"
  base="$base --settings $dir/$id.settings.json"
fi

# Without --title, Claude Code names the workspace itself: it writes the pane
# title as it goes and the agent reads that. A caller who already knows what the
# workspace is for can say so instead, which keeps the name stable and lets a
# batch of workspaces be told apart at a glance.
#
# Two halves, both needed. CLAUDE_CODE_DISABLE_TERMINAL_TITLE stops Claude Code
# overwriting the pane title a second later — an env prefix rather than tmux's
# `-e`, which wants tmux 3.2. And the title is stored with the status glyph the
# agent expects, because `deriveWorkspaceName` only trusts a pane title that
# carries one; a bare title reads as a plain shell and falls back to the
# directory name.
launch="$base \"\$(cat '$dir/$id.md')\""
if [ -n "$title" ]; then
  launch="CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 $launch"
fi

tmux new-session -d -s "$id" -c "$resolved" "$launch"
if [ -n "$title" ]; then
  tmux select-pane -t "$id" -T "✳ $title"
fi

# The stored command deliberately omits the brief. `resumeCommand` in the agent
# splits this on whitespace and builds `<base> --resume <sid> || exec <base>`,
# so keeping the "$(cat …)" arg here would re-submit the original brief into the
# conversation every time the workspace is unparked.
tmux set-option -t "$id" @perch_command "$base"

# A command string the login shell rejects kills the pane instantly, and tmux
# then destroys the session — the workspace just never appears, with no error.
sleep 2
if ! tmux has-session -t "$id" 2>/dev/null; then
  echo "workspace $id died on launch (brief kept at $dir/$id.md)" >&2
  exit 1
fi

echo "$id"
