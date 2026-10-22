import { describe, it, expect, vi } from 'vitest';
import { PresetTranscriber } from './preset-transcriber';
import { DEFAULT_PRESETS, type DictationPreset } from './dictation-presets';

describe('PresetTranscriber', () => {
  it('delegates to the provider of the preset current at each call', async () => {
    const elevenlabs = { transcribe: vi.fn().mockResolvedValue('scribe') };
    const openrouter = { transcribe: vi.fn().mockResolvedValue('gemini') };
    let preset: DictationPreset = DEFAULT_PRESETS[0]!;
    const t = new PresetTranscriber(() => preset, { elevenlabs, openrouter });
    const audio = new Blob(['x']);

    expect(await t.transcribe(audio)).toBe('scribe');
    preset = DEFAULT_PRESETS[1]!;
    expect(await t.transcribe(audio)).toBe('gemini');
    expect(openrouter.transcribe).toHaveBeenCalledWith(audio);
  });
});
