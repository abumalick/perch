import type { ClaudeSettingsPort, VoicePlayerPort } from '../ports/voice-clip-port';

// A terminal reports no key release, so Claude Code reads a held space from the stream of
// repeats a held key produces; this is that stream. Claude needs about a second of hold
// before it records (it warms up), and a little after the audio before the release counts.
export const HOLD_REPEAT_MS = 30;
export const LEAD_MS = 1000;
export const TAIL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Why the held spaces would not be read as voice, or null. In tap mode every space toggles
// recording and submits the prompt, and with voice off they would be typed: both would spray
// the conversation. Voice is off until /voice turns it on, so only an explicit `true` counts;
// a missing mode is Claude's default, hold.
export function voiceSettingsProblem(settings: unknown): string | null {
  const s = (typeof settings === 'object' && settings !== null ? settings : {}) as {
    voiceEnabled?: unknown;
    voice?: { enabled?: unknown; mode?: unknown };
  };
  const enabled = s.voice?.enabled ?? s.voiceEnabled;
  if (enabled !== true) return 'Voice is off in Claude Code on this machine: run /voice in a workspace first';
  if (s.voice?.mode !== undefined && s.voice.mode !== 'hold') {
    return 'Claude voice needs Claude Code’s voice mode set to hold (/config)';
  }
  return null;
}

// Plays a phone's recording into the machine's virtual mic while holding space in a workspace,
// so Claude Code's own /voice transcribes it into the prompt. One clip at a time per machine:
// there is one virtual mic.
export class ClaudeVoice {
  private busy = false;

  constructor(private readonly deps: { player: VoicePlayerPort; settings: ClaudeSettingsPort }) {}

  // Resolves with why it could not dictate, or null once the clip has played and space is released.
  async dictate(audio: Uint8Array, pressSpace: () => void): Promise<string | null> {
    if (this.busy) return 'Claude voice is already playing a clip on this machine';
    this.busy = true;
    try {
      const problem = voiceSettingsProblem(await this.deps.settings.read().catch(() => null));
      if (problem) return problem;
      const press = () => {
        try {
          pressSpace();
        } catch {
          // A dead pty must not throw out of the interval and take the agent down.
        }
      };
      const hold = setInterval(press, HOLD_REPEAT_MS);
      press();
      try {
        await sleep(LEAD_MS);
        const failure = await this.deps.player.play(audio).then(
          () => null,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        await sleep(TAIL_MS);
        return failure;
      } finally {
        clearInterval(hold);
      }
    } finally {
      this.busy = false;
    }
  }
}
