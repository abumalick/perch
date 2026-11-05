import { afterEach, describe, expect, it } from 'vitest';
import { describeConnectionError } from './machine-status';
import { setLanguage } from '../i18n.svelte';

const at = Date.now();

afterEach(() => setLanguage('en'));

describe('describeConnectionError', () => {
  it('shows the diagnostic as the connection recorded it, in English', () => {
    expect(describeConnectionError({ message: 'connection failed (likely network error — machine unreachable)', code: 1006, at })).toBe(
      'connection failed (likely network error — machine unreachable) (code 1006) · 0s ago',
    );
  });

  it('words the known diagnostics in French, keeping what it does not know as it came', () => {
    setLanguage('fr');
    const fr = (message: string) => describeConnectionError({ message, at }).split(' · ')[0];
    expect(fr('connection timed out')).toBe('délai de connexion dépassé');
    expect(fr('connection failed (likely network error — machine unreachable)')).toBe('échec de la connexion (probablement une erreur réseau — machine injoignable)');
    expect(fr('connection failed (never opened)')).toBe('échec de la connexion (jamais ouverte)');
    expect(fr('connection failed (secure channel failed)')).toBe('échec de la connexion (échec du canal sécurisé)');
    expect(fr('connection failed (something new)')).toBe('échec de la connexion (something new)');
    expect(fr('closed by agent — wrong agent key')).toBe('fermée par l’agent — wrong agent key');
    expect(fr('opened then dropped')).toBe('ouverte puis perdue');
    expect(fr('auth rejected')).toBe('authentification refusée');
    expect(fr('something new')).toBe('something new');
  });

  it('leaves a refusal alone: it is already worded in the current language', () => {
    setLanguage('fr');
    expect(describeConnectionError({ message: 'connection timed out', refused: true, at }).split(' · ')[0]).toBe('connection timed out');
  });
});
