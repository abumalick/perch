---
name: perch-spawn
description: Use when asked to launch, spawn, or open one or more new Perch workspaces to work on something — a batch of tickets or issues, or a single problem found mid-conversation that deserves its own workspace. Triggers on "launch a workspace on this", "spawn a workspace for each of those tickets", "open a new Perch workspace to investigate…", "start a workspace in <project>". NOT for in-session subagents (the Agent tool): a Perch workspace is a separate tmux session with its own Claude process and none of this conversation's context.
---

# Spawning Perch workspaces

## Overview

A Perch workspace *is* a detached tmux session named `perch-<6 hex>`. The Perch
agent discovers workspaces by running `tmux list-sessions` — nothing registers
them. The `perch` CLI starts one (`perch spawn`); it needs no agent restart and no
token. It is on PATH once `deploy/install-cli.sh` has run on the machine (see
"Perch CLI" in the Perch repo's `docs/DEPLOY.md`).

Each workspace runs its own `claude` process with its own context. It cannot see
this conversation. **The brief is the only thing it will ever know.**

## When to use

- "Launch a workspace on each of these three tickets"
- "Open a workspace to investigate that bug and fix it"
- "Start a workspace in <project> to do X while we keep going here"

**Do not use for:**
- In-session subagents. "Launch a subagent", "run an agent on this" mean the
  Agent tool, which shares this conversation's context. Different thing.
- Spawning onto another machine. This spawns locally; another machine would need
  the WebSocket protocol and its token.

## Workflow

1. **Check nothing already covers it.** `perch ls` lists every workspace, parked
   ones included, with its title and folder; resume or message an existing one
   rather than spawning a duplicate.
2. **Resolve a project path per item** — it must exist (a relative one resolves
   against your cwd). Two items on the same repo get the same path (see Isolation).
3. **Write a self-contained brief per item** (see below).
4. **Show the batch as a table and ask before spawning.** One row per workspace:
   project path, and the brief or its first line. N background Claude processes
   is not silently reversible, and the briefs are the part worth checking — the
   user gets to see what each workspace will be told before it starts.
5. **Spawn each**, after the yes.
6. **Report the ids.** Names sort themselves out: Claude Code writes the pane
   title and the agent reads that as the workspace name, so each tile ends up
   labelled by what it is doing rather than by the repo. Pass `--title` instead
   when the workspaces come from one batch and their summaries would all look
   alike — see [Naming a workspace](#naming-a-workspace).

## Quick reference

```bash
perch spawn /abs/path/to/project <<'PROMPT'
Work on issue #412. Read it first, then follow this project's conventions.
PROMPT
```

Prints the workspace id. `--model <alias>` picks the model (default
`opus[1m]`); pass `--model 'sonnet[1m]'` for cheap batch work. Each brief is kept at
`~/.perch/spawn/<id>.md` as a record of what that workspace was launched to do.
The Claude session is named after the workspace id, so other sessions can
`SendMessage` it by the id this prints.

## Naming a workspace

By default Claude Code names the workspace, by writing the pane title as it
works — which is why the names read like task summaries rather than repo names.
That is usually what you want, and it is the name you will see change as the
conversation moves on.

When you already know what the workspace is for, say so and the name stops
moving:

```bash
perch spawn --title 'story foo 9' /abs/path <<'PROMPT'
...
PROMPT
```

Worth it for a **batch**: ten workspaces launched from one loop otherwise end up
with ten near-identical summaries, and the tiles cannot be told apart. Give each
the identifier the rest of the work already uses — the branch, the ticket, the
row — and a tile matches a log line without guessing.

The title survives for the life of the session. It does **not** survive an
unpark: a resumed workspace starts a fresh Claude Code without the flag that
suppresses renaming, so it goes back to naming itself.

Always pass the brief through a **quoted** heredoc (`<<'PROMPT'`). An unquoted
one lets the shell expand `$` and backticks in the brief before it is written.

## Reporting to an orchestrator

When the spawning session is an orchestrator that will follow the child, pass
`--child`. The caller must itself be a Perch workspace (it is found from
`$TMUX_PANE`):

```bash
perch spawn --child /abs/path <<'PROMPT'
...
PROMPT
```

The child then:
- **records its parent's workspace id**, a link that survives park/unpark and the
  tmux server's loss; `perch ls --mine` lists the caller's children from it.
- **cannot use `AskUserQuestion` or plan mode.** A per-workspace hook denies them
  and tells it to send the question to the parent with `SendMessage` instead. A
  peer message can never answer a pending prompt, so without this a child blocks
  on a question its orchestrator could have answered.
- **is told in its brief** (an appended footer) to send its questions and its final
  report to the parent by its current messaging name, and to run `perch ls` if that
  name stops resolving.

Without `--child` the workspace is an ordinary one the user drives (the default;
orchestration is explicit). The orchestrator's side is the `perch-orchestrate` skill.

## Writing the brief

The workspace starts cold. Anything carried from this conversation has to be
written down.

- **With a ticket, reference it and stop:** "Work on issue #412. Read it first."
  The details are in the ticket — do not restate them.
- **Without a ticket, describe the actual problem:** what was observed, where,
  and what a good outcome is. Never "the bug we discussed" or "the issue above" —
  the workspace has no above.
- **Say what to do, not how:** "Fix it, and open a ticket if there isn't one" is
  enough. It has the repo and its conventions.
- **Tell it to run to completion.** A workspace's tile turns "Needs you"
  whenever its turn ends, so an agent that stops mid-task to confirm a plan
  looks like it is waiting on the user when it is not. "Work it through, don't
  check in with me" keeps that signal honest. The "Needs you" at the *end* is
  correct — that one means the workspace is worth looking at. With `--child`
  the orchestrator owns this, and the footer covers reporting; don't repeat it.
- Keep it short. A few sentences beats a page.

## Isolation

Point every workspace at the project root and let the repo's own convention take
over — many repos require a git worktree per feature, and their agents create one
themselves. Do not create worktrees or branches here; this is a launcher.

If a repo has no such convention and two workspaces will touch the same files,
say so when presenting the table and let the user decide.

## Testing

`perch spawn` is `spawnWorkspace` in the Perch repo's `packages/agent`, tested there
with a fake tmux. Never run it as a smoke test: it starts a real Claude process.

## Common mistakes

| Mistake | What happens |
|---|---|
| Starting a workspace with raw `tmux new-session` | No `@perch_command`, so it can never be parked; a brief interpolated into the command string dies on its first apostrophe, silently |
| A brief that says "the bug above" | The workspace has no above; it starts by asking what you mean and then sits idle |
| Spawning before showing the table | Several Claude processes start on briefs nobody checked |
| Spawning without checking `perch ls` | A second workspace starts on work an existing (perhaps parked) one already holds |
| Setting the pane title yourself, after spawning | Claude Code overwrites it within seconds — use `--title`, which also turns its renaming off |
