// The device gate run on the phone's own socket: the relay accepts the upgrade, sends a challenge,
// and the phone answers with what it would otherwise have put in the upgrade's query. Text frames,
// outside the Noise session; nothing here is forwarded to the agent. `ready` tells the phone its
// socket now reaches the agent, so it may start the handshake.

// The upgrade query that asks for the gate. A relay that predates it ignores the parameter.
export const GATE_PARAM = 'challenge';
export const GATE_READY = '{"type":"ready"}';
// An honest reply is a few hundred bytes.
export const MAX_GATE_REPLY_BYTES = 1024;

export interface DeviceParams {
  key: string;
  nonce: string;
  sig: string;
  proof?: string;
  // What the phone says it made the proof with. Unchecked: the agent only names a failure by it.
  cred?: 'pairing' | 'token';
}

// The same shapes the agent accepts in a dial: anything else would be forwarded, then dropped by
// the agent, and hold a pending slot until the dial timeout. Null when any is malformed.
export function parseDeviceParams(get: (name: string) => unknown): DeviceParams | null {
  const [key, nonce, sig, proof, cred] = ['device', 'nonce', 'sig', 'proof', 'cred'].map(get);
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return null;
  if (typeof nonce !== 'string' || !/^[\w-]{1,128}$/.test(nonce)) return null;
  if (proof !== undefined && proof !== null && (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(proof))) return null;
  return {
    key,
    nonce,
    sig,
    ...(proof ? { proof } : {}),
    ...(cred === 'pairing' || cred === 'token' ? { cred } : {}),
  };
}

export function encodeGateChallenge(nonce: string): string {
  return JSON.stringify({ type: 'challenge', nonce });
}

export function parseGateChallenge(text: string): string | null {
  const message = parseObject(text);
  return message?.type === 'challenge' && typeof message.nonce === 'string' && message.nonce ? message.nonce : null;
}

export function encodeGateReply(params: DeviceParams): string {
  const { key, ...rest } = params;
  return JSON.stringify({ type: 'device', device: key, ...rest });
}

export function parseGateReply(text: string): DeviceParams | null {
  const message = parseObject(text);
  if (message?.type !== 'device') return null;
  return parseDeviceParams((name) => message[name]);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
