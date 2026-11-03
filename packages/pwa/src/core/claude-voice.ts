import type { AudioRecorder } from './ports/audio-recorder';
import type { PcmSource } from './ports/pcm-source';
import type { Transcriber } from './ports/transcriber';

// The store's side of a Claude voice dictation: it streams to the attached workspace's machine.
export interface VoiceLink {
  begin(): void;
  chunk(pcm: Uint8Array): void;
  // Resolves once the machine has played everything and Claude has the transcript.
  finish(): Promise<void>;
}

// A Claude voice preset records by streaming: the machine plays the audio into its virtual
// mic as it arrives, while holding space, and Claude Code writes the transcript into the
// prompt itself. So there is no recording to hand on, and nothing to type.
export class ClaudeVoiceRecorder implements AudioRecorder {
  constructor(
    private readonly pcm: PcmSource,
    private readonly link: VoiceLink,
  ) {}

  async start(): Promise<void> {
    await this.pcm.start((pcm) => this.link.chunk(pcm));
    try {
      this.link.begin();
    } catch (e) {
      this.pcm.stop();
      throw e;
    }
  }

  async stop(): Promise<Blob> {
    this.pcm.stop();
    return new Blob([]);
  }
}

export class ClaudeVoiceTranscriber implements Transcriber {
  constructor(private readonly link: VoiceLink) {}

  async transcribe(): Promise<string> {
    await this.link.finish();
    return '';
  }
}
