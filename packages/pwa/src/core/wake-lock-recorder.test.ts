import { describe, expect, it, vi } from 'vitest';
import { WakeLockRecorder } from './wake-lock-recorder';

const recorder = () => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => new Blob(['x'])) });
const lock = () => ({ release: vi.fn(async () => undefined) });

describe('WakeLockRecorder', () => {
  it('keeps the screen on from the start of a recording until it stops', async () => {
    const inner = recorder();
    const held = lock();
    const request = vi.fn(async () => held);
    const r = new WakeLockRecorder(inner, request);
    await r.start();
    expect(inner.start).toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(held.release).not.toHaveBeenCalled();
    expect(await r.stop()).toBe(await inner.stop.mock.results[0]!.value);
    await vi.waitFor(() => expect(held.release).toHaveBeenCalledTimes(1));
  });

  it('takes no lock when the recording does not start', async () => {
    const inner = { ...recorder(), start: vi.fn(async () => Promise.reject(new Error('Microphone blocked'))) };
    const request = vi.fn(async () => lock());
    await expect(new WakeLockRecorder(inner, request).start()).rejects.toThrow('Microphone blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('never fails a dictation over the lock', async () => {
    const inner = recorder();
    const r = new WakeLockRecorder(inner, async () => Promise.reject(new DOMException('no', 'NotAllowedError')));
    await r.start();
    await expect(r.stop()).resolves.toBeInstanceOf(Blob);
    const broken = { release: vi.fn(async () => Promise.reject(new Error('gone'))) };
    const r2 = new WakeLockRecorder(recorder(), async () => broken);
    await r2.start();
    await expect(r2.stop()).resolves.toBeInstanceOf(Blob);
  });

  it('releases the lock when the recording fails to stop', async () => {
    const held = lock();
    const inner = { ...recorder(), stop: vi.fn(async () => Promise.reject(new Error('lost'))) };
    const r = new WakeLockRecorder(inner, async () => held);
    await r.start();
    await expect(r.stop()).rejects.toThrow('lost');
    await vi.waitFor(() => expect(held.release).toHaveBeenCalled());
  });

  it('releases a lock granted only after the recording stopped', async () => {
    const held = lock();
    let grant!: (l: typeof held) => void;
    const r = new WakeLockRecorder(recorder(), () => new Promise((resolve) => (grant = resolve)));
    await r.start();
    await r.stop();
    grant(held);
    await vi.waitFor(() => expect(held.release).toHaveBeenCalled());
  });
});
