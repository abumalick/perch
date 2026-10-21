import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '@perch/secure-channel';
import { createWsRelayTransport } from './ws-relay-transport';
import { wsFrameSocket } from './ws-frame-socket';

// Accepts TCP connections and never answers, like a relay host that stalls mid-handshake.
let server: Server | null = null;
const held: Socket[] = [];

afterEach(async () => {
  held.splice(0).forEach((s) => s.destroy());
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

async function silentServer(): Promise<string> {
  server = createServer((socket) => held.push(socket));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/acct`;
}

describe('ws relay transport', () => {
  it('gives up on a control socket stuck in the handshake, so the link redials', async () => {
    const url = await silentServer();
    const transport = createWsRelayTransport({ handshakeTimeoutMs: 100 });
    const control = transport.openControl(`${url}?role=agent`, {});
    const closed = new Promise<void>((resolve) => control.onClose(() => resolve()));
    await expect(Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 2000))])).resolves.toBe('closed');
  });

  it('fails a dial stuck in the handshake', async () => {
    const url = await silentServer();
    const transport = createWsRelayTransport({ handshakeTimeoutMs: 100 });
    await expect(transport.dial(`${url}?role=dial`, {})).rejects.toThrow();
  });

  it('sends the given headers on both upgrades, and control frames once open', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const seen: Array<string | undefined> = [];
    const received: string[] = [];
    wss.on('connection', (socket, req) => {
      seen.push(req.headers.authorization);
      socket.on('message', (data) => received.push(String(data)));
    });
    const base = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct`;
    const transport = createWsRelayTransport();
    const control = transport.openControl(`${base}?role=agent`, { authorization: 'control-sig' });
    control.send('dropped before open');
    await new Promise<void>((resolve) => control.onOpen(resolve));
    control.send('ping');
    const dialed = await transport.dial(`${base}?role=dial`, { authorization: 'dial-sig' });
    await vi.waitFor(() => {
      expect(seen).toEqual(['control-sig', 'dial-sig']);
      expect(received).toEqual(['ping']);
    });
    control.close();
    dialed.terminate();
    await new Promise((r) => wss.close(r));
  });

  it('keeps a spare until the relay says paired, then hands it over with only binary frames', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const relaySide = new Promise<import('ws').WebSocket>((resolve) => wss.on('connection', resolve));
    const transport = createWsRelayTransport();
    const spare = transport.spare(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct?role=spare`, {});
    let closedUnpaired = false;
    spare.onClose(() => (closedUnpaired = true));
    await new Promise<void>((resolve) => spare.onOpen(resolve));
    const relay = await relaySide;
    const pings: string[] = [];
    relay.on('message', (data) => pings.push(String(data)));
    spare.send('ping');
    await vi.waitFor(() => expect(pings).toEqual(['ping']));
    relay.send('pong');
    const handed = new Promise<import('ws').WebSocket>((resolve) => spare.onPaired(resolve));
    relay.send('paired');
    const socket = wsFrameSocket(await handed, true);
    const frames: number[][] = [];
    socket.onFrame((frame) => frames.push([...frame]));
    relay.send('pong');
    relay.send(Uint8Array.of(7, 8), { binary: true });
    await vi.waitFor(() => expect(frames).toEqual([[7, 8]]));
    socket.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(closedUnpaired).toBe(false);
    await new Promise((r) => wss.close(r));
  });

  it('closes a spare that the relay sends a frame before pairing it, and one stuck in the handshake', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (socket) => socket.send(Uint8Array.of(1), { binary: true }));
    const transport = createWsRelayTransport({ handshakeTimeoutMs: 100 });
    const spare = transport.spare(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct?role=spare`, {});
    spare.onPaired(() => {
      throw new Error('not paired');
    });
    await new Promise<void>((resolve) => spare.onClose(resolve));
    await new Promise((r) => wss.close(r));
    const stuck = transport.spare(`${await silentServer()}?role=spare`, {});
    await new Promise<void>((resolve) => stuck.onClose(resolve));
  });

  it("hands the relay's close code to the link, so it can tell a supersede from a drop", async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (socket) => socket.close(4000, 'superseded'));
    const transport = createWsRelayTransport();
    const control = transport.openControl(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct?role=agent`, {});
    expect(await new Promise<number>((resolve) => control.onClose(resolve))).toBe(4000);
    await new Promise((r) => wss.close(r));
  });

  it('refuses a frame larger than one Noise frame on both relay sockets', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    // What the relay side sees: the agent closing with 1009 (message too big).
    const codes: number[] = [];
    wss.on('connection', (socket) => {
      socket.on('close', (code) => codes.push(code));
      socket.send(new Uint8Array(MAX_FRAME_BYTES + 1));
    });
    const base = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct`;
    const transport = createWsRelayTransport();
    const control = transport.openControl(`${base}?role=agent`, {});
    await new Promise<void>((resolve) => control.onClose(() => resolve()));
    const dialed = await transport.dial(`${base}?role=dial`, {});
    await new Promise((r) => dialed.once('close', r));
    await vi.waitFor(() => expect(codes).toEqual([1009, 1009]));
    await new Promise((r) => wss.close(r));
  });

  // A compression context per socket is memory the relay could make the agent hold.
  it('offers no compression on either relay socket', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const offered: Array<string | undefined> = [];
    wss.on('connection', (_socket, req) => offered.push(req.headers['sec-websocket-extensions']));
    const base = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct`;
    const transport = createWsRelayTransport();
    const control = transport.openControl(`${base}?role=agent`, {});
    const dialed = await transport.dial(`${base}?role=dial`, {});
    await vi.waitFor(() => expect(offered).toEqual([undefined, undefined]));
    control.close();
    dialed.terminate();
    await new Promise((r) => wss.close(r));
  });

  // ws waits 30 s for the peer's close frame; a relay that never sends one would keep every
  // refused socket alive that long.
  it('closes a dialed socket within a second even when the relay never answers the close', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (socket) => (socket as unknown as { _socket: { pause(): void } })._socket.pause());
    const transport = createWsRelayTransport();
    const frames = wsFrameSocket(await transport.dial(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct?role=dial`, {}));
    const closed = new Promise<void>((resolve) => frames.onClose(resolve));
    const started = Date.now();
    frames.close(4003, 'device not enrolled');
    await closed;
    expect(Date.now() - started).toBeLessThan(2000);
    wss.clients.forEach((client) => client.terminate());
    await new Promise((r) => wss.close(r));
  });

  // The close frame carries the refusal the phone is shown.
  it('still sends the close code and reason before giving up on the socket', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const seen = new Promise<[number, string]>((resolve) =>
      wss.on('connection', (socket) => socket.on('close', (code, reason) => resolve([code, String(reason)]))),
    );
    const transport = createWsRelayTransport();
    const frames = wsFrameSocket(await transport.dial(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acct?role=dial`, {}));
    frames.close(4003, 'device not enrolled');
    expect(await seen).toEqual([4003, 'device not enrolled']);
    await new Promise((r) => wss.close(r));
  });
});
