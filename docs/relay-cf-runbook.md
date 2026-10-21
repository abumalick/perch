# Relay with end-to-end encryption: runbook

How a phone reaches a machine: always through a relay, end to end encrypted, following
[the relay-only design](2026-09-23-relay-only-design.md). The agent listens on no phone-facing
port; the direct tailnet connection it used to offer is retired ("Retiring the direct path").

## Choose your relay host

Perch supports exactly two relay hosts, both running the same relay core
(`packages/relay`), and one conformance suite proves they behave the same:

| | Cloudflare Worker (`packages/relay-cf`) | Self-hosted Node relay (`packages/relay`, `perch-relay`) |
|---|---|---|
| Pick it | **to start.** Nothing to keep running, reachable from any network | for speed or control: a relay close to the phone and the agent, on a machine you run |
| Keystroke echo, measured on a tablet | 172–187 ms on Wi-Fi | 18 ms on Wi-Fi, over the tailnet |
| Costs to run | Cloudflare's free tier: SQLite-backed Durable Objects and hibernatable WebSockets, so an idle connection costs nothing | one Node process (about 160 MB resident) on a machine that stays up, and a way for the phone to reach it |
| Up while | Cloudflare is | that machine and its uplink are |
| Who sees metadata | Cloudflare | whoever runs the machine, and anything fronting it |

Either way the relay forwards Noise ciphertext only; the threat model below holds for both.

**How the phone reaches a self-hosted relay is the operator's business.** It listens on
localhost; the maintainer publishes it on the tailnet (`tailscale serve`, below), which is
one way to do it and not a requirement: nothing in Perch depends on Tailscale for the relay.
It can equally sit on a VPS behind a reverse proxy or behind the operator's own tunnel. Such
setups are possible but not supported: the project documents what the relay needs from a
proxy in front of it ("Fronting the self-hosted relay"), not the proxy itself. A Cloudflare
Tunnel in front of a home relay was tried and dropped: on 4G it gained nothing over the Worker.

## Connecting a machine and pairing a phone

Two steps, once per machine, with nothing typed on the phone:

1. **The machine.** The relay's operator prints the command once (below), and it is pasted in
   each machine's Perch checkout, where the agent is already set up (`docs/DEPLOY.md`):

   ```bash
   PERCH_JOIN_KEY=<join key> pnpm perch connect wss://<relay> [--pwa https://<where phones open Perch>]
   ```

   It creates the agent's relay identity (`~/.perch/relay-key.json`) if there is none, registers
   the machine with the relay, adds the relay to `PERCH_RELAY_URLS` in the main checkout's
   `deploy/agent.env` (after copying it to `agent.env.bak-<time>`), restarts the agent (the
   systemd user unit, or launchd on macOS; tmux and every workspace survive), and prints a QR
   code and a link. `--pwa` is remembered as `PERCH_PWA_ORIGIN`. Run again, it changes nothing
   and restarts nothing, and prints a fresh code. It stops without touching anything when the
   relay refuses the key (`401`), has no join key configured (`501`), is too old to support
   joining (`404`), or sees too many attempts from this address (`429`). Pass the key in
   `PERCH_JOIN_KEY`, as above, rather than `--key <join key>`: a command-line argument shows in the
   process list, and in the shell's history. On the relay's own
   machine, `--agent-url ws://127.0.0.1:8450` keeps the agent's own leg on localhost while the
   phone gets the published URL.
2. **The phone.** In Perch, Settings → **Scan QR code**, or open the link. The machine appears
   as a relay entry named after it, the phone's device key is enrolled, and it connects. The
   code works once, for ten minutes; `pnpm perch pair` makes another (`--relay <url>` when the
   machine holds several relays a phone can reach, `--pwa` when none is remembered).
   - **iPhone:** the Camera app opens codes in Safari, whose storage is not the installed
     app's, so scan from inside Perch (the camera works in the home-screen app since iOS 14.5),
     or copy the link and use **Paste pairing link** under Settings. A link opened outside the
     home-screen app is not paired there: it shows these steps and leaves the code unused.
   - **Android:** opening the link (from a QR app, a chat, anywhere) goes straight into the
     installed app, since the link is inside its scope.
   - A link opened from outside the app asks first ("Pair with <machine> through <relay>?", with
     the machine key's fingerprint, which `perch pair` prints beside the code: they must match),
     since any page can open one. A link naming another PWA origin than the app's own is refused,
     and so is a relay URL that is not `wss:` (plain `ws:` only on a loopback address). A code naming another agent key than the one an existing
     entry for that relay trusts is refused: taking it would re-pin the entry to a key whoever
     made the code may hold. Remove the entry first when a machine's identity really changed.

The link carries everything in its fragment (`https://<pwa>/#pair?u=<relay URL>/<account>&k=<agent
key>&s=<secret>&n=<machine name>`), which a browser never sends to any server; the PWA takes it
off the address before it connects. The secret stands in for the token: the phone proves it to
the relay's gate and to the agent the way it proves the token (below), and never sends it in the
clear. A paired entry has no token at all: once its device key is enrolled, that key is what the
agent accepts, and the phone forgets the secret (below, "The phone forgets its credential").

### The join key

One shared secret per relay (32 random bytes, base64url) that lets a machine register itself. It
never travels: each join carries the agent's own signature *and* an HMAC under the join key, both
over the account, the role and the time, so a captured header is useless for another account,
another action, or a minute later. The account must be the one derived from the key it registers,
so nobody picks an account id.

| | Self-hosted relay | Cloudflare Worker |
|---|---|---|
| Where it lives | `joinKey` in `~/.perch/relay/config.json` | the `JOIN_KEY` secret, from `RELAY_JOIN_KEY` in main's `deploy/relay-cf.env` |
| Create it, and print the machine command | `pnpm perch-relay join-command --url wss://<how machines reach it>` creates the key when there is none (then restart the relay) and prints the command | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` into `RELAY_JOIN_KEY`, deploy, then `(. deploy/relay-cf.env && echo "PERCH_JOIN_KEY=$RELAY_JOIN_KEY pnpm perch connect wss://${RELAY_DOMAIN:-$RELAY_HOST}")` |
| The admin key | `adminKey` in the same file: `pnpm perch-relay admin-key` creates it when there is none (then restart the relay) and prints it | the `ADMIN_KEY` secret, from `RELAY_ADMIN_KEY` in main's `deploy/relay-cf.env` (made like the join key), uploaded by the deploy |
| List the machines | `pnpm perch-relay machines list` (reads `adminKey` from the config) | `PERCH_ADMIN_KEY=<admin key> pnpm perch-relay machines list --url wss://<relay>` |
| Remove one | `pnpm perch-relay machines remove <account>` | the same, with `--url` and `PERCH_ADMIN_KEY` |
| Let a removed one join again | `pnpm perch-relay machines allow <account>` | the same, with `--url` and `PERCH_ADMIN_KEY` |

Both hosts answer the same HTTP API (`POST /<account>?role=join&key=…`, `GET /?role=machines`,
`POST /<account>?role=remove`), so `perch-relay machines` administers either. **Listing and
removing take the admin key, never the join key**: the join key is handed to every machine that
joins, so it only registers accounts of its own. Both keys sign the same way (an HMAC in the
`x-perch-join` header, bound to account, role and time); a relay without an admin key answers
`501` to `machines`, `remove` and `allow`. `--admin-key` works too, but shows in the process list. A removed machine's
control socket and pairs are closed at once (`4004`) and its account answers `404` again; its
agent keeps retrying with backoff until its URL is taken out of its `agent.env`.

**A removed account stays removed.** The registry keeps it on a deny list, and a join for it is
refused with `403` whatever proofs it carries: an operator removes a machine because its agent key
may be stolen, and the thief then holds the join key too, since every machine does. Only the admin
key lifts it (`perch-relay machines allow <account>`, `POST /<account>?role=allow`); the machine
then joins again with `perch connect` as before. `machines list` shows removed accounts with the
day they were removed. The list only holds removals made since it existed: **an account removed
from the Cloudflare Worker before its version `4d3f7079` is not on it** (nor one removed from a
self-hosted relay older than the deny list), and if its key may be stolen, nothing stops it
joining again until it is removed once more (join it, or wait for the thief to, then remove it).

**Rotating the join key:** write a new one (the self-hosted relay: delete `joinKey` and run
`join-command` again, then restart it; the Worker: a new `RELAY_JOIN_KEY`, then deploy), and
re-run `perch connect` with it on each machine that should join again. Rotation only closes the
door to new machines: machines already registered stay served until removed.

### The account registry

The accounts a relay serves live in a registry that only joins and removals change, with no
redeploy: the Worker keeps them in one SQLite Durable Object (`RegistryRoom`, migration `v2`), the
self-hosted relay in `~/.perch/relay/accounts.json` beside its config, written only by the relay
process. A machine gets in with `perch connect` and the join key; there is no list of accounts to
edit by hand. An unknown account is refused with `404` before any per-account state exists: the
registry is asked first.

The Worker caches a found account for 60 s per isolate, for every role, so the phone's challenges
and upgrades and the agent's dial-backs do not reach the single `RegistryRoom`. A removed account
cannot come back through a stale entry: a control socket whose signature checks out against the
cached key is confirmed with the registry before it is accepted (a forged one never gets that
far), and the account's own `RelayRoom`, once evicted, refuses every role as unknown until the
account joins again, whatever a stale entry let through. A miss is cached for 10 s per isolate,
so a *repeated* guess reaches the registry once per isolate per window; a *distinct* guess is a
new miss and does reach it (see "Challenges, enrolment dials and misses" for that limit). Hits
and misses are held apart (4096 of each per isolate), so a flood of guesses evicts only misses,
never the owner's hit. A machine that has just joined is found at once through the isolate that
took its join, and within 10 s through any other (its agent's control socket retries with
backoff meanwhile).

## Hosts

| | Cloudflare Worker | Self-hosted relay |
|---|---|---|
| Code | `packages/relay-cf` (Worker + one Durable Object per account) | `packages/relay` (`perch-relay`, Node + `ws`) |
| Runs as | Worker `perch-relay` on `RELAY_DOMAIN` (`RELAY_HOST` without one) | user service `perch-relay` on a machine, from `deploy/relay-live` |
| Configured by | the `JOIN_KEY` secret (and the optional `ADMIN_KEY`), uploaded from main's `deploy/relay-cf.env`; accounts in the `RegistryRoom` Durable Object | `~/.perch/relay/config.json`; accounts in `~/.perch/relay/accounts.json` |
| Deployed or flipped by | `deploy/relay-cf-deploy.sh` from a clean main | `pnpm serve:relay <worktree>` / `serve:relay-restore` |
| Reachable at | `wss://<RELAY_DOMAIN>` | `ws://127.0.0.1:8450` on the machine itself; elsewhere through whatever fronts it, e.g. `wss://<machine>.<tailnet>.ts.net:8451` |

**No permanent dev Worker.** wrangler's `env.dev` (Worker `perch-relay-dev`) stays in
`wrangler.jsonc` for a throwaway deploy, on demand; see "Development flow".

**One contract.** `packages/relay/src/conformance.ts` is the relay's behaviour written as one
test suite: agent authentication (401 unsigned, forged, stale, wrong role or dial id), unknown
account and route (404), `/up`, 426 without an upgrade, 503 with no agent, the device gate
(single-use challenges, 4401 for a reused, tampered or another account's one, an earlier one
still valid after many more were handed out, 4403 for an unknown or revoked key, a
closed enrolment or a token proof while token enrolment is off, an enrolment proof handed to the agent and refused at once, with its reason,
when it says so, a client without a device key refused once a policy is published (whatever an
older agent's `anonymous` says), the policy outliving the control socket, enrolment dials past the account's budget refused with 4429), every phone refusal made in band (see "How a refusal reaches the phone"), pairing and
forwarding (text stays text, binary stays binary), close codes carried across a pair, a closed
or superseded control socket failing its waiting clients (503, old socket 4000), the dial
timeout (504, then 404 for the late dial), the pending and total caps (429), the heartbeat, and
the frame limit (1009 on both sides), joining (both proofs, `401` for a wrong key, `400` for an account
not derived from its key), the registry (list, remove with the admin key and never the join key,
`4004` for the removed account's sockets, `404` afterwards, a removed account refused a join with
`403` until the admin key allows it again), the join rate limit (`429` per client address, never another address's),
the agent's own refusal reasons carried to the phone (including its "too many enrolment attempts"),
and dial ids and challenge nonces minted in the characters the agent accepts (`[A-Za-z0-9_-]`, at most 128).
The Node server runs it over real sockets
(`server.conformance.test.ts`), the Worker under the Workers vitest pool
(`relay-cf/test/conformance.test.ts`), each with small limits so it runs in seconds. A change
to either host goes through that suite; a behaviour only one host can have is a bug in the other.

Two things the suite pinned down that are easy to undo:

- **A text `ping` is the heartbeat on every socket, answered `pong` and never forwarded.** The
  Durable Object answers it in the runtime (`setWebSocketAutoResponse`, what lets the room
  hibernate while the agent's heartbeat runs), and that applies to all its sockets alike, so the
  core does the same on Node. Relay traffic itself is binary Noise frames, so nothing is lost.
- **The Node server refuses an oversized frame before buffering it** (`ws` `maxPayload` at one
  Noise frame, where `ws` would otherwise take up to 100 MiB) and closes the partner with the same
  1009 the core sends.

What it is made of:

- `packages/secure-channel`: Noise_IK_25519_ChaChaPoly_SHA256 (prologue `perch-relay-noise-v3`,
  handshake flag `0x03`), checked against the published cacophony test vector. Chunked framing
  with the chunk flag authenticated, agent and device keys, the agent's signed relay
  authentication, the device's challenge signature, enrolment proof and hello proof, stateless
  relay challenges, and the zod-parsed
  control messages between relay and agent. The phone, the agent, the relay and the verify
  client all use it.
- `packages/relay`: the host-agnostic core. It pairs each client socket with a socket the agent
  dials back (or a spare it opened ahead, see "Spare dial-backs"), looks sockets up in a directory port so a hibernating host can run it, caps what
  one account can hold, authenticates the agent role, and gates clients by device key against
  the policy the agent publishes (kept behind a small store port: memory on Node, the Durable
  Object's KV on Cloudflare). The Node server runs it over `ws`; `scripts/verify.ts` plays the
  phone for verification.
- `packages/relay-cf`: a Worker that routes each account to one `RelayRoom` Durable Object
  holding the agent's control socket and every client/dial-back pair on hibernatable
  WebSockets.
- Agent: a relay identity (`~/.perch/relay-key.json`), `perch relay-key`, signed relay upgrades,
  a control heartbeat, the device roster (`~/.perch/devices.json`, `perch devices`), and a Noise
  responder in front of `ConnectionHandler` for every relay-dialed socket.
- PWA: a **device key** created on first use, and a **relay machine** entry. It is reached only
  through the Noise session pinned to the agent's key, and never in plaintext.

## Spare dial-backs

A dial-back puts the agent's whole connect to the relay (TCP, TLS, the upgrade) on the phone's
critical path, after the relay has asked for it over the control socket. On a long or lossy path
to the relay that is a third or more of a phone's connect, and the agent's TLS handshake stalling
is what turns a slow connect into a 504. So while its control socket is open the agent keeps one
**spare**: `?role=spare` with an id of its own in the dial header, signed for role `spare` and
that id. The relay files it as the agent side of a pair whose client has not arrived (at most 2
unpaired per account, 429 past that; 409 for an id already in use). The next admitted client that
needs no enrolment check is accepted against it at once: the relay sends the text `paired` on the
spare, then forwards frames as for any pair. The agent hands the socket to its Noise responder,
dropping text frames from then on (a heartbeat answer may still be on its way), and opens the
next spare. Until paired, the spare carries only the agent's `ping` (with each control heartbeat)
and the relay's `pong`; anything else closes it.

Enrolment dials never use a spare: the agent checks the proof before it dials. A relay that
predates spares answers `role=spare` 404, and the agent retries a spare that never opened after
5 s, doubling up to 15 minutes, so every phone is dialed for as before. A spare goes with the control
socket on both sides: the agent closes its spare when its control socket closes, and the relay
closes the unpaired ones when a new control socket takes over, since an agent that redials after
its path stalled left its old spare open there until the host notices. A spare whose own path dies while
the control socket stays up is still taken for one phone, which waits out its connect deadline;
that phone's close then closes the spare, and the agent has opened another by then. Spares live
under their own pair tags (`spare.<id>`), never a dial id's, so the agent socket of a dialed pair
whose phone is still closing is never taken for one.

## Device keys

Every installed PWA holds its own device identity: an X25519 key (its Noise static key) and an
Ed25519 key (it signs the relay's challenges), both in IndexedDB. Where the browser has the
curves in WebCrypto (Chromium; Safari from 18.4 for X25519, from 17 for Ed25519) the private
halves are non-extractable `CryptoKey`s, which the page can use and never read; elsewhere they
are noble keys stored as bytes. A WebCrypto key is kept only if it derives or signs once when
created, and if IndexedDB refuses to store the `CryptoKey`s, both keys become noble keys, since
IndexedDB can always store raw bytes. Settings → Diagnostics shows the key's fingerprint, which
storage each curve got, and why a curve fell back to a stored key. When no identity can be
loaded or created, Diagnostics shows "Device key unavailable: <cause>", and every relay machine
fails with "device key unavailable: <cause>". That happens when IndexedDB will not open, or when
the stored record cannot be read. Nothing then makes a key for that launch alone, which would
enrol a new device on every launch, and nothing replaces a stored identity. The installed
origin never changes, so neither does the key: updates
and worktree builds keep it, and nothing is ever re-paired. Clearing the site's data makes a new
one.

A relay connection then goes:

1. The phone fetches a single-use nonce: `GET https://<relay>/<account>?role=challenge`.
   No nonce (a network error, a refusal, a hung fetch aborted after 5 s) fails the attempt, and
   the phone's backoff retries it: an upgrade without one would be refused for good (4401).
2. It upgrades with `?device=<Ed25519 key>&nonce=…&sig=…&proof=…`: the signature over the
   nonce, and an enrolment proof, a MAC under a key derived from the token. The token itself
   never leaves the phone, and neither does anything the relay could use to derive it.
3. The relay admits a key the agent's policy lists, refuses a revoked one (4403), and passes an
   unknown one along only with a proof, in the dial; the agent checks the proof and dials back,
   or tells the relay to refuse, and why (4403 at once). An admitted key with no proof to check
   is paired at once with the agent's spare dial-back when one is filed, with no dial at all. Without a proof, with enrolment closed,
   or with a proof the phone says it made with the token while token enrolment is off: 4403, and
   the agent never hears of it.
4. The phone runs IK, whose first message carries its X25519 key and a hello: its Ed25519 key, a
   name, and a proof, an Ed25519 signature over its X25519 key and the handshake hash the hello
   is sealed under. The agent looks the X25519 key up in `~/.perch/devices.json`, whatever the
   relay decided: an enrolled key is served; a revoked one is closed with 4003 before the
   handshake is answered; a first message sealed for another agent key (the entry pins the
   wrong one) is closed with 4003 "wrong agent key", and nothing is sent; an unknown one without a valid proof is closed with 4003 ("device
   signature invalid"), so no phone can name another phone's relay key, nor replay a proof from
   another session. An unknown one may then send `auth` and nothing else, and a token the handler
   accepts enrols it (trust on first use, gated by the token) while enrolment is `on`. The name is
   shown as sent, with control characters and bidi overrides replaced, in the journal and in
   `perch devices`.

Until its `auth` is accepted a session reads messages of at most 8 KiB (32 MiB after), a socket
that sends `auth` more than three times is closed, and one that has not authenticated within
10 s is closed (`4002 authentication timeout`). A frame whose flag is not IK's (`0x03`), such as
the retired NK handshake's, fails at once with 4002.

A **pairing secret** (`perch pair`) takes the token's place in steps 2 and 4: the proof is a MAC
under a key derived from the secret, and the phone's `auth` carries the secret inside the Noise
session. The relay's gate only checks the proof against the live secrets, and spends nothing
(the handshake that follows may still fail); the agent spends the secret atomically at that
`auth`, before its `authResult ok` enrols the key, so two phones racing with one code cannot both
get in. An already-enrolled device that presents a live secret (it opened a pairing link) spends
it too: it needs no code, but a code left live would admit whoever else holds the link. A spent
secret is bound to the device that spent it, so that device presenting it again is not a second
use, and the agent logs `pairing code used by device <fingerprint>`. Secrets live in
`~/.perch/pairing.json` (0600), one use and ten minutes each; enrolment `off` still takes them
(it refuses only the token), `closed` refuses them too. A spent or expired secret stays in the file for a day, marked
(`usedAt`, and a spent one's `expiresAt` moved to the moment it was spent, so an agent from
before this reads it as expired), so a phone that presents it is told which.

### How a refusal reaches the phone

A browser learns nothing from a refused WebSocket upgrade: whatever the status and body, its
socket reports 1006, which reads as a network failure. So the relay refuses a phone **in band**:
it completes the upgrade, files nothing, and closes the socket at once with `4000 + the HTTP
status` and a short reason (`REFUSAL` in `packages/secure-channel/src/refusal.ts`). The agent's
own refusals inside a session (4003) use the same words. The agent's roles keep plain HTTP
refusals; so does the self-hosted relay's per-address connection cap (a flood is cheaper to turn
away before an upgrade). The PWA maps each reason to a message on the entry and on the home
screen (`core/refusal.ts`), and stops redialing when retrying cannot help.

| Refusal | Close | Phone says | Agent logs |
|---|---|---|---|
| Pairing code expired | 4403, or 4003 at `auth` | This pairing code has expired — run `perch pair` on <machine> for a new one | its pairing code expired 49 s ago |
| Pairing code already used | 4403, or 4003 at `auth` | This pairing code was already used — run `perch pair` … | its pairing code was already used |
| Unknown pairing code | 4403 | Pairing refused: the code is not valid for this machine — run `perch pair` … | its pairing code is unknown (not one this agent issued in the last day) |
| Wrong token | 4403 | <machine> refused the token — check the token in this entry | its token proof did not verify (a wrong token) |
| Revoked device | 4403 at the relay, 4003 at the agent | This phone was revoked on <machine> | the device is revoked |
| Token enrolment off (`enrolment off`) | 4403 at the relay, 4003 at `auth` | Enrolment is turned off on <machine> — pair with `perch pair` instead | token enrolment is off (only a pairing code enrols) |
| Enrolment closed | 4403 at the relay, 4003 at `auth` | Enrolment is closed on <machine> — run `perch devices enrolment off` there to allow pairing | enrolment is closed (when the agent is asked) |
| Unknown key, no proof (or, at the agent, no credential) | 4403, or 4003 at `auth` | This phone is not enrolled on <machine> — run `perch pair` there … | — |
| Token sent by an enrolled key | 4003 at `auth` | <machine> no longer needs this entry's token: its device key is enrolled — forgetting the token and reconnecting (redials) | — |
| Entry pinning another agent key than the machine's | 4003 | This entry's agent key is not <machine>'s — pair this machine again | — |
| Unknown key whose hello does not prove its relay key | 4003 | <machine> could not verify this phone's device key — run `perch pair` there for a new code | — |
| Too many enrolment attempts on the account | 4429 | Too many phones are asking to pair with <machine> right now — retrying (redials) | — |
| Bad device signature / device key required | 4401 | The relay refused this phone: … | — |
| Stale challenge | 4401 | The relay refused this phone: its sign-in challenge had expired — retrying | — |
| Unknown account | 4404 | The relay does not know <machine> — run `perch connect` on it again | — |
| Agent offline, did not dial, busy, relay error | 4503, 4504, 4429, 4500 | <machine> is not connected to the relay, … (redials) | — |

The phone tells the agent which credential its proof was made with (`cred=pairing|token`,
unchecked, passed along in the dial) only so the log can name the failure; the phone words it
from its own entry. What a reason gives away: a device's standing is said only after a
signature by that device; a code's fate (expired or used) only to a proof made with that code,
so only its holder learns it, and the code is single use and short-lived. The one exception is
"enrolment closed" and "enrolment off", said to anyone who signs with a key of their own (the
second to a phone that says its proof is a token's): they name a setting, not a
device or a credential, and asking the agent to check the proof first would cost it a dial per
stranger. The agent logs a refusal at most once a minute per reason, so a stranger's stream of
bad proofs cannot hide the owner's expired code.

**An enrolled key authenticates its session on its own.** A relay session whose IK key was
enrolled at the handshake, or which has just spent a pairing secret, is accepted without the token
(a paired phone has none). The token still enrols an unknown key while enrolment is `on`.

**The phone forgets its credential.** The agent's `authResult` says what authenticated the
session (`credential`: `device`, `pairing` or `token`) and whether the device key is now enrolled
(`enrolled`). For a new device the answer waits until the roster is written, so `enrolled` means
written. On `enrolled` the PWA drops the entry's token and pairing secret, and the connection
sends neither again. A key enrolled at the handshake that still sends the token is refused with
4003 "token not needed": the phone redials at once without the token, and forgets it when that
session's `authResult` says the key is enrolled, so an entry from before this heals on its next
connect. The close itself travels outside the session, where the relay could forge it, so it
never erases anything on its own; a redial refused as not enrolled sends the token again. A
pairing secret is dropped on `enrolled`, not on going online: an agent that could not write the
enrolment answers `enrolled: false`, and the phone keeps the code to try again. An unknown key that offers no credential at all (a paired phone
whose enrolment was lost) is told it is not enrolled, whatever the enrolment mode.

The agent publishes the roster to every relay (enrolled and revoked Ed25519 keys, whether
enrolment is open at all and whether the token may enrol) when a control socket opens and whenever the
roster changes, and polls the file every 3 s so an edit from the CLI lands within seconds. The
relay answers `applied`; until it does, the agent publishes again with every heartbeat (20 s).
That matters on Cloudflare: a deploy keeps the hibernated control socket open, so the new code
starts with no policy for an agent that published to the old one.

```bash
perch devices                    # enrolled and revoked devices, and the enrolment setting
perch devices revoke <id|key>    # refuse this key at the relay and the agent; closes its sessions
perch devices forget <id|key>    # drop it from both lists: it can enrol again
perch devices enrolment on       # the token or a pairing code enrols a new phone (the default)
perch devices enrolment off      # only a pairing code from `perch pair` enrols one
perch devices enrolment closed   # no new phone can enrol; only listed devices get in
```

An id is the first 48 bits of the key's hash, so two keys could be made to share one. The agent
refuses to enrol a key whose id is already in the roster, and `perch devices` prints each full
key, which `revoke` and `forget` also take. If enrolment is turned `off` or `closed` between a
phone's handshake and its `auth`, the roster declines the enrolment and the agent closes the
session with that refusal rather than serve it.

A pairing code is minted on the machine by its operator, so it stays an explicit authorisation
while token enrolment is off; `closed` is for a machine that should take no new phone at all.
The mode lives in `devices.json` as `enrolment` (false only when closed, the meaning it always
had) and `tokenEnrolment`, so an agent from before the modes still reads the file, and treats
`off` as `on` until it is restarted.

(`perch` is `pnpm --filter @perch/agent exec tsx src/cli.ts` from a checkout.) An `<id>` is the
fingerprint Settings shows, or an unambiguous prefix of it.

**Revoking a lost phone.** `perch devices revoke` stops that phone's key, and it is a deny list,
not a deletion. A phone forgets the token once its key is enrolled, so a lost phone normally holds
none; one that still does is an entry added by hand that has not connected to an agent since
phones began forgetting it. With the token, while enrolment is `on`, it can enrol a *new* key
(after clearing the PWA's site data). If that is possible, keep enrolment `off` (pairing codes
only) or rotate the token.

**NK is retired.** Phones without a device key (Noise NK, token only) are no longer served: the
agent takes IK only, and the relay refuses a client without device parameters (4401, "device key
required") once the account's agent has published a policy. `PERCH_RELAY_ALLOW_NK` in
`deploy/agent.env` is ignored, with a startup warning to remove it.
`journalctl --user -u perch-agent | grep 'relay client'` shows every relayed connection as
`device <fingerprint> "<name>" <standing>`.

**Secret files must be private.** At startup the agent makes `~/.perch` 0700 and refuses to run
while `relay-key.json`, `devices.json`, `pairing.json` or `token` there can be read or written by
another user: it exits naming each file and the `chmod 600 <path>` that fixes it. The self-hosted
relay does the same for its directory, `config.json` and `accounts.json`. So does the agent for
`deploy/agent.env`, which holds `PERCH_TOKEN` (`run-agent.sh` names it in `PERCH_AGENT_ENV`), and
`deploy/relay-cf-deploy.sh` for `deploy/relay-cf.env`, which holds the Worker's join and admin
keys. `perch connect` leaves `agent.env` 0600 when it rewrites it. No process the agent starts
(tmux, the terminal's pty, agent-browser, git, gh, systemctl) inherits a `PERCH_` variable: a
tmux server copies the environment of the client that starts it to every pane, and an agent that
started tmux once handed `PERCH_TOKEN` to every workspace that way. The loopback `POST /hooks` compares its bearer token in constant time and refuses a
body over 1 MiB (413). That token is not `PERCH_TOKEN`: the agent writes a fresh hooks-only secret
to `~/.perch/token` at each start, and `perch-hook.sh` hands it and Claude's payload to curl
through a header file and stdin, never its command line.


## Threat model

The relay is Cloudflare running this Worker (self-hosted: whoever runs the host). Who can do what:

| Attacker | Outcome |
|---|---|
| Passive network observer | TLS to Cloudflare, Noise inside. Sees nothing. |
| Cloudflare, or whoever controls the Worker or its account | Sees account ids, the agent's public keys, client and agent IPs, timing, frame sizes, connection counts. **Cannot read terminal traffic or the token**: every frame between phone and agent is Noise ciphertext, and `auth` is sent only after the handshake. Cannot pose as the agent to the phone, since it has no X25519 private key. **Cannot alter the stream undetected**: each frame's payload and its chunk flag are authenticated and numbered, so a modified, reordered, replayed, merged or re-segmented frame fails authentication and the session closes (4002 on the agent, "secure channel failed" on the phone). It **can** deny service: drop or delay frames, or close the connection. A dropped frame stops the session at the next one (the counter no longer matches); frames lost at the very end of a stream before a close are lost, but visibly, as a disconnect, never merged into a neighbour. It can also spend the agent's resources, within bounds the agent keeps itself, whatever the relay does: at most 32 dial-backs per relay link that have not authenticated (each holds its slot from the dial until its `authResult` goes out or its socket closes), each closed by the 10 s auth deadline, and its socket let go 1 s after the close frame whether or not the relay answers it; a spare the relay pairs takes one of those 32 slots like a dial, the agent keeps one spare per link and opens the next only once it is paired (past the cap, it closes the spare and waits 5 s); no compression on any relay socket; before `auth` is accepted a session reads messages of at most 8 KiB and three `auth` attempts; one IK handshake per socket, costing a roster read, a DH and a signature check; enrolment checks (a roster read, a pairing-file read and a key derivation each) at most 4 at once and 10 a minute per relay link, refused past either without reading anything; a made-up pairing secret takes no file lock. Dial ids are token characters only, so none can write lines into the agent's journal. What remains: an enrolled phone's session, which the relay can only forward, reassembles messages of up to 32 MiB. |
| Stranger who knows the relay host and an account id (both are in the phone's URL, not secrets) | Can fetch challenges and sign them with a key of their own. The relay refuses that key (403) without asking the agent: it is not in the published policy, and there is no enrolment proof without the token. A client without a device key is refused too (401). A made-up proof is forwarded in a dial and refused by the agent (403 at once); it holds a pending slot only while the agent checks it, and the agent dials nothing. Such dials are capped at 10 a minute per account (4429 past it; the window is kept in the account's storage, so a Durable Object waking from hibernation does not start a fresh one), so a stream of them can hold the owner's pairing off for up to a minute. While enrolment is not `closed`, such a probe also tells whether the account's agent is online: the relay answers `4503 agent offline` itself when no control socket is open, and forwards the agent's refusal when one is (an accepted limit, below). |
| Stranger exhausting an account's slots | Only a key the policy lists, or a proof on its way to the agent (within the enrolment budget above), reaches a slot; everything else is refused before one. Challenges are stateless: each costs the Worker a Durable Object request (and a registry lookup only when the isolate has not seen the account in the last minute) but writes nothing, and no number of them pushes the owner's out. A used nonce is remembered until it expires, and expired ones are swept at most once a second, so a flood of upgrades costs the relay linear CPU, not quadratic. On the self-hosted relay a refused phone's socket is cut 1 s after its close frame whether or not the client answers it, so a client that never answers holds its connection slot that long, not until the heartbeat. Caps that hold throughout: at most 8 clients waiting for a dial and 16 sockets per account; a 10 s dial timeout; a frame over one Noise message (65 536 bytes) closes the pair; a message reassembles to at most 32 MiB in at most 513 chunks. |
| Cloudflare, or whoever runs the relay, with respect to devices | Sees each device's Ed25519 key, the published policy, and the enrolment proof in the upgrade URL. It can admit anyone past its own gate (it *is* that gate), but the agent checks the IK key against its own roster, so that gains nothing. The proof is a MAC under a key derived from the token: it lets someone who sees it test token guesses offline, which is harmless for the 32 random bytes `DEPLOY.md` generates and would not be for a weak hand-picked token. |
| Stranger posing as the agent | Refused at the upgrade (401): the control socket and every dial-back must carry an Ed25519 signature over account, role, dial id and time, checked against the public key the relay's registry holds for the account. Without that key nobody can register as the agent or supersede it. |
| Stranger guessing account ids | 404 before any per-account state exists: the Worker asks its one registry Durable Object (`RegistryRoom`), and caches the miss for 10 s per isolate, so a repeated guess does not reach it again; no account object is created for a guess. **Every distinct guess does reach the `RegistryRoom`**, one object for the whole relay: a flood of them past what it serves (Cloudflare's documented soft limit for one object is about 1,000 requests a second) makes it answer "overloaded", and then every account whose isolate has no cached hit fails at once (`500`), the agents' control reconnects included. Accounts already cached keep working, challenges included. The zone rate-limiting rule bounds the flood per address on the custom domain, the Worker's only host when one is set; a relay with no custom domain has no such rule (an accepted limit, below). The self-hosted relay answers from memory. |
| Replayed agent `Authorization` header | Only the relays ever see it (TLS ends there). It is valid for ±60 s and only for the same role and dial id (a spare signs its own role and the id the agent picked, so a dial's header cannot open one, nor a spare's a dial). **It does not name the relay**, and one agent key is the same account on every relay, so one relay of an agent's can replay a header it was sent on another within that minute: an `agent` header supersedes the control socket there, and a `spare` header files a socket that relay's next phone may be paired with. Either way the replaying relay can only drop or forward ciphertext (the phone pins the agent's key), which any relay in the path can do anyway; binding the header to the relay's origin would close it, and is a wire change. |
| Phone configured with the wrong agent key | Handshake fails and nothing is sent: the agent cannot open the phone's first message, closes with 4003 "wrong agent key", and the phone says "This entry's agent key is not <machine>'s — pair this machine again" and stops redialing until tapped. The close travels outside the session, so a relay could also forge it (as it could any close) to stop an entry redialing; that is denial of service, which it can do anyway. "Agent key mismatch" is shown only when an answer to the phone's first message does not come from the pinned key: an impostor answering, never the real agent. |
| Relay entry with no key, or its key cleared | Never connects. Settings shows "relay machine has no valid agent key — not connecting". The entry stays a relay entry: nothing turns it into a direct one that would send the token in plaintext. Add machine refuses a relay entry without a valid 32-byte key. |
| Stolen phone | Holds its device key and the agent's public key; a token only if its entry was added by hand and has not connected since phones began forgetting it. `perch devices revoke` refuses the key at the relay and the agent and closes its live sessions within seconds, without touching the other phones. A token on it still enrols a new key while enrolment is `on`, so then keep it `off` or rotate the token. |
| Stolen or leaked token, without a phone | While enrolment is `on`: enrols a new device key from any network, like a new phone would. With enrolment `off` or `closed`: the relay refuses a proof made with it, and the agent refuses it at the dial and at `auth`. It never authenticates a key already enrolled (4003 "token not needed"). |
| Stranger who knows only the relay host | Cannot register a machine: a join needs the join key (`401` without it, and every attempt counts against a per-address limit of 10 per 10 minutes, `429`), and the account must derive from a key the joiner holds. Cannot list or remove machines: that takes the admin key, with the same limit. Guessing either 32-byte key is hopeless. |
| Another local user on an agent machine | Can read every process's command line, but not another user's environment (`/proc/<pid>/environ` is the owner's only). The hook script puts neither its secret nor Claude's payload (prompts, tool output) on a command line: both reach curl through a header file and stdin. The secret it sends is a hooks-only one the agent replaces at each start, which can set a workspace's status and nothing more. `PERCH_TOKEN`, which enrols phones, is on disk only in `deploy/agent.env`, which the agent refuses to start with while another user can read it, as it does for the files in `~/.perch`. The token alone enrols nothing without the agent's public key and account id, but those are no secret. |
| Code running in a workspace (Claude, its tools, a dependency's install script, a dev server) | Runs as the agent's user, so it can read `deploy/agent.env` and `~/.perch` on purpose: the agent cannot defend against its own user. What it no longer gets is the token by accident: no process the agent starts inherits a `PERCH_` variable, where a crash report, a log line, an `env` printed into a transcript or a build that inlines `process.env` would have carried it off. A tmux server an older agent started keeps the environment it was started with: `tmux set-environment -g -u PERCH_TOKEN` (and the other `PERCH_` names) stops new panes inheriting it, and open panes keep theirs until they close. |
| Another local user on a machine running `perch connect --key` | Sees the join key in the process list while the command runs. `PERCH_JOIN_KEY` keeps it out, as `PERCH_ADMIN_KEY` does for `perch-relay machines`. |
| Captured join or admin header | Only the relay sees it (TLS ends there). It binds the account, the action and the time (±60 s), so it cannot register another account or remove one; replayed within the minute it repeats the same, idempotent action. |
| Leaked join key | Anyone can register accounts of their own on the relay, and use it as a relay for their own agents, until the key is rotated and those accounts removed (`perch-relay machines`, with the admin key). It reaches no existing account: an account belongs to whoever holds its agent key, registering the same account again changes nothing, a removed account cannot be registered again (`403` until the admin key allows it), and the join key cannot list or remove accounts. |
| Leaked admin key | Anyone can list the accounts (ids, agent public keys, when each joined) and remove any of them, which closes its sockets and cuts its phones off until its machine joins again. It registers nothing and reads no traffic. Rotate it (a new `adminKey` / `RELAY_ADMIN_KEY`, then restart or deploy). |
| Leaked pairing link or QR code, within its ten minutes | Enrols one device with the machine, like the token would: whoever scans it first gets in and the code is then spent. After ten minutes, or once used, it admits nobody. Treat a code like the token for its lifetime: show it only to the phone being paired, and `perch devices revoke` a device paired by mistake. |
| Stolen phone that paired (no token on it) | Holds its device key, which is now the whole credential for its relay entry. `perch devices revoke` refuses it at the relay and the agent within seconds, as before; with no token on the phone, it cannot enrol a new key afterwards. |
| Device key that is extractable | Where IndexedDB will not keep a `CryptoKey` (it refuses one, or returns something else when read back), the device keys are stored as raw bytes in IndexedDB, readable by any script on the PWA's origin. Since an enrolled key now authenticates on its own, that key is the phone's whole credential; the PWA's origin (served from the tailnet) is what protects it. Settings → Diagnostics says which storage each key got. |
| Removed machine | Its control socket and pairs close at once (4004) and its account answers `404`. It cannot join again, even with its agent key and the join key (`403`), until the admin key allows it (`perch-relay machines allow`). On the Worker, a request answered from an isolate's cache in the next 60 s, or an agent upgrade already past the registry when the account was removed, reaches the evicted `RelayRoom`, which refuses it as unknown (`404`, a phone `4404`) and writes nothing back. |
| Revoked device reconnecting | 403 at the relay; a relay that let it through anyway (an old relay, or a compromised one) meets 4003 at the agent before the handshake is answered. |
| Stolen `~/.perch/relay-key.json` | Can pose as the agent to the relay and to phones: the relay keeps the latest control socket, and the real agent, superseded, waits 1 to 15 minutes before taking it back. Phones then open their sessions with the impostor, which sees what they type and can show them anything. A phone whose key is enrolled sends no token; one that still holds a token or a pairing secret sends it on its first connect. **A stolen agent key means a new identity, a new token, new phone entries and a new join key**, on every relay the machine used: `perch-relay machines remove <old account>` (the old account then stays on the relay's deny list, so the thief cannot join it again with the join key, which it likely holds too: every machine has it); rotate the join key ("Rotating the join key" above) and re-run `perch connect` on the other machines with the new one; on the stolen machine move the file aside, set a new `PERCH_TOKEN` and `perch connect` again (a new identity, so a new account); then on **every phone delete the old entry** for that machine (a re-pair adds a new entry beside it, and the old one keeps retrying the old account) and pair it again. Never `machines allow` the old account. |
| Compromised agent machine | That machine only. It can send the phone anything, but nothing it sends runs as script on the PWA's origin, which holds every machine entry and the device keys: a media preview's Blob takes the type its path implies (a reply naming another type is refused), and the PWA's Content-Security-Policy runs no script but the app's own bundle, which a blob document inherits. A rendered markdown file loses its scripts, inline styles and forms, and loads no remote image. It can show a pairing link in the terminal; tapped, it is paired only after the owner confirms the relay host and machine key it names, and adds an entry for a machine it runs, which reaches no other machine. |

Accepted limits:
- The relay sees metadata, can deny service, and can spend the agent's resources within the
  bounds above.
- A relay can replay a phone's device signature, and an enrolment proof, at another relay that
  serves the same account: neither names the relay, and the account id is the same on every
  relay. The replaying relay hands the phone a challenge it fetched from the other one, then
  presents the phone's signature there. That needs the other relay to be reachable from the
  first (a tailnet-only relay is not), and buys one pending slot there (and one of its
  enrolment dials, for a proof) per phone connect, until the agent's 10 s handshake deadline:
  the replaying relay holds no X25519 key, so it gets no further than the agent's IK check.
  Binding the relay's origin into what the phone signs would close it, at the cost of a
  wire-format change; denial of service is all it buys, and a relay can deny service anyway.
- On the Worker, a flood of distinct guessed account ids reaches the one `RegistryRoom` and can
  overload it, failing every account not cached in the isolate that serves it ("Stranger guessing
  account ids"). The zone rate-limiting rule bounds it per address. It needs a custom domain, which
  is then the Worker's only host (`env.production` turns the `workers.dev` host and preview URLs
  off). A relay deployed without one answers on its `workers.dev` host alone, which no zone rule
  can cover, so nothing bounds the flood there.
- A stranger who knows an account id can tell whether its agent is online, to the second, while
  enrolment is not `closed`: a made-up enrolment proof gets `4503 agent offline` from the relay
  itself when no control socket is open. Hiding it would mean telling the owner's own pairing
  phone something other than "not connected". Each probe spends one of the account's enrolment
  dials.
- A stranger with made-up proofs can hold an account's enrolment budget, and so the owner's
  pairing, for up to a minute at a time.
- Enrolment is trust on first use, gated by a pairing secret, or the token while enrolment is
  `on`: whoever holds one can enrol a device. Pairing is per machine: each machine's own
  `devices.json` is the roster, and a phone pairs with each machine separately. A signed roster
  across machines is a later step.
- Join-key requests are counted per client address in memory: the Worker's count lives in the
  registry object and restarts if that object is evicted; behind `tailscale serve` every client
  of the self-hosted relay shares one address, so one budget. Both hosts count an address a proxy
  reports (the Worker's `cf-connecting-ip`, the Node relay's `clientIpHeader`) by its /64 for IPv6
  and as its IPv4 address when it is IPv4-mapped (`address-key.ts`); a direct peer counts as itself.
- Where people without a tailnet load the PWA from is not solved: the pairing link's origin is
  the PWA origin, which for the maintainer is the tailnet one.
- A relay without a policy admits clients as it did before device keys, and the agent's own
  check is then the only gate. That happens for up to one heartbeat (20 s) after a Worker deploy
  that kept the control socket open (seen on the first production deploy of device keys: one
  unknown key was let through by the relay and enrolled by the agent on its token), and for a
  second or so after the self-hosted relay restarts, since it keeps the policy in memory. The
  Worker keeps it in the Durable Object's storage.
- IK's first message has no forward secrecy against a later theft of the agent's static key:
  whoever recorded it and later steals the key reads the hello (the device's public relay key,
  its name, its proof). The token travels only after the handshake, under forward-secret keys.
- Replay protection on the agent header is a time window, not a challenge.
- There is no signed roster yet: the agent's `devices.json` is the roster, and it is per
  machine.
- Whoever serves the PWA can read everything; it is still served from the tailnet.
- A PDF preview's iframe is not sandboxed: WebKit draws PDFs with a plugin, which any sandbox
  disables. What keeps an agent's document from running script there is the type pinning (a
  preview's Blob takes the type its path implies, so a `.pdf` is never `text/html`) and the CSP
  the blob document inherits.
- The CSP's `img-src` takes only the app's own origin, `blob:` and `data:`, so a rendered
  markdown file loads no remote image: README badges show as broken images. That is the point (a
  remote image would tell its host when and where the document was opened).

Nothing secret is in any URL a server sees: the pairing link keeps its secret in the fragment,
which no request carries, and the path holds the account id (derived from the agent's public
signing key), the query holds the role, or a device's public key, a spent nonce, its signature
and the enrolment proof (above), and the agent's dial id and signature travel in headers. A pairing
link names only a `wss:` relay (plain `ws:` on a loopback address only), and the PWA takes a full
link only for its own origin.
Cloudflare's own logs redact `Authorization`, and invocation logs are off in `wrangler.jsonc`.

## Where the values live

Nothing host- or account-specific is in the repo.

| Where | Holds |
|---|---|
| main checkout's `deploy/relay-cf.env` (gitignored; template `deploy/relay-cf.env.example`) | `CLOUDFLARE_ACCOUNT_ID`; the custom domain `RELAY_DOMAIN`, the relay's only host when set; `RELAY_HOST`, the `workers.dev` host `wrangler deploy` printed, used only by a relay with no custom domain; `RELAY_JOIN_KEY` (a production deploy refuses to run without it) and `RELAY_ADMIN_KEY` (without it, listing and removing machines answer 501); `RELAY_DEV_JOIN_KEY` and the optional `RELAY_DEV_ADMIN_KEY` for a `--dev` deploy |
| the Worker's `JOIN_KEY` and `ADMIN_KEY` secrets | `RELAY_JOIN_KEY` and `RELAY_ADMIN_KEY`, uploaded by `deploy/relay-cf-deploy.sh` |
| the Worker's `RegistryRoom` Durable Object | the accounts it serves |
| `~/.perch/relay/config.json` (0600, checked at startup) | the self-hosted relay's bind address, limits, trusted client-IP header (below), `joinKey` and `adminKey` |
| `~/.perch/relay/accounts.json` (0600, checked at startup) | the accounts the self-hosted relay serves |
| main checkout's `deploy/agent.env` | `PERCH_RELAY_URLS`, every relay the agent holds (base URLs, comma-separated; `wss://`, or `ws://` on loopback only, since the agent drops any other `ws://` with a warning); `PERCH_PWA_ORIGIN`, the origin of the pairing links `perch pair` prints; `PERCH_DEFAULT_PATH`, the default path those links give a phone's new entry (optional, absolute); `PERCH_TOKEN`, for token enrolment (the hooks have their own secret) |
| `~/.perch/relay-key.json` (0600) | the agent's X25519 and Ed25519 key pairs. `perch connect` or `perch relay-key` creates it |
| `~/.perch/devices.json` (0600) | the enrolled and revoked device keys and the enrolment mode, managed by `perch devices` |
| `~/.perch/pairing.json` (0600) | the pairing secrets, one use and ten minutes each; spent and expired ones kept a day, to say which |
| `~/.perch/verify-device.json` (0600) | `verify.ts`'s own device key (see "Verification (Node client, deployed relay)") |

## Challenges, enrolment dials and misses: what each costs

- **A challenge is stateless.** The nonce carries its expiry (30 s), 16 random bytes and an HMAC
  over them and the account, under a key the account's relay generates once and keeps in its
  store (`relay-challenge.ts`). Handing one out writes nothing, and no number of them pushes an
  earlier one out. A used nonce is remembered in the relay's memory until it expires, so it works
  once. A Durable Object woken from hibernation has forgotten which were used, while its
  challenge key persists in its storage, which reopens a used nonce on the Worker for what is
  left of its 30 s; it still has to be signed by the device key it names, over this account. A
  restarted self-hosted relay keeps no challenge key (nor anything else of an account's state),
  so it makes a new one, and every nonce handed out before the restart fails instead.
  Used nonces are swept at most once a second, so remembering them costs a flood linear CPU.
- **Enrolment dials are capped per account**: at most 10 a minute (`maxEnrolments`,
  `RELAY_MAX_ENROLMENTS`) ask the agent to check a proof; the rest are refused in band with 4429
  (`too many enrolment attempts`). Pairing a phone takes one. A stranger sending made-up proofs
  can hold the owner's pairing off for the rest of the minute, and costs the agent at most ten
  roster reads a minute. The window is kept in the account's store (a Durable Object's storage on
  the Worker), so an object woken from hibernation keeps counting; each dial within the budget is
  one small write, a refused one none. A restarted Node relay starts a fresh window.
- **The Worker caches accounts per isolate** ("The account registry" above): a found one for 60 s,
  for every role including challenges, a missing one for 10 s. What still reaches the single
  `RegistryRoom`: each *distinct* account an isolate has not seen in its window (a stranger's
  distinct guesses among them), each control socket that carries a valid signature, and joins and
  administration. A flood of distinct guesses past what one Durable Object serves (about 1,000
  requests a second, Cloudflare's documented soft limit) overloads it, and every account not
  cached in the isolates it reaches then fails at once. The rate-limiting rule below is what
  bounds that per address; nothing in the Worker does.

**A Cloudflare rate-limiting rule** in front of the Worker bounds what one address can ask of it at
all. It is a zone rule, so it needs the custom domain (`RELAY_DOMAIN`). Traffic to a `workers.dev`
host never passes through the zone, which is why a deploy with a domain turns that host off
(`env.production`); a relay with no custom domain answers on its `workers.dev` host alone and can
have no such rule. It is created in the dashboard (Security → WAF → Rate limiting rules), not by
the deploy. What each plan allows decides the rule:

| Plan | Expression ("If incoming requests match") | Counting | Rate | Then |
|---|---|---|---|---|
| Free (one rule; 10 s periods) | `(http.host eq "<RELAY_DOMAIN>" and http.request.uri.path ne "/up")` | by IP | 60 requests / 10 s | Block, 10 s |
| Pro (query field) | `(http.host eq "<RELAY_DOMAIN>" and any(http.request.uri.args["role"][*] eq "challenge"))` | by IP | 20 requests / 10 s | Block, 1 min |
| Business (counting expression) | `(http.host eq "<RELAY_DOMAIN>" and http.request.uri.path ne "/up")`, counting only `http.response.code eq 404` | by IP | 20 requests / 1 min | Block, 10 min |

Only HTTP requests count, never WebSocket frames: a phone connecting makes two (the challenge and
the upgrade), an agent one per phone it dials, so 60 in 10 s leaves room for a household behind one
address. Choose one rule per plan; the Free one covers challenges and 404s with the rest.

- **Free does take a host condition, through "Edit expression".** The field picker lists no
  Hostname field, but the expression editor accepts `http.host`, and Free validates and deploys
  it. Keep the host condition: a path-only rule such as `(http.request.uri.path ne "/up")` rate
  limits every other site in the zone along with the relay.
- **"By IP" is per address per data centre.** Cloudflare stores the rule's characteristics as
  `ip.src` and `cf.colo.id`, so the count is kept for each address at each data centre.
- **An allow rule bypasses it.** An account-level IP Access rule with the action "Allow" skips
  rate-limiting rules for that address (Cloudflare's IP Access rules documentation).
- **A new rule takes a minute or two to start counting.** On the Free rule above, a burst from
  one address was answered 429 after about 60 requests in 10 s and answered normally once the
  block ended; the agents and `verify.ts` were not affected.

## Deploying the Worker

`deploy/relay-cf-deploy.sh`, from the main checkout, for production; `--dev` for a throwaway dev
Worker from any checkout, including a worktree with uncommitted changes. It:

- reads `deploy/relay-cf.env` from the **main** checkout, wherever it is run from, and refuses
  one another user can read (`chmod 600` it). It reads only the values it needs, each in a
  subshell: wrangler gets `CLOUDFLARE_ACCOUNT_ID` in its environment and the keys in its secrets
  file only, and a `--dry-run` reads no key at all;
- deploys production to wrangler's `env.production` (Worker `perch-relay`), or to
  `env.production-workers-dev` (the same Worker) when no `RELAY_DOMAIN` is set (below). The top level of
  `wrangler.jsonc` is for `wrangler dev` only: a bare `wrangler deploy` from any checkout makes
  a Worker of its own, `perch-relay-local`, with no host and no keys, and never touches
  production. `pnpm --filter @perch/relay-cf run deploy` runs this script;
- refuses a production deploy unless it runs from the main checkout, on `main`, with no
  uncommitted or untracked files, and at the same commit as its upstream (else `origin/main`) after a
  fetch, so what is live is always what `main` holds and has been pushed (`--dry-run` builds
  and checks from any checkout); a production deploy then runs `pnpm install --frozen-lockfile`,
  since the Worker bundles third-party code (`@noble/*`) from `node_modules`, which those checks
  do not see;
- refuses a production deploy without `RELAY_JOIN_KEY`;
- uploads `JOIN_KEY` and `ADMIN_KEY` (from `RELAY_ADMIN_KEY`; without it the deploy says so and
  `perch-relay machines` answers `501`) as **secrets** with the new version
  (`wrangler deploy --secrets-file`). A deploy deletes plain vars but never secrets, so a later
  deploy keeps them; the served accounts live in the registry, which no deploy touches;
- sets `RELAY_AUDIT` off, or on with `--audit`;
- with `--dev`, deploys to wrangler's `env.dev`: Worker `perch-relay-dev`, its own `workers.dev`
  host (printed by the deploy) and its own Durable Objects (so its own registry), with keys of its
  own and never a custom domain: `RELAY_DEV_JOIN_KEY` (required) and `RELAY_DEV_ADMIN_KEY`
  (optional) become its `JOIN_KEY` and `ADMIN_KEY`. Production's keys
  never reach a throwaway Worker. Nothing it does reaches production. It is **on demand** (see "Development
  flow"): delete it once the change it was for is merged;
- attaches a custom domain to production when `RELAY_DOMAIN` is set, in a zone on the same
  Cloudflare account. Cloudflare creates the DNS record and certificate on the first deploy, and
  a later deploy keeps the domain. With a domain set the deploy targets `env.production`, which
  turns the Worker's `workers.dev` host and preview URLs off: the domain is its only host, so the
  zone's rate-limiting rule sees every request. Without one it targets
  `env.production-workers-dev`, the same Worker `perch-relay` on its `workers.dev` host (put in
  `RELAY_HOST`), and says that no zone rule can cover it; that host then stands in for
  `<RELAY_DOMAIN>` everywhere below. Moving a relay from one to the other changes its host, so
  every agent's `PERCH_RELAY_URLS` and every phone entry must name the new one first. Nothing on the wire names the host (the agent's
  signature and a phone's enrolment proof bind the account, never the hostname), so a phone
  entry can switch to the domain by editing only its URL: its agent key and enrolled device
  key stay valid;
- with `--env-file <path>`, reads that file instead of main's `deploy/relay-cf.env`: one env file
  per Cloudflare account, kept outside the repo, so one checkout can deploy a relay into any account
  you hold ("A relay and PWA in your own Cloudflare account" below). Every other rule above holds as
  written: the same mode check, the same clean-main guard, the keys only in the secrets file.

## Setting it up from scratch

1. Fill main's `deploy/relay-cf.env` from the template (`install -m 600
   deploy/relay-cf.env.example deploy/relay-cf.env`: the deploy refuses a file other users can
   read): the Cloudflare account id, a `RELAY_JOIN_KEY` and a `RELAY_ADMIN_KEY` ("The join key"
   above), and `RELAY_DOMAIN` when you have a zone on the account (only a custom domain can have
   the rate-limiting rule above).
2. `deploy/relay-cf-deploy.sh` from the main checkout. With `RELAY_DOMAIN` set the relay answers
   there and nowhere else; without it, put the `workers.dev` host the deploy prints in
   `RELAY_HOST`.
3. On each machine, the `perch connect` command ("Connecting a machine and pairing a phone").
   `journalctl --user -u perch-agent | grep relay` should then show `relay account <id>` and
   `relay control socket open (wss://<RELAY_DOMAIN>)`, one line per relay. A `401` loop there
   with the right keys means the machine's clock is more than 60 s off.

## A relay and PWA in your own Cloudflare account

The whole client side on one free Cloudflare account, with no domain and no tailnet: the relay
and the PWA each answer on a `workers.dev` host. This is the simplest way to reach your own
machines. The PWA's origin holds every device key it enrols ("Threat model"), so serve it from
an account you control. `docs/SETUP-MACHINE.md` walks through the whole machine around it.

1. Keep the account's values outside the repo, private: `install -m 600 deploy/relay-cf.env.example
   ~/.perch/relay-cf.<name>.env`, then fill in the account id and a fresh `RELAY_JOIN_KEY` and
   `RELAY_ADMIN_KEY`, each made as "The join key" above makes one (32 random bytes in base64url:
   `perch connect` refuses any other shape). Leave `RELAY_DOMAIN` unset when the account has no
   zone: the relay then answers on its `workers.dev` host only, which no zone rate rule covers
   (see "Threat model", accepted limits).
2. Log wrangler into the account. On a machine with no browser, `wrangler login --device` prints a
   code to approve from any browser (the default flow redirects to `localhost` on the machine).
   Wrangler keeps one login, under `$XDG_CONFIG_HOME/.wrangler/`; when you hold several accounts,
   give each its own login with `XDG_CONFIG_HOME=<a directory of its own>` on every wrangler
   command, so logging in for one never drops another. `wrangler whoami` lists the account.
3. Deploy the relay from the clean main checkout:
   `deploy/relay-cf-deploy.sh --env-file ~/.perch/relay-cf.<name>.env`.
4. Serve the PWA from a static-assets Worker in the same account. Build main's PWA, then run
   wrangler from `packages/pwa`, which has no wrangler config (from `packages/relay-cf`,
   `wrangler deploy` would pick up the relay's):
   ```bash
   cd packages/pwa
   CLOUDFLARE_ACCOUNT_ID=<account id> ../relay-cf/node_modules/.bin/wrangler deploy \
     --name perch --assets dist --compatibility-date 2026-09-01
   ```
   It answers on `https://perch.<subdomain>.workers.dev`. The PWA is static and carries its
   Content-Security-Policy in its own `index.html`, so the Worker needs no configuration. (Recent
   wrangler turns `pages project create` into an empty Worker, so Pages is not the way.)
   Redeploy it with the relay whenever a wire-format change ships.
5. On each machine, `perch connect` with the relay, its join key and `--pwa
   https://perch.<subdomain>.workers.dev`, so pairing links open this PWA.

## Several relays at once

The agent holds one control socket per URL in `PERCH_RELAY_URLS`, each with its own backoff,
and every log line names its relay. One key means one account id on every relay, so the phone
keeps an entry per relay (the Worker, the self-hosted relay), all with the same agent key (a
paired phone holds no token), and switches between them by toggling. Nothing is retyped after a flip.

**Two agents with the same key on one relay take turns; they do not fight.** The relay keeps the
latest control socket and closes the older one with 4000. That happens when an agent is run by
hand next to the service agent, which shares `~/.perch/relay-key.json`. A superseded agent does
not redial at once: it waits 1 minute, then 2, 4, 8 and 15 minutes on each further supersede
(an open socket in between does not reset it; holding the relay for an hour does), and logs
`relay control socket superseded by another agent using this relay key (<url>)`. Seeing that
line means: stop one of the two. To try a second agent without disturbing the production
socket, give it only the local relay: `PERCH_RELAY_URLS=ws://127.0.0.1:8450` and another
`PERCH_PORT`.

## The self-hosted relay

The same core as the Worker, as a Node service: `pnpm --filter @perch/relay exec tsx
src/main.ts` (the package's `perch-relay` bin). It reads `~/.perch/relay/config.json`
(`PERCH_RELAY_CONFIG` names another file), outside any checkout, so flipping the checkout it
runs from never changes which agents it serves (they are in `accounts.json` beside it):

```json
{
  "host": "127.0.0.1",
  "port": 8450,
  "joinKey": "<32 bytes, base64url: perch-relay join-command writes it>"
}
```

`joinKey` lets machines join (without it, joining answers `501`); `adminKey` (`perch-relay
admin-key` writes it) lets the operator list and remove them (without it, those answer `501`).
The accounts are not in the config: they are in `accounts.json` beside it, which joins and
removals change. `joinMax` and `joinWindowMs` tune the join rate limit (10 per
10 minutes per client address). `host` defaults to
`127.0.0.1` and `port` to 8450. `dialTimeoutMs`, `maxPending`, `maxPairs` and `maxEnrolments`
are optional and default to the Worker's values (10 s, 8, 16, and 10 enrolment dials per account
per minute). `clientIpHeader` names the header a proxy on the
same machine puts the client's address in (`"cf-connecting-ip"`, `"x-forwarded-for"`); it
defaults to none (below). An unknown key is refused, so a misspelt cap does not silently fall
back to its default. Restart the service after editing it.

On the dev machine it runs as a user service, like the agent:

```bash
sed "s|REPO_PATH|$PWD|" deploy/perch-relay.service > ~/.config/systemd/user/perch-relay.service
systemctl --user daemon-reload && systemctl --user enable --now perch-relay
journalctl --user -u perch-relay   # "perch relay listening on 127.0.0.1:8450, serving 1 account(s) …"
```

`deploy/run-relay.sh` runs it from `deploy/relay-live` (main when that is missing or dangling),
through mise. `pnpm serve:relay .worktrees/<feature>` points it at a worktree and restarts it;
`pnpm serve:relay-restore` points it back at main; `pnpm serve:relay-heal` restores main only
when the symlink dangles. `pnpm worktree:remove` restores main first when the relay runs from
the worktree being removed. A restart drops the relayed connections; the agent and the phone
reconnect on their own.

It listens on localhost only; keep `host` at `127.0.0.1` and put whatever the phone reaches in
front of it on the same machine.

### Publishing it on the tailnet

What the maintainer runs: the relay stays on localhost and `tailscale serve` publishes it to the
tailnet only, with a Let's Encrypt certificate for the machine's MagicDNS name:

```bash
sudo tailscale serve --bg --https=8451 http://127.0.0.1:8450
tailscale serve status                 # https://<machine>.<tailnet>.ts.net:8451 (tailnet only)
```

The phone's entry is `wss://<machine>.<tailnet>.ts.net:8451/<account>`, and the phone needs
Tailscale up. The agent keeps its control socket on `ws://127.0.0.1:8450`: its own leg has no
reason to leave the machine. `tailscale serve` connects to the relay from loopback and sets no
header the relay believes, so leave `clientIpHeader` unset: every tailnet client then counts
against the host cap only (below). `sudo tailscale serve --https=8451 off` unpublishes it.

### Fronting the self-hosted relay

Anything else in front of it (a reverse proxy on a VPS, the operator's own tunnel) needs two
things from the relay's side, and is otherwise the operator's setup:

- **WebSocket passthrough**: the proxy forwards the upgrade (`Upgrade`/`Connection` headers)
  and the query string untouched, and does not time out an idle WebSocket before the relay's
  20 s heartbeat. It terminates TLS; the relay speaks plain `ws://` on localhost.
- **`clientIpHeader`**, if the proxy names the client in a header. The relay believes that
  header only from a loopback peer, so the proxy runs on the relay's machine. With a list
  (`X-Forwarded-For`) the relay reads the last entry, the one the proxy appended; configure
  the proxy to overwrite or append it, never to pass a client's own value through alone.

**Why the header is opt-in.** Anything that connects from loopback could otherwise name its own
address: `tailscale serve` is such a peer, so any tailnet device could have written
`CF-Connecting-IP` and chosen whose per-address cap it spends. Without a configured header, a
loopback peer is a local proxy standing for clients it does not tell apart; keying the cap on
its one address would let any six connections through it lock out every other client, the
owner included. So those connections count against the host cap only, and the account's own
caps (8 pending, 16 pairs) and the device gate still apply. Behind a public proxy, set the
header so the per-address cap works.

**What the Node relay adds for exposure beyond the machine**, where the Worker gets it from
Cloudflare's runtime (all in `server.ts` and `connection-limits.ts`, over the same core; the conformance suite
still runs unchanged on both hosts, plus one check both pass: refusals carry a short reason and
nothing about the software):

| Gap | Node relay | Worker |
|---|---|---|
| Concurrent connections for the whole host | 256 upgrades + open sockets, then `429`, plus 16 slots past that only the agent's own sockets (`role=agent`/`dial`) may take, so phones filling the host cannot cut the agent off; and 512 TCP connections of any kind (`server.maxConnections`), past which Node drops a new one before reading it. With phones filling the host, those 16 are all the agent has: its control socket and at most 15 dial-backs, across every account the relay serves, and a dial-back past them is refused `429`, so its phone waits for the dial timeout. That is tighter than the agent's own bound (up to 32 dial-backs per relay link that have not authenticated), which is there for a hostile relay and never comes into play on this one | the runtime's |
| Per client address | 6, below the account's own caps (8 pending, 16 pairs) so one address cannot fill them. The address is the socket peer's, or, **only from a loopback peer and only when `clientIpHeader` is set**, the header's (last entry of a list); a loopback peer without it counts against the host only (above). A header's IPv6 address counts by its /64. The agent's own sockets (`role=agent`/`dial`) count against the host only, because they come from the same home address as a phone on the home network; a forged one is refused with `401` at once | none of its own beyond the join and admin limit: the per-account caps, and the Cloudflare rate-limiting rule ("Challenges, enrolment dials and misses") when the zone has one |
| Frame size | `ws` `maxPayload` at one Noise frame, compression off (so no frame inflates past what was checked) | the core's check |
| Slow clients | headers within 10 s, whole request within 15 s, idle keep-alive 5 s, checked every second; a client that leaves while waiting for its dial frees its slot at once (Node keeps an upgrade's socket half-open, so it used to hold it until the dial timeout); a phone refused in band is cut 1 s after its close frame whether or not it answers it (it used to hold its slot until the heartbeat, up to 20 s) | Cloudflare's edge |
| Upgrade timeout | the core's dial timeout (`504` after 10 s); the Noise handshake timeout is the agent's (`4002 authentication timeout` after 10 s) | the same |
| Guessed accounts | nothing allocated before the account is known (it used to allocate a room per guessed path); answered from memory, so a guess costs a lookup and nothing else. A refused guess holds a connection slot for at most 1 s (above) | nothing allocated either; but each distinct guess is one request to the single `RegistryRoom` ("Challenges, enrolment dials and misses") |
| Errors | a status and a short reason; an unparsable request gets a bare `400`; a failing handler `500`, never a stack; a server-level accept error is logged, not fatal | the same |
| Logs | one line per refusal, status and address only, at most once a minute per status and address (it remembers 1,000 pairs, then starts over, so a flood from more addresses than that logs more); the trace of a phone's connect (challenge, upgrade, the agent's dial, the address only) at most 30 lines a minute in all, and the next minute's first trace line comes after one saying how many were dropped; never a URL, a nonce, a signature or a frame | invocation logs off |

**Threat model for a self-hosted relay.** Everything in the threat model above holds, with
whoever runs the machine in Cloudflare's place. What is different:

- **Metadata goes to whoever runs the machine, and to anything fronting it** (a proxy that
  terminates TLS sees client IPs, the account path, the device parameters in the query, timing
  and frame sizes). Frames stay Noise ciphertext end to end.
- **Availability tracks the machine's**: a reboot, a power cut or the uplink going down takes
  the relay down while the Worker keeps serving. Keep the Worker entry on the phone as the
  fallback.
- **A flood reaches the machine** before the relay's caps refuse it. The relay answers from
  memory, so the cost is CPU and sockets on the machine, not state.
- **A restart of `perch-relay` opens the relay's gate for about a second** (the policy is in
  memory, see "Accepted limits"); the agent's own check still holds, as on the Worker after a
  deploy.
- **Accepted, as on the Worker:** strangers spread over enough addresses can hold an account's
  enrolment budget (10 dials a minute) with made-up proofs, delaying the owner's pairing; they
  reach no slot otherwise, and challenges, being stateless, cannot push the owner's out.
- A phone behind carrier-grade NAT shares its address, for the per-address cap, with strangers
  on the same carrier address.

## Development flow

The phone's entries never change; only what serves them does.

| To try | Run | What it touches |
|---|---|---|
| A PWA change | `pnpm serve:build .worktrees/<f>` / `serve:restore` | `deploy/pwa-live` |
| An agent change | `pnpm serve:agent .worktrees/<f>` / `serve:agent-restore` | `deploy/agent-live`, restarts `perch-agent` (tmux survives). Its relays come from main's `deploy/agent.env` |
| A relay change, self-hosted | `pnpm serve:relay .worktrees/<f>` / `serve:relay-restore` | `deploy/relay-live`, restarts `perch-relay` |
| A relay core change | `pnpm serve:relay .worktrees/<f>`, and the conformance suite on both hosts | the self-hosted relay |
| The Cloudflare adapter (`packages/relay-cf`) | `pnpm exec wrangler dev` from the worktree's `packages/relay-cf` (local workerd, see below), plus its tests | nothing deployed |
| Durable Object bindings or migrations, or how the Worker deploys | `deploy/relay-cf-deploy.sh --dev` from the worktree, then `wrangler delete --env dev` once merged | a throwaway dev Worker only |
| A production relay release | merge, then `deploy/relay-cf-deploy.sh` from main | the production Worker |

Everything else runs on the local relay: it is the same core, so `serve:relay` tries a relay
change for real without touching Cloudflare. A throwaway dev Worker is only worth deploying for
what workerd run locally cannot show: bindings, migrations and the deploy itself.
`deploy/relay-cf-deploy.test.sh` checks that `env.dev`, `env.production-workers-dev` and the top
level declare the same Durable Objects and migrations as `env.production`, so they have not rotted
when next needed; that neither `env.dev` nor the top level has production's name; and that
`env.production` keeps its `workers.dev` host and preview URLs off.

`wrangler dev` listens on **:8788** (`dev.port` in `wrangler.jsonc`): wrangler's own default,
8787, is the agent's hooks listener (`PERCH_PORT`). It reads its secrets from
`packages/relay-cf/.dev.vars` (gitignored, like `.dev.vars.*`; template `.dev.vars.example`):
without `JOIN_KEY` there, `perch connect` answers **501** (joining is off), and without
`ADMIN_KEY` listing and removing machines do. Use keys made for local work, never production's.
An agent tried against it takes `PERCH_RELAY_URLS=ws://127.0.0.1:8788`, and only a hand-run one
(a second agent on the production relay would supersede the real one).

After any agent flip, check that the production control socket came back:
`journalctl --user -u perch-agent --since -1min | grep 'socket open (wss://<RELAY_DOMAIN>)'`.
A relay change must pass the conformance suite on both hosts before either is deployed.

## Adding the relay machine on the phone by hand

Pairing ("Connecting a machine and pairing a phone") does all of this. By hand, for a phone that
should hold the token:

1. Settings → **＋ Add machine by hand**.
2. **Name**: e.g. `dev (relay)`.
3. **URL**: `wss://<RELAY_DOMAIN>/<account>`, the `phone URL` line from `perch relay-key`.
4. **Token**: the machine's `PERCH_TOKEN`.
5. **Default path**: the project root new workspaces resolve against.
6. **Agent key**: the `agent key` line from `perch relay-key`. Add machine refuses a missing or
   malformed key: every entry is a relay entry.

On its first connection the phone's device key is enrolled by the token, **only while the
machine's enrolment is `on`**: with it `off` (pairing codes only), pair instead. `perch devices`
then lists it under the fingerprint Settings → Diagnostics shows. Nothing else is entered.

Editing an entry can change its key but not clear it: an entry without a key would be an old
direct entry, which never connects.

A self-hosted relay gets its own entry the same way, with its own URL
(`wss://<machine>.<tailnet>.ts.net:8451/<account>` for the tailnet-published one) and the same
agent key; the device key is already enrolled, so it needs no token.

When a machine has an entry per relay, every workspace appears once per entry. **Test one relay
at a time** by switching the other entries off.

If the entry says its agent key **is not the machine's** ("wrong agent key"), the key was
mistyped (or the agent's identity was rotated): the agent could not open the phone's first
message. The entry stops redialing until tapped. **Agent key mismatch** means something else: an
answer came back that the pinned key did not make, so something other than the agent answered.

Everything works through a relay entry, including image, PDF and audio previews, the browser
view and the connection-log flush: they travel inside the encrypted session (next section).

## Retiring the direct path

Phones used to reach an agent directly over the tailnet: a plaintext WebSocket with a bearer
`auth`, published with `tailscale serve`, plus three HTTP side channels on the same port. All of
it is gone. The agent binds `127.0.0.1` only (a non-loopback `PERCH_HOST` is ignored with a
warning) and answers nothing but `POST /hooks` there; a machine that still publishes its agent
port with `tailscale serve` should drop that mapping (`docs/DEPLOY.md`, step 3).

On the phone, an entry saved for the direct path (no relay, no agent key) is kept, never
connected, and shown in Settings as **Old direct entry — no longer supported; pair this machine
again**, with only Delete. Pair the machine (`perch pair`) and delete the old entry.

## Side channels inside the session

Three features used to authenticate with the token outside the connection, which a relay would
have seen. They are messages inside the Noise session instead
(`packages/contracts/src/protocol/session-channels.ts`):

| Feature | Messages | Agent | PWA |
|---|---|---|---|
| Media preview | `readMedia` → `media` (result, type, size), then `mediaChunk`s, each answered with `mediaAck`; `mediaCancel` | `MediaSender` (`application/media-sender.ts`), with `readServableFile`'s caps (5 MB images, 20 MB PDFs, 30 MB audio) | `SessionMedia` builds the Blob and maps a failure to the HTTP-style status the viewers understand |
| Browser view | `browserOpen`, then the browser protocol's own messages wrapped in `browser`, each one the agent sends answered with `browserAck`; `browserClose` / `browserClosed` | `SessionBrowserStreams` gives the unchanged `BrowserStreamHandler` a socket per stream | `SessionBrowser` gives the unchanged `BrowserStream` a socket per stream |
| Connection-log flush | `clientLog` → `clientLogAck` (ok or not) | appended to `~/.perch/client-log.jsonl`; a batch over 512 KB is refused, but it has already been received whole, so the buffering bound is the session's 32 MiB message cap | the same durable ring; events are marked flushed only on `ok` |

The agent lists what it serves in `authResult.channels`. The PWA uses a channel only when it is
listed: an older agent answers an unknown message with `bad_message`, which the PWA ignores, so
without the advert a preview would wait forever. Against such an agent a relay entry shows "need
a newer agent", offers no browser view, and keeps its log events buffered.
`core/session-channels.ts` `sideChannelTransport` is the one place that picks the session or
nothing.

Things not to "simplify":

- **The phone's acknowledgements are the backpressure.** Through a relay the agent's own socket
  drains into the relay at once, so its `bufferedAmount` says nothing about a slow phone: the
  relay buffers the relay → phone leg where the agent cannot see it. A browser stream's
  `bufferedAmount` is therefore the bytes the phone has not acknowledged, and the handler holds
  frames past a limit of 0 there (one message in flight). A held frame is replaced by a newer one, never queued, and goes out as soon as the
  acknowledgement arrives (`onDrain`), so the last frame of a page that stops repainting is
  still shown. Media works the same way with a window of 4 chunks.
- **A media chunk fits in one Noise frame** (45 KiB before base64). `SecureSession.seal` sends
  every frame of a message back to back, so one big message would put its whole length ahead of
  terminal output; small chunks under a small window bound what terminal output waits behind to
  about 180 KB for a preview and one frame for the browser view.
- **One transfer per connection.** A newer `readMedia` supersedes the older one on the agent,
  and the viewer cancels the transfer it leaves, so an abandoned 20 MB PDF does not keep the
  session busy.
- **The browser stream opens with the browser protocol's own `auth`** inside a connection that
  is already authenticated, so both ends run the unchanged browser handler and viewer. Its token
  is empty and never checked: a paired phone holds no token, and the session already proved who
  it is.

## Round trips

The relay costs network distance, not processing. On a tablet, measured by the maintainer:

| Network | Worker | Self-hosted relay |
|---|---|---|
| Wi-Fi at home | 172–187 ms echo | 18 ms echo, over the tailnet |
| 4G | the reference | put behind a Cloudflare Tunnel: no faster than the Worker, so dropped |

Earlier, on the phone: **about 171 ms through the relay against 10 ms on the LAN over the tailnet.** On
cellular the relay was judged good enough in use.

From the agent's own machine (Node client, 30 samples each), both legs going out to Cloudflare
and back:

| Path | Echo median / p90 | Heartbeat median / p90 |
|---|---|---|
| Tailnet entry (the agent is local, so this is the floor) | 2.7 / 3.1 ms | 0.8 / 1.3 ms |
| Relay (Worker) | 161–174 / 163–182 ms | 159–172 / 163–179 ms |
| Self-hosted relay on the same machine, through its tailnet name (20 samples) | 2.6 / 3.0 ms | 1.1 / 1.3 ms |
| Proof-of-concept relay on its own VPS, for comparison | 159.4 / 160.7 ms | 153.8 / 154.5 ms |

From that machine the nearest Cloudflare edge answered a TCP connect in ~84 ms, and each round
trip crosses it twice (phone leg and agent leg). Encryption adds nothing measurable at terminal
rates. `verify.ts rtt` repeats the Node measurement.

## Verification (Node client, deployed relay)

`PERCH_URL` is `wss://<RELAY_DOMAIN>/<account>`, `wss://<machine>.<tailnet>.ts.net:8451/<account>`
or `ws://127.0.0.1:8450/<account>` for the hosts.

`packages/relay/scripts/verify.ts` plays the phone with the same secure-channel code, run on the
agent's machine, so both legs go out to Cloudflare and back:
`pnpm --filter @perch/relay exec tsx scripts/verify.ts <command>`. The commands are listed at
the top of the script.

It is a device like any phone, with its own key in `~/.perch/verify-device.json` (or
`DEVICE_KEY_FILE`), enrolled once by pairing, since token enrolment is normally off:

1. `pnpm perch pair` on the agent's machine prints a link.
2. `verify.ts enrol '<link>'` enrols the key file's key and prints `PERCH_URL` and `AGENT_KEY`.
   The key is enrolled with the agent, so the same key works through every relay the agent holds:
   swap the host in `PERCH_URL` to check another one.
3. Every other command then needs only `PERCH_URL` and `AGENT_KEY`. Leave `PERCH_TOKEN` unset:
   the agent refuses a token from an enrolled key (4003 "token not needed").

It shows in `perch devices` as `verify.ts`; revoke it there when it is no longer used. `verify.ts
pair` and `device-gate` try keys of their own: `pair` enrols a throwaway key each run, so revoke
the fingerprint it prints afterwards. `deploy/relay-cf-deploy.sh --audit` turns the audit on; redeploy without
it afterwards. A redeploy restarts the relay, so a client connecting in the ~20 s after one can
land on an instance that is being retired and be dropped once.

Joining and pairing (2026-09-26). `verify.ts pair '<link>'` plays a new phone from a `perch pair`
link; `verify.ts join-gate <relay>` tries the join and admin API without the join key:

| Check | Self-hosted, through its tailnet name | Worker (a throwaway dev Worker, migration `v2`) |
|---|---|---|
| `perch connect` on the relay's own machine, already registered | `already registered`; only `PERCH_PWA_ORIGIN` added to `agent.env` (backup kept); agent restarted; QR and link printed | — |
| A new account joins, then its control socket opens | — | `201`, then `200` on a second join; `426` to a plain GET; control socket open |
| Remove it | — | `200`; its control socket closed `4004`; `404` afterwards |
| Join with the agent signature only / a wrong join key; list with a wrong key | `401` each; the account stays `404` | `401` each; the account stays `404` |
| Join-key requests from one address past the limit | — | `429` from the 11th |
| `perch-relay machines list --url … --key …` | — | the registered account, listed |
| `verify.ts pair`: pair with the code, reconnect with no token, spent code on a second device | served, served, `403` at the relay (the agent refused the dial) | — |
| The deployed PWA in WebKit at phone width, opening the link | the entry appeared named after the machine, connected in 167 ms, `pairing` gone from storage, no request carried the secret, reconnected after a reload with no token | — |
| The same, through **Scan QR code** (a canvas stream standing in for the camera) | decoded, paired and connected in 407 ms | — |

Side channels inside the session, from the agent's machine with an enrolled device key (`verify.ts
media`, `browser`, `clientlog`), echo measured on a scratch zsh workspace (2026-09-26):

| Check | Worker | Self-hosted, through its tailnet name |
|---|---|---|
| Image (143 KB), sha256 equal to the file's | 4 chunks, 472 ms | 4 chunks, 15 ms |
| PDF (12.6 MB), sha256 equal to the file's | 274 chunks, 12.1 s | 274 chunks, 201 ms |
| Echo, idle / during that PDF transfer | 164 / 157 ms median | 3.0 / 3.2 ms median |
| Browser view on an animated page, 10 s | 48 frames (one in flight per round trip) | 251 frames |
| Echo while streaming it | 189 ms median | 2.7 ms median |
| `clientLog` | acknowledged, line in `client-log.jsonl` | acknowledged, line in `client-log.jsonl` |

The same, through the PWA at phone width in WebKit (the relay-sidechannels build, one relay entry
at a time): image rendered, PDF blob byte-exact (4.3 MB), browser canvas repainting, a typed
command ran in the pane, and the client's connection-log events landed in `client-log.jsonl`.

With the self-hosted relay published on the tailnet and the client-IP header opt-in, from the
agent's machine with an enrolled device key (2026-09-26):

| Check | Worker | Self-hosted, through its tailnet name |
|---|---|---|
| Workspace list | full list | full list |
| Attach, type, see the echo | `prod-42-ECHO` | `home-42-ECHO` |
| Echo round trip (20) | 187.9 ms median | 2.6 ms median |
| Unknown device key, with no proof and with a wrong-token proof (`device-gate`) | `403` at the relay, both | `403` at the relay, both |
| Wrong agent key | — | `4002 secure channel failed` |

After the hardening, against the deployed Worker, from main (2026-09-24):

| Check | Result |
|---|---|
| Workspace list | `auth ok`, full list, over Noise |
| Attach, type, see the echo | `echo MAIN-$((6*7))-ECHO` ran in a scratch zsh pane and `MAIN-42-ECHO` came back |
| Create a Claude Code workspace, send a prompt, park, resume | answered; `park` gave `status=parked` and killed the tmux session; attaching recreated it as `claude … --resume <id> \|\| exec claude …` with the earlier answer on screen |
| Wrong agent key on the client | closed `4002 secure channel failed` before any session existed |
| Wrong token (`wrong-token`) | `authResult ok:false`, then the agent hung up |
| Handshake, then no `auth` (`no-auth`) | closed after 9.9 s: `4002 authentication timeout` |
| Agent role without credentials / signed by another key, control and dial | `401` each |
| 20 raw client sockets opened in a row, with the phone holding one pair | 15 opened, then `429` for the rest (16 in all); the agent closed the 15 unauthenticated ones ~9 s later and a slot was free again |
| The Worker's secrets after a bare `wrangler deploy` | still listed by `wrangler secret list`; the account still answered (`426` to a plain GET, not `404`) and the agent re-registered |
| Production deploy from a worktree | refused; `--dry-run` from the worktree built and checked |
| **Relay sees only ciphertext** (`--audit`, `wrangler tail`, a marker typed over the relay, auth with the real token) | 63 forwarded frames, all binary (4 handshake, 59 transport), none parses as JSON; neither the marker nor the token appears in the tail as text, hex or base64 |

On an Android phone (Chromium), through a relay entry:

| Check | Result |
|---|---|
| Add machine with **Through the relay** ticked and no key | refused with the agent-key message; nothing stored |
| Add it with the key | stored as `relay: true`; workspace list rendered |
| Attach and type | the typed `echo` ran in the pane and its output rendered on the phone |
| Backgrounded 60 s, then foregrounded | the socket died while hidden (Android cuts a background tab's network); on return it reconnected in 1.3–1.4 s and typing worked |
| Key cleared in Settings, then Reconnect tapped | no WebSocket opened at all; "relay machine has no valid agent key — not connecting"; entry still `relay: true` |

*(Since then the Add machine form has no **Through the relay** option: every entry is a relay
entry, `relay: true` is no longer written, and Settings refuses to clear a key.)*

Checked on the first deployment, and still holding:

| Check | Result |
|---|---|
| Create a Claude Code workspace, send a prompt | answered; hooks set `needs-feedback` and captured the session id |
| Agent role: control without credentials / signed by another key; dial without credentials / signed by another key | `401` each |
| Unknown account; `/up` | `404`; `200` |
| Relay restarted with a client attached and pinging | client saw 1006, two `503` while the agent redialed, re-attached 2.6 s after the drop; tmux session intact |
| Agent restarted (`systemctl --user restart perch-agent`) | client saw 1001, one `503`, re-attached 1.9 s after the drop; tmux session intact |
| Hibernation: attached client silent for 60 s, only the auto-answered control heartbeat running | first frame afterwards arrived in a freshly started room holding 3 open sockets (it had hibernated and woken); echo came back in 141 ms |

## Restoring or removing it

- To stop serving a relay from a machine: remove its URL from `PERCH_RELAY_URLS` in its
  `deploy/agent.env` and restart the agent. tmux sessions survive.
  `perch-relay machines remove <account>` also takes it off the relay's registry.
- A dev Worker: `CLOUDFLARE_ACCOUNT_ID=… pnpm exec wrangler delete --env dev` from
  `packages/relay-cf`. The self-hosted relay: `sudo tailscale serve --https=8451 off`, then
  `systemctl --user disable --now perch-relay`.
- On the phone: delete the relay machine entry.
- The Worker serves nothing without an agent. To remove it:
  `cd packages/relay-cf && CLOUDFLARE_ACCOUNT_ID=… pnpm exec wrangler delete perch-relay`.
- `~/.perch/relay-key.json` can stay; it is only read when a relay URL is set.

## History: the proof of concept

Before this, a plaintext proof of concept ran the Node relay in a container on a VPS behind a
reverse proxy. It had no agent authentication (an unguessable account label was its only
protection, and the proxy's request logs held that label) and no encryption, so the relay could
read the token. It showed that relayed round trips are network distance (about 159 ms echo from
the agent's machine) and that the agent's backoff and the PWA's reconnect ride through relay and
agent restarts. Everything it proved carried over; its deployment was torn down.
