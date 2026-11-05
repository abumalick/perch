import { WebSocket } from 'ws';

// Whether the phone port answers a WebSocket upgrade. A freshly restarted agent takes a few
// seconds to listen, so each attempt gets `attemptMs` and they go on until `totalMs`.
export async function answersUpgrade(port: number, options: { attemptMs?: number; totalMs?: number } = {}): Promise<boolean> {
  const attemptMs = options.attemptMs ?? 5_000;
  const deadline = Date.now() + (options.totalMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await attempt(port, attemptMs)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function attempt(port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: false });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    socket.once('open', () => done(true));
    socket.once('error', () => done(false));
  });
}
