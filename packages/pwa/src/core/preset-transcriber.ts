import type { DictationPreset, DictationProvider } from './dictation-presets';
import type { Transcriber } from './ports/transcriber';

// The transcriber the mic uses: whichever provider the current preset names, read at each
// dictation so a preset picked mid-session applies to the next recording.
export class PresetTranscriber implements Transcriber {
  constructor(
    private readonly current: () => DictationPreset,
    private readonly byProvider: Record<DictationProvider, Transcriber>,
  ) {}

  transcribe(audio: Blob): Promise<string> {
    return this.byProvider[this.current().provider].transcribe(audio);
  }
}
