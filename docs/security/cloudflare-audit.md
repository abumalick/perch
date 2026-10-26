# Cloudflare relay security audit

## Scope and result

Source snapshot: `2f6c974ee831f71ed3aa57f26f4d9787a2d3465d`.

The scope is the public Cloudflare Worker, its Durable Objects, the shared relay
core, and the agent authentication code reachable through that relay. The threat
model includes both an unauthenticated internet client and a malicious relay.
Tailnet infrastructure and a general PWA or host security audit are excluded.

No unauthorized terminal access or terminal-content decryption was demonstrated.
Two issues were reproduced: incomplete account removal after an eviction failure,
and an authentication queue with no aggregate bound. These results are a focused
security review, not a proof that every takeover path has been excluded.

Tests used disposable identities, fake terminals, and local listeners. Live
Cloudflare access was limited to deployment/configuration metadata reads. No
production protocol probes, load tests, deployments, or configuration changes were
performed. This branch contains reproductions and this report; it changes no
runtime implementation.

## Confirmed findings

| ID | Severity | Finding | Required condition |
| --- | --- | --- | --- |
| CF-01 | Medium | Failed account eviction cannot be retried through account removal | An established connection and a failed eviction RPC during authorized account removal |
| CF-02 | Medium, conditional | Pending pairing authentication queues messages without an aggregate limit | A connection reaching the agent's Noise handshake, with pairing I/O still pending |

Severity reflects the stated conditions. Neither finding demonstrated an
unauthenticated session takeover through an otherwise functioning relay.

### CF-01: interrupted account removal leaves existing connections forwarding

Affected code: [`handleAdminRequest`](../../packages/relay/src/registry.ts#L197),
[`RegistryRoom.admin`](../../packages/relay-cf/src/registry-room.ts), and
[`RelayRoom.evict`](../../packages/relay-cf/src/relay-room.ts).

Removal first deletes the account from the registry and records its denial. It
then awaits the account's separate RelayRoom eviction RPC. If that RPC fails before
closing the room, the Worker returns HTTP 500. The registry remains changed, but
the room's established connections remain alive. A retry returns HTTP 404 because
the account is already removed, so it never retries eviction.

The Cloudflare runtime reproduction established a client/spare pair, injected one
eviction failure, and observed:

1. First removal: HTTP 500.
2. Registry lookup: account absent.
3. Removal retry: HTTP 404; eviction invoked only once.
4. The existing pair still forwarded a binary message after the retry.

This can preserve an existing connection when the operator is trying to remove a
compromised machine identity. It does not create an initial foothold or defeat
Noise encryption. The reproduction uses marker bytes to demonstrate continued
relay forwarding, not a real terminal session. A transient RPC failure was
injected locally; its production frequency was not measured.

Recommended remediation: make eviction retryable for accounts already on the
removed list. Persist pending eviction work or otherwise reconcile failures across
the registry and relay objects. Do not lift the account's denial to retry cleanup.

Regression tests (the reproductions, flipped once the fix landed):

- [Cloudflare runtime](../../packages/relay-cf/test/account-removal.test.ts)
- [Shared registry core](../../packages/relay/src/registry.test.ts) and the conformance suite

### CF-02: pending credential checks can accumulate unauthenticated messages

Affected code:
[`NoiseClientConnection.dispatch`](../../packages/agent/src/server/noise-client-connection.ts#L281)
and
[`spendPairing`](../../packages/agent/src/server/noise-client-connection.ts#L310).

While pairing redemption is pending, `dispatch` appends every incoming decrypted
message to `held` before checking authentication attempts. Each message has a size
limit, but the queue has no aggregate byte or message limit. Repeated `auth`
messages are not counted until the queue drains.

The bounded reproduction held a credential read pending and sent 128 messages,
each smaller than the 8 KiB pre-authentication message limit. It observed 127
queued messages holding more than 500,000 serialized bytes, while the attempt
counter remained one. No token was accepted, no application operation was
dispatched, and the connection had not closed. The test then stopped the
connection and released the pending read.

An honest relay's enrollment proof check usually prevents an arbitrary internet
client reaching this stage. The issue is reachable by a malicious relay that
forwards an unknown device through a dial-back while enrollment is open, or by a
client that has legitimately reached the handshake. Impact is conditional on the
time spent waiting for I/O. The ordinary authentication timeout limits the initial
pairing wait, but not the number of bytes retained within it. During subsequent
enrollment persistence, the authentication deadline is canceled before the write
finishes, while queuing continues.

Memory exhaustion under sustained traffic is an inference from the missing
aggregate bound; no exhaustion or host crash was attempted. There was no
demonstrated authentication bypass.

Recommended remediation: bound queued message count and total bytes before
retaining messages, enforce authentication-attempt limits on receipt, and keep a
deadline through enrollment persistence. Preserve the existing requirement that
application messages wait for the enrollment decision.

Regression tests: [agent connection](../../packages/agent/src/server/noise-client-connection.test.ts)
(attempts counted on arrival, held auths not counted twice, the 16-message cap).

## Controls reviewed and exercised

| Area | Evidence and limits |
| --- | --- |
| Agent authentication | Handler tests reject application operations before authentication. Unknown IK devices require a credential; revoked devices are refused independently of the relay. |
| Machine and role identity | Relay conformance checks agent signatures, account/key binding, dial ownership, spare pairing, and invalid agent upgrades. |
| Noise and framing | Secure-channel tests cover independent IK vectors, key pinning, noncanonical static keys, invalid keys, frame authentication, ordering, replay, and reassembly limits. No independent cryptographic audit or formal verification was performed. |
| Enrollment | Tests cover token/pairing modes, proof binding, spent or expired codes, atomic pairing redemption, and messages held until enrollment persistence resolves. |
| Device revocation | Agent integration tests verify active connection closure and rejection at the agent even before the relay receives its updated policy. Account removal has the separate CF-01 failure case. |
| Relay admission limits | Reviewed pending/pair/gate caps, enrollment budgets, challenge expiry, and agent-side dial-back limits. Application limits do not replace an edge rate-limit rule. |
| Join and administration | Tests reject wrong keys, mismatched accounts, small-order registration keys, and use of the join key for administration. Removed accounts cannot rejoin without administrative allowance. |
| Failure-state persistence | Reviewed stored policies, removed markers, enrollment windows, cached account authorization, and hibernation behavior. Used challenge nonces are intentionally kept only in memory. |

The following documented availability limits remain relevant:

- Distinct unknown account guesses still reach the shared registry. Isolate miss
  caching does not bound a stream of distinct guesses.
- Rebuilding a RelayRoom forgets spent challenge nonces; a recorded valid device
  proof can be admitted again during its remaining challenge lifetime. The agent
  still requires the Noise device key, so this is not terminal authentication.
- Agent authorization headers are time-bound rather than single-use, and do not
  name the relay. Cross-relay replay is documented as an availability limitation.
- Unauthenticated gate messages reach the Cloudflare runtime before the
  application's small reply limit is checked. Cloudflare permits incoming
  WebSocket messages up to 32 MiB; no large-frame production test was performed.
  See [Cloudflare's limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Live deployment metadata

Read-only API checks confirmed:

- The Worker has `JOIN_KEY` and `ADMIN_KEY` as secret bindings.
- The relay and registry Durable Object bindings are present.
- The `workers.dev` endpoint and preview URLs are disabled.
- A custom-domain binding is present.
- `RELAY_AUDIT` is `0`, and automatic invocation logging is disabled.

The deployment API reported one active version at 100 percent traffic. Its
metadata provides no source commit annotation, so equality between the deployed
bundle and the entire reviewed source snapshot has not been established. A
read-only download of the deployed script did confirm the affected CF-01 removal
implementation: registry removal precedes eviction, and a repeated removal returns
404 before calling eviction. The failure itself was exercised only locally.

The existing API credential returned HTTP 403 when attempting the zone/WAF
configuration read. Therefore the active rate-limit expression, threshold, enabled
state, and bypass rules remain unverified. A custom domain alone does not prove
that a WAF rule is installed or effective. Configuration shown in the runbook is
not evidence of live enforcement.

## Dependencies

`pnpm audit --prod --json` reported no advisory matching the Cloudflare Worker's
production dependency path. Its whole-workspace result contained two DOMPurify
advisories in the PWA:
[GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7) and
[GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2).
Those concern `IN_PLACE` behavior; the inspected Markdown renderer sanitizes a
string and does not enable that option. They are outside this Cloudflare review,
and PWA exploitability was not assessed. An advisory lookup is not a substitute
for dependency source review; a complete supply-chain audit was not performed.

## Verification

Commands below run from the audit worktree. Set `TMPDIR` to its `.tmp` directory
and use the prescribed memory cap for test processes.

```sh
pnpm --filter @perch/secure-channel --filter @perch/relay --filter @perch/relay-cf test
pnpm --filter @perch/agent exec vitest run \
  src/server/noise-client-connection.test.ts \
  src/server/relay-integration.test.ts \
  src/server/connection-handler.test.ts \
  src/application/device-gate.test.ts \
  src/application/relay-link.test.ts
pnpm --filter @perch/relay --filter @perch/agent exec vitest run \
  src/security-audit.test.ts src/server/security-audit.test.ts
pnpm --filter @perch/relay-cf exec vitest run test/security-audit.test.ts
pnpm --filter @perch/agent exec vitest run \
  src/server/security-audit.test.ts \
  src/application/device-roster.test.ts \
  src/application/pairing.test.ts \
  src/infrastructure/file-device-store.test.ts \
  src/infrastructure/file-pairing-store.test.ts
pnpm --filter @perch/agent --filter @perch/relay --filter @perch/relay-cf typecheck
bash deploy/relay-cf-deploy.test.sh
```

Baseline results: 112 secure-channel tests, 262 shared/Node relay tests, 67
Cloudflare tests, and 217 focused agent/persistence tests passed. Three additional
reproduction tests passed by asserting the vulnerable behavior described above,
for 661 distinct passing tests overall. They are proofs of current behavior, not
regression assertions that the issues have been fixed. The complete Cloudflare
suite passed again with its reproduction included (68 tests). Type checking passed
for the three affected packages, and deployment-script tests passed. The Cloudflare
fault-injection test intentionally produces an RPC exception log.

Full UI, device, deployment, and unrelated package gates were not run: no runtime
implementation or UI changed.

## Remaining work

1. ~~Remediate CF-01 and CF-02~~ — fixed (see the reassessment below): a repeated removal of a
   denied account evicts again; the agent counts auth attempts on arrival and caps the queue.
2. Verify the actual edge rate-limit and bypass configuration with WAF read access
   or a configuration export.
3. ~~Establish the deployed bundle's source revision~~ — done, see the reassessment below.
4. Schedule any live adversarial testing separately against an explicitly selected
   disposable account, with agreed traffic limits.

## Reassessment (2026-10-26)

A second, independent pass over the same evidence, with main at `707296e`.

### The audited snapshot is still current

Between the snapshot and main, no file under `packages/relay`, `packages/relay-cf` or
`packages/secure-channel`, nor the agent's `noise-client-connection.ts`, `relay-link.ts` or
`device-gate.ts`, changed; the lockfile and the three packages' manifests are unchanged too.
The findings above describe main as it is.

### Deployed Worker matches main

The downloaded production script was compared with a `wrangler deploy --dry-run` bundle of
main's `env.production`. The two differ by a single hunk: an optional field in the device-hello
schema, added to `secure-channel` after the deploy and bundled through the package's barrel.
Nothing in `packages/relay` or `packages/relay-cf` reads a device hello, so the deployed Worker
executes the same code as main. The deployment list shows no newer deployment. "Remaining work"
item 3 is closed.

### CF-01 — confirmed, with a sharper consequence

After a failed eviction there is no administrative recovery at all. `allow` only lifts the deny
entry; the account is already gone from the registry, so a repeated `remove` keeps answering 404.
The only way to evict is for the machine to join again (which reinstates its room) and be removed
once more — the opposite of what an operator removing a compromised identity wants. What still
contains it: the Worker refuses the account's new client, dial and spare upgrades within the hit
cache's lifetime, and confirms a new control socket with the registry; so the exposure is the
sockets the account already held (control, spare, pairs), which keep working until they drop.
Severity stays Medium, operational: no foothold, nothing against the Noise session.

Fix (shared core, so both hosts): when `registry.remove` reports the account as not
registered, consult the deny list; if the account is on it, run the eviction anyway and answer
200. Eviction is idempotent, so a second removal costs nothing. Keep the registry-first order:
evicting first would strand a still-registered account as removed in its room should the
registry write then fail, since a join on an existing account never reinstates. The conformance
suite checks the repeated removal on both hosts, the registry unit tests the failed-then-retried
eviction, and the Cloudflare runtime test the pair closing with 4004 on the retry.

### CF-02 — downgraded to Low (robustness)

Two constraints narrow the exposure. A sender with no credential reaches the redemption window
only by presenting a made-up pairing-shaped secret, which the agent answers from one read of the
pairing file without taking its lock; nothing the sender controls lengthens that window. The
second window, where the deadline is cancelled during enrolment persistence, opens only after
the handler accepted the credential, so the sender holds the token or a live pairing code. An
honest relay never dials back for an unknown device without a verified enrolment proof. The
realistic shape is therefore a malicious relay pressing the agent's memory, bounded by the 32
unauthenticated dial-backs the agent allows, one file read each, at ingress bandwidth. There is
no path from it to a session.

The fix, landed with this report: `auth` attempts are counted on receipt rather than when the
queue drains, the queue is capped at 16 messages (an honest phone sends nothing behind `auth`
until `authResult`), and past either bound the socket closes. A message drained from the queue
is re-held when routing an earlier one opened a new wait (an accepted auth holds what follows
until the enrolment is written).

### Other paths to a session, checked

Agent and device signatures (60 s window, small-order keys refused at intake, ZIP-215 off), the
HMAC join and admin headers, the enrolment proof and the token are all compared in constant
time; a pairing secret is spent atomically and bound to the device key; a dial-back carries the
agent's signature over the relay-minted dial id; a spare pairs a phone into the same device
check as a dial. The documented cross-relay replay of a control-socket header (the signed
message names no relay) lets a hostile relay supersede the real agent elsewhere for up to a
minute: availability only, since phones pin the agent's static key. No new finding.

### Still unverified

The zone rate-limiting rule: the wrangler credential reaches the zone but is refused on its
rulesets, and the dashboard session kept for this account had expired. Its expression, threshold,
action and any bypass remain unread. Live adversarial testing was not authorised and was not done.
