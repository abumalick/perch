import { deviceFingerprint, parsePairingLink, type PairingLink } from '@perch/secure-channel';
import type { MachineConfig } from './settings-store';

export type Paired = { ok: true; machine: MachineConfig } | { ok: false; reason: string };

// The relay entry a pairing link makes. A link for an entry the phone already has, with the same
// agent key, updates it rather than adding a second one, so scanning again after a failed attempt
// (an expired code) retries in place. A link naming another agent key for that entry is refused:
// taking it would re-pin the entry to a key whoever made the link may hold, and hand them the
// entry's token on the next connect. An existing entry keeps its own name and default path; the
// link's path only fills one it lacks.
export function pairedMachine(machines: MachineConfig[], link: PairingLink, newId: () => string): Paired {
  const existing = machines.find((m) => m.url === link.url);
  if (existing && existing.agentKey?.trim() !== link.agentKey) {
    return { ok: false, reason: `This code names another key for ${existing.name} than the one this phone trusts. If the machine's identity changed, remove that entry first.` };
  }
  const defaultPath = existing?.defaultPath || link.defaultPath;
  const path = defaultPath ? { defaultPath } : {};
  if (existing) return { ok: true, machine: { ...existing, ...path, pairing: link.secret, enabled: true } };
  return { ok: true, machine: { id: newId(), name: link.name, url: link.url, token: '', agentKey: link.agentKey, ...path, pairing: link.secret } };
}

// What the owner is asked before a pairing link adds anything: any page can open such a link. The
// machine key's fingerprint is the one `perch pair` prints beside the code, to compare by eye.
export function pairingQuestion(link: PairingLink): string {
  return (
    `Pair with ${link.name} through ${new URL(link.url).host}?\n\n` +
    `Machine key ${deviceFingerprint(link.agentKey)}: check it matches what perch pair printed.\n\n` +
    'Continue only if you just ran perch pair or perch connect on that machine.'
  );
}

export interface PairingPrompts {
  confirm: (question: string) => boolean;
  alert: (message: string) => void;
  newId: () => string;
}

// Accepting a pairing link: the entry to add, or null when the link is refused (the owner is told
// why) or the owner declines the pairing question.
export function acceptPairingLink(machines: MachineConfig[], link: PairingLink, prompts: PairingPrompts): MachineConfig | null {
  const paired = pairedMachine(machines, link, prompts.newId);
  if (!paired.ok) {
    prompts.alert(paired.reason);
    return null;
  }
  return prompts.confirm(pairingQuestion(link)) ? paired.machine : null;
}

const NOT_A_LINK = 'That is not a Perch pairing code. Run `perch pair` on the machine for a fresh one.';

// A pairing link pasted, scanned or tapped. A full link must name this app's own origin: one
// made for another Perch is not this app's to take. A bare fragment names none.
export function readPairingLink(text: string, ownOrigin: string): { ok: true; link: PairingLink } | { ok: false; reason: string } {
  const link = parsePairingLink(text);
  if (!link) return { ok: false, reason: NOT_A_LINK };
  const trimmed = text.trim();
  if (!trimmed.startsWith('#')) {
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      return { ok: false, reason: NOT_A_LINK };
    }
    if (origin !== ownOrigin) return { ok: false, reason: `This pairing code is for the Perch at ${origin}, not this one (${ownOrigin}).` };
  }
  return { ok: true, link };
}

// A pairing link opened in the PWA: the link, taken off the location, which is rewritten
// without its fragment at once so the secret stays neither in the address bar nor in history.
export function takePairingFragment(
  location: { hash: string; pathname: string; search: string },
  replace: (url: string) => void,
): PairingLink | null {
  // Read before replacing: `location` is live, and the replace empties its hash.
  const { hash, pathname, search } = location;
  if (!hash.startsWith('#pair')) return null;
  replace(`${pathname}${search}`);
  return parsePairingLink(hash);
}

// iOS keeps a Home Screen web app's storage apart from Safari's and from the in-app browsers other
// apps open links in, and no link ever opens the Home Screen app: a link paired there would leave
// the app with nothing, and spend the one-time code. `navigator.standalone` exists only on iOS
// WebKit, false outside the Home Screen app.
export function outsideInstalledApp(nav: { standalone?: boolean }): boolean {
  return nav.standalone === false;
}
