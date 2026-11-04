import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeVoice, DRAIN_MS, HOLD_REPEAT_MS, IDLE_MS, LEAD_MS, MAX_MS, TAIL_MS, voiceSettingsProblem } from './claude-voice';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('voiceSettingsProblem', () => {
  it('accepts voice on in hold mode, the default mode', () => {
    expect(voiceSettingsProblem({ voice: { enabled: true, mode: 'hold' } })).toBeNull();
    expect(voiceSettingsProblem({ voiceEnabled: true })).toBeNull();
  });

  it('refuses voice turned off, never turned on, or settings it cannot read', () => {
    expect(voiceSettingsProblem({ voice: { enabled: false } })).toMatch(/\/voice/);
    expect(voiceSettingsProblem({ voiceEnabled: false })).toMatch(/\/voice/);
    expect(voiceSettingsProblem({ voice: { mode: 'hold' } })).toMatch(/\/voice/);
    expect(voiceSettingsProblem({})).toMatch(/\/voice/);
    expect(voiceSettingsProblem(null)).toMatch(/\/voice/);
  });

  it('refuses tap mode, where each held space would submit', () => {
    expect(voiceSettingsProblem({ voice: { enabled: true, mode: 'tap' } })).toMatch(/hold/);
  });
});

describe('ClaudeVoice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(settings: unknown = { voice: { enabled: true, mode: 'hold' } }) {
    const playing = deferred();
    const written: number[] = [];
    const stream = { played: playing.promise, write: vi.fn((pcm: Uint8Array) => void written.push(...pcm)), end: vi.fn(() => playing.promise), abort: vi.fn() };
    const open = vi.fn(() => stream);
    const voice = new ClaudeVoice({ player: { open, available: async () => true }, settings: { read: async () => settings } });
    const presses: number[] = [];
    const press = () => void presses.push(Date.now());
    return { voice, open, stream, written, playing, presses, press };
  }
  const pcm = (...bytes: number[]) => new Uint8Array(bytes);

  it('is available where its player is', async () => {
    const settings = { read: async () => null };
    const open = vi.fn();
    expect(await new ClaudeVoice({ player: { open, available: async () => true }, settings }).available()).toBe(true);
    expect(await new ClaudeVoice({ player: { open, available: async () => false }, settings }).available()).toBe(false);
  });

  it('holds space at once and plays the audio LEAD_MS later, with what arrived meanwhile', async () => {
    const { voice, open, written, presses, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(0);
    expect(presses).toHaveLength(1);
    session.write(pcm(1));
    await vi.advanceTimersByTimeAsync(LEAD_MS - 1);
    expect(open).not.toHaveBeenCalled();
    expect(presses.length).toBeGreaterThan(LEAD_MS / HOLD_REPEAT_MS - 2);
    session.write(pcm(2));
    await vi.advanceTimersByTimeAsync(1);
    expect(written).toEqual([1, 2]);
    session.write(pcm(3));
    expect(written).toEqual([1, 2, 3]);
  });

  it('releases space TAIL_MS after the audio has played out', async () => {
    const { voice, stream, playing, presses, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(LEAD_MS + 2000);
    session.end();
    expect(stream.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(800);
    playing.resolve();
    await vi.advanceTimersByTimeAsync(TAIL_MS - HOLD_REPEAT_MS);
    const held = presses.length;
    await vi.advanceTimersByTimeAsync(HOLD_REPEAT_MS);
    await expect(session.done).resolves.toBeNull();
    const count = presses.length;
    expect(count).toBeGreaterThan(held - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('plays and ends a dictation that ended before playback began', async () => {
    const { voice, stream, written, playing, press } = setup();
    const session = voice.start(press);
    session.write(pcm(7));
    session.end();
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    expect(written).toEqual([7]);
    expect(stream.end).toHaveBeenCalledOnce();
    playing.resolve();
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    await expect(session.done).resolves.toBeNull();
  });

  it('refuses a second dictation while one runs, and takes the next once it is done', async () => {
    const { voice, playing, press } = setup();
    const first = voice.start(press);
    await expect(voice.start(press).done).resolves.toMatch(/already in use/);
    first.end();
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    playing.resolve();
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    await expect(first.done).resolves.toBeNull();
    const next = voice.start(press);
    next.abort('done');
    await expect(next.done).resolves.toBe('done');
  });

  it('reports a failed playback and stops holding', async () => {
    const { voice, playing, presses, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    session.end();
    playing.reject(new Error('aplay: no loopback device'));
    await expect(session.done).resolves.toMatch(/no loopback device/);
    const count = presses.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('ends at once when the player dies mid-stream', async () => {
    const { voice, playing, presses, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(LEAD_MS + 500);
    playing.reject(new Error('aplay: no such device'));
    await expect(session.done).resolves.toMatch(/no such device/);
    const count = presses.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('stops a player that does not finish after the end', async () => {
    const { voice, stream, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    session.end();
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await expect(session.done).resolves.toMatch(/did not finish/);
    expect(stream.abort).toHaveBeenCalled();
  });

  it('gives up when the phone stops sending, and stops the player', async () => {
    const { voice, stream, presses, press } = setup();
    const session = voice.start(press);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
    session.write(pcm(1));
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(stream.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(session.done).resolves.toMatch(/stopped sending/);
    expect(stream.abort).toHaveBeenCalled();
    const count = presses.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('stops a dictation that runs past MAX_MS', async () => {
    const { voice, press } = setup();
    const session = voice.start(press);
    for (let t = 0; t < MAX_MS; t += 1000) {
      session.write(pcm(0));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await expect(session.done).resolves.toMatch(/5 minutes/);
  });

  it('keeps going when a press throws', async () => {
    const { voice, playing } = setup();
    let presses = 0;
    const session = voice.start(() => {
      presses++;
      throw new Error('pty gone');
    });
    session.end();
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    playing.resolve();
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    await expect(session.done).resolves.toBeNull();
    expect(presses).toBeGreaterThan(1);
  });

  it('presses nothing and opens no player when the settings refuse', async () => {
    const { voice, open, presses, press } = setup({ voice: { enabled: true, mode: 'tap' } });
    const session = voice.start(press);
    await expect(session.done).resolves.toMatch(/hold/);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    expect(open).not.toHaveBeenCalled();
    expect(presses).toEqual([]);
    await expect(voice.start(press).done).resolves.toMatch(/hold/);
  });
});
