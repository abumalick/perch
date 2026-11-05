# Deploying Tarfa (macOS and Linux agents, a phone client)

Tarfa runs an **agent** on each machine and a **PWA**, Tarfa, that your phone installs from
tarfa.app. Each agent listens on a loopback **phone port** (`TARFA_PHONE_PORT`, default 8797)
that its operator publishes (`tailscale serve`, Funnel or a proxy; see "The phone port" below),
and the PWA connects there directly, end to end encrypted with a device key (a Noise IK session
pinned to the agent's key). Both listeners bind `127.0.0.1` only: the hooks endpoint
(`TARFA_PORT`) and the phone port.

## 0. Prerequisites (every machine)
- A machine published with `tailscale serve` or Funnel, and the machine hosting the staging PWA (step 5), need Tailscale with MagicDNS + HTTPS enabled in the tailnet admin (`https://login.tailscale.com/admin/dns`). An agent published another way (a reverse proxy) needs no Tailscale.
- `tmux`, and the toolchain via mise: `mise trust` (the config isn't trusted on a fresh clone), then `mise install`, then `mise exec -- pnpm install` (the postinstall fixes node-pty's `spawn-helper` perms — works on macOS and Linux).
- Clone the repo on each machine that runs an agent (`deploy/agent.env` is per-machine and gitignored).
- Verify node-pty: `mise exec -- pnpm --filter @tarfa/cli test` should pass (real tmux/node-pty). On Ubuntu, `node-pty` prebuilds + the spawn-helper postinstall work without extra build tools.
- `deploy/run-agent.sh` and `run-pwa.sh` self-locate `mise`, so launchd/systemd units don't need mise on their PATH.

## In one command: `tarfa setup`
Steps 1, 2 and 4 below, plus a Tailscale address for phones, are one non-interactive command
run from the checkout (`pnpm tarfa setup --help` lists every flag and the Tailscale primer):
```sh
pnpm tarfa setup --machine-id dev --project-roots ~/workspace --default-path ~/workspace \
  --tailscale funnel --slug me --pair            # add --dry-run first to see the plan
```
It writes `deploy/agent.env` (backed up first, `600`; a `TARFA_TOKEN` only if there is none),
creates the agent key, writes `~/.tarfa/devices.json` with token enrolment **off** before the
service first starts (a missing roster would let the token enrol phones on a public port),
installs the systemd user unit with linger or the launchd agent, runs `install-hooks`, adds one
`tailscale serve` (or `funnel`) handler for the phone port, restarts the agent only if anything
changed and checks the phone port answers. On a machine whose existing roster has token
enrolment on, a run that leaves phones an address (new, or already in `agent.env`) refuses until `--token-enrolment off` switches it
off or `--token-enrolment on` keeps it deliberately. Rerun with the same flags, it changes nothing. It
never replaces an agent key, a token, an installed unit that already runs this checkout's
`deploy/run-agent.sh` with `KillMode=process`, or a `tailscale serve` entry pointing elsewhere.
An existing `TARFA_PWA_ORIGIN` is kept unless `--pwa` names another (the default is
`https://tarfa.app`). Where Tailscale needs root, it prints `sudo tailscale set --operator=$USER`
and exits 1. The address it derives, `wss://<node>.<tailnet>.ts.net:<port>/<slug>`, goes first in
`TARFA_PHONE_ADDRESSES`, then any `--address`; `tarfa pair` then mints links with all of them, in
order.

### A machine set up as Perch
Update the checkout (`git pull`, `pnpm install --frozen-lockfile`, `deploy/install-cli.sh`), then
run `tarfa setup` with the machine's usual flags. It stops `perch-agent` (launchd:
`com.perch.agent`; tmux and every workspace keep running), moves `~/.perch` to `~/.tarfa` (keeping
`~/.perch` as a link to it, and the agent key as `agent-key.json`), renames `deploy/agent.env`'s
`PERCH_*` lines to `TARFA_*` (the token is kept), installs and starts `tarfa-agent`
(`app.tarfa.agent`, with the old unit's drop-ins copied over), reinstalls the hooks as `tarfa-hook.sh`/`tarfa-guard.sh`, and removes the old
unit last. A Codex user then trusts the new hooks in Codex's `/hooks`. An agent merely restarted
under its old unit moves `~/.perch` and re-tags the workspaces' tmux options itself, so the
workspaces, their status, parents and Codex threads, and every paired phone carry over either way.
On macOS, check that `launchctl bootout` of the old label leaves the tmux server running before
relying on it.

Several agents on one node share a Tailscale port under their own `--slug`, each with its own
`--phone-port` (`setup` refuses a phone port another process holds). The node has one Tailscale
operator, so a second Linux user runs
`tarfa setup … --phone-port 8798 --tailscale none --slug <name> --address wss://<node>.<tailnet>.ts.net/<name>`,
which prints the `tailscale serve --bg --https=443 --set-path=/<name> http://127.0.0.1:8798`
line for the operator. The line's port is `--tailscale-port`, else the port of the first
`--address` under `/<name>`, else 443; it reads `tailscale funnel` instead when the serve config
shows that port already on Funnel, since `tailscale serve` there would take the port off Funnel
for every agent on it; for the same reason `--tailscale serve` on a port already on Funnel adds
its handler with `tailscale funnel`. Run through `sudo -u <user>`, setup needs `XDG_RUNTIME_DIR=/run/user/<uid>`
to reach that user's systemd manager, and stops without it rather than reinstall a working unit.
`tailscale serve` replaces whatever `x-forwarded-for` a client sends with
the tailnet peer's address, so the per-address caps see the real client.

## 1. Configure each agent
```sh
install -m 600 deploy/agent.env.example deploy/agent.env
# edit deploy/agent.env: set TARFA_TOKEN (openssl rand -hex 32 — a strong random value, one per machine),
# TARFA_MACHINE_ID (unique: "mac"/"mini"), TARFA_PROJECT_ROOTS (e.g. ~/workspace), keep TARFA_PORT=8787
```
> The token enrols a phone entry added by hand that carries it, while token enrolment is on
> (`tarfa devices enrolment`). The local hooks use their own secret, which the agent writes to
> `~/.tarfa/token` at each start. A phone paired with `tarfa pair`
> holds no token: its enrolled device key is its credential. Use a strong random value either way.
>
> `deploy/agent.env` must be readable by you alone: the agent refuses to start while another user
> can read or change it (it holds the token, which enrols a phone), and says so naming the fix,
> `chmod 600 deploy/agent.env`. A plain `cp` of the example keeps the checkout's mode, which on
> most systems is readable by everyone; `install -m 600` does not.
>
> Several agents can share one machine, one per Linux user, each with its own `TARFA_PORT` and
> `TARFA_MACHINE_ID`: `docs/SETUP-MACHINE.md`, step 13.

## 2. Run the agent as a service
> Run these from the repo root (the `$(pwd)` substitution bakes in the absolute repo path).
> Run `mise trust` first on BOTH platforms — `run-agent.sh` calls `mise exec`, and a service
> context won't have an interactive trust, so an untrusted config makes the unit crash-loop.

**macOS:**
```sh
mise trust
sed "s#REPO_PATH#$(pwd)#g" deploy/app.tarfa.agent.plist > ~/Library/LaunchAgents/app.tarfa.agent.plist
launchctl load ~/Library/LaunchAgents/app.tarfa.agent.plist
# logs: tail -f deploy/agent.err.log
```
**Linux (systemd):**
```sh
mkdir -p ~/.config/systemd/user
sed "s#REPO_PATH#$(pwd)#g" deploy/tarfa-agent.service > ~/.config/systemd/user/tarfa-agent.service
systemctl --user daemon-reload
systemctl --user enable --now tarfa-agent
loginctl enable-linger "$USER"   # keep the user service running without an active login
# logs: journalctl --user -u tarfa-agent -f
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
systemctl --user restart tarfa-agent
```

Confirm: `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8787/hooks` prints `401` (server up, auth enforced). A plain `GET /hooks` returns `404` — only `POST /hooks` reaches the auth check, so the liveness probe must use `-X POST`.

## 3. Publish the phone port and pair a phone
`tarfa setup --tailscale serve|funnel` does this; by hand, publish the phone port and tell the
agent where phones reach it:
```sh
tailscale serve --bg --https=10000 --set-path=/me http://127.0.0.1:8797   # or `tailscale funnel`
# deploy/agent.env: TARFA_PHONE_ADDRESSES=wss://<node>.<tailnet>.ts.net:10000/me
pnpm tarfa pair [--pwa https://<where phones open the app>]
```
`tarfa pair` prints a one-time pairing QR code and link (ten minutes, one phone) with every
address in `TARFA_PHONE_ADDRESSES`. The link names the origin phones open the app at,
`TARFA_PWA_ORIGIN` (default `https://tarfa.app`). Set `TARFA_DEFAULT_PATH` (an absolute path) and
the link hands it to the phone as the new entry's default path; a re-scan fills it only on an
entry that has none. `TARFA_RELAY_URLS` from an older setup is ignored with a warning at
startup; remove it.

**Moving a machine off relays.** An agent updated past the relays' removal no longer dials
them, so a machine phones reached only through a relay is cut off until it is moved: run
`tarfa setup` with `--tailscale serve|funnel` (or `--address` for a proxy), remove
`TARFA_RELAY_URLS` from `deploy/agent.env`, then send each phone a fresh `tarfa pair` link. The
entry, known by its agent key, takes the new addresses; its device key stays enrolled. Update the
agent before phones use a current app: an older agent refuses a new phone's hello ("too old to
pair"). A self-hosted app built before the change must be redeployed too, and the old relay
services stopped by hand (their scripts are gone).

The hooks port is never exposed with `tailscale serve`. A machine set up long ago may
still publish its agent (`tailscale serve status` shows `:8442 -> 127.0.0.1:8787`): remove it
with `tailscale serve --https=8442 off` (`sudo` on Linux).

### The phone port
The agent logs `tarfa agent: phones on 127.0.0.1:<port>` at startup. The port takes a WebSocket
upgrade on any path (`tailscale serve --set-path` strips its prefix) and answers anything else
404, so `/hooks`, `/unpark` and `/message` are never one proxy away from the network. It is meant to sit behind
`tailscale serve` or Funnel; the only port to publish is `TARFA_PHONE_PORT`, never `TARFA_PORT`.
A phone there goes through the agent's device roster, revocation and pairing codes. Its bounds:
8 unauthenticated sockets per client
address and 32 in all (the oldest is closed when full), 20 new sockets a minute per address, a
ping every 30 s, 64 KiB frames, and at most 4 roster or pairing-file reads at once and 10 a minute
for keys that are not enrolled. The client address is the last hop of `x-forwarded-for` from the
local proxy. Refusals arrive in band (`4429`). Several agents on one machine need distinct
phone ports; if the port is taken, the agent logs `no phone port` and keeps serving its hooks.
Check it with an upgrade (`101`) and a plain request (`404`):
```sh
curl -si --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" http://127.0.0.1:8797/x | head -1
curl -si http://127.0.0.1:8797/hooks | head -1
```

## 4. Wire Claude Code hooks (each machine)
The agent writes its token to `~/.tarfa/token` on startup (mode 600); the hook reads it.
```sh
TARFA_MACHINE_ID=$(grep TARFA_MACHINE_ID deploy/agent.env | cut -d= -f2) \
TARFA_PORT=8787 \
pnpm --filter @tarfa/cli exec tsx src/cli.ts install-hooks
# merges UserPromptSubmit/PreToolUse/PostToolUse/Notification/Stop hooks into ~/.claude/settings.json
```

It also registers a second `PreToolUse` hook on `Bash`, `~/.tarfa/tarfa-guard.sh`, which refuses
`pkill`, `killall`, `kill -1`, `xargs kill`, `kill $(pgrep …)` and an unscoped
`tmux kill-server`/`kill-session -a` run from inside a workspace. The tmux server, the agent and
every session run as one user, so one pattern kill ends them all. It also refuses a raw socket client
(`nc -U`, `socat`, `curl --unix-socket`) aimed at another session's message socket, and setting
`@tarfa_parent` or `@tarfa_codex_thread` by hand (docs/MESSAGING.md).

Where Codex is installed (`~/.codex` exists), the same command also merges
UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/Stop hooks into `~/.codex/hooks.json`.
Codex runs none of them until they are trusted: open Codex, run `/hooks` and trust them. Trust
is keyed on a hash of each hook, so re-trust after re-running `install-hooks` changes them.

Codex statuses only work for a Codex started with `--no-daemon`, which the create form adds. By
default Codex runs its hooks in a shared background daemon, outside the workspace's pane, and
the hook cannot tell which workspace they belong to, so it reports nothing for them.

Same idea, same per-machine cadence: link the `tarfa-spawn` and `tarfa-orchestrate` skills
into the global skills directory so a workspace on any project can launch and follow further
workspaces. They live in the repo (so they stay in step with the CLI they call) and are
symlinked rather than copied, so `git pull` updates them. Both use the `tarfa` CLI, so install
it too (next section).
```sh
ln -sfn "$(pwd)/.claude/skills/tarfa-spawn" ~/.claude/skills/tarfa-spawn
ln -sfn "$(pwd)/.claude/skills/tarfa-orchestrate" ~/.claude/skills/tarfa-orchestrate
```

### Tarfa CLI (each machine)
Put `tarfa` on PATH, from the main checkout:
```sh
deploy/install-cli.sh   # links ~/.local/bin/tarfa to deploy/tarfa-cli.sh (and perch to tarfa); safe to re-run
```
The link follows the checkout, so a `git pull` updates the CLI. The shim finds the checkout's
node through mise and runs `packages/agent/src/cli.ts` from the caller's directory. It refuses
to replace a `~/.local/bin/tarfa` or `~/.local/bin/perch` that is not a symlink. Every subcommand works through it (`tarfa
pair`, `tarfa devices`, …). These three need no `deploy/agent.env`, so a session in any repo can
use them:
- `tarfa spawn [--title <title>] [--child] [--model <model>] <projectPath>`, with the brief on stdin:
  starts a workspace running Claude Code on the brief and prints its id (also its Claude session
  name). `--child` makes the caller's own workspace its orchestrator. The child records the
  parent's workspace id, cannot ask the user or enter plan mode, and reports back with SendMessage.
- `tarfa ls [--json] [--mine] [--parent <workspace id>] [--role orchestrator|child|normal] [--path <dir>]`:
  every workspace, parked ones included, with its messaging name, stored status, time in that
  status, role, parent, title and folder. The role comes from the `--child` links: a workspace with
  a listed child is an orchestrator (even if it is a child too), one with a parent is a child, the
  rest are normal. `--mine` lists the caller's children, `--role` one role, and `--path` the
  workspaces whose folder is that directory or under it (relative to the caller, so `--path .`
  means "this project", worktrees included). Filters combine.
- `tarfa peek <workspace id> [-n <lines>]`: its status line and the last 40 (or N) non-blank lines
  of its pane.

`tarfa unpark <workspace id>...` reopens parked workspaces, one line per id, exactly as opening
one on the phone does. It asks the running agent over its loopback listener (`TARFA_PORT` from
`deploy/agent.env`, the hooks secret in `~/.tarfa/token`), so it needs the agent running.

## 5. The PWA: tarfa.app, and the tailnet staging copy
Tarfa is a static-assets Worker (`packages/pwa/wrangler.jsonc`) in the maintainer's Cloudflare
account, on the `tarfa.app` custom domain. Deploy it only with the script, from a clean main that
matches origin:
```sh
cp deploy/pwa-deploy.env.example deploy/pwa-deploy.env   # once, in the main checkout: CLOUDFLARE_ACCOUNT_ID
deploy/pwa-deploy.sh             # frozen install, build, deploy, then waits until tarfa.app serves this build
deploy/pwa-deploy.sh --dry-run   # build and check only, from any checkout
```
To test a worktree's PWA on a phone from a public origin, `deploy/pwa-deploy.sh --dev` deploys it
to a throwaway `tarfa-dev` Worker on workers.dev and prints its URL (its header shows a
`tarfa-dev` badge); mint a link for it with `pnpm tarfa pair --pwa <that URL>`, and remove it with
`deploy/pwa-deploy.sh --dev --delete` when done. Another Cloudflare account serves its own copy the
same way with `--env-file <its file>`.

The tailnet copy below is the **staging PWA**, which `pnpm serve:build` points at a worktree
(the always-on Linux machine only). It is a separate origin, so phones install and pair it
separately:
```sh
sed "s#REPO_PATH#$(pwd)#g" deploy/tarfa-pwa.service > ~/.config/systemd/user/tarfa-pwa.service
systemctl --user daemon-reload
systemctl --user enable --now tarfa-pwa     # builds dist/ then serves on 127.0.0.1:4173
sudo tailscale serve --bg --https=8443 4173  # Linux: sudo; ≥1.64 syntax
tailscale serve status   # shows https://mini.<tailnet>.ts.net:8443/ -> 127.0.0.1:4173
```
Staging PWA URL: `https://mini.<tailnet>.ts.net:8443/`.

## 6. Install on the phone
1. Open `https://tarfa.app/` in Safari on an iPhone (or Chrome on Android). Tailscale on the phone
   is needed only for machines published with `tailscale serve` alone; a Funneled machine is
   reached without it.
2. Share → **Add to Home Screen**. Launch Tarfa from the home screen (standalone).
3. Pair each machine: on the machine, `pnpm tarfa pair` prints a QR code; in Tarfa, **Settings → Scan QR code**.
   Nothing is typed on the phone. On Android, Chrome asks once to find devices on the local
   network the first time it opens a tailnet address: allow it.

## 7. On-device smoke test
1. On a machine: `pnpm --filter @tarfa/cli exec tsx src/cli.ts create ~/workspace/SOME_PROJECT bash` (or create from the phone).
2. Phone list shows the workspace under the right machine with a green status dot.
3. Tap it → the terminal streams; type `echo hi` → see `hi`.
4. In a workspace run `claude`; when it finishes a turn or asks for input, the row bubbles up with "Needs you". ("Finished" is a manual status you set from the status picker — no hook sets it.)
5. Open the same workspace on a second device → the first shows "Opened on another device".
6. Close from the phone → the workspace disappears from the list.

## 8. Troubleshooting
- **`/hooks` 401 from the local hook:** the agent hasn't written `~/.tarfa/token` yet (start the agent first) or the hook ran before startup. The file holds a hooks-only secret the agent replaces at each start, not `TARFA_TOKEN`.
- **node-pty `posix_spawnp failed` on Ubuntu:** re-run `pnpm install` (root postinstall chmods `spawn-helper`); confirm `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-*/spawn-helper` is `+x`.
- **The phone does not connect:** the entry's message in Settings names the refusal (an agent refusal: revoked, not enrolled, a spent or expired pairing code, the wrong agent key). Check the agent logs `phones on 127.0.0.1:<port>`, that the publishing entry points at that port (`tailscale serve status`), and that the phone reaches the address (a tailnet address needs the phone's Tailscale connected; a Funnel one does not).
- **An old direct entry in Settings** ("no longer supported"): delete it and pair the machine again.
- **PWA loads but no workspaces:** watch the agent log (`journalctl --user -u tarfa-agent -f` / `tail -f deploy/agent.log`) for `phone:` lines.
- **Port already in use:** change `TARFA_PORT` in `deploy/agent.env`, then re-run `install-hooks` (step 4), which bakes the port into the hook command.
- **`pnpm: command not found` from the service:** the launchd/systemd PATH may not include your pnpm (e.g. mise shims). Verify `which pnpm` in your normal shell; if it's under `~/.local/share/mise` or similar, either add that dir to the plist `PATH`/systemd `Environment=PATH=...`, or edit `deploy/run-agent.sh` to call pnpm by absolute path.
