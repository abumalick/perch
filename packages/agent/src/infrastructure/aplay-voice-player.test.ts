import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APLAY_ARGS, AplayVoicePlayer, FileClaudeSettings, LOOPBACK_DEVICE, aplayArgs } from './aplay-voice-player';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-voice-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('AplayVoicePlayer', () => {
  it('plays raw 16 kHz mono PCM into the loopback', () => {
    expect(APLAY_ARGS).toEqual(['-q', '-D', LOOPBACK_DEVICE, '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', '16000', '-']);
    expect(aplayArgs('plughw:Loopback,0,2')).toEqual(APLAY_ARGS.map((a) => (a === LOOPBACK_DEVICE ? 'plughw:Loopback,0,2' : a)));
  });

  it('is available only where the kernel lists a loopback card', async () => {
    const cards = join(dir, 'cards');
    const player = new AplayVoicePlayer('aplay', APLAY_ARGS, cards);
    expect(await player.available()).toBe(false);
    await writeFile(cards, ' 0 [Generic        ]: HDA-Intel - HD-Audio Generic\n');
    expect(await player.available()).toBe(false);
    await writeFile(cards, ' 0 [Generic        ]: HDA-Intel - HD-Audio Generic\n 3 [Loopback       ]: Loopback - Loopback\n');
    expect(await player.available()).toBe(true);
  });

  it('streams what is written to the player’s stdin and resolves when it exits', async () => {
    const out = join(dir, 'out');
    const stream = new AplayVoicePlayer('sh', ['-c', `cat > ${out}`]).open();
    stream.write(new TextEncoder().encode('one '));
    stream.write(new TextEncoder().encode('two'));
    await stream.end();
    expect(await readFile(out, 'utf8')).toBe('one two');
  });

  it('reports the player’s last error line, not its underruns', async () => {
    const stream = new AplayVoicePlayer('sh', ['-c', 'echo "cannot open device" >&2; echo "underrun!!!" >&2; exit 1']).open();
    await expect(stream.end()).rejects.toThrow('aplay: cannot open device');
  });

  it('reports a player that cannot start, and survives writes after it died', async () => {
    const stream = new AplayVoicePlayer(join(dir, 'missing')).open();
    stream.write(new Uint8Array([1]));
    await expect(stream.end()).rejects.toThrow(/aplay: .*ENOENT/);
  });

  it('stops the player on abort', async () => {
    const stream = new AplayVoicePlayer('sleep', ['30']).open();
    stream.abort();
    await expect(stream.end()).rejects.toThrow(/aplay: exited with SIGTERM/);
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
