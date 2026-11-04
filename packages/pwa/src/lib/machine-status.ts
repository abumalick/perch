import type { ConnectionStatus } from '../core/machine-connection';
import { msg } from '../i18n.svelte';

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

export function describeConnectionError(err: ConnectionError): string {
  const code = err.code && !err.refused ? msg().status.errorCode(err.code) : '';
  return `${err.message}${code} · ${relative(err.at)}`;
}
