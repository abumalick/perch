<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PerchStore } from '../store.svelte';
  import { scanQrCodes, type QrScan } from '../adapters/qr-camera';
  import { describeError } from '../core/describe-error';

  let {
    store,
    scan = scanQrCodes,
    readClipboard = () => navigator.clipboard.readText(),
  }: { store: Pick<PerchStore, 'pairFromLink'>; scan?: QrScan; readClipboard?: () => Promise<string> } = $props();

  let scanning = $state(false);
  let error = $state('');
  let link = $state('');
  let video = $state<HTMLVideoElement>();
  let stop: (() => void) | null = null;

  function pair(text: string): boolean {
    const result = store.pairFromLink(text);
    if ('name' in result) return true;
    error = result.error;
    return false;
  }

  function stopScan(): void {
    stop?.();
    stop = null;
    scanning = false;
  }

  async function startScan(): Promise<void> {
    error = '';
    scanning = true;
    // The video element exists once the scanning block has rendered.
    await Promise.resolve();
    try {
      const stopper = await scan(video!, (text) => {
        if (pair(text)) stopScan();
      });
      if (scanning) stop = stopper;
      else stopper();
    } catch (err) {
      scanning = false;
      const name = (err as { name?: string } | null)?.name;
      error =
        name === 'NotAllowedError'
          ? 'Camera access was refused. Allow it for this app, or paste the pairing link below.'
          : `Cannot open the camera (${describeError(err)}). Paste the pairing link below instead.`;
    }
  }

  // The way in for a link copied outside the Home Screen app (`InstallFirst`).
  async function pasteLink(): Promise<void> {
    error = '';
    let text: string;
    try {
      text = await readClipboard();
    } catch {
      error = 'Cannot read the clipboard. Paste it in the field below instead.';
      return;
    }
    pair(text);
  }

  function submitLink(event: SubmitEvent): void {
    event.preventDefault();
    if (pair(link)) link = '';
  }

  onDestroy(stopScan);
</script>

<div class="pair" data-testid="pair-machine">
  {#if scanning}
    <div class="viewfinder">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} playsinline muted autoplay></video>
    </div>
    <button type="button" class="wide" onclick={stopScan}>Cancel</button>
  {:else}
    <button type="button" class="wide" onclick={pasteLink}>Paste pairing link</button>
    <button type="button" class="wide" onclick={startScan}>Scan QR code</button>
  {/if}
  <form onsubmit={submitLink}>
    <label>
      Or paste a pairing link
      <input bind:value={link} placeholder="https://…/#pair?…" autocapitalize="off" autocomplete="off" spellcheck="false" />
    </label>
    <button type="submit" class="wide" disabled={!link.trim()}>Pair</button>
  </form>
  {#if error}<p class="diag" role="alert">{error}</p>{/if}
  <p class="hint">Run <code>perch pair</code> on the machine to get a code. It works once, for 10 minutes.</p>
</div>

<style>
  .pair { margin-top: 0.75rem; }
  .viewfinder { width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: var(--radius); background: #000; }
  video { width: 100%; height: 100%; object-fit: cover; }
  .wide {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
    min-height: 44px;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.9rem;
    touch-action: manipulation;
  }
  .wide:active { background: var(--surface-press); }
  .wide:disabled { opacity: 0.5; }
  label { display: block; margin: 0.75rem 0 0; font-size: 0.9rem; }
  input { width: 100%; min-height: 44px; box-sizing: border-box; margin-top: 0.25rem; }
  .diag { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--danger); word-break: break-word; }
  .hint { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
</style>
