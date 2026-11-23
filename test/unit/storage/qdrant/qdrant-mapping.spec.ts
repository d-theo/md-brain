import { describe, expect, it } from 'vitest';
import {
  fromQdrantPayload,
  PAYLOAD_INDEXES,
  toQdrantFilter,
  toQdrantPayload,
} from '../../../../src/storage/qdrant/qdrant-mapping.js';
import { aPayload } from '../../../support/fixtures.js';

describe('qdrant-mapping', () => {
  describe('toQdrantPayload / fromQdrantPayload', () => {
    it('round-trips the payload', () => {
      const payload = aPayload();

      expect(fromQdrantPayload(toQdrantPayload(payload))).toEqual(payload);
    });

    it('uses snake_case keys covering every payload index', () => {
      const stored = toQdrantPayload(aPayload());

      for (const index of PAYLOAD_INDEXES) {
        expect(stored).toHaveProperty(index.field);
      }
    });

    it('rejects a payload that does not match the schema', () => {
      expect(() =>
        fromQdrantPayload({ ...toQdrantPayload(aPayload()), folders: 'work' }),
      ).toThrow();
      expect(() => fromQdrantPayload(null)).toThrow();
    });
  });

  describe('toQdrantFilter', () => {
    it('matches everything without criteria', () => {
      expect(toQdrantFilter({})).toEqual({ must: [] });
    });

    it('maps folders and files to keyword matches', () => {
      expect(toQdrantFilter({ folders: ['work', 'journal'], fileIds: ['f'] })).toEqual({
        must: [
          { key: 'folders', match: { any: ['work', 'journal'] } },
          { key: 'file_id', match: { any: ['f'] } },
        ],
      });
    });

    it('keeps empty lists so that they match nothing', () => {
      expect(toQdrantFilter({ folders: [] })).toEqual({
        must: [{ key: 'folders', match: { any: [] } }],
      });
    });

    it('excludes files with a must_not condition', () => {
      expect(toQdrantFilter({ excludeFileIds: ['f'] })).toEqual({
        must: [],
        must_not: [{ key: 'file_id', match: { any: ['f'] } }],
      });
    });
  });
});
