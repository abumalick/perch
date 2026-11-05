import { describe, it, expect } from 'vitest';
import { ConnectionManager } from './connection-manager';
import { WorkspaceAggregator } from './workspace-aggregator';
import type { CloseInfo, Socket } from './ports/socket';
import type { AgentMessage } from '@perch/contracts';
import { generateAgentKeys } from '@perch/secure-channel';

function fakeSocket() {
  let onMessage: (d: string) => void = () => undefined;
  let onOpen: () => void = () => undefined;
  let onClose: (info?: CloseInfo) => void = () => undefined;
  const sent: string[] = [];
  let closed = false;
  const socket: Socket = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
      onClose();
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onOpen: (cb) => {
      onOpen = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    open: () => onOpen(),
    deliver: (m: unknown) => onMessage(JSON.stringify(m)),
    fireClose: (info: CloseInfo) => onClose(info),
  };
}

const agentKey = generateAgentKeys().x25519.publicKey;

function harness() {
  const sockets: Record<string, ReturnType<typeof fakeSocket>> = {};
  const aggregator = new WorkspaceAggregator();
  const messages: Array<[string, AgentMessage]> = [];
  const statuses: Array<[string, string]> = [];
  const secureFor: string[] = [];
  const secureFakes: Array<ReturnType<typeof fakeSocket>> = [];
  const diagnostics: Array<[string, string]> = [];
  const phases: string[] = [];
  const phaseReporters: Array<(phase: string, detail: string) => void> = [];
  const spent: string[] = [];
  const manager = new ConnectionManager({
    secureSocketFactory: (key, token, onPhase) => {
      phaseReporters.push(onPhase);
      secureFor.push(`${key} ${token}`);
      return (url) => {
        const f = fakeSocket();
        sockets[url] = f;
        secureFakes.push(f);
        return f.socket;
      };
    },
    aggregator,
    onMessage: (id, m) => messages.push([id, m]),
    onStatus: (id, s) => statuses.push([id, s]),
    onDiagnostic: (id, d) => diagnostics.push([id, d.message]),
    onPhase: (id, phase, detail) => phases.push(`${id} ${phase} ${detail}`),
    schedule: () => undefined,
    onCredentialsSpent: (id) => spent.push(id),
  });
  return { manager, aggregator, sockets, messages, statuses, secureFor, secureFakes, diagnostics, phases, phaseReporters, spent };
}

const mac = { id: 'mac', name: 'Mac', addresses: ['wss://mac'], token: 't1', agentKey };
const mini = { id: 'mini', name: 'Mini', addresses: ['wss://mini'], token: 't2', agentKey };

describe('ConnectionManager relay machines', () => {
  it('connects a relay machine through the secure factory for its key', () => {
    const h = harness();
    h.manager.setMachines([{ ...mini, addresses: ['wss://relay/acct'] }]);
    expect(h.secureFor).toEqual([`${agentKey} ${mini.token}`]);
    expect(Object.keys(h.sockets)).toEqual(['wss://relay/acct']);
  });

  it('reports the phases of a connect under the machine and the address they belong to', () => {
    const h = harness();
    h.manager.setMachines([{ ...mini, addresses: ['wss://mini-a', 'wss://mini-b'] }]);
    h.phaseReporters[0]!('ws-open', '12ms');
    h.sockets['wss://mini-a']!.fireClose({ code: 1006 });
    h.phaseReporters[1]!('ws-open', '30ms');
    expect(h.phases).toEqual(['mini ws-open 12ms wss://mini-a', 'mini address wss://mini-a closed (code 1006)', 'mini ws-open 30ms wss://mini-b']);
  });

  it('remembers the address that worked across a change to the machine list', () => {
    const h = harness();
    const two = { ...mini, addresses: ['wss://mini-a', 'wss://mini-b'] };
    h.manager.setMachines([two]);
    h.sockets['wss://mini-a']!.fireClose({ code: 1006 });
    h.sockets['wss://mini-b']!.open();
    h.sockets['wss://mini-b']!.deliver({ type: 'authResult', ok: true });
    delete h.sockets['wss://mini-a'];
    delete h.sockets['wss://mini-b'];
    h.manager.setMachines([two, mac]);
    expect(Object.keys(h.sockets)).toEqual(['wss://mini-b', 'wss://mac']);
  });

  it('reports when the workspace list arrives, once per connect, timed from the attempt', () => {
    let clock = 1000;
    const phases: string[] = [];
    const fakes: Array<ReturnType<typeof fakeSocket>> = [];
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => {
        const f = fakeSocket();
        fakes.push(f);
        return f.socket;
      },
      aggregator: new WorkspaceAggregator(),
      onMessage: () => undefined,
      onStatus: () => undefined,
      onPhase: (id, phase, detail) => phases.push(`${id} ${phase} ${detail}`),
      schedule: () => undefined,
      now: () => clock,
    });
    manager.setMachines([mini]);
    fakes[0]!.open();
    fakes[0]!.deliver({ type: 'authResult', ok: true });
    clock = 1740;
    fakes[0]!.deliver({ type: 'workspaces', workspaces: [] });
    fakes[0]!.deliver({ type: 'workspaces', workspaces: [] });
    expect(phases).toEqual(['mini list 740ms']);
    clock = 5000;
    manager.reconnect('mini');
    fakes[1]!.open();
    fakes[1]!.deliver({ type: 'authResult', ok: true });
    clock = 5100;
    fakes[1]!.deliver({ type: 'workspaces', workspaces: [] });
    expect(phases).toEqual(['mini list 740ms', 'mini list 100ms']);
  });

  it('authenticates with the pairing secret while the entry holds one, even beside a token', () => {
    const h = harness();
    h.manager.setMachines([{ ...mini, pairing: 'S'.repeat(43) }]);
    expect(h.secureFor).toEqual([`${agentKey} ${'S'.repeat(43)}`]);
  });

  it("forgets an entry's credential once the agent says its key is enrolled, for every later connect", () => {
    const h = harness();
    h.manager.setMachines([{ ...mini, pairing: 'S'.repeat(43) }]);
    h.secureFakes[0]!.open();
    h.secureFakes[0]!.deliver({ type: 'authResult', ok: true, credential: 'pairing', enrolled: true });
    expect(h.spent).toEqual(['mini']);
    h.manager.reconnect('mini');
    expect(h.secureFor).toEqual([`${agentKey} ${'S'.repeat(43)}`, `${agentKey} `]);
    h.secureFakes[1]!.open();
    expect(h.secureFakes[1]!.sent.map((d) => JSON.parse(d))).toContainEqual({ type: 'auth', token: '' });
  });

  it("words a refusal with the entry's name and what it connects with", () => {
    const h = harness();
    h.manager.setMachines([{ ...mini, token: '', pairing: 'S'.repeat(43) }, mac]);
    h.secureFakes[0]!.fireClose({ code: 4403, reason: 'enrolment proof invalid' });
    h.secureFakes[1]!.fireClose({ code: 4403, reason: 'enrolment proof invalid' });
    expect(h.diagnostics).toEqual([
      ['mini', 'Pairing refused: the code is not valid for this machine — run `perch pair` on Mini for a new one'],
      ['mac', 'Mac refused the token — check the token in this entry'],
    ]);
  });

  it.each([
    ['no key', ''],
    ['a malformed key', 'not-a-key'],
    ['a key of the wrong length', agentKey.slice(0, 40)],
  ])('opens no socket for an entry with %s', (_label, key) => {
    const h = harness();
    h.manager.setMachines([{ ...mac, agentKey: key }]);
    expect(h.sockets).toEqual({});
  });

  it('opens no socket for an entry with no address it can dial', () => {
    const h = harness();
    h.manager.setMachines([{ ...mac, addresses: [] }, { ...mini, addresses: ['https://mini'] }]);
    expect(h.sockets).toEqual({});
  });

  it('drops a connected machine whose key is cleared, and never reconnects it', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.manager.setMachines([{ ...mac, agentKey: '' }]);
    expect(h.sockets['wss://mac']!.isClosed()).toBe(true);
    h.manager.send('mac', { type: 'list' });
    h.manager.reconnect('mac');
    expect(h.secureFakes).toHaveLength(1);
  });
});

describe('ConnectionManager', () => {
  it('requests the workspace list when a machine comes online', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const sent = h.sockets['wss://mac']!.sent.map((s) => JSON.parse(s) as { type: string });
    expect(sent).toContainEqual({ type: 'list' });
  });

  it('asks for the workspaces and the dictation vocabulary when a machine comes online', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const sent = h.sockets['wss://mac']!.sent.map((s) => JSON.parse(s) as { type: string });
    expect(sent.map((m) => m.type).filter((t) => t.startsWith('list'))).toEqual(['list', 'listKeyterms']);
  });

  it('opens a connection per machine and authenticates', () => {
    const h = harness();
    h.manager.setMachines([mac, mini]);
    h.sockets['wss://mac']!.open();
    expect(JSON.parse(h.sockets['wss://mac']!.sent[0]!)).toEqual({ type: 'auth', token: 't1' });
    expect(Object.keys(h.sockets)).toEqual(['wss://mac', 'wss://mini']);
  });

  it('routes workspace messages into the aggregator', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    expect(h.aggregator.snapshot().map((w) => w.id)).toEqual(['perch-a']);
  });

  it('forwards every message to onMessage with the machine id', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.sockets['wss://mac']!.deliver({ type: 'output', workspaceId: 'perch-a', data: 'aGk=' });
    expect(h.messages).toContainEqual(['mac', { type: 'output', workspaceId: 'perch-a', data: 'aGk=' }]);
  });

  it('reports status and clears a machine on offline', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    h.sockets['wss://mac']!.socket.close();
    expect(h.statuses).toContainEqual(['mac', 'offline']);
    expect(h.aggregator.snapshot()).toEqual([]);
  });

  it('closes removed machines on setMachines', () => {
    const h = harness();
    h.manager.setMachines([mac, mini]);
    h.manager.setMachines([mac]);
    expect(h.sockets['wss://mini']!.isClosed()).toBe(true);
  });

  it('sends a client message to a specific machine', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.manager.send('mac', { type: 'list' });
    expect(JSON.parse(h.sockets['wss://mac']!.sent.at(-1)!)).toEqual({ type: 'list' });
  });

  it('reconnect() drives a fresh connection attempt for one machine', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.socket.close(); // machine drops (schedule is a no-op here)
    h.manager.reconnect('mac');
    h.sockets['wss://mac']!.open();
    expect(JSON.parse(h.sockets['wss://mac']!.sent[0]!)).toEqual({ type: 'auth', token: 't1' });
  });

  it('does not open a connection for a disabled machine', () => {
    const h = harness();
    h.manager.setMachines([{ ...mac, enabled: false }]);
    expect(h.sockets['wss://mac']).toBeUndefined();
  });

  it('closes the socket and clears workspaces when a machine is disabled', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    h.manager.setMachines([{ ...mac, enabled: false }]);
    expect(h.sockets['wss://mac']!.isClosed()).toBe(true);
    expect(h.aggregator.snapshot()).toEqual([]);
  });

  it('reconnects a machine when it is re-enabled', () => {
    const h = harness();
    h.manager.setMachines([{ ...mac, enabled: false }]);
    h.manager.setMachines([mac]);
    expect(h.sockets['wss://mac']).toBeDefined();
    h.sockets['wss://mac']!.open();
    expect(JSON.parse(h.sockets['wss://mac']!.sent[0]!)).toEqual({ type: 'auth', token: 't1' });
  });

  it('clears workspaces when a machine is removed', () => {
    const h = harness();
    h.manager.setMachines([mac]);
    h.sockets['wss://mac']!.open();
    h.sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    h.sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    h.manager.setMachines([]);
    expect(h.aggregator.snapshot()).toEqual([]);
  });
});
