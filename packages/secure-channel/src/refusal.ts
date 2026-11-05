// Why the agent refused a phone. A browser learns nothing from a refused WebSocket upgrade
// (whatever the status, its socket reports 1006), so a phone is refused in band: its upgrade is
// completed and closed at once, with DEVICE_REFUSED or IN_BAND_REFUSAL + an HTTP status, and one
// of these as the close reason.
export const REFUSAL = {
  notEnrolled: 'device not enrolled',
  revoked: 'device revoked',
  // A device whose key is enrolled sent the token anyway: it should forget it.
  tokenNotNeeded: 'token not needed',
  // Token enrolment is off: only a pairing code enrols a new phone.
  enrolmentOff: 'enrolment off',
  // No new phone can enrol, pairing code or not.
  enrolmentClosed: 'enrolment closed',
  // The phone's entry pins another agent key than this machine's.
  wrongAgentKey: 'wrong agent key',
  // The roster declined a device the credential had admitted (its id is taken).
  enrolmentRefused: 'enrolment refused',
  codeExpired: 'pairing code expired',
  codeUsed: 'pairing code used',
  tooManyPending: 'too many pending clients',
  tooManyConnections: 'too many connections',
} as const;

export type Refusal = (typeof REFUSAL)[keyof typeof REFUSAL];

export const IN_BAND_REFUSAL = 4000;
// The agent's own close for a device it will not serve.
export const DEVICE_REFUSED = 4003;
