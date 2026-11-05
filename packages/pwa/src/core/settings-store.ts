import type { StoragePort } from './ports/storage';
import type { FilterMode } from './project-folders';
import { parseAgentKey } from './relay-key';
import { normalizeAddress } from './machine-addresses';
import { parseLanguageChoice, type LanguageChoice } from './i18n/language';
import { DEFAULT_PRESETS, parsePresets, type DictationPreset } from './dictation-presets';

export interface MachineConfig {
  id: string;
  name: string;
  // Where the agent is reached, tried in this order: its own listener, behind `tailscale serve`,
  // Funnel or a proxy. Stored normalized (`normalizeAddress`).
  addresses: string[];
  token: string;
  defaultPath?: string; // root that relative New-workspace paths resolve against
  enabled?: boolean; // absent = enabled; false = user switched the machine off
  // The agent's X25519 public key (base64url), which the Noise session pins.
  agentKey: string;
  // A one-time pairing secret from a pairing link, used in place of the token until this
  // device's key is enrolled; cleared once the machine has accepted it. A paired entry has no
  // token at all: its enrolled device key is what authenticates it from then on.
  pairing?: string;
}

// A machine the app tries to reach: switched on, with an agent key the session can pin and an
// address to dial. Storage is read as it is, so an entry missing either is listed but never
// connected.
export function isConnectable(machine: Pick<MachineConfig, 'agentKey' | 'enabled' | 'addresses'>): boolean {
  return (
    machine.enabled !== false &&
    parseAgentKey(machine.agentKey) !== null &&
    Array.isArray(machine.addresses) &&
    machine.addresses.length > 0 &&
    machine.addresses.every((address) => normalizeAddress(address) !== null)
  );
}

const KEY = 'tarfa.machines';
const LAST_MACHINE_KEY = 'tarfa.lastMachine';
const LAST_COMMAND_KEY = 'tarfa.lastCommand';
const FILE_WRAP_KEY = 'tarfa.fileWrap';
const TERMINAL_FONT_SIZE_KEY = 'tarfa.terminalFontSize';
const SHARE_LINKS_KEY = 'tarfa.shareLinks';
const LANGUAGE_KEY = 'tarfa.language';
const ELEVENLABS_API_KEY = 'tarfa.elevenLabsApiKey';
const OPENROUTER_API_KEY = 'tarfa.openRouterApiKey';
const DICTATION_PRESETS_KEY = 'tarfa.dictationPresets';
const DICTATION_PRESET_KEY = 'tarfa.dictationPreset';
const FOLDER_FILTER_KEY = 'tarfa.folderFilter';
const FOLDER_HIDDEN_KEY = 'tarfa.folderHidden';
const FOLDER_FILTER_MODE_KEY = 'tarfa.folderFilterMode';

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

  update(id: string, patch: { addresses: string[]; token?: string; defaultPath?: string; agentKey?: string }): void {
    const machines = this.list();
    if (!machines.some((m) => m.id === id)) return;
    this.persist(
      machines.map((m) =>
        m.id === id
          ? {
              ...m,
              addresses: patch.addresses,
              token: patch.token ?? m.token,
              defaultPath: patch.defaultPath ?? m.defaultPath,
              agentKey: patch.agentKey ?? m.agentKey,
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

  // The app's language; unset (or unknown) follows the phone.
  languageChoice(): LanguageChoice {
    return parseLanguageChoice(this.storage.read(LANGUAGE_KEY));
  }

  setLanguageChoice(choice: LanguageChoice): void {
    this.storage.write(LANGUAGE_KEY, choice);
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

  // The OpenRouter API key, for dictation presets that run an OpenRouter model. Same rules as
  // the ElevenLabs key.
  openRouterApiKey(): string | null {
    const raw = this.storage.read(OPENROUTER_API_KEY);
    return raw ? raw : null;
  }

  setOpenRouterApiKey(key: string): void {
    this.storage.write(OPENROUTER_API_KEY, key);
  }

  // The user's dictation presets, or the built-in defaults while they have not edited them.
  dictationPresets(): DictationPreset[] {
    return parsePresets(this.storage.read(DICTATION_PRESETS_KEY)) ?? [...DEFAULT_PRESETS];
  }

  // null goes back to the built-in defaults.
  setDictationPresets(presets: DictationPreset[] | null): void {
    this.storage.write(DICTATION_PRESETS_KEY, presets ? JSON.stringify(presets) : '');
  }

  currentPresetId(): string | null {
    return this.storage.read(DICTATION_PRESET_KEY) || null;
  }

  setCurrentPresetId(id: string): void {
    this.storage.write(DICTATION_PRESET_KEY, id);
  }

  private persist(machines: MachineConfig[]): void {
    this.storage.write(KEY, JSON.stringify(machines));
  }
}
