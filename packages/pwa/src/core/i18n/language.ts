export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];
export type LanguageChoice = Language | 'auto';

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

export function parseLanguageChoice(stored: string | null): LanguageChoice {
  return stored !== null && isLanguage(stored) ? stored : 'auto';
}

// `auto` follows the phone: the first of its preferred languages the app speaks, else English.
export function resolveLanguage(choice: LanguageChoice, phoneLanguages: readonly string[]): Language {
  if (choice !== 'auto') return choice;
  for (const tag of phoneLanguages) {
    const primary = (tag.split('-')[0] ?? '').toLowerCase();
    if (isLanguage(primary)) return primary;
  }
  return 'en';
}
