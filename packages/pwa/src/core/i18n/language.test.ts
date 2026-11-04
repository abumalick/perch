import { describe, expect, it } from 'vitest';
import { resolveLanguage, parseLanguageChoice } from './language';

describe('resolveLanguage', () => {
  it('follows the first supported phone language when left on auto', () => {
    expect(resolveLanguage('auto', ['fr-FR', 'en-US'])).toBe('fr');
    expect(resolveLanguage('auto', ['FR-ca'])).toBe('fr');
    expect(resolveLanguage('auto', ['de-DE', 'fr'])).toBe('fr');
  });

  it('falls back to English when no phone language is supported', () => {
    expect(resolveLanguage('auto', ['de-DE', 'ar'])).toBe('en');
    expect(resolveLanguage('auto', [])).toBe('en');
  });

  it('lets an explicit choice win over the phone', () => {
    expect(resolveLanguage('en', ['fr-FR'])).toBe('en');
    expect(resolveLanguage('fr', ['en-US'])).toBe('fr');
  });
});

describe('parseLanguageChoice', () => {
  it('reads a stored choice, anything else as auto', () => {
    expect(parseLanguageChoice('fr')).toBe('fr');
    expect(parseLanguageChoice('en')).toBe('en');
    expect(parseLanguageChoice(null)).toBe('auto');
    expect(parseLanguageChoice('de')).toBe('auto');
  });
});
