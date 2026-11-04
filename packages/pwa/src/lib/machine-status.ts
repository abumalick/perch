import type { ConnectionStatus } from '../core/machine-connection';
import { msg } from '../i18n.svelte';
import { en } from '../core/i18n/en';

export type ConnectionError = { message: string; code?: number; refused?: boolean; at: number };

// Getters, so each read at a call site takes the current language.
export const STATUS_LABEL: Record<ConnectionStatus | 'off', string> = {
  get online() { return msg().status.connection.online; },
  get connecting() { return msg().status.connection.connecting; },
  get offline() { return msg().status.connection.offline; },
  get off() { return msg().status.connection.off; },
};

export function relative(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return msg().status.secondsAgo(secs);
  const mins = Math.round(secs / 60);
  if (mins < 60) return msg().status.minutesAgo(mins);
  return msg().status.hoursAgo(Math.round(mins / 60));
}

// A connection's diagnostic is recorded in English, the words the connection log keeps, and
// worded in the current language only here. A refusal is already worded; anything unknown is
// shown as it came.
function wordDiagnostic(message: string): string {
  const words = msg().status.diagnostic;
  const english = en.status.diagnostic;
  const known: Record<string, string> = {
    [english.timedOut]: words.timedOut,
    [english.dropped]: words.dropped,
    [english.authRejected]: words.authRejected,
    [english.legacyEntry]: words.legacyEntry,
    [english.networkError]: words.networkError,
    [english.neverOpened]: words.neverOpened,
    [english.secureChannel]: words.secureChannel,
  };
  if (known[message]) return known[message];
  const failed = /^connection failed \((.*)\)$/s.exec(message);
  if (failed) return words.failed(known[failed[1]!] ?? failed[1]!);
  const closed = /^closed by agent — (.*)$/s.exec(message);
  if (closed) return words.closedByAgent(closed[1]!);
  return message;
}

export function describeConnectionError(err: ConnectionError): string {
  const code = err.code && !err.refused ? msg().status.errorCode(err.code) : '';
  const message = err.refused ? err.message : wordDiagnostic(err.message);
  return `${message}${code} · ${relative(err.at)}`;
}
