import { describe, expect, it } from 'vitest';
import { chunkId, fileId, KB_UUID_NAMESPACE, uuidV5 } from '../../../src/domain/ids.js';
import { toProjectId } from '../../../src/domain/project-id.js';

const file = {
  project: toProjectId('notes'),
  path: 'work/kb/architecture.md',
};

describe('ids', () => {
  describe('uuidV5', () => {
    it('matches the RFC 4122 reference value', () => {
      const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

      expect(uuidV5('www.example.com', dnsNamespace)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    });

    it('sets the version 5 and RFC variant bits', () => {
      expect(uuidV5('anything', KB_UUID_NAMESPACE)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('rejects an invalid namespace', () => {
      expect(() => uuidV5('name', 'not-a-uuid')).toThrow('Invalid UUID namespace "not-a-uuid".');
    });
  });

  describe('fileId', () => {
    it('is deterministic', () => {
      expect(fileId(file)).toBe(fileId({ ...file }));
      expect(fileId(file)).toMatch(/^[0-9a-f]{40}$/);
    });

    it('differs per project and path', () => {
      const ids = new Set([
        fileId(file),
        fileId({ ...file, project: toProjectId('journal') }),
        fileId({ ...file, path: 'work/kb/embeddings.md' }),
      ]);

      expect(ids.size).toBe(3);
    });
  });

  describe('chunkId', () => {
    it('is a stable UUID for the same anchor and ordinal', () => {
      const first = chunkId(file, 'Architecture > Storage', 0);

      expect(chunkId({ ...file }, 'Architecture > Storage', 0)).toBe(first);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('changes with the anchor or the ordinal', () => {
      const ids = new Set([
        chunkId(file, 'A', 0),
        chunkId(file, 'A', 1),
        chunkId(file, 'B', 0),
        chunkId({ ...file, project: toProjectId('journal') }, 'A', 0),
      ]);

      expect(ids.size).toBe(4);
    });

    it.each([-1, 1.5, Number.NaN])('rejects the invalid ordinal %s', (ordinal) => {
      expect(() => chunkId(file, 'A', ordinal)).toThrow(`Invalid chunk ordinal ${ordinal}.`);
    });
  });
});
