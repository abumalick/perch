// Caps on what one host holds open: upgrades still being answered plus the sockets they became.
// The core caps each account; these cap the host as a whole and each client address, which only
// matters once the relay is reachable from the internet.
import { addressKey } from './address-key.ts';

export interface ConnectionCaps {
  maxConnections: number;
  maxPerAddress: number;
  // TCP connections the host accepts at all, before any request says who or what it is (Node's
  // `server.maxConnections`); unset, twice `maxConnections`.
  maxSockets?: number;
  // Slots past `maxConnections` that only the agent's own sockets may take, so phones filling
  // the host cannot cut the agent off its relay.
  agentReserve?: number;
}

export interface ConnectionSlot {
  release(): void;
}

export class ConnectionLimiter {
  private total = 0;
  private readonly perAddress = new Map<string, number>();

  constructor(private readonly caps: ConnectionCaps) {}

  get size(): number {
    return this.total;
  }

  // A null address counts against the host only: for the agent's own sockets, which share the
  // home address with a phone on the home network and must carry a signature anyway.
  acquire(address: string | null): ConnectionSlot | null {
    const held = address === null ? 0 : (this.perAddress.get(address) ?? 0);
    if (this.total >= this.caps.maxConnections || held >= this.caps.maxPerAddress) return null;
    return this.take(address);
  }

  // The agent's control socket and dial-backs: the host cap plus the reserve.
  acquireAgent(): ConnectionSlot | null {
    if (this.total >= this.caps.maxConnections + (this.caps.agentReserve ?? 0)) return null;
    return this.take(null);
  }

  private take(address: string | null): ConnectionSlot {
    this.total += 1;
    const held = address === null ? 0 : (this.perAddress.get(address) ?? 0);
    if (address !== null) this.perAddress.set(address, held + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        if (address === null) return;
        const left = (this.perAddress.get(address) ?? 1) - 1;
        if (left > 0) this.perAddress.set(address, left);
        else this.perAddress.delete(address);
      },
    };
  }
}

function isLoopback(address: string): boolean {
  return address === '::1' || (addressKey(address)?.startsWith('127.') ?? false);
}

export interface ClientAddress {
  // The key for the per-address cap, or null to count against the host only.
  counted: string | null;
  // What a log line names.
  label: string;
}

// `forwarded` is the configured client-IP header's value, or undefined when none is configured.
// Only a proxy on the relay's own machine is believed, since any other peer could have written the
// header itself; a list (X-Forwarded-For) is read from its last entry, the one that proxy appended.
// A loopback peer that names no client is a local proxy or process standing for clients it does
// not tell apart, so it is counted against the host only: keyed on its address, a few connections
// through that proxy would lock out every other client, the owner included.
export function clientAddress(peer: string | undefined, forwarded: string | undefined): ClientAddress {
  if (!peer) return { counted: 'unknown', label: 'unknown' };
  if (!isLoopback(peer)) return { counted: peer, label: peer };
  const address = addressKey(forwarded?.split(',').at(-1)?.trim() ?? '');
  if (address) return { counted: address, label: address };
  return { counted: null, label: peer };
}
