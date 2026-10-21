# Perch

> **A personal project, shared as a reference.** It is not maintained, there is no
> support, and issues and pull requests are not accepted. Fork it and make it yours.

Perch is a mobile-first PWA for watching and driving [Claude Code](https://claude.com/claude-code)
sessions running in tmux on several machines, from a phone, through an end-to-end encrypted
relay.

It is shared so that you can see how such a tool can be built and adapt the ideas to your
own setup, not as a product to install as-is. It is shaped around one person's machines and
habits.

## How it works

- An **agent** (`packages/agent`, Node) runs on each machine. It manages tmux sessions
  ("workspaces"), streams their terminals through `node-pty`, and receives Claude Code hook
  events on a loopback `POST /hooks` to know whether a session is working or waiting for you.
  It listens on no phone-facing port: it dials out to one or more **relays**
  (`packages/relay`, self-hosted in Node, or `packages/relay-cf` on Cloudflare Workers).
- The **PWA** (`packages/pwa`, Svelte 5 + xterm.js) reaches every agent through a relay, in a
  Noise session (`packages/secure-channel`) keyed by the phone's own device key, so the relay
  forwards ciphertext only. A phone is added by scanning a QR code the machine prints. It lists
  the workspaces sorted by who needs attention, and opens a full terminal with a
  touch-friendly keyboard bar.
- `packages/contracts` holds the shared zod wire protocol.
- The maintainer serves the PWA and a self-hosted relay on a [Tailscale](https://tailscale.com)
  network; where to serve the PWA for someone without one is an open question.

The code follows a hexagonal layout (pure core, ports, adapters) and is mostly unit-tested
against fakes, with a Playwright e2e suite driving the PWA against a fake agent.

## Where to look

- `docs/SETUP-MACHINE.md` — setting up your own machine end to end: preparing Ubuntu, the
  agent, your relay and app on a free Cloudflare account, pairing your phone, and the pitfalls.
- `docs/DEPLOY.md` — running agents as services, connecting them to a relay, hosting the
  PWA, installing Claude Code hooks.
- `docs/relay-cf-runbook.md` — the relays, device keys, pairing and the threat model.
- `docs/WORKTREES.md` — the git-worktree workflow used for development.
- `docs/BROWSER.md` — naming agent-browser sessions so Perch's browser view attaches them
  to a workspace.
- `CLAUDE.md` and `.claude/skills/` — the instructions the project was built with, using
  Claude Code as the main developer. The "Gotchas already fixed" section records the
  non-obvious lessons (iOS WebKit, Android IMEs, tmux, reconnect handling).

## Security

A paired phone's device key, and an agent's bearer token, are each equivalent to a shell on
that machine: creating a workspace and sending terminal input run arbitrary commands as the
user the agent runs as. The agent listens only on loopback, for its hooks; phones reach it
through relays, which see only ciphertext, and the agent checks every phone's key itself
against its own roster (`perch devices`). Use a strong random token per machine, and keep
enrolment by token off once your phones are paired (`perch devices enrolment off`).

## Development

Toolchain is pinned with [mise](https://mise.jdx.dev) (Node, pnpm, gitleaks); the package
manager is pnpm.

```bash
mise install
pnpm install
pnpm -s test                       # unit tests, all packages
pnpm --filter @perch/pwa build
pnpm --filter @perch/pwa exec playwright install webkit
E2E_PORT=4175 pnpm --filter @perch/pwa e2e
```

## License

[MIT](LICENSE)
