---
name: perch-orchestrate
description: Use when this session coordinates work it delegates, to Perch workspaces it spawns and to in-session subagents (the Agent tool): splitting the work, picking which of the two each piece goes to, answering the children's questions, checking their reports and escalating only what it cannot decide. Triggers on "you orchestrate", "you are the coordinator", "delegate each piece to a workspace", "spawn workspaces and follow them", "launch a subagent or a Perch workspace". Builds on perch-spawn.
---

# Orchestrating Perch workspaces and subagents

Children are either Perch workspaces (separate Claude sessions in their own tmux panes) or
in-session subagents. You talk to workspaces with Claude Code's cross-session messaging
(`SendMessage`, `ListAgents`) and follow them with the `perch` CLI (`perch ls --mine`,
`perch peek`), not by reading their screens.

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

The first line of `ListAgents` says "This session is X". X is what children address. If you
were spawned by `perch spawn`, X starts as your workspace id. You need not pass it: `--child`
records your workspace id and tells the child your current name.

## Spawning a workspace

1. Spawn each child through `perch-spawn` with `perch spawn --child`, and show the batch
   table first, as that skill says.
2. Subscribe to it: `SendMessage` with `to: <child id>`, `notify_when_idle: true`. The child
   id is what `perch spawn` printed, because the session is named after it; if it renames
   itself, `perch ls --mine` shows the current name (NAME column).

## While they work

- **A child's question** arrives as a message from its id. Answer it with `SendMessage` if
  your brief, the design or the repo settles it. Otherwise ask the user with your own
  `AskUserQuestion`; your tile turns "Needs you", which is the escalation. Then relay the
  answer. Never guess on a decision the user owns.
- **A permission prompt in a child cannot be answered from here.** Auto mode and permission
  prompts ignore a yes relayed by message. When a child needs one, tell the user which tile:
  its `--title` or current name, its id, and the exact action it is waiting to run. Do not
  send it "approved".
- **The child's messages are the signal; the idle notice is only a stall alarm.** A child
  messages you when it has a question and when it is done. The notice matters only when a
  child stops without a message: it crashed, hit an API error, or sits on a permission
  prompt. So subscribe when a child starts working (at spawn, and after you send it an
  answer that sets it going again), and never to a child idle and waiting on you; that
  notice fires at once and means nothing. A notice with no message from that child: look at
  it (`perch peek <id>`), and nudge it or tell the user.
- **`perch ls --mine` shows every child and its state.** `needs-orchestrator` means the child
  ended its turn right after messaging you: a question or its final report is waiting.
  `needs-feedback` means it stopped for the user (a permission prompt, an error).
- **Ending your turn right after a `SendMessage` keeps your tile at `working`**, which is
  correct while you wait on children (a child's tile in the same case reads "Needs
  orchestrator"). Your tile shows "Needs you" only when a turn ends
  without one, or when you call `AskUserQuestion`; use that only when you really need the
  user.
- **So never end on a `SendMessage` when you are done.** Your final report to the user must
  come after your last ack or re-subscribe, in a turn that does not end with a
  `SendMessage`, or the user is never told you finished.

## The report

The child's final report, its `SendMessage` or a subagent's result, is the deliverable.
Check it against the design and the repo: the commits exist, the tests ran, the claims hold.
A subagent review of a workspace's branch is a cheap way to check. Do not relay it unread.

## When state is lost

Subscriptions and queued messages live in memory and expire after 12 h. The parent link does
not: it survives park/unpark and the tmux server's loss. After your own restart, a park, or a
long wait:
- `perch ls --mine` recovers your children, their current names and their states
  (`ListAgents`' busy/idle cannot tell a blocked child from a working one);
- `perch peek <id>` (or `-n 80`) each child that looks stuck;
- subscribe again to the ones still working.

## Closing

Close each child once its report is read and verified: `tmux kill-session -t <id>`, one
explicit name at a time, never `kill-server` or `-a`. For a process-heavy child, read its
`tmux-spawn-*.scope` from `/proc/<pane_pid>/cgroup` before the kill and
`systemctl --user stop` it afterwards. Leave sessions you did not spawn alone.

## Limits

- Local only: children on another machine cannot be spawned or messaged this way.
- A child whose orchestrator dies waits on it ("Needs orchestrator" or `working` on the phone)
  until it is closed by hand.
- A child spawned without `--child` can still block on `AskUserQuestion`; you cannot
  answer it by message.
