// One dictation's playback into the machine's virtual microphone, fed as it arrives.
// Audio is 16 kHz mono s16le PCM. `end` resolves once everything written has played.
export interface VoiceStream {
  write(pcm: Uint8Array): void;
  end(): Promise<void>;
  abort(): void;
}

export interface VoicePlayerPort {
  open(): VoiceStream;
}

// Claude Code's own voice settings on this machine, as raw JSON (null when unreadable).
export interface ClaudeSettingsPort {
  read(): Promise<unknown>;
}
