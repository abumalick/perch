export const pairing = {
  otherKey: (machine: string) =>
    `This code names another key for ${machine} than the one this phone trusts. If the machine's identity changed, remove that entry first.`,
  question: (machine: string, host: string, fingerprint: string) =>
    `Pair with ${machine} through ${host}?\n\n` +
    `Machine key ${fingerprint}: check it matches what perch pair printed.\n\n` +
    'Continue only if you just ran perch pair or perch connect on that machine.',
  notALink: 'That is not a Perch pairing code. Run `perch pair` on the machine for a fresh one.',
  otherOrigin: (origin: string, own: string) => `This pairing code is for the Perch at ${origin}, not this one (${own}).`,
  cameraRefused: 'Camera access was refused. Allow it for this app, or paste the pairing link below.',
  cameraFailed: (error: string) => `Cannot open the camera (${error}). Paste the pairing link below instead.`,
  clipboardFailed: 'Cannot read the clipboard. Paste it in the field below instead.',
  cancel: 'Cancel',
  scan: 'Scan QR code',
  pasteLink: 'Paste pairing link',
  orPaste: 'Or paste a pairing link',
  pair: 'Pair',
  hintBefore: 'Run ',
  hintAfter: ' on the machine to get a code. It works once, for 10 minutes.',
};
