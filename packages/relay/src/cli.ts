// `perch-relay` subcommands besides serving. `machines` talks to a relay through its HTTP API
// (signed with the admin key), the local one by default, so the same commands administer the
// Worker.
import { JOIN_HEADER, generateJoinKey, isJoinKey, signJoinAuth, type JoinClaim } from '@perch/secure-channel';
import { DEFAULT_RELAY_PORT } from './config.ts';

export interface RelayCliDeps {
  configPath: string;
  // The config file's text, or null when there is none.
  readConfig(): Promise<string | null>;
  writeConfig(text: string): Promise<void>;
  fetch(url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string> }): Promise<{ status: number; body: string }>;
  now(): number;
  env: Record<string, string | undefined>;
}

const RELAY_CLI_USAGE = [
  'usage: perch-relay                       serve (reads ~/.perch/relay/config.json)',
  '       perch-relay join-command [--url <relay URL machines use>]',
  '       perch-relay admin-key',
  '       perch-relay machines list [--url <relay>]',
  '       perch-relay machines remove <account> [--url <relay>]',
  '       perch-relay machines allow <account> [--url <relay>]   (a removed machine may join again)',
  '  With --url, the admin key comes from PERCH_ADMIN_KEY (or --admin-key, which the process list shows).',
].join('\n');

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value\n${RELAY_CLI_USAGE}`);
  args.splice(at, 2);
  return value;
}

async function readConfig(deps: RelayCliDeps): Promise<Record<string, unknown>> {
  const text = await deps.readConfig();
  if (text === null) throw new Error(`no relay config at ${deps.configPath}`);
  return JSON.parse(text) as Record<string, unknown>;
}

const localUrl = (config: Record<string, unknown>) => `ws://127.0.0.1:${typeof config.port === 'number' ? config.port : DEFAULT_RELAY_PORT}`;

export async function runRelayCli(argv: string[], deps: RelayCliDeps): Promise<string> {
  const args = [...argv];
  const command = args.shift();
  if (command === 'join-command') return joinCommand(args, deps);
  if (command === 'admin-key') return adminKeyCommand(deps);
  if (command === 'machines') return machines(args, deps);
  throw new Error(RELAY_CLI_USAGE);
}

async function joinCommand(args: string[], deps: RelayCliDeps): Promise<string> {
  const url = option(args, '--url');
  const config = await readConfig(deps);
  const lines: string[] = [];
  let joinKey = config.joinKey;
  if (!isJoinKey(joinKey)) {
    joinKey = generateJoinKey();
    await deps.writeConfig(`${JSON.stringify({ ...config, joinKey }, null, 2)}\n`);
    lines.push(`created a join key in ${deps.configPath}; restart the relay to enable joining:`);
    lines.push('  systemctl --user restart perch-relay', '');
  }
  lines.push("Run this in each machine's Perch checkout (agent set up per docs/DEPLOY.md) to connect it:", '');
  lines.push(`  PERCH_JOIN_KEY=${joinKey} pnpm perch connect ${url ?? localUrl(config)}`, '');
  lines.push('The key lets any machine register with this relay: share it only with machines you own.');
  return lines.join('\n');
}

// The operator's key for `machines`, apart from the join key every joining machine holds.
async function adminKeyCommand(deps: RelayCliDeps): Promise<string> {
  const config = await readConfig(deps);
  if (isJoinKey(config.adminKey)) return `admin key (in ${deps.configPath}): ${config.adminKey}`;
  const adminKey = generateJoinKey();
  await deps.writeConfig(`${JSON.stringify({ ...config, adminKey }, null, 2)}\n`);
  return [
    `created an admin key in ${deps.configPath}; restart the relay to use it:`,
    '  systemctl --user restart perch-relay',
    '',
    `admin key: ${adminKey}`,
    'It lists and removes every machine on this relay: keep it with the operator only.',
  ].join('\n');
}

async function machines(args: string[], deps: RelayCliDeps): Promise<string> {
  let url = option(args, '--url');
  if (option(args, '--key') !== undefined) {
    throw new Error('machines take the admin key now, not the join key: PERCH_ADMIN_KEY=<admin key> (or --admin-key)');
  }
  let key = option(args, '--admin-key') ?? (url ? deps.env.PERCH_ADMIN_KEY : undefined);
  const [action, account] = args;
  if (!url || !key) {
    const config = await readConfig(deps);
    url ??= localUrl(config);
    key ??= isJoinKey(config.adminKey) ? config.adminKey : undefined;
  }
  if (!isJoinKey(key)) throw new Error('no admin key: set PERCH_ADMIN_KEY, or run perch-relay admin-key on the relay to create one');
  const base = url.replace(/^ws/, 'http').replace(/\/+$/, '');
  const call = async (method: 'GET' | 'POST', path: string, claim: JoinClaim) => {
    const res = await deps.fetch(`${base}${path}`, { method, headers: { [JOIN_HEADER]: signJoinAuth(key, claim, deps.now()) } });
    if (res.status !== 200) throw new Error(`relay answered ${res.status}: ${res.body.slice(0, 200)}`);
    return res.body;
  };
  if (action === 'list') {
    const entries = JSON.parse(await call('GET', '/?role=machines', { account: '*', role: 'machines' })) as Array<{
      account: string;
      addedAt: string;
      removedAt?: string;
    }>;
    if (entries.length === 0) return 'no machines';
    const lines = entries.map((e) =>
      e.removedAt !== undefined
        ? `${e.account}  removed ${e.removedAt.slice(0, 10)}`
        : `${e.account}  added ${e.addedAt.slice(0, 10) || 'before joining existed'}`,
    );
    if (entries.some((e) => e.removedAt !== undefined)) lines.push('', 'A removed machine cannot join again until `perch-relay machines allow <account>`.');
    return lines.join('\n');
  }
  if (action === 'remove' && account) {
    await call('POST', `/${account}?role=remove`, { account, role: 'remove' });
    return `removed ${account}; its sockets on the relay are closed, and it cannot join again until \`machines allow ${account}\``;
  }
  if (action === 'allow' && account) {
    await call('POST', `/${account}?role=allow`, { account, role: 'allow' });
    return `${account} may join again (with the join key)`;
  }
  throw new Error(RELAY_CLI_USAGE);
}
