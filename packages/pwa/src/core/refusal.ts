import { DEVICE_REFUSED, IN_BAND_REFUSAL, REFUSAL } from '@tarfa/secure-channel';
import { msg } from '../i18n.svelte';

// What the entry connects with, which is how a refused enrolment is worded: a pairing code,
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

// A refusal by the agent (DEVICE_REFUSED, or IN_BAND_REFUSAL + an HTTP status), in the owner's
// words; null for any other close.
export function describeRefusal(code: number | undefined, reason: string | undefined, context: RefusalContext): Refusal | null {
  if (code === undefined) return null;
  const refused = code === DEVICE_REFUSED || (code >= IN_BAND_REFUSAL + 400 && code < IN_BAND_REFUSAL + 600);
  if (!refused) return null;
  const { machine, credential } = context;
  const m = msg().refusal;
  const newCode = m.newCode(machine);
  const final = (message: string): Refusal => ({ message, final: true });
  const passing = (message: string): Refusal => ({ message, final: false });
  const badToken = final(m.badToken(machine));
  switch (reason) {
    case REFUSAL.codeExpired:
      return final(m.codeExpired(newCode));
    case REFUSAL.codeUsed:
      return final(m.codeUsed(newCode));
    case REFUSAL.enrolmentRefused:
      return credential === 'token'
        ? badToken
        : final(m.enrolmentRefused(newCode));
    case REFUSAL.wrongAgentKey:
      return final(m.wrongAgentKey(machine));
    case REFUSAL.revoked:
      return final(m.revoked(machine));
    case REFUSAL.tokenNotNeeded:
      return passing(m.tokenNotNeeded(machine));
    case REFUSAL.enrolmentOff:
      return final(m.enrolmentOff(machine));
    case REFUSAL.enrolmentClosed:
      return final(m.enrolmentClosed(machine));
    case REFUSAL.notEnrolled:
      return final(m.notEnrolled(machine));
    case REFUSAL.signature:
      return final(m.agentTooOld(machine));
    case REFUSAL.tooManyPending:
    case REFUSAL.tooManyConnections:
      return passing(m.busy(machine));
    default:
      return passing(m.other(machine, reason || m.code(code)));
  }
}
