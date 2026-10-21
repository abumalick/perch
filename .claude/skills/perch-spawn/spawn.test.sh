#!/usr/bin/env bash
# Tests for spawn.sh, which launches a Perch workspace (a detached tmux session
# running Claude Code on a brief).
#
# ISOLATION - read before editing, this test can destroy real work.
#
# tmux picks its socket from $TMUX first when that is set, ignoring TMUX_TMPDIR
# entirely. This test is normally run by an agent from inside a Perch pane, where
# $TMUX points at the real server holding the user's live workspaces. So
# environment variables alone are NOT a safe way to keep tmux calls off it: one
# missing prefix turns `kill-server` into a machine-wide wipe.
#
# Two mechanisms, used for two different things:
#   * This test's own tmux calls go through `t()`, which passes an explicit
#     `-S <sandbox socket>`. -S overrides both $TMUX and TMUX_TMPDIR and never
#     falls back, so those calls cannot reach the real server no matter what the
#     environment says. Every destructive call MUST go through it.
#   * spawn.sh runs bare `tmux` on purpose - in production it must use the
#     ambient server, the one its own workspace lives on - so it can only be
#     isolated by environment, via `run_spawn()`. That is checked rather than
#     trusted: the first spawn is asserted to have landed on the sandbox socket,
#     and the test aborts loudly if it did not.
#
# A fake `claude` on PATH records its argv instead of starting a real session.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPAWN="${HERE}/spawn.sh"
SANDBOX="$(mktemp -d)"
SOCKET="${SANDBOX}/tmux-$(id -u)/default"

# Every tmux call this test makes itself. Explicit socket, no env resolution.
t() { tmux -S "${SOCKET}" "$@"; }

# spawn.sh calls bare tmux, so it is isolated by environment: TMUX_TMPDIR sets
# the socket directory and TMUX must be unset for it to be honoured at all.
# Also drop the title-disable variable: a Perch workspace that was itself spawned
# with --title carries it, and the "left out" check below reads it back from the
# spawn's environment, so it must not be inherited from the one running the test.
run_spawn() {
  env -u TMUX -u CLAUDE_CODE_DISABLE_TERMINAL_TITLE TMUX_TMPDIR="${SANDBOX}" bash "${SPAWN}" "$@"
}

cleanup() {
  # Belt and braces over `t`: refuse to kill anything whose socket is not inside
  # the sandbox, in case SOCKET is ever changed carelessly. Not silenced - a
  # destructive step that fails must say so rather than fail invisibly.
  case "${SOCKET}" in
    "${SANDBOX}"/*)
      if [ -S "${SOCKET}" ]; then
        t kill-server || echo "warning: could not kill the test tmux server at ${SOCKET}" >&2
      fi
      ;;
    *)
      echo "refusing to kill a tmux server: ${SOCKET} is outside ${SANDBOX}" >&2
      ;;
  esac
  rm -rf "${SANDBOX}"
}
trap cleanup EXIT

BIN="${SANDBOX}/bin"
PROJECT="${SANDBOX}/project"
mkdir -p "${BIN}" "${PROJECT}"

# Records what claude was actually handed, then stays alive so spawn.sh's
# has-session check sees a live pane.
cat > "${BIN}/claude" <<'EOF'
#!/usr/bin/env bash
rm -f "${HOME}"/arg[0-9]*
printf '%s' "$#" > "${HOME}/argc"
i=0
for a in "$@"; do
  i=$((i + 1))
  printf '%s' "$a" > "${HOME}/arg${i}"
done
printf '%s' "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-}" > "${HOME}/title_env"
sleep 30
EOF
chmod +x "${BIN}/claude"

# The real node binary, resolved while HOME is still the user's: `node` is usually a mise
# shim, and the shim cannot find its trust state once HOME points at the sandbox.
NODE="$(node -e 'process.stdout.write(process.execPath)')"

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

echo "spawn.sh"

# --- refusals -------------------------------------------------------------
status=0
run_spawn < /dev/null > /dev/null 2>&1 || status=$?
check "rejects a missing project path" "2" "${status}"

status=0
run_spawn "${SANDBOX}/nope" <<< "brief" > /dev/null 2>&1 || status=$?
check "rejects a project path that is not a directory" "2" "${status}"

# A blank brief would launch a workspace with nothing to do, which reads as a
# hung session rather than a mistake.
status=0
run_spawn "${PROJECT}" <<< "   " > /dev/null 2>&1 || status=$?
check "rejects a whitespace-only brief" "2" "${status}"

# --- the brief survives, verbatim, as a single argument -------------------
# The whole design rests on this: the brief reaches claude as ONE argv element
# with nothing expanded. If it were ever interpolated into the tmux command
# string, the login shell would split it and expand $HOME and $(whoami).
BRIEF='Fix the thing.
Hostile: don'"'"'t "quoted" `backtick` $HOME $(whoami) a|b; c>d & 100%'

id="$(run_spawn "${PROJECT}" <<< "${BRIEF}")"

# Isolation check, before anything else touches tmux. If spawn.sh's session is
# not on the sandbox socket then the environment isolation failed and its
# sessions are on the real server; stop immediately rather than carry on.
if ! t has-session -t "${id}" 2>/dev/null; then
  echo "ABORT: ${id} is not on the sandbox socket ${SOCKET}." >&2
  echo "       spawn.sh escaped its sandbox - its sessions may be on the real" >&2
  echo "       tmux server. Nothing was killed. Investigate before re-running." >&2
  exit 99
fi

case "${id}" in
  perch-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) check "id is perch- plus 6 hex" "ok" "ok" ;;
  *) check "id is perch- plus 6 hex" "perch-<6 hex>" "${id}" ;;
esac

check "brief is stored verbatim" "${BRIEF}" "$(cat "${SANDBOX}/.perch/spawn/${id}.md")"
check "claude gets exactly 5 arguments" "5" "$(cat "${SANDBOX}/argc")"
check "claude gets --model" "--model" "$(cat "${SANDBOX}/arg1")"
check "claude gets the default model" "opus[1m]" "$(cat "${SANDBOX}/arg2")"
# The Claude session name is what other sessions address it by (SendMessage, ListAgents);
# making it the workspace id lets an orchestrator message the id spawn.sh printed.
check "claude is named after the workspace id" "--name ${id}" \
  "$(cat "${SANDBOX}/arg3") $(cat "${SANDBOX}/arg4")"
check "claude gets the brief unexpanded, as one argument" "${BRIEF}" "$(cat "${SANDBOX}/arg5")"

# The stored command omits the brief on purpose: resumeCommand splits it on
# whitespace to build the unpark command, so keeping the brief here would
# re-submit it into the resumed conversation every time.
check "@perch_command is the base command only" "claude --model 'opus[1m]' --name ${id}" \
  "$(t show-options -t "${id}" -v @perch_command)"
check "session starts in the project directory" "${PROJECT}" \
  "$(t display-message -p -t "${id}" '#{session_path}')"

# --- model override, and a relative path ---------------------------------
# `tmux new-session -c` silently falls back to $HOME on a path it cannot use, so
# spawn.sh resolves the path itself rather than handing tmux a relative one.
id2="$(cd "${SANDBOX}" && run_spawn project 'sonnet[1m]' <<< "brief")"
check "model override reaches claude" "sonnet[1m]" "$(cat "${SANDBOX}/arg2")"
check "model override reaches @perch_command" "claude --model 'sonnet[1m]' --name ${id2}" \
  "$(t show-options -t "${id2}" -v @perch_command)"
check "a relative project path is resolved" "${PROJECT}" \
  "$(t display-message -p -t "${id2}" '#{session_path}')"

# --- an explicit workspace name ------------------------------------------
# Naming a workspace is two things at once: the pane title has to be set AND
# Claude Code has to be told to stop writing its own, or it overwrites ours
# a second later. The glyph is not decoration — deriveWorkspaceName ignores a
# pane title without one and falls back to the directory name.
TITLED_BRIEF='Record story 9.
Hostile: don'"'"'t "quoted" `backtick` $HOME'
id3="$(run_spawn --title 'story foo 9' "${PROJECT}" <<< "${TITLED_BRIEF}")"
check "--title sets the pane title, with the status glyph" "✳ story foo 9" \
  "$(t display-message -p -t "${id3}" '#{pane_title}')"
check "--title stops Claude Code renaming the pane" "1" \
  "$(cat "${SANDBOX}/title_env")"
check "--title leaves the brief a single verbatim argument" "${TITLED_BRIEF}" \
  "$(cat "${SANDBOX}/arg5")"
check "--title does not leak into @perch_command" "claude --model 'opus[1m]' --name ${id3}" \
  "$(t show-options -t "${id3}" -v @perch_command)"

id4="$(run_spawn --title='story foo 10' "${PROJECT}" 'sonnet[1m]' <<< "brief")"
check "--title=NAME is accepted too" "✳ story foo 10" \
  "$(t display-message -p -t "${id4}" '#{pane_title}')"
check "a title does not disturb the model argument" "sonnet[1m]" "$(cat "${SANDBOX}/arg2")"

# Left out, nothing changes: Claude Code keeps naming the workspace itself.
run_spawn "${PROJECT}" <<< "brief" > /dev/null
check "without --title the rename stays enabled" "" "$(cat "${SANDBOX}/title_env")"

# --- a child that reports to an orchestrator --------------------------------
# The parent goes into a per-workspace settings file, never an env var: unpark runs
# `<base> --resume <sid> || exec <base>`, and `exec VAR=x claude` fails.
id5="$(run_spawn --parent relay-orchestrator "${PROJECT}" <<< "Do the thing.")"
SETTINGS="${SANDBOX}/.perch/spawn/${id5}.settings.json"
check "--parent adds --settings to @perch_command" \
  "claude --model 'opus[1m]' --name ${id5} --settings ${SETTINGS}" \
  "$(t show-options -t "${id5}" -v @perch_command)"
check "--parent hands claude the settings file" "--settings ${SETTINGS}" \
  "$(cat "${SANDBOX}/arg5") $(cat "${SANDBOX}/arg6")"
case "$(cat "${SANDBOX}/arg7")" in
  "Do the thing."*'orchestrator session "relay-orchestrator"'*) check "the brief gains a footer naming the parent" ok ok ;;
  *) check "the brief gains a footer naming the parent" "footer" "$(cat "${SANDBOX}/arg7")" ;;
esac

# The hook must deny with a reason naming the parent, as valid hook JSON.
hook_cmd="$("${NODE}" -e 'const s=require(process.argv[1]); const h=s.hooks.PreToolUse[0]; console.log(h.matcher+"\n"+h.hooks[0].command)' "${SETTINGS}")"
check "the hook matches the plan-mode and question tools" "AskUserQuestion|EnterPlanMode|ExitPlanMode" "$(printf '%s\n' "${hook_cmd}" | head -1)"
decision="$(printf '{"tool_name":"AskUserQuestion"}' | sh -c "$(printf '%s\n' "${hook_cmd}" | tail -1)" \
  | "${NODE}" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d).hookSpecificOutput;console.log(o.hookEventName+" "+o.permissionDecision+" "+/relay-orchestrator/.test(o.permissionDecisionReason))})')"
check "the hook denies, naming the parent" "PreToolUse deny true" "${decision}"

before="$(find "${SANDBOX}/.perch/spawn" -name '*.settings.json' | wc -l | tr -d ' ')"
run_spawn "${PROJECT}" <<< "brief" > /dev/null
after="$(find "${SANDBOX}/.perch/spawn" -name '*.settings.json' | wc -l | tr -d ' ')"
check "without --parent no settings file is written" "${before}" "${after}"
check "without --parent the brief has no footer" "brief" "$(cat "${SANDBOX}/arg5")"

# A parent name or path that would break the command string must fail up front, not
# produce a workspace that dies on launch or silently loses its hook after an unpark.
status=0
run_spawn --parent 'bad"name' "${PROJECT}" <<< "brief" > /dev/null 2>&1 || status=$?
check "rejects an unsafe parent name" "2" "${status}"

# A parent name with spaces only reaches the hook JSON, never a command line.
id6="$(run_spawn --parent "foo orchestrator" "${PROJECT}" <<< "brief")"
reason="$("${NODE}" -e 'console.log(require(process.argv[1]).hookSpecificOutput.permissionDecisionReason.includes("foo orchestrator"))' \
  "${SANDBOX}/.perch/spawn/${id6}.deny.json")"
check "accepts a parent name with spaces, as valid hook JSON" "true" "${reason}"

mkdir -p "${SANDBOX}/sp ace"
status=0
env -u TMUX -u CLAUDE_CODE_DISABLE_TERMINAL_TITLE TMUX_TMPDIR="${SANDBOX}" HOME="${SANDBOX}/sp ace" \
  bash "${SPAWN}" --parent orch "${PROJECT}" <<< "brief" > /dev/null 2>&1 || status=$?
check "rejects a HOME with a space when --parent needs a settings path" "2" "${status}"

if [ "${fails}" -gt 0 ]; then
  echo "${fails} check(s) failed"
  exit 1
fi
echo "all spawn.sh checks passed"
