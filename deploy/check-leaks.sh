#!/usr/bin/env bash
# Leak guard, run first by the test gate (run-tests.sh). Fails on:
#   1. secrets — gitleaks over the staged diff and the whole history;
#   2. blocklisted words — names that must never be published (other projects,
#      organisations, hostnames). gitleaks only knows credential shapes, so it cannot
#      catch these. Checked in the tracked files of the working tree and the index, and
#      in what the hook is about to publish: each commit a push sends or a merge brings
#      in (the lines it adds and its message), so a name added by one commit and removed
#      by the next does not reach the remote unseen.
# The word list lives OUTSIDE the repo, one case-insensitive whole word (or ERE) per
# line, `#` comments allowed: ${PERCH_LEAK_WORDS:-~/.perch/leak-words.txt}. Keeping it
# out of the tree is the point — committing the list would publish the very names it
# guards. A missing list skips the word check (opt-in per machine); a list git cannot
# use (a malformed ERE) fails the check.
#
# Arg 1 is the hook running it: `pre-push` reads git's ref lines on stdin, and
# `pre-merge-commit` checks HEAD..MERGE_HEAD.
set -euo pipefail

HOOK="${1:-}"
REPO="$(git rev-parse --show-toplevel)"
WORDS="${PERCH_LEAK_WORDS:-${HOME}/.perch/leak-words.txt}"
ZERO='0000000000000000000000000000000000000000'

command -v gitleaks >/dev/null || { echo "check-leaks: gitleaks not found (pinned in mise.toml; run 'mise install')" >&2; exit 1; }

gitleaks git --no-banner --redact --log-level warn --pre-commit --staged "${REPO}"
gitleaks git --no-banner --redact --log-level warn "${REPO}"

if [ ! -f "${WORDS}" ]; then
  echo "check-leaks: no word list at ${WORDS}; skipping the word check"
  exit 0
fi

# A blank pattern would match every line, so strip blanks and comments first.
patterns="$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "${WORDS}")"
[ -n "${patterns}" ] || exit 0

found=0
# $1 names what was searched; the rest is the search, which exits like grep: 0 on a hit,
# 1 on none, anything else on an error. An error fails the check: a word list git or grep
# cannot read would otherwise pass everything.
search() {
  local what="$1" hits rc
  shift
  set +e
  hits="$("$@" 2>&1)"
  rc=$?
  set -e
  case "${rc}" in
    0)
      echo "check-leaks: blocklisted words (from ${WORDS}) in ${what}:" >&2
      printf '%s\n' "${hits}" >&2
      found=1 ;;
    1) ;;
    *)
      echo "check-leaks: the word check failed on ${what} (exit ${rc}); fix ${WORDS}:" >&2
      printf '%s\n' "${hits}" >&2
      exit 1 ;;
  esac
}

grep_words() { grep -n -I -i -w -E -f <(printf '%s\n' "${patterns}"); }

# What a commit publishes: its message and the lines it adds, each prefixed with the commit.
commit_text() {
  git -C "${REPO}" log --no-color --no-ext-diff --format='@@commit %h%n%B' -p "$@" | awk '
    /^@@commit / { commit = $2; body = 1; next }
    /^diff --git / { body = 0; next }
    body { print commit ": " $0; next }
    /^\+/ && !/^\+\+\+ / { print commit ": " $0 }'
}

search_range() {
  local text
  text="$(commit_text "$@")" || { echo "check-leaks: could not read the commits $*" >&2; exit 1; }
  search "the commits $*" grep_words <<<"${text}"
}

search "tracked files" git -C "${REPO}" grep -n -I -i -w -E -f <(printf '%s\n' "${patterns}")
search "the index" git -C "${REPO}" grep --cached -n -I -i -w -E -f <(printf '%s\n' "${patterns}")

case "${HOOK}" in
  pre-merge-commit)
    if git -C "${REPO}" rev-parse -q --verify MERGE_HEAD >/dev/null; then search_range HEAD..MERGE_HEAD; fi ;;
  pre-push)
    while read -r _local_ref local_sha _remote_ref remote_sha; do
      [ "${local_sha}" = "${ZERO}" ] && continue
      if [ "${remote_sha}" = "${ZERO}" ]; then
        search_range "${local_sha}" --not --remotes
      else
        search_range "${remote_sha}..${local_sha}"
      fi
    done ;;
esac

[ "${found}" = 0 ] || exit 1
