# Set up your own Perch machine

This walks through one Ubuntu machine (a home server, a VPS, a spare PC) where Claude Code and
Codex run in tmux workspaces that you drive from your phone. Your phone reaches the machine
through your own relay on Cloudflare, end to end encrypted, and loads the Perch app from the same
Cloudflare account. You need:

- an Ubuntu machine you have sudo on (the steps were written on Ubuntu 26.04);
- a free Cloudflare account (no domain needed);
- a phone;
- your own fork of this repository.

Tailscale is optional: it is a convenient way to SSH into the machine and to preview web servers
from your phone (step 10), but Perch itself does not need it.

```
phone (Perch app, https://perch.<subdomain>.workers.dev)
   │  wss, Noise-encrypted end to end
   ▼
relay (Cloudflare Worker, wss://perch-relay.<subdomain>.workers.dev)
   ▲  the agent dials out; nothing on the machine listens for the phone
   │
Ubuntu machine: perch-agent (systemd user unit) ── tmux server ── claude / codex workspaces
```

This guide gives the commands in order; `docs/DEPLOY.md` and `docs/relay-cf-runbook.md` explain
them in depth and win wherever they disagree with this page. Placeholders: `<user>`, `<uid>`,
`<subdomain>` (your account's `workers.dev` subdomain), `<account-id>`, `<Area/City>`.

## 1. Prepare the machine (sudo, once)

```bash
sudo apt update
sudo apt install -y tmux git curl ripgrep fd-find unzip htop unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # security updates install themselves

sudo locale-gen en_US.UTF-8
sudo update-locale LANG=en_US.UTF-8
sudo timedatectl set-timezone <Area/City>

sudo loginctl enable-linger <user>
```

- **A UTF-8 locale** keeps tmux from replacing accents, Arabic or box drawing with `_` in what
  your phone shows.
- **Linger** keeps your user services (the agent, the tmux server) running when nobody is logged
  in, and starts them at boot.
- `node-pty` ships prebuilt binaries, so build tools are not required (`docs/DEPLOY.md`, step 0).

Check: `locale` (after a new login), `timedatectl`, `loginctl show-user <user> -p Linger`.

## 2. Keep one runaway job from freezing the machine

Several agents share one machine. A job that eats all the memory is not killed quickly: the
machine thrashes and stops answering, phone included. Cap your user's whole slice, and give big
jobs a smaller cap of their own.

```bash
sudo mkdir -p /etc/systemd/system/user@<uid>.service.d
sudo tee /etc/systemd/system/user@<uid>.service.d/50-memory.conf >/dev/null <<'EOF'
[Service]
# roughly 80% and 90% of physical memory
MemoryHigh=<e.g. 12G>
MemoryMax=<e.g. 14G>
EOF
sudo systemctl daemon-reload
```

`daemon-reload` applies the limits to the running unit. **Do not restart `user@<uid>.service`**:
that stops every user service and every workspace.

A `heavy` wrapper for builds and test suites, saved as `~/.local/bin/heavy` and made executable:

```bash
#!/usr/bin/env bash
exec systemd-run --user --scope -q -p MemoryMax="${HEAVY_MEM:-8G}" -p MemorySwapMax=2G "$@"
```

`heavy pnpm test`, `HEAVY_MEM=12G heavy uv run train.py`: a job past its cap is killed alone, in
under a second. Perch's home screen shows how much memory is left before the slowdown and before
the kill (`CLAUDE.md`, "Machine load strip").

## 3. Toolchain

As your user:

```bash
curl https://mise.run | sh                       # mise: runtimes and CLIs, in ~/.local/bin
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
exec bash
mise use -g node@24 pnpm@11 gh npm:@openai/codex

curl -LsSf https://astral.sh/uv/install.sh | sh  # uv, if you work in Python
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code, in ~/.local/bin/claude
```

Log in to Claude Code (`claude`) and Codex (`codex`) once, from a terminal on the machine.

Docs: [mise](https://mise.jdx.dev/getting-started.html),
[uv](https://docs.astral.sh/uv/getting-started/installation/),
[Claude Code setup](https://code.claude.com/docs/en/setup),
[Codex CLI](https://developers.openai.com/codex/cli).

## 4. Give user services your PATH (do not skip)

Each workspace command runs through a non-interactive shell that reads no profile, so it starts
with the PATH systemd gives user services. On stock Ubuntu that PATH lacks `~/.local/bin`, where
Claude Code lives: the workspace exits at once with status 127 and the phone shows **"No
session"**. `docs/DEPLOY.md` (step 2) has the fix:

```bash
mkdir -p ~/.config/environment.d
echo 'PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:${PATH}' > ~/.config/environment.d/999-user-path.conf
systemctl --user daemon-reload && systemctl --user show-environment | grep ^PATH=
```

The name must sort after `/usr/lib/environment.d/99-environment.conf`, which sets PATH from
`/etc/environment` and would override an earlier file.

## 5. Run tmux as its own service (recommended)

The agent unit already uses `KillMode=process`, so restarting the agent leaves tmux alone. A
tmux server of its own also keeps your workspaces independent of the agent entirely.

`~/.config/systemd/user/tmux-server.service`:

```ini
[Unit]
Description=tmux server

[Service]
ExecStart=/usr/bin/bash -lc 'exec /usr/bin/tmux -D'
Restart=always
RefuseManualStop=yes

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now tmux-server
```

Never run `tmux kill-server` on this machine: every workspace lives on that one server.
Workspaces do not come back after a reboot; a Claude conversation can be resumed with
`claude --resume` in a new workspace.

## 6. Install the agent

Details: `docs/DEPLOY.md`, steps 0 to 2 and 4.

```bash
mkdir -p ~/workspace && cd ~/workspace
git clone <your fork> perch && cd perch
mise trust && mise install && mise exec -- pnpm install

install -m 600 deploy/agent.env.example deploy/agent.env
openssl rand -hex 32        # → PERCH_TOKEN in deploy/agent.env
```

In `deploy/agent.env`, set `PERCH_TOKEN`, `PERCH_MACHINE_ID` (a short name for this machine),
`PERCH_PROJECT_ROOTS` (e.g. `/home/<user>/workspace`) and, optionally, `PERCH_DEFAULT_PATH`
(absolute). Keep `PERCH_PORT=8787`. The file must stay `600`: the agent refuses to start while
another user can read it.

```bash
mkdir -p ~/.config/systemd/user
sed "s#REPO_PATH#$(pwd)#g" deploy/perch-agent.service > ~/.config/systemd/user/perch-agent.service
mkdir -p ~/.config/systemd/user/perch-agent.service.d
printf '[Unit]\nAfter=tmux-server.service\nWants=tmux-server.service\n' \
  > ~/.config/systemd/user/perch-agent.service.d/10-tmux.conf    # only with step 5
systemctl --user daemon-reload && systemctl --user enable --now perch-agent

pnpm perch install-hooks                                         # status hooks, see below
mkdir -p ~/.claude/skills && ln -sfn "$(pwd)/.claude/skills/perch-spawn" ~/.claude/skills/perch-spawn
ln -sfn "$(pwd)/.claude/skills/perch-orchestrate" ~/.claude/skills/perch-orchestrate
deploy/install-cli.sh                                            # `perch` on PATH (the skills use it)
```

Check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/hooks` prints
`401` (running, and refusing an unauthenticated hook).

**Or in one step.** `pnpm perch setup` does the `agent.env`, unit and hooks steps above without
prompting, and is safe to rerun (it changes only what differs):

```bash
pnpm perch setup --machine-id <name> --project-roots /home/<user>/workspace \
  --default-path /home/<user>/workspace --dry-run      # the plan; drop --dry-run to apply it
```

It also writes `~/.perch/devices.json` with token enrolment off, so only a `perch pair` code adds
a phone. With Tailscale on the machine, `--tailscale serve` (tailnet only) or `--tailscale funnel`
(public, the phone needs no VPN) also publishes the phone port and records its address for
`perch pair`; that path needs the direct-connection app, which steps 7 and 8 do not use yet.
`pnpm perch setup --help` explains the flags and the Tailscale admin settings. The tmux drop-in,
skills and `install-cli.sh` lines above are still yours to run.

**Status hooks** tell your phone whether a session is working or waiting for you. They go into
`~/.claude/settings.json`, and into `~/.codex/hooks.json` when `~/.codex` exists, which Codex
creates on its first run: run `install-hooks` again after you first start Codex, then open Codex,
run `/hooks` and trust them (again after any change). See `docs/DEPLOY.md`, step 4.

## 7. Your relay and app on Cloudflare

Both live in your Cloudflare account, on free `workers.dev` hosts. The full procedure and the
reasons behind it: `docs/relay-cf-runbook.md`, "A relay and PWA in your own Cloudflare account".
Deploys run from a clean, pushed `main` of your fork.

```bash
# keys: 32 random bytes in base64url each (perch connect refuses hex)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # twice
install -m 600 deploy/relay-cf.env.example ~/.perch/relay-cf.<name>.env
# fill in CLOUDFLARE_ACCOUNT_ID, RELAY_JOIN_KEY, RELAY_ADMIN_KEY; leave RELAY_DOMAIN unset

(cd packages/relay-cf && pnpm exec wrangler login --device && pnpm exec wrangler whoami)

deploy/relay-cf-deploy.sh --env-file ~/.perch/relay-cf.<name>.env          # the relay

mise exec -- pnpm --filter @perch/pwa build                                 # the app
(cd packages/pwa && CLOUDFLARE_ACCOUNT_ID=<account-id> ../relay-cf/node_modules/.bin/wrangler deploy \
  --name perch --assets dist --compatibility-date 2026-09-01)
```

`--device` lets you approve the login from any browser, which a machine with no screen needs. If
you hold several Cloudflare accounts, give each its own wrangler login with
`XDG_CONFIG_HOME=<a directory of its own>` on every wrangler and deploy command.

Keep the admin key in your password manager; it lists and removes machines. The join key only
registers machines; keeping a private copy at `~/.perch/relay-join-key` (mode `600`) makes
adding your next machine a one-liner.

Docs: [Workers static assets](https://developers.cloudflare.com/workers/static-assets/),
[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/).

## 8. Connect the machine and pair your phone

```bash
cd ~/workspace/perch
PERCH_JOIN_KEY="$(cat ~/.perch/relay-join-key)" pnpm perch connect \
  wss://perch-relay.<subdomain>.workers.dev --pwa https://perch.<subdomain>.workers.dev
```

The key travels in the environment, never as `--key`, which the process list and your shell
history would show. `connect` registers the machine, adds the relay to `deploy/agent.env`,
restarts the agent and prints a QR code and a link. Check:
`journalctl --user -u perch-agent | grep 'socket open'`.

On your phone, open `https://perch.<subdomain>.workers.dev` and install it (iPhone: Share → Add to
Home Screen; Android: install from the browser menu). Then pair:

- **iPhone:** scan the QR code from **inside the installed app** (Settings → Scan QR code), or
  copy the link and use **Paste pairing link**. The Camera app opens Safari, whose storage is not
  the installed app's.
- **Android:** open the link anywhere; it goes straight into the installed app.

A code works once, for 10 minutes; `pnpm perch pair` makes another. Once your phones are paired:

```bash
pnpm perch devices enrolment off   # only a perch pair code can add a phone from now on
pnpm perch devices                 # your phones; revoke a lost one by id or key
```

Check: the machine shows on your phone, a new `bash` workspace opens, and `echo hi` answers.

## 9. Updating

```bash
cd ~/workspace/perch
git pull --ff-only && pnpm install --frozen-lockfile && systemctl --user restart perch-agent
```

Workspaces survive the restart (the agent runs from source, so there is nothing to build). When
the wire format changes, redeploy the relay and the app from step 7 too, together. Run
`install-hooks` again when the hook script changes, and trust the Codex hooks again.

## 10. Optional: reaching the machine yourself

Perch goes through the relay, so a workspace on your phone is already a shell on the machine, even
when nothing else works. For SSH and for previewing web servers, [Tailscale](https://tailscale.com/docs/install/linux)
is the simple path:

- **SSH with keys only.** Cloud-init's `/etc/ssh/sshd_config.d/50-cloud-init.conf` turns password
  login on, and sshd keeps the first value it reads, so put yours in a file that sorts earlier:
  ```bash
  sudo tee /etc/ssh/sshd_config.d/10-keys-only.conf >/dev/null <<'EOF'
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitRootLogin no
  EOF
  sudo sshd -t && sudo systemctl reload ssh
  ```
  Check with `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin) '`, and open a new
  SSH session before you close the one you are in.
- **Never hand your phone a `localhost` link**: it opens on the phone. Publish a dev server on your
  tailnet instead, and open `https://<machine>.<tailnet>.ts.net:<port>`:
  ```bash
  sudo tailscale set --operator=$USER                 # once, so serve needs no sudo
  tailscale serve --bg --https=<port> http://127.0.0.1:<port>
  tailscale serve --https=<port> off                  # when done
  ```
  It needs MagicDNS and HTTPS certificates on in your tailnet, and your access policy must let
  your phone reach that port ([serve](https://tailscale.com/docs/features/tailscale-serve),
  [grants](https://tailscale.com/docs/features/access-control/grants)). Disable key expiry for
  the machine in the admin console, or it drops off the tailnet after a few months
  ([key expiry](https://tailscale.com/docs/features/access-control/key-expiry)).

## 11. Optional: dictate through Claude Code's own `/voice` (Linux)

The "Claude Code /voice" dictation preset streams what you say to the agent, which plays it into
a virtual microphone while holding space in the open workspace, so Claude Code transcribes it into
the prompt, unsent, for you to review. It needs no speech-to-text key, but each machine
must be set up once by hand:

```bash
sudo apt install -y alsa-utils
sudo usermod -aG audio <user>       # the agent's service has no seat, so it needs the group
echo snd-aloop | sudo tee /etc/modules-load.d/snd-aloop.conf   # load the loopback at boot
sudo modprobe snd-aloop                                         # and now

# Claude Code records from ALSA's default device: make that the loopback's capture side.
cat > ~/.asoundrc <<'EOF'
pcm.!default {
  type asym
  playback.pcm "plughw:Loopback,0"
  capture.pcm "plughw:Loopback,1"
}
EOF
```

Then run `/voice` once in any Claude workspace and keep **hold** mode, the default (or set
`"voice": {"enabled": true, "mode": "hold"}` in `~/.claude/settings.json`). The setting is per
user, shared by all of that user's workspaces, and the agent refuses a dictation while voice is off
or in tap mode (tap mode would submit the prompt). If you had to add the group, reboot: the user
services run under a user manager that keeps the groups it started with, and restarting that
manager would take every workspace of that user down with it. To use it before the next reboot,
grant the user the loopback devices directly instead (lost at reboot, when the group takes over):

```bash
card=$(awk '/\[Loopback/ {print $1}' /proc/asound/cards)
for d in /dev/snd/controlC$card /dev/snd/pcmC${card}D*; do sudo setfacl -m u:<user>:rw "$d"; done
``` On the phone: Settings →
Add preset → Provider "Claude Code /voice".

- **Check:** `aplay -l | grep Loopback` lists the card, `jq .voice ~/.claude/settings.json`
  says `"enabled": true, "mode": "hold"`, and the agent's own user manager can open the
  loopback (`id -nG` in a login shell is not enough: it shows a group the manager may not have):
  `systemd-run --user --quiet --wait --pipe aplay -q -D plughw:Loopback,0 -f S16_LE -r 16000 -c 1 -t raw -d 1 /dev/zero`
  exits without an error (with several users, use that user's `PERCH_VOICE_DEVICE` as the `-D`).
- **This is meant for a headless server.** `~/.asoundrc` replaces the default device for every
  ALSA program of that user, playback included, so on a desktop with PipeWire or PulseAudio it
  would take the real microphone and speakers away. That case is untested.
- One dictation at a time per agent. The text arrives about 1.5 s after you stop speaking.
- Each agent tells the phone whether Claude voice can work on its machine (the loopback card is
  loaded). Where it cannot (macOS, or no `snd-aloop`), the preset is greyed out "not on this
  machine" and the mic uses the preset's Fallback. After loading the module, reopen the app so
  the phone asks again.

**Several Linux users on one machine (see step 13).** They share the one loopback card, and ALSA
gives each `aplay` and each recorder the lowest free subdevice, pairing playback subdevice *n*
with capture subdevice *n*. Two users dictating at once then cross over whenever their programs
open in a different order, and one user's Claude hears the other's speech (measured with
`arecord`/`aplay`: a recorder heard the tone another player sent; pinned subdevices kept apart).
Give every user its own subdevice *n* (0, 1, 2…; the card has 8), **the first user included**,
since one user left on "lowest free" can still take another's. Each user also needs the rest of
this step for itself: the `audio` group (or the direct grant above) and `/voice` in hold mode.

```bash
# In that user's ~/.asoundrc, with its own <n> on both sides:
pcm.!default {
  type asym
  playback.pcm "plughw:Loopback,0,<n>"
  capture.pcm "plughw:Loopback,1,<n>"
}
# And in its deploy/agent.env, the playback side of the same <n>, then restart its agent:
PERCH_VOICE_DEVICE=plughw:Loopback,0,<n>
```

The agent plays into `plughw:Loopback,0` when `PERCH_VOICE_DEVICE` is unset, which is right
only for a machine with one user.

## 12. Optional: a Claude Code setup that works well here

None of this is required by Perch.

- **Tell Claude where it is.** A few lines in `~/.claude/CLAUDE.md` go a long way: every session
  runs in a Perch workspace you read on a small screen; never kill tmux sessions it did not
  create; never give `localhost` links (step 10); Perch questions are answered from
  `~/workspace/perch` and its `docs/`; `heavy` for big jobs.
- **Library docs:** [Context7](https://github.com/upstash/context7) as an HTTP MCP server, which
  works without a key: `claude mcp add --transport http --scope user context7 https://mcp.context7.com/mcp`
  ([MCP in Claude Code](https://code.claude.com/docs/en/mcp)).
- **Plugins** from the official marketplace, installed with `/plugin`; language-server plugins
  need their servers installed (e.g. `mise use -g npm:typescript-language-server npm:typescript`,
  `uv tool install pyright`) ([plugins](https://code.claude.com/docs/en/discover-plugins)).
- **Browser automation** with [agent-browser](https://github.com/vercel-labs/agent-browser) on
  Ubuntu 23.10+: its Chrome needs the usual shared libraries, and AppArmor blocks the user
  namespaces Chrome's sandbox needs
  ([Ubuntu's change](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)).
  Allow that one binary, in `/etc/apparmor.d/agent-browser-chrome`:
  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile agent-browser-chrome @{HOME}/.agent-browser/browsers/chrome-*/chrome flags=(unconfined) {
    userns,
  }
  ```
  then `sudo apparmor_parser -r /etc/apparmor.d/agent-browser-chrome`. Name a session after its
  workspace and Perch's browser view picks it up (`docs/BROWSER.md`).

## 13. Another Linux user on the same machine

One machine can run several Perch agents, one per Linux user. Each user has its own agent, tmux
server, `~/.perch` (agent key, paired phones, parked workspaces, and its own `hidden-folders.json`,
`commands.json` and `launchers.json`), Claude Code login and config, and files. The phone sees
each agent as a separate machine. Use it to keep one kind of work apart from the rest: a client's
projects in an account that cannot read your home directory, your credentials or your sessions.

Everything below runs from your admin account. `<user>` is the new user, `<uid>` its id
(`id -u <user>`).

**The user.** Give it neither `sudo` nor the `docker` group: either one can read every other
user's files, which defeats the point. Check that your own home is closed to it as well
(`stat -c %a ~` should say `750` or `700`; older Ubuntu installs made homes `755`). Other users
can still see command lines in `ps`, which is why Perch keeps its secrets off them.

```bash
sudo adduser --disabled-password --gecos '' <user>
sudo loginctl enable-linger <user>
id <user>                     # no sudo, no docker among the groups
```

If the user needs Docker, run it rootless and private to that user
([rootless mode](https://docs.docker.com/engine/security/rootless/)).

**Memory.** With several users, cap each one's `user-<uid>.slice`, yours included, instead of the
single `user@<uid>.service` of step 2: the slice also holds the user's SSH logins. Keep the sum
of the limits within the machine, so one user's runaway job cannot freeze another's workspaces.
For each user:

```bash
sudo mkdir -p /etc/systemd/system/user-<uid>.slice.d
sudo tee /etc/systemd/system/user-<uid>.slice.d/50-share.conf >/dev/null <<'EOF'
[Slice]
MemoryHigh=<e.g. 8G>
MemoryMax=<e.g. 10G>
MemorySwapMax=2G
EOF
sudo systemctl daemon-reload
```

Then remove step 2's `user@<uid>.service.d/50-memory.conf` for your own user. Give the new user
the `heavy` wrapper of step 2 in its own `~/.local/bin`.

**Working as that user.** For the interactive parts (step 3's installers, the Claude Code and
Codex logins), open a shell as that user:

```bash
sudo -iu <user>
export XDG_RUNTIME_DIR=/run/user/$(id -u)   # or systemctl --user cannot reach its user manager
```

For scripted parts, a here-doc keeps the quoting simple. It runs a non-interactive shell, which
reads no profile, so set the two variables it lacks:

```bash
sudo -u <user> -H bash -s <<'EOF'
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH
cd ~/workspace/perch && git pull --ff-only
EOF
```

**Steps 3 to 6, 8 and 9 again, as that user** (step 7 is done once per Cloudflare account). The new user needs its own clone (a private fork needs git
credentials of its own). In `deploy/agent.env`, three values differ:

- **`PERCH_PORT` must differ from every other agent's on the machine** (and step 6's check
  `curl`s that port). Each agent listens on `127.0.0.1:<port>` for its hooks, and with the port
  taken the second agent exits at once and its service restarts it in a loop. Pick 8789 or above
  (8788 is `wrangler dev`'s). `install-hooks` and the `perch` CLI read the port from
  `agent.env`; `install-hooks` writes it into each hook, so run it again after changing the port.
- **`PERCH_MACHINE_ID`** is the name the phone shows: give each agent its own.
- **`PERCH_STATS`**: each agent shows its own user's memory room on the home screen, which is
  how you see the new user's jobs nearing their cap. `PERCH_STATS=off` hides that line.
- **`PERCH_VOICE_DEVICE`**: for Claude voice, each user needs its own loopback subdevice, in
  its `~/.asoundrc` and its `agent.env` (step 11, "Several Linux users on one machine").

With `perch setup` (step 6), the second user passes its own `--machine-id` and
`--phone-port` (8798 beside your 8797; `setup` refuses a port another user's agent holds), and
sets `PERCH_PORT` in its `agent.env` first (`setup` refuses a hooks port that is taken, naming
it). To share your Tailscale port under its own path, it runs `--tailscale none --slug <user>
--address wss://<node>.<tailnet>.ts.net/<user>`, and `setup` prints the `tailscale serve` line
for you, the node's operator, to run.

**What not to copy from your account.**
- **`~/.perch`:** never copy it. Two agents with one agent key take turns on the relay instead of
  both staying connected (`docs/relay-cf-runbook.md`, "Several relays at once").
- **`~/.claude`:** never copy it whole. It holds your Claude login (`.credentials.json`) and your
  conversations (`projects/`, `history.jsonl`). Copy only what the user should have: the
  instructions in `CLAUDE.md`, chosen skills, `settings.json`. In that `settings.json` `env`, set
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`, or the claude.ai connectors of a shared Claude account
  (mail, drive) come along.

**Relay and phone (step 8).** The same relay is fine: each agent key is its own account there,
and the phone gets a separate entry for it. The new user has no join key of its own: give it the
key from your password manager through the environment, as step 8 does, or install a private copy
in its `~/.perch/relay-join-key` (mode `600`). `perch connect` prints the first pairing code;
`perch pair` makes more. Turn token enrolment off for this agent too
(`pnpm perch devices enrolment off`).

**Running it from your account.**
- Its user services: `sudo systemctl --user -M <user>@ <status|restart> perch-agent`.
- Its logs: `sudo journalctl _UID=<uid> _SYSTEMD_USER_UNIT=perch-agent.service`.
- Updating it is step 9, run as that user.
- Each user has its own tmux server. Upgrading tmux replaces **every** user's server in the same
  step, or a newer client cannot attach to an older server (`docs/TMUX-OSC7501.md`).

## 14. Pitfalls

- **Every new workspace says "No session" (status 127):** `claude` is not on the user services'
  PATH. Step 4, then restart the agent.
- **`perch connect` refuses the join key:** it was made in hex. Use the base64url one-liner.
- **`wrangler pages project create` made an empty Worker:** deploy the app as a static-assets
  Worker (step 7).
- **`wrangler login` hangs on a machine with no screen:** it waits for a redirect to
  `localhost` on the machine. Use `--device`.
- **The deploy script refuses:** it wants the main checkout, on `main`, clean, equal to
  `origin/main`, and an env file only you can read. Fix the checkout rather than working around it.
- **Pairing on an iPhone "did nothing":** the link opened in Safari, not the installed app. Scan or
  paste it from inside the app.
- **Codex shows no status:** its hooks are not trusted yet (`/hooks`), `install-hooks` ran before
  `~/.codex` existed, or Codex was started without `--no-daemon` (the app's create form adds it).
- **Password SSH is still on:** cloud-init's `50-cloud-init.conf` wins unless your file sorts
  before it.
- **The agent loops on `401` against the relay:** the machine's clock is more than a minute off.
- **Accents or Arabic show as `_`:** no UTF-8 locale (step 1).
- **After a reboot the workspaces are gone:** resume conversations with `claude --resume`.
