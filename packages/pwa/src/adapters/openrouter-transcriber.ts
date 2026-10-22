import type { Transcriber } from '../core/ports/transcriber';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Upload and processing both grow with the recording, so each attempt gets a base plus an
// allowance per MB. The base sits above the ~13 s some requests take when OpenRouter routes
// Gemini through AI Studio rather than Vertex.
const TIMEOUT_PER_MB_MS = 10_000;

// Runs a dictation preset's OpenRouter model directly from the browser: the model hears the
// recording and returns text shaped by the preset's prompt. Key, model, prompt and vocabulary
// are read on each call, so a change in Settings or a newly picked preset applies at once.
// One retry covers the transient failures (a hang, a dropped connection, a 429/5xx, a 200
// carrying an upstream error); a bad key or exhausted credit fails at once.
export class OpenRouterTranscriber implements Transcriber {
  constructor(
    private readonly getKey: () => string | null,
    private readonly getConfig: () => { model: string; prompt: string },
    private readonly getKeyterms: () => string[] = () => [],
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly baseTimeoutMs = 15_000,
  ) {}

  async transcribe(audio: Blob): Promise<string> {
    const key = this.getKey();
    if (!key) throw new Error('Set OpenRouter key in Settings');

    const body = JSON.stringify(this.request(await base64(audio), audioFormat(audio.type)));
    const timeoutMs = this.baseTimeoutMs + TIMEOUT_PER_MB_MS * (audio.size / 1_000_000);
    let failure: Attempt = { retry: false, message: '' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attempt(key, body, timeoutMs);
      if (typeof result === 'string') return result;
      failure = result;
      if (!result.retry) break;
    }
    throw new Error(failure.message);
  }

  private request(data: string, format: string) {
    const { model, prompt } = this.getConfig();
    const terms = this.getKeyterms();
    const system = terms.length
      ? `${prompt}\n\nVocabulary the speaker may use (spell these exactly): ${terms.join(', ')}`
      : prompt;
    return {
      model,
      temperature: 0,
      reasoning: { effort: 'minimal' },
      // Best-effort: Vertex answered in ~2 s where AI Studio often took ~13 s. Fallbacks stay
      // on, since forbidding them is what produced the one multi-minute hang seen.
      ...(model.startsWith('google/') ? { provider: { order: ['google-vertex'], allow_fallbacks: true } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format } }] },
      ],
    };
  }

  private async attempt(key: string, body: string, timeoutMs: number): Promise<string | Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(OPENROUTER_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted) return { retry: true, message: 'Dictation timed out — try again' };
        return { retry: true, message: e instanceof Error ? e.message : 'Transcription failed' };
      }
      if (res.status === 401) return { retry: false, message: 'Invalid OpenRouter key' };
      if (res.status === 402) return { retry: false, message: 'OpenRouter credit exhausted' };
      if (!res.ok) {
        return { retry: res.status === 429 || res.status >= 500, message: `Transcription failed (HTTP ${res.status})` };
      }
      const data = (await res.json().catch(() => null)) as Completion | null;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        const reason = typeof data?.error?.message === 'string' ? data.error.message : 'no reply';
        return { retry: true, message: `Transcription failed (${reason})` };
      }
      // One line: a newline reaching the pty would submit what the user meant to check first.
      return content.replace(/\s*\n+\s*/g, ' ').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

type Attempt = { retry: boolean; message: string };
type Completion = { choices?: { message?: { content?: unknown } }[]; error?: { message?: unknown } };

function audioFormat(mimeType: string): string {
  const type = mimeType.split(';')[0]?.trim().toLowerCase();
  if (type === 'audio/mp4' || type === 'audio/aac' || type === 'audio/x-m4a') return 'm4a';
  if (type === 'audio/ogg') return 'ogg';
  if (type === 'audio/mpeg') return 'mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav';
  return 'webm';
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });
}
