import { rmSync } from 'node:fs';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Ollama } from 'ollama';
import type { ProjectConfig } from '../src/config/project-config.js';
import type { EmbeddingProvider, VectorStore } from '../src/domain/ports.js';
import { OllamaEmbeddingProvider } from '../src/embeddings/ollama-embedding-provider.js';
import { QdrantVectorStore } from '../src/storage/qdrant/qdrant-vector-store.js';
import { SqliteMetadataStore } from '../src/storage/sqlite/sqlite-metadata-store.js';

/** Adapters of one project. Composition root of the CLI and of the MCP server. */
export interface ProjectRuntime {
  readonly store: SqliteMetadataStore;
  readonly vectors: VectorStore;
  readonly embeddings: EmbeddingProvider;
  close(): void;
}

export interface RuntimeOptions {
  readonly readOnly?: boolean;
}

export type RuntimeFactory = (project: ProjectConfig, options?: RuntimeOptions) => ProjectRuntime;

export const createRuntime: RuntimeFactory = (project, options = {}) => {
  const store = SqliteMetadataStore.open(project.sqlitePath, project.id, {
    readOnly: options.readOnly ?? false,
  });
  const qdrant = new QdrantClient({ url: project.qdrant.url, checkCompatibility: false });
  return {
    store,
    vectors: new QdrantVectorStore(qdrant, project.collection, project.embeddings.dimensions),
    embeddings: new OllamaEmbeddingProvider(
      new Ollama({ host: project.embeddings.host }),
      project.embeddings,
    ),
    close: () => store.close(),
  };
};

/** Forgets everything indexed for the project with the configured model (`--rebuild`). */
export async function resetProject(project: ProjectConfig): Promise<void> {
  const qdrant = new QdrantClient({ url: project.qdrant.url, checkCompatibility: false });
  await new QdrantVectorStore(qdrant, project.collection, project.embeddings.dimensions).drop();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${project.sqlitePath}${suffix}`, { force: true });
  }
}
