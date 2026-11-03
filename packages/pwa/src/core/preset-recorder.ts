import type { DictationPreset } from './dictation-presets';
import type { AudioRecorder } from './ports/audio-recorder';

// The recorder the mic uses: a Claude voice preset streams, every other provider records a
// clip. Chosen at `start`; `startedWith` keeps that preset until the next start, so the
// transcriber of the same dictation uses it too even if another preset was picked meanwhile.
export class PresetRecorder implements AudioRecorder {
  private recording: AudioRecorder | null = null;
  startedWith: DictationPreset | null = null;

  constructor(
    private readonly current: () => DictationPreset,
    private readonly recorders: { clip: AudioRecorder; claude: AudioRecorder },
  ) {}

  async start(): Promise<void> {
    const preset = this.current();
    const recorder = preset.provider === 'claude' ? this.recorders.claude : this.recorders.clip;
    this.startedWith = preset;
    await recorder.start();
    this.recording = recorder;
  }

  stop(): Promise<Blob> {
    const recorder = this.recording;
    this.recording = null;
    return recorder ? recorder.stop() : Promise.reject(new Error('not recording'));
  }
}
