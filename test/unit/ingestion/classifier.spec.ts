import { describe, expect, it } from 'vitest';
import { globMatcher, isMarkdownPath } from '../../../src/ingestion/classifier.js';

describe('classifier', () => {
  describe('isMarkdownPath', () => {
    it.each([
      ['README.md', true],
      ['work/kb/Architecture.MD', true],
      ['journal/2026.markdown', true],
      ['notes.txt', false],
      ['diagram.md.png', false],
      ['markdown', false],
    ])('%s -> %s', (path, expected) => {
      expect(isMarkdownPath(path)).toBe(expected);
    });
  });

  describe('globMatcher', () => {
    it('matches POSIX paths, dotfiles included', () => {
      const match = globMatcher(['**/*.md']);

      expect(match('work/kb.md')).toBe(true);
      expect(match('.drafts/idea.md')).toBe(true);
      expect(match('work/kb.txt')).toBe(false);
    });

    it('matches nothing without globs', () => {
      expect(globMatcher([])('anything.md')).toBe(false);
    });
  });
});
