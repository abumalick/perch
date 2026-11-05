import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { portOwner } from './port-owner';

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

describe('portOwner', () => {
  it('reads a port nobody holds as free', async () => {
    const { server, port } = await listen();
    await new Promise((resolve) => server.close(resolve));
    expect(await portOwner(port)).toBe('free');
  });

  it('reads a port held by a process that is not the agent as another\'s', async () => {
    const { server, port } = await listen();
    try {
      expect(await portOwner(port)).toBe('other');
    } finally {
      server.close();
    }
  });
});
