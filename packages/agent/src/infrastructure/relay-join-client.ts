import { JOIN_HEADER } from '@perch/secure-channel';
import type { JoinRequest, RelayJoinPort } from '../ports/relay-join-port';

// POST <relay>/<account>?role=join over HTTP(S): the relay's ws(s):// URL with the scheme swapped.
export const relayJoinClient: RelayJoinPort = {
  async join(relayUrl: string, request: JoinRequest) {
    const url = new URL(`${relayUrl.replace(/^ws/, 'http')}/${request.account}`);
    url.searchParams.set('role', 'join');
    url.searchParams.set('key', request.key);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: request.authorization, [JOIN_HEADER]: request.join } });
    } catch (err) {
      throw new Error(`cannot reach the relay at ${url.origin}: ${err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err)}`);
    }
    return { status: res.status, body: await res.text() };
  },
};
