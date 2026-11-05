export const refusal = {
  newCode: (machine: string) => `run \`perch pair\` on ${machine} for a new one`,
  badToken: (machine: string) => `${machine} refused the token — check the token in this entry`,
  codeExpired: (newCode: string) => `This pairing code has expired — ${newCode}`,
  codeUsed: (newCode: string) => `This pairing code was already used — ${newCode}`,
  proofInvalid: (newCode: string) => `Pairing refused: the code is not valid for this machine — ${newCode}`,
  enrolmentRefused: (newCode: string) =>
    `Pairing refused: the code has expired, was already used, or is not valid for this machine — ${newCode}`,
  wrongAgentKey: (machine: string) => `This entry's agent key is not ${machine}'s — pair this machine again`,
  revoked: (machine: string) => `This phone was revoked on ${machine}`,
  tokenNotNeeded: (machine: string) =>
    `${machine} no longer needs this entry's token: its device key is enrolled — forgetting the token and reconnecting`,
  enrolmentOff: (machine: string) => `Enrolment is turned off on ${machine} — pair with \`perch pair\` instead`,
  enrolmentClosed: (machine: string) =>
    `Enrolment is closed on ${machine} — run \`perch devices enrolment off\` there to allow pairing`,
  notEnrolled: (machine: string) => `This phone is not enrolled on ${machine} — run \`perch pair\` there to pair it again`,
  agentSignature: (machine: string) =>
    `${machine} could not verify this phone's device key — run \`perch pair\` there for a new code`,
  tooManyEnrolments: (machine: string) => `Too many phones are asking to pair with ${machine} right now — retrying`,
  busy: (machine: string) => `${machine} is busy: too many phones are connecting to it`,
  internal: (machine: string) => `${machine} failed (internal error) — retrying`,
  other: (machine: string, detail: string) => `${machine} refused this phone (${detail})`,
  code: (code: number) => `code ${code}`,
};
