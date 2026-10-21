// The self-hosted relay. Its configuration lives outside any checkout, so switching the checkout
// it runs from (deploy/serve-relay.sh) never changes which agents it serves. See
// docs/relay-cf-runbook.md for the file's shape.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseRelayConfig } from './config.ts';
import { runRelayCli } from './cli.ts';
import { openFileRegistry } from './file-registry.ts';
import { securePrivateConfig, writePrivateConfig } from './private-files.ts';
import { startRelayServer } from './server.ts';

const path = process.env.PERCH_RELAY_CONFIG || join(homedir(), '.perch', 'relay', 'config.json');
const argv = process.argv.slice(2);

if (argv.length > 0 && argv[0] !== 'serve') {
  try {
    const out = await runRelayCli(argv, {
      configPath: path,
      readConfig: () =>
        readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        }),
      writeConfig: (text) => writePrivateConfig(path, text),
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        return { status: res.status, body: await res.text() };
      },
      now: Date.now,
      env: process.env,
    });
    process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} else {
  const accountsPath = join(dirname(path), 'accounts.json');
  await securePrivateConfig(path, [accountsPath]);
  const config = parseRelayConfig(await readFile(path, 'utf8'));
  // Beside the config; changed only by joins and removals.
  const registry = await openFileRegistry(accountsPath);
  const accounts = (await registry.list()).length;
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const server = await startRelayServer({ ...config, registry, log: print, trace: print });
  const joining = `${config.joinKey ? 'joining on' : 'joining off (no joinKey)'}, ${config.adminKey ? 'admin on' : 'admin off (no adminKey)'}`;
  process.stdout.write(`perch relay listening on ${config.host}:${server.port}, serving ${accounts} account(s), ${joining}, from ${path}\n`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}
