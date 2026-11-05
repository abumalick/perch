#!/usr/bin/env bash
# Tests for deploy/pwa-deploy.sh against a throwaway git sandbox with a fake pnpm and curl, so no
# Cloudflare call is ever made: production deploys only from a clean main matching origin, and is
# done only once tarfa.app serves the build just made; --dev deploys any checkout and prints its
# URL; --dry-run touches nothing.
set -euo pipefail

for _v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "${_v}"; done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
mkdir -p "${REPO}/.tmp"
SB="$(mktemp -d "${REPO}/.tmp/pwa-deploy-test.XXXXXX")"
trap 'rm -rf "${SB}"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# The fake pnpm logs each call (with the build's label and id) and plays wrangler; the fake curl
# answers version.json with whatever build id FAKE_SERVED names ('' = the one just built).
mkdir -p "${SB}/bin"
cat > "${SB}/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
printf '%s|label=%s|id=%s|account=%s|cwd=%s\n' "$*" "${TARFA_BUILD_LABEL:-}" "${TARFA_BUILD_ID:-}" "${CLOUDFLARE_ACCOUNT_ID:-}" "$(basename "$PWD")" >> "${FAKE_LOG}"
case "$*" in
  *build*) printf '%s' "${TARFA_BUILD_ID:-}" > "${FAKE_LOG}.built" ;;
  *"wrangler deploy --env dev"*) echo "Deployed tarfa-dev triggers" ; echo "  https://tarfa-dev.someone.workers.dev" ;;
esac
FAKE
cat > "${SB}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_LOG}.curl"
id="${FAKE_SERVED-}"
[ -n "${id}" ] || id="$(cat "${FAKE_LOG}.built" 2>/dev/null)"
printf '{"label":"main","buildId":"%s"}' "${id}"
FAKE
chmod +x "${SB}/bin/pnpm" "${SB}/bin/curl"
export PATH="${SB}/bin:${PATH}"
export FAKE_LOG="${SB}/pnpm.log"
export PWA_DEPLOY_WAIT_S=1

MAIN="${SB}/repo"
git init -q -b main "${MAIN}"
git -C "${MAIN}" config user.email t@t
git -C "${MAIN}" config user.name test
mkdir -p "${MAIN}/deploy" "${MAIN}/packages/pwa"
printf '.worktrees/\n.tmp/\ndeploy/pwa-deploy.env\n' > "${MAIN}/.gitignore"
cp "${HERE}/pwa-deploy.sh" "${MAIN}/deploy/"
touch "${MAIN}/packages/pwa/.keep"
git -C "${MAIN}" add -A
git -C "${MAIN}" commit -qm init
git init -q --bare "${SB}/origin.git"
git -C "${MAIN}" remote add origin "${SB}/origin.git"
git -C "${MAIN}" push -q -u origin main
git -C "${MAIN}" worktree add -q "${MAIN}/.worktrees/feature" -b feature
WT="${MAIN}/.worktrees/feature"

run() { rm -f "${FAKE_LOG}" "${FAKE_LOG}.curl" "${FAKE_LOG}.built"; "$@" >"${SB}/out" 2>&1; }
deployed_with() { grep -q -- "wrangler deploy $1|" "${FAKE_LOG}" 2>/dev/null; }

# --- 1. no env file: refused, by name ------------------------------------------
if run "${MAIN}/deploy/pwa-deploy.sh"; then fail "deployed without deploy/pwa-deploy.env"; fi
grep -q "pwa-deploy.env" "${SB}/out" || fail "missing-env message does not name the file"

# --- 2. clean main: install, build, deploy production, wait for the build -------
printf 'CLOUDFLARE_ACCOUNT_ID=acct-123\n' > "${MAIN}/deploy/pwa-deploy.env"
run "${MAIN}/deploy/pwa-deploy.sh" || { cat "${SB}/out"; fail "clean main did not deploy"; }
grep -q "^install --frozen-lockfile|" "${FAKE_LOG}" || fail "no frozen install before a production deploy"
build="$(grep -- "--filter @tarfa/pwa build|" "${FAKE_LOG}")" || fail "no build"
case "${build}" in *"|label=main|"*) ;; *) fail "production build label: ${build}" ;; esac
sha="$(git -C "${MAIN}" rev-parse --short=12 HEAD)"
case "${build}" in *"|id=${sha}-"*) ;; *) fail "build id does not start with the commit: ${build}" ;; esac
deployed_with "--env production" || fail "did not deploy env.production: $(cat "${FAKE_LOG}")"
grep -q -- "wrangler deploy --env production|.*account=acct-123|cwd=pwa" "${FAKE_LOG}" || fail "wrangler not run from packages/pwa with the account"
grep -q "https://tarfa.app/version.json" "${FAKE_LOG}.curl" || fail "did not check tarfa.app/version.json"
grep -q "tarfa.app" "${SB}/out" || fail "does not say where it went"

# --- 2b. tarfa.app still serving another build: the deploy fails, saying so -----
if FAKE_SERVED=old-build run "${MAIN}/deploy/pwa-deploy.sh"; then fail "succeeded while tarfa.app served another build"; fi
grep -q "old-build" "${SB}/out" || fail "the failure does not name what tarfa.app serves"

# --- 3. production refuses anything but a clean main matching origin ------------
if run "${WT}/deploy/pwa-deploy.sh"; then fail "deployed production from a worktree"; fi
grep -q "main" "${SB}/out" || fail "worktree refusal does not say why"
[ -f "${FAKE_LOG}" ] && fail "a refused deploy ran pnpm"
touch "${MAIN}/stray"
if run "${MAIN}/deploy/pwa-deploy.sh"; then fail "deployed with an untracked file"; fi
grep -q "uncommitted or untracked" "${SB}/out" || fail "dirty refusal does not say why"
rm "${MAIN}/stray"
git -C "${MAIN}" commit -q --allow-empty -m ahead
if run "${MAIN}/deploy/pwa-deploy.sh"; then fail "deployed a main ahead of origin"; fi
grep -q "push or pull" "${SB}/out" || fail "ahead refusal does not say why"
git -C "${MAIN}" push -q origin main

# --- 4. --dry-run builds and asks wrangler for a dry run, from any checkout ------
run "${WT}/deploy/pwa-deploy.sh" --dry-run || { cat "${SB}/out"; fail "dry run from a worktree refused"; }
grep -q -- "wrangler deploy --env production --assets .*/.tmp/pwa-deploy-dist --dry-run|" "${FAKE_LOG}" || fail "dry run not passed to wrangler with its own build: $(cat "${FAKE_LOG}")"
# A build outside production goes to its own directory: main's dist is the staging PWA.
grep -q -- "--filter @tarfa/pwa build --outDir .*/.tmp/pwa-deploy-dist --emptyOutDir|" "${FAKE_LOG}" || fail "dry run built into dist: $(cat "${FAKE_LOG}")"
for combo in "--dry-run --dev" "--dry-run --dev --delete"; do
  # shellcheck disable=SC2086
  if run "${WT}/deploy/pwa-deploy.sh" ${combo}; then fail "accepted ${combo}"; fi
  [ -f "${FAKE_LOG}" ] && fail "${combo} ran pnpm"
done
[ -f "${FAKE_LOG}.curl" ] && fail "a dry run checked tarfa.app"
grep -q "^install" "${FAKE_LOG}" && fail "a dry run reinstalled dependencies"

# --- 5. --dev deploys this checkout to tarfa-dev and prints its URL -------------
run "${WT}/deploy/pwa-deploy.sh" --dev || { cat "${SB}/out"; fail "--dev from a worktree refused"; }
grep -q -- "wrangler deploy --env dev --assets .*/.tmp/pwa-deploy-dist|" "${FAKE_LOG}" || fail "--dev did not deploy its own build to env.dev: $(cat "${FAKE_LOG}")"
grep -q -- "--filter @tarfa/pwa build --outDir .*|label=tarfa-dev|" "${FAKE_LOG}" || fail "dev build not labelled tarfa-dev"
grep -q "https://tarfa-dev.someone.workers.dev" "${SB}/out" || fail "--dev does not print the dev URL"
grep -q "\-\-dev \-\-delete" "${SB}/out" || fail "--dev does not say how to delete it"
[ -f "${FAKE_LOG}.curl" ] && fail "--dev checked tarfa.app"

# --- 6. --dev --delete removes the dev Worker, building nothing ------------------
run "${WT}/deploy/pwa-deploy.sh" --dev --delete || { cat "${SB}/out"; fail "--dev --delete refused"; }
grep -q -- "wrangler delete --env dev" "${FAKE_LOG}" || fail "--delete did not delete env.dev"
grep -q "build" "${FAKE_LOG}" && fail "--delete built"
if run "${MAIN}/deploy/pwa-deploy.sh" --delete; then fail "--delete without --dev was accepted"; fi

# --- 6b. a production check that cannot reach tarfa.app says why --------------
cat > "${SB}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl: (6) Could not resolve host: tarfa.app" >&2; exit 6
FAKE
if run "${MAIN}/deploy/pwa-deploy.sh"; then fail "succeeded with tarfa.app unreachable"; fi
grep -q "Could not resolve host" "${SB}/out" || fail "an unreachable tarfa.app is not explained"

# --- 6c. --env-file in a directory that does not exist is named as given ----------
if run "${WT}/deploy/pwa-deploy.sh" --dev --env-file "${SB}/nowhere/x.env"; then fail "accepted a missing env file"; fi
grep -q "nowhere/x.env" "${SB}/out" || fail "missing env file not named as given: $(cat "${SB}/out")"

# --- 7. --env-file names another account's file ---------------------------------
printf 'CLOUDFLARE_ACCOUNT_ID=other-acct\n' > "${SB}/other.env"
run "${WT}/deploy/pwa-deploy.sh" --dev --env-file "${SB}/other.env" || { cat "${SB}/out"; fail "--env-file refused"; }
grep -q "account=other-acct" "${FAKE_LOG}" || fail "--env-file account not used"

echo "pwa-deploy tests passed"
