import type { AgentMessage, BrowserSession, ClientMessage, CommandEntry, MachineStats, MediaResult, Workspace, WorkspaceStatus } from '@perch/contracts';
import { imageMediaType, pdfMediaType, audioMediaType } from '@perch/contracts';
import type { ConnectionManager } from './core/connection-manager';
import type { WorkspaceAggregator } from './core/workspace-aggregator';
import type { SettingsStore, MachineConfig } from './core/settings-store';
import { clampFontSize, isConnectable, TERMINAL_FONT_DEFAULT } from './core/settings-store';
import type { ConnectionDiagnostic, ConnectionStatus } from './core/machine-connection';
import type { ConnectionLog } from './core/connection-log';
import { deriveHomeView, type HomeView } from './core/home-view';
import { imageFiles, neighbor, position } from './core/image-nav';
import { audioFiles } from './core/audio-nav';
import { readSharedFile, consumeSharedFile, type CacheLike } from './core/shared-file';
import { checkUploadSize } from './core/upload-limit';
import { joinBrowserSessions } from './core/browser-sessions';
import { filterWorkspaces, type FilterMode } from './core/project-folders';
import { nextWorkspace } from './core/next-workspace';
import { BrowserStream, type BrowserStreamDeps } from './core/browser-stream';
import { SessionChannels } from './core/session-channels';
import { flushConnectionLog } from './core/connection-log-flush';
import { UnreadableDeviceKeyError, type KeyStorage } from './core/ports/device-identity';
import { describeError } from './core/describe-error';
import { parsePairingLink } from '@perch/secure-channel';
import { acceptPairingLink, readPairingLink } from './core/pairing';

export interface DeviceKeyInfo {
  fingerprint: string;
  storage: { x25519: KeyStorage; ed25519: KeyStorage };
  fallback?: { x25519?: string; ed25519?: string };
}
import { SpeechToText, type DictationState } from './core/speech-to-text';
import { mergeKeyterms } from './core/keyterms';
import { DEFAULT_PRESETS, currentPreset, type DictationPreset, type DictationProvider } from './core/dictation-presets';
import type { AudioRecorder } from './core/ports/audio-recorder';
import type { Transcriber } from './core/ports/transcriber';

type View = 'list' | 'terminal' | 'settings' | 'create' | 'newMachine' | 'browser' | 'viewer' | 'browserView';

// Terminal output: base64 of the pty's UTF-8 bytes. Decode base64 → bytes → UTF-8 string.
// (Writing the raw `atob` latin1 string instead mangles every non-ASCII byte — box-drawing,
// accents — into mojibake and breaks the render.)
function decode(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
// Terminal input: encode the string as UTF-8 bytes, then base64 (utf8-safe — plain
// btoa throws on non-latin1 input).
function encode(text: string): string {
  return encodeBytes(new TextEncoder().encode(text));
}

// How long to show the "Connecting…" home screen before concluding the machines are
// unreachable (phone offline, agent down or off its relay) and switching to the reconnect screen.
const GRACE_MS = 4000;
// A machine that has connected before is known-reachable, so we give it a much longer calm
// "Reconnecting…" window before falling through to the actionable "Can't reach" screen — a
// brief blip (phone waking, backoff) shouldn't alarm, but a genuine extended outage (phone
// offline, agent down) still surfaces the relay hint + Reconnect button so the user can act.
const RECONNECT_GRACE_MS = 25_000;

// Why a media preview could not be shown (a file over the cap is shown as truncated instead).
const MEDIA_ERRORS: Record<Exclude<MediaResult, 'ok' | 'too-large'>, string> = {
  forbidden: "Couldn't load this file: the agent may not read it.",
  'not-found': "Couldn't load this file: it was not found.",
  error: "Couldn't load this file: the agent could not read it.",
};

export class PerchStore {
  view = $state<View>('list');
  workspaces = $state<Workspace[]>([]);
  // Connection ids whose workspace list has arrived since they last came online.
  listedMachines = $state<string[]>([]);
  statuses = $state<Record<string, ConnectionStatus>>({});
  // A pairing link opened outside the Home Screen app on iOS, held unspent for the owner to carry
  // into the app (`outsideInstalledApp`).
  installFirst = $state<{ name: string; link: string } | null>(null);
  // True once the connect grace period has elapsed with no machine online: it flips the home
  // screen from "Connecting…" to "Can't reach your machines". Reset whenever a machine is
  // online (or on a manual reconnect) so a later drop gets a fresh grace, not an instant
  // unreachable screen.
  graceElapsed = $state(false);
  // The last connection failure per machine, surfaced in Settings so a user can see why
  // a machine won't connect. Cleared once that machine reaches `online`.
  lastConnectionError = $state<Record<string, ConnectionDiagnostic | undefined>>({});
  // This device's relay identity, shown in Settings; null until loaded or where unavailable.
  deviceKey = $state<DeviceKeyInfo | null>(null);
  // Why this device has no identity, when loading or creating it failed.
  deviceKeyError = $state<string | null>(null);
  // The stored identity reads back malformed: the one case Settings offers to make a new one.
  deviceKeyUnreadable = $state(false);
  machines = $state<MachineConfig[]>([]);
  // Machines that have reached `online` at least once this session — i.e. known-reachable, so
  // they auto-retry forever. Used to show a calm "Reconnecting…" instead of "Can't reach"
  // while such a machine is briefly down. Reactive record (not a Set) so `homeView` recomputes.
  reachedOnce = $state<Record<string, boolean>>({});
  // Enabled machines the relay or the agent refused, and why: the home screen shows these in place
  // of the network hint, which would send the owner after the wrong cause.
  refusals = $derived(
    this.machines
      .filter((m) => isConnectable(m) && this.statuses[m.id] !== 'online' && this.lastConnectionError[m.id]?.refused)
      .map((m) => ({ id: m.id, message: this.lastConnectionError[m.id]!.message })),
  );
  // Which home screen to show: add-machine / connecting / reconnecting / unreachable / create / list.
  homeView = $derived.by<HomeView>(() =>
    deriveHomeView({
      enabledMachineCount: this.machines.filter(isConnectable).length,
      anyOnline: this.machines.some(
        (m) => isConnectable(m) && this.statuses[m.id] === 'online',
      ),
      workspaceCount: this.workspaces.length,
      graceElapsed: this.graceElapsed,
      listsPending: this.machines.some(
        (m) => isConnectable(m) && this.statuses[m.id] === 'online' && !this.listedMachines.includes(m.id),
      ),
      // Calm "Reconnecting…" only within the (longer) grace window; once it elapses we fall
      // through to the actionable "Can't reach" screen so an extended outage isn't an eternal
      // spinner. `graceElapsed` here reflects RECONNECT_GRACE_MS (see recomputeGrace).
      // A machine refused for good is not retrying, so it is never "Reconnecting…".
      anyReconnecting:
        !this.graceElapsed &&
        this.machines.some(
          (m) => isConnectable(m) && this.reachedOnce[m.id] && this.statuses[m.id] !== 'online' && !this.lastConnectionError[m.id]?.final,
        ),
      anyRefusedForGood: this.machines.some(
        (m) => isConnectable(m) && this.statuses[m.id] !== 'online' && this.lastConnectionError[m.id]?.final,
      ),
    }),
  );
  // The machine used for the last create, so the New workspace view can preselect it.
  lastMachineId = $state<string | null>(null);
  // The command run for the last create, so the New workspace view can preselect it.
  lastCommand = $state<string | null>(null);
  active = $state<Workspace | null>(null);
  recentPaths = $state<Record<string, string[]>>({});
  // The agent's configured project roots, per machine, used as the folder picker's
  // top-level browse points. Filled from the `roots` reply to `listRoots` (sent on goCreate).
  machineRoots = $state<Record<string, string[]>>({});
  // The agent machine's command shortcuts, per machine, offered by the keyboard bar's
  // drop-down. Filled from the `commands` reply to `listCommands` (sent on every connect).
  machineCommands = $state<Record<string, CommandEntry[]>>({});
  // What each machine offers in the Create Workspace command list: the known CLIs it has
  // installed and the custom commands launched there. Filled from the `launchers` reply to
  // `listLaunchers` (sent whenever the create form opens); absent for an agent too old to answer.
  machineLaunchers = $state<Record<string, { detected: string[]; custom: string[] }>>({});
  // The agent machine's dictation vocabulary, per machine, sent to ElevenLabs with each
  // transcription. Filled from the `keyterms` reply to `listKeyterms` (sent on every connect).
  machineKeyterms = $state<Record<string, string[]>>({});
  // The agent machine's current load, per machine, shown by the home screen's load strip.
  // Pushed by the agent on a timer and dropped when the machine goes offline: a reading is
  // only true for the moment it was taken.
  machineStats = $state<Record<string, MachineStats>>({});
  // The cgroup's cumulative OOM-kill count when this client first saw it, per machine. The
  // absolute figure is meaningless (it counts the life of the cgroup); only growth since we
  // started watching means a kill the user just took. Deliberately NOT dropped on offline:
  // a kill landing while the phone is backgrounded is the one most worth surfacing.
  private oomBaseline: Record<string, number> = {};
  dirEntries = $state<{ path: string; subdirs: string[]; files: string[] } | null>(null);

  // OOM kills this machine has taken since the client first saw its counter.
  oomKillsSince(machineId: string): number {
    const kills = this.machineStats[machineId]?.limit?.oomKills;
    const baseline = this.oomBaseline[machineId];
    if (kills === undefined || baseline === undefined) return 0;
    return Math.max(0, kills - baseline);
  }

  // The project folder the browser is confined to (the active workspace's projectPath).
  browserRoot = $state<string | null>(null);
  // Set when the agent rejects/fails a browse while the browser is open, so the UI shows
  // the failure instead of hanging on "Loading…". Cleared on each new browse request.
  browseError = $state<string | null>(null);
  // The file currently open in the read-only viewer. `text` is the decoded UTF-8 contents
  // ('' when binary or a media file). For an image or PDF, `mediaType` is its MIME and
  // `blobUrl` is a blob/object URL of the bytes read inside the session ('' while loading or when
  // over the size cap). Cleared on each new openFile.
  fileView = $state<{ path: string; text: string; mediaType: string; blobUrl: string; truncated: boolean; binary: boolean } | null>(null);
  // Set when the agent fails a readFile while the viewer is open, so the UI shows the
  // failure instead of hanging on "Loading…". Cleared on each new openFile.
  viewError = $state<string | null>(null);
  // Set when the agent rejects a create (e.g. the path is not an existing directory) while
  // the create form is open, so the form shows the failure instead of silently dropping it.
  // Cleared on each new create attempt and on entering the create view.
  createError = $state<string | null>(null);
  // An agent refusal that belongs to no particular view — e.g. parking a workspace with no
  // resumable Claude session. Without somewhere to land, such an error is dropped and the
  // action just appears to do nothing. Shown as a dismissible banner.
  actionError = $state<string | null>(null);
  // True while the New-workspace folder picker is open. It shares dirEntries/browseError
  // with the file browser (the two are never open at once) and only needs this flag so an
  // agent `error` is routed to the picker even though the view is still 'create'.
  pickerActive = $state(false);
  // Word-wrap preference for the file viewer, persisted via settings (loaded in start()).
  fileWrap = $state(true);
  shareLinks = $state(false);
  // Global terminal font size (zoom), persisted via settings (loaded in start()).
  terminalFontSize = $state(TERMINAL_FONT_DEFAULT);
  // ElevenLabs API key for client-side dictation, persisted on-device (loaded in start()).
  elevenLabsApiKey = $state('');
  // OpenRouter API key for dictation presets that run an OpenRouter model; on-device too.
  openRouterApiKey = $state('');
  // The dictation presets (the user's, or the built-in defaults) and the one the mic uses.
  dictationPresets = $state<DictationPreset[]>([...DEFAULT_PRESETS]);
  currentPresetId = $state<string | null>(null);
  // Set by the mic menu's "Add preset…": Settings opens a new preset's form, then clears it.
  addingPreset = $state(false);
  // Project-folder filter on the home list, persisted via settings (loaded in start()).
  // Two independent selections — the live one is whichever `folderFilterMode` names — so
  // focusing on a project for a moment doesn't discard a hide set once.
  folderFilter = $state<string[]>([]);
  folderHidden = $state<string[]>([]);
  folderFilterMode = $state<FilterMode>('only');
  // Whether the home list's parked group is open. Held here rather than in the list so it
  // survives opening a workspace and coming back; deliberately not persisted, so a reload
  // starts collapsed.
  parkedExpanded = $state(false);
  // Live agent-browser sessions per connection, from the agent's `browserSessions`
  // message. Keyed by the CONNECTION id (this PWA's machine config id), never the
  // agent's self-reported machine id — same routing rule as workspaces.
  browserSessions = $state<Record<string, BrowserSession[]>>({});
  // Connections that have ever sent `browserSessions` (even empty): the browser UI is
  // only offered for these, so an older agent never gets messages it can't parse.
  private browserSupport = $state<Record<string, boolean>>({});
  // Each machine's side channels (media, browser view, log flush), inside its session.
  private readonly sessionChannels = new Map<string, SessionChannels>();
  // Bumped by every media load, so a superseded one (another file, or the same one reopened)
  // never writes its result.
  private mediaLoad = 0;
  private bootLogged = false;
  // The session the browser view is showing (null when the view is closed).
  browserTarget = $state<{ connectionId: string; session: string } | null>(null);
  // Where closeBrowserView returns to (terminal when opened from a workspace, list from home).
  private browserReturnView: View = 'list';
  terminalState = $state<'live' | 'moved'>('live');
  // When true, the terminal grabs focus on mount and pops the soft keyboard. Only a
  // freshly created workspace sets this; opening an existing one leaves it false so the
  // keyboard stays closed (the user is usually reading output, not typing).
  autoFocus = $state(false);
  // A new build has been installed and is waiting; the update banner offers a reload.
  // `incomingBuildLabel` is the slug of that pending build (null if it couldn't be read).
  updateReady = $state(false);
  incomingBuildLabel = $state<string | null>(null);
  // A file handed to the app by the OS "Share" sheet (Android), read from the Cache API
  // at boot. Held until the user, in a session, taps to attach it (or to discard it); then
  // sent via the paste path (sendPutFile). Home surfaces it as a "1 file ready" banner.
  // Android-only: iOS WebKit has no Web Share Target, so nothing populates it there.
  pendingSharedFile = $state<{ name: string; bytes: Uint8Array } | null>(null);
  // The Cache holding the shared file, kept so the entry can be dropped once attached (flush).
  private sharedFileCache: CacheLike | null = null;
  onOutput: ((data: string) => void) | null = null;
  // Called before the store types into the terminal on its own (a stored file's path, a
  // dictation transcript), so the view can drop input state that assumed it owned the line.
  onInjectedInput: (() => void) | null = null;
  // Called when the active terminal's machine recovers from a drop, so the view re-attaches
  // (clear stale rows + resend `attach`) and self-heals instead of staying frozen on the last
  // frame. Wired by TerminalView, which owns the terminal dimensions.
  onReattach: (() => void) | null = null;
  // Machines seen offline since they were last online. Lets setStatus fire onReattach only on
  // a real drop-and-recover, not on the first connect (which has nothing stale to re-attach).
  private disconnected = new Set<string>();
  // Push-to-talk dictation state, mirrored from the SpeechToText controller for the UI.
  dictationState = $state<DictationState>('idle');
  dictationError = $state<string | null>(null);
  // A create we sent and are waiting to see appear in the list, so we can auto-open it.
  private pendingCreate: { machineId: string; projectPath: string; existingIds: Set<string> } | null = null;
  // Focuses App's hidden input. iOS only raises the soft keyboard from a user gesture, so
  // the create tap focuses this anchor to open the keyboard now and hold it through the
  // round-trip; the terminal takes focus from it on mount (see App.svelte, TerminalView).
  private keyboardAnchor: (() => void) | null = null;
  // Lazily built on first use so dictation is inert when its adapters aren't wired (tests
  // that omit them, or a build without mic/transcriber support).
  private stt: SpeechToText | null = null;
  // The object URL of the media file (image or PDF) currently shown in the viewer, tracked so
  // it can be revoked when the viewer closes or another file is opened (otherwise the blob leaks).
  private currentBlobUrl: string | null = null;
  // Cancels the running grace timer (null when none is armed).
  private graceCancel: (() => void) | null = null;
  private readonly startTimer: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      manager: ConnectionManager;
      aggregator: WorkspaceAggregator;
      // Applies the waiting service worker and reloads the page (wired to vite-plugin-pwa's
      // updateSW in main.ts; omitted in tests).
      applyUpdate?: () => void;
      // Speech-to-text adapters (mic + the current preset's transcriber). Omitted in tests that don't exercise
      // dictation; when absent, toggleDictation is a no-op.
      recorder?: AudioRecorder;
      transcriber?: Transcriber;
      // Arms a one-shot timer and returns a canceller (the grace clock). Defaults to
      // setTimeout; tests inject a manual timer for deterministic grace transitions.
      startTimer?: (fn: () => void, ms: number) => () => void;
      // Durable connection-event log, flushed inside each machine's session. Omitted in tests
      // that don't exercise logging; when absent, event recording and flushing are no-ops.
      connectionLog?: ConnectionLog;
      logMeta?: { ua?: string; shell?: string };
      // Milliseconds since the app was launched (navigation start); logged once as `boot` when
      // the first connect begins, so the time before connecting is measured too.
      sinceLaunch?: () => number;
      deviceKey?: () => Promise<DeviceKeyInfo>;
      replaceDeviceKey?: () => Promise<DeviceKeyInfo>;
      // Asks the owner before a tapped pairing link adds anything, and says why one was refused.
      confirm: (message: string) => boolean;
      alert: (message: string) => void;
      // An id for a machine entry a pairing link adds.
      newId: () => string;
      // This app's origin: a pairing link must name it. Defaults to the page's.
      origin?: string;
    },
  ) {
    deps.deviceKey?.().then(
      (info) => (this.deviceKey = info),
      (err: unknown) => this.failDeviceKey(err),
    );
    this.startTimer =
      deps.startTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    deps.aggregator.onChange(() => {
      this.workspaces = deps.aggregator.snapshot();
      this.listedMachines = deps.aggregator.listedMachines();
      // Keep the open workspace's metadata (e.g. status) in sync with the agent's
      // broadcasts so the terminal header status picker reflects the live state.
      if (this.active) {
        const fresh = this.workspaces.find(
          (w) => w.machineId === this.active!.machineId && w.id === this.active!.id,
        );
        if (fresh) this.active = fresh;
      }
      this.maybeOpenCreated();
    });
  }

  start(): void {
    this.machines = this.deps.settings.list();
    this.lastMachineId = this.deps.settings.lastMachine();
    this.lastCommand = this.deps.settings.lastCommand();
    this.fileWrap = this.deps.settings.fileWrap();
    this.shareLinks = this.deps.settings.shareLinks();
    this.terminalFontSize = this.deps.settings.terminalFontSize();
    this.elevenLabsApiKey = this.deps.settings.elevenLabsApiKey() ?? '';
    this.openRouterApiKey = this.deps.settings.openRouterApiKey() ?? '';
    this.dictationPresets = this.deps.settings.dictationPresets();
    this.currentPresetId = this.deps.settings.currentPresetId();
    this.folderFilter = this.deps.settings.folderFilter();
    this.folderHidden = this.deps.settings.folderHidden();
    this.folderFilterMode = this.deps.settings.folderFilterMode();
    if (this.deps.sinceLaunch && !this.bootLogged) {
      this.bootLogged = true;
      this.deps.connectionLog?.push(null, 'boot', { reason: `${Math.round(this.deps.sinceLaunch())}ms` });
    }
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  // The agent said this entry's device key is enrolled: nothing else is needed to connect, and
  // a token kept would be sent to whoever answers with the agent's key.
  forgetCredentials(machineId: string, scope: 'all' | 'pairing' = 'all'): void {
    if (scope === 'all') this.deps.settings.forgetCredentials(machineId);
    else this.deps.settings.clearPairing(machineId);
    this.machines = this.deps.settings.list();
  }

  setStatus(machineId: string, status: ConnectionStatus): void {
    this.statuses[machineId] = status;
    if (status === 'connecting') {
      this.deps.connectionLog?.push(machineId, 'connect');
    }
    if (status === 'offline') {
      this.sessionChannels.get(machineId)?.offline();
      this.disconnected.add(machineId);
      const { [machineId]: _dropped, ...rest } = this.machineStats;
      this.machineStats = rest;
    } else if (status === 'online') {
      this.reachedOnce[machineId] = true;
      this.deps.connectionLog?.push(machineId, 'online');
      this.flushMachine(machineId);
      // goCreate asked only the machines that were up: one that connects while the form is open
      // is asked now, or its Browse stays disabled.
      if (this.view === 'create') this.askCreateData(machineId);
      this.lastConnectionError[machineId] = undefined;
      // After a drop, the reconnect resyncs the workspace list but never re-attaches the open
      // terminal, leaving it frozen on its last frame. Re-attach it automatically — exactly
      // what the manual refresh button does — so the terminal self-heals.
      if (this.disconnected.delete(machineId) && this.active?.machineId === machineId) {
        this.onReattach?.();
      }
    }
    this.recomputeGrace();
  }

  // Reconnect every enabled machine that is idle-offline (the home Reconnect button, plus app
  // refocus / browser `online`). Deliberately **skips machines already `connecting`**: aborting
  // an in-flight attempt to restart it just resets progress on a slow-to-establish path (a phone
  // waking, a slow relay) — the connect-deadline reaps a genuinely stalled one within 10s
  // anyway. Their backoff is reset instead: an attempt left in flight while the app was
  // backgrounded fails right after it returns, and would otherwise wait up to 10s to retry.
  // `manual` distinguishes a user tap from an automatic refocus in the connection log.
  reconnectAll(manual = false): void {
    this.graceElapsed = false;
    this.cancelGraceTimer();
    for (const m of this.machines) {
      const status = this.statuses[m.id];
      if (isConnectable(m) && status === 'connecting') this.deps.manager.resetBackoff(m.id);
      else if (isConnectable(m) && status !== 'online') {
        this.deps.connectionLog?.push(m.id, manual ? 'manual-reconnect' : 'auto-reconnect');
        this.deps.manager.reconnect(m.id);
      }
    }
    this.recomputeGrace();
  }

  // Drives the connect grace clock: while enabled machines exist but none are online, arm a
  // one-shot timer that flips graceElapsed (→ unreachable screen). Cancel and reset it once a
  // machine is online or there are no machines, so the screen self-heals.
  private recomputeGrace(): void {
    const enabled = this.machines.filter(isConnectable);
    const anyOnline = enabled.some((m) => this.statuses[m.id] === 'online');
    if (enabled.length === 0 || anyOnline) {
      this.cancelGraceTimer();
      this.graceElapsed = false;
      return;
    }
    if (!this.graceElapsed && !this.graceCancel) {
      // A known-reachable machine (connected before) gets the longer reconnect grace so its
      // calm "Reconnecting…" isn't cut short; a never-connected machine keeps the short grace
      // before "Can't reach". Duration is fixed at arm time (the guard above prevents re-arming).
      const graceMs = enabled.some((m) => this.reachedOnce[m.id]) ? RECONNECT_GRACE_MS : GRACE_MS;
      this.graceCancel = this.startTimer(() => {
        this.graceCancel = null;
        this.graceElapsed = true;
      }, graceMs);
    }
  }

  private cancelGraceTimer(): void {
    this.graceCancel?.();
    this.graceCancel = null;
  }

  // Probe the active machine's link now (used when the app returns to the foreground). A dead
  // socket is force-closed and reconnected, which then triggers onReattach via setStatus.
  checkActiveLiveness(): void {
    if (this.active) this.deps.manager.checkLiveness(this.active.machineId);
  }

  setConnectionError(machineId: string, diagnostic: ConnectionDiagnostic): void {
    const { attempt, retryInMs } = diagnostic;
    const retry = attempt === undefined ? '' : ` [attempt ${attempt}${retryInMs === undefined ? ', giving up' : `, retry in ${retryInMs}ms`}]`;
    this.deps.connectionLog?.push(machineId, 'close', { code: diagnostic.code, reason: diagnostic.message + retry });
    this.lastConnectionError[machineId] = diagnostic;
  }

  logPhase(machineId: string, phase: string, detail: string): void {
    this.deps.connectionLog?.push(machineId, phase, { reason: detail });
  }

  // Records an app-global connectivity event (visibility/network transition) and flushes every
  // online machine, so a foreground/reconnect drains the buffered story of the last drop.
  logConnectivity(kind: string): void {
    this.deps.connectionLog?.push(null, kind);
    for (const m of this.machines) {
      if (this.statuses[m.id] === 'online') this.flushMachine(m.id);
    }
  }

  private flushMachine(machineId: string): void {
    if (!this.deps.connectionLog || !this.machines.some((m) => m.id === machineId)) return;
    void flushConnectionLog({
      log: this.deps.connectionLog,
      machineId,
      send: this.channelsFor(machineId).sendLog,
      meta: this.deps.logMeta,
    });
  }

  private channelsFor(machineId: string): SessionChannels {
    let channels = this.sessionChannels.get(machineId);
    if (!channels) {
      channels = new SessionChannels({
        send: (message) => this.send(machineId, message),
        isOnline: () => this.statuses[machineId] === 'online',
      });
      this.sessionChannels.set(machineId, channels);
    }
    return channels;
  }

  handleMessage(machineId: string, message: AgentMessage): void {
    if (this.channelsFor(machineId).handle(message)) return;
    switch (message.type) {
      case 'output':
        if (this.active?.id === message.workspaceId) this.onOutput?.(decode(message.data));
        return;
      case 'fileStored':
        // The agent saved a pasted file under the workspace cwd; type its relative path
        // into the terminal at the cursor, exactly like typed input.
        if (this.active?.id === message.workspaceId) this.injectInput(message.path);
        return;
      case 'detached':
        if (this.active?.id === message.workspaceId && message.reason === 'opened-elsewhere') {
          this.terminalState = 'moved';
        }
        return;
      case 'closed':
        if (this.active?.id === message.workspaceId) this.back();
        return;
      case 'recentPaths':
        this.recentPaths = { ...this.recentPaths, [machineId]: message.paths };
        return;
      case 'stats': {
        this.machineStats = { ...this.machineStats, [machineId]: message.stats };
        const kills = message.stats.limit?.oomKills;
        // A counter below the baseline means the cgroup was recreated; re-baseline rather
        // than let a negative delta read as a permanent all-clear.
        if (kills !== undefined && (this.oomBaseline[machineId] ?? Infinity) > kills) {
          this.oomBaseline[machineId] = kills;
        }
        return;
      }
      case 'launchers':
        this.machineLaunchers = { ...this.machineLaunchers, [machineId]: { detected: message.detected, custom: message.custom } };
        return;
      case 'commands':
        this.machineCommands = { ...this.machineCommands, [machineId]: message.commands };
        return;
      case 'keyterms':
        this.machineKeyterms = { ...this.machineKeyterms, [machineId]: message.keyterms };
        return;
      case 'roots':
        this.machineRoots = { ...this.machineRoots, [machineId]: message.roots };
        return;
      case 'browserSessions':
        this.browserSessions = { ...this.browserSessions, [machineId]: message.sessions };
        this.browserSupport = { ...this.browserSupport, [machineId]: true };
        return;
      case 'dirEntries':
        this.dirEntries = { path: message.path, subdirs: message.subdirs, files: message.files };
        this.browseError = null;
        return;
      case 'fileContents':
        // Text/binary only — images, PDFs and audio are read in chunks as media (openFile).
        this.fileView = {
          path: message.path,
          text: message.binary ? '' : decode(message.data),
          mediaType: '',
          blobUrl: '',
          truncated: message.truncated,
          binary: message.binary,
        };
        this.viewError = null;
        return;
      case 'error':
        // `bad_message` means an older agent rejected a client message it doesn't understand
        // (e.g. the heartbeat `ping` during a version-skew rollout). That's protocol noise,
        // not a failed user action, so don't surface it in any view.
        if (message.code === 'bad_message') return;
        // The agent reports failures (e.g. a rejected/unreadable path) as a generic error;
        // surface it in whichever view is waiting so it doesn't hang or vanish silently.
        if (this.view === 'browser' || this.pickerActive) this.browseError = message.message;
        else if (this.view === 'create' && this.pendingCreate) {
          this.createError = message.message;
          this.pendingCreate = null;
        } else if (this.view === 'viewer') this.viewError = message.message;
        else this.actionError = message.message;
        return;
      default:
        return;
    }
  }

  open(workspace: Workspace, focus = false): void {
    this.active = workspace;
    this.terminalState = 'live';
    this.autoFocus = focus;
    this.view = 'terminal';
  }

  // The workspaces the home list shows, in its order: the folder filter applied.
  get visibleWorkspaces(): Workspace[] {
    const selected = new Set(this.folderFilterMode === 'hide' ? this.folderHidden : this.folderFilter);
    return filterWorkspaces(this.workspaces, this.machines, selected, this.folderFilterMode);
  }

  get nextWorkspace(): Workspace | null {
    return this.active ? nextWorkspace(this.visibleWorkspaces, this.active) : null;
  }

  openNext(): void {
    const next = this.nextWorkspace;
    if (next) this.open(next);
  }

  // Read an OS-shared file out of the Cache API (stashed by the share-target SW helper) and
  // hold it as pending. Called once at boot; `cache` is null when the Cache API is absent or
  // no share happened, in which case this is a clean no-op. The read is non-destructive — the
  // cache entry is removed only when the file is attached (flush) — so it survives a re-open
  // before attaching, and two boots can't race to delete a just-stashed entry.
  async loadSharedFile(cache: CacheLike | null): Promise<void> {
    if (!cache) return;
    this.sharedFileCache = cache;
    this.pendingSharedFile = await readSharedFile(cache);
  }

  // Send the pending shared file to the active workspace, on the user's tap only: the share
  // target cannot prove a file came from the OS share sheet (a page that hides its referrer can
  // POST one too), so nothing is uploaded until the user has seen what and where. Needs the
  // machine online (the putFile needs a live socket to get its fileStored reply). On success
  // the cache entry is dropped so it isn't offered again next boot.
  attachSharedFile(): void {
    const shared = this.pendingSharedFile;
    if (!shared || !this.active || this.statuses[this.active.machineId] !== 'online') return;
    // The cache entry is the only copy; keep it (and the banner) if the send was refused,
    // e.g. the file is over the upload cap. Otherwise the bytes would be gone for good.
    if (!this.sendPutFile(shared.name, shared.bytes)) return;
    this.dropSharedFile();
  }

  discardSharedFile(): void {
    this.dropSharedFile();
  }

  private dropSharedFile(): void {
    this.pendingSharedFile = null;
    if (this.sharedFileCache) void consumeSharedFile(this.sharedFileCache);
  }

  attach(cols: number, rows: number): void {
    if (this.active) this.send(this.active.machineId, { type: 'attach', workspaceId: this.active.id, cols, rows });
  }

  // Re-claim a workspace that was opened on another device: re-attaching evicts the other
  // viewer (the agent's registry is last-attach-wins), so we just flip back to live and
  // resend attach with the terminal's current size.
  takeOver(cols: number, rows: number): void {
    this.terminalState = 'live';
    this.attach(cols, rows);
  }

  sendInput(data: string): void {
    if (this.active) this.send(this.active.machineId, { type: 'input', workspaceId: this.active.id, data: encode(data) });
  }

  private injectInput(data: string): void {
    this.onInjectedInput?.();
    this.sendInput(data);
  }

  // Upload an attached file to the active workspace. The agent saves it under the workspace's
  // .tmp/files/ and replies with `fileStored`, which types the saved path into the terminal.
  // The size check lives here rather than at the call sites because paste, the file picker
  // and the share target all funnel through this one method.
  // Returns whether the file was actually sent, so a caller holding the only copy (the
  // share-target cache) knows not to discard it on a refusal.
  sendPutFile(name: string, bytes: Uint8Array): boolean {
    if (!this.active) return false;
    const tooLarge = checkUploadSize(bytes.byteLength);
    if (tooLarge) {
      this.actionError = tooLarge;
      return false;
    }
    this.send(this.active.machineId, { type: 'putFile', workspaceId: this.active.id, name, data: encodeBytes(bytes) });
    return true;
  }

  // Toggle dictation: first tap records, second stops and transcribes; the transcript is
  // inserted at the terminal via the normal input path (no auto-submit). No-op when the
  // dictation adapters aren't wired.
  toggleDictation(): Promise<void> {
    return this.speech()?.toggle() ?? Promise.resolve();
  }

  // Dismiss a dictation error (the error banner's ✕), returning the mic to idle.
  dismissDictationError(): void {
    this.stt?.dismiss();
  }

  dismissActionError(): void {
    this.actionError = null;
  }

  // The vocabulary a dictation request carries: every connected machine's list, unioned.
  // Read at transcription time, so a vocabulary arriving with a later reconnect is picked up.
  keyterms(): string[] {
    return mergeKeyterms(this.machineKeyterms);
  }

  private speech(): SpeechToText | null {
    if (this.stt) return this.stt;
    const { recorder, transcriber } = this.deps;
    if (!recorder || !transcriber) return null;
    this.stt = new SpeechToText(
      recorder,
      transcriber,
      (text) => this.injectInput(text),
      () => {
        this.dictationState = this.stt?.state ?? 'idle';
        this.dictationError = this.stt?.error ?? null;
      },
    );
    return this.stt;
  }

  resize(cols: number, rows: number): void {
    if (this.active) this.send(this.active.machineId, { type: 'resize', workspaceId: this.active.id, cols, rows });
  }

  setWorkspaceStatus(status: WorkspaceStatus): void {
    if (this.active) {
      this.send(this.active.machineId, {
        type: 'setStatus',
        workspaceId: this.active.id,
        status,
      });
    }
  }

  setWorkspaceUrgent(urgent: boolean): void {
    if (this.active) {
      this.send(this.active.machineId, {
        type: 'setUrgent',
        workspaceId: this.active.id,
        urgent,
      });
    }
  }

  closeActive(): void {
    if (this.active) {
      this.send(this.active.machineId, { type: 'close', workspaceId: this.active.id });
      this.active = null;
      this.view = 'list';
    }
  }

  back(): void {
    if (this.active) this.send(this.active.machineId, { type: 'detach', workspaceId: this.active.id });
    this.active = null;
    this.view = 'list';
  }

  goSettings(): void {
    this.view = 'settings';
  }

  goNewMachine(): void {
    this.view = 'newMachine';
  }

  private askCreateData(machineId: string): void {
    this.send(machineId, { type: 'getRecentPaths' });
    this.send(machineId, { type: 'listRoots' });
    this.send(machineId, { type: 'listLaunchers' });
  }

  forgetLauncher(machineId: string, command: string): void {
    this.send(machineId, { type: 'forgetLauncher', command });
  }

  goCreate(): void {
    for (const m of this.machines) this.askCreateData(m.id);
    this.dirEntries = null;
    this.createError = null;
    this.view = 'create';
  }

  // Leaving the create form returns you where you opened it from: the terminal when it was
  // reached from a workspace's menu, the list otherwise. No detach — the terminal was only
  // unmounted, and the agent keeps a single attachment per connection (same as openBrowser).
  cancelCreate(): void {
    if (this.active) this.view = 'terminal';
    else this.back();
  }

  browse(machineId: string, path: string): void {
    this.send(machineId, { type: 'browseDir', path });
  }

  openBrowser(): void {
    if (!this.active) return;
    this.browserRoot = this.active.projectPath;
    this.dirEntries = null;
    this.browseError = null;
    this.browse(this.active.machineId, this.active.projectPath);
    this.view = 'browser';
  }

  browseInto(path: string): void {
    if (!this.active) return;
    this.browseError = null;
    this.browse(this.active.machineId, path);
  }

  closeBrowser(): void {
    this.view = 'terminal';
  }

  supportsBrowser(connectionId: string): boolean {
    return this.machines.some((m) => m.id === connectionId) && this.browserSupport[connectionId] === true;
  }

  // Session names attached to this workspace (session name === workspace id rule).
  browserSessionsFor(workspace: Workspace): string[] {
    const sessions = this.browserSessions[workspace.machineId] ?? [];
    const peers = this.workspaces.filter((w) => w.machineId === workspace.machineId);
    return joinBrowserSessions(sessions, peers).attached.get(workspace.id) ?? [];
  }

  // Sessions matching no workspace (e.g. a home-level per-site login like `github`), across
  // every connection, for the home list's per-machine bucket.
  unattachedBrowserSessions(): { connectionId: string; name: string }[] {
    const out: { connectionId: string; name: string }[] = [];
    for (const [connectionId, sessions] of Object.entries(this.browserSessions)) {
      const peers = this.workspaces.filter((w) => w.machineId === connectionId);
      for (const name of joinBrowserSessions(sessions, peers).unattached) {
        out.push({ connectionId, name });
      }
    }
    return out;
  }

  startBrowser(connectionId: string, workspaceId: string): void {
    this.send(connectionId, { type: 'startBrowser', workspaceId });
  }

  openBrowserView(connectionId: string, session: string): void {
    this.browserReturnView = this.view;
    this.browserTarget = { connectionId, session };
    this.view = 'browserView';
  }

  closeBrowserView(): void {
    this.browserTarget = null;
    this.view = this.browserReturnView;
  }

  // Leaving after a closeSession: re-list the connection so the agent's fresh
  // browserSessions (without the closed session) replaces the stale chip.
  browserSessionClosed(): void {
    if (this.browserTarget) this.send(this.browserTarget.connectionId, { type: 'list' });
    this.closeBrowserView();
  }

  // Builds the viewer-scoped stream for the open browser target. The caller (BrowserView)
  // owns its lifecycle: open() on mount, close() on unmount, open() again to retry.
  openBrowserStream(
    handlers: Omit<BrowserStreamDeps, 'url' | 'socketFactory'>,
  ): BrowserStream | null {
    const target = this.browserTarget;
    if (!target) return null;
    if (!this.machines.some((m) => m.id === target.connectionId)) return null;
    // A stream inside the session; the session factory takes the session name as its URL.
    return new BrowserStream({
      url: target.session,
      socketFactory: this.channelsFor(target.connectionId).browser.socketFactory,
      ...handlers,
    });
  }

  // The New-workspace folder picker. It reuses browse()/dirEntries but stays on the 'create'
  // view: the picker is rendered inside CreateWorkspace so the form draft survives.
  // pickerActive routes agent errors here while it is open; the picker drives the actual
  // browsing through pickerBrowse (starting from the machine's reported roots).
  openFolderPicker(): void {
    this.dirEntries = null;
    this.browseError = null;
    this.pickerActive = true;
  }

  pickerBrowse(machineId: string, path: string): void {
    this.browseError = null;
    this.browse(machineId, path);
  }

  // Create `name` inside `parent` on the agent. The reply is a `dirEntries` for the new
  // folder, so the existing dirEntries handling browses into it (no extra client step).
  pickerMakeDir(machineId: string, parent: string, name: string): void {
    this.browseError = null;
    this.send(machineId, { type: 'makeDir', parent, name });
  }

  closeFolderPicker(): void {
    this.pickerActive = false;
  }

  openFile(path: string): void {
    if (!this.active) return;
    this.revokeBlobUrl();
    this.cancelMediaLoad();
    this.viewError = null;
    // Images, PDFs, and audio are loaded as bytes in chunks inside the session — show the viewer
    // now, load the bytes async. Everything else is requested as text/binary over the WS.
    const mediaType = imageMediaType(path) || pdfMediaType(path) || audioMediaType(path);
    if (mediaType) {
      this.fileView = { path, text: '', mediaType, blobUrl: '', truncated: false, binary: false };
      this.view = 'viewer';
      void this.loadBlobFile(path, mediaType);
    } else {
      this.fileView = null;
      this.send(this.active.machineId, { type: 'readFile', path });
      this.view = 'viewer';
    }
  }

  // Loads a media file's bytes (image, PDF, or audio) in chunks inside the session and exposes
  // them as an object URL. Guards against a newer openFile superseding this load.
  private async loadBlobFile(path: string, mediaType: string): Promise<void> {
    const machine = this.machines.find((m) => m.id === this.active?.machineId);
    if (!machine) return;
    const load = (this.mediaLoad += 1);
    const current = () => load === this.mediaLoad && this.fileView?.path === path;
    try {
      const read = await this.channelsFor(machine.id).media.read(path);
      if (!current()) return;
      if (read.result === 'too-large') {
        this.fileView = { path, text: '', mediaType, blobUrl: '', truncated: true, binary: false };
        return;
      }
      if (read.result !== 'ok') {
        this.viewError = MEDIA_ERRORS[read.result];
        return;
      }
      const objectUrl = URL.createObjectURL(read.blob);
      if (!current()) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.currentBlobUrl = objectUrl;
      this.fileView = { path, text: '', mediaType, blobUrl: objectUrl, truncated: false, binary: false };
    } catch {
      if (current()) this.viewError = "Couldn't load this file.";
    }
  }

  // Stops a relay media transfer nobody will look at, so it does not keep squatting the
  // session ahead of terminal output.
  private cancelMediaLoad(): void {
    this.mediaLoad += 1;
    for (const channels of this.sessionChannels.values()) channels.media.cancel();
  }

  private revokeBlobUrl(): void {
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
  }

  closeViewer(): void {
    this.revokeBlobUrl();
    this.cancelMediaLoad();
    this.view = 'browser';
  }

  showImageNeighbor(dir: -1 | 1): void {
    if (!this.dirEntries || !this.fileView) return;
    const next = neighbor(imageFiles(this.dirEntries.files), this.fileView.path, dir);
    if (next) this.openFile(next);
  }

  get imagePosition(): { index: number; count: number } | null {
    if (!this.dirEntries || !this.fileView) return null;
    return position(imageFiles(this.dirEntries.files), this.fileView.path);
  }

  showAudioNeighbor(dir: -1 | 1): void {
    if (!this.dirEntries || !this.fileView) return;
    const next = neighbor(audioFiles(this.dirEntries.files), this.fileView.path, dir);
    if (next) this.openFile(next);
  }

  get audioPosition(): { index: number; count: number } | null {
    if (!this.dirEntries || !this.fileView) return null;
    return position(audioFiles(this.dirEntries.files), this.fileView.path);
  }

  setFileWrap(on: boolean): void {
    this.fileWrap = on;
    this.deps.settings.setFileWrap(on);
  }

  setShareLinks(on: boolean): void {
    this.shareLinks = on;
    this.deps.settings.setShareLinks(on);
  }

  setTerminalFontSize(size: number): void {
    const clamped = clampFontSize(size);
    this.terminalFontSize = clamped;
    this.deps.settings.setTerminalFontSize(clamped);
  }

  setElevenLabsApiKey(key: string): void {
    this.elevenLabsApiKey = key;
    this.deps.settings.setElevenLabsApiKey(key);
  }

  setOpenRouterApiKey(key: string): void {
    this.openRouterApiKey = key;
    this.deps.settings.setOpenRouterApiKey(key);
  }

  get presetKeys(): Record<DictationProvider, boolean> {
    return { elevenlabs: !!this.elevenLabsApiKey, openrouter: !!this.openRouterApiKey };
  }

  get currentPreset(): DictationPreset {
    return currentPreset(this.dictationPresets, this.currentPresetId, this.presetKeys);
  }

  selectPreset(id: string): void {
    this.currentPresetId = id;
    this.deps.settings.setCurrentPresetId(id);
  }

  saveDictationPresets(presets: DictationPreset[]): void {
    this.dictationPresets = presets;
    this.deps.settings.setDictationPresets(presets);
  }

  addDictationPreset(): void {
    this.back();
    this.addingPreset = true;
    this.view = 'settings';
  }

  resetDictationPresets(): void {
    this.dictationPresets = [...DEFAULT_PRESETS];
    this.deps.settings.setDictationPresets(null);
  }

  setFolderFilter(keys: string[]): void {
    this.folderFilter = keys;
    this.deps.settings.setFolderFilter(keys);
  }

  setFolderHidden(keys: string[]): void {
    this.folderHidden = keys;
    this.deps.settings.setFolderHidden(keys);
  }

  setFolderFilterMode(mode: FilterMode): void {
    this.folderFilterMode = mode;
    this.deps.settings.setFolderFilterMode(mode);
  }

  toggleParked(): void {
    this.parkedExpanded = !this.parkedExpanded;
  }

  setKeyboardAnchor(focus: (() => void) | null): void {
    this.keyboardAnchor = focus;
  }

  notifyUpdateAvailable(label: string | null): void {
    this.incomingBuildLabel = label;
    this.updateReady = true;
  }

  applyUpdate(): void {
    this.deps.applyUpdate?.();
  }

  dismissUpdate(): void {
    this.updateReady = false;
  }

  requestCreate(machineId: string, projectPath: string, command: string, remember = false): void {
    // Open the keyboard while the create tap's gesture is still live (see keyboardAnchor).
    this.keyboardAnchor?.();
    this.createError = null;
    const existingIds = new Set(this.workspaces.map((w) => w.id));
    this.pendingCreate = { machineId, projectPath, existingIds };
    this.lastMachineId = machineId;
    this.deps.settings.setLastMachine(machineId);
    this.lastCommand = command;
    this.deps.settings.setLastCommand(command);
    this.send(machineId, remember ? { type: 'create', projectPath, command, remember } : { type: 'create', projectPath, command });
    // Stay on the create form until the agent confirms the workspace (then we jump into it)
    // or reports an error (surfaced inline). This keeps the form's draft so the user can fix
    // a bad path without retyping.
  }

  // Once the agent reports the new workspace, jump into it with the keyboard up so the
  // user can type the first command. Matching by (machine, path, not-seen-before id)
  // pinpoints the one we just created even if others share the path.
  private maybeOpenCreated(): void {
    const pending = this.pendingCreate;
    if (!pending) return;
    const created = this.workspaces.find(
      (w) => w.machineId === pending.machineId && w.projectPath === pending.projectPath && !pending.existingIds.has(w.id),
    );
    if (!created) return;
    this.pendingCreate = null;
    if (this.view === 'list' || this.view === 'create') this.open(created, true);
  }

  private origin(): string {
    return this.deps.origin ?? location.origin;
  }

  // A pairing link, scanned or pasted: adds (or updates) the relay entry and connects it.
  // Returns the machine's name, or why the link was refused.
  pairFromLink(text: string): { name: string } | { error: string } {
    const read = readPairingLink(text, this.origin());
    if (!read.ok) return { error: read.reason };
    // Pasting or scanning a code is the owner's own act: nothing to confirm, and a refusal is
    // shown beside the input rather than in a dialog.
    let error = '';
    const machine = acceptPairingLink(this.deps.settings.list(), read.link, {
      confirm: () => true,
      alert: (message) => (error = message),
      newId: this.deps.newId,
    });
    if (!machine) return { error };
    this.addPairedMachine(machine);
    return { name: read.link.name };
  }

  // A pairing link tapped inside the app (a terminal link, any in-app link): handled here, by the
  // running app, rather than opened in another page context that would add the entry behind its
  // back. False when `uri` is not a pairing link, which is then the browser's to open.
  openPairingLink(uri: string): boolean {
    if (!parsePairingLink(uri)) return false;
    const read = readPairingLink(uri, this.origin());
    if (!read.ok) {
      this.deps.alert(read.reason);
      return true;
    }
    const machine = acceptPairingLink(this.deps.settings.list(), read.link, this.deps);
    if (machine) this.addPairedMachine(machine);
    return true;
  }

  holdForInstall(link: string): void {
    const parsed = parsePairingLink(link);
    if (parsed) this.installFirst = { name: parsed.name, link };
  }

  pairInBrowser(): void {
    const held = this.installFirst;
    this.installFirst = null;
    if (held) this.openPairingLink(held.link);
  }

  private addPairedMachine(machine: MachineConfig): void {
    this.addMachine(machine);
    this.view = 'list';
  }

  // Machine entries written by another page context of the app (a pairing link opened in a new
  // window): taken up when they differ, since applying them reconnects every machine.
  refreshMachines(): void {
    const stored = this.deps.settings.list();
    if (JSON.stringify(stored) === JSON.stringify(this.machines)) return;
    this.machines = stored;
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  addMachine(config: MachineConfig): void {
    this.deps.settings.add(config);
    this.machines = this.deps.settings.list();
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  updateMachine(id: string, patch: { url: string; token?: string; defaultPath?: string; agentKey?: string }): void {
    this.deps.settings.update(id, patch);
    this.machines = this.deps.settings.list();
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  removeMachine(id: string): void {
    this.deps.settings.remove(id);
    this.machines = this.deps.settings.list();
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  toggleMachine(id: string): void {
    const current = this.machines.find((m) => m.id === id);
    if (!current) return;
    this.deps.settings.setEnabled(id, current.enabled === false);
    this.machines = this.deps.settings.list();
    this.deps.manager.setMachines(this.machines);
    this.recomputeGrace();
  }

  private failDeviceKey(err: unknown): void {
    this.deviceKeyError = describeError(err);
    this.deviceKeyUnreadable = err instanceof UnreadableDeviceKeyError;
  }

  async replaceDeviceKey(): Promise<void> {
    if (!this.deviceKeyUnreadable || !this.deps.replaceDeviceKey) return;
    try {
      this.deviceKey = await this.deps.replaceDeviceKey();
      this.deviceKeyError = null;
      this.deviceKeyUnreadable = false;
    } catch (err) {
      this.failDeviceKey(err);
      return;
    }
    for (const m of this.machines) {
      if (isConnectable(m)) this.reconnectMachine(m.id);
    }
  }

  reconnectMachine(id: string): void {
    this.deps.connectionLog?.push(id, 'manual-reconnect');
    this.deps.manager.reconnect(id);
  }

  private send(machineId: string, message: ClientMessage): void {
    this.deps.manager.send(machineId, message);
  }
}
