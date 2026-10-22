import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterTranscriber, OPENROUTER_ENDPOINT } from './openrouter-transcriber';

const audio = new Blob(['abc'], { type: 'audio/webm;codecs=opus' });
const config = { model: 'google/gemini-3.8-flash', prompt: 'Clean it up.' };

function reply(content: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: { content } }] }) } as unknown as Response;
}
function body(status: number, json: unknown = {}): Response {
  return { ok: status < 300, status, json: () => Promise.resolve(json) } as unknown as Response;
}
// A request that only ends when its signal aborts, like a hung network call.
function hang(_url: unknown, init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
}
function transcriber(fetchFn: unknown, opts: { key?: string | null; keyterms?: string[]; model?: string } = {}) {
  return new OpenRouterTranscriber(
    () => (opts.key === undefined ? 'sk-or-k' : opts.key),
    () => ({ ...config, model: opts.model ?? config.model }),
    () => opts.keyterms ?? [],
    fetchFn as typeof fetch,
  );
}
function sent(fetchFn: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(fetchFn.mock.calls[call]![1].body as string);
}

afterEach(() => vi.useRealTimers());

describe('OpenRouterTranscriber', () => {
  it('throws when no API key is configured, without calling fetch', async () => {
    const fetchFn = vi.fn();
    await expect(transcriber(fetchFn, { key: null }).transcribe(audio)).rejects.toThrow('Set OpenRouter key in Settings');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts the prompt and the audio to the chat endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('Hello.'));
    expect(await transcriber(fetchFn).transcribe(audio)).toBe('Hello.');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-or-k');
    const req = sent(fetchFn);
    expect(req.model).toBe('google/gemini-3.8-flash');
    expect(req.temperature).toBe(0);
    expect(req.reasoning).toEqual({ effort: 'minimal' });
    expect(req.messages[0]).toEqual({ role: 'system', content: 'Clean it up.' });
    expect(req.messages[1].content[0]).toEqual({ type: 'input_audio', input_audio: { data: btoa('abc'), format: 'webm' } });
  });

  it('names an iPhone recording m4a', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('ok'));
    await transcriber(fetchFn).transcribe(new Blob(['x'], { type: 'audio/mp4' }));
    expect(sent(fetchFn).messages[1].content[0].input_audio.format).toBe('m4a');
  });

  it('prefers the Vertex route for Google models only', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('ok'));
    await transcriber(fetchFn).transcribe(audio);
    expect(sent(fetchFn).provider).toEqual({ order: ['google-vertex'], allow_fallbacks: true });
    await transcriber(fetchFn, { model: 'openai/x' }).transcribe(audio);
    expect(sent(fetchFn, 1)).not.toHaveProperty('provider');
  });

  it('appends the vocabulary to the prompt when there is one', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('ok'));
    await transcriber(fetchFn, { keyterms: ['Perch', 'pnpm'] }).transcribe(audio);
    expect(sent(fetchFn).messages[0].content).toBe(
      'Clean it up.\n\nVocabulary the speaker may use (spell these exactly): Perch, pnpm',
    );
  });

  // A newline reaching the pty submits the line; the user checks the text there before sending.
  it('types the reply as one line', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('Line one.\n\n  Line two.\n'));
    expect(await transcriber(fetchFn).transcribe(audio)).toBe('Line one. Line two.');
  });

  it('treats a blank reply as nothing said, without retrying', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply('   '));
    expect(await transcriber(fetchFn).transcribe(audio)).toBe('');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps a bad key and exhausted credit without retrying', async () => {
    const f401 = vi.fn().mockResolvedValue(body(401));
    await expect(transcriber(f401).transcribe(audio)).rejects.toThrow('Invalid OpenRouter key');
    expect(f401).toHaveBeenCalledTimes(1);
    const f402 = vi.fn().mockResolvedValue(body(402));
    await expect(transcriber(f402).transcribe(audio)).rejects.toThrow('OpenRouter credit exhausted');
    expect(f402).toHaveBeenCalledTimes(1);
  });

  it('retries a server error once', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(body(503)).mockResolvedValueOnce(reply('ok'));
    expect(await transcriber(fetchFn).transcribe(audio)).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const twice = vi.fn().mockResolvedValue(body(503));
    await expect(transcriber(twice).transcribe(audio)).rejects.toThrow('Transcription failed (HTTP 503)');
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('retries a network error once', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(reply('ok'));
    expect(await transcriber(fetchFn).transcribe(audio)).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries a 200 carrying an upstream error, and names it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(body(200, { error: { message: 'Upstream error' } }));
    await expect(transcriber(fetchFn).transcribe(audio)).rejects.toThrow('Transcription failed (Upstream error)');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries a hung request once, then gives up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchFn = vi.fn().mockImplementationOnce(hang).mockResolvedValueOnce(reply('ok'));
    const pending = transcriber(fetchFn).transcribe(audio);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe('ok');

    const hangs = vi.fn().mockImplementation(hang);
    const failing = expect(transcriber(hangs).transcribe(audio)).rejects.toThrow('Dictation timed out — try again');
    await vi.waitFor(() => expect(hangs).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await failing;
    expect(hangs).toHaveBeenCalledTimes(2);
  });

  it('allows a longer recording more time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const big = new Blob([new Uint8Array(2_000_000)], { type: 'audio/webm' });
    const fetchFn = vi.fn().mockImplementation(hang);
    const pending = transcriber(fetchFn).transcribe(big).catch(() => {});
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(35_000);
    await pending;
  });
});
