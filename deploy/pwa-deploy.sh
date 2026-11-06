#!/usr/bin/env bash
# Deploys the PWA to tarfa.app, a static-assets Worker (packages/pwa/wrangler.jsonc), with the
# Cloudflare account from the main checkout's gitignored deploy/pwa-deploy.env, wherever it is
# run from. The file names the account and PWA_DEPLOY_TOKEN_CMD, a command that prints a scoped
# API token (e.g. `bw get password <item>`). The token goes only into wrangler's environment, for
# each wrangler call, and is never printed; without it nothing that reaches Cloudflare runs, so
# wrangler never falls back to an OAuth login it may hold.
#
# A production deploy (env.production: the Worker `tarfa` on the tarfa.app custom domain) runs
# only from a clean main checkout that matches its upstream after a fetch, with dependencies
# installed from the lockfile, so what is live is always what main holds. It is done once
# tarfa.app serves the build just made: its version.json names the commit and build time.
#
#   deploy/pwa-deploy.sh                    # production deploy, from a clean, pushed main
#   deploy/pwa-deploy.sh --dry-run          # build and check only, from any checkout
#   deploy/pwa-deploy.sh --dev              # this checkout to the throwaway tarfa-dev Worker
#   deploy/pwa-deploy.sh --dev --delete     # remove tarfa-dev once the test is done
#   deploy/pwa-deploy.sh --env-file <path>  # another Cloudflare account's file (same guards)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
main="$(cd "$(dirname "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)"

dry_run=0
dev=0
delete=0
env_file="$main/deploy/pwa-deploy.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --dev) dev=1 ;;
    --delete) delete=1 ;;
    --env-file)
      [ -n "${2:-}" ] || { echo "--env-file needs a path" >&2; exit 2; }
      env_file="$2"
      [ -d "$(dirname "$2")" ] && env_file="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
      shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$delete" = 0 ] || [ "$dev" = 1 ] || { echo "--delete removes the dev Worker only: use --dev --delete" >&2; exit 2; }
[ "$dry_run" = 0 ] || [ "$dev" = 0 ] || { echo "--dry-run checks the production build only; it does not combine with --dev or --delete" >&2; exit 2; }

[ -f "$env_file" ] || { echo "missing $env_file (template: deploy/pwa-deploy.env.example)" >&2; exit 1; }
# Read in a subshell, so nothing else the file sets reaches wrangler.
# shellcheck source=/dev/null
CLOUDFLARE_ACCOUNT_ID="$( (. "$env_file" >/dev/null && printf '%s' "${CLOUDFLARE_ACCOUNT_ID:-}") )"
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "set CLOUDFLARE_ACCOUNT_ID in $env_file" >&2; exit 1; }
export CLOUDFLARE_ACCOUNT_ID
# shellcheck source=/dev/null
token_cmd="$( (. "$env_file" >/dev/null && printf '%s' "${PWA_DEPLOY_TOKEN_CMD:-}") )"
token=''
fetch_token() {
  [ -n "$token_cmd" ] || { echo "set PWA_DEPLOY_TOKEN_CMD in $env_file: a command that prints the scoped Cloudflare API token" >&2; exit 1; }
  token="$(bash -c "$token_cmd")" || { echo "PWA_DEPLOY_TOKEN_CMD failed: no token, nothing deployed" >&2; exit 1; }
  [ -n "$token" ] || { echo "PWA_DEPLOY_TOKEN_CMD printed nothing: no token, nothing deployed" >&2; exit 1; }
}
# Wrangler with the token in its own environment only; the build and git never see it.
wrangler() { CLOUDFLARE_API_TOKEN="$token" pnpm exec wrangler "$@"; }

pwa="$root/packages/pwa"
if [ "$delete" = 1 ]; then
  fetch_token
  cd "$pwa"
  wrangler delete --env dev
  exit 0
fi

production=0
[ "$dry_run" = 1 ] || [ "$dev" = 1 ] || production=1
if [ "$production" = 1 ]; then
  [ "$root" = "$main" ] || { echo "refusing to deploy from $root: production deploys run from the main checkout ($main); use --dry-run or --dev here" >&2; exit 1; }
  branch="$(git -C "$root" branch --show-current)"
  [ "$branch" = main ] || { echo "refusing to deploy branch '$branch': production deploys run from main" >&2; exit 1; }
  [ -z "$(git -C "$root" status --porcelain)" ] || { echo "refusing to deploy: main has uncommitted or untracked files" >&2; exit 1; }
  upstream="$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo origin/main)"
  git -C "$root" fetch --quiet "${upstream%%/*}" "${upstream#*/}" \
    || { echo "refusing to deploy: could not fetch $upstream to compare main with" >&2; exit 1; }
  [ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$root" rev-parse "refs/remotes/$upstream")" ] \
    || { echo "refusing to deploy: main is not $upstream (push or pull first)" >&2; exit 1; }
  fetch_token
  (cd "$root" && pnpm install --frozen-lockfile) || { echo "refusing to deploy: pnpm install --frozen-lockfile failed" >&2; exit 1; }
fi
# A dry run reaches no account, so it needs no token.
[ "$dev" = 0 ] || fetch_token

# The build's id names the commit and the time, so the check below can tell this build from the
# one it replaces. A dev build carries a label, which the app shows as a badge. Outside
# production the build goes to its own directory: packages/pwa/dist in the main checkout is
# what the tailnet staging PWA serves, and a dry run may come from uncommitted work.
build_id="$(git -C "$root" rev-parse --short=12 HEAD)-$(date +%s)"
label=main
[ "$dev" = 1 ] && label=tarfa-dev
assets=()
build=(pnpm --filter @tarfa/pwa build)
if [ "$production" = 0 ]; then
  out="$root/.tmp/pwa-deploy-dist"
  assets=(--assets "$out")
  build+=(--outDir "$out" --emptyOutDir)
fi
(cd "$root" && TARFA_BUILD_LABEL="$label" TARFA_BUILD_ID="$build_id" "${build[@]}")

cd "$pwa"
if [ "$dev" = 1 ]; then
  log="$(wrangler deploy --env dev "${assets[@]}" | tee /dev/stderr)"
  url="$(printf '%s\n' "$log" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n1 || true)"
  echo "tarfa-dev: ${url:-see the wrangler output above}"
  echo "delete it after the test: deploy/pwa-deploy.sh --dev --delete"
  exit 0
fi
if [ "$dry_run" = 1 ]; then
  pnpm exec wrangler deploy --env production "${assets[@]}" --dry-run
  exit 0
fi

wrangler deploy --env production
# A new custom-domain version takes a few seconds to answer everywhere.
deadline=$(( $(date +%s) + ${PWA_DEPLOY_WAIT_S:-60} ))
mkdir -p "$root/.tmp"
served='' error_text=''
while :; do
  error="$(mktemp "$root/.tmp/pwa-deploy-curl.XXXXXX")"
  served="$(curl -fsS --max-time 10 "https://tarfa.app/version.json?t=$(date +%s)" 2>"$error" || true)"
  error_text="$(cat "$error")"; rm -f "$error"
  case "$served" in *"\"buildId\":\"$build_id\""*) echo "tarfa.app serves $build_id"; exit 0 ;; esac
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 2
done
echo "deployed, but tarfa.app still serves ${served:-nothing${error_text:+ ($error_text)}} instead of $build_id" >&2
exit 1
