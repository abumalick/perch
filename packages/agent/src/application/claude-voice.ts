import type { ClaudeSettingsPort, VoicePlayerPort, VoiceStream } from '../ports/voice-stream-port';

// A terminal reports no key release, so Claude Code reads a held space from the stream of
// repeats a held key produces; this is that stream. Claude needs about a second of hold
// before it records (it warms up), so playback starts LEAD_MS late with the audio that
// arrived meanwhile, and a little after the audio before the release counts.
export const HOLD_REPEAT_MS = 30;
export const LEAD_MS = 1000;
export const TAIL_MS = 500;
// The hold must end even when the phone vanishes mid-sentence.
export const IDLE_MS = 5000;
export const MAX_MS = 5 * 60_000;

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

// One dictation as the phone streams it. `done` settles once with why it failed, or null
// once the audio has played and space is released.
export interface VoiceSession {
  write(pcm: Uint8Array): void;
  end(): void;
  abort(reason: string): void;
  readonly done: Promise<string | null>;
}

type Deps = { player: VoicePlayerPort; settings: ClaudeSettingsPort };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Dictation implements VoiceSession {
  readonly done: Promise<string | null>;
  private resolve!: (result: string | null) => void;
  private queue: Uint8Array[] = [];
  private stream: VoiceStream | null = null;
  private ended = false;
  private finished = false;
  private hold: ReturnType<typeof setInterval> | undefined;
  private lead: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly max: ReturnType<typeof setTimeout>;

  constructor(
    private readonly deps: Deps,
    private readonly pressSpace: () => void,
    private readonly release: () => void,
  ) {
    this.done = new Promise((resolve) => (this.resolve = resolve));
    this.max = setTimeout(() => this.abort('Dictation stopped: it ran past 5 minutes'), MAX_MS);
    this.touch();
    void this.begin();
  }

  write(pcm: Uint8Array): void {
    if (this.finished || this.ended) return;
    this.touch();
    if (this.stream) this.stream.write(pcm);
    else this.queue.push(pcm);
  }

  end(): void {
    if (this.finished || this.ended) return;
    this.ended = true;
    clearTimeout(this.idle);
    if (this.stream) this.drain(this.stream);
  }

  abort(reason: string): void {
    this.stream?.abort();
    this.finish(reason);
  }

  private async begin(): Promise<void> {
    const problem = voiceSettingsProblem(await this.deps.settings.read().catch(() => null));
    if (this.finished) return;
    if (problem) return this.finish(problem);
    const press = () => {
      try {
        this.pressSpace();
      } catch {
        // A dead pty must not throw out of the interval and take the agent down.
      }
    };
    this.hold = setInterval(press, HOLD_REPEAT_MS);
    press();
    this.lead = setTimeout(() => this.play(), LEAD_MS);
  }

  private play(): void {
    if (this.finished) return;
    let stream: VoiceStream;
    try {
      stream = this.deps.player.open();
    } catch (e) {
      return this.finish(errorText(e));
    }
    this.stream = stream;
    for (const pcm of this.queue.splice(0)) stream.write(pcm);
    if (this.ended) this.drain(stream);
  }

  private drain(stream: VoiceStream): void {
    void stream.end().then(
      () => setTimeout(() => this.finish(null), TAIL_MS),
      (e: unknown) => this.finish(errorText(e)),
    );
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.abort('Dictation stopped: the phone stopped sending audio'), IDLE_MS);
  }

  private finish(result: string | null): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.hold);
    clearTimeout(this.lead);
    clearTimeout(this.idle);
    clearTimeout(this.max);
    this.queue = [];
    this.release();
    this.resolve(result);
  }
}

// Plays the phone's dictation into the machine's virtual mic as it arrives, while holding
// space in a workspace, so Claude Code's own /voice transcribes it into the prompt. One
// dictation at a time per machine: there is one virtual mic.
export class ClaudeVoice {
  private busy = false;

  constructor(private readonly deps: Deps) {}

  start(pressSpace: () => void): VoiceSession {
    if (this.busy) {
      const done = Promise.resolve('Claude voice is already in use on this machine');
      return { write: () => undefined, end: () => undefined, abort: () => undefined, done };
    }
    this.busy = true;
    return new Dictation(this.deps, pressSpace, () => (this.busy = false));
  }
}
