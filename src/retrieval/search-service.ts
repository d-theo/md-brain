import { type FusedResult, reciprocalRankFusion } from '../domain/fusion.js';
import type {
  EmbeddingProvider,
  MetadataStore,
  SearchFilter,
  VectorStore,
} from '../domain/ports.js';
import { toFtsExpression } from './lexical-query.js';

export const CANDIDATES_PER_RETRIEVER = 40;
export const MAX_RESULTS = 50;
/**
 * Weight of the dense retriever in the fusion. 2 was the best value on the documentation of a
 * code project (claude-brain eval, Qwen3-Embedding 0.6B); recalibrate with `mdb eval`.
 */
export const SEMANTIC_WEIGHT = 2;
/** Diversity: a note contributes at most this many chunks; identical chunks appear once. */
const MAX_CHUNKS_PER_FILE = 2;

export interface SearchResult {
  readonly chunkId: string;
  readonly score: number;
  /** 1-based rank of the chunk in each retriever that found it. */
  readonly ranks: Readonly<Record<string, number>>;
  readonly path: string;
  readonly title: string | null;
  readonly startLine: number;
  readonly endLine: number;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Hybrid search: dense (Qdrant) + lexical (FTS5), fused with Reciprocal Rank Fusion. */
export class SearchService {
  constructor(
    private readonly store: MetadataStore,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(query: string, filter: SearchFilter, limit = 10): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 2_000) {
      throw new SearchError('The query must contain between 1 and 2000 characters.');
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RESULTS) {
      throw new SearchError(`The limit must be an integer between 1 and ${MAX_RESULTS}.`);
    }
    const expression = toFtsExpression(trimmed);
    const semantic = await this.vectors.search(
      await this.embeddings.embedQuery(trimmed),
      filter,
      CANDIDATES_PER_RETRIEVER,
    );
    const lexical =
      expression === null
        ? []
        : this.store.searchLexical(expression, filter, CANDIDATES_PER_RETRIEVER);
    const fused = reciprocalRankFusion([
      { source: 'semantic', ids: semantic.map((hit) => hit.id), weight: SEMANTIC_WEIGHT },
      { source: 'lexical', ids: lexical.map((hit) => hit.chunkId) },
    ]);
    return this.resolve(fused, limit);
  }

  /**
   * Attaches source locations; ids unknown to SQLite (orphan vectors) are dropped, and results
   * are diversified (chunks per note, identical contents).
   */
  private resolve(fused: readonly FusedResult[], limit: number): SearchResult[] {
    const contexts = this.store.getChunkContexts(
      fused.slice(0, limit * 4).map((result) => result.id),
    );
    const results: SearchResult[] = [];
    const perFile = new Map<string, number>();
    const contents = new Set<string>();
    for (const result of fused) {
      const context = contexts.get(result.id);
      if (context === undefined) {
        continue;
      }
      const { chunk, file } = context;
      const fileCount = perFile.get(file.id) ?? 0;
      if (fileCount >= MAX_CHUNKS_PER_FILE || contents.has(chunk.contentHash)) {
        continue;
      }
      perFile.set(file.id, fileCount + 1);
      contents.add(chunk.contentHash);
      results.push({
        chunkId: chunk.id,
        score: result.score,
        ranks: result.ranks,
        path: file.path,
        title: chunk.headingPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
      if (results.length === limit) {
        break;
      }
    }
    return results;
  }
}
