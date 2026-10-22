import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import App from './App.svelte';
import { PerchStore } from './store.svelte';
import { ConnectionManager } from './core/connection-manager';
import { WorkspaceAggregator } from './core/workspace-aggregator';
import { SettingsStore } from './core/settings-store';
import { LocalStorageAdapter } from './adapters/local-storage';
import { createConnectionLog } from './core/connection-log';
import { createStorageLogStore } from './adapters/storage-log-store';
import { browserFrameSocketFactory } from './adapters/browser-frame-socket';
import { fetchRelayChallenge, noiseSocketFactory } from './adapters/noise-socket';
import { indexedDbIdentityStore, loadDeviceIdentity, replaceUnreadableDeviceIdentity } from './adapters/device-keys';
import { deviceName } from './core/device-name';
import { deviceFingerprint } from '@perch/secure-channel';
import type { DeviceIdentity } from './core/ports/device-identity';
import { MediaRecorderAudio } from './adapters/media-recorder-audio';
import { ElevenLabsTranscriber } from './adapters/elevenlabs-transcriber';
import { VERSION_FILE, parseVersionJson } from './core/version-file';
import { acceptPairingLink, outsideInstalledApp, takePairingFragment, type PairingPrompts } from './core/pairing';

// Poll for a new service worker every minute so an OPEN PWA learns about new builds.
// registerType is 'prompt': the new worker installs and waits instead of reloading on
// its own (iOS standalone never reliably auto-reloaded). When it's waiting, onNeedRefresh
// fires; we surface a banner and only reload when the user taps it (updateSW(true)).
const UPDATE_INTERVAL_MS = 60_000;

// The running app only has its own (now-stale) build identity baked in, so fetch the
// incoming build's label + id from the network-only version.json. Falls back to nulls
// (generic banner / no-op) on a failed or malformed response.
async function fetchVersion(): Promise<{ label: string | null }> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${VERSION_FILE}?ts=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return { label: null };
    return parseVersionJson(await res.json());
  } catch {
    return { label: null };
  }
}

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      setInterval(() => {
        void registration.update();
      }, UPDATE_INTERVAL_MS);
    }
  },
  onNeedRefresh() {
    void fetchVersion().then(({ label }) => store.notifyUpdateAvailable(label));
  },
});

const aggregator = new WorkspaceAggregator();

const storage = new LocalStorageAdapter();
const settings = new SettingsStore(storage);
const prompts: PairingPrompts = {
  confirm: (message) => window.confirm(message),
  alert: (message) => window.alert(message),
  newId: () => crypto.randomUUID(),
};

// Opened from a pairing link (a scanned QR code, or the link itself): the fragment is taken off
// the address and history before anything else runs, and the machine is added before anything
// connects. Any page can open such a link, so the phone's owner confirms it first. On iOS outside
// the Home Screen app the link is held instead, for the owner to carry into the app.
const pairingHref = location.href;
const pairing = takePairingFragment(location, (url) => history.replaceState(history.state, '', url));
const holdPairing = pairing !== null && outsideInstalledApp(navigator as { standalone?: boolean });
if (pairing && !holdPairing) {
  const machine = acceptPairingLink(settings.list(), pairing, prompts);
  if (machine) settings.add(machine);
}

// This installed PWA's device key, created on first use and kept in IndexedDB for good.
let identity: Promise<DeviceIdentity> | null = null;
const cacheIdentity = (load: Promise<DeviceIdentity>): Promise<DeviceIdentity> =>
  (identity = load.catch((err: unknown) => {
    identity = null;
    throw err;
  }));
const deviceIdentity = (): Promise<DeviceIdentity> => identity ?? cacheIdentity(loadDeviceIdentity(indexedDbIdentityStore()));
const keyInfo = async (load: Promise<DeviceIdentity>) => {
  const { x25519Public, storage, fallback } = await load;
  return { fingerprint: deviceFingerprint(x25519Public), storage, fallback };
};

let store: PerchStore;
const legacyRelays = new Set<string>();
const manager = new ConnectionManager({
  secureSocketFactory: (agentKey, token, credential, onPhase) =>
    noiseSocketFactory(browserFrameSocketFactory, agentKey, {
      device: deviceIdentity,
      token,
      credential,
      deviceName: deviceName(navigator.userAgent),
      fetchChallenge: fetchRelayChallenge,
      legacyRelays,
      onPhase,
    }),
  aggregator,
  onMessage: (id, message) => store.handleMessage(id, message),
  onStatus: (id, status) => store.setStatus(id, status),
  onDiagnostic: (id, diagnostic) => store.setConnectionError(id, diagnostic),
  onPhase: (id, phase, detail) => store.logPhase(id, phase, detail),
  onCredentialsSpent: (id, scope) => store.forgetCredentials(id, scope),
});

// Durable connection-event log: buffers lifecycle events (with online/visibility context) and
// flushes them per-machine inside the session after a reconnect. crypto.randomUUID
// is available in the https (secure) context the PWA is served from.
const connectionLog = createConnectionLog({
  store: createStorageLogStore(storage),
  env: { now: () => Date.now(), readEnv: () => ({ online: navigator.onLine, vis: document.visibilityState }) },
  sess: crypto.randomUUID(),
});
const logMeta = { ua: navigator.userAgent, shell: 'pwa' };
store = new PerchStore({
  settings,
  manager,
  aggregator,
  applyUpdate: () => void updateSW(true),
  recorder: new MediaRecorderAudio(),
  transcriber: new ElevenLabsTranscriber(
    () => settings.elevenLabsApiKey(),
    () => store.keyterms(),
  ),
  connectionLog,
  logMeta,
  deviceKey: () => keyInfo(deviceIdentity()),
  replaceDeviceKey: () => keyInfo(cacheIdentity(replaceUnreadableDeviceIdentity(indexedDbIdentityStore()))),
  ...prompts,
});

// Pick up an image handed to us by the OS "Share" sheet (Android Web Share Target). The SW
// helper (public/share-target-sw.js) stashed it in the Cache API on the share POST; read it
// once at boot. Fire-and-forget so app boot never blocks on the Cache API. No-op where the
// Cache API is absent or no share happened. The entry is deleted only when the image is
// actually attached to a session (flush), so a re-open before attaching still surfaces it.
if ('caches' in self) {
  void caches.open('perch-shared').then((cache) => store.loadSharedFile(cache));
} else {
  void store.loadSharedFile(null);
}

if (holdPairing) store.holdForInstall(pairingHref);

const target = document.getElementById('app');
if (!target) {
  throw new Error('#app not found');
}
mount(App, { target, props: { store } });
