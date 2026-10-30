import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DirectoryChecker } from '../ports/directory-checker';

// ENOENT, a permission error, or a path that is a file all mean "not a usable directory".
export const fsIsDirectory: DirectoryChecker = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

// A directory's absolute, symlink-free path, relative paths taken from `cwd`; null when it is
// not a usable directory.
export const fsResolveDirectory = (cwd: string) => async (path: string): Promise<string | null> => {
  const absolute = resolve(cwd, path);
  if (!(await fsIsDirectory(absolute))) return null;
  try {
    return await realpath(absolute);
  } catch {
    return null;
  }
};
