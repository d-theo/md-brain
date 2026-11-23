import { describe, expect, it } from 'vitest';
import { getOrThrow, lastPart, zipStrict } from '../../../src/domain/collections.js';

describe('collections', () => {
  describe('zipStrict', () => {
    it('pairs arrays of the same length', () => {
      expect(zipStrict(['a', 'b'], [1, 2])).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      expect(zipStrict([], [])).toEqual([]);
    });

    it.each([
      [['a', 'b'], [1]],
      [['a'], [1, 2]],
    ])('rejects %j and %j', (left, right) => {
      expect(() => zipStrict(left, right)).toThrow(RangeError);
    });
  });

  describe('getOrThrow', () => {
    it('returns present values and fails on missing keys', () => {
      const map = new Map([['a', 1]]);

      expect(getOrThrow(map, 'a', 'value')).toBe(1);
      expect(() => getOrThrow(map, 'b', 'value')).toThrow('Missing value for b.');
    });
  });

  describe('lastPart', () => {
    it.each([
      ['a/b/c.ts', '/', 'c.ts'],
      ['c.ts', '/', 'c.ts'],
      ['Foo.bar', '.', 'bar'],
    ])('returns the last part of %s', (value, separator, expected) => {
      expect(lastPart(value, separator)).toBe(expected);
    });
  });
});
