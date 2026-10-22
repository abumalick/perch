// Why the relay, or the agent through it, refused a phone. A browser learns nothing from a
// refused WebSocket upgrade (whatever the status, its socket reports 1006), so the relay completes
// a phone's upgrade and closes it at once with IN_BAND_REFUSAL + the HTTP status, and one of these
// as the close reason. The agent closes a session with the same words (DEVICE_REFUSED).
export const REFUSAL = {
  challenge: 'unknown or expired challenge',
  // The phone's answer to a challenge sent on its socket was not one the relay could read.
  invalidReply: 'invalid challenge reply',
  challengeUnanswered: 'challenge not answered',
  signature: 'device signature invalid',
  deviceKeyRequired: 'device key required',
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
  // An agent from before refusals carried a reason.
  enrolmentRefused: 'enrolment refused',
  codeExpired: 'pairing code expired',
  codeUsed: 'pairing code used',
  // The proof matched neither the token nor a pairing code the agent issued recently.
  proofInvalid: 'enrolment proof invalid',
  agentOffline: 'agent offline',
  agentSilent: 'agent did not dial',
  tooManyPending: 'too many pending clients',
  tooManyConnections: 'too many connections',
  // Unknown keys asking the agent to enrol them, past the relay's per-account budget.
  tooManyEnrolments: 'too many enrolment attempts',
  unknownAccount: 'unknown account',
  internal: 'internal error',
} as const;

export type Refusal = (typeof REFUSAL)[keyof typeof REFUSAL];

// What an agent may tell the relay when it refuses an enrolment.
export const AGENT_REFUSALS = [
  REFUSAL.enrolmentOff,
  REFUSAL.enrolmentClosed,
  REFUSAL.revoked,
  REFUSAL.codeExpired,
  REFUSAL.codeUsed,
  REFUSAL.proofInvalid,
  // The agent's own bound on enrolment checks, past the relay's.
  REFUSAL.tooManyEnrolments,
] as const;
export type AgentRefusal = (typeof AGENT_REFUSALS)[number];

export const IN_BAND_REFUSAL = 4000;
// The agent's own close for a device it will not serve, forwarded to the phone by the relay.
export const DEVICE_REFUSED = 4003;
