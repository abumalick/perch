import { DEVICE_REFUSED, IN_BAND_REFUSAL, REFUSAL } from '@perch/secure-channel';

// What the entry connects with, which is how a failed enrolment proof is worded: a pairing code,
// the machine's token, or nothing (a phone whose device key is already enrolled).
export interface RefusalContext {
  machine: string;
  credential: 'pairing' | 'token' | 'none';
}

// `final` means retrying cannot help: the entry waits for the owner instead of redialing.
export interface Refusal {
  message: string;
  final: boolean;
}

// A refusal by the relay (IN_BAND_REFUSAL + an HTTP status) or by the agent (DEVICE_REFUSED),
// in the owner's words; null for any other close.
export function describeRefusal(code: number | undefined, reason: string | undefined, context: RefusalContext): Refusal | null {
  if (code === undefined) return null;
  const refused = code === DEVICE_REFUSED || (code >= IN_BAND_REFUSAL + 400 && code < IN_BAND_REFUSAL + 600);
  if (!refused) return null;
  const { machine, credential } = context;
  const newCode = `run \`perch pair\` on ${machine} for a new one`;
  const final = (message: string): Refusal => ({ message, final: true });
  const passing = (message: string): Refusal => ({ message, final: false });
  const badToken = final(`${machine} refused the token — check the token in this entry`);
  switch (reason) {
    case REFUSAL.codeExpired:
      return final(`This pairing code has expired — ${newCode}`);
    case REFUSAL.codeUsed:
      return final(`This pairing code was already used — ${newCode}`);
    case REFUSAL.proofInvalid:
      return credential === 'token' ? badToken : final(`Pairing refused: the code is not valid for this machine — ${newCode}`);
    case REFUSAL.enrolmentRefused:
      return credential === 'token'
        ? badToken
        : final(`Pairing refused: the code has expired, was already used, or is not valid for this machine — ${newCode}`);
    case REFUSAL.wrongAgentKey:
      return final(`This entry's agent key is not ${machine}'s — pair this machine again`);
    case REFUSAL.revoked:
      return final(`This phone was revoked on ${machine}`);
    case REFUSAL.tokenNotNeeded:
      return passing(`${machine} no longer needs this entry's token: its device key is enrolled — forgetting the token and reconnecting`);
    case REFUSAL.enrolmentOff:
      return final(`Enrolment is turned off on ${machine} — pair with \`perch pair\` instead`);
    case REFUSAL.enrolmentClosed:
      return final(`Enrolment is closed on ${machine} — run \`perch devices enrolment off\` there to allow pairing`);
    case REFUSAL.notEnrolled:
      return final(`This phone is not enrolled on ${machine} — run \`perch pair\` there to pair it again`);
    case REFUSAL.signature:
      // The agent says it too, when a new phone's hello does not prove its relay key.
      return code === DEVICE_REFUSED
        ? final(`${machine} could not verify this phone's device key — run \`perch pair\` there for a new code`)
        : final('The relay refused this phone: its device-key signature did not verify');
    case REFUSAL.tooManyEnrolments:
      return passing(`Too many phones are asking to pair with ${machine} right now — retrying`);
    case REFUSAL.deviceKeyRequired:
      return final(`The relay refused this phone: ${machine} accepts only phones with a device key`);
    case REFUSAL.challenge:
      return passing('The relay refused this phone: its sign-in challenge had expired — retrying');
    case REFUSAL.challengeUnanswered:
    case REFUSAL.invalidReply:
      return passing('The relay did not receive this phone’s sign-in — retrying');
    case REFUSAL.unknownAccount:
      return final(`The relay does not know ${machine} — run \`perch connect\` on it again`);
    case REFUSAL.agentOffline:
      return passing(`${machine} is not connected to the relay`);
    case REFUSAL.agentSilent:
      return passing(`${machine} did not answer through the relay`);
    case REFUSAL.tooManyPending:
    case REFUSAL.tooManyConnections:
      return passing(`The relay is busy: too many phones are connecting to ${machine}`);
    case REFUSAL.internal:
      return passing('The relay failed (internal error) — retrying');
    default:
      return passing(`The relay refused this phone (${reason || `code ${code}`})`);
  }
}
