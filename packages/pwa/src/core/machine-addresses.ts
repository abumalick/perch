import { isMachineUrl, MAX_ADDRESSES } from '@tarfa/secure-channel';

// An address as the phone stores and compares it: `wss://host` and `wss://host/` are one
// address, so a link spelling it either way finds the entry that holds it. Null for anything a
// pairing link could not carry.
export function normalizeAddress(text: string): string | null {
  const trimmed = text.trim();
  return isMachineUrl(trimmed) ? new URL(trimmed).href : null;
}

// The Settings editor's addresses, one per line in the order they are tried. Null when there is
// none, more than a pairing link can carry, or a line that is no address: saving it would leave
// an entry that cannot connect.
export function parseAddressLines(text: string): string[] | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const addresses: string[] = [];
  for (const line of lines) {
    const address = normalizeAddress(line);
    if (!address) return null;
    if (!addresses.includes(address)) addresses.push(address);
  }
  return addresses.length > 0 && addresses.length <= MAX_ADDRESSES ? addresses : null;
}

export function addressHost(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
