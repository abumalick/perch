// The agent's settings were named PERCH_* before the rename. For one release an agent.env (or a
// service environment) that still uses those names keeps working, and `tarfa setup` rewrites it.

export const ENV_PREFIX = 'TARFA_';
export const LEGACY_ENV_PREFIX = 'PERCH_';

const ASSIGNMENT = /^(\s*(?:export\s+)?)PERCH_([A-Za-z0-9_]*)=/;

export function renamedEnvName(legacy: string): string {
  return ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length);
}

// The PERCH_* names set without their TARFA_* name, which they stand in for.
export function legacyEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(
    (name) => name.startsWith(LEGACY_ENV_PREFIX) && env[name] !== undefined && env[renamedEnvName(name)] === undefined,
  );
}

export function withLegacyEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of legacyEnvNames(env)) out[renamedEnvName(name)] = env[name];
  return out as T;
}

// agent.env's text with each PERCH_X= line renamed TARFA_X=, every other byte kept. A PERCH_X
// line beside a TARFA_X one is dropped, since TARFA_X is the one the agent reads.
export function renameLegacyEnvLines(text: string): { text: string; renamed: string[] } {
  const assigned = new Set(
    text.split('\n').flatMap((line) => /^\s*(?:export\s+)?(TARFA_[A-Za-z0-9_]*)=/.exec(line)?.[1] ?? []),
  );
  const renamed: string[] = [];
  const lines = text.split('\n').flatMap((line) => {
    const match = ASSIGNMENT.exec(line);
    if (!match) return [line];
    const name = `${ENV_PREFIX}${match[2]}`;
    if (assigned.has(name)) {
      renamed.push(`PERCH_${match[2]} dropped (${name} is set)`);
      return [];
    }
    renamed.push(`PERCH_${match[2]} renamed ${name}`);
    assigned.add(name);
    return [line.replace(ASSIGNMENT, `$1${name}=`)];
  });
  return { text: lines.join('\n'), renamed };
}
