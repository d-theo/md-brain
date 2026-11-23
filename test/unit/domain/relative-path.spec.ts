import { describe, expect, it } from 'vitest';
import { InvalidRelativePathError } from '../../../src/domain/errors.js';
import {
  parentFolders,
  ROOT_FOLDER,
  toFolder,
  topFolder,
  toRelativePath,
} from '../../../src/domain/relative-path.js';

describe('relative-path', () => {
  describe('toRelativePath', () => {
    it.each([
      ['src/main.ts', 'src/main.ts'],
      ['./src//main.ts', 'src/main.ts'],
      ['src\\domain\\a.ts', 'src/domain/a.ts'],
      ['docs/', 'docs'],
    ])('normalises %s to %s', (input, expected) => {
      expect(toRelativePath(input)).toBe(expected);
    });

    it.each([
      ['', 'empty path'],
      ['/etc/passwd', 'absolute paths are not allowed'],
      ['C:/Windows', 'absolute paths are not allowed'],
      ['src/\0x', 'NUL characters are not allowed'],
      ['../secret', 'parent segments are not allowed'],
      ['src/../../x', 'parent segments are not allowed'],
      ['./', 'path resolves to the root'],
    ])('rejects %j (%s)', (input, reason) => {
      expect(() => toRelativePath(input)).toThrow(InvalidRelativePathError);
      expect(() => toRelativePath(input)).toThrow(reason);
    });
  });

  describe('parentFolders', () => {
    it.each([
      ['work/kb/architecture.md', ['work', 'work/kb']],
      ['./work//kb.md', ['work']],
      ['README.md', []],
    ])('lists the folders containing %s', (path, expected) => {
      expect(parentFolders(path)).toEqual(expected);
    });
  });

  describe('toFolder', () => {
    it.each([
      ['./work/', 'work'],
      ['work\\kb', 'work/kb'],
      ['journal', 'journal'],
    ])('normalises %j to %s', (input, expected) => {
      expect(toFolder(input)).toBe(expected);
    });

    it('rejects folders escaping the project', () => {
      expect(() => toFolder('../private')).toThrow(InvalidRelativePathError);
    });
  });

  describe('topFolder', () => {
    it('returns the first folder, or the root folder for a root note', () => {
      expect(topFolder('work/kb/architecture.md')).toBe('work');
      expect(topFolder('README.md')).toBe(ROOT_FOLDER);
    });
  });
});
