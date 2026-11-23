import { describe, expect, it } from 'vitest';
import { toProjectId } from '../../../src/domain/project-id.js';
import {
  KnowledgeService,
  NotFoundError,
  resolveLinkTarget,
} from '../../../src/retrieval/knowledge-service.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { FakeEmbeddingProvider } from '../../support/fake-embeddings.js';
import { aFile } from '../../support/fixtures.js';
import { InMemoryVectorStore } from '../../support/in-memory-vector-store.js';
import { aProjectConfig } from '../../support/project-config.js';

describe('KnowledgeService', () => {
  describe('resolveLinkTarget', () => {
    const notes = new Set(['work/kb.md', 'journal/2026.markdown', 'README.md']);

    it.each([
      ['work/kb.md', 'work/kb.md'],
      ['work/kb', 'work/kb.md'],
      ['journal/2026', 'journal/2026.markdown'],
      ['work/missing', null],
      ['work', null],
    ])('resolves %s to %s', (target, expected) => {
      expect(resolveLinkTarget(target, notes)).toBe(expected);
    });
  });

  describe('getOverview', () => {
    it('describes a project that was never indexed', () => {
      const project = toProjectId('empty-project');
      const store = SqliteMetadataStore.open(':memory:', project);
      const service = new KnowledgeService(
        aProjectConfig(project, '/tmp/empty'),
        store,
        new InMemoryVectorStore(),
        new FakeEmbeddingProvider(8),
      );

      expect(service.getOverview()).toMatchObject({
        index: { lastRun: null },
        notes: 0,
        folders: {},
        mostLinked: [],
        brokenLinks: 0,
      });
      store.close();
    });
  });

  describe('getNote', () => {
    it('rejects a path suffix shared by several notes, listing them', () => {
      const project = toProjectId('ambiguous-project');
      const store = SqliteMetadataStore.open(':memory:', project);
      for (const path of ['work/kb.md', 'journal/kb.md']) {
        store.replaceFile(aFile(project, { path }), []);
      }
      const service = new KnowledgeService(
        aProjectConfig(project, '/tmp/ambiguous'),
        store,
        new InMemoryVectorStore(),
        new FakeEmbeddingProvider(8),
      );

      expect(() => service.getNote('kb.md')).toThrow(NotFoundError);
      expect(() => service.getNote('./kb.md')).toThrow(
        '"./kb.md" is ambiguous: journal/kb.md, work/kb.md.',
      );
      store.close();
    });
  });
});
