# Perch — Codex agent guide

Perch is a mobile-first PWA for interacting with terminal sessions (including Claude
Code and Codex) in tmux workspaces across machines. Each machine's agent dials out to
relays; the phone reaches it through an end-to-end Noise session keyed by its device
key. No agent listens on a phone-facing port.

## Instruction sources

This is Codex's repository entry point (`AGENTS.md`, plural). It adapts the shared
working rules from [CLAUDE.md](CLAUDE.md). That file remains the detailed architecture,
deployment, and regression reference for both clients. Read its relevant sections
before changing a subsystem; search by symbol or topic rather than loading all 84 KB.
Keep shared rules consistent when updating either guide. Codex tool and workflow
instructions here and in `.agents/skills/` take precedence over Claude-specific
workflow instructions. References to Claude's runtime behavior describe the product;
do not mechanically rename its commands, hooks, or protocol fields to Codex.

Useful routes into `CLAUDE.md`:

- **Runtime & deployment:** machine configuration, workspace lifecycle, parking,
  resource limits, reconnect, relays, Noise, device keys, enrolment and pairing.
- **CRITICAL: why the PWA is still served from the tailnet:** origin and device-key
  constraints. Keep the maintainer's PWA on its existing tailnet origin.
- **Gotchas already fixed:** terminal input, mobile keyboards, browser typing,
  schema drift, attention hooks (including Codex), media and file uploads.
- Runbooks: [deployment](docs/DEPLOY.md), [worktrees](docs/WORKTREES.md),
  [relays](docs/relay-cf-runbook.md), [machine setup](docs/SETUP-MACHINE.md).

## Golden rules

- All code, docs, comments, and commits in English.
- Testability is the top priority. Keep pure domain/application logic and ports
  separate from I/O adapters; test the core with fakes and keep adapters thin.
- Make surgical changes, follow surrounding style, and avoid speculative features.
- Use **mise** for the pinned Node 24 / pnpm 11 toolchain and **pnpm** for this
  workspace monorepo. Use **uv** for any Python tooling.
- Never commit secrets. `deploy/agent.env` is gitignored;
  `deploy/agent.env.example` is the template. Use neutral fixture names, never real
  unrelated project, organisation, or host names.

## Layout

- `packages/contracts` (`@perch/contracts`): zod wire schemas and shared types.
  Change the protocol here first, then the agent and PWA. Terminal data is base64.
- `packages/agent` (`@perch/agent`): tmux and node-pty adapters, relay connections,
  and a loopback-only `POST /hooks` server. Domain/application in `application/`
  and `ports/`, adapters in `infrastructure/`, wiring in `server/`.
- `packages/relay`, `packages/relay-cf`, `packages/secure-channel`: relay core,
  Node and Cloudflare hosts, and the Noise session implementation. Keep relay core
  host-agnostic and run the shared conformance suite on both hosts after changes.
- `packages/pwa` (`@perch/pwa`): Svelte 5 runes, xterm.js, Vite PWA, Playwright.
  Core logic lives in `src/core` and `src/adapters`; `src/lib` contains the UI.

## Development workflow and skills

Codex discovers this repository's skills in `.agents/skills/`. Use:

- `$work` for Perch features, fixes, and behavior changes. It contains the local
  design, worktree, testing, on-device verification, and integration workflow;
  it does not require the Claude Superpowers plugin.
- `$perch-spawn` when asked to launch a separate local Perch workspace. Its
  launcher, `perch spawn`, starts **Claude Code**, even when called from Codex.
- `$perch-orchestrate` when asked to coordinate delegated work. Use available Codex
  collaboration tools for Codex subagents; they cannot address arbitrary Claude
  sessions by a tmux workspace id.

Do not assume Claude's `Agent`, `SendMessage`, `ListAgents`, `AskUserQuestion`,
or `superpowers:*` skills exist in Codex. Use only tools actually exposed in the
session. Reading or migrating a skill is not an instruction to execute its workflow.

## Worktrees and live testing

- Never do code/config feature work in the shared main checkout, or switch its
  branch with `git checkout` / `git checkout -b`. Create a worktree first:
  `git worktree add .worktrees/<feature> -b <feature>`, then run `mise trust` and
  `pnpm install` there. Dependencies are per-worktree.
- Provably docs-only work (`*.md` or documentation under `docs/`) may stay on the
  current branch, as in the existing `work` workflow. It needs no device deploy.
- Unit/integration tests use ephemeral ports. E2E uses a fixed preview port:
  **4173 is reserved for the standing deploy**. Build first, then choose a free
  `E2E_PORT`, e.g. `E2E_PORT=4175 pnpm --filter @perch/pwa e2e`.
- `pnpm serve:build .worktrees/<feature>` builds the PWA and changes the live deploy.
  The installed app updates in about 60 seconds while foregrounded and shows the
  worktree slug. `pnpm serve:restore` restores main.
- Protocol changes need the worktree's agent too: `pnpm serve:agent
  .worktrees/<feature>`; restore with `pnpm serve:agent-restore`. Relay equivalents
  are `serve:relay` and `serve:relay-restore`. These are shared live slots, not
  isolated previews; inspect existing symlinks before changing them.
- Propose on-device testing after implementation and local checks are ready. Obtain
  authorization for the live switch if not already given, then wait for the user's
  device-test verdict before integrating behavior changes.
- Remove integrated worktrees with `pnpm worktree:remove .worktrees/<feature>` so a
  live symlink cannot be left pointing at a deleted checkout. Delete only merged
  branches with `git branch -d <feature>`.

## Commands and verification

- Unit tests: `pnpm -s test` (runs `pnpm -r test`). This alone is **not** the full gate.
- Types: `pnpm -r typecheck`. Shell/script tests: `pnpm test:scripts`.
- PWA build: `pnpm --filter @perch/pwa build`.
- PWA e2e: `E2E_PORT=<free-port> pnpm --filter @perch/pwa e2e` after building.
  The suite uses WebKit and a faithful fake agent in `e2e/fake-agent.ts`.
  Install WebKit once per machine with
  `pnpm --filter @perch/pwa exec playwright install webkit`.
- Individual packages: `pnpm --filter @perch/<pkg> test` or `typecheck`.
- Add meaningful regression coverage for behavior changes. For documentation-only
  edits, validate paths, skill metadata and the diff rather than adding code tests.

The commit, merge, and push hooks in `deploy/git-hooks/` run the shared
`run-tests.sh` gate: leak checks, types, unit tests, script tests, PWA build and e2e
on a free port. Never bypass it with `--no-verify`, or integrate by updating
`refs/heads/main` directly. Fix failures instead. The leak check includes a private
word list outside the repo (`~/.perch/leak-words.txt` or `PERCH_LEAK_WORDS`); never
copy that list into the repository.

There is **no remote test CI**. GitHub only runs a gitleaks scan. Do not wait for a
remote test run after pushing. Post-commit/post-merge hooks rebuild; a clean merge
to main also auto-pushes, so merging has a remote side effect.

When integration/push is authorized and a push fails because `origin/main` advanced,
fetch and merge it into local main automatically. Read both sides of conflicts;
never blind-pick `-X ours` / `-X theirs`. Run the test gate before pushing. A conflicted
merge does not run post-merge's auto-push: push explicitly after the merge is green.
Stop and report genuinely ambiguous conflicts or failing tests; never push guessed
or red main. Leave changes uncommitted when the task does not authorize a commit.

## Runtime invariants

- Agents bind `127.0.0.1` and accept only hook traffic there. Phones connect through
  relays with pinned agent keys and Noise IK; never restore plaintext/direct access.
- Use `childEnv()` for agent-spawned processes; no child may inherit `PERCH_` secrets.
- Keep `KillMode=process` in the agent service so restarting it preserves workspaces.
- Never use broad process kills or kill the ambient tmux server. Inspect processes
  and target exact PIDs or session ids. Tests that destroy a tmux server must use an
  explicit sandbox socket (`tmux -S <sandbox>`), and unset `TMUX` for launcher calls.
- Keep optional protocol additions backward-compatible. Add new `Workspace` fields
  to the zod schema too and test parsing: type equality misses optional-field drift.
- Preserve base64 → bytes → UTF-8 decoding, connection-id routing, and an explicit
  workspace `list` after authentication on every reconnect.
- Deploy Cloudflare only through `deploy/relay-cf-deploy.sh` and its runbook; production
  requires clean, up-to-date main. Use a local relay for ordinary development and
  never start a second agent against production with the same identity.
- Codex hook support already exists in `install-hooks`. Its observed pane attribution
  requires `--no-daemon`; hook changes require installation on each machine and user
  trust in `/hooks`. Do not install or reconfigure runtime hooks just to edit docs.
- Codex session ids must never be stored as Claude session ids. Parking currently
  resumes with `claude --resume`, so Codex workspaces are not parkable.
