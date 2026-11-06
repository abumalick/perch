#!/usr/bin/env bash
# Puts the Tarfa CLI on PATH: links ~/.local/bin/tarfa to this checkout's deploy/tarfa-cli.sh,
# and ~/.local/bin/perch, its name before the rename, to `tarfa` for one release.
# Run it once per machine, from the main checkout (the link follows that checkout, so a
# `git pull` there updates the CLI). Safe to re-run; never replaces a file that is not a link.
set -euo pipefail
REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${REPO}/deploy/tarfa-cli.sh"
bin="${HOME}/.local/bin"

mkdir -p "${bin}"
for name in tarfa perch; do
  if [ -e "${bin}/${name}" ] && [ ! -L "${bin}/${name}" ]; then
    echo "refusing to replace ${bin}/${name}: it is not a symlink (move it away first)" >&2
    exit 1
  fi
done
ln -sfn "${target}" "${bin}/tarfa"
ln -sfn tarfa "${bin}/perch"
echo "${bin}/tarfa -> ${target}"
echo "${bin}/perch -> tarfa"
case ":${PATH}:" in
  *":${bin}:"*) ;;
  *) echo "note: ${bin} is not on PATH; add it to use \`tarfa\`" >&2 ;;
esac
