#!/usr/bin/env bash
# Tests for deploy/relay-cf-deploy.sh against a throwaway git sandbox with a fake pnpm, so no
# Cloudflare call is ever made: it reads its values from the main checkout, refuses a
# production deploy from anywhere but a clean main, and ships its keys as secrets.
set -euo pipefail

# The pre-commit gate exports GIT_* into the environment; strip them so the sandbox's git
# commands don't act on the outer repo.
for _v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "${_v}"; done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
mkdir -p "${REPO}/.tmp"
SB="$(mktemp -d "${REPO}/.tmp/relay-cf-deploy-test.XXXXXX")"
trap 'rm -rf "${SB}"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# relay-cf.env holds the production keys: the deploy refuses it unless it is private, and every
# file this test makes is.
umask 077

# A fake pnpm that records its arguments, the keys its environment holds and a copy of the
# secrets file it was handed. An install is logged on its own.
mkdir -p "${SB}/bin"
cat > "${SB}/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = install ]; then printf '%s\n' "$*" >> "${FAKE_LOG}.install"; exit 0; fi
printf '%s\n' "$@" > "${FAKE_LOG}"
env | grep -E '^(RELAY_[A-Z_]*KEY|JOIN_KEY|ADMIN_KEY)=' > "${FAKE_LOG}.env" || true
printf '%s' "${CLOUDFLARE_ACCOUNT_ID:-}" > "${FAKE_LOG}.account"
prev=''
for arg in "$@"; do
  if [ "${prev}" = "--secrets-file" ]; then cp "${arg}" "${FAKE_LOG}.secrets"; fi
  prev="${arg}"
done
FAKE
chmod +x "${SB}/bin/pnpm"
export PATH="${SB}/bin:${PATH}"
export FAKE_LOG="${SB}/pnpm.log"

MAIN="${SB}/repo"
git init -q -b main "${MAIN}"
git -C "${MAIN}" config user.email t@t
git -C "${MAIN}" config user.name test
mkdir -p "${MAIN}/deploy" "${MAIN}/packages/relay-cf"
printf '.worktrees/\n.tmp/\ndeploy/relay-cf.env\n' > "${MAIN}/.gitignore"
cp "${HERE}/relay-cf-deploy.sh" "${MAIN}/deploy/"
touch "${MAIN}/packages/relay-cf/.keep"
git -C "${MAIN}" add -A
git -C "${MAIN}" commit -qm init
# What main holds is what origin holds: a production deploy compares the two.
git init -q --bare "${SB}/origin.git"
git -C "${MAIN}" remote add origin "${SB}/origin.git"
git -C "${MAIN}" push -q -u origin main
git -C "${MAIN}" worktree add -q "${MAIN}/.worktrees/feature" -b feature

run() { rm -f "${FAKE_LOG}" "${FAKE_LOG}.secrets" "${FAKE_LOG}.install" "${FAKE_LOG}.env"; "$@" >"${SB}/out" 2>&1; }
# Wrangler runs with no key in its environment: they reach it in the secrets file alone.
# The wrangler environment the last run targeted.
targeted_env() { grep -A1 -x -- "--env" "${FAKE_LOG}" | tail -n1; }
no_keys_in_env() { [ ! -s "${FAKE_LOG}.env" ] || fail "$1: wrangler's environment held $(cut -d= -f1 "${FAKE_LOG}.env" | tr '\n' ' ')"; }

# --- 1. no env file in main: refused -----------------------------------------
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed without deploy/relay-cf.env"; fi
grep -q "relay-cf.env" "${SB}/out" || fail "missing-env message does not name the file"

# --- 2. production needs the join key: an env without one is refused by name ----
cat > "${MAIN}/deploy/relay-cf.env" <<'ENV'
CLOUDFLARE_ACCOUNT_ID=acct-123
RELAY_AGENTS='{"acct":"key"}'
ENV
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed without a join key"; fi
[ -f "${FAKE_LOG}" ] && fail "wrangler ran for a deploy without a join key"
grep -q "RELAY_JOIN_KEY" "${SB}/out" || fail "missing-join-key message does not name RELAY_JOIN_KEY"

# --- 2b. clean main: deploys, the join key as a secret, never on the command line ----
# A leftover RELAY_AGENTS is ignored: the accounts live in the relay's registry.
printf "RELAY_JOIN_KEY=the-join-key\n" >> "${MAIN}/deploy/relay-cf.env"
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "clean main did not deploy"; }
grep -qx -- "--secrets-file" "${FAKE_LOG}" || fail "keys not passed as a secrets file"
grep -qx -- "RELAY_AUDIT:0" "${FAKE_LOG}" || fail "audit not off by default"
[ "$(cat "${FAKE_LOG}.secrets")" = '{"JOIN_KEY":"the-join-key"}' ] || fail "secrets file content: $(cat "${FAKE_LOG}.secrets")"
grep -q "the-join-key" "${FAKE_LOG}" && fail "join key passed on the command line"
grep -q "RELAY_ADMIN_KEY" "${SB}/out" || fail "no note that the admin key is missing"
no_keys_in_env "a production deploy"
# No custom domain: the workers.dev host is the relay's only one, so it stays on, and the deploy
# says that no zone rate-limiting rule covers it.
[ "$(targeted_env)" = production-workers-dev ] || fail "a production deploy without a domain targeted '$(targeted_env)', not env.production-workers-dev"
grep -qx -- "--domain" "${FAKE_LOG}" && fail "passed --domain with none configured"
grep -q "workers.dev" "${SB}/out" || fail "no note that the workers.dev host is the only one"
grep -qx "install --frozen-lockfile" "${FAKE_LOG}.install" 2>/dev/null || fail "a production deploy did not install from the lockfile first"
[ -z "$(find "${MAIN}/.tmp" -type f 2>/dev/null)" ] || fail "secrets file left behind"

run "${MAIN}/deploy/relay-cf-deploy.sh" --audit || fail "audit deploy failed"
grep -qx -- "RELAY_AUDIT:1" "${FAKE_LOG}" || fail "--audit did not turn the audit on"

# --- 2c. the admin key rides as a secret too ---------------------------------
printf "CLOUDFLARE_ACCOUNT_ID=acct-123\nRELAY_JOIN_KEY=the-join-key\n" > "${SB}/join.env"
printf "CLOUDFLARE_ACCOUNT_ID=acct-123\nRELAY_JOIN_KEY=the-join-key\nRELAY_ADMIN_KEY=the-admin-key\n" > "${MAIN}/deploy/relay-cf.env"
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "deploy with an admin key refused"; }
[ "$(cat "${FAKE_LOG}.secrets")" = '{"JOIN_KEY":"the-join-key","ADMIN_KEY":"the-admin-key"}' ] || fail "admin key secret: $(cat "${FAKE_LOG}.secrets")"
grep -q "the-admin-key" "${FAKE_LOG}" && fail "admin key passed on the command line"
grep -q "RELAY_ADMIN_KEY" "${SB}/out" && fail "noted a missing admin key that is set"
cp "${SB}/join.env" "${MAIN}/deploy/relay-cf.env"

# --- 3. a worktree reads main's env, but may only dry-run ---------------------
WT="${MAIN}/.worktrees/feature"
if run "${WT}/deploy/relay-cf-deploy.sh"; then fail "deployed from a worktree"; fi
[ -f "${FAKE_LOG}" ] && fail "wrangler ran for a refused deploy"
grep -q "main" "${SB}/out" || fail "refusal does not say why"
run "${WT}/deploy/relay-cf-deploy.sh" --dry-run || { cat "${SB}/out"; fail "dry run from a worktree refused"; }
grep -qx -- "--dry-run" "${FAKE_LOG}" || fail "dry run not passed to wrangler"
# A worktree's wrangler builds the dry run: it gets no key at all, not even in its secrets file.
[ "$(cat "${FAKE_LOG}.secrets")" = '{}' ] || fail "a dry run handed wrangler keys: $(cat "${FAKE_LOG}.secrets")"
no_keys_in_env "a dry run"
[ "$(targeted_env)" = production-workers-dev ] || fail "a dry run without a domain built '$(targeted_env)'"
[ -f "${FAKE_LOG}.install" ] && fail "a dry run reinstalled the worktree's dependencies"

# --- 3b. --dev deploys the dev Worker from anywhere, with its own keys only ---
# The throwaway Worker must never hold production's join key, admin key or accounts.
cp "${MAIN}/deploy/relay-cf.env" "${SB}/before-dev.env"
printf "RELAY_JOIN_KEY=prod-join\nRELAY_ADMIN_KEY=prod-admin\n" >> "${MAIN}/deploy/relay-cf.env"
if run "${WT}/deploy/relay-cf-deploy.sh" --dev; then fail "dev deploy ran without dev keys"; fi
[ -f "${FAKE_LOG}" ] && fail "wrangler ran for a dev deploy without dev keys"
grep -q "RELAY_DEV_JOIN_KEY" "${SB}/out" || fail "dev refusal does not name RELAY_DEV_JOIN_KEY"
printf "RELAY_DEV_JOIN_KEY=dev-join\nRELAY_DEV_ADMIN_KEY=dev-admin\n" >> "${MAIN}/deploy/relay-cf.env"
run "${WT}/deploy/relay-cf-deploy.sh" --dev || { cat "${SB}/out"; fail "dev deploy from a worktree refused"; }
grep -qx -- "--env" "${FAKE_LOG}" && grep -qx -- "dev" "${FAKE_LOG}" || fail "--dev did not target the dev environment"
[ "$(cat "${FAKE_LOG}.secrets")" = '{"JOIN_KEY":"dev-join","ADMIN_KEY":"dev-admin"}' ] || fail "dev secrets: $(cat "${FAKE_LOG}.secrets")"
grep -qx -- "--dry-run" "${FAKE_LOG}" && fail "--dev turned into a dry run"
no_keys_in_env "a dev deploy"
echo change >> "${WT}/packages/relay-cf/.keep"
run "${WT}/deploy/relay-cf-deploy.sh" --dev || fail "dev deploy refused a dirty worktree"
git -C "${WT}" checkout -q -- packages/relay-cf/.keep
run "${MAIN}/deploy/relay-cf-deploy.sh" || fail "production deploy from main failed after a dev one"
grep -qx -- "dev" "${FAKE_LOG}" && fail "a production deploy targeted the dev environment"
grep -q "dev-join" "${FAKE_LOG}.secrets" && fail "a production deploy uploaded the dev join key"
cp "${SB}/before-dev.env" "${MAIN}/deploy/relay-cf.env"
printf "RELAY_DEV_JOIN_KEY=dev-join\n" >> "${MAIN}/deploy/relay-cf.env"

# --- 3c. with a domain, production gets it on env.production (workers.dev off), and the
# throwaway dev Worker never gets one, even from a leftover RELAY_DEV_DOMAIN --
cat >> "${MAIN}/deploy/relay-cf.env" <<'ENV'
RELAY_DOMAIN=relay.example.net
RELAY_DEV_DOMAIN=relay-dev.example.net
ENV
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "production deploy with a domain failed"; }
grep -qx -- "--domain" "${FAKE_LOG}" && grep -qx -- "relay.example.net" "${FAKE_LOG}" || fail "production domain not passed"
[ "$(targeted_env)" = production ] || fail "a production deploy with a domain targeted '$(targeted_env)', not env.production"
grep -q "workers.dev" "${SB}/out" && fail "noted the workers.dev host with a domain set"
run "${WT}/deploy/relay-cf-deploy.sh" --dry-run || fail "dry run with a domain failed"
[ "$(targeted_env)" = production ] || fail "a dry run with a domain built '$(targeted_env)'"
run "${WT}/deploy/relay-cf-deploy.sh" --dev || fail "dev deploy with a domain failed"
grep -qx -- "--domain" "${FAKE_LOG}" && fail "a domain was attached to the throwaway dev Worker"
git -C "${MAIN}" diff --quiet HEAD -- || fail "env edits dirtied main"

# --- 3d. an env file other users can read: refused, naming the fix ------------
chmod 644 "${MAIN}/deploy/relay-cf.env"
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed with a relay-cf.env other users can read"; fi
[ -f "${FAKE_LOG}" ] && fail "wrangler ran with an exposed relay-cf.env"
grep -q "chmod 600" "${SB}/out" || fail "the refusal does not name chmod 600"
if run "${WT}/deploy/relay-cf-deploy.sh" --dry-run; then fail "a dry run read an exposed relay-cf.env"; fi
chmod 600 "${MAIN}/deploy/relay-cf.env"

# --- 3e. --env-file deploys another Cloudflare account, under the same guards ----
# Main's own relay-cf.env must not be read at all: neither its account nor its keys.
mkdir -p "${SB}/other-operator"
printf "CLOUDFLARE_ACCOUNT_ID=acct-other\nRELAY_JOIN_KEY=other-join\nRELAY_ADMIN_KEY=other-admin\n" > "${SB}/other-operator/relay-cf.env"
run bash -c "cd '${SB}/other-operator' && '${MAIN}/deploy/relay-cf-deploy.sh' --env-file relay-cf.env" \
  || { cat "${SB}/out"; fail "--env-file deploy from main refused"; }
[ "$(cat "${FAKE_LOG}.secrets")" = '{"JOIN_KEY":"other-join","ADMIN_KEY":"other-admin"}' ] || fail "--env-file secrets: $(cat "${FAKE_LOG}.secrets")"
[ "$(cat "${FAKE_LOG}.account")" = acct-other ] || fail "--env-file account: $(cat "${FAKE_LOG}.account")"
grep -qx -- "--domain" "${FAKE_LOG}" && fail "--env-file deploy took main's domain"
[ "$(targeted_env)" = production-workers-dev ] || fail "an --env-file deploy without a domain targeted '$(targeted_env)'"
no_keys_in_env "an --env-file deploy"
if run "${WT}/deploy/relay-cf-deploy.sh" --env-file "${SB}/other-operator/relay-cf.env"; then fail "--env-file deployed from a worktree"; fi
if run "${MAIN}/deploy/relay-cf-deploy.sh" --env-file "${SB}/missing.env"; then fail "deployed with a missing --env-file"; fi
grep -q "missing.env" "${SB}/out" || fail "missing --env-file message does not name the file"
if run "${MAIN}/deploy/relay-cf-deploy.sh" --env-file; then fail "accepted --env-file with no path"; fi
chmod 644 "${SB}/other-operator/relay-cf.env"
if run "${MAIN}/deploy/relay-cf-deploy.sh" --env-file "${SB}/other-operator/relay-cf.env"; then fail "deployed with an --env-file other users can read"; fi
grep -q "chmod 600" "${SB}/out" || fail "the --env-file refusal does not name chmod 600"

# --- 4. main with uncommitted changes, or another branch: refused ------------
echo change >> "${MAIN}/deploy/relay-cf-deploy.sh"
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed a dirty main"; fi
git -C "${MAIN}" checkout -q -- deploy/relay-cf-deploy.sh
git -C "${MAIN}" checkout -q -b other
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed from a branch other than main"; fi
git -C "${MAIN}" checkout -q main

# --- 4b. an untracked file, or main apart from origin/main: refused ------------
touch "${MAIN}/stray.txt"
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed a main with an untracked file"; fi
grep -q "uncommitted" "${SB}/out" || fail "untracked refusal does not say why"
rm "${MAIN}/stray.txt"
echo more >> "${MAIN}/packages/relay-cf/.keep"
git -C "${MAIN}" commit -qam unpushed
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed an unpushed commit"; fi
grep -q "origin" "${SB}/out" || fail "unpushed refusal does not name the upstream"
git -C "${MAIN}" push -q origin main
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "deploy refused once main matched origin"; }
# Someone else pushed: the deploy fetches first, and main is behind.
OTHER="${SB}/other"
git clone -q "${SB}/origin.git" "${OTHER}"
git -C "${OTHER}" -c user.email=t@t -c user.name=test commit -q --allow-empty -m elsewhere
git -C "${OTHER}" push -q origin main
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed a main behind origin"; fi
git -C "${MAIN}" pull -q --ff-only
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "deploy refused after catching up"; }
# No upstream set: main is compared with origin/main, as the hooks push it there.
git -C "${MAIN}" branch -q --unset-upstream
run "${MAIN}/deploy/relay-cf-deploy.sh" || { cat "${SB}/out"; fail "deploy refused a main equal to origin/main with no upstream set"; }
git -C "${MAIN}" commit -q --allow-empty -m unpushed-again
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed an unpushed commit with no upstream set"; fi
git -C "${MAIN}" push -q origin main
# Nothing to compare with at all: refused.
git -C "${MAIN}" remote rename origin elsewhere
if run "${MAIN}/deploy/relay-cf-deploy.sh"; then fail "deployed with no origin to compare with"; fi
git -C "${MAIN}" remote rename elsewhere origin

# --- 5. the on-demand dev Worker declares what production does ---------------
# An environment inherits neither Durable Object bindings nor migrations, so env.dev repeats
# them; this keeps the copy from drifting while no dev Worker is deployed to notice.
same_objects() {
  (cd "${REPO}/packages/relay-cf" && node -e '
    import("wrangler").then(({ unstable_readConfig: read }) => {
      const pick = (c) => JSON.stringify([c.durable_objects, c.migrations]);
      const [top, dev, production, open] = [undefined, "dev", "production", "production-workers-dev"].map((env) => read({ config: process.argv[1], env }));
      if ([dev, top, open].some((c) => pick(c) !== pick(production))) { console.error(pick(production), pick(dev), pick(top), pick(open)); process.exit(1); }
      // A bare `wrangler deploy` must never reach production; both production envs are one Worker.
      if (production.name !== "perch-relay" || open.name !== production.name || top.name === production.name || dev.name === production.name) { console.error("names", top.name, dev.name, production.name, open.name); process.exit(1); }
      // With a custom domain, nothing but the domain answers: no zone rule covers a workers.dev host.
      if (production.workers_dev !== false || production.preview_urls !== false || open.workers_dev !== true || top.workers_dev !== false) { console.error("hosts", production.workers_dev, production.preview_urls, open.workers_dev, top.workers_dev); process.exit(1); }
    });' "$1") >/dev/null 2>&1
}
same_objects "${REPO}/packages/relay-cf/wrangler.jsonc" || fail "env.dev, env.production-workers-dev or the top level declares other Durable Objects or migrations than env.production, a bare deploy targets production, or env.production keeps a workers.dev host"
trap 'rm -rf "${SB}" "${REPO}/packages/relay-cf/.wrangler-drift.jsonc"' EXIT
# Production alone gains a migration, the way a change that forgets env.dev would.
node -e 'const fs = require("fs"); const c = fs.readFileSync(process.argv[1], "utf8");
  fs.writeFileSync(process.argv[2], c.replace("\"new_sqlite_classes\": [\"RelayRoom\"] }", "\"new_sqlite_classes\": [\"RelayRoom\"] }, { \"tag\": \"v2\", \"deleted_classes\": [\"Old\"] }"))' \
  "${REPO}/packages/relay-cf/wrangler.jsonc" "${REPO}/packages/relay-cf/.wrangler-drift.jsonc"
cmp -s "${REPO}/packages/relay-cf/wrangler.jsonc" "${REPO}/packages/relay-cf/.wrangler-drift.jsonc" && fail "drift fixture did not change the config"
same_objects "${REPO}/packages/relay-cf/.wrangler-drift.jsonc" && fail "a drifted env.dev was not noticed"

echo "relay-cf-deploy tests passed"
