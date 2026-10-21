// A phone pairing link: what a phone needs to reach a machine through a relay and enrol itself,
// in one URL a QR code can carry. Everything sits in the fragment, which a browser never sends to
// any server, so neither the PWA's host nor anything in between sees the secret.
import { randomBytes } from '@noble/hashes/utils.js';
import { b64url } from './keys';

export interface PairingLink {
  // The relay machine entry's URL: ws(s)://<relay>/<account>.
  url: string;
  // The agent's X25519 public key, which the Noise session pins.
  agentKey: string;
  // One-time and short-lived; it stands in for the token when the device key is enrolled.
  secret: string;
  // The machine's name, which the new entry is called by.
  name: string;
  // Where relative New-workspace paths resolve on that machine: PERCH_DEFAULT_PATH, when set.
  defaultPath?: string;
}

const PREFIX = '#pair?';
const KEY = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME = 64;
// Each character makes the QR code denser; a longer path is not one anyone would type relative to.
const MAX_PATH = 128;

export function isPairingPath(path: string): boolean {
  return path.startsWith('/') && path.length <= MAX_PATH && !/[\u0000-\u001f\u007f]/.test(path);
}

export function generatePairingSecret(): string {
  return b64url.encode(randomBytes(32));
}

// `:` and `/` are left as they are (URLSearchParams reads them back unchanged): percent-encoding
// them would only make the QR code denser.
const encode = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2F/gi, '/');

export function pairingLink(pwaOrigin: string, pairing: PairingLink): string {
  const query = Object.entries({
    u: pairing.url,
    k: pairing.agentKey,
    s: pairing.secret,
    n: pairing.name,
    ...(pairing.defaultPath ? { p: pairing.defaultPath } : {}),
  })
    .map(([name, value]) => `${name}=${encode(value)}`)
    .join('&');
  return `${new URL(pwaOrigin).origin}/${PREFIX}${query}`;
}

// A pairing link, or just its fragment (what the PWA reads off its own location). Null for
// anything incomplete or malformed: a half-read QR code must not produce a half-made entry.
export function parsePairingLink(text: string): PairingLink | null {
  const trimmed = text.trim();
  const hash = trimmed.startsWith('#') ? trimmed : trimmed.slice(Math.max(0, trimmed.indexOf('#')));
  if (!trimmed.includes('#') || !hash.startsWith(PREFIX)) return null;
  const query = new URLSearchParams(hash.slice(PREFIX.length));
  const [url, agentKey, secret] = ['u', 'k', 's'].map((name) => query.get(name) ?? '');
  const name = (query.get('n') ?? '').trim() || 'machine';
  if (!KEY.test(agentKey!) || !KEY.test(secret!) || name.length > MAX_NAME || !isRelayMachineUrl(url!)) return null;
  // A path the phone cannot use costs the path, not the pairing.
  const defaultPath = query.get('p') ?? '';
  return { url: url!, agentKey: agentKey!, secret: secret!, name, ...(isPairingPath(defaultPath) ? { defaultPath } : {}) };
}

// Plain ws: would carry the phone's upgrade (its signature and enrolment proof) in the clear, so
// only a relay on the phone's own machine may use it: a loopback address (the e2e's fake relay, or
// a relay tried on the same machine).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isRelayMachineUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const secure = url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname));
    return secure && /^\/[\w-]{1,64}$/.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}
