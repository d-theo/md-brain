import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingModelMismatchError } from '../../../src/domain/errors.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import {
  ProjectMismatchError,
  SchemaVersionError,
  StorageError,
} from '../../../src/storage/errors.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { aChunk, aFile, aLink, aSimilarity } from '../../support/fixtures.js';

const projectA = toProjectId('project-a');
const projectB = toProjectId('project-b');

describe('SqliteMetadataStore', () => {
  let dir: string;
  let stores: SqliteMetadataStore[];

  function open(
    project = projectA,
    file = 'a/md.sqlite',
    options: Parameters<typeof SqliteMetadataStore.open>[2] = {},
  ): SqliteMetadataStore {
    const store = SqliteMetadataStore.open(join(dir, file), project, options);
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-sqlite-'));
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) {
      store.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe('open', () => {
    it('creates the database, migrates it and is idempotent', () => {
      open().close();
      const store = open();

      expect(store.listFiles()).toEqual([]);
    });

    it('refuses a database that belongs to another project', () => {
      open(projectA).close();

      expect(() => open(projectB)).toThrow(ProjectMismatchError);
    });

    it('refuses to open a missing schema read-only', () => {
      new DatabaseSync(join(dir, 'empty.sqlite')).close();

      expect(() => open(projectA, 'empty.sqlite', { readOnly: true })).toThrow(SchemaVersionError);
    });

    it('refuses a read-only database without project id', () => {
      const path = join(dir, 'a/md.sqlite');
      open().close();
      const raw = new DatabaseSync(path);
      raw.exec("DELETE FROM meta WHERE key = 'project_id'");
      raw.close();

      expect(() => open(projectA, 'a/md.sqlite', { readOnly: true })).toThrow('has no project id');
    });

    it('refuses a schema newer than the build', () => {
      const path = join(dir, 'a/md.sqlite');
      open().close();
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA user_version = 999');
      raw.close();

      expect(() => open()).toThrow('is newer than this build');
    });

    it('opens read-only connections that cannot write', () => {
      open().close();
      const reader = open(projectA, 'a/md.sqlite', { readOnly: true });

      expect(reader.listFiles()).toEqual([]);
      expect(() => reader.setMeta('k', 'v')).toThrow();
    });
  });

  describe('isolation', () => {
    it('keeps the data of two projects apart', () => {
      const a = open(projectA, 'a/md.sqlite');
      const b = open(projectB, 'b/md.sqlite');
      const file = aFile(projectA);
      a.replaceFile(file, [aChunk(projectA, file, 0, 'toxicity detection pipeline')]);

      expect(b.listFiles()).toEqual([]);
      expect(b.countLexicalMatches('toxicity')).toBe(0);
      expect(a.countLexicalMatches('toxicity')).toBe(1);
    });
  });

  describe('bindEmbeddingModel', () => {
    it('accepts the same model again and refuses another one', () => {
      const store = open();
      store.bindEmbeddingModel({ model: 'qwen3-embedding:0.6b', dimensions: 1024 });
      store.bindEmbeddingModel({ model: 'qwen3-embedding:0.6b', dimensions: 1024 });

      expect(() =>
        store.bindEmbeddingModel({ model: 'qwen3-embedding:4b', dimensions: 1024 }),
      ).toThrow(EmbeddingModelMismatchError);
      expect(() =>
        store.bindEmbeddingModel({ model: 'qwen3-embedding:0.6b', dimensions: 512 }),
      ).toThrow(EmbeddingModelMismatchError);
    });
  });

  describe('files and chunks', () => {
    it('stores a file with its chunks and lexical entries', () => {
      const store = open();
      const file = aFile(projectA, { path: 'work/flow.md', lastRunId: 3 });
      const chunks = [
        aChunk(projectA, file, 0, 'Le lambda appelle Détox pour chaque message'),
        aChunk(projectA, file, 1, 'Prioritization queue stored in Valkey'),
      ];

      store.replaceFile(file, chunks);

      expect(store.getFile(file.path)).toEqual(file);
      expect(store.getFileById(file.id)).toEqual(file);
      expect(store.listFiles()).toEqual([file]);
      expect(store.listFileIds()).toEqual([file.id]);
      expect(store.listChunks(file.id)).toEqual(
        chunks.map(({ text: _text, title: _title, ...chunk }) => ({
          ...chunk,
          fileId: file.id,
          embeddedModel: null,
        })),
      );
      expect(store.countLexicalMatches('detox')).toBe(1);
      expect(store.countLexicalMatches('valkey')).toBe(1);
      expect(store.countLexicalMatches('path:flow')).toBe(2);
    });

    it('replaces previous chunks and lexical entries of a file', () => {
      const store = open();
      const file = aFile(projectA);
      store.replaceFile(file, [aChunk(projectA, file, 0, 'old allowlist text')]);

      store.replaceFile({ ...file, contentHash: 'e'.repeat(64) }, [
        aChunk(projectA, file, 0, 'new blocklist text'),
      ]);

      expect(store.countLexicalMatches('allowlist')).toBe(0);
      expect(store.countLexicalMatches('blocklist')).toBe(1);
      expect(store.listChunks(file.id)).toHaveLength(1);
    });

    it('keeps lexical search working after compaction', () => {
      const store = open();
      const file = aFile(projectA);
      store.replaceFile(file, [aChunk(projectA, file, 0, 'first version')]);
      store.replaceFile(file, [aChunk(projectA, file, 0, 'second version')]);

      store.optimize();

      expect(store.countLexicalMatches('first')).toBe(0);
      expect(store.countLexicalMatches('second')).toBe(1);
    });

    it('deletes chunks and lexical entries in cascade', () => {
      const store = open();
      const file = aFile(projectA);
      store.replaceFile(file, [aChunk(projectA, file, 0, 'shorttext detection')]);

      store.deleteFile(file.id);

      expect(store.getFile(file.path)).toBeUndefined();
      expect(store.getFileById(file.id)).toBeUndefined();
      expect(store.listChunks(file.id)).toEqual([]);
      expect(store.countLexicalMatches('shorttext')).toBe(0);
    });

    it('rejects duplicate chunk ids and leaves the previous state untouched', () => {
      const store = open();
      const file = aFile(projectA);
      const chunk = aChunk(projectA, file, 0, 'kept');
      store.replaceFile(file, [chunk]);

      expect(() => store.replaceFile(file, [chunk, chunk])).toThrow(StorageError);
      expect(store.countLexicalMatches('kept')).toBe(1);
    });

    it('rolls back a failed replacement', () => {
      const store = open();
      const file = aFile(projectA);
      const other = aFile(projectA, { path: 'work/other.md' });
      const taken = aChunk(projectA, other, 0, 'other note');
      store.replaceFile(file, [aChunk(projectA, file, 0, 'kept')]);
      store.replaceFile(other, [taken]);

      expect(() => store.replaceFile(file, [{ ...taken, text: 'lost' }])).toThrow();
      expect(store.countLexicalMatches('kept')).toBe(1);
      expect(store.countLexicalMatches('lost')).toBe(0);
    });

    it('touches the metadata of an unchanged file and keeps its chunks', () => {
      const store = open();
      const file = aFile(projectA);
      store.replaceFile(file, [aChunk(projectA, file, 0, 'kept chunk')]);
      const touched = { ...file, mtimeMs: file.mtimeMs + 1, lastRunId: 2, pipelineVersion: 'v2' };

      store.touchFile(touched);

      expect(store.getFile(file.path)).toEqual(touched);
      expect(store.listChunks(file.id)).toHaveLength(1);
      expect(() => store.touchFile({ ...touched, contentHash: 'other' })).toThrow(
        'unknown file or content',
      );
    });

    it('marks chunks as embedded', () => {
      const store = open();
      const file = aFile(projectA);
      const chunks = [aChunk(projectA, file, 0, 'a'), aChunk(projectA, file, 1, 'b')];
      store.replaceFile(file, chunks);

      store.markChunksEmbedded([chunks[0]?.id ?? ''], 'qwen3-embedding:0.6b');

      expect(store.listChunks(file.id).map((chunk) => chunk.embeddedModel)).toEqual([
        'qwen3-embedding:0.6b',
        null,
      ]);
    });
  });

  describe('paths and lexical search', () => {
    it('finds notes by path or unambiguous suffix, escaping LIKE wildcards', () => {
      const store = open();
      for (const path of ['work/kb.md', 'journal/kb.md', 'work/a_b.md', 'work/axb.md']) {
        store.replaceFile(aFile(projectA, { path }), []);
      }

      expect(store.findFilesByPath('work/kb.md').map((file) => file.path)).toEqual(['work/kb.md']);
      expect(store.findFilesByPath('kb.md').map((file) => file.path)).toEqual([
        'journal/kb.md',
        'work/kb.md',
      ]);
      expect(store.findFilesByPath('a_b.md').map((file) => file.path)).toEqual(['work/a_b.md']);
      expect(store.findFilesByPath('b.md')).toEqual([]);
    });

    it('filters lexical hits by folder (subfolders included) and by file', () => {
      const store = open();
      const notes = ['work/kb.md', 'work/kb/deep.md', 'work_old/kb.md', 'journal/kb.md'].map(
        (path) => aFile(projectA, { path }),
      );
      for (const note of notes) {
        store.replaceFile(note, [aChunk(projectA, note, 0, 'qdrant vectors')]);
      }
      const pathsOf = (filter: Parameters<typeof store.searchLexical>[1]) =>
        store
          .searchLexical('"qdrant"', filter, 10)
          .map((hit) => store.getChunkContexts([hit.chunkId]).get(hit.chunkId)?.file.path)
          .sort();

      expect(pathsOf({})).toHaveLength(4);
      expect(pathsOf({ folders: ['work'] })).toEqual(['work/kb.md', 'work/kb/deep.md']);
      expect(pathsOf({ folders: ['work/kb', 'journal'] })).toEqual([
        'journal/kb.md',
        'work/kb/deep.md',
      ]);
      expect(pathsOf({ folders: [] })).toEqual([]);
      expect(pathsOf({ fileIds: [notes[0]?.id ?? ''] })).toEqual(['work/kb.md']);
      expect(pathsOf({ fileIds: [] })).toEqual([]);
      expect(pathsOf({ excludeFileIds: [notes[0]?.id ?? ''] })).toHaveLength(3);
    });
  });

  describe('relations', () => {
    it('stores links with their file and finds them from both ends', () => {
      const store = open();
      const file = aFile(projectA, { path: 'work/kb.md' });
      const chunk = aChunk(projectA, file, 0, 'see the journal');

      store.replaceFile(file, [chunk], [aLink(chunk.id, 'journal/2026.md', 3)]);

      const expected = { ...aLink(chunk.id, 'journal/2026.md', 3), fileId: file.id };
      expect(store.relationsFrom([chunk.id])).toEqual([expected]);
      expect(store.relationsFrom([chunk.id], ['similar_to'])).toEqual([]);
      expect(store.relationsTo(['journal/2026.md'], ['md_link'])).toEqual([expected]);
      expect(store.relationsOfKind(['md_link'])).toEqual([expected]);

      store.deleteFile(file.id);

      expect(store.relationsOfKind(['md_link'])).toEqual([]);
    });

    it('manages suggested links between chunks', () => {
      const store = open();
      const [a, b, c] = ['a.md', 'b.md', 'c.md'].map((path) => aFile(projectA, { path }));
      if (a === undefined || b === undefined || c === undefined) {
        throw new Error('missing files');
      }
      const [ca, cb, cc] = [a, b, c].map((file) => aChunk(projectA, file, 0, `text ${file.path}`));
      if (ca === undefined || cb === undefined || cc === undefined) {
        throw new Error('missing chunks');
      }
      store.replaceFile(a, [ca]);
      store.replaceFile(b, [cb]);
      store.replaceFile(c, [cc]);
      store.insertRelations(a.id, [
        aSimilarity(ca.id, cb.id, 0.97, 'duplicate_of'),
        aSimilarity(ca.id, cc.id, 0.9),
      ]);
      store.insertRelations(c.id, [aSimilarity(cc.id, cb.id, 0.86)]);

      expect(store.relationsAround([cb.id], ['duplicate_of', 'similar_to'])).toHaveLength(2);
      expect(
        store.topSuggestedRelations(['similar_to'], 1).map((relation) => relation.score),
      ).toEqual([0.9]);
      expect(store.listSimilarityCandidates([a.id, b.id])).toEqual([
        { chunkId: ca.id, fileId: a.id, tokenCount: ca.tokenCount },
        { chunkId: cb.id, fileId: b.id, tokenCount: cb.tokenCount },
      ]);

      store.deleteRelationsAround([ca.id], ['duplicate_of']);

      expect(store.relationsOfKind(['duplicate_of'])).toEqual([]);
      expect(store.relationsOfKind(['similar_to'])).toHaveLength(2);

      store.deleteRelationsAround([cb.id], ['similar_to']);

      expect(store.relationsOfKind(['similar_to']).map((relation) => relation.dstId)).toEqual([
        cc.id,
      ]);
    });

    it('groups identical chunks of several notes, largest groups first', () => {
      const store = open();
      const text = 'the same long paragraph copied in several notes';
      const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((path) =>
        aFile(projectA, { path }),
      );
      files.forEach((file, index) => {
        store.replaceFile(file, [aChunk(projectA, file, 0, index < 3 ? text : `${text} v2`)]);
      });

      const groups = store.duplicateGroups(10, 5);

      expect(groups.map((group) => group.length)).toEqual([3, 2]);
      expect(store.duplicateGroups(10, 1_000)).toEqual([]);
    });

    it('returns the latest succeeded run only', () => {
      const store = open();
      const first = store.startRun();
      store.finishRun(first, 'succeeded', {});
      store.finishRun(store.startRun(), 'failed', {});

      expect(store.latestRun()?.id).toBe(first);
    });
  });

  describe('embedding cache', () => {
    it('stores vectors per model and content hash', () => {
      const store = open();
      store.putCachedEmbeddings('m1', new Map([['h1', [0.5, 0.25]]]));
      store.putCachedEmbeddings(
        'm1',
        new Map([
          ['h1', [1, 2]],
          ['h2', [3, 4]],
        ]),
      );

      expect(store.getCachedEmbeddings('m1', ['h1', 'h2', 'h3', 'h1'])).toEqual(
        new Map([
          ['h1', [1, 2]],
          ['h2', [3, 4]],
        ]),
      );
      expect(store.getCachedEmbeddings('m2', ['h1']).size).toBe(0);
    });

    it('handles more hashes than one SQL batch', () => {
      const store = open();
      const vectors = new Map(Array.from({ length: 1_200 }, (_, index) => [`h${index}`, [index]]));
      store.putCachedEmbeddings('m', vectors);

      expect(store.getCachedEmbeddings('m', [...vectors.keys()]).size).toBe(1_200);
    });
  });

  describe('index runs', () => {
    it('records a run with its stats', () => {
      const clock = [new Date('2026-11-23T10:00:00Z'), new Date('2026-11-23T10:05:00Z')];
      const store = open(projectA, 'a/md.sqlite', { now: () => clock.shift() ?? new Date(0) });

      const runId = store.startRun();
      store.finishRun(runId, 'succeeded', { files: 3 });

      expect(store.getRun(runId)).toEqual({
        id: runId,
        startedAt: '2026-11-23T10:00:00.000Z',
        finishedAt: '2026-11-23T10:05:00.000Z',
        status: 'succeeded',
        stats: { files: 3 },
      });
      expect(store.getRun(runId + 1)).toBeUndefined();
    });

    it('refuses to finish an unknown run', () => {
      expect(() => open().finishRun(42, 'failed', {})).toThrow('Unknown index run 42.');
    });

    it.each([
      ['[]', 'Invalid index run stats.'],
      ['{"files":"3"}', 'Invalid index run stat "files".'],
    ])('rejects corrupted stats %s', (json, message) => {
      const store = open();
      const runId = store.startRun();
      store.close();
      const raw = new DatabaseSync(join(dir, 'a/md.sqlite'));
      raw.prepare('UPDATE index_run SET stats_json = ? WHERE id = ?').run(json, runId);
      raw.close();

      expect(() => open().getRun(runId)).toThrow(message);
    });
  });
});
