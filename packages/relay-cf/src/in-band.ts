// A phone's refusal, as a browser can read it: the upgrade completes and the socket closes at once
// with the code and reason (see the relay core). The socket is accepted here, not by a Durable
// Object, so nothing is ever filed for it.
export function refusedInBand(code: number, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
