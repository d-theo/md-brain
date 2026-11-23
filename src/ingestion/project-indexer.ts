import type { ProjectConfig } from '../config/project-config.js';
import type { EmbeddingProvider, MetadataStore, VectorStore } from '../domain/ports.js';
import { CachedEmbedder, type EmbedStats } from '../embeddings/cached-embedder.js';
import { SimilarityLinker, type SimilarityReport } from '../knowledge/similarity.js';
import { type Chunker, MarkdownChunker } from './chunking.js';
import { ProjectDiscovery } from './discovery.js';
import { IndexingProcessor } from './indexing-processor.js';
import { type FileReader, IndexSync, type SyncReport } from './sync.js';

export interface IndexOutcome {
  readonly report: SyncReport;
  readonly embeddings: EmbedStats;
  readonly similarity: SimilarityReport;
  readonly parseFailures: readonly { path: string; reason: string }[];
}

export interface ProjectIndexerDependencies {
  readonly project: ProjectConfig;
  readonly store: MetadataStore;
  readonly vectors: VectorStore;
  readonly embeddings: EmbeddingProvider;
  readonly readFile?: FileReader;
  readonly chunker?: Chunker;
}

/** Incremental indexing of ONE project; the project alias is switched only after success. */
export class ProjectIndexer {
  constructor(private readonly deps: ProjectIndexerDependencies) {}

  async run(): Promise<IndexOutcome> {
    const { project, store, vectors, embeddings } = this.deps;
    store.bindEmbeddingModel(embeddings);
    await vectors.ensureCollection();
    const embedder = new CachedEmbedder(embeddings, store);
    const processor = new IndexingProcessor(
      project,
      this.deps.chunker ?? new MarkdownChunker(),
      embedder,
      store,
      vectors,
    );
    const sync = new IndexSync(
      project,
      store,
      new ProjectDiscovery(project),
      processor,
      this.deps.readFile,
    );
    const report = await sync.run();
    const similarity = await new SimilarityLinker(store, vectors, project.knowledge).linkChanged(
      report.processedFileIds,
    );
    store.optimize();
    await vectors.activateAlias();
    return {
      report,
      embeddings: embedder.counters,
      similarity,
      parseFailures: processor.parseFailures,
    };
  }
}
