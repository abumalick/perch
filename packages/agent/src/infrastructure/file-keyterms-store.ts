import { readFile } from 'node:fs/promises';
import type { KeytermsPort } from '../ports/keyterms-port';
import { parseKeyterms } from '../application/parse-keyterms';

// Reads the dictation vocabulary from a file (default ~/.perch/keyterms.txt, typically a
// symlink to the maintainer's dotfiles). Missing or unreadable file yields an empty list, so
// the feature is opt-in and a bad file can never break dictation.
export class FileKeytermsStore implements KeytermsPort {
  constructor(private readonly filePath: string) {}

  async list(): Promise<string[]> {
    try {
      return parseKeyterms(await readFile(this.filePath, 'utf8'));
    } catch {
      return [];
    }
  }
}
