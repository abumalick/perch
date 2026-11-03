import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ClaudeSettingsPort, VoicePlayerPort, VoiceStream } from '../ports/voice-stream-port';
import { childEnv } from './child-env';

// The playback side of an ALSA loopback (snd-aloop): what is played here is what a recorder
// on the default capture device hears, once ~/.asoundrc points capture at `Loopback,1`.
export const LOOPBACK_DEVICE = 'plughw:Loopback,0';
export const APLAY_ARGS = ['-q', '-D', LOOPBACK_DEVICE, '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', '16000', '-'];

// Raw PCM goes straight to aplay's stdin. An underrun (the phone's audio arriving late) is
// harmless: aplay reports it and plays on, and Claude still hears the speech.
export class AplayVoicePlayer implements VoicePlayerPort {
  constructor(
    private readonly command = 'aplay',
    private readonly args = APLAY_ARGS,
  ) {}

  open(): VoiceStream {
    const child = spawn(this.command, this.args, { env: childEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const failure = () => stderr.split('\n').filter((l) => l.trim() && !l.includes('underrun')).at(-1)?.trim();
    const played = new Promise<void>((resolve, reject) => {
      child.on('error', (e) => reject(new Error(`aplay: ${e.message}`)));
      child.on('close', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`aplay: ${failure() ?? `exited with ${code ?? signal}`}`)),
      );
    });
    played.catch(() => undefined);
    // Writing after aplay died raises EPIPE here; its exit says why, through `end`.
    child.stdin.on('error', () => undefined);
    return {
      played,
      write: (pcm) => {
        if (child.stdin.writable) child.stdin.write(pcm);
      },
      end: () => {
        child.stdin.end();
        return played;
      },
      abort: () => {
        child.kill();
      },
    };
  }
}

export class FileClaudeSettings implements ClaudeSettingsPort {
  constructor(private readonly path: string) {}

  async read(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      return null;
    }
  }
}
