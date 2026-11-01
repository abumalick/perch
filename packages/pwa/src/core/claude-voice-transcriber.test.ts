import { describe, expect, it, vi } from 'vitest';
import { ClaudeVoiceTranscriber } from './claude-voice-transcriber';

describe('ClaudeVoiceTranscriber', () => {
  it('hands the recording to the machine and types nothing itself', async () => {
    const send = vi.fn(async () => undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    const audio = { arrayBuffer: async () => bytes.buffer } as unknown as Blob;
    await expect(new ClaudeVoiceTranscriber(send).transcribe(audio)).resolves.toBe('');
    expect(send).toHaveBeenCalledWith(bytes);
  });

  it('passes the machine’s refusal on as the dictation error', async () => {
    const audio = { arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Blob;
    const transcriber = new ClaudeVoiceTranscriber(async () => {
      throw new Error('Voice is off');
    });
    await expect(transcriber.transcribe(audio)).rejects.toThrow('Voice is off');
  });
});
