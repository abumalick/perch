import { describe, expect, it } from 'vitest';
import { REFUSAL } from '@perch/secure-channel';
import { describeRefusal, type RefusalContext } from './refusal';

const paired: RefusalContext = { machine: 'dev box', credential: 'pairing' };
const withToken: RefusalContext = { machine: 'dev box', credential: 'token' };
const enrolled: RefusalContext = { machine: 'dev box', credential: 'none' };

describe('describeRefusal', () => {
  it.each([
    [4403, REFUSAL.codeExpired, paired, 'This pairing code has expired — run `perch pair` on dev box for a new one', true],
    [4403, REFUSAL.codeUsed, paired, 'This pairing code was already used — run `perch pair` on dev box for a new one', true],
    [4403, REFUSAL.proofInvalid, paired, 'Pairing refused: the code is not valid for this machine — run `perch pair` on dev box for a new one', true],
    [4403, REFUSAL.proofInvalid, withToken, 'dev box refused the token — check the token in this entry', true],
    [4403, REFUSAL.revoked, enrolled, 'This phone was revoked on dev box', true],
    [4003, REFUSAL.wrongAgentKey, enrolled, "This entry's agent key is not dev box's — pair this machine again", true],
    [4003, REFUSAL.signature, paired, 'dev box could not verify this phone\'s device key — run `perch pair` there for a new code', true],
    [4429, REFUSAL.tooManyEnrolments, paired, 'Too many phones are asking to pair with dev box right now — retrying', false],
    [4003, REFUSAL.tokenNotNeeded, withToken, "dev box no longer needs this entry's token: its device key is enrolled — forgetting the token and reconnecting", false],
    [4403, REFUSAL.enrolmentOff, withToken, 'Enrolment is turned off on dev box — pair with `perch pair` instead', true],
    [4003, REFUSAL.enrolmentClosed, paired, 'Enrolment is closed on dev box — run `perch devices enrolment off` there to allow pairing', true],
    [4403, REFUSAL.notEnrolled, enrolled, 'This phone is not enrolled on dev box — run `perch pair` there to pair it again', true],
    [4401, REFUSAL.signature, enrolled, 'The relay refused this phone: its device-key signature did not verify', true],
    [4401, REFUSAL.deviceKeyRequired, enrolled, 'The relay refused this phone: dev box accepts only phones with a device key', true],
    [4401, REFUSAL.challenge, enrolled, 'The relay refused this phone: its sign-in challenge had expired — retrying', false],
    [4404, REFUSAL.unknownAccount, enrolled, 'The relay does not know dev box — run `perch connect` on it again', true],
    [4503, REFUSAL.agentOffline, enrolled, 'dev box is not connected to the relay', false],
    [4504, REFUSAL.agentSilent, enrolled, 'dev box did not answer through the relay', false],
    [4429, REFUSAL.tooManyPending, enrolled, 'The relay is busy: too many phones are connecting to dev box', false],
    [4429, REFUSAL.tooManyConnections, enrolled, 'The relay is busy: too many phones are connecting to dev box', false],
    [4500, REFUSAL.internal, enrolled, 'The relay failed (internal error) — retrying', false],
  ] as const)('%i %s', (code, reason, context, message, final) => {
    expect(describeRefusal(code, reason, context)).toEqual({ message, final });
  });

  // The agent's own close for a device, forwarded by the relay, uses the same words.
  it('reads the agent closing the session over a device, or a code spent since the relay let it through', () => {
    expect(describeRefusal(4003, REFUSAL.revoked, enrolled)?.message).toBe('This phone was revoked on dev box');
    expect(describeRefusal(4003, REFUSAL.codeUsed, paired)?.message).toMatch(/^This pairing code was already used/);
  });

  it('words an older agent that refused without saying why by what the phone sent', () => {
    expect(describeRefusal(4403, REFUSAL.enrolmentRefused, paired)).toEqual({
      message: 'Pairing refused: the code has expired, was already used, or is not valid for this machine — run `perch pair` on dev box for a new one',
      final: true,
    });
    expect(describeRefusal(4403, REFUSAL.enrolmentRefused, withToken)?.message).toBe('dev box refused the token — check the token in this entry');
  });

  it('still says the relay refused the phone for a reason it does not know', () => {
    expect(describeRefusal(4403, 'something new', enrolled)).toEqual({ message: 'The relay refused this phone (something new)', final: false });
    expect(describeRefusal(4418, '', enrolled)).toEqual({ message: 'The relay refused this phone (code 4418)', final: false });
  });

  it('leaves every other close to the connection', () => {
    expect(describeRefusal(1006, '', paired)).toBeNull();
    expect(describeRefusal(4000, 'superseded', paired)).toBeNull();
    expect(describeRefusal(4002, 'secure channel failed', paired)).toBeNull();
    expect(describeRefusal(undefined, REFUSAL.codeExpired, paired)).toBeNull();
  });
});
