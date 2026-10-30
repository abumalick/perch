---
name: perch-orchestrate
description: Coordinate explicitly requested delegated Perch work, choosing between native Codex subagents and separate local Perch workspaces, reviewing results, and handling questions and cleanup. Use for requests to orchestrate or follow delegated tasks.
---

# Coordinate Perch work from Codex

Use this workflow when the user requests delegation or coordination. Inspect the
tools actually available in the session; do not assume Claude's `Agent`,
`ListAgents`, or cross-session `SendMessage` tools are present.

## Choose the execution context

- **Codex subagent:** bounded work in this repository, such as a review, research,
  or a scoped implementation. Use the exposed collaboration tools when available.
  Agents share files, so assign non-overlapping ownership or separate worktrees.
- **Perch workspace:** a separate repo, a long-lived task, or a session the user
  needs to steer independently. It has its own tmux pane and process.
  `$perch-spawn` (`perch spawn`) launches **Claude Code**.

Honor the user's requested context. If the necessary tools are unavailable,
explain the limitation and continue the parts possible locally; do not invent a
messaging bridge or substitute a different runtime silently.

## Native Codex delegation

Give each child a concrete outcome, repository/worktree path, file ownership,
constraints, relevant context, expected verification, and reporting requirements.
Use `spawn_agent` when exposed, and retain its returned agent identifier for
`send_message`, `followup_task`, and status/wait tools. Tool names and capabilities
can vary by host; use their actual schemas. Do not send a tmux id to these tools.

Answer child questions from the task and repository evidence. Escalate decisions
the user owns. A relayed “approved” message does not satisfy a child process's
permission prompt; identify its exact pending action and where the user must act.

Keep making independent progress while children work. Receive their reports with
the host's completion/message tools and inspect the resulting changes and checks.
Do not report a task complete merely because a child says it is.

## Separate Perch workspaces

Launch through `$perch-spawn`. Record ids, project paths, titles, task ownership,
and expected report locations so coordination can survive lost context.

Codex's native collaboration tools do not address arbitrary Claude sessions.
Without an explicitly available cross-session bridge:

- Leave `perch spawn`'s `--child` unset: its hook would prohibit user questions
  and redirect the child to an unreachable Claude parent.
- Include a concrete report path in the brief when the user wants supervision,
  e.g. a unique file under that project's gitignored `.tmp/`. Read that report
  and inspect the child's branch/worktree when it completes.
- Use `perch ls` (status, title, folder of every workspace) and, when needed,
  `perch peek <workspace-id> -n 80` to diagnose a stalled child.
  These are observations, not reliable structured completion messages.
- Tell the user which workspace needs attention, including its title, id and
  pending action. Do not submit answers or approve permission dialogs through
  tmux keystrokes.

If an actual Claude messaging bridge is available, read the original
[orchestration procedure](../../../.claude/skills/perch-orchestrate/SKILL.md)
before using its subscriptions or parent mode. Its `SendMessage` idle/status
behavior is Claude-specific; do not assume it applies to Codex messages.

## Verify and finish

Review reports against the requested outcome, actual diffs/commits and test
results. Integration still follows `$work` and its on-device gate where applicable.
Distinguish verified completion, blocked work and unverified claims in the report.

Close only children created for this task after their useful state is preserved
and closing them is within the requested scope. For Perch sessions, target one
explicit id with `tmux kill-session -t <id>`; never kill the ambient server or use
`-a`. For process-heavy children, inspect the pane's cgroup before closing and reap
only its exact `tmux-spawn-<uuid>.scope` if needed; never stop the agent service's
scope. Leave unrelated sessions alone.

If context is lost, recover the recorded task/child mapping (`perch ls` lists
every workspace with its title and folder), inspect status and
reports, and re-establish any available subscriptions. Do not assume Claude's
subscription lifetimes or restart semantics apply to Codex.
