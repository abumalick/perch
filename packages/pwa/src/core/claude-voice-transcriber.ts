import type { Transcriber } from './ports/transcriber';

// A Claude voice preset: Claude Code on the machine transcribes the recording and writes it
// into the prompt itself, so the transcript this returns is always empty.
export class ClaudeVoiceTranscriber implements Transcriber {
  constructor(private readonly send: (bytes: Uint8Array) => Promise<void>) {}

  async transcribe(audio: Blob): Promise<string> {
    await this.send(new Uint8Array(await audio.arrayBuffer()));
    return '';
  }
}
