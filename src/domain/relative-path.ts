import { InvalidRelativePathError } from './errors.js';

/**
 * Normalises a path relative to a project or repository root (POSIX separators) and
 * rejects anything that could escape that root.
 */
export function toRelativePath(value: string): string {
  const posix = value.replaceAll('\\', '/');
  if (posix.length === 0) {
    throw new InvalidRelativePathError(value, 'empty path');
  }
  if (posix.startsWith('/') || /^[a-zA-Z]:\//.test(posix)) {
    throw new InvalidRelativePathError(value, 'absolute paths are not allowed');
  }
  if (posix.includes('\0')) {
    throw new InvalidRelativePathError(value, 'NUL characters are not allowed');
  }
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new InvalidRelativePathError(value, 'parent segments are not allowed');
  }
  if (segments.length === 0) {
    throw new InvalidRelativePathError(value, 'path resolves to the root');
  }
  return segments.join('/');
}

/** Folders containing a relative path, outermost first (`a/b/note.md` -> `a`, `a/b`). */
export function parentFolders(path: string): string[] {
  const segments = toRelativePath(path).split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** Normalises a folder given by a user (`./notes/`, `notes\\work`) into a relative path. */
export function toFolder(value: string): string {
  return toRelativePath(value.replace(/^\.\//, ''));
}

/** Notes at the root of the project are grouped under this folder name. */
export const ROOT_FOLDER = '.';

/** First folder of a relative path, ROOT_FOLDER for a file at the root. */
export function topFolder(path: string): string {
  const separator = path.indexOf('/');
  return separator === -1 ? ROOT_FOLDER : path.slice(0, separator);
}
