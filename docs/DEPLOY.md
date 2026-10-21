# Deploying Perch (macOS and Linux agents, a phone client, through a relay)

Perch runs an **agent** on each machine and a **PWA** that your phone installs. A phone never
connects to an agent directly: each agent dials out to one or more **relays** and the phone
reaches it through them, end to end encrypted with a device key
([relay runbook](relay-cf-runbook.md)). An agent listens on no phone-facing port; its only
listener is the Claude Code hooks endpoint on `127.0.0.1`.

## 0. Prerequisites (every machine)
- A relay to connect to: the Cloudflare Worker or a self-hosted relay (runbook, "Choose your relay host").
- The machine hosting the PWA (step 5) needs Tailscale with MagicDNS + HTTPS enabled in the tailnet admin (`https://login.tailscale.com/admin/dns`), since the PWA is served on the tailnet. So does any machine publishing a self-hosted relay there. An agent itself needs no Tailscale.
- `tmux`, and the toolchain via mise: `mise trust` (the config isn't trusted on a fresh clone), then `mise install`, then `mise exec -- pnpm install` (the postinstall fixes node-pty's `spawn-helper` perms — works on macOS and Linux).
- Clone the repo on each machine that runs an agent (`deploy/agent.env` is per-machine and gitignored).
- Verify node-pty: `mise exec -- pnpm --filter @perch/agent test` should pass (real tmux/node-pty). On Ubuntu, `node-pty` prebuilds + the spawn-helper postinstall work without extra build tools.
- `deploy/run-agent.sh` and `run-pwa.sh` self-locate `mise`, so launchd/systemd units don't need mise on their PATH.

## 1. Configure each agent
```sh
install -m 600 deploy/agent.env.example deploy/agent.env
# edit deploy/agent.env: set PERCH_TOKEN (openssl rand -hex 32 — a strong random value, one per machine),
# PERCH_MACHINE_ID (unique: "mac"/"mini"), PERCH_PROJECT_ROOTS (e.g. ~/workspace), keep PERCH_PORT=8787
```
> The token enrols the relay entries added by hand that carry it (runbook, "Adding the relay
> machine on the phone by hand"). The local hooks use their own secret, which the agent writes to
> `~/.perch/token` at each start. A phone paired with `perch pair`
> holds no token: its enrolled device key is its credential. Use a strong random value either way.
>
> `deploy/agent.env` must be readable by you alone: the agent refuses to start while another user
> can read or change it (it holds the token, which enrols a phone), and says so naming the fix,
> `chmod 600 deploy/agent.env`. A plain `cp` of the example keeps the checkout's mode, which on
> most systems is readable by everyone; `install -m 600` does not. `deploy/relay-cf.env`, which
> holds a Cloudflare relay's join and admin keys, is held to the same rule by
> `deploy/relay-cf-deploy.sh`.

## 2. Run the agent as a service
> Run these from the repo root (the `$(pwd)` substitution bakes in the absolute repo path).
> Run `mise trust` first on BOTH platforms — `run-agent.sh` calls `mise exec`, and a service
> context won't have an interactive trust, so an untrusted config makes the unit crash-loop.

**macOS:**
```sh
mise trust
sed "s#REPO_PATH#$(pwd)#g" deploy/com.perch.agent.plist > ~/Library/LaunchAgents/com.perch.agent.plist
launchctl load ~/Library/LaunchAgents/com.perch.agent.plist
# logs: tail -f deploy/agent.err.log
```
**Linux (systemd):**
```sh
mkdir -p ~/.config/systemd/user
sed "s#REPO_PATH#$(pwd)#g" deploy/perch-agent.service > ~/.config/systemd/user/perch-agent.service
systemctl --user daemon-reload
systemctl --user enable --now perch-agent
loginctl enable-linger "$USER"   # keep the user service running without an active login
# logs: journalctl --user -u perch-agent -f
```
**The agent's PATH is the one every workspace starts with.** A workspace command runs through a
non-interactive shell, which reads no profile, so `claude` must be on the PATH systemd gives user
services. Claude Code's installer puts it in `~/.local/bin`, which that PATH lacks on a stock
Ubuntu with bash: the pane exits with status 127 at once and the phone reports "No session". (A
zsh login sets PATH in `~/.zshenv`, which every zsh reads, so it never shows there.) Give user
services the tools in a file that sorts after `/usr/lib/environment.d/99-environment.conf`, which
sets PATH from `/etc/environment` and would override an earlier one:
```sh
mkdir -p ~/.config/environment.d
echo 'PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:${PATH}' > ~/.config/environment.d/999-user-path.conf
systemctl --user daemon-reload && systemctl --user show-environment | grep ^PATH=
systemctl --user restart perch-agent
```

Confirm: `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8787/hooks` prints `401` (server up, auth enforced). A plain `GET /hooks` returns `404` — only `POST /hooks` reaches the auth check, so the liveness probe must use `-X POST`.

## 3. Connect each agent to a relay
From each machine's checkout, with the command the relay's operator prints (runbook,
"Connecting a machine and pairing a phone"):
```sh
PERCH_JOIN_KEY=<join key> pnpm perch connect wss://<relay> [--pwa https://<where phones open Perch>]
```
The key goes in the environment rather than `--key`, which the process list and the shell history
would show. It registers the machine with the relay, adds the relay to `PERCH_RELAY_URLS` in
`deploy/agent.env` (after a backup), restarts the agent and prints a pairing QR code and link. The
link needs the origin phones open Perch at: pass `--pwa` the first time (it is saved as
`PERCH_PWA_ORIGIN` in `deploy/agent.env`), or set `PERCH_PWA_ORIGIN` there beforehand. Set
`PERCH_DEFAULT_PATH` there too (an absolute path) and the link hands it to the phone as the new
entry's default path; a re-scan fills it only on an entry that has none. Without
one, `connect` still joins and says so, and `perch pair --pwa <origin>` prints the link later. Run it once
per relay the machine should hold. `journalctl --user -u perch-agent | grep 'socket open'` (or
`deploy/agent.log` on macOS) then shows one `relay control socket open (<url>)` line per relay.

Nothing is exposed with `tailscale serve` for the agent. A machine set up before the relay may
still publish its agent (`tailscale serve status` shows `:8442 -> 127.0.0.1:8787`): remove it
with `tailscale serve --https=8442 off` (`sudo` on Linux).

## 4. Wire Claude Code hooks (each machine)
The agent writes its token to `~/.perch/token` on startup (mode 600); the hook reads it.
```sh
PERCH_MACHINE_ID=$(grep PERCH_MACHINE_ID deploy/agent.env | cut -d= -f2) \
PERCH_PORT=8787 \
pnpm --filter @perch/agent exec tsx src/cli.ts install-hooks
# merges UserPromptSubmit/PreToolUse/PostToolUse/Notification/Stop hooks into ~/.claude/settings.json
```

It also registers a second `PreToolUse` hook on `Bash`, `~/.perch/perch-guard.sh`, which refuses
`pkill`, `killall`, `kill -1`, `xargs kill`, `kill $(pgrep …)` and an unscoped
`tmux kill-server`/`kill-session -a` run from inside a workspace. The tmux server, the agent and
every session run as one user, so one pattern kill ends them all.

Where Codex is installed (`~/.codex` exists), the same command also merges
UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/Stop hooks into `~/.codex/hooks.json`.
Codex runs none of them until they are trusted: open Codex, run `/hooks` and trust them. Trust
is keyed on a hash of each hook, so re-trust after re-running `install-hooks` changes them.

Codex statuses only work for a Codex started with `--no-daemon`, which the create form adds. By
default Codex runs its hooks in a shared background daemon, outside the workspace's pane, and
the hook cannot tell which workspace they belong to, so it reports nothing for them.

Same idea, same per-machine cadence: link the `perch-spawn` skill into the global
skills directory so a workspace on any project can launch further workspaces. It
lives in the repo (so it stays in step with the tmux session convention it depends
on) and is symlinked rather than copied, so `git pull` updates it.
```sh
ln -sfn "$(pwd)/.claude/skills/perch-spawn" ~/.claude/skills/perch-spawn
```

## 5. Host the PWA (the always-on Linux machine only)
```sh
sed "s#REPO_PATH#$(pwd)#g" deploy/perch-pwa.service > ~/.config/systemd/user/perch-pwa.service
systemctl --user daemon-reload
systemctl --user enable --now perch-pwa     # builds dist/ then serves on 127.0.0.1:4173
sudo tailscale serve --bg --https=8443 4173  # Linux: sudo; ≥1.64 syntax
tailscale serve status   # shows https://mini.<tailnet>.ts.net:8443/ -> 127.0.0.1:4173
```
PWA URL: `https://mini.<tailnet>.ts.net:8443/`.

## 6. Install on the phone
1. Install the Tailscale app, log into the same tailnet, ensure it's connected (the PWA is served on the tailnet).
2. Open `https://mini.<tailnet>.ts.net:8443/` in Safari on an iPhone (the tailnet cert is publicly valid — no manual trust needed).
3. Share → **Add to Home Screen**. Launch Perch from the home screen (standalone).
4. Pair each machine: on the machine, `pnpm perch pair` prints a QR code; in Perch, **Settings → Scan QR code**
   (runbook, "Connecting a machine and pairing a phone"). Nothing is typed on the phone.

## 7. On-device smoke test
1. On a machine: `pnpm --filter @perch/agent exec tsx src/cli.ts create ~/workspace/SOME_PROJECT bash` (or create from the phone).
2. Phone list shows the workspace under the right machine with a green status dot.
3. Tap it → the terminal streams; type `echo hi` → see `hi`.
4. In a workspace run `claude`; when it finishes a turn or asks for input, the row bubbles up with "Needs you". ("Finished" is a manual status you set from the status picker — no hook sets it.)
5. Open the same workspace on a second device → the first shows "Opened on another device".
6. Close from the phone → the workspace disappears from the list.

## 8. Troubleshooting
- **`/hooks` 401 from the local hook:** the agent hasn't written `~/.perch/token` yet (start the agent first) or the hook ran before startup. The file holds a hooks-only secret the agent replaces at each start, not `PERCH_TOKEN`.
- **node-pty `posix_spawnp failed` on Ubuntu:** re-run `pnpm install` (root postinstall chmods `spawn-helper`); confirm `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-*/spawn-helper` is `+x`.
- **The phone does not connect:** the entry's message in Settings names the refusal (runbook, "How a refusal reaches the phone"). Check the agent holds the relay (`relay control socket open` in its log) and that the phone reaches the relay (a self-hosted relay on the tailnet needs the phone's Tailscale connected).
- **An old direct entry in Settings** ("no longer supported"): delete it and pair the machine again.
- **PWA loads but no workspaces:** watch the agent log (`journalctl --user -u perch-agent -f` / `tail -f deploy/agent.log`) for `relay client:` lines.
- **Port already in use:** change `PERCH_PORT` in `deploy/agent.env`, then re-run `install-hooks` (step 4), which bakes the port into the hook command.
- **`pnpm: command not found` from the service:** the launchd/systemd PATH may not include your pnpm (e.g. mise shims). Verify `which pnpm` in your normal shell; if it's under `~/.local/share/mise` or similar, either add that dir to the plist `PATH`/systemd `Environment=PATH=...`, or edit `deploy/run-agent.sh` to call pnpm by absolute path.
