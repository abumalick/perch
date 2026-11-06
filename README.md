# Tarfa

> **A personal project, actively maintained.** Its author uses it every day and keeps
> shipping updates. Issues and pull requests are welcome, within the bar set under
> [Contributing](#contributing).

Tarfa is a mobile-first PWA for watching and driving [Claude Code](https://claude.com/claude-code)
sessions running in tmux on several machines, from a phone, over an end-to-end encrypted
connection to each machine. Its app is published as Tarfa, at tarfa.app.

It is shaped around one person's machines and habits, so expect to adapt it to your own
setup; `docs/SETUP-MACHINE.md` walks through running it on a machine of your own.

## How it works

- An **agent** (`packages/agent`, Node) runs on each machine. It manages tmux sessions
  ("workspaces"), streams their terminals through `node-pty`, and receives Claude Code hook
  events on a loopback `POST /hooks` to know whether a session is working or waiting for you.
  Phones reach it on a loopback **phone port**, which its operator publishes with
  `tailscale serve`, Tailscale Funnel or a reverse proxy (`tarfa setup` does the Tailscale part).
- The **PWA** (`packages/pwa`, Svelte 5 + xterm.js) connects to every agent directly, in a
  Noise session (`packages/secure-channel`) pinned to the agent's key and keyed by the phone's
  own device key, so whatever publishes the port forwards ciphertext only. A phone is added by scanning a QR code the machine prints. It lists
  the workspaces sorted by who needs attention, and opens a full terminal with a
  touch-friendly keyboard bar.
- `packages/contracts` holds the shared zod wire protocol.
- The maintainer serves the PWA at tarfa.app; anyone who would rather trust themselves serves
  their own copy (`deploy/pwa-deploy.sh --env-file`, or any static host).

The code follows a hexagonal layout (pure core, ports, adapters) and is mostly unit-tested
against fakes, with a Playwright e2e suite driving the PWA against a fake agent.

## Where to look

- `docs/SETUP-MACHINE.md` — setting up your own machine end to end: preparing Ubuntu, the
  agent, publishing it with Tailscale, the app (tarfa.app or your own), pairing your phone, a second Linux
  user with its own agent on the same machine, and the pitfalls.
- `docs/DEPLOY.md` — running agents as services, `tarfa setup`, the phone port, pairing,
  hosting the PWA, installing Claude Code hooks.
- `docs/WORKTREES.md` — the git-worktree workflow used for development.
- `docs/BROWSER.md` — naming agent-browser sessions so Tarfa's browser view attaches them
  to a workspace.
- `CLAUDE.md` and `.claude/skills/` — the instructions the project was built with, using
  Claude Code as the main developer. The "Gotchas already fixed" section records the
  non-obvious lessons (iOS WebKit, Android IMEs, tmux, reconnect handling).

## Security

A paired phone's device key, and an agent's bearer token, are each equivalent to a shell on
that machine: creating a workspace and sending terminal input run arbitrary commands as the
user the agent runs as. The agent listens only on loopback, for its hooks and its phone port;
whatever publishes the phone port sees only ciphertext, and the agent checks every phone's key
itself against its own roster (`tarfa devices`). A Funnel address is public: the agent bounds
unauthenticated sockets, and only an enrolled key or a live pairing code gets past the
handshake. Use a strong random token per machine, and keep
enrolment by token off once your phones are paired (`tarfa devices enrolment off`).

## Development

Toolchain is pinned with [mise](https://mise.jdx.dev) (Node, pnpm, gitleaks); the package
manager is pnpm.

```bash
mise install
pnpm install
pnpm -s test                       # unit tests, all packages
pnpm --filter @tarfa/pwa build
pnpm --filter @tarfa/pwa exec playwright install webkit
E2E_PORT=4175 pnpm --filter @tarfa/pwa e2e
```

## Contributing

Issues and pull requests are welcome, as long as they are high quality. Anything that falls
short is closed without review.

- **An issue** says what happened, what you expected, and how to reproduce it: the machine and
  OS, the phone and browser, and the steps. A report nobody can reproduce cannot be fixed.
- **A pull request** is complete and working: it does one thing, comes with tests, and passes
  the whole suite and the e2e (`pnpm -s test`, then the Playwright run above). It follows
  `CLAUDE.md`, which is the project's coding guide. A change you have not run yourself is
  not ready.
- **Work done with a coding agent must come from a frontier model**: Claude Opus or an
  equivalent. Tarfa itself is built this way, with `CLAUDE.md` as the agent's instructions.
  Output from weaker models is easy to spot and will be closed.

## License

[MIT](LICENSE)
