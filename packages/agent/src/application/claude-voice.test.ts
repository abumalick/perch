import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeVoice, HOLD_REPEAT_MS, LEAD_MS, TAIL_MS, voiceSettingsProblem } from './claude-voice';

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
  it('accepts voice on in hold mode, or settings it cannot read', () => {
    expect(voiceSettingsProblem({ voice: { enabled: true, mode: 'hold' } })).toBeNull();
    expect(voiceSettingsProblem({ voiceEnabled: true })).toBeNull();
    expect(voiceSettingsProblem(null)).toBeNull();
  });

  it('refuses voice turned off', () => {
    expect(voiceSettingsProblem({ voice: { enabled: false } })).toMatch(/\/voice/);
    expect(voiceSettingsProblem({ voiceEnabled: false })).toMatch(/\/voice/);
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
    const play = vi.fn(() => playing.promise);
    const voice = new ClaudeVoice({ player: { play }, settings: { read: async () => settings } });
    const presses: number[] = [];
    const press = () => presses.push(Date.now());
    return { voice, play, playing, presses, press };
  }

  it('holds space from before the clip starts until after it ends', async () => {
    const { voice, play, playing, presses, press } = setup();
    const start = Date.now();
    const done = voice.dictate(new Uint8Array([1]), press);

    await vi.advanceTimersByTimeAsync(LEAD_MS - 1);
    expect(play).not.toHaveBeenCalled();
    expect(presses.length).toBeGreaterThan(LEAD_MS / HOLD_REPEAT_MS - 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(play).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2000);
    playing.resolve();
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    await expect(done).resolves.toBeNull();

    const last = presses.at(-1)!;
    expect(last - start).toBeGreaterThanOrEqual(LEAD_MS + 2000 + TAIL_MS - HOLD_REPEAT_MS);
    const count = presses.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('refuses a second clip while one plays, and takes the next once it is done', async () => {
    const { voice, playing, press } = setup();
    const first = voice.dictate(new Uint8Array([1]), press);
    await expect(voice.dictate(new Uint8Array([2]), press)).resolves.toMatch(/already/);
    playing.resolve();
    await vi.advanceTimersByTimeAsync(LEAD_MS + TAIL_MS);
    await expect(first).resolves.toBeNull();
  });

  it('stops holding and reports a failed playback', async () => {
    const { voice, playing, presses, press } = setup();
    const done = voice.dictate(new Uint8Array([1]), press);
    await vi.advanceTimersByTimeAsync(LEAD_MS);
    playing.reject(new Error('no loopback device'));
    await vi.advanceTimersByTimeAsync(TAIL_MS);
    await expect(done).resolves.toMatch(/no loopback device/);
    const count = presses.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(presses.length).toBe(count);
  });

  it('presses nothing when the settings refuse', async () => {
    const { voice, play, presses, press } = setup({ voice: { enabled: true, mode: 'tap' } });
    await expect(voice.dictate(new Uint8Array([1]), press)).resolves.toMatch(/hold/);
    expect(play).not.toHaveBeenCalled();
    expect(presses).toEqual([]);
  });
});
