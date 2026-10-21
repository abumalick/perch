// Mirrors the agent's cap (parse-keyterms.ts): above 100 terms ElevenLabs bills every clip
// as at least 20 seconds.
export const MAX_KEYTERMS = 100;

// Flattens the per-machine vocabularies into the one list a dictation request carries. Each
// machine validated its own file, so this only unions them: machines usually link the same
// dotfiles list, and the API takes each term once.
export function mergeKeyterms(perMachine: Record<string, string[]>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const machineTerms of Object.values(perMachine)) {
    for (const term of machineTerms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length === MAX_KEYTERMS) return terms;
    }
  }
  return terms;
}
