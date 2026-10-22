import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLEANUP_PROMPT,
  DEFAULT_PRESETS,
  currentPreset,
  needsKey,
  parsePresets,
  presetError,
  type DictationPreset,
} from './dictation-presets';

const clean = DEFAULT_PRESETS.find((p) => p.id === 'clean')!;
const custom: DictationPreset = {
  id: 'tr',
  name: 'Translate',
  badge: 'TR',
  provider: 'openrouter',
  model: 'google/gemini-3.8-flash',
  prompt: 'Translate to English.',
};

describe('DEFAULT_PRESETS', () => {
  it('ships Scribe, Clean up and Fast, in that order', () => {
    expect(DEFAULT_PRESETS.map((p) => p.id)).toEqual(['scribe', 'clean', 'fast']);
  });

  it('cleans up in the language spoken, as one paragraph', () => {
    expect(DEFAULT_CLEANUP_PROMPT).toContain('Write in the language the speaker used.');
    expect(DEFAULT_CLEANUP_PROMPT).toContain('single paragraph');
  });

  it('are all valid', () => {
    for (const p of DEFAULT_PRESETS) expect(presetError(p)).toBeNull();
  });
});

describe('parsePresets', () => {
  it('returns null (use the defaults) for nothing, garbage, or an empty list', () => {
    expect(parsePresets(null)).toBeNull();
    expect(parsePresets('')).toBeNull();
    expect(parsePresets('not json')).toBeNull();
    expect(parsePresets('{}')).toBeNull();
    expect(parsePresets('[]')).toBeNull();
  });

  it('keeps valid entries and drops broken ones one by one', () => {
    const broken = { ...custom, id: 'x', model: '' };
    expect(parsePresets(JSON.stringify([custom, broken, 42, null]))).toEqual([custom]);
  });

  it('returns null when nothing valid is left', () => {
    expect(parsePresets(JSON.stringify([{ id: 'x' }]))).toBeNull();
  });

  it('drops a second entry reusing an id', () => {
    expect(parsePresets(JSON.stringify([custom, { ...custom, name: 'Other' }]))).toEqual([custom]);
  });
});

describe('currentPreset', () => {
  it('finds the preset by id', () => {
    expect(currentPreset(DEFAULT_PRESETS, 'clean').id).toBe('clean');
  });

  it('falls back to the first preset for an unknown or missing id', () => {
    expect(currentPreset(DEFAULT_PRESETS, 'gone').id).toBe('scribe');
    expect(currentPreset(DEFAULT_PRESETS, null).id).toBe('scribe');
  });
});

describe('presetError', () => {
  it('requires a name', () => {
    expect(presetError({ ...custom, name: '  ' })).toMatch(/name/i);
  });

  it('requires a badge of one to three characters', () => {
    expect(presetError({ ...custom, badge: '' })).toMatch(/badge/i);
    expect(presetError({ ...custom, badge: 'ABCD' })).toMatch(/badge/i);
    expect(presetError({ ...custom, badge: '⚡' })).toBeNull();
    expect(presetError({ ...custom, badge: 'ABC' })).toBeNull();
  });

  it('requires a model and a prompt for OpenRouter', () => {
    expect(presetError({ ...custom, model: ' ' })).toMatch(/model/i);
    expect(presetError({ ...custom, prompt: '' })).toMatch(/prompt/i);
  });
});

describe('needsKey', () => {
  it('is true when the preset provider has no key', () => {
    expect(needsKey(clean, { elevenlabs: true, openrouter: false })).toBe(true);
    expect(needsKey(clean, { elevenlabs: false, openrouter: true })).toBe(false);
    expect(needsKey(DEFAULT_PRESETS[0]!, { elevenlabs: false, openrouter: true })).toBe(true);
  });
});
