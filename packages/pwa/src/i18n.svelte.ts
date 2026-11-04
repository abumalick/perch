import { en, type Messages } from './core/i18n/en';
import { fr } from './core/i18n/fr';
import type { Language } from './core/i18n/language';

const dictionaries: Record<Language, Messages> = { en, fr };

const current = $state<{ language: Language }>({ language: 'en' });

// The active dictionary. Reading it inside a template or $derived subscribes to the language,
// so changing it redraws every string in place.
export function msg(): Messages {
  return dictionaries[current.language];
}

export function language(): Language {
  return current.language;
}

export function setLanguage(next: Language): void {
  current.language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}
