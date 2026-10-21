#!/usr/bin/env bash
# Perch PreToolUse guard for Claude Code and Codex: refuse Bash commands that kill processes by
# name or en masse from inside a workspace.
#
# The tmux server, the agent and every workspace's CLI run as the same user, so a pattern kill
# from any one workspace (`pkill -f x` matches nearly every command line) takes all of them down
# at once. Nothing at the OS level can stop a process signalling its own user's processes, so
# this refuses the command before it runs. It is a guard against accidents, not a security
# boundary: a determined command can always get past a text match.
#
# Only commands run inside a tmux pane are checked. A quoted string is one argument, so a grep
# pattern or a commit message that names these commands passes; a `sh -c` script is checked as
# a command line of its own. A heredoc body is read as commands, and an apostrophe in one can
# throw the quote tracking off for the rest of the line: the cost of a text match.
[ -n "${TMUX_PANE:-}" ] || exit 0
[ -t 0 ] && exit 0
payload=$(cat) || exit 0

# No jq on every agent machine: take tool_input.command from the JSON by hand.
re='"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
[[ $payload =~ $re ]] || exit 0
cmd=${BASH_REMATCH[1]}
cmd=${cmd//\\\\/$'\x01'}
cmd=${cmd//\\n/$'\n'}
cmd=${cmd//\\t/ }
cmd=${cmd//\\\"/\"}
cmd=${cmd//$'\x01'/\\}

deny() {
  printf 'Blocked by Perch: %s The tmux server, the Perch agent and every other workspace run as this same user, so a kill by name or en masse can end all of them at once. Look first with `pgrep -af <pattern>`, then `kill <pid>` the explicit pids that belong to this task.\n' "$1" >&2
  exit 2
}

word_end='([[:space:])}"'"'"'`]|$)'
# tmux accepts any unambiguous prefix of a command name; kill-ser is the shortest for kill-server.
kill_server_re="[[:space:]]kill-ser[a-z]*$word_end"
kill_others_re="[[:space:]]kill-session([[:space:]].*)?[[:space:]]-a$word_end"
shell_c_re='^([^[:space:]]*/)?(ba|z|da)?sh([[:space:]]+-[a-zA-Z]+)*[[:space:]]+-[a-zA-Z]*c[[:space:]]+'
has_socket_flag() { [[ $1 =~ (^|[[:space:]])-[A-Za-z]*[SL]([[:space:]]|[^[:space:]]|$) ]]; }

# A pid list computed from a name is a kill by name.
pgrep_kill_re='(^|[^[:alnum:]_-])kill[[:space:]][^;&|]*(\$\(|`)[[:space:]]*(pgrep|pidof)([[:space:]]|$)'
[[ $cmd =~ $pgrep_kill_re ]] && deny 'kill $(pgrep …) kills by name.'

# One simple command per line: split on separators outside quotes, so a quoted `a|pkill|b`
# (a grep pattern, a commit message) stays one argument. `$(` and a backquote split inside
# double quotes too, since they run there. Newlines inside quotes become spaces.
segments() {
  printf '%s' "$1" | LC_ALL=C awk -v sq="'" '
    BEGIN { RS = "\001" }
    {
      n = length($0); q = ""; out = ""
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1); c2 = substr($0, i, 2)
        if (q == sq) { if (c == sq) q = ""; out = out (c == "\n" ? " " : c); continue }
        if (c == "\\") { out = out (c2 == "\\\n" ? " " : c2); i++; continue }
        if (c2 == "$(") { print out; out = ""; i++; continue }
        if (c == "`") { print out; out = ""; continue }
        if (q == "\"") { if (c == "\"") q = ""; out = out (c == "\n" ? " " : c); continue }
        if (c == sq || c == "\"") { q = c; out = out c; continue }
        if (c2 == "&&" || c2 == "||") { print out; out = ""; i++; continue }
        if (c == ";" || c == "|" || c == "&" || c == "\n") { print out; out = ""; continue }
        out = out c
      }
      print out
    }'
}

check() {
local seg s word payload args i
while IFS= read -r seg; do
  s="$seg"
  # Strip what can precede the command word: grouping, keywords, VAR=value, wrappers, and a
  # `sh -c '` prefix (later commands inside the wrapper arrive as their own segments).
  while :; do
    s="${s#"${s%%[![:space:]]*}"}"
    case "$s" in
      '('* | '{'* | '!'* | \'* | '"'* | '`'*) s="${s:1}" ;;
      then\ * | do\ * | else\ * | time\ * | exec\ * | sudo\ * | command\ * | nohup\ * | nice\ * | setsid\ *) s="${s#* }" ;;
      timeout\ *)
        s="${s#timeout }"
        while [[ $s =~ ^[[:space:]]*(-[^[:space:]]+)[[:space:]]+ ]]; do s="${s:${#BASH_REMATCH[0]}}"; done
        [[ $s =~ ^[[:space:]]*[0-9.]+[smhd]?[[:space:]]+ ]] && s="${s:${#BASH_REMATCH[0]}}"
        ;;
      env\ *)
        s="${s#env }"
        while [[ $s =~ ^[[:space:]]*(-u[[:space:]]+[^[:space:]]+|-[^[:space:]]+)[[:space:]]+ ]]; do
          s="${s:${#BASH_REMATCH[0]}}"
        done
        ;;
      *)
        if [[ $s =~ $shell_c_re ]]; then
          s="${s:${#BASH_REMATCH[0]}}"
          # A quoted script is a command line of its own: check every command in it.
          case "$s" in
            \'*) payload="${s:1}"; check "${payload%%\'*}"; continue 2 ;;
            '"'*) payload="${s:1}"; check "${payload%%\"*}"; continue 2 ;;
          esac
        elif [[ $s =~ ^[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|\'[^\']*\'|[^[:space:]]*)[[:space:]]+ ]]; then
          s="${s:${#BASH_REMATCH[0]}}"
        else
          break
        fi
        ;;
    esac
  done

  word=${s%%[[:space:]]*}
  word=${word##*/}
  word=${word%%[\"\']*}
  case "$word" in
    pkill) deny 'pkill kills by name.' ;;
    killall) deny 'killall kills by name.' ;;
    xargs) [[ $s =~ [[:space:]]kill([[:space:]]|$) ]] && deny 'xargs kill kills a computed pid list.' ;;
    kill)
      # `-1` as a target (not the first argument, where it names a signal) is every process.
      read -ra args <<< "${s#kill}"
      for ((i = 1; i < ${#args[@]}; i++)); do
        [ "${args[i]}" = "-1" ] && deny 'kill -1 signals every process you own.'
      done
      ;;
    tmux)
      has_socket_flag "$s" && continue
      [[ $s =~ $kill_server_re ]] && deny 'tmux kill-server without -S/-L ends the shared tmux server every workspace runs in.'
      [[ $s =~ $kill_others_re ]] && deny 'tmux kill-session -a kills every other workspace; kill one by name with -t.'
      ;;
  esac
done < <(segments "$1")
}

check "$cmd"
exit 0
