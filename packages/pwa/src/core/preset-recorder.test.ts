import { describe, expect, it, vi } from 'vitest';
import type { DictationPreset } from './dictation-presets';
import { PresetRecorder } from './preset-recorder';

const recorder = () => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => new Blob(['x'])) });

describe('PresetRecorder', () => {
  it('streams for a Claude voice preset and records a clip otherwise, stopping the one it started', async () => {
    const clip = recorder();
    const claude = recorder();
    let preset: DictationPreset = { id: 'cv', name: 'Claude voice', badge: 'CV', provider: 'claude' };
    const r = new PresetRecorder(() => preset, { clip, claude });
    await r.start();
    preset = { id: 'scribe', name: 'Scribe', badge: 'EL', provider: 'elevenlabs' };
    await r.stop();
    expect(claude.start).toHaveBeenCalled();
    expect(claude.stop).toHaveBeenCalled();
    expect(clip.stop).not.toHaveBeenCalled();
    await r.start();
    await r.stop();
    expect(clip.stop).toHaveBeenCalled();
  });

  it('refuses a stop with nothing recording', async () => {
    const r = new PresetRecorder(() => ({ id: 'cv', name: 'c', badge: 'C', provider: 'claude' }), { clip: recorder(), claude: recorder() });
    await expect(r.stop()).rejects.toThrow('not recording');
  });
});
