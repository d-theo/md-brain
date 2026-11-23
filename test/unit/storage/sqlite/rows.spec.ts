import { describe, expect, it } from 'vitest';
import { StorageError } from '../../../../src/storage/errors.js';
import {
  blob,
  bool,
  decodeVector,
  encodeVector,
  int,
  intOrNull,
  oneOf,
  text,
  textOrNull,
} from '../../../../src/storage/sqlite/rows.js';

const row = {
  name: 'core',
  missing: null,
  count: 3,
  big: 7n,
  huge: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  ratio: 1.5,
  flag: 1,
  bytes: new Uint8Array([1, 2]),
};

describe('rows', () => {
  describe('text / textOrNull', () => {
    it('reads text columns', () => {
      expect(text(row, 'name')).toBe('core');
      expect(textOrNull(row, 'name')).toBe('core');
      expect(textOrNull(row, 'missing')).toBeNull();
    });

    it('rejects other types', () => {
      expect(() => text(row, 'count')).toThrow(StorageError);
      expect(() => text(row, 'absent')).toThrow('Column "absent": expected text, got undefined.');
    });
  });

  describe('int / intOrNull / bool', () => {
    it('reads integers stored as number or bigint', () => {
      expect(int(row, 'count')).toBe(3);
      expect(int(row, 'big')).toBe(7);
      expect(intOrNull(row, 'missing')).toBeNull();
      expect(intOrNull(row, 'count')).toBe(3);
      expect(bool(row, 'flag')).toBe(true);
      expect(bool({ flag: 0 }, 'flag')).toBe(false);
    });

    it.each(['ratio', 'huge', 'name'])('rejects the non-integer column %s', (column) => {
      expect(() => int(row, column)).toThrow(`Column "${column}": expected integer`);
    });
  });

  describe('blob', () => {
    it('reads blobs and rejects other types', () => {
      expect(blob(row, 'bytes')).toEqual(new Uint8Array([1, 2]));
      expect(() => blob(row, 'name')).toThrow('expected blob');
    });
  });

  describe('oneOf', () => {
    it('narrows to allowed literals', () => {
      expect(oneOf(row, 'name', ['core', 'shorttext'])).toBe('core');
      expect(() => oneOf(row, 'name', ['shorttext'])).toThrow('expected one of shorttext');
    });
  });

  describe('encodeVector / decodeVector', () => {
    it('round-trips float32 vectors', () => {
      expect(decodeVector(encodeVector([0.5, -1, 2]))).toEqual([0.5, -1, 2]);
    });

    it('decodes from an unaligned view', () => {
      const encoded = encodeVector([0.25, 4]);
      const padded = new Uint8Array(encoded.byteLength + 1);
      padded.set(encoded, 1);

      expect(decodeVector(padded.subarray(1))).toEqual([0.25, 4]);
    });

    it('rejects truncated blobs', () => {
      expect(() => decodeVector(new Uint8Array(3))).toThrow('Invalid vector blob of 3 bytes.');
    });
  });
});
