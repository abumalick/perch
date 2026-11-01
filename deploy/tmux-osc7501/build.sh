#!/usr/bin/env bash
# Builds tmux with the OSC 7501 program status patch into a separate prefix, and smoke-tests it.
#
#   deploy/tmux-osc7501/build.sh [--master] [--prefix DIR]   build and install
#   deploy/tmux-osc7501/build.sh check [--prefix DIR]        smoke-test an installed build
#
# It never touches the tmux on PATH or a running server: it installs into the prefix only
# (default ~/.local/opt/tmux-osc), and `check` runs its own server on a private `-L` socket,
# started without $TMUX and without any config. Switching a machine over is a separate, manual
# step: docs/TMUX-OSC7501.md.
#
# The default build is the 3.8 release with the backported patch; --master builds the pinned
# master commit the upstream-shaped patch is written against.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=$HOME/.local/opt/tmux-osc
SRC=${XDG_CACHE_HOME:-$HOME/.cache}/tmux-osc7501/src
REPO=https://github.com/tmux/tmux.git
REF=3.8
PATCH=$HERE/0001-osc-7501-3.8.patch
MODE=build

while [ $# -gt 0 ]; do
  case $1 in
    check) MODE=check ;;
    --master)
      REF=a73616d781f2af13085691c741cfb0780d365328
      PATCH=$HERE/0001-osc-7501-master.patch
      ;;
    --prefix) PREFIX=$2; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

build() {
  local configure_args=(--prefix="$PREFIX")
  case $(uname -s) in
    Linux)
      # Perch reaps each pane's tmux-spawn-*.scope on close, which needs systemd support.
      configure_args+=(--enable-systemd)
      ;;
    Darwin)
      command -v brew >/dev/null || { echo 'Homebrew is required on macOS' >&2; exit 1; }
      local pkg
      for pkg in libevent ncurses utf8proc pkg-config autoconf automake bison; do
        brew list --versions "$pkg" >/dev/null || { echo "missing: brew install $pkg" >&2; exit 1; }
      done
      # macOS ships a bison too old for tmux's grammar.
      PATH="$(brew --prefix bison)/bin:$PATH"
      export PKG_CONFIG_PATH="$(brew --prefix libevent)/lib/pkgconfig:$(brew --prefix ncurses)/lib/pkgconfig:$(brew --prefix utf8proc)/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
      configure_args+=(--enable-utf8proc)
      ;;
  esac

  if [ ! -d "$SRC/.git" ]; then
    mkdir -p "$(dirname "$SRC")"
    git clone --quiet "$REPO" "$SRC"
  fi
  git -C "$SRC" fetch --quiet --tags origin
  # The source tree is this script's own cache: reset it to exactly the pinned ref + patch.
  git -C "$SRC" checkout --quiet --force --detach "$REF"
  git -C "$SRC" clean --quiet -fdx
  git -C "$SRC" apply "$PATCH"

  (
    cd "$SRC"
    sh autogen.sh >/dev/null
    ./configure "${configure_args[@]}" >/dev/null
    make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >/dev/null
    make install >/dev/null
  )
  echo "installed $("$PREFIX/bin/tmux" -V) (+OSC 7501) in $PREFIX"
}

CHECK_DIR=
# Every call names a private socket (-S beats $TMUX), so the user's server is never reached.
t() { env -u TMUX "$PREFIX/bin/tmux" -S "$CHECK_DIR/s" -f /dev/null "$@"; }

check() {
  local fails=0
  [ -x "$PREFIX/bin/tmux" ] || { echo "no tmux at $PREFIX/bin/tmux; build first" >&2; exit 1; }
  CHECK_DIR=$(mktemp -d)
  trap 't kill-server 2>/dev/null; rm -rf "$CHECK_DIR"' EXIT

  t new-session -d -s check -x 80 -y 24 sh
  sleep 0.3
  expect() {
    local sequence=$1 want=$2 got
    t send-keys -t check "printf '$sequence'" Enter
    sleep 0.3
    got=$(t display-message -p -t check '#{pane_program_state}|#{pane_program_kind}|#{pane_program_app}')
    if [ "$got" = "$want" ]; then echo "ok    $sequence -> $got"; else echo "FAIL  $sequence -> $got (want $want)"; fails=$((fails + 1)); fi
  }
  expect '\033]7501;state=working:app=claude-code\033\\' 'working||claude-code'
  expect '\033]7501;state=done:id=child\033\\' 'working||claude-code'
  expect '\033]7501;state=bogus\033\\' 'working||claude-code'
  expect '\033]7501;state=blocked:kind=question\007' 'blocked|question|'
  expect '\033]133;A\007' '||'
  expect '\033]7501;state=done\033\\' 'done||'
  expect '\033]133;A\007' 'done||'
  expect '\033]7501;state=clear\033\\' '||'
  expect '\033]7501;state=working\033\\' 'working||'
  expect '\033c' '||'

  # The probe must be answered before the DA1 that follows it: that order is how a program
  # (Claude Code) decides the terminal supports the protocol.
  local out=$CHECK_DIR reply
  t new-session -d -s probe "stty raw -echo min 0 time 10; printf '\\033]7501;?\\033\\\\\\033[c'; cat > '$out/reply'"
  sleep 2
  reply=$(LC_ALL=C tr -c '[:print:]' '.' < "$out/reply")
  case $reply in
    .]7501\;\?:states=*.\[\?*c) echo "ok    probe answered before DA1: $reply" ;;
    *) echo "FAIL  probe reply: $reply"; fails=$((fails + 1)) ;;
  esac

  if [ "$(uname -s)" = Linux ]; then
    local pid
    pid=$(t display-message -p -t check '#{pane_pid}')
    if grep -q 'tmux-spawn-.*\.scope' "/proc/$pid/cgroup"; then echo 'ok    pane runs in a tmux-spawn-*.scope'
    else echo "FAIL  pane cgroup: $(cat "/proc/$pid/cgroup")"; fails=$((fails + 1)); fi
  fi

  if [ "$fails" -ne 0 ]; then echo "$fails check(s) failed"; exit 1; fi
  echo "all checks passed ($("$PREFIX/bin/tmux" -V))"
}

"$MODE"
