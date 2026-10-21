// The only messages the relay and the agent exchange themselves, on the agent's control socket.
// Kept tiny and strictly parsed: this is the one surface of the agent a hostile relay can
// write to directly (everything else it carries is Noise ciphertext).
import { z } from 'zod';
import { AGENT_REFUSALS } from './refusal';
import { isEd25519PublicKey } from './agent-auth';

const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// Both relay hosts mint ids as UUIDs. The agent logs an id and sends it as a header, so it is held
// to a token's characters: a hostile relay cannot write lines into the agent's journal with one.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
// A relay takes at most this many keys a list; past it, it keeps the policy it had.
export const MAX_POLICY_KEYS = 256;

// Agent → relay. Which device keys the relay may admit. The relay is only the first gate: the
// agent checks the key itself in the Noise handshake whatever the relay decided.
const policySchema = z.object({
  type: z.literal('policy'),
  // Enrolled devices' Ed25519 keys.
  devices: z.array(key.refine(isEd25519PublicKey)).max(MAX_POLICY_KEYS),
  // Revoked keys: refused even with an enrolment proof.
  revoked: z.array(key).max(MAX_POLICY_KEYS),
  // Whether an unknown key may ask the agent to enrol it.
  enrol: z.boolean(),
  // Whether it may do so with the token, beside a pairing code (absent, from an older agent: it
  // may). The relay only reads the phone's unchecked word for which one it used; the agent checks.
  tokenEnrol: z.boolean().optional(),
});

// Agent → relay: the enrolment a dial asked for is refused, and why. A reason this relay does not
// know is dropped rather than the refusal, so the phone still hears of it at once.
const refuseSchema = z.object({ type: z.literal('refuse'), id, reason: z.enum(AGENT_REFUSALS).optional().catch(undefined) });

const agentControlSchema = z.discriminatedUnion('type', [policySchema, refuseSchema]);

// Relay → agent: dial a socket back for a waiting client. `enrol` is present when the client's
// key is not enrolled and it asks to be; the agent checks the proof before dialing.
const dialSchema = z.object({
  type: z.literal('dial'),
  id,
  // `cred` is what the phone says it made the proof with; the agent only uses it to name a
  // failure in its log.
  enrol: z
    .object({ device: key, nonce: id, proof: z.string().max(128), cred: z.enum(['pairing', 'token']).optional().catch(undefined) })
    .optional(),
});

// Relay → agent: the policy is in force. Without it the agent publishes again, since a relay
// upgraded under a live control socket starts with none.
const appliedSchema = z.object({ type: z.literal('applied') });

const relayControlSchema = z.discriminatedUnion('type', [dialSchema, appliedSchema]);

export type RelayPolicy = z.infer<typeof policySchema>;
type AgentControl = z.infer<typeof agentControlSchema>;
export type RelayControl = z.infer<typeof relayControlSchema>;

function parseWith<S extends z.ZodTypeAny>(schema: S, text: string): z.output<S> | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseAgentControl(text: string): AgentControl | null {
  return parseWith(agentControlSchema, text);
}

export function parseRelayControl(text: string): RelayControl | null {
  return parseWith(relayControlSchema, text);
}
