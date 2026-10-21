import { describe, it, expect, vi, afterEach } from 'vitest';
import { MediaRecorderAudio, AUDIO_CONSTRAINTS } from './media-recorder-audio';

class FakeMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = 'audio/webm';
  start(): void {}
  stop(): void {
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function stubMic(): ReturnType<typeof vi.fn> {
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  return getUserMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MediaRecorderAudio', () => {
  // Mono with the cleanup filters on is what Scribe transcribes best.
  it('asks for a mono, cleaned-up microphone stream', async () => {
    const getUserMedia = stubMic();
    await new MediaRecorderAudio().start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: AUDIO_CONSTRAINTS });
  });

  // `exact` would throw OverconstrainedError on a browser that can't honour a constraint,
  // costing dictation entirely; `ideal` degrades to whatever the device offers.
  it('states every constraint as ideal, never exact', () => {
    for (const value of Object.values(AUDIO_CONSTRAINTS)) {
      expect(value).toHaveProperty('ideal');
      expect(value).not.toHaveProperty('exact');
    }
  });

  it('resolves with the recorded audio on stop', async () => {
    stubMic();
    const recorder = new MediaRecorderAudio();
    await recorder.start();
    const blob = await recorder.stop();
    expect(blob.type).toBe('audio/webm');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('rejects a stop that was never started', async () => {
    await expect(new MediaRecorderAudio().stop()).rejects.toThrow('not recording');
  });
});
