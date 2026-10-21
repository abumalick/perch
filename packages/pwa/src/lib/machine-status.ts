import type { ConnectionStatus } from '../core/machine-connection';

export type ConnectionError = { message: string; code?: number; refused?: boolean; at: number };

export const STATUS_LABEL: Record<ConnectionStatus | 'off', string> = {
  online: 'Online',
  connecting: 'Connecting…',
  offline: 'Offline',
  off: 'Off',
};

export function relative(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function describeConnectionError(err: ConnectionError): string {
  const code = err.code && !err.refused ? ` (code ${err.code})` : '';
  return `${err.message}${code} · ${relative(err.at)}`;
}
