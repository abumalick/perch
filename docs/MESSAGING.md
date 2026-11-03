# Messaging between workspaces

## Pi inbox contract

`perch send` reaches a Pi session through a socket that the Perch extension for Pi
(`perchInbox`, loaded by `pi-reviewed`) binds in that session. The agent's side is
`PiInboxDelivery` (`packages/agent/src/infrastructure/pi-inbox-delivery.ts`). Version 1:

- **Path:** `~/.perch/inbox/<workspace-id>.sock`, where the workspace id is the tmux session
  name of the pane Pi runs in (`tmux display-message -p -t "$TMUX_PANE" '#S'`). The directory
  is 0700 and the socket 0600: only the user running both ends can write to it.
- **The extension binds it** at `session_start`, unless Pi runs outside tmux or as a subagent
  (`PI_SUBAGENT_DEPTH` set). It unlinks a stale socket first, and closes and unlinks its own at
  `session_shutdown`.
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
  own instruction; `from your CHILD` and `from a PEER` grant nothing. The agent always writes
  the header first, so a body cannot forge it. Change the wording on both sides together.
- **Status:** an accepted message reports `UserPromptSubmit` through the Perch status hook
  before it reaches Pi, as a typed prompt does.
