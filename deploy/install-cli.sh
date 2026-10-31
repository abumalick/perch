#!/usr/bin/env bash
# Puts the Perch CLI on PATH: links ~/.local/bin/perch to this checkout's deploy/perch-cli.sh.
# Run it once per machine, from the main checkout (the link follows that checkout, so a
# `git pull` there updates the CLI). Safe to re-run; never replaces a file that is not a link.
set -euo pipefail
REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${REPO}/deploy/perch-cli.sh"
bin="${HOME}/.local/bin"
link="${bin}/perch"

mkdir -p "${bin}"
if [ -e "${link}" ] && [ ! -L "${link}" ]; then
  echo "refusing to replace ${link}: it is not a symlink (move it away first)" >&2
  exit 1
fi
ln -sfn "${target}" "${link}"
echo "${link} -> ${target}"
case ":${PATH}:" in
  *":${bin}:"*) ;;
  *) echo "note: ${bin} is not on PATH; add it to use \`perch\`" >&2 ;;
esac
