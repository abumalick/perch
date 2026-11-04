import { describe, expect, it, vi } from 'vitest';
import { ClaudeVoiceRecorder, ClaudeVoiceTranscriber, type VoiceLink } from './claude-voice';
import type { PcmSource } from './ports/pcm-source';

function fakes() {
  let emit: (pcm: Uint8Array) => void = () => undefined;
  const pcm: PcmSource = {
    start: vi.fn(async (onPcm: (pcm: Uint8Array) => void) => {
      emit = onPcm;
    }),
    stop: vi.fn(),
  };
  const link: VoiceLink = { begin: vi.fn(), chunk: vi.fn(), finish: vi.fn(async () => undefined) };
  return { pcm, link, emit: (bytes: Uint8Array) => emit(bytes) };
}

describe('ClaudeVoiceRecorder', () => {
  it('starts the stream once the mic runs, and forwards every block', async () => {
    const { pcm, link, emit } = fakes();
    const recorder = new ClaudeVoiceRecorder(pcm, link);
    await recorder.start();
    expect(link.begin).toHaveBeenCalledOnce();
    emit(new Uint8Array([1, 2]));
    expect(link.chunk).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    const audio = await recorder.stop();
    expect(pcm.stop).toHaveBeenCalled();
    expect(audio.size).toBe(0);
  });

  it('streams nothing when the mic is refused', async () => {
    const { pcm, link } = fakes();
    vi.mocked(pcm.start).mockRejectedValue(new Error('NotAllowedError'));
    await expect(new ClaudeVoiceRecorder(pcm, link).start()).rejects.toThrow();
    expect(link.begin).not.toHaveBeenCalled();
  });

  it('releases the mic when the stream cannot begin', async () => {
    const { pcm, link } = fakes();
    vi.mocked(link.begin).mockImplementation(() => {
      throw new Error('Open a workspace first');
    });
    await expect(new ClaudeVoiceRecorder(pcm, link).start()).rejects.toThrow('Open a workspace first');
    expect(pcm.stop).toHaveBeenCalled();
  });
});

describe('ClaudeVoiceTranscriber', () => {
  it('waits for the machine and types nothing itself', async () => {
    const { link } = fakes();
    await expect(new ClaudeVoiceTranscriber(link).transcribe()).resolves.toBe('');
    expect(link.finish).toHaveBeenCalled();
  });

  it('passes the machine’s refusal on as the dictation error', async () => {
    const { link } = fakes();
    vi.mocked(link.finish).mockRejectedValue(new Error('Voice is off'));
    await expect(new ClaudeVoiceTranscriber(link).transcribe()).rejects.toThrow('Voice is off');
  });
});
