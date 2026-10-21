#!/usr/bin/env bash
# Tests for check-leaks.sh against a throwaway git sandbox. Needs gitleaks on PATH
# (pinned in mise.toml).
set -euo pipefail

# Under a git hook, GIT_DIR/GIT_INDEX_FILE point at the OUTER repo; the sandbox's git
# commands must not inherit them.
for _v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "${_v}"; done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
mkdir -p "${REPO}/.tmp"
SB="$(mktemp -d "${REPO}/.tmp/check-leaks-test.XXXXXX")"
trap 'rm -rf "${SB}"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
# Arg 1 is the hook name; stdin carries pre-push's ref lines.
check() { (cd "${SB}/repo" && PERCH_LEAK_WORDS="${SB}/words.txt" bash "${HERE}/check-leaks.sh" "$@") >"${SB}/out" 2>&1; }
commit() { git -C "${SB}/repo" -c user.email=t@t -c user.name=test commit -q "$@"; }

git init -q "${SB}/repo"
echo "hello" > "${SB}/repo/readme.txt"
git -C "${SB}/repo" add -A
git -C "${SB}/repo" -c user.email=t@t -c user.name=test commit -qm init

printf '# comment\n\nzorblax\n' > "${SB}/words.txt"

check || { cat "${SB}/out"; fail "a clean repo must pass"; }

echo "see the Zorblax project" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt
check && fail "a blocklisted word in a tracked file must fail"
grep -q 'notes.txt' "${SB}/out" || fail "the failure must name the offending file"

echo "zorblaxian is a different word" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt
check || { cat "${SB}/out"; fail "blocklisted words match whole words only"; }

echo "see the Zorblax project" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt
rm "${SB}/words.txt"
check || { cat "${SB}/out"; fail "a missing word list must skip the word check, not fail"; }
git -C "${SB}/repo" rm -q --cached notes.txt && rm "${SB}/repo/notes.txt"
printf '# comment\n\nzorblax\n' > "${SB}/words.txt"

# Staged, then edited away in the working tree without staging: the staged copy is what commits.
echo "see the Zorblax project" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt
echo "nothing to see" > "${SB}/repo/notes.txt"
check pre-commit && fail "a blocklisted word staged but gone from the working tree must fail"
git -C "${SB}/repo" rm -q -f --cached notes.txt && rm "${SB}/repo/notes.txt"

# A push carries every commit since the remote's tip, not only the tip's tree.
base="$(git -C "${SB}/repo" rev-parse HEAD)"
echo "see the Zorblax project" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt && commit -m "add notes"
echo "nothing to see" > "${SB}/repo/notes.txt"
git -C "${SB}/repo" add notes.txt && commit -m "fix notes"
tip="$(git -C "${SB}/repo" rev-parse HEAD)"
check pre-push <<<"refs/heads/main ${tip} refs/heads/main ${base}" && fail "a word added then removed within a pushed range must fail"
grep -q '+see the Zorblax' "${SB}/out" || fail "the failure must show the added line"
check pre-push <<<"refs/heads/main ${tip} refs/heads/main ${tip}" || { cat "${SB}/out"; fail "an empty push range must pass"; }
# A new branch (no remote tip) is checked against everything no remote holds yet.
zero=0000000000000000000000000000000000000000
check pre-push <<<"refs/heads/main ${tip} refs/heads/new ${zero}" && fail "a new branch carrying the word in its history must fail"
check pre-push <<<"(delete) ${zero} refs/heads/gone ${tip}" || { cat "${SB}/out"; fail "deleting a remote branch publishes nothing"; }
# A commit that only removes the word publishes nothing new.
check pre-push <<<"refs/heads/main ${tip} refs/heads/main $(git -C "${SB}/repo" rev-parse HEAD~1)" || { cat "${SB}/out"; fail "a commit removing the word must pass"; }

# A commit message is published too.
commit --allow-empty -m "Port the Zorblax importer"
msg_tip="$(git -C "${SB}/repo" rev-parse HEAD)"
check pre-push <<<"refs/heads/main ${msg_tip} refs/heads/main ${tip}" && fail "a blocklisted word in a commit message must fail"

# A merge brings in the other branch's commits.
git -C "${SB}/repo" branch -q side "${tip}"
git -C "${SB}/repo" reset -q --hard "${base}"
commit --allow-empty -m "the branch moves on"
git -C "${SB}/repo" -c user.email=t@t -c user.name=test merge -q --no-commit --no-ff side >/dev/null 2>&1 || true
git -C "${SB}/repo" rev-parse -q --verify MERGE_HEAD >/dev/null || fail "the merge fixture did not start a merge"
check pre-merge-commit && fail "a merge bringing in a word added then removed must fail"
git -C "${SB}/repo" merge --abort
check pre-merge-commit || { cat "${SB}/out"; fail "no merge in progress must pass"; }

# A word list git cannot use fails the check instead of passing everything.
printf 'zorblax\nfoo(bar\n' > "${SB}/words.txt"
check && fail "a malformed pattern must fail the check, not skip it"
grep -q 'word check failed' "${SB}/out" || fail "the failure must say the word check itself failed"
printf '# comment\n\nzorblax\n' > "${SB}/words.txt"

# Built at runtime so this file never contains a token-shaped string itself.
token="ghp_$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 36)"
echo "GITHUB_TOKEN=${token}" > "${SB}/repo/config.env"
git -C "${SB}/repo" add config.env
check && fail "a staged secret must fail"
grep -q "${token}" "${SB}/out" && fail "the secret must be redacted from the output"

echo "all check-leaks checks passed"
