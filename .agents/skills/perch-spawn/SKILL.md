---
name: perch-spawn
description: Launch separate local Perch tmux workspaces from self-contained task briefs using the existing Claude Code launcher. Use when asked to open or spawn a Perch workspace, not for in-session Codex subagents or remote machines.
---

# Spawn a Perch workspace from Codex

A Perch workspace is a detached tmux session named `perch-<6 hex>`, discovered by
the machine agent. The existing launcher starts **Claude Code**, not Codex. Make
that explicit in the proposed launch. If the user specifically requests a Codex
workspace, do not silently substitute Claude or rename flags in this script.

The maintained helper and its tests remain in this repository:

- [spawn.sh](../../../.claude/skills/perch-spawn/spawn.sh)
- [spawn.test.sh](../../../.claude/skills/perch-spawn/spawn.test.sh)

Use those shared files rather than duplicating the launcher. They require local
`bash`, `tmux`, and `claude`. The existing `pnpm test:scripts` gate tests the helper.

## Prepare and launch

1. Resolve an existing absolute project directory for each workspace.
2. Write a self-contained brief. A child has none of this conversation's context.
   Reference an issue if it contains the details; otherwise describe the observed
   problem and desired outcome. Include reporting expectations and relevant
   constraints. Do not refer to “the bug above”.
3. Show the concrete batch (project, brief, optional title, and Claude runtime).
   Obtain launch authorization if the existing request does not already cover
   these workspaces. Honor existing authorization without asking again.
4. Run the shared script from the Perch repository root, passing the brief through
   a **quoted** heredoc:

```sh
bash .claude/skills/perch-spawn/spawn.sh --title 'issue 412' /abs/path/to/project <<'PROMPT'
Work on issue #412. Read it first and follow this project's conventions.
Complete the authorized work and report the changes, checks, and anything left open.
PROMPT
```

5. Report the returned workspace id and title. The brief remains at
   `~/.perch/spawn/<id>.md`.

The optional second positional argument is a Claude model alias; the current
script defaults to `opus[1m]`. Preserve that default unless the user requests a
different model. `--title` distinguishes batches and suppresses Claude's pane-title
updates for the initial session; it does not survive park/unpark.

Point children at their project roots and let each project's own worktree rules
provide isolation. If the project has no such convention and concurrent children
would edit the same files, resolve ownership before launching.

## Messaging boundary

**Do not pass `--parent` from an ordinary Codex session.** It installs Claude hooks
that deny user questions and require the child to contact a parent through Claude's
`SendMessage`. Codex collaboration agent ids are not Claude session names; there is
no implicit bridge between them. Without that bridge a child could be stranded.

Leave `--parent` off for user-driven workspaces. For a user-requested coordinated
batch, follow `$perch-orchestrate`: prefer native Codex subagents when suitable, or
explicitly arrange a workspace report location and monitoring plan. Use Claude's
parent mode only if an actual Claude parent and working messaging integration have
been established. The legacy Claude procedure is in
[the original skill](../../../.claude/skills/perch-spawn/SKILL.md).

## Launcher invariants

- Keep the brief on stdin, never interpolate it into a tmux shell command. The
  quoted heredoc preserves `$`, backticks, apostrophes, and newlines.
- Keep `@perch_command`: it supplies the workspace command and park/unpark resume
  behavior. It must omit the initial brief, or resuming would submit it again.
- Use the raw tmux helper; do not add a fallback through `perch create`, which
  requires machine-specific configuration.
- Tests must use a sandbox tmux socket. Unset `TMUX` on every helper invocation;
  it overrides `TMUX_TMPDIR`. Destructive test calls must explicitly pass
  `tmux -S <sandbox socket>`, never rely on environment variables alone.
- Do not run the launcher as a migration smoke test: it starts a real process.
