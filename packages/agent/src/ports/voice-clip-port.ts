// Plays a recorded clip into the machine's virtual microphone, resolving once it has played
// in full. The clip is whatever container the phone's browser recorded (webm, mp4).
export interface VoicePlayerPort {
  play(audio: Uint8Array): Promise<void>;
}

// Claude Code's own voice settings on this machine, as raw JSON (null when unreadable).
export interface ClaudeSettingsPort {
  read(): Promise<unknown>;
}
