// The key a client address is counted under, for every per-address limit on every host. Pure, with
// nothing Node-only, so the Worker keys its limits the same way the Node server does.
//
// One subscriber gets a whole IPv6 /64 (Cloudflare's rate limit counts the same way), so a limit on
// single IPv6 addresses would not hold them; an IPv4-mapped address is its IPv4 one. Null for
// anything that is not an address.
export function addressKey(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) return v4.join('.');
  const groups = parseIPv6(address);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // A leading zero is refused, as Node's isIP does: some parsers read it as octal.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function parseIPv6(text: string): number[] | null {
  const zone = text.indexOf('%');
  const address = zone === -1 ? text : text.slice(0, zone);
  if (zone !== -1 && zone === text.length - 1) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array<number>(missing).fill(0), ...tail] : null;
}

// Colon-separated hex groups; the last may be a dotted IPv4 address when it ends the address.
function parseGroups(text: string, endsAddress: boolean): number[] | null {
  if (text === '') return [];
  const parts = text.split(':');
  const groups: number[] = [];
  for (const [i, part] of parts.entries()) {
    if (endsAddress && i === parts.length - 1 && part.includes('.')) {
      const v4 = parseIPv4(part);
      if (!v4) return null;
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
      groups.push(parseInt(part, 16));
    } else {
      return null;
    }
  }
  return groups;
}
