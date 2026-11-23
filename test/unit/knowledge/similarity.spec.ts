import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../../src/domain/project-id.js';
import {
  duplicatesReport,
  formatDuplicatesReport,
} from '../../../src/knowledge/duplicates-report.js';
import { SimilarityLinker } from '../../../src/knowledge/similarity.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { aChunk, aFile, aPayload, aSimilarity } from '../../support/fixtures.js';
import { InMemoryVectorStore } from '../../support/in-memory-vector-store.js';

const project = toProjectId('similarity-test');
const LONG = 'word '.repeat(60);
const thresholds = { duplicateThreshold: 0.95, similarThreshold: 0.8 };

describe('similarity', () => {
  let store: SqliteMetadataStore;
  let vectors: InMemoryVectorStore;
  const files = ['a.md', 'b.md', 'c.md', 'd.md'].map((path) => aFile(project, { path }));

  async function addChunk(fileIndex: number, ordinal: number, text: string, vector: number[]) {
    const file = files[fileIndex] ?? files[0];
    if (file === undefined) {
      throw new Error('no file');
    }
    const chunk = aChunk(project, file, ordinal, text);
    const existing = store.listChunks(file.id).map((stored) => ({
      ...aChunk(project, file, stored.ordinal, `${LONG} ${stored.ordinal}`),
    }));
    store.replaceFile(file, [...existing, chunk]);
    await vectors.upsert([
      { id: chunk.id, vector, payload: aPayload({ fileId: file.id, path: file.path }) },
    ]);
    return chunk.id;
  }

  beforeEach(() => {
    store = SqliteMetadataStore.open(':memory:', project);
    vectors = new InMemoryVectorStore();
  });

  afterEach(() => {
    store.close();
  });

  describe('SimilarityLinker', () => {
    it('suggests duplicates and similar chunks of other notes, once per pair', async () => {
      const a = await addChunk(0, 0, `${LONG} a`, [1, 0, 0]);
      const b = await addChunk(1, 0, `${LONG} b`, [0.99, 0.05, 0]);
      const c = await addChunk(2, 0, `${LONG} c`, [0.85, 0.5, 0]);
      await addChunk(3, 0, 'tiny d', [1, 0, 0]);
      await addChunk(2, 1, 'tiny', [1, 0, 0]);

      const report = await new SimilarityLinker(store, vectors, thresholds).link(
        files.map((file) => file.id),
      );

      expect(report).toEqual({ compared: 3, duplicates: 1, similar: 2 });
      const relations = store.relationsAround([a], ['duplicate_of', 'similar_to']);
      const other = (relation: { srcId: string; dstId: string | null }) =>
        relation.srcId === a ? relation.dstId : relation.srcId;
      expect(relations.map((relation) => [relation.kind, other(relation)]).sort()).toEqual([
        ['duplicate_of', b],
        ['similar_to', c],
      ]);
      expect(
        relations.every(
          (relation) => relation.origin === 'suggested' && relation.method === 'embedding',
        ),
      ).toBe(true);
    });

    it('recomputes links of changed files and drops links pointing at them', async () => {
      const a = await addChunk(0, 0, `${LONG} a`, [1, 0, 0]);
      await addChunk(1, 0, `${LONG} b`, [1, 0, 0]);
      const linker = new SimilarityLinker(store, vectors, thresholds);
      await linker.link(files.map((file) => file.id));
      await vectors.upsert([
        { id: a, vector: [0, 0, 1], payload: aPayload({ fileId: files[0]?.id ?? '' }) },
      ]);

      await linker.link([files[0]?.id ?? '']);

      expect(store.relationsAround([a], ['duplicate_of', 'similar_to'])).toEqual([]);
    });

    it('relinks every file when the thresholds change', async () => {
      await addChunk(0, 0, `${LONG} a`, [1, 0, 0]);
      await addChunk(1, 0, `${LONG} b`, [0.9, 0.3, 0]);

      const first = await new SimilarityLinker(store, vectors, thresholds).linkChanged([]);
      const unchanged = await new SimilarityLinker(store, vectors, thresholds).linkChanged([]);
      const stricter = await new SimilarityLinker(store, vectors, {
        duplicateThreshold: 0.99,
        similarThreshold: 0.98,
      }).linkChanged([]);

      expect(first.compared).toBe(2);
      expect(unchanged.compared).toBe(0);
      expect(stricter).toEqual({ compared: 2, duplicates: 0, similar: 0 });
    });
  });

  describe('duplicatesReport', () => {
    it('lists exact duplicate groups and suggested pairs with their locations', async () => {
      await addChunk(0, 0, `${LONG} same`, [1, 0, 0]);
      await addChunk(1, 0, `${LONG} same`, [1, 0, 0]);
      await new SimilarityLinker(store, vectors, thresholds).link(files.map((file) => file.id));

      const report = duplicatesReport(store, ['duplicate_of'], 10);
      const lines = formatDuplicatesReport(report);

      expect(report.exactGroups).toHaveLength(1);
      expect(report.exactGroups[0]?.map((location) => location.location)).toEqual([
        'a.md:L1-L9',
        'b.md:L1-L9',
      ]);
      expect(report.suggested[0]).toMatchObject({ kind: 'duplicate_of', score: 1 });
      expect(lines[0]).toBe('Exact duplicates:');
      expect(lines).toContain('  1. 2 copies');
      expect(lines).toContain('  1. duplicate_of 1.000');
    });

    it('shows untitled chunks and skips links whose target disappeared', async () => {
      const loose = aFile(project, { path: 'inbox/untitled.md' });
      const kept = { ...aChunk(project, loose, 0, `${LONG} same`), headingPath: null };
      store.replaceFile(loose, [kept]);
      await vectors.upsert([
        { id: kept.id, vector: [1, 0, 0], payload: aPayload({ fileId: loose.id }) },
      ]);
      await addChunk(0, 0, `${LONG} same`, [1, 0, 0]);
      const gone = await addChunk(1, 0, `${LONG} gone`, [1, 0, 0]);
      await new SimilarityLinker(store, vectors, thresholds).link([
        loose.id,
        files[0]?.id ?? '',
        files[1]?.id ?? '',
      ]);
      store.deleteFile(files[1]?.id ?? '');

      const report = duplicatesReport(store, ['duplicate_of'], 10);
      const lines = formatDuplicatesReport(report);

      expect(report.exactGroups[0]?.map((location) => location.location)).toContain(
        'inbox/untitled.md:L1-L9',
      );
      expect(
        report.suggested.some(
          (pair) => pair.target.chunkId === gone || pair.source.chunkId === gone,
        ),
      ).toBe(false);
      expect(lines).toContain('     inbox/untitled.md:L1-L9');
    });

    it('renders untitled suggested pairs and a missing score as 0', () => {
      const [a, b] = files;
      if (a === undefined || b === undefined) {
        throw new Error('missing files');
      }
      const ca = { ...aChunk(project, a, 0, `${LONG} a`), headingPath: null };
      const cb = { ...aChunk(project, b, 0, `${LONG} b`), headingPath: null };
      store.replaceFile(a, [ca]);
      store.replaceFile(b, [cb]);
      store.insertRelations(a.id, [{ ...aSimilarity(ca.id, cb.id, 0.9), score: null }]);

      const lines = formatDuplicatesReport(duplicatesReport(store, ['similar_to'], 10));

      expect(lines.slice(-3)).toEqual([
        '  1. similar_to 0.000',
        '     a.md:L1-L9',
        '     b.md:L1-L9',
      ]);
    });

    it('reports when there is nothing to review', () => {
      expect(formatDuplicatesReport(duplicatesReport(store, ['similar_to'], 10))).toEqual([
        'Exact duplicates:',
        '  none',
        'Suggested (embeddings):',
        '  none',
      ]);
    });
  });
});
