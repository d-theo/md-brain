import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../../src/domain/project-id.js';
import { CachedEmbedder } from '../../../src/embeddings/cached-embedder.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { FakeEmbeddingProvider } from '../../support/fake-embeddings.js';

describe('CachedEmbedder', () => {
  let store: SqliteMetadataStore;
  let provider: FakeEmbeddingProvider;
  let embedder: CachedEmbedder;

  beforeEach(() => {
    store = SqliteMetadataStore.open(':memory:', toProjectId('cache-test'));
    provider = new FakeEmbeddingProvider(8);
    embedder = new CachedEmbedder(provider, store);
  });

  afterEach(() => {
    store.close();
  });

  describe('embedDocuments', () => {
    it('embeds each distinct text once and serves the rest from the cache', async () => {
      const first = await embedder.embedDocuments(['alpha text', 'beta text', 'alpha text']);
      const second = await embedder.embedDocuments(['beta text\r\n', 'gamma text']);

      expect(provider.documentCalls).toEqual([['alpha text', 'beta text'], ['gamma text']]);
      expect(first[0]).toEqual(first[2]);
      expect(second[0]).toEqual(first[1]?.map((value) => Math.fround(value)));
      expect(embedder.counters).toEqual({ requested: 5, cached: 2, computed: 3 });
      expect(embedder.model).toBe('fake-bow');
    });

    it('keeps caches of different models apart', async () => {
      await embedder.embedDocuments(['alpha text']);
      const other = Object.assign(new FakeEmbeddingProvider(8), { model: 'other-model' });

      await new CachedEmbedder(other, store).embedDocuments(['alpha text']);

      expect(other.documentCalls).toEqual([['alpha text']]);
    });

    it('fails if the provider returns fewer vectors than requested', async () => {
      const broken = Object.assign(new FakeEmbeddingProvider(8), {
        embedDocuments: async () => [],
      });

      await expect(new CachedEmbedder(broken, store).embedDocuments(['x'])).rejects.toThrow(
        'Cannot zip arrays of length 1 and 0.',
      );
    });
  });
});
