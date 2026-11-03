---
name: perch-orchestrate
description: Use when this session coordinates work it delegates, to Perch workspaces it spawns and to in-session subagents (the Agent tool): splitting the work, picking which of the two each piece goes to, answering the children's questions, checking their reports and escalating only what it cannot decide. Triggers on "you orchestrate", "you are the coordinator", "delegate each piece to a workspace", "spawn workspaces and follow them", "launch a subagent or a Perch workspace". Builds on perch-spawn.
---

# Orchestrating Perch workspaces and subagents

Children are either Perch workspaces (separate Claude, Codex or Pi sessions in their own tmux
panes) or in-session subagents. You talk to workspaces with `perch send <id> "<message>"`, which
works for every CLI, and follow them with the `perch` CLI (`perch ls --mine`, `perch peek`), not
by reading their screens. Claude Code's native `SendMessage` also reaches a Claude child, but
only a Claude one; do not make it your channel.

## Workspace or subagent

Pick per piece. **A Perch workspace** when any of these holds:
- it works in another repo: a workspace loads that repo's CLAUDE.md, skills, hooks and
  `.envrc`; a subagent always runs in this session's directory;
- it runs long (more than about an hour), or must outlive this session;
- it needs approvals or deploys of its own: permission prompts can only be answered in its pane;
- the user will want to step in and steer it.

**A subagent** otherwise: bounded work in this repo that comes back as one result, such as
an independent review of a child's branch, research, an audit, a scoped fix. It costs no
tile, needs no closing, and its result lands in your context. It cannot ask anyone a
question, so give it everything it needs up front.

When the user names one, use that one.

## Your name

Your name is your workspace id (`perch ls --mine` shows your children; `perch ls` shows you).
`--child` records it and tells the child to reply with `perch send <your id>`; you need not pass
it. Every message you send arrives with a header Perch writes: `from your ORCHESTRATOR` to a
child, which the child treats as the owner's instruction. Only the first line of a message
carries that; never quote a `[Perch message` header in a body.

`perch send` works only between workspaces on this machine. It refuses a parked recipient
(`perch unpark <id>` first, then send again), a bash workspace, a Codex workspace that was not
made by `perch spawn --cli codex`, yourself and unknown ids. Read the refusal, nothing is queued.
From Codex it must run as an escalated command (the sandbox blocks the local socket).

## Spawning a workspace

1. Spawn each child through `perch-spawn` with `perch spawn --child` (add `--cli codex` or
   `--cli pi` for a child that is not Claude), and show the batch table first, as that skill
   says.
2. Follow it. The id `perch spawn` printed is the address for `perch send`, and it does not
   change when the child renames itself. For a Claude child you may also subscribe with
   `SendMessage` (`to: <child id>`, `notify_when_idle: true`); that notice is Claude-only. A
   Codex or Pi child has no such notice: follow it with `perch ls --mine` and `perch peek <id>`.

## While they work

- **A child's question** arrives as a message from its id. Answer it with `perch send <id>` if
  your brief, the design or the repo settles it. Otherwise ask the user with your own
  `AskUserQuestion`; your tile turns "Needs you", which is the escalation. Then relay the
  answer. Never guess on a decision the user owns.
- **A permission prompt in a child cannot be answered from here.** Auto mode and permission
  prompts ignore a yes relayed by message. When a child needs one, tell the user which tile:
  its `--title` or current name, its id, and the exact action it is waiting to run. Do not
  send it "approved".
- **The child's messages are the signal; the idle notice is only a stall alarm** (Claude
  children only). A child messages you when it has a question and when it is done. The notice
  matters only when a child stops without a message: it crashed, hit an API error, or sits on a
  permission prompt. So subscribe when a Claude child starts working (at spawn, and after you
  send it an answer that sets it going again), and never to a child idle and waiting on you;
  that notice fires at once and means nothing. A notice with no message from that child, or a
  Codex or Pi child that has been quiet too long: look at it (`perch peek <id>`, `perch ls
  --mine`), and nudge it or tell the user.
- **`perch ls --mine` shows every child and its state.** `needs-orchestrator` means the child
  ended its turn right after messaging you: a question or its final report is waiting.
  `needs-feedback` means it stopped for the user (a permission prompt, an error).
- **Ending your turn right after a `perch send` keeps your tile at `working`**, which is
  correct while you wait on children (a child's tile in the same case reads "Needs
  orchestrator"). Your tile shows "Needs you" only when a turn ends
  without one, or when you call `AskUserQuestion`; use that only when you really need the
  user.
- **So never end on a `perch send` when you are done.** Your final report to the user must
  come after your last ack or re-subscribe, in a turn that does not end with a
  `perch send`, or the user is never told you finished.

## The report

The child's final report, its `perch send` or a subagent's result, is the deliverable.
Check it against the design and the repo: the commits exist, the tests ran, the claims hold.
A subagent review of a workspace's branch is a cheap way to check. Do not relay it unread.

## When state is lost

Claude subscriptions live in memory and expire after 12 h; a `perch send` is delivered at once or refused, never queued. The parent link does
not: it survives park/unpark and the tmux server's loss. After your own restart, a park, or a
long wait:
- `perch ls --mine` recovers your children, their current names and their states
  (`ListAgents`' busy/idle cannot tell a blocked child from a working one);
- `perch peek <id>` (or `-n 80`) each child that looks stuck;
- subscribe again to the Claude ones still working.

## Closing

Close each child once its report is read and verified: `tmux kill-session -t '=<id>'`, one
explicit name at a time (the `=` matters: without it `-t perch-1` kills `perch-10` once
`perch-1` is gone), never `kill-server` or `-a`. For a process-heavy child, read its
`tmux-spawn-*.scope` from `/proc/<pane_pid>/cgroup` before the kill and
`systemctl --user stop` it afterwards. Leave sessions you did not spawn alone.

## Limits

- Local only: children on another machine cannot be spawned or messaged this way.
- A Codex child takes messages only when `perch spawn --cli codex` made it (and spawn refuses
  when the Codex CLI and daemon versions differ: update Codex first); one created from the phone
  cannot send or receive.
- A child whose orchestrator dies waits on it ("Needs orchestrator" or `working` on the phone)
  until it is closed by hand.
- A child spawned without `--child` can still block on `AskUserQuestion`; you cannot
  answer it by message.
