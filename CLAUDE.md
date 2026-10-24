# Perch — agent guide

Perch is a mobile-first PWA to view and interact with Claude Code terminal sessions
(tmux workspaces) running on multiple machines, from an iPhone. An **agent** runs on each
machine (e.g. a Mac and a Linux box) and dials out to one or more **relays**; the **PWA**
reaches each agent only through a relay, in an end-to-end Noise session keyed by the phone's
device key, and streams its terminals. No agent listens on a phone-facing port.

## Golden rules
- **All code, docs, comments, and commits in English.**
- **Testability is the top priority.** Clean / hexagonal architecture: pure domain +
  application (ports) layers, all I/O behind infrastructure/adapters. Unit-test the core
  with fakes; keep a thin, well-covered adapter layer.
- **Surgical changes, YAGNI.** Match surrounding style. Add comments only for genuinely
  tricky logic, not to restate code.
- Toolchain via **mise** (`mise.toml` pins node 24 + pnpm 11). Package manager is **pnpm**
  (workspace monorepo). Any Python would use **uv** (none today).
- **Never commit secrets.** Tokens live in `deploy/agent.env` (gitignored) and in a password manager. `deploy/agent.env.example` is the template.

## Layout
- `packages/contracts` (`@perch/contracts`) — the zod wire protocol and shared types.
  `ClientMessage` / `AgentMessage` discriminated unions. Terminal `data` is base64.
  **Change the protocol here first**, then the agent and PWA.
- `packages/agent` (`@perch/agent`) — per-machine agent. tmux via `node:child_process`,
  terminal streaming via `node-pty`, a `RelayLink` per relay that dials a socket back for
  each phone (served through `NoiseClientConnection`), and a `node:http` server on
  `127.0.0.1` whose only route is the bearer-token-guarded `POST /hooks` (Claude Code hooks
  report attention here).
  Domain/application in `application/` + `ports/`, adapters in `infrastructure/`, wiring in
  `server/`.
- `packages/relay` (`@perch/relay`), `packages/relay-cf`, `packages/secure-channel` — the
  relay core and its two hosts, and the Noise session both ends run (see the relay section).
- `packages/pwa` (`@perch/pwa`) — Svelte 5 (runes) PWA. xterm.js terminal, vite-plugin-pwa
  (auto-update), Playwright e2e. Core logic (connection manager, aggregator, store) is in
  `src/core` + `src/adapters` and unit-tested with a fake socket; `src/lib` is the UI.

## Commands (per package via `pnpm --filter @perch/<pkg> …`)
- Test: `test` (vitest). Types: `typecheck`. Build (pwa): `build`. E2E (pwa):
  `exec playwright test` (uses a faithful fake agent in `e2e/fake-agent.ts`).
- Run the whole suite: `pnpm -s test`. Keep it green; add tests with every change.

## Worktrees & on-device testing
Build each feature in its own git worktree; full runbook in `docs/WORKTREES.md`.
- **NEVER do feature work in the main checkout — and NEVER `git checkout`/`git checkout -b`
  there.** The main checkout is shared: switching its branch or leaving edits in its working
  tree blocks every other agent and process bound to it (the standing deploy, other worktrees'
  expectations). Start a feature with its own worktree *first* (below), before editing. If you
  somehow already have uncommitted edits in the main checkout, surface it and move them into a
  worktree — do not `checkout -b` in place to "branch" them.
- Create: `git worktree add .worktrees/<feature> -b <feature>` (`.worktrees/` is gitignored),
  then `pnpm install` (node_modules is per-worktree). Unit/integration tests bind ephemeral
  ports, so they run in parallel across worktrees with no clash.
- **e2e ports clash** — `vite preview` uses a fixed port. On the host running `run-pwa.sh`,
  **4173 is the standing deploy**; give each checkout its own:
  `E2E_PORT=4175 pnpm --filter @perch/pwa e2e` (build first — `vite preview` serves the gitignored `dist/`).
- **Test a worktree build on the phone:** `pnpm serve:build .worktrees/<feature>` points the
  live deploy at it (installed PWA auto-updates in ~60s; the home header shows the worktree
  slug as a badge); `pnpm serve:restore` flips back to main.
- **Protocol changes need the worktree's agent too:** the PWA and agent share the zod wire
  protocol, so testing a protocol change on-device requires running the worktree's agent or
  the deployed (main) agent silently drops the new/changed messages. `pnpm serve:agent
  .worktrees/<feature>` runs that worktree's agent live (flips `deploy/agent-live`, restarts
  the service — safe via `KillMode=process`); it dials the same relays with the same identity,
  so the phone's entries reach it unchanged. `pnpm serve:agent-restore` flips back. Secrets
  and relays come from main's `deploy/agent.env`. Make additive protocol fields backward-compatible
  (e.g. `z.array(...).default([])`) so a version-skewed rollout degrades gracefully instead
  of the strict client parser dropping the whole message.

## Runtime & deployment
See `docs/DEPLOY.md` for the full runbook. In short:
- Each agent reads `deploy/agent.env` (`PERCH_TOKEN`, `PERCH_MACHINE_ID`,
  `PERCH_PROJECT_ROOTS`, `PERCH_PORT` for the loopback hooks listener, `PERCH_RELAY_URLS`) and
  runs as a service: **launchd** on macOS
  (`deploy/com.perch.agent.plist`), **systemd user unit + linger** on Ubuntu. Both invoke
  `deploy/run-agent.sh`, which self-locates `mise` (services don't inherit an interactive
  PATH). Run `mise trust` once per machine or the unit crash-loops.
- **An agent is reached only through its relays.** It binds `127.0.0.1` whatever
  `PERCH_HOST` says (a non-loopback value is ignored with a warning), serves only `POST /hooks`
  there, and is never published with `tailscale serve`. `pnpm perch connect` joins a machine
  to a relay; `perch pair` pairs a phone (relay section).
- The PWA is built and served on the always-on machine via `deploy/run-pwa.sh` +
  `tailscale serve`, and added to the iPhone home screen.
  - **The host running `run-pwa.sh`:** it keeps a `vite preview`
    process serving the `deploy/pwa-live` symlink (defaults to `packages/pwa/dist/`), fronted
    by `tailscale serve` on :8443. The preview stays up and serves whatever the symlink points
    at, so `pnpm --filter @perch/pwa build` alone re-deploys here — no process restart, just
    reload the PWA. `pnpm serve:build` temporarily repoints the symlink at a worktree build
    (see above).
- Install Claude Code hooks on each agent machine: the agent CLI `install-hooks` command.
- **Hidden folders are per-machine, file-based config — not a protocol/PWA feature.** A
  gitignored `~/.perch/hidden-folders.json` (JSON array of folder names) on each agent
  machine hides matching projects from workspaces, recent paths, and the folder picker
  (`is-hidden-path.ts`: any path segment equal to a listed name is filtered). Read fresh
  from disk on every call (`FileHiddenFoldersStore`) — no caching, so edits take effect
  immediately with no agent restart. Missing or malformed file → empty list (opt-in;
  filtering only activates once the file exists). Manage it directly on each machine (there's
  no CLI/PWA UI to edit it), and set it up separately per machine — nothing syncs it.
- **Command shortcuts are per-machine, file-based config too — but they cross the wire.** A
  gitignored `~/.perch/commands.json` (JSON array of `{command, submit?}`) on each agent
  machine fills the keyboard bar's `/` drop-down. Unlike hidden folders (agent-internal, only
  the *effect* crosses the wire), the PWA needs the contents, so it follows the
  `listRoots`/`roots` request/reply shape: `listCommands` → `commands`. The PWA asks on every
  (re)connect and keys the result by connection id (`store.machineCommands`), so **an edit
  takes effect on the next reconnect, not immediately** — that's the one property this gives
  up versus hidden folders. Missing/malformed file → empty list → the `/` button doesn't
  render at all. `parse-commands.ts` degrades entry-by-entry (a bad `submit` costs the flag,
  not the command) since the file is hand-edited. Set it up separately per machine.
- **The Create Workspace command list is per machine: detected CLIs plus remembered ones.**
  The PWA sends `listLaunchers` each time the form opens (`askCreateData`) and the agent answers
  `launchers {detected, custom}`. `detected` is `claude`/`codex` resolved **through the login
  shell** (`$SHELL -lc 'command -v …'`) — the service's own PATH lacks `~/.local/bin`, so
  walking it would hide Claude. Only the shell's exit 1 means "absent": a failing profile, a
  timeout or an unstartable shell keeps the CLI offered, since hiding Claude would silently make
  Bash the form's default. A PATH set only in `.zshrc` is invisible to a login shell. Bash is always
  offered. `custom` is a gitignored `~/.perch/launchers.json` (capped at 20): a `create` carrying
  `remember: true` — set only when the Custom radio was used — adds its command after the
  workspace exists, unless it is exactly `bash`/`claude`/`codex` (so `claude --resume` typed as
  Custom is kept). A remembered command runs as typed, with no model picker; `forgetLauncher`
  removes one. An agent that predates this never answers, and the PWA keeps the fixed
  Claude/Codex/Bash list. Needs an agent restart per machine.
- **Dictation presets are on-device config: no agent, no protocol.** The 🎤 records in the PWA
  and sends the audio straight from the phone, either to ElevenLabs Scribe or to an OpenRouter
  model that hears it and follows the preset's prompt (`adapters/openrouter-transcriber.ts`);
  `PresetTranscriber` picks one per dictation from the current preset. A long press (500 ms,
  `HOLD_MS`) on the mic opens the presets; its badge shows the current one; Settings edits them
  and holds both keys. **Only a preset whose provider has a key can be used**: the current
  preset is the chosen one if it has its key, else the first that does (`currentPreset`), a
  keyless one is disabled in the menu, and with no key at all the mic is not rendered.
  Things not to "simplify":
  - **The defaults live in code until the user edits the list** (`DEFAULT_PRESETS`, nothing
    seeded into `perch.dictationPresets`), so an update can replace a model id OpenRouter has
    retired for everyone who never customised. Nothing personal ships: the default prompt
    cleans up in the language spoken, and a translation preset is the user's own.
  - **An OpenRouter reply is typed as one line.** A newline reaching the pty submits the line
    (a shell would run a half-dictated command); a bracketed paste is no better, since Claude
    Code folds it into an unreadable `[Pasted text]`.
  - **Each attempt gets 15 s + 10 s per MB of audio, then one retry** (hang, network error,
    429/5xx, or a 200 carrying an upstream `error`). Measured: Gemini Flash answers in ~2 s
    when routed through Vertex and in ~13 s through AI Studio, which OpenRouter picks about one
    time in three, with rare minutes-long hangs. The `google-vertex` provider order is
    best-effort tuning, not a guarantee; forbidding fallbacks produced the worst hang.
  - **The long press ends the key's press itself** (`cancel()` in the hold timer): the finger
    lifts over the menu's backdrop, so the mic never sees its own `pointerup`. While recording
    the hold is not armed, so a slow press still stops the recording.
- **Connection-event log — a client→agent diagnostic that survives drops.** The PWA records
  connection lifecycle events (`connect`/`online`/`close`/`manual-reconnect` per machine —
  `manual-reconnect` = the user tapped Reconnect, `auto-reconnect` = a foreground/`online`
  event drove `reconnectAll` — plus app-global `visible`/`hidden`/`net-online`/`net-offline`),
  each stamped with the WS close `code`,
  `navigator.onLine`, and `document.visibilityState` — the three signals that separate
  iOS-backgrounding from network loss from a tailnet link drop. Events buffer in a durable
  localStorage ring (`core/connection-log.ts`, key `perch.connlog`) that survives an app kill,
  and flush **per-machine** inside the relay session after a reconnect (`clientLog` →
  `clientLogAck`; `core/connection-log-flush.ts`, driven from
  `store.setStatus`/`setConnectionError` and `App.svelte`'s visibility/online handlers via
  `store.logConnectivity`). The flush rides the *new* session, so the events about why the old
  one died are not lost with it; it fails soft (no `ok` ack → events stay buffered, drain next
  reconnect). The agent appends one JSON line per event to a gitignored
  `~/.perch/client-log.jsonl` (`FileClientLogStore`); a batch over 512 KB is refused. Dedup by
  `(sess, seq)` at read (a global event may appear once per machine it flushed to). No PWA/UI
  to read it; analyse the file on the box.
- **Workspace lifecycle log — a durable record of every closed workspace, agent-side only.**
  `WsServer` tracks each live workspace's last-known snapshot (`lastWorkspaces`, the same map
  that already drives rename/disappearance detection); whenever one stops existing it appends
  one JSON line — id, name, project path, machine id, created/closed timestamps, a reason
  (`closed-by-user` for an explicit PWA close, `exited` for a shell exit/crash/manual
  `tmux kill-session`), and the last known attention status — to a gitignored
  `~/.perch/workspace-log.jsonl` (`FileWorkspaceLogStore`). An explicit close snapshots via
  `WsServer.forgetWorkspace(id)` *before* killing the tmux session (tmux can't answer
  afterward) and falls back to a fresh tmux lookup if the workspace was closed within its
  first title-poll tick. The log write is best-effort (a failure must never fail the close
  or crash the poll's fire-and-forget interval). No PWA/UI, no protocol change; read the file
  by hand on the box. Two edge cases are accepted by design (a narrow duplicate-log race, and log writes failing silently).
- **Parking a workspace — stop the session, keep the conversation.** Setting a workspace's
  status to `parked` (renamed from `postponed`) kills its tmux session to free the `claude`
  process, and snapshots what's needed to revive it — id, name, path, command, and the
  captured `claudeSessionId` — into a gitignored `~/.perch/parked.json`
  (`FileParkedStore`). `listWorkspaces` unions parked records with live tmux sessions, so
  a parked workspace stays in the list with no protocol change, no new `Workspace` field,
  and no PWA logic — and the disappearance poll never sees it vanish, so it logs no
  spurious `exited`. Opening it recreates the session with `--resume` injected into the
  **original** command (`claude --model 'opus[1m]' --resume <id>`, preserving flags), then
  clears the record. **The parked record — not `status === 'parked'` — is the source of
  truth for behavior:** the rename migration relabels pre-existing live workspaces to
  `parked` with no record, so status-keyed logic would try to recreate a live session on
  attach. The unpark command carries a `|| exec <original>` tail because
  `claude --resume <unknown-id>` is a hard error that would otherwise destroy the
  workspace. **A known `claudeSessionId` is required to park at all** — without one the
  conversation could not be resumed, so parking would free the resources and silently throw
  the conversation away, which is worse than not parking; `parkWorkspace` returns
  `not-restorable` and the agent sends an `error` the PWA shows as a dismissible banner
  (`ActionErrorBanner`, fed by `store.actionError` — the fallback arm of the `error` handler,
  for refusals no view owns). The id arrives with the first Claude Code hook event, so a
  workspace becomes parkable once it is used; non-Claude workspaces (Codex, zsh) cannot be
  parked. Codex hooks report status too, but their `session_id` is never recorded
  (`applyHookEvent` skips it for `agent: 'codex'`): unparking would run `claude --resume` on it. `FileStatusStore`
  migrates the old `postponed` literal on read, since nothing syncs config between machines.
  At agent startup, `reconcileParked` kills any tmux session whose id collides with a
  parked record — the one case is tmux-continuum resurrecting a parked id as a Claude-less
  shell on restart — so the parked record stays the single source of truth. Requires an
  agent rebuild + restart per machine.
- **Workspaces lost with the tmux server come back parked.** Everything dies with the tmux
  server — a reboot, or a session's own `pkill -f <pattern>` matching `tmux -D` — usually with
  the agent beside it, so the disappearance poll never sees them go, and the startup prune then
  drops their status entries (and session ids). `trackLiveWorkspaces` keeps a gitignored
  `~/.perch/live.json` (`FileLiveSnapshotStore`): every live workspace in the parked-record shape,
  plus the server's identity (`TmuxPort.serverId`, `#{pid}:#{start_time}` from
  `display-message`, which an empty but running server still answers). It runs at startup
  **before** `reconcileParked` and the prune, and on every poll tick **before** `pollTitles`,
  connected client or not. **The server identity is the discriminator:** a workspace missing
  while the same server runs is an ordinary exit and is just dropped; one missing after the
  identity changed (or with no server) is logged `server-lost` and, when its Claude session id
  is known, written to `parked.json`, so the PWA lists it as parked and opening it resumes the
  conversation. A session present on the new server without `@perch_command` counts as lost too
  (tmux-resurrect's bare shell), and `reconcileParked` kills it. An explicit close or park drops
  the entry at once (`forgetWorkspace`). Accepted edge: on a machine whose tmux server exits
  with its last session, that last workspace exiting on its own comes back parked; close it.
  Nothing reopens on its own: starting every lost `claude` at once is a real memory cost.

- **Closing a workspace reaps the pane's systemd scope — and acknowledges before it does.**
  tmux (built with systemd support) puts every pane it spawns in its own transient
  `tmux-spawn-<uuid>.scope`. `tmux kill-session` only SIGHUPs the pane's process **group**, so
  anything that called `setsid()` — a backgrounded dev server, or a self-daemonizing tool like
  `adb`'s fork-server or `Xvfb` — survives with no tmux session left to find it by. Left alone,
  such scopes accumulate indefinitely, holding memory/swap and squatting localhost ports.
  `closeWorkspace` resolves the pane's scope **before** the kill (`/proc/<pid>/cgroup` vanishes
  with the process, so afterwards there is nothing to read) and returns it; `reapWorkspaceScope`
  stops it with `systemctl --user stop`. `SystemdScopeReaper` **refuses any unit that is not
  `tmux-spawn-<uuid>.scope`** — a pane under a tmux built without systemd support sits in
  `perch-agent.service`, and stopping that would kill the agent itself. Linux-only by
  construction: on macOS `scopeForPid` returns null and the leak remains.
  **Two orderings carry the design.** Claude Code exits gracefully on SIGTERM as well as SIGHUP
  (verified: its `~/.claude/sessions/<pid>.json` registry entry, key and socket are all removed;
  only SIGKILL leaves a stale entry), so the scope stop cannot strand a session — but the tmux
  kill must still come first. And the `closed` reply is sent **before** the slow tail
  (`finishClose` — the scope stop, then the agent-browser cascade, which waits on a Chrome
  shutdown). Don't move either back in front of the acknowledgement: everything after the kill
  only touches the local machine, and waiting on it is what made the phone's close button feel
  hung. Reaping is best-effort at every layer — a workspace must still close on a machine where
  none of this works. There is no exclusion list, so a shared daemon started from a workspace
  (the `adb` fork-server is the one that bites) dies with it; re-running `adb connect` is the cost.
- **Machine load strip — two figures, both measured from the footprint left once
  reclaimable cache is gone.** The agent pushes a `stats` message (CPU, physical memory, swap,
  and the per-user cgroup limit when one exists) every 5s while a client is connected; the home
  screen shows one compact line per machine (`core/machine-load.ts` + `lib/MachineLoad.svelte`),
  cleared when the machine goes offline so a stale reading is never shown as current. The line
  is `RAM <slow> left · <kill> before kill`, from `headroomBytes`:
  `slow = totalBytes − (usedBytes − reclaimable)` and `kill = maxBytes − (usedBytes − reclaimable)`.
  **Reclaimable cache counts as free in both, never as used:** `memory.current` counts it, so
  a healthy machine sits at its `memory.high` indefinitely while the kernel just drops cache.
  The slowdown starts when the *footprint* reaches `memory.high` and every allocation must
  swap; `memory.max` is the kill. No usage ratio, fraction or swap figure is shown — they
  were dropped as noise, since none of them answers "can I start something now". The kill
  figure is omitted when there is no separate kill line (uncapped, or `max ≤ high`); an
  uncapped machine shows MemAvailable alone. Four things not to "simplify":
  - The limit is found by **walking the agent's own cgroup up to the nearest ancestor that sets
    `memory.high`/`memory.max`** — a uid- or unit-name-keyed lookup breaks on any other machine.
  - **`totalBytes` is `min(high, max)` and `maxBytes` is a separate field.** `high` is where
    the slice slows down, `max` where the kernel kills; the strip shows the room before each.
  - **`reclaimableBytes` subtracts `file_mapped`** from `file + slab_reclaimable`. Mapped pages
    are reclaimable in principle but are the working set of running programs; counting them as
    free overstates the cushion, and a safety figure that overstates is worse than none.
  - **The band is the worst of three signals**: the room before slowing down against thresholds (`HEADROOM_WARN_BYTES` 3G /
    `HEADROOM_ALERT_BYTES` 0.5G — the knobs), the PSI `some avg10` stall (what is being felt
    *now*), and **growth in `memory.events` `oom_kill` since the client connected**. That last
    one is not redundant: a kill frees the memory that caused it, so the very next reading looks
    healthy and nothing else can report that anything died. The agent sends the raw cumulative
    counter; `store.oomKillsSince` keeps the per-connection baseline (deliberately **not**
    dropped when the machine goes offline — a kill landing while the phone is backgrounded is
    the one most worth surfacing — and re-baselined if the counter goes backwards, which means
    the cgroup was recreated).
  On this class of box the kernel kills by `oom_score_adj`, **not** by size: agent-spawned
  helpers (`adb`, `esbuild`, dbus, gpg-agent) carry 200 against a Claude session's 100, so a
  real kill looks like tooling breaking oddly rather than a workspace vanishing.
  A **`?` opens `MachineLoadHelp`**, which explains that machine's own live reading — it takes
  the same `LoadDescription` the strip rendered rather than re-deriving from `stats`, so the
  two cannot disagree, and it prints the thresholds via `formatBytes(HEADROOM_*)` so the prose
  survives a retune. Two layout traps, both of which pass every size assertion:
  **`.load` must not set `overflow: hidden`** — the button is a 32px tap target pulled back
  with negative margins, so clipping the row shaves its top and bottom and the circle paints as
  an ellipse (`boundingBox` still reports 32×32, so only a screenshot catches it); truncation
  belongs to `.figures`. And the button needs **explicit equal `width`/`height`**, not `min-*`:
  a stretched flex item with `border-radius: 50%` is an ellipse too. The strip's `aria-hidden`
  sits on `.figures`, **not** the wrapper — a focusable button inside an aria-hidden subtree is
  unreachable. Whitespace at an `{#if}` boundary is trimmed, so the optional kill figure joins
  the line with an explicit `{' '}`.
  `ProcSystemStats` is Linux-only by construction: elsewhere `read()` returns null, no
  `stats` is sent, and the strip does not render. All the headroom reads are best-effort — a
  kernel that exposes none of them still yields a reading, and the fields are optional on the
  wire so a version-skewed agent degrades to the old strip. Requires an agent restart per machine.
- **Reconnect must replace the connect chain, never stack a second one.** `MachineConnection`'s
  backoff retry is a fire-and-forget timer with no cancel handle, and `reconnect()` clears the
  `closedByUser` kill-switch. Before the fix, tapping Reconnect (or the app auto-firing
  `reconnectAll` on every foreground/`online`) started a *new* connect while a pending retry was
  still queued, so overlapping chains stacked up; each left a socket stalled in CONNECTING that
  WebKit never tears down, saturating the per-host pool and wedging reconnect until the user
  toggled the machine off/on (the only path that called `close()`, which quiesced everything).
  Fix: a monotonic `generation` token bumped by `reconnect()`/`close()`; the retry captures it
  and no-ops if superseded, so at most one chain is ever live. `onOpen`/`onMessage` also guard
  `this.socket === socket` so a late-opening orphan can't authenticate. Don't reintroduce an
  uncancellable retry or let `reconnect()` add chains without superseding the old one.
- **Reconnect UX: auto-recover calmly, don't interrupt in-flight connects.** `reconnectAll`
  (app refocus / browser `online` / the home Reconnect button) **skips machines already
  `connecting`** — aborting an in-flight attempt to restart it just resets progress on a
  slow-to-establish path (a phone waking, Tailscale cold); the 10s connect-deadline reaps a
  genuinely stalled one anyway. It only kicks idle-`offline` machines; a `connecting` one gets
  its backoff reset instead (`resetBackoff`, no abort). An attempt left in flight while the app
  was backgrounded fails right after it returns, and before this it then waited the backoff the
  background had built up (10 s), which on-device logs showed as the slowest foregrounds. The home screen shows a
  distinct calm **`reconnecting`** view ("Reconnecting…", spinner, no button) for a machine that
  reached `online` at least once this session (`store.reachedOnce`) and is briefly down — vs the
  alarming `unreachable` "Can't reach your machines / Reconnect" which is reserved for a machine
  that has **never** connected this session. **The `reconnecting` view falls through to
  `unreachable` after a longer grace** (`RECONNECT_GRACE_MS` = 25s, an adaptive duration on the
  single existing grace timer keyed off `reachedOnce`; `anyReconnecting` is gated on
  `!graceElapsed`) so a genuine extended outage surfaces the relay hint + button instead of
  an eternal spinner. `deriveHomeView`'s `anyReconnecting` is otherwise stable within the window
  so it doesn't flicker with the backoff `connecting`↔`offline` cycle. The home button
  passes `reconnectAll(true)` → logs `manual-reconnect` (vs `auto-reconnect` for refocus). This
  came from on-device logs: the old 4s-grace flip to "Can't reach" made the user tap Reconnect,
  and each tap aborted an about-to-succeed connect, making recovery *slower*.

- **The relay — reaching a machine without the tailnet, end-to-end encrypted.** Runbook and
  threat model: `docs/relay-cf-runbook.md`. **Exactly two supported hosts over one core:** the
  Cloudflare Worker (`packages/relay-cf`, the default to start with) and the self-hosted Node
  relay (`packages/relay`, the `perch-relay` service). How a self-hosted relay is reached is
  its operator's business: Tailscale is one way, never a requirement, and VPS or tunnel setups
  are possible but not supported (no Cloudflare Tunnel support; it was tried and dropped).
  An agent holds a control socket to each relay in `PERCH_RELAY_URLS` (the old single `PERCH_RELAY_URL` is ignored, with a warning) and dials back one socket per client; every byte
  between phone and agent is a Noise IK session (`packages/secure-channel`) pinned to the agent's key and
  carrying the phone's own device key, so the relay forwards ciphertext only. Things not to "simplify":
  - **A machine entry is connectable only with a valid 32-byte agent key, and never connects in
    plaintext.** Without one it gets no socket at all, and Settings refuses to save an entry
    with its key cleared. (A stored `relay: true` from older builds is read and ignored.)
    **An old direct entry (no key) left in storage is never connected and never silently deleted:**
    Settings shows it as "Old direct entry — no longer supported; pair this machine again" with
    only Delete, and the home screen ignores it. The PWA has no plaintext socket left to give it.
  - **The chunk flag is the AEAD's associated data.** Outside it, the relay could merge or
    cut messages undetected. Any change to framing or the handshake is a wire-format change:
    bump the prologue, and ship the agent and PWA together (`serve:agent` + `serve:build`).
  - **Deploy the Worker only with `deploy/relay-cf-deploy.sh`, from a clean main.** It reads
    main's gitignored `deploy/relay-cf.env` and uploads `JOIN_KEY` (required) and `ADMIN_KEY` as secrets. Nothing host- or
    account-specific goes in the repo. "Clean" is enforced: no uncommitted or untracked files,
    and `HEAD` equal to its upstream (else `origin/main`) after a fetch. `--dev` deploys any checkout to a throwaway dev Worker
    (wrangler `env.dev`) with **its own keys** (`RELAY_DEV_JOIN_KEY`, optional
    `RELAY_DEV_ADMIN_KEY`; it refuses without the first and never uploads production's keys),
    **on demand only**: for a change to Durable Object bindings or
    migrations or to the deploy itself, deleted afterwards (`wrangler delete --env dev`). There
    is no permanent dev Worker. **Production is wrangler's `env.production`** (or
    `env.production-workers-dev`, the same Worker, for a relay with no custom domain), which
    only the script targets; `wrangler.jsonc`'s top level is a local Worker of its own
    (`perch-relay-local`, no host, no keys), so a bare `wrangler deploy` never replaces
    production. Don't move production back to the top level. A test keeps the top level's,
    `env.dev`'s and both production environments' Durable Objects and migrations equal,
    production's name to those two, and `env.production`'s `workers_dev` and `preview_urls` off. **Wrangler never holds a key in its environment**: the script
    reads each value in a subshell, exports only `CLOUDFLARE_ACCOUNT_ID`, passes the keys in the
    secrets file only, and a `--dry-run` reads none. A production deploy runs
    `pnpm install --frozen-lockfile` first (the Worker bundles `@noble/*` from `node_modules`).
    `--env-file <path>` reads another env file (one per Cloudflare account, outside the repo) under
    the same guards; that account's PWA goes on a static-assets Worker beside its relay (runbook,
    "A relay and PWA in your own Cloudflare account"; `docs/SETUP-MACHINE.md` for the whole machine).
  - **`packages/relay` stays host-agnostic** (no Cloudflare types): the Node server
    (`perch-relay`, config in `~/.perch/relay/config.json`) is the self-hosted host beside
    `packages/relay-cf`, over the same core. **Both run one conformance suite**
    (`packages/relay/src/conformance.ts`, the test API injected because the two packages run
    different vitest versions); a relay change passes it on both hosts, and a behaviour only
    one host has is a bug in the other.
  - **Dev flow: the local relay for everything.** The dev machine runs the self-hosted relay as
    the `perch-relay` user service on localhost (`serve:relay` / `serve:relay-restore`, like
    the agent), published to the tailnet with `tailscale serve --https=8451`; `wrangler dev`
    (local workerd) when iterating on the Cloudflare adapter; production deploys only from main.
    `wrangler dev` listens on **:8788** (`dev.port` in `wrangler.jsonc`; its default 8787 is the
    agent's `PERCH_PORT`) and needs `JOIN_KEY` in `packages/relay-cf/.dev.vars` (template
    `.dev.vars.example`), or joining answers 501.
    **The `serve:*` scripts and `worktree:remove` act on main's `deploy/*-live` symlinks from any
    checkout** (they resolve main with `git rev-parse --git-common-dir`, like
    `relay-cf-deploy.sh`), so `pnpm serve:relay .` inside a worktree flips the live relay.
    One agent key is one account on every relay, so the phone keeps an entry per relay and
    toggles. **The agent's own control socket stays on `ws://127.0.0.1:8450`.**
  - **The self-hosted relay caps connections per host and per client address itself**, and
    **believes no client-IP header unless `clientIpHeader` is set** in
    `~/.perch/relay/config.json` — and then only from a loopback peer (a proxy on the same
    machine; keep the relay bound to `127.0.0.1`). Trusting `CF-Connecting-IP` from any
    loopback peer let every tailnet device forge its address through `tailscale serve`.
    **A loopback peer that names no client counts against the host cap only**: keyed on its one
    address, six connections through a local proxy would lock out every other client, the owner
    included. The agent's roles count against the host cap only too.
  - **A superseded agent backs off, it does not redial.** The relay closes an older control
    socket for the same account with 4000; `RelayLink` then waits 1 → 15 minutes instead of
    resetting its backoff on the next open, which is what made two agents sharing
    `~/.perch/relay-key.json` knock each other off every second. Never run a second agent
    against the production relay; give a hand-run one only `ws://127.0.0.1:8450`.
  - **Media previews, the browser view and the connection-log flush ride the session**
    (`session-channels.ts` in contracts; runbook "Side channels inside the session"); the
    agent no longer has the HTTP `/file`, `/clientlog` or `/browser` endpoints they once used.
    Every agent that can still connect serves them, so the PWA always uses them. The browser stream opens with the browser
    protocol's `auth` but its token is empty and never checked: the session is already
    authenticated, and a paired phone holds no token (checking it refused every paired phone).
    **The phone's acknowledgements are the backpressure** (`mediaAck`, `browserAck`): the
    agent's socket drains into the relay at once, so its `bufferedAmount` cannot see a slow
    phone. Keep a media chunk inside one Noise frame and the windows small (4 chunks, one
    browser message), since `seal` sends a message's frames back to back and whatever is in
    flight is what terminal output waits behind. A held browser frame is flushed on the ack
    (`onDrain`), not on the next upstream message.
  - **Device keys: the agent is the gate, the relay only the first one.** Each PWA keeps an
    X25519 + Ed25519 identity in IndexedDB (non-extractable WebCrypto keys, noble per curve
    where the browser lacks it). **If IndexedDB will not store the `CryptoKey`s (or returns them
    broken), both keys fall back to noble raw bytes.** That falls under storage, not generation.
    Playwright's WebKit takes `CryptoKey`s without an error but reads them back broken, so every
    e2e exercises the read-back fallback; only `e2e/device-key.spec.ts`'s patched IndexedDB
    covers the `DataCloneError` path.
    A store that cannot be *read* fails the load: never make a key for the launch alone (each
    one would enrol as a new device), and never replace a stored identity. The failure reaches
    Settings → Diagnostics and the connection error with its DOMException name. The agent checks the IK key against `~/.perch/devices.json`
    itself and never takes the relay's word: an unknown key may send `auth` and nothing else,
    and it is enrolled only when the handler's `authResult ok` goes out. **A new key must prove
    the Ed25519 relay key its hello names** (`hello.proof`: a signature over its X25519 key and
    the IK handshake hash the hello is sealed under, `IkResponder.payloadHash()`), or one phone
    could have the agent publish another's; an enrolled key needs none. **The roster knows a key
    by its bytes, so the responder refuses a non-canonical X25519 encoding** (top bit set, or
    ≥ p): X25519 ignores the top bit, and a revoked key re-spelled would come back as unknown.
    Enrolment likewise refuses a new key naming a revoked Ed25519 relay key. **Nothing the phone
    sends behind an accepted `auth` reaches the handler until the roster write settles** (it is
    held with the outgoing `authResult`, and dropped if the roster declines). Hello names are
    sanitised (control characters, bidi overrides) before the journal and `perch devices`. The
    relay admits the Ed25519 keys the agent publishes over the control socket (a zod-parsed
    `policy`), after a signature over its own challenge. **Challenges are stateless** (expiry +
    random + HMAC under a per-account key kept once in the store, `relay-challenge.ts`): handing
    one out writes nothing; used nonces are remembered in memory for their 30 s only. **Enrolment
    dials are capped per account** (10 a minute, 4429), since each costs the agent file reads and
    a key derivation; the window lives in the store, so a Durable Object woken from hibernation
    does not get a fresh one. Until `auth` is accepted the agent reads 8 KiB messages at most and three
    `auth`s per socket. **The agent bounds what a hostile relay can make it hold, without
    trusting the relay's own caps:** `RelayLink` keeps at most 32 dial-backs unauthenticated
    (a dial holds its slot until its `authResult` goes out or its socket closes, so don't free it
    on open), checks at most 4 enrolments at once and 10 a minute per link (refusing past either
    without touching disk), a closed relay socket is terminated 1 s after its close frame, and no
    relay socket offers compression. Dial ids are token characters only (`relay-control.ts`), since
    the agent logs them. Runbook: "Device keys".
  - **The agent keeps one spare dial-back per relay, and the relay pairs a phone with it at once.**
    A fresh dial-back put the agent's TCP + TLS + upgrade to the relay on every phone connect's
    critical path (on a long path to Cloudflare, its own TLS handshake stalling was what ended a
    connect in 4504). A spare is `role=spare`, signed for that role and an id the agent picks;
    the relay sends `paired` on it before the phone's frames (runbook, "Spare dial-backs"). Two
    things not to "simplify": **an enrolment dial never takes a spare** (the agent checks the
    proof before it dials), and **a paired spare takes a dial-back slot like a dial**, so a relay
    that pairs spares as fast as they open is held to the same 32 as one that floods dials.
  - **A phone is refused in band, never with an HTTP status.** A browser's WebSocket reports
    1006 for any refused upgrade, which reads as a network failure. The relay completes a
    phone's upgrade and closes it at once with `4000 + status` and a `REFUSAL` reason
    (`secure-channel/src/refusal.ts`); the agent's `refuse` carries its reason, and its own 4003
    closes use the same words; the PWA words each one (`core/refusal.ts`) and stops redialing
    on a final one. The agent keeps spent and expired pairing codes for a day so it can say
    which. A reason is told only to whoever passed the check that produced it. Runbook: "How a
    refusal reaches the phone".
  - **The relay holds nothing derived from the token.** An unknown key's enrolment proof is a
    MAC under a token-derived key; the relay forwards it in the `dial` and the agent answers
    `refuse` or dials back. Don't move that check into the relay.
  - **Revocation is a deny list, not a deletion.** A lost phone may still hold the token (an
    entry added by hand that has not connected since phones began forgetting it), and a deleted
    key would re-enrol itself on it; `forget` is the explicit way back. Revoke also cannot stop
    the token enrolling a *new* key: that takes `enrolment off`.
  - **A phone forgets its token once its key is enrolled, and the `authResult` waits for the
    roster.** `authResult` carries `credential` (device, pairing, token) and `enrolled`; on
    `enrolled` the PWA drops the entry's token and pairing secret (`onCredentialsSpent`), so a
    stolen `relay-key.json` no longer collects the token from every phone. For a new device
    `NoiseClientConnection` holds the `authResult` (and anything sent after it, in order) until
    the roster write resolves: `enrolled` must mean written, or a phone whose enrolment failed
    would be left with no credential. A key enrolled at the handshake that still sends the token
    is refused with 4003 "token not needed", which the PWA answers by redialing without it;
    don't make that refusal final. **That close travels outside the session, so the relay can
    forge it:** the PWA only holds the token back, forgets it when the next session's `authResult`
    says `enrolled`, and sends it again if that attempt is refused as not enrolled. A pairing
    secret is likewise dropped on `enrolled` only (or on any accepted auth from an agent that
    predates the field), never just because the machine came online. An unknown key that offers no credential is told
    it is not enrolled, whatever the mode.
  - **Enrolment has three modes, and `off` means token enrolment only.** `on`: the token or a
    pairing code enrols a phone; `off`: only a pairing code (minted on the machine by its
    operator, so an explicit authorisation); `closed`: nothing. `devices.json` keeps `enrolment`
    as "any enrolment at all" (false = closed, its old meaning) and adds `tokenEnrolment`, so an
    agent from before the modes still parses the file instead of failing closed. The agent
    refuses a token at four places: the dial (`admitsEnrolment`), the handshake (closed only),
    an unknown device's `auth` **before the handler sees the token** (`refusesToken`, including a
    pairing-shaped secret it does not know), and `enrol(device, via)` after `authResult`, which
    closes the session with the refusal when the roster declines (a mode changed since the
    handshake); only a failed write serves it unenrolled. The
    relay's `tokenEnrol` policy field refuses only a proof the phone *says* is a token's
    (`cred=token`); one that names no credential goes to the agent, which can tell.
  - **The published policy outlives the control socket**, so an agent dropping does not reopen
    the relay's gate; only a relay that never received one admits a client without a device key
    (the agent, IK only, then closes it).
    **The agent republishes on each heartbeat until the relay answers `applied`:** a Worker
    deploy keeps the hibernated control socket open, so the new code starts with no policy
    and would otherwise stay open until the roster next changed.
  - **Device ids are 48 bits, so a key is the real name.** Enrolment refuses a key whose id is
    already in the roster (enrolled or revoked), and `perch devices revoke/forget` take the full
    X25519 key as well as an id, which `perch devices` prints.
  - **`devices.json` fails closed and writes under a lock.** Malformed is an error, never an
    empty roster (that would forget every revocation and re-open enrolment), and the agent and
    `perch devices` write it from different processes. A pairing secret the agent never issued is
    answered without taking `pairing.json`'s lock, so made-up ones cannot keep `perch pair` out.
  - **The hooks have their own secret, kept off every command line.** `POST /hooks` takes a
    random secret the agent writes to `~/.perch/token` at each start (the path installed hooks
    already read), never `PERCH_TOKEN`, which enrols phones. `perch-hook.sh` gives curl the header
    through a file (process substitution) and the body on stdin, built with the `printf` builtin:
    any local user can read a process's argv. `perch-hook.test.sh` asserts neither reaches it.
  - **An agent refuses a `ws://` relay off loopback** (`isCleartextRemote`): `perch connect`
    throws, and `PERCH_RELAY_URLS` drops it with a warning, as the phone's pairing link does.
  - **The PWA runs no script but its own bundle.** A media preview's Blob takes the type its
    path implies, never the agent's (`SessionMedia` refuses a reply naming another): a blob: URL
    has the PWA's origin, so an agent answering a `.pdf` as `text/html` once ran script beside
    every machine entry and the device keys. The build adds a Content-Security-Policy meta
    (`core/csp.ts`, `script-src 'self'`; a blob document inherits it), and specs that touch
    previews, the browser view or the terminal fail on any violation (`e2e/csp.ts`). A new
    external host the PWA must reach goes in `connect-src` there. The PDF iframe has no
    `sandbox`: WebKit draws PDFs with a plugin, which any sandbox disables.
  - **Secret files must be private, or the agent does not start.** At startup it makes
    `~/.perch` 0700 and exits, naming each file and the `chmod 600` that fixes it, while
    `relay-key.json`, `devices.json`, `pairing.json`, `token` or `deploy/agent.env` (named by
    `PERCH_AGENT_ENV` from `run-agent.sh`) can be read or written by another user; the
    self-hosted relay does the same for its directory, config and accounts, and
    `relay-cf-deploy.sh` for `deploy/relay-cf.env`. A service that crash-loops right after an
    update: read its log for that line first.
  - **No process the agent starts gets a `PERCH_` variable** (`childEnv`, used by every
    `execFile` and the pty). A tmux server copies the environment of the client that starts it
    into its global environment, which every pane inherits; when the agent's own
    `new-session` found no server, every workspace got `PERCH_TOKEN`. A new spawn site must use
    `childEnv()` too. The CLI reads the agent.env the service reads for every command, since a
    shell in a workspace has none of the agent's variables.
  - **A phone that pinned another agent key is told so, finally.** The responder tells a first
    message sealed for another static key (`WrongStaticKeyError`) from any other failure; the
    agent closes it with 4003 "wrong agent key", and the PWA words it as final. "Agent key
    mismatch" is for an answer the pinned key did not make, which the real agent never sends.
  - **The challenge comes on the phone's own socket (the gate); the fetch is the fallback.**
    The PWA upgrades with `?challenge=1`; the relay accepts at once, files the socket as a
    `gate` (nobody's partner), sends a challenge text frame, takes exactly one text reply
    carrying what the query would have (`relay-gate.ts`), runs the unchanged `admitDevice`, and
    sends `ready` once the socket is paired; the phone starts IK only then. That spares a TLS
    connection per connect. Things not to "simplify": **a gate is held unauthenticated, so it is
    bounded** (5 s deadline, 4408; 8 waiting per account, and the ninth closes the *oldest*
    waiting one, never the newcomer, or holding 8 idle sockets would lock the owner out; a phone
    whose gate is closed before `ready` with 4429/4408 goes on over the fetched challenge, so a
    stranger opening gates fast enough to evict it costs the owner speed, not access);
    **anything but one well-formed text reply closes it** (4400), and nothing from it is ever
    forwarded; **the nonce is not bound to the gate** (the MAC and spent set carry replay, as for
    a fetched one), so a Durable Object that lost a gate's memory just closes it (4401). Socket
    labels live in the DO attachment (tags are fixed at accept, and a gate becomes a client), with
    the tags as fallback for sockets accepted by older code. **The fetch flow stays on every
    relay**, for older PWAs and for the PWA's fallback: a relay from before the gate answers
    `4401 device key required` before any challenge (remembered per relay for the app session,
    `legacyRelays`) or, with no policy yet, dials the socket to the agent and nothing arrives
    (fallback after `GATE_WAIT_MS`, not remembered). `device key required` after a challenge
    stays final. The phase `challenge-fallback` in the connection log shows a fallback.
  - **A challenge that cannot be had fails the attempt, and the backoff retries it.** Every
    relay hands out challenges and refuses an upgrade without device parameters with a *final*
    "device key required", so connecting without them after a brief network error parked the
    entry until a tap. `fetchRelayChallenge` rejects with `ChallengeError` (network error, a
    non-200 — which carries no CORS headers, so the browser reports it as a network error too —
    or no nonce), and the attempt closes as "relay challenge failed: …". The one cost: a relay
    that no longer knows the account answers its challenge 404, so that entry now retries with
    "relay challenge failed" instead of showing the final "does not know this machine".
    **A challenge fetch that hangs fails the attempt too.** On Android Chrome,
    after a long sleep, the first attempt's fetch hung until the 10 s connect deadline on every
    wake (the close said so: code 1000 comes only from a socket closed before the WebSocket
    existed). Why it hangs is not proven; a pooled connection dead since the sleep fits. It is aborted
    after 5 s (`fetchRelayChallenge`) and rejects with `ChallengeTimeoutError` ("relay challenge
    timed out"). Never map a failed challenge to "no device parameters": a gated relay refuses
    that for good. **The e2e cannot catch a regression here:** it runs WebKit only, with no
    Android and no sleep, so the wake-after-sleep path is covered by `fetchRelayChallenge`'s unit
    tests alone and needs an on-device check when it changes.
    Each relay connect also logs its phases to the connection log (`device-key` once the device key is loaded, `ws-open`, `challenge`,
    `admitted`, `handshake`, `list` when the workspaces arrive, with ms since the attempt began;
    plus one app-global `boot` with the ms from launch to the first connect; a `close` carries its attempt number and
    backoff), and the self-hosted relay prints when a phone's challenge, upgrade and the agent's
    dial arrive, so a slow connect can be placed (at most 30 such lines a minute, so a flood
    cannot fill the journal).
  - **Machines join; phones pair.** Runbook: "Connecting a machine and pairing a phone".
    `PERCH_JOIN_KEY=<join key> pnpm perch connect <relay>` registers the machine (`role=join`), adds the
    relay to main's `agent.env` (backed up first), restarts the agent and prints a QR code;
    `perch pair` mints another. The accounts a relay serves live in a registry (the Worker's
    `RegistryRoom` SQLite Durable Object, `~/.perch/relay/accounts.json` on Node), changed only by
    joins and removals; there is no hand-edited account list. Things not to "simplify":
    - **A join carries two proofs, and neither alone registers anything:** the agent's Ed25519
      signature and an HMAC under the join key, both over the same account/role/time message,
      and the account must be `accountId(key)`. The join key never travels, so the relay takes
      nothing it could replay for another account or action.
    - **The join key only registers; listing and removing take a separate admin key**
      (`adminKey` in the Node config, the Worker's `ADMIN_KEY`; none configured → 501). The join
      key is handed to every machine, so it must not be able to remove other accounts.
    - **Unknown account → 404 before any per-account state**, answered from the registry.
      The Worker caches found accounts per isolate (60 s, every role, challenges included) and a
      miss for 10 s, hits and misses in separate bounded maps so guesses never evict a hit. A
      miss only absorbs a *repeated* guess: **every distinct guess still reaches the one
      `RegistryRoom`**, which a flood past ~1,000 requests a second can overload for every
      uncached account; the zone rate rule is the bound. With a custom domain (`RELAY_DOMAIN`)
      the deploy targets `env.production`, which turns the `workers.dev` host off so nothing
      bypasses the rule; without one it targets `env.production-workers-dev`, the same Worker on
      its `workers.dev` host, which no zone rule can cover (runbook, accepted limits). A removed account cannot come back through a stale hit, by two
      mechanisms, don't drop either: a control socket that passes its signature check against
      the cached key is confirmed with the registry (`authorizeCached`), and an evicted
      `RelayRoom` refuses every role as unknown until a join reinstates it (`Relay.evict` marks
      the store; `RelayRoom.evict` wipes storage *before* that, or the mark would be wiped too).
      A removed account's sockets close with 4004.
    - **A removed account is on a deny list a join cannot lift** (`removed` in `accounts.json`,
      a `removed` table in `RegistryRoom`): a join answers 403 until the admin key allows it
      (`perch-relay machines allow`). Its thief holds the join key too, since every machine does.
    - **The join rate limit counts every join-key request per client address** on both hosts,
      and lives in the conformance suite with the rest.
    - **A pairing secret is verify-only at the relay gate** (`admitsEnrolment`) **and spent
      atomically at `auth`** (`redeemPairing`, under the pairing file's lock): spending it at the
      gate would cost the phone a new code whenever the handshake after it failed. Enrolment
      `off` still takes it (see "Enrolment has three modes" above); only `closed` refuses it. **It is spent by the first `auth` that presents it, enrolled
      device or not**, and bound to that device's key (`usedBy`): an already-enrolled device
      needs no code, but one it left live would admit whoever else holds the link for ten
      minutes. The binding device presenting it again is not a second use; any other is refused.
    - **An enrolled IK key authenticates its relay session on its own** (`keyCredential`:
      `device` for a key enrolled at the handshake, `pairing` for one that just spent a code):
      a paired phone has no token. That makes the device key the phone's whole credential, which
      is why the extractable fallback below matters.
    - **A link's default path (`p`, from `PERCH_DEFAULT_PATH`) is a convenience, never a reason
      to fail a pairing.** The phone drops one that is not absolute or exceeds 128 characters and
      pairs anyway, so `perch pair`/`connect` refuse such a value up front instead. It sets a new
      entry's `defaultPath` and fills an existing entry only when that has none: a re-scan is a
      retry, and the owner's Settings value wins, like the entry's name.
    - **A pairing link never re-pins an entry.** A code for a relay URL the phone already has
      an entry for, naming another agent key, is refused (`pairedMachine`): accepting it would
      point the entry's token at a key the link's maker may hold. A link opened from outside the
      app is confirmed first, showing the relay host and the machine key's fingerprint that
      `perch pair` prints beside the code, and a pending pairing secret is sent in preference to
      a token. A link must name a `wss:` relay (`ws:` on loopback only, for the e2e), and a full
      link only this app's own origin (`readPairingLink`).
    - **A pairing link tapped inside the app is paired by the running app**
      (`store.openPairingLink`, from the terminal's link handlers and a capture-phase click
      listener), never opened: on Android it opened another page context, which added the
      entry behind the main view's back. Entries written by another page context are picked up
      on the `storage` event and on becoming visible (`refreshMachines`).
    - **The PWA takes the `#pair?…` fragment before anything connects**, and must read
      `location.hash` *before* `history.replaceState` — `location` is live, and reading it after
      the replace yields an empty hash (a plain-object unit test cannot see this; the e2e does).
    - **On iOS, a pairing link opened outside the Home Screen app is held, not paired**
      (`outsideInstalledApp`: `navigator.standalone === false`). The Home Screen app keeps its
      own storage, apart from Safari's and from the in-app browsers chat apps open links in, and
      no link ever opens it, so pairing there spent the one-time code on a context the owner
      then left. `InstallFirst` walks them through copying the link, adding the app, and
      **Paste pairing link** in Settings (the clipboard is the one thing the contexts share);
      "Pair in this browser instead" keeps the old path.
    - **A new device key is read back before it is trusted.** A browser can take a `CryptoKey`
      into IndexedDB without an error and return something else (Playwright's WebKit does): the
      PWA then replaces its own just-created record with noble keys, and an existing record that
      reads back malformed fails with a way out, never a `TypeError` and never a silent new key.
  - **An enrolled phone with no credential is served at once, right behind message 2.** Its
    device hello carries `push`; when the agent finds the key enrolled it answers `authResult`
    (`pushed`) and the opening replies (workspaces, commands, keyterms) without waiting for the
    phone's `auth`, which saves the two round trips that followed the handshake (on Cloudflare,
    the list came ~480 ms after the handshake, now ~90). The phone still sends its `auth`; the
    handler answers it with nothing (a token is still refused as not needed). Things not to
    "simplify": **the phone asks only when its entry holds no token and no pairing secret** —
    otherwise the pushed `enrolled` could make it forget a pairing code before its `auth` burned
    it; **a pushed session keeps its auth deadline and dial-back slot until the phone's first
    frame** (message 1 can be replayed by the relay, and its replies are unreadable, but each
    one would otherwise free a slot as authenticated); and **`PushBudget` caps pushes at 10 a
    minute per device key** across all relays, since each replay builds the list again; past
    it, and with no budget wired at all, the phone gets the old flow. No prologue bump: an older
    agent strips the unknown hello field and an older PWA never asks.
  - **NK is retired; IK is the only handshake** (prologue `perch-relay-noise-v3`, flag `0x03`).
    The old NK flag `0x02` fails as any non-handshake frame does (4002). The relay refuses a
    client without a device key once a policy is published, and drops an older agent's
    `anonymous` field unread; `PERCH_RELAY_ALLOW_NK` is ignored with a startup warning.

## CRITICAL: why the PWA is still served from the tailnet
The PWA was first put on the tailnet so that it could open WebSockets to tailnet agents: browsers
block a **public-origin page from connecting to a private/tailnet `100.x` address**:
- Chromium: Local Network Access (the PNA successor) gates public→local behind a user
  permission; as of Chrome 147 this also covers WebSockets. The
  `Access-Control-Allow-Private-Network` header is a dead path.
- **iOS Safari (all iOS browsers are WebKit): there is no web-facing local-network
  permission at all — the connection fails silently with no workaround.**

No agent is reached that way any more: phones go through relays. What still holds:
- **A self-hosted relay published on the tailnet** (the maintainer's home relay,
  `wss://<machine>.<tailnet>.ts.net:8451`) is a `100.x` address, so the same wall applies to it:
  a PWA on a public origin could not reach it. Its challenge fetch and its WebSocket both need a
  tailnet origin.
- **The origin protects the device key.** Where IndexedDB will not keep a `CryptoKey`, the key is
  stored as raw bytes readable by any script on the PWA's origin, and an enrolled key is the
  phone's whole credential; whoever serves the PWA can also read everything. The tailnet origin
  is what keeps that to the maintainer. Moving origins also means a new device key (a new
  origin has empty storage), so every phone pairs again.
- **Pairing links name the PWA's origin** (`PERCH_PWA_ORIGIN`), so they follow it.

What no longer needs the tailnet: the Cloudflare Worker relay is public and reachable from any
origin, so a PWA served elsewhere would work against it. **Where people without a tailnet load
the PWA from is an open question**, not settled here: it needs an origin they trust with their
device key (see the relay runbook's threat model). Someone with a Cloudflare account of their
own serves their own copy from a static-assets Worker there, next to their own relay (runbook, "A relay and
PWA in your own Cloudflare account"); that answers it for them, not for the maintainer. Until it is answered, keep the maintainer's
PWA on the tailnet, and do not move it to a public origin to "simplify" deployment.

## Gotchas already fixed (don't regress)
- **A cold launch's path to the first connect carries only what connecting needs.** Measured on
  Android: the time from launch to `start()` was mostly compiling and evaluating the bundle, and
  xterm plus marked/dompurify were half of it, so `TerminalView` and `FileViewer` are their own
  chunks (`App.svelte`'s loaders). They are fetched once the first workspace list arrives, well
  before anyone can open one; a failed import is forgotten, so opening the view again retries it.
  Don't import either statically from anything the main bundle reaches. The device key's
  IndexedDB read then waited on the main thread, so `public/warm-device-key.js` (an `async`
  classic script: module scripts in `index.html` are folded into the main bundle) opens the
  database first. **It must create nothing**: a first launch's upgrade is aborted, or the app's
  own `open(DB, 1)` would find a database without its object store. The name is duplicated in
  `device-keys.ts`; `warm-device-key.test.ts` keeps the two equal.
- **A subagent's tool calls must not stamp the parent workspace's status.** `PreToolUse`/
  `PostToolUse` fire in the **parent** session for a subagent's own tool calls, carrying an
  `agent_id`/`agent_type` pair that is absent on the main loop's calls. Mapping those to
  `working` meant that whenever a session sat blocked on a question with a background subagent
  still running, the subagent's next tool call (seconds later) silently overwrote the
  `needs-feedback` the block had just raised — so the workspace showed `working` with a prompt
  waiting on screen, indefinitely. `attentionDecision` now returns `status: null` for any tool
  event carrying an `agent_id`, leaving the parent's status alone. Read `agent_id` defensively;
  it is undocumented.
- **A pending multiple choice is read off the tool name, not a notification.** Claude blocks
  indefinitely on `AskUserQuestion`/`ExitPlanMode` waiting for the user to pick an option, and
  (from v2.1.200) these never auto-time-out. A `Notification` with
  `notification_type: 'permission_prompt'` *is* emitted for them on 2.1.215 — but a few seconds
  late and undocumented for `AskUserQuestion`, so it is not the primary signal. `PreToolUse` for
  those two tools maps straight to `needs-feedback`; the matching `PostToolUse` (which fires only
  once the user has answered) returns the session to `working`. Both checks are skipped for
  subagent calls, so a subagent's own question never speaks for the parent.
- **The create form's `--model` value must stay single-quoted.** `CreateWorkspace.svelte`
  builds `claude --model '<value>'`, and two Claude entries carry Claude Code's `[1m]`
  suffix — `opus[1m]` (the default) and `sonnet[1m]`. That suffix used to be what bought the
  1M window, the bare alias being the *smaller* 200K one despite looking canonical; Opus 5
  and Sonnet 5 are now natively 1M, so the CLI strips the suffix for them and it buys nothing.
  It is kept because it is what ships and works — the window is what matters here (Claude Code
  never errors at the context limit, it silently autocompacts, so a small window costs
  fidelity rather than raising an error anyone would notice), and re-testing the default
  launch command to win a cosmetic tidy is a bad trade. The suffix is **not** a safety net for
  a future non-native-1M model: on one of those the CLI passes it through as a request for the
  1M beta, which a model without a 1M window rejects — `claude-haiku-4-5[1m]` returns
  a 400 because Haiku 4.5 is a 200K model, which is also why Haiku is the one 200K entry in the picker. tmux runs the command string through the login shell, and brackets
  are a glob pattern there: under zsh an unmatched glob aborts the whole command line, so an
  unquoted `opus[1m]` means the session dies before `claude` ever starts — and because the
  command *is* the pane's process, the workspace vanishes from the list instantly. The quote
  is applied to **every** model, not just this one, so the next value someone adds can't
  reintroduce it; it lives at the build site rather than in `value`, which doubles as the
  radio's identity. `resumeCommand`'s whitespace split preserves it, so park/unpark is safe
  (guarded by a test). Verified against zsh through `tmux new-session`, not just in jsdom.
- **A new `Workspace` field must be added to `workspaceSchema` too — the type guard will not
  tell you.** `messages.ts` asserts schema/domain agreement with
  `Equals<z.infer<typeof workspaceSchema>, Workspace>`, but that check is blind to a *missing
  optional* property: a type lacking an optional key is still assignable in both directions,
  so the drift typechecks clean. Since `z.object()` strips unknown keys, the agent then sends
  the field and the client parser deletes it before the store sees it — both sides' unit tests
  green, nothing in the UI, no error anywhere. `agentAddress` shipped this way once. Guard a
  new optional field with a `workspaceSchema.parse` test (the only thing that proves it
  survives the wire) and, when it renders, an e2e through `e2e/fake-agent.ts` (the only thing
  that proves it reaches the DOM).
- **Terminal encoding:** the agent base64-encodes the pty's UTF-8 bytes; the PWA must
  decode base64 → bytes → `TextDecoder` (UTF-8), never `atob` into a latin1 string (that
  mojibakes box-drawing/accents and breaks the xterm render). Guarded by a store unit test.
- **Machine routing:** the PWA routes attach/input/close by the **connection id** (the
  PWA's machine config id), not the agent's `PERCH_MACHINE_ID`. The aggregator stamps each
  workspace with the connection id. The e2e uses a deliberately mismatched agent id to
  cover this.
- **List on connect:** the agent sends workspaces in response to an explicit `list`, or pushes
  them right behind the handshake to a phone it serves at once (relay section). Otherwise the
  PWA sends `list` (with `listCommands`, `listKeyterms`) once each relay session is
  authenticated, on every (re)connect (`openingRequests`). The e2e fake agent is faithful to both.
- **Restarting the agent must NOT kill tmux sessions:** the agent spawns the tmux server
  as a child, so it lives in the systemd unit's cgroup. The default
  `KillMode=control-group` would SIGTERM the whole cgroup on restart and take every
  workspace (and the Claude Code session inside it) down with it. `deploy/perch-agent.service`
  sets **`KillMode=process`** so a restart stops only the agent; the tmux server and its
  sessions survive. Don't drop this. On restart the agent re-discovers live sessions via
  `tmux list-sessions` (no in-memory session registry), so workspaces reappear on the PWA's
  next `list`. Status is **durable** (`FileStatusStore` → `~/.perch/status.json`): it reloads
  on startup, so each session keeps its last status across a restart instead of resetting to
  `idle`, and entries for sessions that no longer exist are pruned at startup. After changing
  the unit, re-deploy it and `systemctl --user daemon-reload`; this and `install-hooks` must
  be redone per machine.
- **Android terminal input bypasses xterm's IME path, and the textarea is the model.**
  xterm.js's composition handling desyncs from the pty on Android: it tracks a composition as
  absolute indices into its accumulating hidden-textarea value, which breaks on Android's racing
  composition events, and Perch's keyboard-bar arrows write to the pty out-of-band. On Android
  (iOS untouched) `lib/android-input.ts` takes over: **the browser applies every keyboard edit to
  the textarea, and on each `input` (and `compositionend`) the adapter sends
  `diffLine(sent, textarea.value)`** (`core/android-terminal-input.ts`) — backspaces to the common
  prefix, then the new tail — and sets `sent` to the field. The field is thus both what the
  keyboard reads back (word boundaries, predictions, the swipe space) and the record of what the
  pty line holds since the field last started over.
  **Don't go back to inferring edits from event types.** The previous design `preventDefault`ed
  each edit and rebuilt the line from its `inputType`, which needs facts a textarea does not
  give: `getTargetRanges()` is always empty there, a keyboard can delete several characters in
  one `deleteContentBackward`, and when backspacing into a committed word HeliBoard re-opens it
  as a composition and re-announces it in full with **no `beforeinput` and no `input`**. A
  heuristic for that last case ("the update starts with the field's trailing word") split words
  on spaces while HeliBoard splits on `/ . - '`, so `path/to/file.ts` + 3 backspaces + `md` sent
  `see path/to/filefilemd` (captured on-device, replayed in `android-input.test.ts`). Under the
  diff the re-opening changes nothing in the field, so nothing is sent. Nine patches to the
  inference design preceded this; each was one more case of the same gap.
  Invariants that carry it:
  - **`sent` and the field change together** (`sync()`); nothing else writes either. A field
    emptied behind the adapter's back would make the next diff backspace the whole line.
  - **Every `input` is stopped from reaching xterm**, composing or not: xterm's input handler
    re-sends inserted text and empties the field.
  - The adapter listens on an **ancestor** (the terminal container) in the **capture phase** and
    calls `stopPropagation()`, NOT on the textarea. xterm registers its textarea listeners during
    `open()` *before* the adapter, and at the target node listeners fire in registration order
    regardless of capture flag — a textarea-level `stopImmediatePropagation` runs too late (every
    letter was sent twice). A test with a pre-registered xterm-like listener guards it.
  - **The field keeps the whole line typed since it last started over** — never blank it after a
    word. Gesture typing emits the inter-word space as a standalone `insertText " "` only when
    the keyboard sees a word before the caret, and it tracks the field as a whole: a one-word
    window passed with two words and dropped every space from the third (`one twothreefour`).
    Verify a change here with **four** swiped words on-device, never two.
  - **Anything that writes the pty line without the field starts the field over**
    (`resetContext()`): the keyboard bar, the 📋 button, and the store's own typing (a stored
    file's path, a dictation transcript) via `store.onInjectedInput`. Enter starts it over too
    (else the keyboard prepends a space to the next line), and so does a keyboard paste: xterm's
    `paste` listener sends the bracketed text and empties the field, the adapter
    `preventDefault`s the `insertFromPaste` that would put it back, and since Claude Code may fold
    a paste into a `[Pasted text]` placeholder the resulting line is unknown.
  - **`resetContext()` starts the field over even with a word open — that is what ends it.**
    Measured on-device: changing the field makes HeliBoard drop its composition (no
    `compositionend`) and start the next letter afresh in the new field, with no stale update
    for the old word. Re-setting the same value or moving the caret and back does *not* end it.
    The old rule (no-op while composing) let a bar key land on the pty while HeliBoard went on
    editing its open word, so its next backspace hit the bar's character instead.
  - **A blur starts the field over too.** xterm's `_handleTextAreaBlur` sets
    `textarea.value = ''`; without `sync('')` on `focusout`, the first edit after switching apps
    or hiding the keyboard diffed against the old line and backspaced all of it.
  - **A backspace on an empty field is sent by hand.** HeliBoard then fires `keydown`(8) +
    `beforeinput deleteContentBackward` and **no `input`**, while the pty line may still hold text
    from before the field started over; the adapter sends `DEL` when the caret is at 0.
  - An edit away from the end of the field (the keyboard moving the caret itself) diffs as
    "backspace to it, retype the tail", which is right because the pty cursor is at the end.
  Diagnose on-device by capturing the raw event stream over Chrome DevTools (window
  capture-phase listeners recording `inputType`, `data` and the field value before/after) next
  to `tmux capture-pane` of a scratch workspace; Settings → Diagnostics keeps the adapter's own
  log (`core/terminal-input-log.ts`).
  - **A keydown that edits no text goes to xterm; there is no list of shortcuts.** Swallowing
    every keydown killed a hardware keyboard's Ctrl+P, Esc, Tab and Shift+Arrow, and
    HeliBoard's dpad joystick (real `KEYCODE_DPAD_*` events). `forXterm` lets through anything
    with Ctrl/Alt/Meta held and any named key (`key` longer than one character) except Enter
    and Backspace. xterm encodes it (every modifier combination, application cursor mode),
    sends it from the keydown and cancels the event, so no text reaches the field. The adapter
    then calls `resetContext()`. These stay on the field path: soft-keyboard text (229,
    `Unidentified`, `Process`), `Dead` and AltGr characters, printable keys with or without
    Shift, and Enter/Backspace (HeliBoard sends both as real keycodes; beforeinput handles
    them). Two exceptions not to "simplify". **A bare modifier keydown is stopped without a
    reset**, or a Shift pressed before a letter would end the open word. **Ctrl+V stays the
    browser's paste**: xterm would send `^V` and cancel it, and HeliBoard's paste key is a Ctrl+V.
    A keyboard-bar Ctrl/Alt still applies to the next letter typed (it goes through the field
    and `sendTyped`); because the pty then gets a control byte the field does not hold,
    `sendTyped` starts the field over whenever it transforms the input.
    `e2e/android-hardware-keys.spec.ts` drives the real xterm with an Android user agent.
  - **The adapter must stop `keypress` too, not just `keydown`.** One soft-keyboard Enter fires
    `keydown`(13) → `keypress`(13) → `beforeinput`(`insertLineBreak`). xterm registers a
    `keypress` listener on its textarea and sends the key from it whenever it did not handle the
    matching `keydown`, which with `keydown` stopped is always. The adapter's `beforeinput`
    path sends `\r` as well, so every Enter submitted twice. In Claude Code's `AskUserQuestion`
    the extra `\r` answers the next question with its first option (or lands on the review
    screen), which reads as "several answers submitted" or a declined prompt. The keyboard
    bar's ⏎ writes straight to the pty and never had the bug, which is what hid the cause. The
    `keypress` is stopped **without** `preventDefault`, which could cancel the `beforeinput`
    that carries the Enter. Found by capturing the WebSocket bytes on-device over Chrome
    DevTools. The in-app input log never records xterm's own sends, so it could not show this.
- **Select mode (⌶) is a frozen plain-text snapshot, the same on every platform.** xterm's
  rows cannot carry a native selection: xterm sets `user-select: none`, rebuilds a row's
  elements whenever its content changes (Claude Code's spinner collapsed an iOS selection
  within seconds), and has only the visible screen in the DOM. Each platform once had its own
  workaround (iOS re-enabled `user-select` on the rows, Android drove xterm's selection from
  touch with a Copy button). Now ⌶ covers the terminal with `core/terminal-snapshot.ts`'s
  copy of the buffer, scrollback included and soft-wrapped rows joined, in an ordinary
  scrollable element, so the OS's own selection, handles and Copy callout work as on a web
  page. It is frozen on purpose: live output would disturb the selection. Plain text only.
  Desktop copy-on-select in the live terminal is unchanged.
  **Claude Code wraps its own text**, so the terminal holds its paragraphs as separate lines
  (`tmux capture-pane -J` joins nothing): the snapshot rebuilds them by inference (`reflow`).
  A break counts as the app's when the row plus a space plus the next word exceeds the width
  (Claude wraps at exactly `cols`, measured on real panes), the next row has a continuation
  indent and opens no item; a full row whose token runs on rejoins with no space. A rare wrong
  join in command output is the accepted cost; it affects only what is copied.
- **Browser-view typing reads the hidden input's text, and every key event carries `text`.**
  Two causes made soft-keyboard typing in the browser view do nothing. The PWA forwarded only
  the hidden input's `keydown`, and an Android keyboard's is `Unidentified` (229) with the text
  delivered as a field edit; so `lib/browser-typing.ts` lets the browser apply each edit and
  sends `editMessages(sent, field)` (backspace to the common prefix, type the tail, per code
  point), like the terminal's Android adapter. Only keys that edit nothing go from `keydown`
  (Enter, Tab, arrows, Escape, Ctrl/Meta shortcuts, Backspace on an empty field); the field
  starts over on those, a page tap, the keyboard bar and blur. And agent-browser's stream
  (0.31.1) **silently drops an `input_keyboard` with no `text` field**, while Chrome acts on a
  named key only with `windowsVirtualKeyCode` (a Backspace without it fires a keydown and
  deletes nothing) and submits a form on Enter only with `text: '\r'`; so the keyboard bar's
  keys never worked either. `keyMessages` always sets `text` and the virtual key code; measured
  against a live session's stream socket, not assumed. The agent forwards the message verbatim.
- **An installed Android PWA cannot hand a tapped link to another browser app; the share sheet
  can.** A link picker set as the default browser (LinkSheet) never sees a terminal link: Firefox's
  web-app mode drops any link bound for an installed browser, and Chrome keeps http(s) in-app
  unless an app declares that exact host, while an `intent://` URL renders a blank page inside the
  WebAPK (measured on-device against every variant: `package`, `component`, `action`, fallback,
  anchor, `location.href`, `window.open`). So the Android-only Settings toggle "Open links with
  the share sheet" (`perch.shareLinks`, off by default) sends terminal links to
  `navigator.share({ url })`, where LinkSheet's share target takes them. Don't go back to
  intent URLs; a one-tap handoff needs a native shell.
- **A dropdown inside the keyboard bar must be `position: fixed`, not `absolute`.** The bar
  is a horizontal scroller (`overflow-x: auto`), and CSS forces the cross axis to a clipping
  value when one axis scrolls — `overflow-y: visible` is impossible there. So an
  absolutely-positioned menu inside the bar renders in the DOM but is invisibly clipped
  (jsdom has no layout, so unit tests happily pass; only the Playwright e2e caught it).
  `CommandPicker` measures its trigger's rect on open and positions the menu fixed against
  the viewport, which also keeps it anchored as the bar scrolls and the soft keyboard
  resizes the viewport. Don't "simplify" it back to `absolute`.
- **A keyboard-bar key commits on release, never on `pointerdown`.** The bar is a horizontal
  scroller, so a drag that starts on a key is usually the user scrolling it — and firing on
  `pointerdown` typed a space / submitted the line / sent an Escape before the gesture could
  reveal itself as a scroll. A keystroke on the wire cannot be recalled, so `press` waits for
  `pointerup` and cancels on drag. Two things not to "simplify": **`pointercancel` is the
  primary cancel signal, not a backstop** — once WebKit's scroller claims the gesture it fires
  `pointerdown → pointercancel` with typically *zero* `pointermove`, so a slop-only version
  passes every unit test and does nothing on the phone; and **`suppressClick` is set in `arm`,
  not at the fire site**, or a cancelled press still sends on the `click` the browser
  synthesizes anyway. `startKeyRepeat` now owns the *first* hit of a held key (at 300ms) and
  sets `fired` so the release doesn't double-send — a held `⌫` therefore starts deleting at
  300ms, an accepted cost. `TAP_SLOP_PX` (10, exported from `KeyboardBar.svelte`) is the knob.
  Playwright can't cover this — `page.touchscreen` has only `tap()`, no drag-pan — so the
  unit tests carry it.
- **Cursor movement is a trackpad (`✥`), not four arrow buttons.** Dragging the pad emits one
  arrow key per `NOTCH_PX` of travel (Blink-Shell style), so distance controls how far the
  cursor moves instead of tap-count or hold-duration. **The tuning knobs, in order of how
  likely you are to want them:**
  - `NOTCH_PX` in `core/cursor-pad.ts` (currently 18) — px of travel per arrow key. Lower =
    faster/twitchier, higher = slower/more precise. Changing it needs no other edit; the unit
    tests derive from the constant.
  - The axis lock in `moveGesture`'s `lockAxis` — the first notch picks an axis and the
    gesture keeps it until release, so a sloppy diagonal can't spray perpendicular arrows.
  - `padKeys` in `KeyboardBar.svelte` — the four arrow definitions, kept intact (just not
    rendered as buttons) so restoring the old four-arrow bar is a small revert.
  The logic is a pure reducer (`core/cursor-pad.ts`) modelled as **reference point + notch
  crossing**, not distance-from-origin: each emitted notch advances the reference, which is
  what makes reversing the drag emit the opposite arrow for free. Two things not to
  "simplify": the pad uses its **own** pointer action, **not** the shared `press` action —
  `press` releases on `pointerleave`, which would abort the drag the instant the finger left
  the 2.75rem button; and it needs `setPointerCapture` **plus** `touch-action: none`, or the
  bar's `overflow-x: auto` scroller eats the gesture (jsdom has no layout, so only an e2e
  sees that). Each notch is emitted through the same `applyEditKey` path as a real key tap,
  so an **armed** ⌥ is consumed by the first notch only (word-left, then char-lefts) while a
  **locked** ⌥ applies to every notch — and `↑`/`↓` deliberately carry no `edit` field, so
  modifiers never transform them. A plain tap emits nothing (the button has no inherent
  direction). If the ratchet model ever loses on feel, the recorded fallback is a
  hold-to-repeat joystick reusing `core/key-repeat.ts`.
- **Attention status self-heals via tool hooks:** the attention state is last-hook-wins
  (`attention-decision.ts`). `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `working`,
  `Notification` and `Stop` → `needs-feedback` ("Needs you"). A bare `Stop` only means the
  turn ended, **not** that the task is done, so it maps to `needs-feedback`. **`finished`
  is a manual status the user sets from the PWA StatusPicker** — no hook emits it (a trailing
  `Stop` would overwrite anything Claude tried to set, so auto-`finished` isn't possible
  without a side channel; intentionally out of scope). Mapping `Pre`/`PostToolUse` to
  `working` is what unsticks a stale "Needs you" after a mid-task permission/idle
  `Notification` once Claude resumes — keep these five registered in `install-hooks.ts`, beside the two
  that end a stale `working`: **`StopFailure`**, which Claude Code fires *instead of*
  `Stop` when an API error (usage limit, overload, dropped connection) ends the turn, maps to
  `needs-feedback`; and **`SessionStart`** with source `startup`/`resume`/`clear`/`fork` (a new
  `claude` process or conversation, which has none of the old one's background tasks) drops all
  three in-memory marks and turns a `working` into `needs-feedback`, leaving any other status
  alone (an unpark sets `idle` just before its resume fires it). Source `compact` fires
  mid-turn on auto-compaction and changes nothing. An Esc interrupt fires no hook at all, so it
  still leaves `working` behind.
- **Every hook event is logged with the rule that decided it.** `applyHookEvent` appends one
  JSON line per event to a gitignored `~/.perch/hook-events.jsonl` (`FileHookEventLog`, moved to
  `.1` past 50 MB): workspace, event, session id, tool, notification type, source, whether a
  subagent made the call, the Stop's `background_tasks` (trimmed), a `StopFailure`'s `error`,
  the `reason` (`AttentionReason`), and the status and three marks before and after. Never the
  prompt, a tool's input or output, or the assistant's message. It is what answers "why is this
  workspace still `working`": `rg '"workspace":"perch-xxxx"' ~/.perch/hook-events.jsonl | tail`.
  Best-effort: a failed write never changes the decision or the 204. No PWA/UI.
- **A session parked on background work stays `working`, and the 60s idle notification must
  not undo it.** `perch-hook.sh` forwards Claude's hook stdin verbatim as a nested `claude`
  object on `POST /hooks`; `attention-decision.ts` reads `background_tasks` from it. A `Stop`
  with a running or pending task the session is **waiting on** leaves the session at `working`
  and marks it deferred in an in-memory `Set` on `WsServer`. That is a task of type `shell`
  (backgrounded Bash, and also the Monitor tool and `until` loops), `subagent`, `workflow`,
  `teammate` or `cloud session`, or one naming a `server` (an MCP monitor or task). **A watched
  artifact is a `monitor` task with no `server` that lasts the session's whole life**, so it
  must not count: it pinned every session with a `⧉` watch at `working` until closed. Nor do
  Claude's housekeeping kinds (`dream`, `auto-mode scan`, `memory import`) or any kind not on
  the list: a wrong "Needs you" costs a glance, a wrong `working` hides a waiting session
  indefinitely. (Kinds read from the claude 2.1.310 Stop payload builder.) This is **not** an LLM judgement — the Stop payload carries the answer
  as data (`background_tasks`, `last_assistant_message`, `session_crons` — all undocumented,
  so read defensively; anything unexpected falls back to `needs-feedback`, i.e. the old
  behaviour). **Claude Code emits a `Notification` with `notification_type: 'idle_prompt'`
  exactly 60s after every `Stop` — even while a background task is still running** — so
  without suppressing that one on a deferred session the feature would silently die after a
  minute. Only `idle_prompt` is suppressed; permission prompts always get through. And
  `Pre`/`PostToolUse` must **keep** the deferral (they don't clear it): a background
  subagent's own tool calls fire them in the parent session after its `Stop`, and clearing
  there would re-open the 60s hole for the subagent case. The deferral `Set` is deliberately
  in-memory — losing it on restart costs one extra "Needs you", never a missed one.
  **`perch-hook.sh` posts only when the pane named by `$TMUX_PANE` has its own process among
  the script's ancestors.** `$TMUX`/`$TMUX_PANE` alone prove nothing: an untargeted
  `tmux display-message -p '#S'` resolves to the most-recently-active session, and Codex runs
  hooks in a shared daemon that kept the environment of whichever pane started it. Both stamped
  statuses onto unrelated workspaces. Changing the script means re-running `install-hooks` per
  machine (it copies it to `~/.perch/perch-hook.sh`).
  **A turn that ends right after a main-loop `SendMessage` defers the same way.** That is a
  session waiting on another Claude session's reply (a spawned child on its orchestrator, an
  orchestrator on its children; see the `perch-orchestrate` skill), not on the user. The fact
  is a second in-memory marker (`messagedLast`), set by a main-loop `PostToolUse` of
  `SendMessage`, cleared by any other main-loop `PostToolUse` and by `UserPromptSubmit` (the
  reply arrives as one). It must stay separate from the deferral `Set`, because tool calls keep
  the deferral but change this. Accepted cost: a child whose last act was its final report stays
  `working` until it is closed.
- **`install-hooks` also installs a kill guard (`perch-guard.sh`, a `PreToolUse` hook on `Bash`
  for Claude Code and Codex).** A workspace session once ran `pkill -f "x"`, which matches
  nearly every command line: it took down the tmux server, the agent and every other session in
  one second. Everything runs as one Linux user, so nothing at the OS level can stop that; a
  private PID namespace per pane would, but breaks `sudo` in workspaces and `perch-hook.sh`'s
  pane-ancestry check (the pane pid tmux reports would be outside the namespace). The guard
  refuses `pkill`, `killall`, `kill -1`, `xargs kill`, `kill $(pgrep|pidof …)` and `tmux
  kill-server`/`kill-session -a` without `-S`/`-L`, including behind `sudo`/`env`/`sh -c`, and
  tells the session to `pgrep -af` then `kill <pid>`. It acts only when `$TMUX_PANE` is set, and
  is an accident guard, not a boundary. Its splitter (awk, so it runs on macOS's bash 3.2 and
  BSD tools) keeps a quoted string whole, so `rg "pkill|killall"` or a commit message naming
  these commands is not refused (refusing those taught sessions to route around the hook), and
  checks a `sh -c` script as its own command line. It parses the JSON without `jq`, like
  `perch-hook.sh`. Table-tested in `perch-guard.test.sh`; re-run `install-hooks` per machine,
  and re-trust the Codex hooks in `/hooks`.
- **Codex reports status through the same hook script, with `codex` as a third argument.**
  `install-hooks` also writes `~/.codex/hooks.json` where `~/.codex` exists; Codex runs nothing
  until the user trusts the hooks in `/hooks` (hash-keyed, so re-trust after a change). Three
  differences from Claude Code, all observed on Codex 0.162:
  - **Hooks run outside the pane unless Codex is started with `--no-daemon`**, which the create
    form adds. Under the shared daemon the hook posts nothing (see the pane check above).
  - **A question is asynchronous.** `request_user_input_async`'s `PostToolUse` fires as soon as
    the question is shown, then the model sleeps on `clocksleep`; the answer arrives as a
    `UserPromptSubmit`. A third in-memory marker (`questionPending`) holds `needs-feedback`
    across those tool events. It is the opposite of the deferral (stay `needs-feedback` despite
    tool events, versus stay `working` despite `Stop`), so keep the two separate.
  - **Approval is `PermissionRequest`, with no `Notification`.** It fires under an automatic
    reviewer too, so an auto-approved call flashes "Needs you" for a second until `PostToolUse`.
    A subagent's request still maps to `needs-feedback`: the user is the one asked. `SessionEnd`
    is not registered: it can fire late, from a newer Codex process.
- **Media previews come in acknowledged chunks inside the session, never as one message.**
  Image, PDF and audio bytes are read with `readMedia` and arrive as `mediaChunk`s (relay
  section), never as one base64 blob on the shared session, which would stall terminal output
  behind it. The agent once served them over an HTTP `GET /file`, which on the iPhone needed
  iCloud Private Relay off: it proxies Safari's HTTPS fetches through Apple, which cannot reach
  a tailnet `100.x` address, while WebSockets and the cached PWA shell kept working and masked
  the cause. The one HTTPS fetch left to a tailnet host is the self-hosted relay's challenge
  (`?role=challenge`); if it ever fails only on an iPhone, suspect Private Relay first.
  Also: the image viewer's frame is sized to `calc(100dvh - 8rem)` like `FileViewer`,
  **not** `height:100%` — the narrow phone layout's `<main>` has no height, so a percentage
  height collapses the frame to 0 (image invisible). A phone-width Playwright test guards it;
  the wide-viewport e2e missed it.
- **Attaching a file: the picker takes every type, paste cannot.** The keyboard bar's 📎
  input deliberately carries **no `accept`** (and no `capture`): any `accept` greys out
  non-matching files in the OS picker, and an `image/*` one made archives unreachable in
  the iPhone's Files app. Nothing downstream ever needed an image — `putFile` is
  `{name, data}` on the wire and `storePastedFile` only sanitizes the basename — so the
  restriction was purely the two PWA entry points. **Paste is different and is not a bug:**
  WebKit's async clipboard read (`navigator.clipboard.read()`, what the 📋 button calls)
  supports only `text/plain`, `text/html`, `text/uri-list` and `image/png`, and it
  deliberately suppresses file references — with a file on the pasteboard, `text/uri-list`
  is honoured only for `http`/`https`/`data`/`blob` schemes and `text/plain` returns empty,
  so a `file:` URL from Files.app is blocked by design. Don't "fix" `clipboard-paste.ts` to
  chase it. (The *paste-event* path, `DataTransfer.files` on a real paste into a focused
  editable field, is a different API that WebKit does populate — untested here, and using it
  would mean replacing the button with a native paste callout.)
  Two things not to drop: **uploads are capped at 20 MB in `store.sendPutFile`** — `putFile`
  base64s the file over the terminal session, and the old image-only filter was
  implicitly bounding size, so accepting archives removes that bound; the guard lives in
  `sendPutFile` because paste, the picker and the share target all funnel through it. And
  `sendPutFile` **returns whether it sent**, which `attachSharedFile` must honour: the
  share-target cache entry is the only copy of a shared file, so clearing it after a refused
  send destroys the bytes. **A shared file is attached only on the user's tap**
  (`SharedFileConfirm` in the terminal view names the file, its size and the workspace): the
  service worker drops a share-target POST that carries a referrer or a cross-site
  `Sec-Fetch-Site`, but a page that hides its referrer gets past that, so opening a workspace
  or a machine coming online must never send it on its own. The Android share target accepts `*/*` and the service worker
  reads **`form.get('file') ?? form.get('image')`** — an installed PWA keeps its old manifest
  until a home-screen reinstall, so the OS goes on POSTing the old field name.

## The test gate is at commit, merge, AND push — don't punch holes in it
Three hooks (`deploy/git-hooks/`) run the full suite via a shared `run-tests.sh`:
`pre-commit`, `pre-merge-commit`, and `pre-push`. The merge and push hooks exist because
`pre-commit` alone does **not** gate `main`: git never runs it for merge commits (the
dominant integration path here), fast-forward merges, or direct ref moves. `pre-merge-commit`
catches red merges before they land; `pre-push` is the universal backstop so nothing red
reaches `origin`, including FF merges and `git update-ref` advances no commit hook can see.
- **Never land code on `main` through a path that skips the gate.** Do **not** use
  `git commit --no-verify`, `git push --no-verify`, or `git update-ref refs/heads/main`
  to integrate — every one of these bypasses the suite and is how red code reached `main`
  before these hooks existed. If the gate is in your way, the tests are red — fix them.
- The gate first runs `deploy/check-leaks.sh`: gitleaks over the staged diff and history,
  then a whole-word check of tracked files against a word list kept **outside** the repo
  (`~/.perch/leak-words.txt`, or `$PERCH_LEAK_WORDS`) — names of other projects,
  organisations and hosts that must never be published. gitleaks only knows credential
  shapes, so it can't catch those; and committing the list would publish the names it
  guards. No list on a machine → that half is skipped. Use neutral fixture names (`foo`,
  `acme-org/acme-app`), never real ones.
- It then runs `pnpm -r typecheck` + `pnpm -r test` + `pnpm test:scripts`, builds the
  PWA and runs the Playwright **e2e** on a free port (the default 4173 is the standing
  deploy on the host running `run-pwa.sh`). The suite runs on **WebKit only** (the Perch client is exclusively WebKit —
  iPhone/iPad/Safari), so a machine needs it once — `pnpm --filter @perch/pwa exec
  playwright install webkit` — alongside `mise trust`; without them the gate fails closed.

## Pushing & merge conflicts
**There is no remote test CI.** The only GitHub Action is a gitleaks secret scan
(`.github/workflows/gitleaks.yml`), a backstop for the local leak check. The test gate
runs entirely on the local git hooks (commit/merge/push) before anything reaches `origin`.
So after a `git push`, do **not** wait for a remote test run — there is none. Verifying locally with
`pnpm -s test` + e2e is the whole story.

`origin` is a real GitHub remote (no test CI). The post-merge hook auto-pushes `main`, but that
push **fails whenever `origin/main` has advanced** since you branched. When a push fails —
the hook's auto-push or a manual `git push` — integrate automatically; do **not** stop and
ask:
1. `git fetch origin`, then `git merge origin/main` into local `main`.
2. Resolve any conflicts by reading **both** sides and integrating the real intent — never
   blind-pick `-X ours`/`-X theirs`, which silently drops code.
3. Gate on the suite (`pnpm -s test`): green → `git push origin main`; red, or a conflict
   hunk that's genuinely ambiguous → **stop and hand back**. Never push a red or guessed
   `main`.

## Reference
- Deploy runbook: `docs/DEPLOY.md`. Worktree runbook: `docs/WORKTREES.md`.
- The repo has no remote test CI; verify locally (`pnpm -s test` + e2e) before pushing.
