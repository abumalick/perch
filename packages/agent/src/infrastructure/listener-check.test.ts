import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { answersUpgrade } from './listener-check';

describe('answersUpgrade', () => {
  it('is true for a WebSocket server', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    try {
      expect(await answersUpgrade((wss.address() as { port: number }).port, { totalMs: 2_000 })).toBe(true);
    } finally {
      wss.close();
    }
  });

  it('is false for a port that never upgrades', async () => {
    const server = createServer((socket) => socket.end('HTTP/1.1 404 Not Found\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      expect(await answersUpgrade((server.address() as { port: number }).port, { attemptMs: 500, totalMs: 800 })).toBe(false);
    } finally {
      server.close();
    }
  });
});
