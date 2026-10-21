// Files holding a secret (the relay key, the device roster, pairing secrets, the token) must be
// usable by their owner only: any other user on the machine who reads one can pose as the agent
// or a phone. The agent refuses to start rather than serve with one exposed.
export function exposedFiles(files: Array<{ path: string; mode: number }>): string[] {
  return files
    .filter(({ mode }) => (mode & 0o077) !== 0)
    .map(({ path, mode }) => `${path} is readable or writable by other users (mode ${(mode & 0o777).toString(8)}): run \`chmod 600 ${path}\``);
}
