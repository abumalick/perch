import type { Transcriber } from '../core/ports/transcriber';

export const SCRIBE_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
export const SCRIBE_MODEL_ID = 'scribe_v2';

// Transcribes audio via ElevenLabs Scribe directly from the browser. The API key and the
// keyterm vocabulary are read lazily on each call (so a key entered after construction, or a
// vocabulary that arrives with a later reconnect, is picked up). Language is left unset so
// Scribe auto-detects. The request is bounded by a timeout so a hung network call surfaces as
// an error the UI can leave and retry, rather than leaving dictation stuck "transcribing"
// forever.
export class ElevenLabsTranscriber implements Transcriber {
  constructor(
    private readonly getKey: () => string | null,
    private readonly getKeyterms: () => string[] = () => [],
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs = 30_000,
  ) {}

  async transcribe(audio: Blob): Promise<string> {
    const key = this.getKey();
    if (!key) throw new Error('Set ElevenLabs key in Settings');

    const form = new FormData();
    form.append('file', audio, audioFileName(audio.type));
    form.append('model_id', SCRIBE_MODEL_ID);
    // Drop filler words, false starts and non-speech sounds at the source (scribe_v2 only).
    form.append('no_verbatim', 'true');
    // Defaults to true server-side, which types "(baby crying)" into the terminal.
    form.append('tag_audio_events', 'false');
    // One part per term is how the API takes a list; the agent already validated and capped
    // them, so they go on the wire as they arrive.
    for (const term of this.getKeyterms()) form.append('keyterms', term);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(SCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new Error('Dictation timed out — try again');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(await errorMessage(res));

    const data: unknown = await res.json();
    const text = (data as { text?: unknown })?.text;
    return typeof text === 'string' ? text : '';
  }
}

// Name the upload after what the platform actually recorded (Safari → mp4, Chromium → webm),
// so the extension never contradicts the bytes.
function audioFileName(mimeType: string): string {
  const type = mimeType.split(';')[0]?.trim().toLowerCase();
  if (type === 'audio/mp4' || type === 'audio/aac') return 'audio.m4a';
  if (type === 'audio/ogg') return 'audio.ogg';
  if (type === 'audio/mpeg') return 'audio.mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'audio.wav';
  return 'audio.webm';
}

// Map an ElevenLabs error response to a message the user can act on. Out-of-credit comes
// back as a 401 whose body reports a quota status, so the body is inspected before falling
// back to the plain 401 "invalid key" reading.
async function errorMessage(res: Response): Promise<string> {
  const status = await quotaOrKeyStatus(res);
  if (res.status === 402 || /quota|credit|exceed/i.test(status)) return 'ElevenLabs quota exceeded';
  if (res.status === 401) return 'Invalid ElevenLabs key';
  return `Transcription failed (HTTP ${res.status})`;
}

async function quotaOrKeyStatus(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { status?: unknown } };
    const status = body?.detail?.status;
    return typeof status === 'string' ? status : '';
  } catch {
    return '';
  }
}
