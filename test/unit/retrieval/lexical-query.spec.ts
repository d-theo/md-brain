import { describe, expect, it } from 'vitest';
import { queryTerms, toFtsExpression } from '../../../src/retrieval/lexical-query.js';

describe('lexical-query', () => {
  describe('queryTerms', () => {
    it('keeps significant, deduplicated, lowercased terms in French and English', () => {
      expect(queryTerms("Comment un message toxique arrive-t-il jusqu'à Core ? core")).toEqual([
        'message',
        'toxique',
        'arrive',
        'jusqu',
        'core',
      ]);
      expect(queryTerms('How is CreateToxicMessages called?')).toEqual([
        'createtoxicmessages',
        'called',
      ]);
    });

    it('returns no term for punctuation only', () => {
      expect(queryTerms('?!...')).toEqual([]);
    });

    it('limits the number of terms', () => {
      const query = Array.from({ length: 50 }, (_, index) => `term${index}`).join(' ');

      expect(queryTerms(query)).toHaveLength(32);
    });
  });

  describe('toFtsExpression', () => {
    it('quotes every term so that FTS5 syntax cannot be injected', () => {
      expect(toFtsExpression('allowlist NEAR(" blocklist*) OR')).toBe(
        '"allowlist"* OR "near" OR "blocklist"*',
      );
    });

    it('returns null without significant term', () => {
      expect(toFtsExpression('le la de ?')).toBeNull();
    });
  });
});
