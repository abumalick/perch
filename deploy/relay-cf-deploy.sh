#!/usr/bin/env bash
# Deploys the Cloudflare relay (packages/relay-cf) with the values from the main checkout's
# gitignored deploy/relay-cf.env, wherever it is run from (like serve-agent.sh reads main's
# agent.env).
#
# The join key (JOIN_KEY, from RELAY_JOIN_KEY, required) and the operator's admin key (ADMIN_KEY,
# from RELAY_ADMIN_KEY, optional: without it listing and removing machines answer 501) are
# uploaded as Worker secrets with the version, and a later deploy keeps them: deploys delete
# plain vars, never secrets. The accounts served live in the Worker's registry, which machines
# join with the join key.
#
# Production is wrangler's env.production (env.production-workers-dev, the same Worker, when no
# RELAY_DOMAIN is set), which only this script targets: wrangler.jsonc's top level is a local
# Worker of its own, so a bare `wrangler deploy` never reaches production.
# A production deploy only runs from a clean main checkout that matches origin/main (after a
# fetch), with its dependencies installed from the lockfile, so what is live is always what
# main holds. A worktree can check its build with
# --dry-run, or deploy it to a throwaway dev Worker (perch-relay-dev, wrangler's env.dev: its own
# workers.dev host and Durable Objects) with --dev. The dev Worker is on demand: deploy it only
# for a change to Durable Object bindings or migrations, or to how the Worker deploys, and delete
# it afterwards (`wrangler delete --env dev` from packages/relay-cf). It never gets a custom
# domain, and it gets keys of its own (RELAY_DEV_JOIN_KEY, optional RELAY_DEV_ADMIN_KEY), never
# production's keys: whatever deploys a throwaway Worker should not hold them. Nor does wrangler,
# on any path: it gets only CLOUDFLARE_ACCOUNT_ID from the file, and the keys reach it in the
# secrets file alone. A dry run reads no key.
#
#   deploy/relay-cf-deploy.sh             # production deploy
#   deploy/relay-cf-deploy.sh --dev       # deploy this checkout to a throwaway dev Worker, from any checkout
#   deploy/relay-cf-deploy.sh --audit     # also log each frame's size and first bytes (verification)
#   deploy/relay-cf-deploy.sh --dry-run   # build and check only, from any checkout
#   deploy/relay-cf-deploy.sh --env-file <path>   # another Cloudflare account's id, keys and domain
#                                                  # instead of main's relay-cf.env (same guards)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
main="$(cd "$(dirname "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)"

audit=0
dry_run=0
dev=0
env_file="$main/deploy/relay-cf.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --audit) audit=1 ;;
    --dry-run) dry_run=1 ;;
    --dev) dev=1 ;;
    --env-file)
      [ -n "${2:-}" ] || { echo "--env-file needs a path" >&2; exit 2; }
      env_file="$(cd "$(dirname "$2")" 2>/dev/null && pwd -P)/$(basename "$2")"
      shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$env_file" ] || { echo "missing $env_file (template: deploy/relay-cf.env.example)" >&2; exit 1; }
# It holds the production join and admin keys.
mode="$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")"
(( (8#$mode & 8#077) == 0 )) || { echo "$env_file is readable or writable by other users (mode $mode): run \`chmod 600 $env_file\`" >&2; exit 1; }
# One value from the file, read in a subshell: nothing it sets reaches this script's environment,
# and so none of it reaches wrangler.
value() {
  # shellcheck source=/dev/null
  (. "$env_file" >/dev/null && printf '%s' "${!1:-}")
}
CLOUDFLARE_ACCOUNT_ID="$(value CLOUDFLARE_ACCOUNT_ID)"
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "set CLOUDFLARE_ACCOUNT_ID in deploy/relay-cf.env" >&2; exit 1; }
export CLOUDFLARE_ACCOUNT_ID
join_key='' admin_key=''
if [ "$dev" = 1 ]; then
  join_key="$(value RELAY_DEV_JOIN_KEY)" admin_key="$(value RELAY_DEV_ADMIN_KEY)"
  [ -n "$join_key" ] || { echo "set RELAY_DEV_JOIN_KEY in deploy/relay-cf.env: the dev Worker never gets production's keys" >&2; exit 1; }
elif [ "$dry_run" = 0 ]; then
  join_key="$(value RELAY_JOIN_KEY)" admin_key="$(value RELAY_ADMIN_KEY)"
  [ -n "$join_key" ] || { echo "set RELAY_JOIN_KEY in deploy/relay-cf.env: machines join the relay with it" >&2; exit 1; }
fi

if [ "$dry_run" = 0 ] && [ "$dev" = 0 ]; then
  [ "$root" = "$main" ] || { echo "refusing to deploy from $root: production deploys run from the main checkout ($main); use --dry-run here" >&2; exit 1; }
  branch="$(git -C "$root" branch --show-current)"
  [ "$branch" = main ] || { echo "refusing to deploy branch '$branch': production deploys run from main" >&2; exit 1; }
  [ -z "$(git -C "$root" status --porcelain)" ] || { echo "refusing to deploy: main has uncommitted or untracked files" >&2; exit 1; }
  # Its upstream when one is set, else origin/main (the hooks push main there explicitly).
  upstream="$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo origin/main)"
  git -C "$root" fetch --quiet "${upstream%%/*}" "${upstream#*/}" \
    || { echo "refusing to deploy: could not fetch $upstream to compare main with" >&2; exit 1; }
  [ "$(git -C "$root" rev-parse HEAD)" = "$(git -C "$root" rev-parse "refs/remotes/$upstream")" ] \
    || { echo "refusing to deploy: main is not $upstream (push or pull first)" >&2; exit 1; }
  # The Worker bundles third-party code (@noble/*) from node_modules, which the checks above do
  # not see: install exactly what main's lockfile names.
  (cd "$root" && pnpm install --frozen-lockfile) || { echo "refusing to deploy: pnpm install --frozen-lockfile failed" >&2; exit 1; }
fi

mkdir -p "$root/.tmp"
secrets="$(umask 077 && mktemp "$root/.tmp/relay-cf-secrets.XXXXXX")"
trap 'rm -f "$secrets"' EXIT
[ -n "$admin_key" ] || [ -z "$join_key" ] || echo "note: no RELAY_ADMIN_KEY (RELAY_DEV_ADMIN_KEY for --dev) in deploy/relay-cf.env: perch-relay machines will answer 501" >&2
JOIN_KEY="$join_key" ADMIN_KEY="$admin_key" node -e '
  const secrets = {};
  for (const name of ["JOIN_KEY", "ADMIN_KEY"]) if (process.env[name]) secrets[name] = process.env[name];
  process.stdout.write(JSON.stringify(secrets));' > "$secrets"

args=(deploy --var "RELAY_AUDIT:$audit" --secrets-file "$secrets")
# A custom domain (RELAY_DOMAIN) is attached on every production deploy (Cloudflare creates its
# DNS record and certificate) and is then the relay's only host: env.production turns the
# workers.dev host off, since the zone's rate-limiting rule never sees traffic to it. Without a
# domain, env.production-workers-dev deploys the same Worker on its workers.dev host.
relay_domain="$(value RELAY_DOMAIN)"
if [ "$dev" = 1 ]; then
  args+=(--env dev)
elif [ -n "$relay_domain" ]; then
  args+=(--env production --domain "$relay_domain")
else
  args+=(--env production-workers-dev)
  echo "note: no RELAY_DOMAIN in $env_file: the relay answers on its workers.dev host only, which no zone rate-limiting rule can cover" >&2
fi
[ "$dry_run" = 1 ] && args+=(--dry-run)
cd "$root/packages/relay-cf"
pnpm exec wrangler "${args[@]}"
