import { describe, expect, it } from 'vitest';
import { contentHash, normalizeContent, sha256 } from '../../../src/domain/content-hash.js';

describe('content-hash', () => {
  describe('normalizeContent', () => {
    it('normalises line endings, trailing spaces and surrounding blank lines', () => {
      expect(normalizeContent('\n  a  \r\nb\t\n\n')).toBe('  a\nb');
    });
  });

  describe('contentHash', () => {
    it('ignores formatting noise', () => {
      expect(contentHash('a\r\nb  \n')).toBe(contentHash('a\nb'));
    });

    it('detects real changes', () => {
      expect(contentHash('a\nb')).not.toBe(contentHash('a\nc'));
    });
  });

  describe('sha256', () => {
    it('hashes raw content without normalisation', () => {
      expect(sha256('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(sha256(new TextEncoder().encode('abc'))).toBe(sha256('abc'));
      expect(sha256('a ')).not.toBe(sha256('a'));
    });
  });
});
