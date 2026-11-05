// The response headers tarfa.app sends, written at build into dist/_headers, which the
// static-assets Worker applies to every response (the file itself is not served). The CSP is the
// <meta> one plus what only a header can carry: frame-ancestors, and a policy for sw.js, which a
// worker takes from its response headers alone.
import { CONTENT_SECURITY_POLICY } from './csp';

// Only what the app uses, for its own origin: dictation's microphone, the QR scanner's camera,
// paste and copy, the screen kept on while recording, and links handed to the share sheet.
// Everything else it names is off.
const ALLOWED = ['microphone', 'camera', 'clipboard-read', 'clipboard-write', 'screen-wake-lock', 'web-share'];
const DENIED = ['geolocation', 'payment', 'usb', 'serial', 'bluetooth', 'hid', 'midi', 'display-capture', 'accelerometer', 'gyroscope', 'magnetometer'];

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // No includeSubDomains or preload: those bind every future subdomain and are slow to undo.
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': [...ALLOWED.map((f) => `${f}=(self)`), ...DENIED.map((f) => `${f}=()`)].join(', '),
};

export const HEADERS_FILE = '_headers';

export function buildHeadersFile(headers: Record<string, string> = SECURITY_HEADERS): string {
  return ['/*', ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ''].join('\n');
}
