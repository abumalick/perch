# Hosted relay: is it worth building?

**Status:** draft, for discussion · **Date:** 2026-09-23

An evaluation of a possible new direction: a public relay server that brokers between
the PWA and the agent machines, with accounts instead of per-machine tokens and URLs,
sold as a subscription, with both sides staying open source so anyone can self-host.
No product code was written for this; it is research and design only.

## Summary

**Recommendation: do not build the hosted relay now.** Serve the immediate need (colleagues
on a company LAN behind a VPN) with one reverse proxy holding a wildcard certificate,
which needs no change to Perch and no per-person setup. Keep the relay design below as the
recorded plan for a *narrower*, self-hostable rendezvous, and only start it if demand
appears beyond the colleague case. If it does, the first step is a two-day spike on the
one technical assumption everything rests on, not the relay itself.

The three hard requirements are all satisfiable, with residuals that must be stated
honestly:

| Requirement | Verdict | Mechanism | What remains |
|---|---|---|---|
| 1. Blind relay | Feasible | Device keys + app-layer Noise session inside the channel; the relay carries ciphertext and signed metadata only | Metadata, keystroke timing, and code delivery: whoever serves the PWA JavaScript can defeat the encryption |
| 2. Direct when possible | Feasible, one way only | WebRTC data channels with ICE; the relay does introduction and signalling, TURN is the fallback | Depends on the agent's LAN address being routable from the phone; a future WebKit local-network permission could turn direct-LAN into a prompt or a fallback |
| 3. Not a VPN | By construction | Per-connection sockets, no interface, no routing; the relay never forwards arbitrary TCP/UDP | Keep it that way: no "expose port" feature, ever |

A second shape, found after this evaluation by reading an existing open-source client's
source, drops requirement 2 and with it most of the cost: a plain WebSocket relay with
keypair identity and QR pairing, self-hostable in one command. It is written up separately
in [the relay-only design](2026-09-23-relay-only-design.md), including the security
comparison with the tailnet. **After discussion, that is the shape chosen to build**,
starting with the proof of concept it describes; this evaluation stands as the record of
why the hosted, direct-connection version was not.

What decides the verdict is not feasibility but cost against benefit: the relay is
roughly four to six months of part-time work plus an indefinite operations and legal
tail, for a market in which the incumbent (Anthropic's own Remote Control) is included in
paid Claude plans and the closest E2E competitor (Happy) is free, while the colleague
case is solved by an afternoon of proxy configuration.

## The question

Perch today: a PWA plus a per-machine agent, reachable only over the owner's own
Tailscale tailnet, with a bearer token per machine typed into the PWA. The tailnet gives
each agent a `wss://` endpoint with a publicly trusted certificate, which is what iOS
requires for a PWA and for a WebSocket.

The motivating case: colleagues who are not on that tailnet and will not be. Their
machines sit on a company LAN reachable from outside only through a corporate VPN. They
need an HTTPS origin on a private address, which iOS will not accept without a publicly
trusted certificate, and they need it without exposing anything publicly.

The proposed answer was a hosted relay. This document evaluates it against the three
hard requirements, then architecture, security, effort, business, and the cheaper
alternatives.

## Requirement 1: the relay must be blind

**Feasible.** The mechanism is standard and the pieces exist for both the browser and Node.

### Design

- **Device identity.** Every device (a phone running the PWA, a machine running the agent)
  generates a static X25519 key pair locally on first run and never exports the private
  key. On the agent it lives in a file under `~/.perch/`. In the PWA it is a
  non-extractable WebCrypto `CryptoKey` stored in IndexedDB; installed home-screen web
  apps keep their own storage counter and are not subject to Safari's seven-day eviction
  ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
  X25519 in WebCrypto: caniuse lists Safari 17, WebKit's own notes announce it in
  [Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/); take
  18.4 as the floor. A lost key is a re-pair, not a breach, so re-enrolment must stay
  cheap.
- **Session encryption.** Once two devices know each other's static keys, each connection
  runs a Noise handshake (pattern `KK`, both statics known in advance, or `IK`) and then
  carries every Perch protocol message as a ciphertext frame. Libraries usable in both
  the browser and Node exist (`@noble/curves`, `@noble/ciphers`, both audited;
  [noise spec §7.5](https://noiseprotocol.org/noise.html)). This layer is independent of
  the transport: the same frames ride a WebRTC data channel, a TURN relay, a WebSocket
  through the relay, or the existing tailnet WebSocket.
- **Why encrypt above the transport when WebRTC already has DTLS.** DTLS between two
  peers is end-to-end only if the certificate fingerprints in the signalling are
  authenticated; a signalling server that substitutes fingerprints is a man in the middle
  ([RFC 8827 §9.1](https://www.rfc-editor.org/rfc/rfc8827.html),
  [RFC 8826 §4.3.2](https://www.rfc-editor.org/rfc/rfc8826.html)). Putting the Noise
  session inside the channel makes that attack pointless without having to sign SDP:
  the relay gains nothing by interposing on DTLS. It also means the encryption proof does
  not depend on a WebRTC library's DTLS implementation, and one frame format serves every
  transport.
- **The roster.** The relay stores, per account, a list of devices: public key, display
  name, kind. That list is what "signing in lists your machines" shows. To keep the relay
  from inserting or substituting a device, the roster is **signed by an account root key
  that lives only on devices**, never on the relay. The first device creates it; every
  later device receives it inside the encrypted pairing exchange. The relay serves the
  signed blob; clients verify it and refuse to connect to an entry that is not signed. A
  version counter in the signed blob, remembered by each device, stops the relay from
  serving an older roster to resurrect a revoked device. This is Matrix cross-signing and
  Tailscale's Tailnet Lock, not a new idea
  ([Matrix](https://spec.matrix.org/latest/client-server-api/#cross-signing),
  [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)).
- **Recovery.** Losing every device loses the root key and therefore the account's
  machines. A recovery code (printed words, generated with the root key) is mandatory,
  or the design locks users out in a way support cannot fix. That is the price of the
  relay not holding the key.
- **Enrolling a new device.** Two flows, both safe against a malicious relay:
  - **QR out of band.** The device being added shows a QR carrying its public key and a
    random secret; an already enrolled device scans it and seals the root key material and
    a roster signature to that public key, through the relay. The relay carries
    ciphertext addressed to a key it saw only in a blob it cannot alter without the scan
    failing. This is Signal's device-linking model
    ([Signal](https://signal.org/blog/a-synchronized-start-for-linked-devices/)). An
    agent enrols by printing the QR in the terminal; the phone scans it.
  - **Short code when no camera is available.** A password-authenticated key exchange
    (SPAKE2, [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html)) over a relay
    mailbox, Magic Wormhole style: a wrong guess ends the pairing visibly, so a malicious
    relay gets one guess per attempt. A `spake2` npm package exists; no audited browser
    CPace implementation was found.
  - **Trust on first use** alone is not enough: with an untrusted relay there is no "first
    use" that the relay could not stage. Both flows above bind the key out of band.
- **Cautionary example.** The Happy client's pairing is E2E on paper; a report filed
  against it on the day of this research claims the pairing endpoint hands out an
  account bearer token to anyone who saw the QR
  ([slopus/happy#1829](https://github.com/slopus/happy/issues/1829), unconfirmed at
  time of writing). Whether or not it holds, it illustrates the rule: the relay must never
  treat anything it can observe as an authenticator.

### What a compromised or malicious relay operator can still do

| Capability | Status | Mitigation |
|---|---|---|
| Read terminal traffic, workspace names, paths, files | No. All of it rides inside the Noise session; the workspace list is a protocol message, not relay state | None needed |
| Impersonate a device | No, without its private key. Adding a fake device fails roster verification | Signed roster |
| Serve an older roster (resurrect a revoked device) | Limited | Roster version counter; devices refuse to go backwards |
| Learn who talks to whom, when, for how long, from which IP, how many bytes | **Yes.** Metadata is inherent; Syncthing and Signal say so of their own relays | Minimise what is logged; state it in the privacy policy |
| Recover typing from packet timing | **Partly.** A terminal sends one frame per keystroke; inter-keystroke timing leaks content ([Song, Wagner, Tian 2001](https://www.usenix.org/conference/10th-usenix-security-symposium/timing-analysis-keystrokes-and-timing-attacks-ssh)); OpenSSH 9.8 quantises to 20 ms with chaff for this reason | Batch input frames on a short timer and pad to size buckets; cheap for a KB/s stream |
| Deny service, lock a user out, force the relayed path | **Yes.** Signalling is sealed to the peer so candidates cannot be selectively dropped, but whole messages can | Nothing beyond self-hosting |
| Brute-force a pairing | One guess per attempt, visibly | Single-use codes, rate limits on the relay itself |
| **Change the code the phone runs** | **Yes, if the relay operator also serves the PWA.** This is the standard critique of browser cryptography: the verifier is delivered by the party being verified | Serve the PWA from a separate, pinned static origin (or, for a self-hoster, from their own machine). Subresource Integrity covers scripts but not the top-level document; the WAICT and WEBCAT proposals that would fix this do not ship in Safari |

The last row is the honest limit of requirement 1: **blindness is a property of the
transport, not of a deployment where the same operator ships the JavaScript.** A hosted
product must separate the two roles or say plainly that it has not.

## Requirement 2: direct connections when possible

**Feasible, and there is exactly one way to do it from a browser.**

### Why WebSockets cannot do it

From the PWA's point of view a direct connection means the page opening a socket to an
address on the phone's LAN or VPN. A `wss://` connection to a private address needs a
publicly trusted certificate for that name; `ws://` from an HTTPS page is blocked as
mixed content ([WebKit bug 89068](https://bugs.webkit.org/show_bug.cgi?id=89068)); a
self-signed certificate cannot be accepted for a WebSocket on iOS at all, only a CA
installed as a device profile works. That is the wall the tailnet currently climbs with
`tailscale serve` certificates, and it is why the current design serves the PWA from the
tailnet.

### WebRTC is the browser's peer-to-peer primitive

A WebRTC data channel is SCTP over DTLS over ICE: the browser gathers candidate
addresses, exchanges them with the peer through any signalling path, probes every pair,
and picks the best working one (host over reflexive over relayed). iOS Safari has had
data channels since iOS 11; `restartIce()` since 14.5. The historical standalone-PWA bug
was `getUserMedia` only, fixed in 14.5; data channels were never listed as broken in
standalone mode ([WebKit bug 185448](https://bugs.webkit.org/show_bug.cgi?id=185448)).
Safari 26.4 shipped further data-channel fixes
([WebKit](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)).

**The Safari catch, and why the design survives it.** WebKit filters host candidates by
default: a page without camera or microphone access sees only reflexive and relay
candidates, or mDNS-obfuscated names ([WebKit](https://webkit.org/blog/7763/a-closer-look-into-webrtc/);
`ICECandidateFilteringEnabled` defaults to true in WebKit's preferences). Two peers behind
the same NAT that both offer only reflexive candidates need NAT hairpinning, which home
routers often lack. The design does not depend on the phone's candidates:

- The **agent advertises its real LAN address** as a host candidate (Node is not filtered).
- Safari **probes that address directly**; the connectivity check arrives from the phone's
  real LAN address, and the agent adopts it as a peer-reflexive candidate
  ([RFC 8445 §7.3.1.3](https://www.rfc-editor.org/rfc/rfc8445.html)).
- So the direct path works whenever **the agent's address is routable from where the phone
  is**: same Wi-Fi, the corporate VPN, or a tailnet. The agent does not need to resolve
  the phone's `.local` mDNS name, though libdatachannel can.

This was assembled from the RFC and WebKit's documentation, not observed on a device.
It is the single assumption the whole direct path rests on and is the first thing a spike
must prove. No local-network permission prompt applies to Safari today: iOS 14's
local-network privacy is for apps, and Safari is exempt
([Apple forums](https://developer.apple.com/forums/thread/663848)).

**Discovery.** A web page cannot discover peers on the LAN: the W3C discovery API was
abandoned in 2013 and nothing replaced it. The relay's rendezvous role is therefore not
optional; "find the machine on my Wi-Fi" is "ask the relay for its candidates and probe
them". With no relay reachable there is no direct path either, which is acceptable for a
relay product but worth saying.

**A note on the project's own guide.** The agent guide records that a PWA served from a
public origin cannot open a WebSocket to a tailnet address on iOS, that the failure is
silent and that this was investigated and settled. The WebKit sources gathered here show
no such block in shipping WebKit: the Local Network Access implementation was merged in
September 2026 behind a preference that defaults to off
([WebKit PR 72725](https://github.com/WebKit/WebKit/pull/72725)), and the specification
does not count the tailnet's `100.64/10` range as local in any case
([explainer](https://github.com/WICG/local-network-access/blob/main/explainer.md)). The
relay design does not depend on which is right, because its direct path is WebRTC, not a
WebSocket. But the discrepancy is worth one on-device retest with Private Relay off and a
known-good certificate, since if the observed failure had another cause it changes what a
hosted-origin PWA can do on the tailnet path as well. This is a discussion item, not
something this document resolves.

**Future risk, named.** The same explainer plans to gate WebRTC ICE candidates behind the
local-network permission in Chrome. If WebKit follows, a public-origin PWA's direct LAN
path becomes a permission prompt at best and a silent fall back to the relay at worst.
Nothing in the design can prevent that; it can only degrade gracefully, which ICE does.

### The Node side

Three libraries let a Node 24 agent speak WebRTC with a browser:

| Library | Basis | State (Sept 2026) | Notes |
|---|---|---|---|
| `node-datachannel` | libdatachannel, N-API | 0.33.x, prebuilds for macOS arm64/x64 and Linux x64 | TURN client, mDNS resolution; the obvious pick |
| `werift` | pure TypeScript | Active, Node 22+ | No native build; TURN over UDP/TCP/TLS |
| `@roamhq/wrtc` | libwebrtc M106 (2022) | Aging | Heaviest, oldest engine |

Node 22+ has a built-in WebSocket client for the signalling connection to the relay.

### Upgrading from relayed to direct without dropping the session

Two things make this easy, and one of them is already true of Perch:

- **ICE does it natively.** All candidate pairs are probed in parallel; the relay pair
  usually validates first and the channel opens on it, then a higher-priority direct pair
  that validates is selected. A reliable, ordered data channel does not notice the
  switch, and the Noise session above it is unaffected.
- **tmux holds the session.** Perch's terminal state lives in tmux on the agent, and the
  viewer already re-attaches and re-sends `list` on every reconnect. Even a full transport
  swap (a new peer connection) is a re-attach the user sees as a blink, not a lost
  session. This is the current design's biggest asset for the feature, and it also caps
  what the relay can promise: iOS suspends a backgrounded PWA within seconds to a minute or
  two, and the connection log already shows the resulting code 1006 on resume. No
  transport changes that.

### WebTransport, the QUIC option

The task named QUIC. Safari 26.4 (March 2026) shipped WebTransport, including
`serverCertificateHashes` ([WebKit](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/),
[h3#347](https://github.com/hyperium/h3/issues/347)). That matters because it is the one
browser transport that can connect to a **private IP with a self-signed certificate**:
the agent would rotate a short-lived certificate and publish its hash in the signed
roster, and no certificate authority, and no `tailscale serve`, would be needed for the
direct path, on the tailnet either. Its costs today:

- Safari 26.4 or later on every phone; nothing older.
- No NAT traversal: it is direct only when the agent is already reachable, and needs a
  separate relayed fallback (a WebSocket carrying the same Noise frames).
- Interop caveats: Safari negotiates a hybrid draft set and needs the server to send
  initial flow-control capsules; Node has no built-in WebTransport server and the
  third-party ones are young.
- It would be subject to any future local-network gating just like WebSockets.

WebRTC remains the recommendation; WebTransport is the watch item that could later
simplify the direct path, particularly for the tailnet deployment.

## Requirement 3: not a VPN

**Satisfied by construction.** WebRTC opens sockets per connection, creates no interface,
routes nothing, and the agent only ever exposes Perch's own protocol. The design rule to
keep it that way: the relay and agent never grow a generic port-forwarding or TCP-tunnel
feature, and the roster only names devices, never services. That rule also keeps the relay
in the "mere conduit" category legally (see Business).

## Architecture

### Components and what the relay holds

| Component | Role | State |
|---|---|---|
| Relay: control plane | Accounts, sign-in, billing, signed rosters, device presence, pairing mailboxes, signalling forwarding, time-limited TURN credentials | Accounts and billing; roster blobs (opaque, signed); presence (ephemeral); mailboxes and signalling queues (minutes-long TTL); connection metadata logs |
| Relay: TURN | Fallback byte carrier for DTLS ciphertext | None beyond allocations |
| Static PWA host | Serves the client, separate from the relay | The build |
| Agent | As today, plus: device key, outbound relay client, WebRTC peer, Noise session, enrolment CLI | Device key, roster copy |
| PWA | As today, plus: account sign-in, device key, roster verification, pairing UI, WebRTC connection class | Device key, root key material, roster copy |

The relay never holds: terminal bytes, workspace names, project paths, file contents,
browser-view frames, or any key that decrypts them.

### Agent registration and authentication

1. `perch-agent enroll` generates the device key if absent, prints a QR (public key plus
   a random secret), and opens a pairing mailbox on the relay.
2. The phone scans it, seals the root key material and a roster entry signed by the root
   key to the agent's public key, and posts it to the mailbox. The relay stores the new
   signed roster.
3. From then on the agent keeps one outbound WebSocket to the relay, authenticating by
   signing a relay challenge with its device key. The relay maps that key to the account
   and marks the device present. Reconnection is the existing backoff pattern.

Nothing inbound reaches the agent; no port is opened on the machine.

### Signalling protocol

Sealed envelopes between two device keys, forwarded by the relay by device id:

- `offer`, `answer`, `candidate` for ICE, with trickle ICE so the relayed pair connects
  fast and direct pairs upgrade it.
- `turn-credentials` from the relay, HMAC time-limited, per the standard TURN REST scheme.
- `roster` from the relay, verified by the receiver.
- Pairing: `pair-open`, `pair-payload`, `pair-close` on a mailbox keyed by a random id.

The current `ClientMessage` and `AgentMessage` unions ride unchanged inside the Noise
frames. `auth` with a bearer token becomes the Noise handshake.

### Reconnection

The PWA holds one control WebSocket to the relay and one peer connection per enabled
machine (Perch connects to all machines at once for the aggregated list; two to five
peer connections is well within what iOS handles). On foreground it recreates peer
connections; ICE gathering plus checks costs one to two seconds where the tailnet
WebSocket costs a few hundred milliseconds. The existing generation-token rule (one
connect chain per machine, never two) carries over unchanged and matters more, since a
stale peer connection holds a TURN allocation.

### What iOS Safari and WebKit support

| Capability | Status | Source |
|---|---|---|
| `RTCDataChannel` | Since iOS 11; fine in standalone PWAs | caniuse, WebKit bug 185448 |
| Host ICE candidates without camera/mic | Filtered (mDNS names at most) | WebKit blog 7763, WebKit preferences |
| `restartIce()` | Since 14.5 | caniuse |
| Local-network permission for Safari pages | None today; implementation merged Sept 2026, off by default | WebKit PR 72725 |
| WebTransport with certificate hashes | Since 26.4 | WebKit blog 17862 |
| X25519 and Ed25519 in WebCrypto | 17 per caniuse, 18.4 per WebKit; use 18.4 | WebKit blog 16574 |
| Non-extractable `CryptoKey` in IndexedDB | Works | WebKit bug 183167 |
| Storage of installed PWAs | Not subject to seven-day eviction | WebKit blog 10218 |
| Web Push for installed PWAs | Since 16.4; any HTTPS origin | WebKit blog 13878 |
| Background connections | Suspended within seconds to minutes | Apple forums, the existing connection log |

### Side channels that must move inside the channel

Three parts of today's agent do not ride a data channel as they are, and each is real
work and a `contracts` change:

- **`GET /file`**, the image preview, fetched cross-origin over HTTP with a bearer header.
  Becomes a chunked binary read inside the encrypted channel (data channel messages are
  best kept at 16 KB; 256 KB closes the channel on some engines).
- **`POST /clientlog`**, the connection-event flush. Its whole point is to not depend on
  the session socket; through the relay it becomes a second, tiny sealed message to the
  agent's mailbox, or is dropped on the relay path.
- **The `/browser` WebSocket**, which carries JPEG frames with its own backpressure
  (latest-wins above 200 KB queued). Becomes a second data channel with the same policy,
  and its bearer auth becomes the Noise session.

`POST /hooks` is local to the machine and unaffected.

## Security and trust

A relay that brokers terminal sessions is one hop from shell access on every connected
machine, so the question is what a compromise yields.

**Blast radius of a relay compromise, with the design above:** the attacker gets account
emails, billing records, device public keys, presence history and connection metadata.
They cannot decrypt past or future sessions (no key material), cannot connect to any
machine (no device private key, no roster signature), cannot add a device the clients will
trust. They can deny service and they can watch metadata. If the same operator serves the
PWA, add: full compromise of every session opened after a backdoored build ships, which
is why the static origin must be separate and, ideally, pinned by build hash.

**Blast radius of an agent-machine compromise:** unchanged from today. The device key on
that machine authorises only that machine's presence; the root key material it received
during enrolment lets it sign roster changes, which is a trade-off to decide (a machine
could be enrolled as "signable by phones only" at the cost of needing a phone to add
the next machine).

**Blast radius of a phone compromise:** the root key. Today, the same phone holds every
machine's bearer token, so this is not worse than the present design, and a revocation
flow from another device (re-signed roster with the phone removed) is better than today's
"rotate every token".

**What a self-hoster inherits:** a public HTTPS name and certificate for the relay, a
TURN server or a TURN provider, account and password (or passkey) handling, the
pairing flows, backups of the roster store, and the rule that they should serve the PWA
from a host they control, which they get for free. They do not inherit billing, but they
do inherit on-call for a service their phone depends on. This is more than the current
`tailscale serve` recipe, not less.

## Effort

### What survives, what is replaced, what is new

| Area | Survives | Replaced or extended | New |
|---|---|---|---|
| `contracts` | Every existing message | `auth` semantics | Envelope/frame schema, pairing, roster, signalling messages |
| Agent application layer | All of it (tmux, workspaces, parking, hooks, status, files) | Nothing | Nothing |
| Agent `ConnectionHandler` | Yes: it is written against the `ClientConnection` port, not `ws` | Nothing | A `ClientConnection` adapter over a data channel plus Noise |
| Agent server | The `ws` listener and HTTP routes stay for the tailnet path | `/file`, `/clientlog`, `/browser` need in-channel equivalents | Relay client, WebRTC peer, device key store, `enroll` CLI |
| PWA core | Store, aggregator, terminal, keyboard bar, all UI | `MachineConnection` (URL + token + WebSocket) gains a sibling built on ICE | Account and pairing UI, key store, roster verification, machine list from roster |
| PWA adapters | `browserSocketFactory` for the tailnet path | Nothing | Data-channel socket adapter, WebCrypto key adapter, camera QR scan |
| Relay | Nothing exists | | A new package: HTTP + WebSocket server, accounts, billing, storage, TURN, deployment, monitoring, abuse limits |
| Docs, legal, site | | | Deploy runbook for self-hosters, terms, privacy policy, DPA template, pricing page |

The hexagonal split pays off here: the agent's `ConnectionHandler` and the PWA's `Socket`
port mean the transport is genuinely swappable. What is not small is everything around
the transport.

### Estimate

For one maintainer working part-time, rough and in phases:

| Phase | Weeks |
|---|---|
| Spike: standalone iOS PWA to `node-datachannel`, direct on LAN without camera access, and via TURN from cellular | 0.5 |
| Frame layer, device keys, Noise session, in-channel replacements for the three side channels | 4 to 6 |
| WebRTC connection class in the PWA, agent peer and relay client, reconnection on iOS | 3 to 4 |
| Pairing (QR and code), signed roster, recovery code, revocation | 3 to 4 |
| Relay service: accounts, presence, signalling, TURN, billing, deployment, monitoring | 4 to 6 |
| Hardening on real phones, legal documents, website | 2 to 4 |

That is four to six months before the first paying user, and the transport surface of the
codebase more than doubles. The relay package alone is a second product with its own
release cadence.

### The tailnet path

Stays supported with no change: the agent keeps its WebSocket listener and tokens, the PWA
keeps `{url, token}` machines. A machine could later be reachable both ways. The Noise
frame layer could also wrap the tailnet path for defence in depth, but nothing requires it.

## Business

### Who else does this

| Product | Relay | Can the vendor read sessions? | Price | Relevance |
|---|---|---|---|---|
| Tailscale (Serve, Funnel, DERP) | Blind DERP relays | No | Free for 6 users non-commercial; $8 per user per month Standard | The benchmark: vendor-blind, all plans, but a VPN and a Tailscale account |
| Anthropic Remote Control | Anthropic API | Yes, and the transcript is stored server-side | Included in Pro, Max, Team, Enterprise | The incumbent; its stated gap is exactly requirement 1 |
| Happy | Hosted, stores ciphertext | No (NaCl, QR secret) | Free, open source, donation IAP | The closest E2E competitor, at zero price |
| Omnara | Hosted | Yes, by their own statement | Metered | |
| VS Code tunnels, Dev Tunnels | Microsoft | Yes at ingress (VS Code adds SSH on top) | Free, 5 GB per month | Proves the outbound-agent-plus-rendezvous model |
| ngrok | Hosted | Yes on HTTPS; no on paid TLS endpoints | $10 to $20 per month plus usage | No free E2E path |
| Cloudflare Tunnel + Access | Hosted | Yes | Free to 50 users | Untrusted transport only |
| sshx | Hosted | No (key in URL fragment, unauthenticated AES-CTR) | Free | Shows the demand for blind terminal sharing |
| Blink Shell | None (Mosh/SSH direct) | n/a | about $20 per year | Proves a paying iOS terminal audience |
| Warp session sharing | Warp cloud | Yes | $20 per month and up | Server-visible by design |
| CodeRemote | None (over Tailscale) | n/a | $49 per month, closed | Someone charges this for a web UI |

Nobody sells a paid, end-to-end encrypted, non-VPN phone relay for Claude Code today. That
is not the same as an opportunity: the incumbent is bundled into the plan every target user
already pays for, and the E2E alternative is free.

### Pricing and costs

| Item | Figure |
|---|---|
| Plausible price | $4 to $8 per user per month, or about $30 per year (Tailscale Standard, Termius, Blink as anchors) |
| Relay host | One small EU VPS; 20 TB egress included is thousands of users of KB/s terminal traffic |
| TURN | Self-hosted coturn on the same box, or a hosted TURN at $0.05 per GB with 1 TB free per month |
| Payments | Stripe plus tax handling, or a merchant of record at 5% plus 50 cents per transaction |
| Break-even on hosting | A handful of subscribers |

Hosting cost is not the issue. The realistic subscriber count is tens to low hundreds:
people who run Claude Code in tmux on their own machines, want a phone client, will not
use the bundled Remote Control, and will pay rather than use Happy. That is a few hundred
to a couple of thousand dollars a month at best.

### The operating burden, alone

A paid relay is a service people's working day depends on. That means uptime, on-call,
incident communication, abuse handling, account support, key-loss support (which the
design deliberately cannot resolve for them), payment disputes, dependency upgrades to a
WebRTC stack that moves under Safari releases, and a second deploy pipeline. Every hour of
it comes out of Perch itself.

### Legal and privacy

Factual summary, not legal advice, taking a solo operator established in the EU as the
example; other jurisdictions differ in the details but not in the shape:

- **GDPR.** Controller for accounts, billing and connection metadata; processor for the
  relayed ciphertext. A written data-processing agreement with any business customer,
  records of processing (the small-organisation exemption does not apply to processing
  that is not occasional), and breach notification to the authority within 72 hours.
  End-to-end encryption waives notification to *data subjects* only, and only while the
  keys are intact; metadata (IP addresses, timestamps, volumes) is personal data in its
  own right. Requirement 1 shrinks the exposure; it does not remove the obligations.
- **Electronic communications law.** A relay between one person's own devices is arguably
  not an interpersonal communications service, and the classification is decided case by
  case by national regulators. If it were classed as any electronic communications
  service, confidentiality and traffic-data rules and a 24-hour breach notice would apply.
  This is the one genuinely open legal question.
- **Digital Services Act.** A blind, non-persisting relay fits "mere conduit"; every
  intermediary regardless of size still needs a contact point for authorities and users
  and published terms. Persisting ciphertext (offline queues, stored scrollback) drifts
  toward hosting obligations, so the design should not.
- **Encryption policy.** A single user on two devices is outside the user-to-user scope
  of the UK Online Safety Act and the EU child-safety measures, which currently carve out
  end-to-end encryption; a sharing or collaboration feature would flip that.
- **Tax.** EU consumer sales of a digital service are taxed in the customer's country past
  a 10,000 euro EU-wide threshold, through the One Stop Shop or a merchant of record.

## Alternatives for the colleague case

The colleagues already have the VPN. Their problem is a certificate, not connectivity.

| Option | One-time setup | Per person | Cost | iOS caveats | Who sees traffic |
|---|---|---|---|---|---|
| **One reverse proxy on a VPN-reachable host with a DNS-01 wildcard certificate, split-horizon DNS on the company resolver** | A real domain, a DNS API token, one Caddy or similar with a DNS plugin, records pointing at private addresses, `wss://` upgrade to each agent | None beyond the VPN they already use | About a domain fee per year | None: publicly trusted certificate, private addresses, same names on office Wi-Fi and VPN | Nobody outside the company |
| Same, but a certificate per agent machine | As above plus a distribution job | None | Same | Let's Encrypt issues at most five identical certificates per week, and lifetimes fall to 45 days from 2028, so the copy job becomes mandatory | Same |
| Internal CA (step-ca, mkcert) | CA plus an ACME endpoint | Install a profile and enable full trust on each phone; repeat on each new phone | Free | A root every colleague trusts can sign any hostname; manual trust toggle | Same |
| Each colleague on their own Tailscale | Machine can join one tailnet; node sharing for the rest | Account, app, and toggling against the corporate VPN (iOS runs one VPN at a time) | Free only for non-commercial use; $8 per user per month otherwise | VPN conflict on the phone | Tailscale sees metadata, not content |
| Cloudflare Tunnel + Access | Zone, tunnel, identity provider | One sign-in | Free to 50 users | Session expiry breaks `wss://` opaquely | Cloudflare decrypts everything; also a public origin |
| Self-hosted Perch relay inside the company | The whole relay above, deployed on a VPN-reachable host | Pairing | Free | Needs the relay to exist first | Nobody |

**The first row is the recommendation.** It is what the tailnet does today with the
company's VPN in Tailscale's place: DNS-01 validation does not require the host to be
reachable ([Let's Encrypt](https://letsencrypt.org/docs/challenge-types/)), a wildcard
keeps the leaf names out of certificate transparency logs, and one proxy sidesteps both
the rate limit and the shortening lifetimes
([Let's Encrypt](https://letsencrypt.org/2025/12/02/from-90-to-45)). The known trap is
DNS-rebind protection on home routers stripping private answers when a colleague is off
the VPN; split-horizon DNS on the company resolver avoids public records altogether.
Perch needs no code change. The deliverable is a page in the deploy runbook and, at most,
an example proxy configuration.

The last row is worth noting: even if the relay existed, the colleagues would run it
inside the company, where it would only ever be the introduction service for connections
that the wildcard proxy already makes possible with no new software.

## Recommendation

**Do not build the hosted relay now.**

1. **Solve the colleague case with the wildcard proxy.** One afternoon, no product change,
   no per-person setup, nothing public, nobody in the middle. Document it in the deploy
   runbook.
2. **Keep this design as the recorded plan** for a narrower product if demand appears from
   outside: a **self-hostable rendezvous with no accounts or billing** (device keys, signed
   roster, WebRTC plus TURN, Noise frames), built so that a hosted version is a later
   deployment of the same package rather than a different one. Accounts and billing are
   the part with the least technical content and the most operational tail; they come
   last, if ever.
3. **If that day comes, start with the spike, not the relay.** Two days on a real iPhone:
   a standalone PWA served from a public origin opens a data channel to `node-datachannel`
   on the same Wi-Fi without camera access and confirms the selected pair is direct, then
   does the same from cellular through TURN. If either fails, nothing else in this document
   matters.

### Main risks, if it is ever built

- **WebKit gates WebRTC behind a local-network permission.** Direct LAN degrades to a
  prompt or to relayed. Likely eventual; only graceful degradation is possible.
- **Code delivery undermines blindness.** A hosted PWA served by the relay operator makes
  the encryption a promise, not a property. A separate pinned static origin is the
  mitigation and must be part of the product, not an option.
- **Pairing is where E2E designs fail in practice**, not the cipher. The relay must never
  treat anything it can see as an authenticator; the recovery-code path needs the same care.
- **iOS backgrounding** means no transport delivers "always connected"; the relay must not
  be marketed as if it did.
- **A solo operator on call** for a paid service, against an incumbent bundled into the
  plan every target user already pays for, and a free E2E alternative.
- **The one open legal question** is whether a same-user relay is an electronic
  communications service in the operator's jurisdiction.

## Open questions for discussion

1. Is the colleague case the whole motivation, or is there demand from outside for a
   phone client that is E2E and not a VPN? The answer decides whether the narrower
   rendezvous is worth starting at all.
2. Should the public-origin-to-tailnet WebSocket failure recorded in the agent guide be
   retested on a device, given the WebKit sources above? It changes nothing in this design
   but changes what a hosted-origin PWA could do on the tailnet path.
3. If the rendezvous is ever built: may an enrolled machine sign roster changes (so a
   machine can enrol the next machine), or phones only?
4. For the wildcard-proxy option: is a page in the deploy runbook enough, or should an
   example proxy configuration ship under `deploy/`?
5. Is WebTransport with certificate hashes worth a spike of its own for the tailnet
   deployment, independent of any relay, once Safari 26.4 is the floor on every phone?

## Notes on verification

Claims above marked as assembled from specifications rather than observed are: the
agent-host-candidate plus peer-reflexive path on iOS Safari; mDNS candidates appearing
without camera access; data channels in standalone PWAs on iOS 17 and later (inferred
from the standalone bug being camera-only); Web Push from a private-origin PWA. Figures
that could not be confirmed on a primary source: Tailscale Funnel's bandwidth cap, ngrok's
current TLS-endpoint tier, cloud egress list prices behind script-only pages. The report
against the Happy client is a same-day, unanswered claim. Prices and plan limits are as
published in September 2026 and will drift.
