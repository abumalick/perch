import type { StoragePort } from './ports/storage';
import type { FilterMode } from './project-folders';
import { parseAgentKey } from './relay-key';

export interface MachineConfig {
  id: string;
  name: string;
  url: string;
  token: string;
  defaultPath?: string; // root that relative New-workspace paths resolve against
  enabled?: boolean; // absent = enabled; false = user switched the machine off
  // Written by earlier versions on every relay entry; read and ignored now.
  relay?: boolean;
  // The agent's X25519 public key (base64url), which the Noise session pins. Every entry the app
  // connects carries a valid one; an entry without one is an old direct entry.
  agentKey?: string;
  // A one-time pairing secret from a pairing link, used in place of the token until this
  // device's key is enrolled; cleared once the machine has accepted it. A paired entry has no
  // token at all: its enrolled device key is what authenticates it from then on.
  pairing?: string;
}

// A machine the app can reach: one whose agent key the end-to-end session can pin. An entry from
// before the relay (a direct machine) has none; it is kept in storage so its owner can see and
// delete it, but is never connected and counts as no machine at all.
export function isRelayMachine(machine: Pick<MachineConfig, 'agentKey'>): boolean {
  return parseAgentKey(machine.agentKey) !== null;
}

// A machine the app tries to reach: switched on, and a relay entry.
export function isConnectable(machine: Pick<MachineConfig, 'agentKey' | 'enabled'>): boolean {
  return machine.enabled !== false && isRelayMachine(machine);
}

const KEY = 'perch.machines';
const LAST_MACHINE_KEY = 'perch.lastMachine';
const LAST_COMMAND_KEY = 'perch.lastCommand';
const FILE_WRAP_KEY = 'perch.fileWrap';
const TERMINAL_FONT_SIZE_KEY = 'perch.terminalFontSize';
const SHARE_LINKS_KEY = 'perch.shareLinks';
const ELEVENLABS_API_KEY = 'perch.elevenLabsApiKey';
const FOLDER_FILTER_KEY = 'perch.folderFilter';
const FOLDER_HIDDEN_KEY = 'perch.folderHidden';
const FOLDER_FILTER_MODE_KEY = 'perch.folderFilterMode';

export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 24;
export const TERMINAL_FONT_DEFAULT = 13;

export function clampFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

export class SettingsStore {
  constructor(private readonly storage: StoragePort) {}

  list(): MachineConfig[] {
    const raw = this.storage.read(KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MachineConfig[]) : [];
    } catch {
      return [];
    }
  }

  add(config: MachineConfig): void {
    const next = [...this.list().filter((m) => m.id !== config.id), config];
    this.persist(next);
  }

  update(id: string, patch: { url: string; token?: string; defaultPath?: string; agentKey?: string }): void {
    const machines = this.list();
    if (!machines.some((m) => m.id === id)) return;
    this.persist(
      machines.map((m) =>
        m.id === id
          ? {
              ...m,
              url: patch.url,
              token: patch.token ?? m.token,
              defaultPath: patch.defaultPath ?? m.defaultPath,
              // '' clears it; absent keeps it.
              agentKey: patch.agentKey === undefined ? m.agentKey : patch.agentKey || undefined,
            }
          : m,
      ),
    );
  }

  // Forgets a spent pairing secret.
  clearPairing(id: string): void {
    const machines = this.list();
    if (!machines.some((m) => m.id === id && m.pairing)) return;
    this.persist(machines.map((m) => (m.id === id ? { ...m, pairing: undefined } : m)));
  }

  // Forgets the token and the pairing secret of an entry whose device key is enrolled: the key
  // is its credential from then on.
  forgetCredentials(id: string): void {
    const machines = this.list();
    if (!machines.some((m) => m.id === id && (m.pairing || m.token))) return;
    this.persist(machines.map((m) => (m.id === id ? { ...m, token: '', pairing: undefined } : m)));
  }

  remove(id: string): void {
    this.persist(this.list().filter((m) => m.id !== id));
  }

  setEnabled(id: string, enabled: boolean): void {
    const machines = this.list();
    if (!machines.some((m) => m.id === id)) return;
    this.persist(machines.map((m) => (m.id === id ? { ...m, enabled } : m)));
  }

  lastMachine(): string | null {
    return this.storage.read(LAST_MACHINE_KEY);
  }

  setLastMachine(id: string): void {
    this.storage.write(LAST_MACHINE_KEY, id);
  }

  // The command run for the last create, so the New workspace view can preselect it.
  lastCommand(): string | null {
    return this.storage.read(LAST_COMMAND_KEY);
  }

  setLastCommand(command: string): void {
    this.storage.write(LAST_COMMAND_KEY, command);
  }

  // Project-folder filter pills on the home list, persisted so the selection survives
  // navigation (WorkspaceList remounts on the narrow layout) and app reload.
  folderFilter(): string[] {
    return this.readKeys(FOLDER_FILTER_KEY);
  }

  setFolderFilter(keys: string[]): void {
    this.storage.write(FOLDER_FILTER_KEY, JSON.stringify(keys));
  }

  // The hidden-folder selection, kept in its own key so a transient "show only" focus never
  // wipes a hide the user set once.
  folderHidden(): string[] {
    return this.readKeys(FOLDER_HIDDEN_KEY);
  }

  setFolderHidden(keys: string[]): void {
    this.storage.write(FOLDER_HIDDEN_KEY, JSON.stringify(keys));
  }

  // Which of the two selections is live. Unset reads as 'only', so an existing installation's
  // persisted `folderFilter` keeps meaning exactly what it did before hide mode existed.
  folderFilterMode(): FilterMode {
    return this.storage.read(FOLDER_FILTER_MODE_KEY) === 'hide' ? 'hide' : 'only';
  }

  setFolderFilterMode(mode: FilterMode): void {
    this.storage.write(FOLDER_FILTER_MODE_KEY, mode);
  }

  private readKeys(key: string): string[] {
    const raw = this.storage.read(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  // File viewer word-wrap preference. Defaults on (friendlier on a narrow phone); only an
  // explicit '0' means off, so an unset key reads as on.
  fileWrap(): boolean {
    return this.storage.read(FILE_WRAP_KEY) !== '0';
  }

  setFileWrap(on: boolean): void {
    this.storage.write(FILE_WRAP_KEY, on ? '1' : '0');
  }

  // Open terminal links with the share sheet instead of the browser (Android). Off unless set.
  shareLinks(): boolean {
    return this.storage.read(SHARE_LINKS_KEY) === '1';
  }

  setShareLinks(on: boolean): void {
    this.storage.write(SHARE_LINKS_KEY, on ? '1' : '0');
  }

  // Global terminal font size (zoom). Unset, non-numeric, or out-of-range values fall back
  // to the default; valid values are clamped to the supported range.
  terminalFontSize(): number {
    const raw = this.storage.read(TERMINAL_FONT_SIZE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clampFontSize(parsed) : TERMINAL_FONT_DEFAULT;
  }

  setTerminalFontSize(size: number): void {
    this.storage.write(TERMINAL_FONT_SIZE_KEY, String(clampFontSize(size)));
  }

  // The ElevenLabs API key for client-side speech-to-text. App-global, stored on-device
  // only (never sent to the agent, never committed). An empty value clears it.
  elevenLabsApiKey(): string | null {
    const raw = this.storage.read(ELEVENLABS_API_KEY);
    return raw ? raw : null;
  }

  setElevenLabsApiKey(key: string): void {
    this.storage.write(ELEVENLABS_API_KEY, key);
  }

  private persist(machines: MachineConfig[]): void {
    this.storage.write(KEY, JSON.stringify(machines));
  }
}
