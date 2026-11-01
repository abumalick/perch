import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ClaudeSettingsPort, VoicePlayerPort } from '../ports/voice-clip-port';
import { childEnv } from './child-env';

const exec = promisify(execFile);

export type CommandRunner = (cmd: string, args: string[]) => Promise<void>;

// The playback side of an ALSA loopback (snd-aloop): what is played here is what a recorder
// on the default capture device hears, once ~/.asoundrc points capture at `Loopback,1`.
export const LOOPBACK_DEVICE = 'plughw:Loopback,0';

const runFfmpeg: CommandRunner = async (cmd, args) => {
  await exec(cmd, args, { env: childEnv(), timeout: 5 * 60_000 });
};

// Decodes the clip with ffmpeg straight to the loopback. The clip goes through a file, not
// stdin: Safari records MP4 with its index at the end, which ffmpeg cannot read from a pipe.
export class LoopbackVoicePlayer implements VoicePlayerPort {
  constructor(
    private readonly dir: string,
    private readonly run: CommandRunner = runFfmpeg,
  ) {}

  async play(audio: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const clip = join(this.dir, 'clip');
    await writeFile(clip, audio, { mode: 0o600 });
    try {
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', clip, '-ac', '1', '-ar', '16000', '-f', 'alsa', LOOPBACK_DEVICE]);
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr?.trim();
      throw new Error(stderr ? `ffmpeg: ${stderr.split('\n').at(-1)}` : e instanceof Error ? e.message : String(e));
    } finally {
      await rm(clip, { force: true });
    }
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
