---
name: perch-spawn
description: Launch separate local Perch tmux workspaces from self-contained task briefs with the `perch spawn` CLI, which starts Claude Code. Use when asked to open or spawn a Perch workspace, not for in-session Codex subagents or remote machines.
---

# Spawn a Perch workspace from Codex

A Perch workspace is a detached tmux session named `perch-<6 hex>`, discovered by
the machine agent. The launcher is the `perch` CLI (`perch spawn`), on PATH once
`deploy/install-cli.sh` has run on the machine (`docs/DEPLOY.md`, "Perch CLI").
It starts **Claude Code**, not Codex. Make that explicit in the proposed launch.
If the user specifically requests a Codex workspace, do not silently substitute
Claude.

Use the CLI rather than raw tmux or a launcher of your own. It is
`spawnWorkspace` in `packages/agent`, tested there.

## Prepare and launch

1. Run `perch ls` to see whether an existing workspace (parked ones included,
   listed with title and folder) already holds the task, then resolve an existing
   project directory for each new one (a relative path resolves against the cwd).
2. Write a self-contained brief. A child has none of this conversation's context.
   Reference an issue if it contains the details; otherwise describe the observed
   problem and desired outcome. Include reporting expectations and relevant
   constraints. Do not refer to “the bug above”.
3. Show the concrete batch (project, brief, optional title, and Claude runtime).
   Obtain launch authorization if the existing request does not already cover
   these workspaces. Honor existing authorization without asking again.
4. Run `perch spawn`, passing the brief through a **quoted** heredoc:

```sh
perch spawn --title 'issue 412' /abs/path/to/project <<'PROMPT'
Work on issue #412. Read it first and follow this project's conventions.
Complete the authorized work and report the changes, checks, and anything left open.
PROMPT
```

5. Report the returned workspace id and title. The brief remains at
   `~/.perch/spawn/<id>.md`.

`--model <alias>` picks the Claude model; the default is `opus[1m]`. Preserve that default unless the user requests a
different model. `--title` distinguishes batches and suppresses Claude's pane-title
updates for the initial session; it does not survive park/unpark.

Point children at their project roots and let each project's own worktree rules
provide isolation. If the project has no such convention and concurrent children
would edit the same files, resolve ownership before launching.

## Messaging boundary

**Do not pass `--child` from an ordinary Codex session.** It installs Claude hooks
that deny user questions and require the child to contact its parent (the calling
workspace) through Claude's `SendMessage`. Codex collaboration agent ids are not Claude session names; there is
no implicit bridge between them. Without that bridge a child could be stranded.

Leave `--child` off for user-driven workspaces (the default). For a user-requested coordinated
batch, follow `$perch-orchestrate`: prefer native Codex subagents when suitable, or
explicitly arrange a workspace report location and monitoring plan. Use Claude's
parent mode only if an actual Claude parent and working messaging integration have
been established. The legacy Claude procedure is in
[the original skill](../../../.claude/skills/perch-spawn/SKILL.md).

## Launcher invariants

- Keep the brief on stdin through a quoted heredoc, never interpolated into a
  command line: it preserves `$`, backticks, apostrophes, and newlines.
- Do not start workspaces with raw `tmux new-session`: without the CLI's
  `@perch_command` a workspace can never be parked or resumed.
- Do not run `perch spawn` as a migration smoke test: it starts a real process.
