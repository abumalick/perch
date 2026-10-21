# Relay-only design: reaching the machines without a VPN

**Status:** relay-only in production, the direct path retired; no signed roster yet (see "Decisions taken in discussion") · **Date:** 2026-09-23 · **Companion to:**
[the hosted-relay evaluation](2026-09-23-hosted-relay-evaluation.md)

The evaluation treated "direct connections when possible" as a hard requirement and
concluded that only WebRTC could satisfy it from a browser, at a cost that made the whole
relay not worth building. This document records a second shape that surfaced from reading
the source of an existing open-source mobile client for Claude Code (Happy): **a plain
WebSocket relay that everything routes through**, with keypair identity, QR pairing and a
single self-host binary. It gives up the direct-connection requirement (the tailnet path
stays as the direct case) *(Superseded: the direct tailnet path is retired; see "Decisions taken in discussion".)* and in exchange removes most of the cost. The centre of this
document is the security question that comes with it: the tailnet guarantees that
anyone outside it can never reach a machine, so what replaces that guarantee?

## The model

```
  phone (PWA) ──wss──▶ relay ◀──wss── agent (machine)
                        │
       routes ciphertext frames between devices of one account;
       holds public keys, presence, pairing mailboxes; nothing else
```

- Both the phone and the agent **connect outbound** to the relay. The agent **listens on
  no port** (its hooks endpoint stays on the loopback interface).
- The relay **forwards frames between devices that belong to the same account** and does
  nothing else with them. Every frame is ciphertext from a Noise session between the two
  devices; the relay cannot read or forge one.
- The relay is **self-hostable in one command** (an embedded database, the PWA bundled) and
  could later also run as a hosted service. Nothing in the design differs between the two.
- **The tailnet path stays.** A machine can be reachable directly over the tailnet, through
  a relay, or both; the PWA tries direct first when a direct address is configured. *(Superseded: the direct tailnet path is retired; see "Decisions taken in discussion".)*

Terminal traffic is kilobytes per second, so relaying everything costs one round trip of
latency per keystroke echo and nothing in bandwidth. The single-user, own-machines use
case never needed peer-to-peer; the evaluation's WebRTC design was the price of insisting
on it from a browser.

## What the setup becomes

| Step | Today (tailnet) | Relay-only |
|---|---|---|
| Network | Tailscale on every machine and the phone, MagicDNS and HTTPS enabled in the admin | None. A relay URL |
| Certificate | `tailscale serve` per machine | One certificate on the relay (or none inside a company VPN with an internal proxy) |
| Machine | Install toolchain, run the agent as a service, `install-hooks` | Same, plus `perch-agent enroll` prints a QR |
| Phone | Install the PWA from the tailnet origin; type each machine's URL and token | Install the PWA from the relay origin; scan each machine's QR |
| Second phone | Retype every token | Scan a QR shown by the first phone |
| Colleagues on a company LAN | No workable path without a certificate on a private address | Run the relay on any VPN-reachable host, or use a public one |
| Revoking a lost phone | Rotate every machine's token | Remove the device from the roster on another device |

## Security: what replaces "not on the tailnet, no access"

### The two gates today

1. **Network membership.** The agent's port is served on the tailnet only. A stranger on
   the internet cannot reach it; they cannot even find it. Membership is decided by
   Tailscale's login and coordination server.
2. **A bearer token** per machine, sent in the first message after the socket opens.

Both gates are needed: the token is what stops another tailnet member, and the tailnet is
what stops everyone else.

### The two gates in the relay model

1. **Relay routing.** The relay forwards a frame to a machine only from a device enrolled
   in the same account. A stranger on the internet can reach the relay, but the relay will
   not carry their bytes to anyone's machine. This gate is the relay's authorisation code,
   and it is the weaker of the two: it is software on a public server.
2. **Device-key verification on the agent.** Before any Perch protocol message is parsed,
   the agent requires a Noise handshake from a static key that appears in its copy of the
   **account roster**, which is signed by an account root key that only devices hold.
   Anything else is dropped at the handshake. This gate does not trust the relay at all: a
   compromised relay, a bug in its authorisation, or a stolen relay database gives an
   attacker nothing to present to the agent.

The second gate is what replaces the tailnet. It is the same shape as Tailscale with
Tailnet Lock enabled: a central server introduces peers, and each peer still verifies the
other's key against a signature that the server cannot produce. Plain Tailscale without
Tailnet Lock is in fact **weaker** than this on paper: its coordination server can add a
node to a tailnet, which is exactly why Tailnet Lock exists.

### Who can do what

| Attacker | Tailnet today | Relay-only |
|---|---|---|
| Stranger on the internet, port scanning | Finds nothing; the agent is not on a public interface | Finds nothing on the machine; it has no listening port. Finds the relay, a public HTTPS server |
| Someone with an account on the same relay | n/a | Can make the relay carry frames only to their own devices. Their frames never reach another account's machine, and would fail the agent's key check if they did |
| Someone who steals the relay database | n/a | Gets public keys, account ids, presence history and connection metadata. Cannot decrypt anything, cannot connect to any machine, cannot add a device the agent would accept |
| The relay operator, or an attacker who owns the running relay | n/a (the tailnet has an analogue: the coordination server) | Same as above, plus: denial of service, traffic metadata, packet timing, and, if the relay also serves the PWA, a backdoored client. Cannot get a shell |
| Another member of the tailnet | Reaches the agent's port; needs the token | Not a concept. Equivalent: an enrolled device of the same account, which is by definition trusted |
| Someone who steals the phone unlocked | Has every machine's token; every token must be rotated | Has the device key and the root key material; another device removes it from the roster, and the agents stop accepting it on their next roster refresh |
| Someone who compromises one machine | Gets that machine's token; other machines are unaffected | Gets that machine's device key; other machines are unaffected. Machines cannot sign roster changes, so it cannot enrol a device |
| Someone who sees the enrolment QR | n/a | The QR carries the new device's public key and a one-shot secret; a watcher cannot pair with it. A short mailbox lifetime and single use bound the window |
| Someone who guesses at the relay | n/a | Rate-limited by the relay; a guessed account id yields nothing without a device key |

### What is weaker than the tailnet, honestly

- **A new parsing surface on the agent.** Today no untrusted party can send the agent a
  byte. In the relay model the agent's relay client parses control messages from the relay
  (routing, presence, roster). A hostile or compromised relay can therefore attack that
  code. The mitigation is to keep it tiny and strictly validated, exactly like the existing
  wire protocol: a handful of zod-parsed message types, no dynamic behaviour, and the Noise
  handshake as the only path into the rest of the agent.
- **A public server exists that did not before.** It needs the care any internet-facing
  service needs: updates, rate limits, logs, a certificate. For a self-hoster this is the
  new burden. Inside a company VPN the server is not public, and the network gate returns
  on top of the key gate.
- **Availability depends on the relay.** No relay, no access. On the tailnet, existing
  connections survive a coordination outage. Keeping the tailnet path for the machines
  that have it is the mitigation.
- **Metadata.** The relay learns which devices exist, when they connect, from which IP
  addresses, and how much they talk. The tailnet's coordination server learns nearly the
  same; the difference is who operates it.
- **Code delivery.** Whoever serves the PWA can read everything, encryption or not. A
  self-hoster serving the PWA from their own relay is trusting themselves. A hosted service
  would have to serve the PWA from a separate, pinned origin to keep its blindness claim.

### What is stronger than today

- **No listening port on any machine**, not even on the tailnet.
- **Per-device keys and revocation** instead of one shared token per machine typed into
  every phone.
- **No secret crosses the wire.** Today the token travels in the first message; a device
  key never leaves its device.
- **The introduction server is not trusted for authentication**, which plain Tailscale
  cannot say without Tailnet Lock.

### Rules that keep it safe

1. The agent never accepts a protocol message from a peer whose static key is not in a
   roster signed by the account root key. No exceptions for "the relay said so".
2. The relay never treats anything it can observe as an authenticator: not a pairing
   public key, not an account id, not a session id. The Happy client is reported to have
   slipped here ([slopus/happy#1829](https://github.com/slopus/happy/issues/1829),
   unconfirmed at time of writing).
3. The relay persists nothing but public keys, signed rosters and short-lived pairing
   mailboxes. No message queue: tmux holds the session, so an offline phone re-attaches
   rather than catches up. This also keeps the relay a mere conduit legally.
4. The relay-facing protocol on the agent is minimal and zod-validated, like the existing
   `contracts` package.
5. A device key is a file with the same protection as `deploy/agent.env` today; the
   account root key is only ever transferred inside a pairing exchange sealed to a key
   that was read out of band (QR).
6. **Whoever serves the PWA is trusted.** A self-hoster serves it from their own relay,
   trusting themselves. A hosted instance, if one ever exists, serves the PWA from a
   separate, pinned static origin, or does not claim to be blind.

## Design

### Components and relay state

| Component | Role | State |
|---|---|---|
| Relay | Accept outbound WebSockets from devices; authenticate each by a signed challenge; route frames between devices of one account; hold pairing mailboxes; serve the PWA (self-host) | Account root public keys; signed roster per account; presence (in memory); mailboxes (minutes) |
| Agent | As today, plus a relay client (outbound WebSocket, reconnect with backoff), a device key, a Noise responder, `enroll` | Device key; roster copy |
| PWA | As today, plus sign-in by device key, roster verification, pairing screens, a relay-backed `Socket` | Device key; root key material; roster copy |

The relay never holds terminal bytes, workspace names, paths, files or browser frames, and
no key that decrypts them.

### Identity, roster and pairing

Unchanged from the evaluation: static X25519 device keys, a root key that lives only on
devices and signs the roster, a version counter against rollback, a recovery code, QR
pairing that carries the new device's public key out of band, and a SPAKE2 short code when
no camera is available. The Happy source confirms the shape works in practice: its v2
pairing seals a per-machine key to an ephemeral key read from a QR, so a machine never
holds the master secret.

**Only phones sign roster changes.** A machine's device key authenticates the machine and
nothing else; it never receives root key material and cannot enrol a device. A compromised
machine therefore has exactly today's blast radius (that machine), at the cost that adding
a machine always needs a phone to scan its QR, which is the enrolment flow anyway.

### Transport

- **One WebSocket per device to the relay**, authenticated by signing a relay challenge with
  the device key. Node 22+ has a built-in client; the PWA already has a `Socket` port.
- **Frames.** `{to, from, seq, payload}` where `payload` is Noise ciphertext. The existing
  `ClientMessage` and `AgentMessage` unions ride inside unchanged. The bearer `auth`
  message becomes the handshake.
- **Multiplexing.** Today's three side channels become streams inside the same session:
  the image fetch (`GET /file`) becomes a chunked read message; the browser view's
  `/browser` WebSocket becomes a second stream with the same latest-wins backpressure; the
  connection-event flush (`POST /clientlog`) becomes a message, or is dropped on the relay
  path. Same protocol work as in the evaluation; no transport work beyond it.
- **No persistence, no sequence catch-up.** The relay drops frames for an offline peer and
  reports presence; the PWA re-attaches on reconnect as it does today. This is where
  Perch needs strictly less than Happy: Happy has to persist a transcript because its phone
  UI *is* the transcript; Perch's terminal state lives in tmux.
- **Direct path first.** A machine entry can carry an optional direct URL (the tailnet
  address). The PWA tries it first with the same Noise session over the existing
  WebSocket, and falls back to the relay. The token path can be retired once every machine
  has a device key, or kept for machines that never enrol. *(Superseded: the direct tailnet path is retired; see "Decisions taken in discussion".)*

### Presence, reconnection, backgrounding

The agent's relay client reconnects with exponential backoff (the Happy CLI uses a fixed
three-second retry; backoff is kinder to a self-hosted relay). The relay marks a device
present while its socket is up and broadcasts presence to the account's other devices,
which is what the home screen's online/offline state becomes. iOS suspends the PWA within
seconds to minutes of backgrounding; on foreground the PWA reconnects one socket to the
relay instead of one per machine, which is cheaper than today.

### Push notifications: deliberately out of scope

A relay makes Web Push possible (installed PWAs on iOS 16.4 and later, any HTTPS origin),
and Happy users cite it. It is **not** part of this design: with many workspaces a push
per `needs-feedback` is noise, and the intended use is to open the app and work, not to be
interrupted. If it is ever added, it is only for workspaces flagged urgent (the protocol
already carries `setUrgent`), with the payload sealed to the phone so the relay sees an
event kind and a timestamp, nothing more.

### Keeping the development flow

A constraint as hard as the security ones: Perch is developed from inside Perch. The
maintainer opens a workspace in the Perch checkout, the work happens in a worktree, and the
worktree's build is tested on the phone against the very machines being used, through the
existing `serve:build` (repoints the `deploy/pwa-live` symlink at the worktree's build) and
`serve:agent` (repoints `deploy/agent-live` and restarts the agent service, which tmux
survives). Nothing in that flow may require re-entering a URL or re-pairing on the phone.
The relay design keeps it as follows.

| Fixed thing | Today | With the relay |
|---|---|---|
| The installed PWA's origin | The standing `vite preview` behind the tailnet, serving whatever `pwa-live` points at | Unchanged on the dev machine. The relay's bundled PWA is for self-hosters who have nothing else; the dev machine keeps serving the PWA as today, and that PWA talks to the tailnet path and the relay path alike |
| The machine's identity in the PWA | A URL and a token per machine | A device key and a roster entry per machine, both in `~/.perch/`, shared by every worktree just as `deploy/agent.env` is today. Flipping `agent-live` changes the code, never the identity |
| The relay | n/a | One long-running user service, exactly like the agent: a `deploy/relay-live` symlink and a `serve:relay` / `serve:relay-restore` pair. Its durable state lives in `~/.perch/relay/`, outside any worktree, so a flip never loses a roster. Its URL is configured once |
| Version skew across worktrees | A worktree PWA against the main agent drops unknown messages; additive fields stay optional | Same rule, and easier: the relay never parses a payload, so any worktree PWA and any worktree agent work through the main relay. Only the tiny relay-facing control protocol must stay backward compatible, which is the reason to keep it tiny |

So a normal day stays: open a workspace in the Perch checkout, make a worktree,
`serve:build` it, `serve:agent` it if the agent changed, test on the phone, merge,
`serve:restore`. The relay is flipped only when the relay itself changed, which will be
rare. On the other machines (a laptop, a colleague's machine) the packaged one-command
install is the right shape, and it is fine that they run a different environment from the
dev machine: they never build Perch, they only run it.

## What is borrowed from Happy, and what is not

| Happy | This design | Why |
|---|---|---|
| Keypair account, no email or password; sign a challenge | Same | No passwords to leak, nothing for the relay to reset |
| QR pairing with an ephemeral key; v2 per-machine keys | Same, plus a root-signed roster | Happy's server decides who is in the account; here the devices do |
| Socket.IO with WebSocket transport | Plain WebSocket | One dependency fewer; the PWA already has a socket port |
| Server-persisted, sequence-numbered encrypted messages | Nothing persisted | tmux is the state; the relay stays a conduit |
| Versioned encrypted state blobs, RPC rooms | Not needed | Perch's protocol is already request/reply over one channel |
| Application heartbeats and an inactivity sweep | The existing heartbeat | Already in `MachineConnection` |
| Daemon that spawns sessions in a chosen directory | Already exists (`create`) | |
| Expo push for permission, question, done | Not adopted | Too noisy for many workspaces; at most, later, for workspaces flagged urgent |
| Embedded-database standalone server, bundled web app, custom server URL in every client | Same | The self-host story in one command |
| Vendor OAuth tokens uploaded to the server | Never | Perch does not touch credentials |
| Push text and usage in the clear | Sealed or absent | Metadata discipline |

## Terms of use

A survey of Anthropic's current documents, not legal advice. The discriminating fact is
that Perch never talks to Anthropic: it runs the unmodified `claude` binary in tmux,
mirrors its terminal to the owner's own phone, and receives status events from the
official hooks feature. Every relevant restriction turns on that.

- **Clearly within the texts.** The legal and compliance page
  ([source](https://code.claude.com/docs/en/legal-and-compliance)) states that nothing
  "prevents an end user from signing in to the unmodified Claude Code binary with their
  own Claude subscription"; its conditions for running Claude Code inside a product are
  that "the Claude Code binary must not be modified" and that customers "may not pay for,
  resell, or intermediate Claude usage on their end users' behalf", both of which Perch
  meets. Hooks are documented for exactly this purpose ("get a desktop notification
  whenever Claude finishes working and needs your input",
  [hooks guide](https://code.claude.com/docs/en/hooks-guide)), `session_id` is a standard
  hook field, and `--resume` is a plain CLI feature. No document mentions terminal
  streaming, tmux, or the number of devices viewing a session. A self-hosted end-to-end
  relay changes none of this: still no Anthropic traffic, still no credentials.
- **What the 2026 enforcement targeted.** Every action (the January server-side rejection
  of subscription OAuth outside Claude Code, the February rewording of the legal page, the
  April cut-off of subscription coverage for third-party tools) was aimed at tools that
  send their own requests to Anthropic on a subscription token or spoof the Claude Code
  harness. None concerned tools that display or relay an interactive session. The Agent
  SDK "agent credit" announced in May 2026 was **paused** on 2026-06-15; the support
  article now says "nothing has changed" and SDK, `claude -p` and third-party usage still
  draw from the subscription limits
  ([source](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
  Perch triggers none of the four cases that credit was defined to cover.
- **Grey, for a hosted service only.** "Running Claude Code in your products or services
  requires agreeing to our Commercial Terms of Service" plausibly attaches if a hosted
  relay makes Perch a service for others, and the login article keeps a discretionary
  "reserves the right to draw use of such third-party tools from usage credits". Charging
  for a relay is not charging for Claude usage, and nothing found prohibits it, but no
  Anthropic statement addresses remote terminal clients in either direction. The
  self-hosted shape in this document does not raise the question.
- **Would cross the line.** Modifying the binary or its authentication; collecting,
  storing or forwarding OAuth tokens (the one thing in the Happy source that does this is
  its optional vendor-connect feature, which this design explicitly does not borrow);
  sending requests to Anthropic on a subscription token; running sessions headlessly or
  through the Agent SDK on behalf of others; letting several people use one account;
  naming a product with "Claude" in it. "Perch" is fine; saying in plain text that it runs
  Claude Code is expressly allowed.

Contrast with Happy: its **local** mode is the same class of use as Perch (unmodified
binary, the user's own login), while its **remote** mode drives the session through the
Agent SDK, which Anthropic says should use API key authentication. Perch's terminal
paradigm keeps it on the permitted side without needing that second mode.

## Proof of concept, before any implementation

The design's one unproven claim is that Claude Code through a relay, with no direct LAN
path, is pleasant enough to work in from the phone. That is a feel-and-latency question
nobody can answer from a document, so the proof of concept comes first and decides
whether the rest happens.

**What it proves.** Working in a real workspace from the phone through a relay: creating a
workspace, typing into Claude Code, reading output, parking and resuming, backgrounding
the phone and coming back. Measured, not felt: the keystroke echo round trip through the
relay compared with the tailnet, on Wi-Fi and on cellular.

**What it does not do.** No device keys, no Noise, no pairing, no roster. Bearer tokens
stay, so the machine is protected exactly as today (the relay forwards a stranger's bytes
to the agent, which rejects them at `auth`; a 32-byte random token is not guessable). The
relay sees plaintext, which is acceptable for a test on the maintainer's own host and is
the first thing the implementation removes. Image preview, the browser view and the
connection-log flush do not work through it.

**Scope, chosen so the PWA needs no change at all.**

- **Relay.** A small WebSocket forwarder on a host with a public HTTPS name. A client
  connects with a role and an account label; the relay asks the agent, over a control
  socket it already holds, to dial a fresh socket for that client, then forwards frames
  verbatim between the pair. One agent socket per phone connection means the agent's
  existing `WsClientConnection` and `ConnectionHandler` are reused unchanged and the relay
  never parses a payload. About a hundred lines, in a new `packages/relay` marked
  experimental, because the forwarder is the core of the real relay.
- **Agent.** One new setting: a relay URL. When set, the agent dials it and keeps the
  control socket up with backoff, alongside its normal listener. Everything else, hooks
  included, is untouched.
- **PWA.** Nothing. The machine's URL in settings becomes the relay's URL with the account
  label; `MachineConnection` sends `auth` with the token as today. The PWA can be served
  from its current origin.
- **Measurement.** Log the round trip of the existing heartbeat `ping`/`pong` and of a
  typed character to its echo, on the same phone, tailnet versus relay, Wi-Fi versus
  cellular. A day or two of work.

**Success criteria.**

| Check | Pass |
|---|---|
| Echo round trip on Wi-Fi through the relay | Typing feels immediate; comparable to the tailnet plus one relay hop |
| Echo round trip on cellular | Usable for real work, not just demos |
| Workspace list, create, attach, park, resume | Identical to the tailnet path |
| Phone backgrounded, then foregrounded | Reconnects through the relay and re-attaches, as today |
| Relay restarted mid-session | tmux session intact; the phone reconnects and re-attaches |
| Agent restarted | Redials the relay; workspaces reappear |

If the relay path fails the feel test, the tailnet stays the only transport and the
wildcard proxy remains the answer for a LAN behind a VPN.

## Effort, after the proof of concept

| Phase | What | Weeks |
|---|---|---|
| 1 | Frame layer on the **existing tailnet WebSocket first**: device keys, Noise session, envelope schema in `contracts`, agent `ClientConnection` adapter and PWA `Socket` adapter over it. Transport-independent, replaces the shared token, gives current users per-device keys and revocation before any relay exists | 3 to 4 |
| 2 | Relay package grown from the PoC forwarder: challenge auth by device key, per-account routing, pairing mailboxes, presence, embedded database, PWA bundling, one `perch-relay` command | 2 to 3 |
| 3 | Pairing UX (QR on the agent, scan on the phone, second phone), signed roster, recovery code, revocation | 2 to 3 |
| 4 | In-channel replacements for the three side channels (image read, browser stream, log flush); on-device hardening; deploy runbook | 1 to 2 |
| 5 | One-command agent install for the public case: a published package with prebuilt native modules, an install command that writes the service unit and hooks, then `enroll`. The transport is not what makes Perch hard to install; after the relay, the agent install is the worst step | 2 to 3 |

Phases 1 to 4 are two to three months part-time. Phase 5 is what "open to the public"
costs on top, and can wait until someone other than the maintainer wants to install it.
What disappears against the WebRTC design: WebRTC, TURN, ICE reconnection logic, accounts
with email, billing, and every obligation of a hosted paid service. The agent application
layer, the terminal UI, the store and the protocol survive untouched; the transport is
swapped behind two ports that already exist.

## Recommendation

Build the self-hosted relay-only design, in this order: the proof of concept above, then
phases 1 to 4. It is the only shape that scores well on maintenance (no WebRTC, no TURN,
a relay whose durable state is public keys and signed rosters, and a terminal paradigm
whose coupling to Claude Code is hooks plus `--resume`), on security (the agent trusts
device keys, never the relay; the same shape as Tailscale with Tailnet Lock), and on
installation and use (run the agent, scan a QR, no VPN, no certificates, no tokens).

Not part of it: a hosted paid relay (the evaluation's business findings stand), Web Push
(noise; at most later for urgent workspaces), and retiring the tailnet path (it stays as
the direct case; the token path goes only once every machine can enrol). *(Superseded: the direct tailnet path is retired; see "Decisions taken in discussion".)*

## Decisions taken in discussion

- **The wildcard proxy ships as the interim step** for a LAN behind a VPN while the relay
  is built; security first and small steps.
- **The one-command install is for machines that only run Perch** (a laptop, a colleague's
  machine, anyone installing it). The dev machine runs everything from the checkout and
  the worktree flow above, and keeps a different environment from those machines.
- **Packaging follows from that:** the relay is one npm-published command with an embedded
  database for self-hosters, and the same code run as a user service from the checkout on
  the dev machine. No container is needed for either.
- **No Web Push.** At most, later, for workspaces flagged urgent.
- **Only phones sign roster changes.**
- **Two supported relay hosts, over one relay core:** the Cloudflare Worker, the recommended
  default for anyone trying Perch, and the self-hosted Node relay, reached however its operator
  likes. Measured on a tablet on Wi-Fi, the self-hosted relay over the tailnet echoes in 18 ms
  against the Worker's 172–187 ms, which is why the maintainer runs one.
- **Tailscale is one way to reach the self-hosted relay, not a requirement.** The project
  documents what the relay needs from whatever fronts it (WebSocket passthrough, and a
  client-IP header it trusts only when told to); a VPS or the operator's own tunnel is theirs
  to run.
- **No Cloudflare Tunnel support.** A tunnel in front of a home relay gained nothing over the
  Worker on 4G, and cost a second Cloudflare setup to maintain.
- **The dev Worker is on demand**, deployed only for a change to Durable Object bindings or
  migrations or to the deploy itself, and deleted afterwards. Relay changes are tried on the
  local self-hosted relay; the Cloudflare adapter under local workerd (`wrangler dev`).
- **The direct tailnet path is retired.** Its side channels (media previews, the browser view,
  the connection-log flush) moved inside the encrypted session first; then the direct path went:
  the agent listens on no phone-facing port (only `POST /hooks`, on loopback), the PWA has no
  plaintext socket, and a stored direct entry is shown as unsupported with only a delete action,
  never silently removed. This supersedes "The tailnet path stays" and "Direct path first"
  above: a relay is the only way in, and a tailnet can still carry the phone to a self-hosted
  relay.
- **Enrolment off means token enrolment off.** A pairing code is minted on the machine by its
  operator, so it stays an explicit authorisation: `perch devices enrolment off` refuses only
  the token, and `enrolment closed` refuses every new phone.
- **The PWA stays on the tailnet for now**; where people without a tailnet load it from is open
  (CLAUDE.md, "why the PWA is still served from the tailnet").
