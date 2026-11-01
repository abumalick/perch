# tmux with OSC 7501 program status

Perch derives a workspace's status from Claude Code and Codex hooks. Some turn ends fire no hook
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
  `tmux-spawn-*.scope`, which Perch's workspace close reaps.

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
- `finished` and `parked` are the user's; OSC never moves a workspace off them.
- The first sighting of a pane only records its state: a record has no heartbeat, so after an
  agent restart it may be hours old. A stuck `working` from before is therefore not healed until
  the next transition.
- Every applied change is logged to `~/.perch/hook-events.jsonl` as event `OSC7501`, with
  `programState` and the rule that decided.
- With a stock tmux the formats expand to nothing, and the hooks alone decide.

A titled `perch spawn` used to start Claude with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` so it
would not overwrite the title; that switch also turns off Claude's OSC 7501. Where tmux has
`allow-set-title` (3.5+, so any patched build), the spawn locks the pane's title instead.

## Build

Linux needs `libevent-dev libncurses-dev libsystemd-dev bison autoconf automake pkg-config`.

```sh
deploy/tmux-osc7501/build.sh          # 3.8 + patch → ~/.local/opt/tmux-osc
deploy/tmux-osc7501/build.sh check    # smoke test on a private socket
```

`--prefix DIR` installs elsewhere; `--master` builds the pinned master commit with the upstream
patch. The build never touches the `tmux` on `PATH`, and `check` runs its own server on a private
`-S` socket without `$TMUX` or any config. `check` verifies the probe order, every state rule
above, and (on Linux) the `tmux-spawn-*.scope`.

**macOS (Homebrew):** `brew install libevent ncurses utf8proc pkg-config autoconf automake bison`,
then the same two commands. The script puts Homebrew's bison first (macOS's is too old), points
`pkg-config` at the Homebrew libraries and adds `--enable-utf8proc`; there is no systemd.

The patched agent test runs only when `PERCH_TMUX_OSC` names the binary:
`PERCH_TMUX_OSC=~/.local/opt/tmux-osc/bin/tmux pnpm --filter @perch/agent exec vitest run src/infrastructure/tmux-adapter.osc.test.ts`.

## Cutover

**Switching costs every live workspace its process.** A tmux client cannot talk to a server of
another protocol version, so the server must be replaced, which ends every pane and every
`claude` in it. What survives: workspaces whose Claude session id is known come back **parked**
(the server-lost recovery, `live.json`), and opening one resumes its conversation; the others
are recorded in `~/.perch/workspace-log.jsonl` as `server-lost`. Pick a moment when that is fine.

Everything that talks to the server finds `tmux` on `PATH`: the agent, the `tmux-server` unit and
its script, `perch-hook.sh`, the `perch` CLI, tmux-resurrect and every shell. So the switch is one
binary swap plus one server restart, done back to back: between the two, new clients cannot reach
the old server.

### Linux (systemd `tmux-server` unit)

1. Deploy the agent first (merge, then `systemctl --user restart perch-agent`). It degrades to the
   hooks with the old tmux, so this can go out on its own.
2. Build and check: `deploy/tmux-osc7501/build.sh && deploy/tmux-osc7501/build.sh check`.
3. Check the tmux config parses under the new version (`-n` executes nothing):
   `env -u TMUX ~/.local/opt/tmux-osc/bin/tmux -S ~/.cache/tmux-parse -f /dev/null start-server \; source-file -n ~/.config/tmux/tmux.conf`, then
   `env -u TMUX ~/.local/opt/tmux-osc/bin/tmux -S ~/.cache/tmux-parse kill-server`.
4. Save the layout (tmux-resurrect), from a pane: `~/.config/tmux/plugins/tmux-resurrect/scripts/save.sh`.
5. Put the new binary where the packaged one was. `PATH` order differs between the systemd user
   manager (`/usr/local/bin` first) and login shells (often `/usr/bin` first), so no extra
   directory wins in both; a diversion moves Debian's `/usr/bin/tmux` aside (apt upgrades then
   keep it there) and frees its path:
   `sudo dpkg-divert --local --rename --divert /usr/bin/tmux.distrib --add /usr/bin/tmux && sudo ln -s ~/.local/opt/tmux-osc/bin/tmux /usr/bin/tmux`.
   Check that `tmux -V`, `zsh -lc 'tmux -V'` and `env -i PATH=/usr/bin tmux -V` all name the
   new version. (These clients cannot reach the old server; carry straight on.)
6. Replace the server at once. The unit refuses a manual stop, so kill it:
   `systemctl --user kill tmux-server`. `Restart=always` starts the new binary two seconds later,
   and its script restores the saved layout as bare shells.
7. `systemctl --user restart perch-agent`: at startup it parks the lost workspaces and kills the
   bare shells resurrect brought back for them.
8. Verify: `tmux -V` names the new version; `systemctl --user status tmux-server`;
   `tmux list-panes -a -F '#{session_name} #{pane_program_state}'` shows states once Claude runs;
   `grep OSC7501 ~/.perch/hook-events.jsonl | tail`; and on the phone, an Esc-interrupted turn
   leaves "Needs you" within a few seconds.

**Rollback:** `sudo rm /usr/bin/tmux && sudo dpkg-divert --rename --remove /usr/bin/tmux`, then
`systemctl --user kill tmux-server` and `systemctl --user restart perch-agent`. It costs the live
workspaces again.

### macOS (launchd agent, no tmux unit)

1. Deploy the agent (pull, `launchctl kickstart -k gui/$(id -u)/com.perch.agent`).
2. Build and check as above (Homebrew dependencies first).
3. Stop the old server **with the old client**: `tmux kill-server`.
4. Put the new binary in Homebrew's place, keeping Homebrew's tmux installed for a rollback:
   `brew unlink tmux && ln -s ~/.local/opt/tmux-osc/bin/tmux "$(brew --prefix)/bin/tmux"`.
5. `launchctl kickstart -k gui/$(id -u)/com.perch.agent`; the agent's first tmux call starts the
   new server.

**Rollback:** `tmux kill-server`, `rm "$(brew --prefix)/bin/tmux" && brew link tmux`, kickstart the
agent. A `brew upgrade` that relinks tmux undoes step 4; run it again after one.

### After the cutover

Codex runs its hooks outside the pane unless started with `--no-daemon`; its OSC 7501 reports come
from its own pane either way, so Codex status no longer depends on hook trust or the daemon flag.
