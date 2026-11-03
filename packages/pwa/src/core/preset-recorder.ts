import type { DictationPreset } from './dictation-presets';
import type { AudioRecorder } from './ports/audio-recorder';

// The recorder the mic uses: a Claude voice preset streams, every other provider records a
// clip. Chosen at `start`, and kept until `stop`, so the pair always matches.
export class PresetRecorder implements AudioRecorder {
  private recording: AudioRecorder | null = null;

  constructor(
    private readonly current: () => DictationPreset,
    private readonly recorders: { clip: AudioRecorder; claude: AudioRecorder },
  ) {}

  async start(): Promise<void> {
    const recorder = this.current().provider === 'claude' ? this.recorders.claude : this.recorders.clip;
    await recorder.start();
    this.recording = recorder;
  }

  stop(): Promise<Blob> {
    const recorder = this.recording;
    this.recording = null;
    return recorder ? recorder.stop() : Promise.reject(new Error('not recording'));
  }
}
