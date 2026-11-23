import type { EmbeddingModelRef } from './collection.js';
import type { RelationKind } from './model.js';
import type {
  ChunkInput,
  ChunkRecord,
  FileRecord,
  IndexRunRecord,
  IndexRunStatus,
  RelationInput,
  RelationRecord,
} from './records.js';

/** Metadata stored next to each vector, enough to filter and to cite the source. */
export interface ChunkPayload {
  readonly fileId: string;
  readonly path: string;
  /** Every folder containing the note (`a`, `a/b` for `a/b/note.md`): folder filters. */
  readonly folders: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
}

export interface VectorPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: ChunkPayload;
}

/** Filters shared by every retriever. */
export interface SearchFilter {
  /** Notes inside any of these folders (relative to the project root, subfolders included). */
  readonly folders?: readonly string[];
  readonly fileIds?: readonly string[];
  readonly excludeFileIds?: readonly string[];
}

export interface VectorHit {
  readonly id: string;
  readonly score: number;
  readonly payload: ChunkPayload;
}

export interface LexicalHit {
  readonly chunkId: string;
  /** bm25 score, higher is better. */
  readonly score: number;
}

export interface SimilarityCandidate {
  readonly chunkId: string;
  readonly fileId: string;
  readonly tokenCount: number;
}

/** A chunk with the note it comes from. */
export interface ChunkContext {
  readonly chunk: ChunkRecord;
  readonly file: FileRecord;
}

export interface VectorStore {
  /** Creates the project/model collection and its payload indexes if missing. */
  ensureCollection(): Promise<void>;
  /** Points the project alias at this store's collection (atomic switch). */
  activateAlias(): Promise<void>;
  upsert(points: readonly VectorPoint[]): Promise<void>;
  deleteByFileIds(fileIds: readonly string[]): Promise<void>;
  search(vector: readonly number[], filter: SearchFilter, limit: number): Promise<VectorHit[]>;
  /** Nearest neighbours of a stored point (its own vector), above `minScore`. */
  similarTo(
    pointId: string,
    filter: SearchFilter,
    limit: number,
    minScore: number,
  ): Promise<VectorHit[]>;
  count(filter?: SearchFilter): Promise<number>;
}

export interface MetadataStore {
  /** Records the embedding model on first use and refuses any other model afterwards. */
  bindEmbeddingModel(model: EmbeddingModelRef): void;
  /** Compacts the lexical index after an index run. */
  optimize(): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  listFileIds(): string[];
  getFile(path: string): FileRecord | undefined;
  getFileById(fileId: string): FileRecord | undefined;
  listFiles(): FileRecord[];
  /** Files whose path is `path` or ends with `/path`. */
  findFilesByPath(path: string): FileRecord[];
  /** Atomically replaces a file, its chunks (lexical index included) and its relations. */
  replaceFile(
    file: FileRecord,
    chunks: readonly ChunkInput[],
    relations?: readonly RelationInput[],
  ): void;
  /** Updates the metadata of a file whose content did not change (chunks are kept). */
  touchFile(file: FileRecord): void;
  /** Deletes a file; chunks, lexical entries and relations are removed in cascade. */
  deleteFile(fileId: string): void;
  listChunks(fileId: string): ChunkRecord[];
  markChunksEmbedded(chunkIds: readonly string[], model: string): void;
  /** FTS5 search; `matchExpression` must be a valid FTS5 query built by the retrieval layer. */
  searchLexical(matchExpression: string, filter: SearchFilter, limit: number): LexicalHit[];
  getChunkContexts(chunkIds: readonly string[]): Map<string, ChunkContext>;
  /** Adds relations computed after indexing (post-passes); removed with `fileId`. */
  insertRelations(fileId: string, relations: readonly RelationInput[]): void;
  /** Deletes relations of the given kinds starting from or pointing at the given chunks. */
  deleteRelationsAround(chunkIds: readonly string[], kinds: readonly RelationKind[]): void;
  listSimilarityCandidates(fileIds: readonly string[]): SimilarityCandidate[];
  /** Groups of identical chunks found in several files, largest groups first. */
  duplicateGroups(limit: number, minTokens: number): string[][];
  /** Relations of the given kinds touching the given ids, as source or as target. */
  relationsAround(ids: readonly string[], kinds: readonly RelationKind[]): RelationRecord[];
  topSuggestedRelations(kinds: readonly RelationKind[], limit: number): RelationRecord[];
  relationsFrom(srcIds: readonly string[], kinds?: readonly RelationKind[]): RelationRecord[];
  relationsTo(dstRefs: readonly string[], kinds?: readonly RelationKind[]): RelationRecord[];
  /** Every relation of the given kinds (whole project). */
  relationsOfKind(kinds: readonly RelationKind[]): RelationRecord[];
  getCachedEmbeddings(model: string, contentHashes: readonly string[]): Map<string, number[]>;
  putCachedEmbeddings(model: string, vectors: ReadonlyMap<string, readonly number[]>): void;
  startRun(): number;
  finishRun(runId: number, status: IndexRunStatus, stats: Readonly<Record<string, number>>): void;
  getRun(runId: number): IndexRunRecord | undefined;
  latestRun(): IndexRunRecord | undefined;
  close(): void;
}

/** Embedding model. Queries and documents are embedded differently (instruction prefix). */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}
