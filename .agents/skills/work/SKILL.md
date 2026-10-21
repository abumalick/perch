---
name: work
description: Implement Perch features, fixes, and behavior changes using its worktree, clean architecture, testing, on-device verification, and local integration workflow.
---

# Work — Perch development flow for Codex

Read the repository's `AGENTS.md` and the relevant architecture/regression notes in
`CLAUDE.md`. This skill is self-contained; it does not require `superpowers:*` or
Claude-specific tools. Reading this file for review or migration does not activate
the implementation workflow.

## Design and scope

Understand the requested outcome and inspect the affected code before editing.
For substantive changes, record the design and a short implementation plan; scale
this to the task. Resolve routine choices from project conventions and ask only for
missing decisions that matter. Local design notes may go under the gitignored
`docs/superpowers/`; durable information belongs in `AGENTS.md`, `CLAUDE.md`, tests,
or tracked `docs/*.md`. Do not commit ignored design notes.

## Worktree gate

Provably docs-only work (`*.md` or documentation under `docs/`) may use the current
branch. Anything involving code or config requires a dedicated worktree before
editing. Never switch the shared main checkout to a feature branch.

```sh
git worktree add .worktrees/<feature> -b <feature>
cd .worktrees/<feature>
mise trust
pnpm install
```

Use a short kebab-case feature name. See `docs/WORKTREES.md`; dependencies and mise
trust are per-worktree. Inspect existing changes and preserve others' work.

## Implementation and verification

Keep domain/application logic pure, define I/O through `ports/`, put adapters in
`infrastructure/`, and wire them in `server/`. For behavior changes, first reproduce
the problem with a meaningful failing test where practical, then implement the
smallest fix and verify it. Use fakes for core logic. Docs-only edits need metadata,
links, and diff validation, not new runtime tests.

Run relevant checks while working. The integration gate includes:

```sh
pnpm -r typecheck
pnpm -r test
pnpm test:scripts
pnpm --filter @perch/pwa build
E2E_PORT=<free-port> pnpm --filter @perch/pwa e2e
```

Port 4173 belongs to the standing deploy. E2E uses WebKit; install its browser if
needed. Commit/merge/push hooks also run leak checks. Never bypass those hooks.

## On-device gate

Once a behavior change is ready and verified locally, describe the concrete live
test and seek authorization if the user has not already given it:

```sh
pnpm serve:build .worktrees/<feature>
```

The installed PWA updates while foregrounded in about 60 seconds and shows the
feature slug. Protocol changes also need `pnpm serve:agent .worktrees/<feature>`;
relay changes may need `pnpm serve:relay .worktrees/<feature>`. These change shared
live services. Check the existing deploy symlinks before replacing them.

Wait for the user's on-device verdict before integration. Explain this gate as the
project's requirement and link to this skill when asking. Existing authorization
still applies; do not ask twice. Docs-only work skips this phase.

## Integration and cleanup

After the device test is approved and integration is authorized, restore any live
slots this task changed (`serve:restore`, `serve:agent-restore`,
`serve:relay-restore`). Commit only this task's changes with hooks enabled. From the
main checkout, verify that it is on main, merge the feature branch, then use
`pnpm worktree:remove .worktrees/<feature>` and `git branch -d <feature>` after a
successful merge. Do not switch another session's shared checkout branch.

Read both sides of merge conflicts and integrate their intent. Never use blanket
`-X ours` / `-X theirs`. A clean merge rebuilds and auto-pushes main; a conflicted
merge needs an explicit push after the resolved merge passes the full gate. If
origin advanced, fetch and merge `origin/main`, verify, and push again. Stop for
failing tests or genuinely ambiguous conflicts; never publish a guessed result.

Docs-only work has no deploy or worktree cleanup. Commit when authorized; otherwise
leave the verified diff for review. Do not treat invocation of this skill alone
as permission to deploy, merge, push, or commit beyond the user's task.

## Closeout

Report what changed, what was verified, and anything left open. State whether the
changes are uncommitted, awaiting an on-device verdict, or integrated with cleanup
complete. Do not label an unmerged feature ready to close.
