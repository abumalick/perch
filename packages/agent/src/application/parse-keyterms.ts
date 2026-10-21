// Over 100 keyterms, ElevenLabs bills a minimum of 20 seconds per clip — dictation here is
// usually shorter than that, so the list is capped rather than sent whole.
export const MAX_KEYTERMS = 100;

const MAX_TERM_LENGTH = 50;
const MAX_TERM_WORDS = 5;
// The API rejects these characters inside a keyterm.
const FORBIDDEN = /[<>{}[\]\\]/;

// Validates the raw text of ~/.perch/keyterms.txt: one term per line, `#` comments and blank
// lines ignored. Hand-edited, so it degrades line by line rather than rejecting the file — a
// term the API would refuse is dropped, the rest still reach Scribe.
export function parseKeyterms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const term = line.trim();
    if (term.length === 0 || term.startsWith('#')) continue;
    if (term.length > MAX_TERM_LENGTH || FORBIDDEN.test(term)) continue;
    if (term.split(/\s+/).length > MAX_TERM_WORDS) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_KEYTERMS) break;
  }
  return terms;
}
