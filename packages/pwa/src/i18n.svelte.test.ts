import { afterEach, describe, expect, it } from 'vitest';
import { language, msg, setLanguage } from './i18n.svelte';

afterEach(() => setLanguage('en'));

describe('i18n', () => {
  it('serves the chosen dictionary and marks the document language', () => {
    setLanguage('fr');
    expect(language()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(msg().settings.language).toBe('Langue');
    setLanguage('en');
    expect(document.documentElement.lang).toBe('en');
    expect(msg().settings.language).toBe('Language');
  });
});
