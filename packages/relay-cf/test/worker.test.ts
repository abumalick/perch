import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { JOIN_HEADER, accountId, generateAgentKeys, signAgentAuth, signJoinAuth } from '@perch/secure-channel';

// The relay contract itself is test/conformance.test.ts; this file holds what only the Worker has.
describe('relay worker', () => {
  it("verifies agent signatures with the runtime's native Ed25519", async () => {
    // The pure-JS verifier alone eats much of the free plan's 10 ms CPU budget per request.
    const account = env.TEST_ACCOUNT;
    const now = Date.now();
    const joined = await SELF.fetch(`https://relay.test/${account}?role=join&key=${env.TEST_AGENT_PUBLIC_KEY}`, {
      method: 'POST',
      headers: {
        authorization: signAgentAuth(env.TEST_AGENT_KEY, { account, role: 'join' }, now),
        [JOIN_HEADER]: signJoinAuth(env.JOIN_KEY!, { account, role: 'join' }, now),
      },
    });
    await joined.body?.cancel();
    expect([200, 201]).toContain(joined.status);
    const verify = vi.spyOn(crypto.subtle, 'verify');
    const res = await SELF.fetch(`https://relay.test/${account}?role=agent`, {
      headers: { upgrade: 'websocket', authorization: signAgentAuth(env.TEST_AGENT_KEY, { account, role: 'agent' }, Date.now()) },
    });
    expect(res.status).toBe(101);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ed25519' }), expect.anything(), expect.anything(), expect.anything());
    verify.mockRestore();
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  // An upgrade already past the registry when its account is removed, or a phone's request
  // answered from another isolate's stale hit, still reaches the account's RelayRoom: it must
  // refuse it there and write nothing back into the evicted object.
  it('refuses every role in an evicted RelayRoom until the account joins again', async () => {
    const keys = generateAgentKeys();
    const account = accountId(keys.ed25519.publicKey);
    const room = env.RELAY.getByName(account);
    await room.evict();
    const agent = await room.fetch(new Request(`https://relay.test/${account}?role=agent`, { headers: { upgrade: 'websocket' } }));
    expect(agent.status).toBe(404);
    await agent.body?.cancel();
    const challenge = await room.fetch(new Request(`https://relay.test/${account}?role=challenge`));
    expect(challenge.status).toBe(404);
    await challenge.body?.cancel();
    const client = await room.fetch(new Request(`https://relay.test/${account}`, { headers: { upgrade: 'websocket' } }));
    expect(client.status).toBe(101);
    const closed = new Promise<number>((resolve) => client.webSocket!.addEventListener('close', (e) => resolve(e.code)));
    client.webSocket!.accept();
    expect(await closed).toBe(4404);
    await room.reinstate();
    const again = await room.fetch(new Request(`https://relay.test/${account}?role=challenge`));
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });
});
