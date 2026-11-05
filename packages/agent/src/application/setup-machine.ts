// `tarfa setup`: what it takes to turn a checkout into a running agent phones can reach, worked
// out from flags and what the machine already holds. Pure: the caller reads the machine into a
// SetupState and applies the steps (run-setup.ts). Every step is planned only when something
// differs, so a rerun with the same flags plans nothing.
import { isMachineUrl, isPairingPath, MAX_ADDRESSES } from '@tarfa/secure-channel';
import { parseEnvFile, setEnvValue } from './agent-env';
import { renameLegacyEnvLines, withLegacyEnv } from './legacy-env';
import type { EnrolmentMode } from './device-roster';

export type TailscaleMode = 'serve' | 'funnel' | 'none';

export interface SetupFlags {
  machineId: string;
  projectRoots: string[];
  defaultPath?: string;
  phonePort: number;
  slug?: string;
  tailscale: TailscaleMode;
  tailscalePort?: number;
  addresses: string[];
  // Only when --pwa is given: an existing TARFA_PWA_ORIGIN is otherwise kept.
  pwa?: string;
  pair: boolean;
  dryRun: boolean;
  tokenEnrolment?: 'on' | 'off';
}

// The fields of `tailscale status --json` setup reads. Every one may be missing.
export interface TailscaleStatus {
  BackendState?: string;
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
  CertDomains?: string[] | null;
  Self?: { DNSName?: string; CapMap?: Record<string, unknown> | null } | null;
}

// The fields of `tailscale serve status --json` setup reads.
export interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

// Who listens on a loopback port: nobody, this user's running agent, or anything else.
export type PortOwner = 'free' | 'ours' | 'other';

export interface SetupState {
  // The main checkout, which the service runs (deploy/run-agent.sh follows deploy/agent-live).
  repo: string;
  // The unit (systemd) or plist (launchd) template with REPO_PATH, the one installed, and
  // whether it is enabled to start at boot (with linger, under systemd).
  service: { kind: 'systemd' | 'launchd'; template: string; installed: string | null; enabled: boolean };
  envText: string | null;
  // Used only when agent.env holds no TARFA_TOKEN.
  newToken: string;
  hasKey: boolean;
  roster: 'absent' | EnrolmentMode;
  hooksCurrent: boolean;
  // The unit (or plist) from before the rename, perch-agent / com.perch.agent, is installed.
  legacyService: boolean;
  // Where the state is: moved to ~/.tarfa, still in ~/.perch, or in both (which the agent refuses
  // to merge, so setup stops before it stops anything).
  stateDir: 'moved' | 'legacy' | 'conflict';
  phonePortOwner: PortOwner;
  hooksPortOwner: PortOwner;
  // Null when Tailscale is not installed or its daemon does not answer.
  tailscale: TailscaleStatus | null;
  serve: ServeConfig | null;
}

export type SetupStep =
  | { kind: 'stop-legacy-service' }
  | { kind: 'move-state' }
  | { kind: 'remove-legacy-service' }
  | { kind: 'write-env'; text: string; changes: string[] }
  | { kind: 'create-key' }
  | { kind: 'write-roster'; mode: EnrolmentMode }
  | { kind: 'install-unit'; text: string }
  | { kind: 'install-hooks' }
  | { kind: 'tailscale-serve'; port: number; path: string; target: string; funnel: boolean }
  | { kind: 'restart' }
  | { kind: 'check-listener'; port: number }
  | { kind: 'pair' }
  | { kind: 'print'; line: string };

export const DEFAULT_PHONE_PORT = 8797;
export const DEFAULT_PWA_ORIGIN = 'https://tarfa.app';
export const FUNNEL_PORTS = [443, 8443, 10000];
const SLUG = /^[\w-]{1,64}$/;
const SHELL_SAFE = /^[\w./@+-]+$/;
const FUNNEL_PORTS_CAP = 'https://tailscale.com/cap/funnel-ports?ports=';

export function planSetup(flags: SetupFlags, state: SetupState): { steps: SetupStep[]; checks: string[] } | { error: string } {
  if (state.phonePortOwner === 'other') {
    return {
      error: `127.0.0.1:${flags.phonePort} is taken by another process (another user's agent?): pick a free one with --phone-port, e.g. ${flags.phonePort + 1}`,
    };
  }
  if (state.hooksPortOwner === 'other') {
    return { error: 'the hooks port is taken by another process (another user\'s agent?): set TARFA_PORT in deploy/agent.env to a free port, then run tarfa setup again' };
  }

  if (state.stateDir === 'conflict') {
    return {
      error: 'both ~/.perch and ~/.tarfa hold state (or ~/.perch links elsewhere): the agent will not merge them, so setup stops before touching the service. Keep the one that holds the agent key, move the other away, then run tarfa setup again',
    };
  }

  const target = `http://127.0.0.1:${flags.phonePort}`;
  const path = flags.slug ? `/${flags.slug}` : '/';
  const steps: SetupStep[] = [];
  const checks: string[] = [];
  let serveStep: SetupStep | undefined;
  let operatorStep: SetupStep | undefined;
  let derived: string | undefined;

  if (flags.tailscale !== 'none') {
    const port = flags.tailscalePort ?? (flags.tailscale === 'funnel' ? 10000 : 443);
    const checked = checkTailscale(flags.tailscale, port, state.tailscale);
    if ('error' in checked) return checked;
    checks.push(...checked.checks);
    if (state.serve === null) return { error: 'could not read `tailscale serve status --json`: setup will not add a handler it cannot check against the existing ones' };
    const served = serveNeeds(state.serve, `${checked.host}:${port}`, port, path, target, flags.tailscale === 'funnel');
    if ('error' in served) return served;
    if (served.public) checks.push(`tailscale: port ${port} is on Funnel, so this address is reachable from the internet`);
    // `tailscale serve` on a port already on Funnel takes the port off Funnel, for every agent on it.
    if (served.needed) serveStep = { kind: 'tailscale-serve', port, path, target, funnel: flags.tailscale === 'funnel' || served.public };
    derived = `wss://${checked.host}:${port}${path === '/' ? '' : path}`;
  } else if (flags.slug) {
    const operator = operatorEntry(flags, state.serve, path, target);
    if (operator.funnel) checks.push(`tailscale: port ${operator.port} is on Funnel, so this address is reachable from the internet`);
    operatorStep = { kind: 'print', line: serveCommand(operator) };
  }

  const addresses = [...(derived ? [derived] : []), ...flags.addresses];
  if (addresses.length > MAX_ADDRESSES) return { error: `a machine takes at most ${MAX_ADDRESSES} addresses (got ${addresses.length})` };
  // A roster that already offers token enrolment is never published silently: the owner says
  // whether to keep it.
  const published = addresses.length > 0 || Boolean(withLegacyEnv(parseEnvFile(state.envText ?? '')).TARFA_PHONE_ADDRESSES);
  if (published && state.roster === 'on' && flags.tokenEnrolment === undefined) {
    return {
      error: 'token enrolment is on in ~/.tarfa/devices.json, and this run gives phones an address: pass --token-enrolment off to switch it off (pairing codes only), or --token-enrolment on to keep it on deliberately',
    };
  }

  // The swap from the service's old name: stop the old agent, move ~/.perch while nothing holds
  // it, then the steps below install and start the new one. Never both at once: two agents would
  // share one hooks port and one state directory.
  if (state.legacyService) steps.push({ kind: 'stop-legacy-service' });
  if (state.stateDir === 'legacy') steps.push({ kind: 'move-state' });
  const env = planEnv(flags, state, addresses);
  if (env) steps.push(env);
  if (!state.hasKey) steps.push({ kind: 'create-key' });
  // Before the service can start: a missing roster means token enrolment on, which a published
  // phone port must not offer.
  if (state.roster === 'absent') steps.push({ kind: 'write-roster', mode: flags.tokenEnrolment ?? 'off' });
  else if (flags.tokenEnrolment && state.roster !== flags.tokenEnrolment) steps.push({ kind: 'write-roster', mode: flags.tokenEnrolment });
  const mode = state.roster === 'absent' ? (flags.tokenEnrolment ?? 'off') : (flags.tokenEnrolment ?? state.roster);
  if (mode === 'on' && checks.some((line) => line.includes('internet') || line.includes('Funnel allowed'))) {
    checks.push('warning: token enrolment is on, so whoever holds TARFA_TOKEN can enrol a phone on a public port: run `tarfa devices enrolment off` (or pass --token-enrolment off)');
  }
  const unit = state.service.template.replaceAll('REPO_PATH', state.repo);
  if (!state.service.enabled || !unitIsCurrent(state.service.kind, state.service.installed, state.repo)) steps.push({ kind: 'install-unit', text: unit });
  // The old agent is stopped: start the new one before anything that can fail, so a failed hooks
  // or serve step never leaves the machine with no agent (and a phone with no way back in).
  if (state.legacyService) steps.push({ kind: 'restart' }, { kind: 'check-listener', port: flags.phonePort });
  if (!state.hooksCurrent) steps.push({ kind: 'install-hooks' });
  if (serveStep) steps.push(serveStep);
  if (state.legacyService) steps.push({ kind: 'remove-legacy-service' });
  else if (steps.length > 0) steps.push({ kind: 'restart' }, { kind: 'check-listener', port: flags.phonePort });
  if (operatorStep) steps.push(operatorStep);
  if (flags.pair) steps.push({ kind: 'pair' });
  return { steps, checks };
}

function planEnv(flags: SetupFlags, state: SetupState, addresses: string[]): SetupStep | null {
  const legacy = renameLegacyEnvLines(state.envText ?? '');
  const before = legacy.text;
  const values = parseEnvFile(before);
  const wanted: Array<[string, string, string?]> = [];
  if (!values.TARFA_TOKEN) wanted.push(['TARFA_TOKEN', state.newToken, '(generated)']);
  wanted.push(['TARFA_MACHINE_ID', flags.machineId], ['TARFA_PROJECT_ROOTS', flags.projectRoots.join(':')]);
  if (flags.defaultPath) wanted.push(['TARFA_DEFAULT_PATH', flags.defaultPath]);
  wanted.push(['TARFA_PHONE_PORT', String(flags.phonePort)]);
  if (addresses.length > 0) wanted.push(['TARFA_PHONE_ADDRESSES', addresses.join(',')]);
  if (flags.pwa || !values.TARFA_PWA_ORIGIN) wanted.push(['TARFA_PWA_ORIGIN', flags.pwa ?? DEFAULT_PWA_ORIGIN]);

  let text = before;
  const changes: string[] = [...legacy.renamed];
  for (const [name, value, shown] of wanted) {
    if (values[name] === value) continue;
    text = setEnvValue(text, name, value);
    changes.push(`${name}=${shown ?? value}`);
  }
  return changes.length === 0 ? null : { kind: 'write-env', text, changes };
}

// An installed unit is left alone when it already runs this checkout's run-agent.sh, however it
// gets there (dev's runs it through `mise exec` from WorkingDirectory), and, under systemd, stops
// only the agent on a restart: KillMode=process is what keeps every workspace alive.
function unitIsCurrent(kind: 'systemd' | 'launchd', installed: string | null, repo: string): boolean {
  if (installed === null) return false;
  const script = `${repo}/deploy/run-agent.sh`;
  if (kind === 'launchd') return installed.includes(`<string>${script}</string>`);
  if (!/^KillMode=process\s*$/m.test(installed)) return false;
  const execStart = /^ExecStart=(.*)$/m.exec(installed)?.[1] ?? '';
  const words = execStart.split(/\s+/);
  if (words.includes(script)) return true;
  const workingDirectory = /^WorkingDirectory=(.*)$/m.exec(installed)?.[1]?.trim();
  return workingDirectory === repo && (words.includes('deploy/run-agent.sh') || words.includes('./deploy/run-agent.sh'));
}

// The handler a node's operator adds for a user who cannot change the serve config. The port is
// --tailscale-port, else the one of the first --address under this slug, else 443; the funnel
// form only when the serve config shows that host:port already on Funnel, since `tailscale serve`
// on a Funnel port would take the port off Funnel for every agent on it.
function operatorEntry(flags: SetupFlags, serve: ServeConfig | null, path: string, target: string) {
  const address = flags.addresses.map((a) => new URL(a)).find((url) => url.pathname === path);
  const port = flags.tailscalePort ?? (address?.port ? Number(address.port) : 443);
  const funnel = address !== undefined && serve?.AllowFunnel?.[`${address.hostname}:${port}`] === true;
  return { port, path, target, funnel };
}

function serveCommand(entry: { port: number; path: string; target: string; funnel: boolean }): string {
  return `tailscale ${entry.funnel ? 'funnel' : 'serve'} --bg --https=${entry.port}${entry.path === '/' ? '' : ` --set-path=${entry.path}`} ${entry.target}`;
}

function checkTailscale(mode: 'serve' | 'funnel', port: number, status: TailscaleStatus | null): { host: string; checks: string[] } | { error: string } {
  if (status === null) return { error: 'Tailscale is not installed or its daemon does not answer: install it, run `tailscale up`, then run tarfa setup again (see tarfa setup --help)' };
  if (status.BackendState !== 'Running') {
    return { error: `Tailscale is not running or logged out (state ${status.BackendState ?? 'unknown'}): run \`tailscale up\`` };
  }
  if (status.CurrentTailnet?.MagicDNSEnabled !== true) {
    return { error: 'MagicDNS is off: turn it on in the Tailscale admin console (DNS page)' };
  }
  if (!Array.isArray(status.CertDomains) || status.CertDomains.length === 0) {
    return { error: 'HTTPS certificates are off: enable HTTPS in the Tailscale admin console (DNS page)' };
  }
  const host = (status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!host) return { error: 'Tailscale reports no DNS name for this node: check `tailscale status`' };
  const checks = [`tailscale: running, MagicDNS on, HTTPS on, node ${host}`];
  if (mode === 'funnel') {
    if (!FUNNEL_PORTS.includes(port)) return { error: `Funnel serves only ports 443, 8443 or 10000 (got ${port}): pick one with --tailscale-port` };
    const caps = Object.keys(status.Self?.CapMap ?? {});
    if (!caps.includes('funnel')) {
      return { error: 'Funnel is not allowed for this node: add the funnel node attribute for it in the tailnet policy file (tarfa setup --help)' };
    }
    const listed = caps.find((cap) => cap.startsWith(FUNNEL_PORTS_CAP));
    const ports = listed ? listed.slice(FUNNEL_PORTS_CAP.length).split(',').map(Number) : FUNNEL_PORTS;
    if (!ports.includes(port)) {
      return { error: `Funnel is not allowed on port ${port} for this node (the policy's funnel-ports allow ${ports.join(', ')}): pick one of those with --tailscale-port` };
    }
    checks.push(`tailscale: Funnel allowed on port ${port}`);
  }
  return { host, checks };
}

// Funnel is set per host:port, not per path: turning it on publishes every handler on the port.
function serveNeeds(
  serve: ServeConfig,
  hostPort: string,
  port: number,
  path: string,
  target: string,
  funnel: boolean,
): { needed: boolean; public: boolean } | { error: string } {
  if (serve.TCP?.[String(port)]?.TCPForward) {
    return { error: `Tailscale port ${port} already forwards raw TCP (${serve.TCP[String(port)]!.TCPForward}): pick another with --tailscale-port` };
  }
  const handlers = serve.Web?.[hostPort]?.Handlers ?? {};
  const funnelled = serve.AllowFunnel?.[hostPort] === true;
  const others = Object.keys(handlers).filter((p) => p !== path);
  if (funnel && !funnelled && others.length > 0) {
    return { error: `Funnel on port ${port} would also publish ${others.map((p) => `https://${hostPort}${p}`).join(', ')}, which is tailnet-only now: pick another --tailscale-port` };
  }
  const existing = handlers[path]?.Proxy;
  if (existing !== undefined && existing.replace(/\/$/, '') !== target) {
    return { error: `https://${hostPort}${path} is already served to ${existing}: pick another --slug or --tailscale-port (tarfa setup never replaces a serve entry)` };
  }
  return { needed: existing === undefined || (funnel && !funnelled), public: !funnel && funnelled };
}

export function describeStep(step: SetupStep, envPath: string): string {
  switch (step.kind) {
    case 'write-env':
      return `update ${envPath} (backed up first): ${step.changes.join(', ')}`;
    case 'stop-legacy-service':
      return 'stop the agent service installed under its old name (perch-agent); tmux and every workspace keep running';
    case 'move-state':
      return 'move ~/.perch to ~/.tarfa, leaving ~/.perch as a link to it';
    case 'remove-legacy-service':
      return 'remove the agent service installed under its old name (perch-agent)';
    case 'create-key':
      return 'create the agent key (~/.tarfa/agent-key.json)';
    case 'write-roster':
      return `write ~/.tarfa/devices.json with enrolment ${step.mode}${step.mode === 'off' ? ' (pairing codes only)' : ''}`;
    case 'install-unit':
      return 'install and enable the agent service (starts at boot)';
    case 'install-hooks':
      return 'install the Claude Code (and Codex) hooks';
    case 'tailscale-serve':
      return serveCommand(step);
    case 'restart':
      return 'restart the agent';
    case 'check-listener':
      return `check the phone port answers a WebSocket upgrade on 127.0.0.1:${step.port}`;
    case 'pair':
      return 'mint a pairing link (tarfa pair)';
    case 'print':
      return `ask the node's Tailscale operator to run: ${step.line}`;
  }
}

const VALUE_FLAGS = new Set(['--machine-id', '--project-roots', '--default-path', '--phone-port', '--slug', '--tailscale', '--tailscale-port', '--address', '--pwa', '--token-enrolment']);
const BOOLEAN_FLAGS = new Set(['--pair', '--dry-run']);

function portNumber(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

export function parseSetupFlags(argv: string[]): SetupFlags | { error: string } {
  const single = new Map<string, string>();
  const addresses: string[] = [];
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOLEAN_FLAGS.has(arg)) {
      set.add(arg);
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) return { error: `unknown argument: ${arg}` };
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    if (arg === '--address') addresses.push(value);
    else single.set(arg, value);
  }

  const machineId = single.get('--machine-id');
  if (!machineId || !/^[\w.-]{1,64}$/.test(machineId)) return { error: '--machine-id is required: letters, digits, . _ - (at most 64)' };
  const projectRoots = (single.get('--project-roots') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (projectRoots.length === 0) return { error: '--project-roots is required: absolute paths, comma-separated' };
  // agent.env is sourced by bash, so a value must need no quoting there.
  if (projectRoots.some((p) => !p.startsWith('/') || !SHELL_SAFE.test(p))) {
    return { error: '--project-roots takes absolute paths, comma-separated, of letters, digits and . _ - / @ + only' };
  }
  const defaultPath = single.get('--default-path');
  if (defaultPath !== undefined && (!isPairingPath(defaultPath) || !SHELL_SAFE.test(defaultPath))) {
    return { error: '--default-path must be an absolute path of at most 128 characters, of letters, digits and . _ - / @ + only' };
  }
  const phonePort = single.has('--phone-port') ? portNumber(single.get('--phone-port')!) : DEFAULT_PHONE_PORT;
  if (phonePort === null) return { error: '--phone-port must be a port number (1-65535)' };
  const slug = single.get('--slug');
  if (slug !== undefined && !SLUG.test(slug)) return { error: '--slug takes letters, digits, _ and - (at most 64)' };
  const tailscale = single.get('--tailscale') ?? 'none';
  if (tailscale !== 'serve' && tailscale !== 'funnel' && tailscale !== 'none') return { error: '--tailscale takes serve, funnel or none' };
  const tailscalePort = single.has('--tailscale-port') ? portNumber(single.get('--tailscale-port')!) : undefined;
  if (tailscalePort === null) return { error: '--tailscale-port must be a port number' };
  const bad = addresses.find((a) => !isMachineUrl(a) || !a.startsWith('wss://'));
  if (bad) return { error: `--address must be wss://<host>[:port][/<slug>] (got ${bad})` };
  let pwa: string | undefined;
  if (single.has('--pwa')) {
    try {
      const url = new URL(single.get('--pwa')!);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      pwa = url.origin;
    } catch {
      return { error: `--pwa must be the http(s) origin phones open the app at (got ${single.get('--pwa')})` };
    }
  }
  const tokenEnrolment = single.get('--token-enrolment');
  if (tokenEnrolment !== undefined && tokenEnrolment !== 'on' && tokenEnrolment !== 'off') return { error: '--token-enrolment takes on or off' };

  return {
    machineId,
    projectRoots,
    ...(defaultPath !== undefined ? { defaultPath } : {}),
    phonePort,
    ...(slug !== undefined ? { slug } : {}),
    tailscale,
    ...(tailscalePort !== undefined ? { tailscalePort } : {}),
    addresses,
    ...(pwa !== undefined ? { pwa } : {}),
    pair: set.has('--pair'),
    dryRun: set.has('--dry-run'),
    ...(tokenEnrolment !== undefined ? { tokenEnrolment } : {}),
  };
}
