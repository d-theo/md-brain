import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { ProjectConfig } from '../../src/config/project-config.js';
import { collectionNames } from '../../src/domain/collection.js';
import { type IndexOutcome, ProjectIndexer } from '../../src/ingestion/project-indexer.js';
import { QdrantVectorStore } from '../../src/storage/qdrant/qdrant-vector-store.js';
import { SqliteMetadataStore } from '../../src/storage/sqlite/sqlite-metadata-store.js';
import { FakeEmbeddingProvider } from './fake-embeddings.js';
import { uniqueProjectId } from './fixtures.js';
import { NotesFixture } from './notes-fixture.js';
import { aProjectConfig } from './project-config.js';

export const QDRANT_URL = process.env.MD_TEST_QDRANT_URL ?? 'http://localhost:6333';

/** A temporary notes project indexed with real SQLite + Qdrant and fake embeddings. */
export class E2eProject {
  readonly fixture: NotesFixture;
  readonly config: ProjectConfig;
  readonly embeddings = new FakeEmbeddingProvider();
  readonly client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
  readonly store: SqliteMetadataStore;
  readonly vectors: QdrantVectorStore;

  constructor() {
    this.fixture = new NotesFixture(mkdtempSync(join(tmpdir(), 'md-e2e-')));
    const id = uniqueProjectId('mde2e');
    const base = aProjectConfig(id, this.fixture.root, { maxFileBytes: 64 * 1024 });
    const embeddings = { ...base.embeddings, model: this.embeddings.model, dimensions: 64 };
    this.config = { ...base, embeddings, collection: collectionNames(id, embeddings) };
    this.store = SqliteMetadataStore.open(this.config.sqlitePath, id);
    this.vectors = new QdrantVectorStore(this.client, this.config.collection, 64);
  }

  index(): Promise<IndexOutcome> {
    return new ProjectIndexer({
      project: this.config,
      store: this.store,
      vectors: this.vectors,
      embeddings: this.embeddings,
    }).run();
  }

  async dispose(): Promise<void> {
    this.store.close();
    await this.vectors.drop();
    rmSync(this.fixture.root, { recursive: true, force: true });
  }
}
