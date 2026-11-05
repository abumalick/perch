import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n.svelte';
import { REFUSAL } from '@perch/secure-channel';
import { describeRefusal, type RefusalContext } from './refusal';

const paired: RefusalContext = { machine: 'dev box', credential: 'pairing' };
const withToken: RefusalContext = { machine: 'dev box', credential: 'token' };
const enrolled: RefusalContext = { machine: 'dev box', credential: 'none' };

describe('describeRefusal', () => {
  it.each([
    [4403, REFUSAL.codeExpired, paired, 'This pairing code has expired — run `perch pair` on dev box for a new one', true],
    [4403, REFUSAL.codeUsed, paired, 'This pairing code was already used — run `perch pair` on dev box for a new one', true],
    [4403, REFUSAL.revoked, enrolled, 'This phone was revoked on dev box', true],
    [4003, REFUSAL.wrongAgentKey, enrolled, "This entry's agent key is not dev box's — pair this machine again", true],
    [4003, REFUSAL.tokenNotNeeded, withToken, "dev box no longer needs this entry's token: its device key is enrolled — forgetting the token and reconnecting", false],
    [4403, REFUSAL.enrolmentOff, withToken, 'Enrolment is turned off on dev box — pair with `perch pair` instead', true],
    [4003, REFUSAL.enrolmentClosed, paired, 'Enrolment is closed on dev box — run `perch devices enrolment off` there to allow pairing', true],
    [4403, REFUSAL.notEnrolled, enrolled, 'This phone is not enrolled on dev box — run `perch pair` there to pair it again', true],
    [4003, REFUSAL.signature, paired, 'dev box runs an agent too old to pair this phone — update its agent, then pair again', true],
    [4429, REFUSAL.tooManyPending, enrolled, 'dev box is busy: too many phones are connecting to it', false],
    [4429, REFUSAL.tooManyConnections, enrolled, 'dev box is busy: too many phones are connecting to it', false],
  ] as const)('%i %s', (code, reason, context, message, final) => {
    expect(describeRefusal(code, reason, context)).toEqual({ message, final });
  });

  it('reads the agent closing the session over a device, or a code spent since the phone dialed', () => {
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

  it('still says the machine refused the phone for a reason it does not know', () => {
    expect(describeRefusal(4003, 'something new', enrolled)).toEqual({ message: 'dev box refused this phone (something new)', final: false });
    expect(describeRefusal(4418, '', enrolled)).toEqual({ message: 'dev box refused this phone (code 4418)', final: false });
  });

  it('words no reason an agent does not send', () => {
    for (const reason of ['enrolment proof invalid', 'internal error']) {
      expect(describeRefusal(4403, reason, enrolled)?.message).toBe(`dev box refused this phone (${reason})`);
    }
  });

  it('leaves every other close to the connection', () => {
    expect(describeRefusal(1006, '', paired)).toBeNull();
    expect(describeRefusal(4000, 'superseded', paired)).toBeNull();
    expect(describeRefusal(4002, 'secure channel failed', paired)).toBeNull();
    expect(describeRefusal(undefined, REFUSAL.codeExpired, paired)).toBeNull();
  });
});

describe('describeRefusal in French', () => {
  afterEach(() => setLanguage('en'));

  it('words a revoked phone in French', () => {
    setLanguage('fr');
    expect(describeRefusal(4403, REFUSAL.revoked, enrolled)?.message).toBe('Ce téléphone a été révoqué sur dev box');
  });
});
