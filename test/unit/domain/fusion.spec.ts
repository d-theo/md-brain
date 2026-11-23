import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, reciprocalRankFusion } from '../../../src/domain/fusion.js';

describe('fusion', () => {
  describe('reciprocalRankFusion', () => {
    it('sums reciprocal ranks across sources', () => {
      const fused = reciprocalRankFusion([
        { source: 'semantic', ids: ['a', 'b'] },
        { source: 'lexical', ids: ['b', 'c'] },
      ]);

      expect(fused.map((result) => result.id)).toEqual(['b', 'a', 'c']);
      expect(fused[0]).toEqual({
        id: 'b',
        score: 1 / (DEFAULT_RRF_K + 2) + 1 / (DEFAULT_RRF_K + 1),
        ranks: { semantic: 2, lexical: 1 },
      });
    });

    it('applies source weights', () => {
      const fused = reciprocalRankFusion(
        [
          { source: 'semantic', ids: ['a'] },
          { source: 'symbol', ids: ['b'], weight: 3 },
        ],
        1,
      );

      expect(fused.map((result) => [result.id, result.score])).toEqual([
        ['b', 1.5],
        ['a', 0.5],
      ]);
    });

    it('keeps the best rank of an id repeated in a list', () => {
      const fused = reciprocalRankFusion([{ source: 'lexical', ids: ['a', 'b', 'a'] }], 1);

      expect(fused).toEqual([
        { id: 'a', score: 0.5, ranks: { lexical: 1 } },
        { id: 'b', score: 1 / 3, ranks: { lexical: 2 } },
      ]);
    });

    it('breaks score ties by number of sources then by id', () => {
      const fused = reciprocalRankFusion(
        [
          { source: 's1', ids: ['z', 'x'] },
          { source: 's2', ids: ['y'], weight: 0 },
          { source: 's3', ids: ['w'] },
        ],
        1,
      );

      expect(fused.map((result) => result.id)).toEqual(['w', 'z', 'x', 'y']);
      const tied = reciprocalRankFusion(
        [
          { source: 's1', ids: ['b'] },
          { source: 's2', ids: ['a'] },
          { source: 's3', ids: ['c'], weight: 1 },
          { source: 's4', ids: ['c'], weight: 0 },
        ],
        1,
      );
      expect(tied.map((result) => result.id)).toEqual(['c', 'a', 'b']);
    });

    it('returns nothing for empty input', () => {
      expect(reciprocalRankFusion([])).toEqual([]);
    });

    it.each([0, -1, Number.NaN])('rejects the invalid constant %s', (k) => {
      expect(() => reciprocalRankFusion([], k)).toThrow(`Invalid RRF constant ${k}.`);
    });

    it.each([-1, Number.NaN])('rejects the invalid weight %s', (weight) => {
      expect(() => reciprocalRankFusion([{ source: 's', ids: ['a'], weight }])).toThrow(
        `Invalid weight ${weight} for source "s".`,
      );
    });
  });
});
