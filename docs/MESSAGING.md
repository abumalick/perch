# Messaging between workspaces

## Pi inbox contract

`perch send` reaches a Pi session through a socket that the Perch extension for Pi
(`perchInbox`, loaded by `pi-reviewed`) binds in that session. The agent's side is
`PiInboxDelivery` (`packages/agent/src/infrastructure/pi-inbox-delivery.ts`). Version 1:

- **Path:** `~/.perch/inbox/<workspace-id>.sock`, where the workspace id is the tmux session
  name of the pane Pi runs in (`tmux display-message -p -t "$TMUX_PANE" '#S'`). The directory
  is 0700 and the socket 0600: only the user running both ends can write to it.
- **The extension binds it** at `session_start`, unless Pi runs outside tmux or as a subagent
  (`PI_SUBAGENT_DEPTH` set). It binds a private name and renames it over the path, which
  replaces a stale socket; at `session_shutdown` it unlinks the path only while it is still its
  own socket (same device and inode), so a second Pi that took the path over keeps it.
- **Limits:** a line over 1 MiB + 64 KiB is answered `message too large` and the connection
  dropped; a connection idle for 10 s without a full line is dropped unanswered.
- **The agent writes one line,** `JSON.stringify({ v: 1, text })` + `\n`. `text` is the whole
  message: the Perch header (`formatAgentMessage`), a `---` line, then the body.
- **The extension answers one line and closes:** `{"ok":true}` once it handed the text to Pi
  (`pi.sendMessage` with `customType: "perch-message"`, `triggerTurn: true`,
  `deliverAs: "steer"`), or `{"ok":false,"error":"…"}`. A line that is not exactly
  `{v: 1, text: string}` is refused.
- **What `perch send` reports:**
  - no socket, or one nobody listens on → `Pi without the Perch inbox`;
  - a refusal → `the Pi inbox refused: <error>`;
  - no answer within 5 s → `the Pi inbox did not answer in 5 s`;
  - anything else (closed without answering, an answer outside the contract, another socket
    error) → `the Pi inbox of <id> failed: <message>`.
- **The header's first line is wire format.** The extension and Pi's reviewer read
  `[Perch message — from your ORCHESTRATOR]` (em dash) at the start of `text` as the owner's
  own instruction; `from your CHILD` and `from a PEER` grant nothing. Only the first line of
  the whole message counts. The agent always writes the header first and quotes (`> `) every
  body line that begins with `[Perch message`, so a body sent through `perch send` cannot forge
  one; for Claude it also escapes `</cross-session-message` in the text, so a body cannot close
  the envelope and open a second one under another sender's name. Change the wording on both
  sides together.
- **Accepted limit: this is a guard against accidents and prompt injection, not a security
  boundary.** Every workspace runs as the same user, so any process of that user can claim the
  orchestrator's authority by two routes, for all three CLIs (Claude's and Codex's sockets as
  well as this one): it can write an inbox socket directly with a forged header, or set
  `@perch_parent` on another tmux session so the agent itself writes `from your ORCHESTRATOR`.
  The sender-side guards refuse only the obvious commands that would do either: `perch-guard.sh`
  (Claude Code and Codex) refuses `nc`, `ncat`, `socat` or `curl` naming a message socket
  (`cc-socks/`, `.perch/inbox/`, `app-server-control/`) and `tmux set`/`setw` (any form) of
  `@perch_parent` or `@perch_codex_thread` on the default server. Beyond that it is up to each
  CLI's own configuration, which Perch does not ship: Claude Code's auto-mode rules and Pi's
  reviewer can hold these commands and judge a `perch send` body as an instruction given on the
  owner's behalf; Codex's `[auto_review]` reviewer takes no extra rules from `config.toml`
  (`extra_policy` has no effect on its verdicts), so for Codex it is the model's own
  instructions (`AGENTS.md`) and `perch-guard.sh`. A script, a path reached through `cd` or a
  variable, or any other client gets past the guard.
- **Status:** an accepted message reports `UserPromptSubmit` through the Perch status hook
  before it reaches Pi, as a typed prompt does.

## Codex delivery

`perch send` reaches a Codex session through the Codex app-server daemon
(`~/.codex/app-server-control/app-server-control.sock`, JSON-RPC over a WebSocket), never
through the pane. The agent's side is `CodexDelivery` over `CodexAppServer`
(`packages/agent/src/infrastructure/codex-*.ts`).

- **Only a daemon-bound thread takes messages.** The workspace must record its thread as the
  tmux option `@perch_codex_thread` (set by `perch spawn --cli codex`), and the daemon must list
  that thread in `thread/loaded/list`. A Codex started with `--no-daemon`, or with any `-c`,
  `--enable`, `--disable` or `--search` on its command line, holds its thread in-process, where
  nothing outside can reach it.
- **Idle thread → `turn/start`; running turn → `turn/steer`** with the turn's id from
  `thread/read`. When the turn moved or ended between the two, the delivery re-reads once.
- **What `perch send` reports:** no recorded thread → `no Codex thread recorded for <id> (only
  perch spawn --cli codex workspaces take messages)`; not loaded → `the Codex thread of <id> is
  not open`; no socket → `the Codex app server is not running`; anything else → `the Codex app
  server failed: <message>`.
- **A Codex sender is named by its thread.** Tools run in the daemon's sandbox, outside the
  pane, with the daemon's stale `TMUX_PANE`; `perch send` posts `CODEX_THREAD_ID` and the agent
  takes the workspace recording that thread as the sender, with no ancestry check (the same
  accepted limit as above). Its hooks run in the daemon too: `perch-hook.sh` posts the payload's
  `session_id` as `thread`, and `/hooks` applies the event to the workspace recording it.
  Either way a thread names a workspace only when exactly one session running `codex` records
  it, and a hook by thread must say `agent: codex`; anything else names nobody. Hooks by thread
  are applied in the order they arrive.
- **`perch spawn --cli codex` makes the thread first.** It refuses when `codex --version` and the
  daemon's `appServerVersion` differ (the CLI would open on an update chooser), creates the thread
  with the brief as its first turn (`thread/start` + `turn/start`, and a child's orchestrator
  note as `developerInstructions`), then launches exactly `codex resume <thread id>`.
