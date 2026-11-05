# tmux with OSC 7501 program status

Tarfa derives a workspace's status from Claude Code and Codex hooks. Some turn ends fire no hook
at all (an Esc interrupt), so a session can stay `working` long after it stopped. Both CLIs also
report their status with **OSC 7501**, the Program Status Protocol (draft by Mitchell Hashimoto:
states `idle`, `working`, `done`, `blocked`, `error`). Stock tmux drops the sequence and never
answers its `OSC 7501 ; ?` probe, and Claude Code reports only after that probe is answered, so
inside tmux nothing gets through.

`deploy/tmux-osc7501/` holds a tmux patch that fixes that, and a script that builds it into a
separate prefix. With it, the agent reads each pane's status as a second source beside the hooks.
Without it, the agent behaves exactly as before.

## What the patch does

`0001-osc-7501-master.patch` is written against tmux master, in the shape of an upstream change;
`0001-osc-7501-3.8.patch` is the same change on the 3.8 release, which is what the script builds
by default.

- Answers the probe (`OSC 7501 ; ? : states=… : kinds=…`), queued like any other reply, so it
  reaches the program before the answer to the DA1 query it sends next. That order is how Claude
  Code decides the terminal supports the protocol.
- Keeps each pane's root record (a report without `id`): formats `pane_program_state`,
  `pane_program_kind`, `pane_program_app`, `pane_program_time` (time of the last change). Child
  records are ignored; an invalid report is discarded.
- Fires a `pane-program-changed` hook (`hook_program_state`, `hook_program_kind`,
  `hook_program_app`).
- As the protocol asks: `working` and `blocked` are dropped when the program exits or a new
  shell prompt starts (OSC 133 `A`), `done` and `error` survive both, and `RIS` clears the record.
- Keeps systemd support (`--enable-systemd`): every pane still gets its own
  `tmux-spawn-*.scope`, which Tarfa's workspace close reaps.

## How the agent uses it

The agent adds `#{pane_program_state}` and `#{pane_program_time}` to the `list-sessions` call it
already makes, and every 2 s tick (connected phone or not) applies a **change** of state
(`application/program-status-decision.ts`):

| OSC state | Workspace status |
|---|---|
| `working` | `working` |
| `blocked` | `needs-feedback` |
| `done`, `error` | `needs-feedback`, unless a hook mark holds it `working` |
| `idle` while `working` | `needs-feedback` (an Esc interrupt; Codex's turn end) |

- **The hooks stay.** They alone give the Claude session id (parking), `messagedLast` ("Needs
  orchestrator") and the background-task deferral. OSC says `done` while a background shell still
  runs and while a child waits on its orchestrator, so a turn end never overrides those marks.
  OSC's `done` also lands before the Stop hook does: when it already set needs-feedback, a Stop
  that defers takes that back to `working`. It takes back nothing else, so a permission prompt
  (or OSC `blocked`) raised while a background subagent runs still reads "Needs you".
- `finished` and `parked` are the user's; OSC never moves a workspace off them.
- The first sighting of a pane only records its state: a record has no heartbeat, so after an
  agent restart it may be hours old. A stuck `working` from before is therefore not healed until
  the next transition.
- Every applied change is logged to `~/.tarfa/hook-events.jsonl` as event `OSC7501`, with
  `programState` and the rule that decided.
- With a stock tmux the formats expand to nothing, and the hooks alone decide.

A titled `tarfa spawn` used to start Claude with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` so it
would not overwrite the title; that switch also turns off Claude's OSC 7501. Where tmux has
`allow-set-title` (3.5+, so any patched build), the spawn locks the pane's title instead.

## Build

Linux needs `libevent-dev libncurses-dev libsystemd-dev bison autoconf automake pkg-config`.

```sh
deploy/tmux-osc7501/build.sh          # 3.8 + patch → /opt/tmux-osc (sudo for the install only)
deploy/tmux-osc7501/build.sh check    # smoke test on a private socket
```

The default prefix is root-owned on purpose. The cutover makes `/usr/bin/tmux` a link to it, and
every account on the machine runs that binary: a build under a home directory other users cannot
enter (mode 750 or 700) would fail for all of them with "permission denied". `--prefix DIR`
installs elsewhere (for a scratch build); `--master` builds the pinned master commit with the upstream
patch. The build never touches the `tmux` on `PATH`, and `check` runs its own server on a private
`-S` socket without `$TMUX` or any config. `check` verifies the probe order, every state rule
above, and (on Linux) the `tmux-spawn-*.scope`.

**macOS (Homebrew):** `brew install libevent ncurses utf8proc jemalloc pkg-config autoconf automake bison`,
then the same two commands. The script puts Homebrew's bison first (macOS's is too old), points
`pkg-config` at the Homebrew libraries and adds `--enable-utf8proc --enable-jemalloc` (3.8's
configure stops on macOS without a jemalloc choice); there is no systemd.

The patched agent test runs only when `TARFA_TMUX_OSC` names the binary:
`TARFA_TMUX_OSC=/opt/tmux-osc/bin/tmux pnpm --filter @tarfa/cli exec vitest run src/infrastructure/tmux-adapter.osc.test.ts`.

## Cutover

**Switching costs every live workspace its process.** The patch lives in the server, so the
running server must be replaced, which ends every pane and every `claude` in it. What survives: workspaces whose Claude session id is known come back **parked**
(the server-lost recovery, `live.json`), and opening one resumes its conversation; the others
are recorded in `~/.tarfa/workspace-log.jsonl` as `server-lost`. Pick a moment when that is fine.

Everything that talks to the server finds `tmux` on `PATH`: the agent, the `tmux-server` unit and
its script, `tarfa-hook.sh`, the `tarfa` CLI, tmux-resurrect and every shell. So the switch is a
binary swap plus a server restart, **done as one step**. A 3.8 client answers `ls` from a running
3.4 server, but it cannot *attach* to one ("open terminal failed: not a terminal"): between the
swap and the restart every Tarfa terminal opened (each is an attach) fails. Check a cutover with a
real attach, not `tmux -V` or `ls`:
`script -qec "tmux new-session -s attach-check 'sleep 1'" /dev/null` must exit 0.

tmux-resurrect and tmux-continuum ran under 3.8 on macOS (continuum restored the saved layout).

### Linux (systemd `tmux-server` unit)

1. Deploy the agent first (merge, then `systemctl --user restart tarfa-agent`). It degrades to the
   hooks with the old tmux, so this can go out on its own.
2. Build and check: `deploy/tmux-osc7501/build.sh && deploy/tmux-osc7501/build.sh check`.
3. Check the tmux config parses under the new version (`-n` executes nothing):
   `env -u TMUX /opt/tmux-osc/bin/tmux -S ~/.cache/tmux-parse -f /dev/null start-server \; source-file -n ~/.config/tmux/tmux.conf`, then
   `env -u TMUX /opt/tmux-osc/bin/tmux -S ~/.cache/tmux-parse kill-server`.
4. Save the layout (tmux-resurrect), from a pane: `~/.config/tmux/plugins/tmux-resurrect/scripts/save.sh`.
5. Swap the binary and replace the server in one go, when losing the live workspaces is fine.
   The new binary goes where the packaged one was: `PATH` order differs between the systemd user
   manager (`/usr/local/bin` first) and login shells (often `/usr/bin` first), so no extra
   directory wins in both; a diversion moves Debian's `/usr/bin/tmux` aside (apt upgrades then
   keep it there) and frees its path. The unit refuses a manual stop, so it is killed;
   `Restart=always` starts the new binary two seconds later, and its script restores the saved
   layout as bare shells:
   `sudo dpkg-divert --local --rename --divert /usr/bin/tmux.distrib --add /usr/bin/tmux && sudo ln -s /opt/tmux-osc/bin/tmux /usr/bin/tmux && systemctl --user kill tmux-server`.
   **Every account on the machine now runs this binary**, so each other account's server (also
   started from `/usr/bin/tmux`) must be replaced in the same window, or its terminals stop
   attaching too: kill it as that user, by its own unit or socket.
6. `systemctl --user restart tarfa-agent` (and each other account's agent): at startup it parks
   the lost workspaces and kills the bare shells resurrect brought back for them.
7. Verify: `tmux -V`, `zsh -lc 'tmux -V'` and `env -i PATH=/usr/bin tmux -V` name the new
   version; the attach check above exits 0, as this account and as each other one
   (`sudo -u <other user> script -qec "tmux new-session -s attach-check 'sleep 1'" /dev/null`);
   `systemctl --user status tmux-server`;
   `tmux list-panes -a -F '#{session_name} #{pane_program_state}'` shows states once Claude runs;
   `grep OSC7501 ~/.tarfa/hook-events.jsonl | tail`; and on the phone, an Esc-interrupted turn
   leaves "Needs you" within a few seconds.

**Rollback:** `sudo rm /usr/bin/tmux && sudo dpkg-divert --rename --remove /usr/bin/tmux`, then
`systemctl --user kill tmux-server` and `systemctl --user restart tarfa-agent`. It costs the live
workspaces again. `/opt/tmux-osc` can stay; `sudo rm -rf /opt/tmux-osc` once nothing links to it.

### macOS (launchd agent, no tmux unit)

1. Deploy the agent (pull, `launchctl kickstart -k gui/$(id -u)/app.tarfa.agent`).
2. Build and check as above (Homebrew dependencies first).
3. Save the layout if tmux-resurrect runs (`~/.config/tmux/plugins/tmux-resurrect/scripts/save.sh`).
4. Swap the binary and replace the server in one go: a new client cannot attach to the old
   server, so every terminal opened in between would fail. The new binary goes in Homebrew's
   place, keeping Homebrew's tmux installed for a rollback, and the old server is killed with
   the old binary:
   `touch ~/tmux_no_auto_restore; brew unlink tmux && ln -s /opt/tmux-osc/bin/tmux "$(brew --prefix)/bin/tmux" && "$(brew --prefix)/Cellar/tmux/<old version>/bin/tmux" -L default kill-server`.
   The running agent parks the lost workspaces on its next poll (`~/.tarfa/parked.json`).
5. **Let the agent start the new server; never start it from an ssh session.** A tmux server
   started over ssh lives outside the login session, so its panes cannot read the login
   keychain: every `claude` in it reports "Not logged in". `tarfa unpark <id>...` asks the agent
   (a launchd GUI agent) to create the sessions, so the first one starts the server there.
   Session commands sent over ssh afterwards are fine: panes are forked by the server.
   tmux-continuum would restore the saved layout as bare shells when that server starts and
   race the unpark for the same names; `~/tmux_no_auto_restore` (step 4) halts it, so remove
   that file once the workspaces are back, and recreate any bare shell by hand.
6. Verify with the attach check, in BSD `script` syntax and with a terminal type (a
   non-interactive ssh has none, and tmux's "unsuitable terminal" looks like the skew error):
   `TERM=xterm-256color script -q /dev/null tmux new-session -s attach-check 'sleep 1'`.

**Rollback:** `tmux -L default kill-server`, `rm "$(brew --prefix)/bin/tmux" && brew link tmux`,
kickstart the agent, then unpark. A `brew upgrade` that relinks tmux undoes step 4; run it again
after one.

### After the cutover

Codex runs its hooks outside the pane unless started with `--no-daemon`; its OSC 7501 reports come
from its own pane either way, so Codex status no longer depends on hook trust or the daemon flag.
