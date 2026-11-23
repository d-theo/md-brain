import type { ProjectConfig } from '../config/project-config.js';
import { zipStrict } from '../domain/collections.js';
import { describeError } from '../domain/errors.js';
import type { MetadataStore, VectorPoint, VectorStore } from '../domain/ports.js';
import type { FileRecord } from '../domain/records.js';
import { parentFolders } from '../domain/relative-path.js';
import type { CachedEmbedder } from '../embeddings/cached-embedder.js';
import { SIMILARITY_KINDS } from '../knowledge/similarity.js';
import type { Chunker, ParsedFile } from './chunking.js';
import type { FileProcessor, FileToIndex } from './sync.js';

/**
 * Chunks a note, embeds its chunks (through the cache) and stores them. Vectors are written
 * before metadata: if SQLite fails afterwards, the file is retried on the next run and the
 * vectors are overwritten (same stable ids).
 */
export class IndexingProcessor implements FileProcessor {
  readonly parseFailures: { path: string; reason: string }[] = [];

  constructor(
    private readonly project: ProjectConfig,
    private readonly chunker: Chunker,
    private readonly embedder: CachedEmbedder,
    private readonly store: MetadataStore,
    private readonly vectors: VectorStore,
  ) {}

  get version(): string {
    return this.chunker.version;
  }

  async process({ record, content }: FileToIndex): Promise<void> {
    const parsed = this.parse(record, content);
    const vectors = await this.embedder.embedDocuments(
      parsed.chunks.map((entry) => entry.embedText),
    );
    const folders = parentFolders(record.path);
    const points: VectorPoint[] = zipStrict(parsed.chunks, vectors).map(([entry, vector]) => ({
      id: entry.chunk.id,
      vector,
      payload: {
        fileId: record.id,
        path: record.path,
        folders,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        contentHash: entry.chunk.contentHash,
      },
    }));
    await this.vectors.deleteByFileIds([record.id]);
    await this.vectors.upsert(points);
    const chunks = parsed.chunks.map((entry) => entry.chunk);
    this.store.replaceFile(record, chunks, parsed.relations);
    this.store.markChunksEmbedded(
      chunks.map((chunk) => chunk.id),
      this.embedder.model,
    );
  }

  /** A note that cannot be parsed is still indexed as a file, without chunks. */
  private parse(record: FileRecord, content: string): ParsedFile {
    try {
      return this.chunker.chunk({ project: this.project.id, path: record.path, content });
    } catch (error) {
      this.parseFailures.push({ path: record.path, reason: describeError(error) });
      return { chunks: [], relations: [] };
    }
  }

  async remove(files: readonly FileRecord[]): Promise<void> {
    await this.vectors.deleteByFileIds(files.map((file) => file.id));
    for (const file of files) {
      const chunkIds = this.store.listChunks(file.id).map((chunk) => chunk.id);
      this.store.deleteRelationsAround(chunkIds, SIMILARITY_KINDS);
      this.store.deleteFile(file.id);
    }
  }
}
