// One dictation's playback into the machine's virtual microphone, fed as it arrives.
// Audio is 16 kHz mono s16le PCM. `played` settles when the player exits: it resolves once
// everything written has played after `end`, and rejects with why the player failed.
export interface VoiceStream {
  readonly played: Promise<void>;
  write(pcm: Uint8Array): void;
  end(): Promise<void>;
  abort(): void;
}

export interface VoicePlayerPort {
  open(): VoiceStream;
  // Whether this machine has the virtual mic to play into at all.
  available(): Promise<boolean>;
}

// Claude Code's own voice settings on this machine, as raw JSON (null when unreadable).
export interface ClaudeSettingsPort {
  read(): Promise<unknown>;
}
