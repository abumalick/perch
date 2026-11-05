import { deviceFingerprint, parsePairingLink, type PairingLink } from '@tarfa/secure-channel';
import type { MachineConfig } from './settings-store';
import { addressHost, normalizeAddress } from './machine-addresses';
import { msg } from '../i18n.svelte';

export type Paired = { ok: true; machine: MachineConfig } | { ok: false; reason: string };

// The entry a pairing link makes. The phone keeps one entry per machine, known by its agent key:
// a link naming a key the phone already has updates that entry (its addresses become the link's,
// in the link's order), so scanning again after a failed attempt (an expired code) or after the
// machine moved retries in place. A link naming an address that another key's entry holds is
// refused: taking it would point that entry's address at a key whoever made the link may hold. An
// existing entry keeps its own name and default path; the link's path only fills one it lacks.
export function pairedMachine(machines: MachineConfig[], link: PairingLink, newId: () => string): Paired {
  const addresses = link.urls.flatMap((url) => normalizeAddress(url) ?? []);
  const taken = machines.find((m) => m.agentKey?.trim() !== link.agentKey && m.addresses?.some((a) => addresses.includes(normalizeAddress(a) ?? a)));
  if (taken) return { ok: false, reason: msg().pairing.otherKey(taken.name) };
  const existing = machines.find((m) => m.agentKey?.trim() === link.agentKey);
  const defaultPath = existing?.defaultPath || link.defaultPath;
  const path = defaultPath ? { defaultPath } : {};
  if (existing) return { ok: true, machine: { ...existing, addresses, ...path, pairing: link.secret, enabled: true } };
  return { ok: true, machine: { id: newId(), name: link.name, addresses, token: '', agentKey: link.agentKey, ...path, pairing: link.secret } };
}

// What the owner is asked before a pairing link adds anything: any page can open such a link. It
// names every host the entry will dial, and the machine key's fingerprint that `tarfa pair` prints
// beside the code, to compare by eye.
export function pairingQuestion(link: PairingLink): string {
  return msg().pairing.question(link.name, link.urls.map(addressHost).join(', '), deviceFingerprint(link.agentKey));
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

// A pairing link pasted, scanned or tapped. A full link must name this app's own origin: one
// made for another Tarfa is not this app's to take. A bare fragment names none.
export function readPairingLink(text: string, ownOrigin: string): { ok: true; link: PairingLink } | { ok: false; reason: string } {
  const link = parsePairingLink(text);
  if (!link) return { ok: false, reason: msg().pairing.notALink };
  const trimmed = text.trim();
  if (!trimmed.startsWith('#')) {
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      return { ok: false, reason: msg().pairing.notALink };
    }
    if (origin !== ownOrigin) return { ok: false, reason: msg().pairing.otherOrigin(origin, ownOrigin) };
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
