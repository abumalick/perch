import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileClaudeSettings, LOOPBACK_DEVICE, LoopbackVoicePlayer } from './loopback-voice-player';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-voice-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('LoopbackVoicePlayer', () => {
  it('plays the clip from a file into the loopback, then deletes it', async () => {
    const calls: { cmd: string; args: string[]; bytes: string }[] = [];
    const player = new LoopbackVoicePlayer(join(dir, 'voice'), async (cmd, args) => {
      const input = args[args.indexOf('-i') + 1]!;
      const { readFile } = await import('node:fs/promises');
      calls.push({ cmd, args, bytes: (await readFile(input)).toString() });
    });
    await player.play(new TextEncoder().encode('clip-bytes'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('ffmpeg');
    expect(calls[0]!.bytes).toBe('clip-bytes');
    expect(calls[0]!.args.slice(-3)).toEqual(['-f', 'alsa', LOOPBACK_DEVICE]);
    expect(await readdir(join(dir, 'voice'))).toEqual([]);
  });

  it('reports ffmpeg’s last stderr line and still deletes the clip', async () => {
    const player = new LoopbackVoicePlayer(join(dir, 'voice'), async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'noise\nCannot open audio device plughw:Loopback,0\n' });
    });
    await expect(player.play(new Uint8Array([1]))).rejects.toThrow('ffmpeg: Cannot open audio device plughw:Loopback,0');
    expect(await readdir(join(dir, 'voice'))).toEqual([]);
  });
});

describe('FileClaudeSettings', () => {
  it('reads the JSON, and null when missing or malformed', async () => {
    const path = join(dir, 'settings.json');
    expect(await new FileClaudeSettings(path).read()).toBeNull();
    await writeFile(path, '{"voice":{"mode":"hold"}}');
    expect(await new FileClaudeSettings(path).read()).toEqual({ voice: { mode: 'hold' } });
    await writeFile(path, '{nope');
    expect(await new FileClaudeSettings(path).read()).toBeNull();
  });
});
