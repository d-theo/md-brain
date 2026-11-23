import type { KnowledgeConfig } from '../config/config-schema.js';
import type {
  ChunkContext,
  MetadataStore,
  SimilarityCandidate,
  VectorStore,
} from '../domain/ports.js';
import type { RelationInput } from '../domain/records.js';

export const SIMILARITY_KINDS = ['duplicate_of', 'similar_to'] as const;
const SIMILARITY_VERSION = 1;
const SIMILARITY_META_KEY = 'similarity_version';

export interface SimilarityOptions {
  readonly neighbours: number;
  /** Chunks shorter than this are not compared (titles, one-liners). */
  readonly minTokens: number;
}

export const DEFAULT_SIMILARITY_OPTIONS: SimilarityOptions = {
  neighbours: 5,
  minTokens: 40,
};

export interface SimilarityReport {
  readonly compared: number;
  readonly duplicates: number;
  readonly similar: number;
}

function toCandidate({ chunk, file }: ChunkContext): SimilarityCandidate {
  return { chunkId: chunk.id, fileId: file.id, tokenCount: chunk.tokenCount };
}

function eligible(candidate: SimilarityCandidate, options: SimilarityOptions): boolean {
  return candidate.tokenCount >= options.minTokens;
}

/**
 * Suggested links between chunks of different files, from their embeddings: `duplicate_of`
 * above the duplicate threshold, `similar_to` above the similarity threshold. Only the chunks
 * of changed files are compared; their previous links (in both directions) are replaced.
 */
export class SimilarityLinker {
  constructor(
    private readonly store: MetadataStore,
    private readonly vectors: VectorStore,
    private readonly thresholds: KnowledgeConfig,
    private readonly options: SimilarityOptions = DEFAULT_SIMILARITY_OPTIONS,
  ) {}

  /**
   * Links the chunks of the given files; every file when the thresholds or the options changed
   * since the last run (recorded in the store).
   */
  async linkChanged(fileIds: readonly string[]): Promise<SimilarityReport> {
    const version = JSON.stringify({
      version: SIMILARITY_VERSION,
      ...this.thresholds,
      ...this.options,
    });
    const all = this.store.getMeta(SIMILARITY_META_KEY) !== version;
    const report = await this.link(all ? this.store.listFileIds() : fileIds);
    this.store.setMeta(SIMILARITY_META_KEY, version);
    return report;
  }

  async link(fileIds: readonly string[]): Promise<SimilarityReport> {
    const candidates = this.store.listSimilarityCandidates(fileIds);
    this.store.deleteRelationsAround(
      candidates.map((candidate) => candidate.chunkId),
      SIMILARITY_KINDS,
    );
    const seen = new Set<string>();
    const byFile = new Map<string, RelationInput[]>();
    let duplicates = 0;
    let similar = 0;
    let compared = 0;
    for (const candidate of candidates.filter((entry) => eligible(entry, this.options))) {
      compared += 1;
      const hits = await this.vectors.similarTo(
        candidate.chunkId,
        { excludeFileIds: [candidate.fileId] },
        this.options.neighbours,
        this.thresholds.similarThreshold,
      );
      const targets = this.store.getChunkContexts(hits.map((hit) => hit.id));
      for (const hit of hits) {
        const target = targets.get(hit.id);
        if (target === undefined || !eligible(toCandidate(target), this.options)) {
          continue;
        }
        const pair = [candidate.chunkId, hit.id].sort().join('|');
        if (seen.has(pair)) {
          continue;
        }
        seen.add(pair);
        const duplicate = hit.score >= this.thresholds.duplicateThreshold;
        duplicates += duplicate ? 1 : 0;
        similar += duplicate ? 0 : 1;
        byFile.set(candidate.fileId, [
          ...(byFile.get(candidate.fileId) ?? []),
          {
            srcId: candidate.chunkId,
            kind: duplicate ? 'duplicate_of' : 'similar_to',
            dstType: 'chunk',
            dstId: hit.id,
            dstRef: hit.id,
            origin: 'suggested',
            method: 'embedding',
            score: hit.score,
            line: null,
          },
        ]);
      }
    }
    for (const [fileId, relations] of byFile) {
      this.store.insertRelations(fileId, relations);
    }
    return { compared, duplicates, similar };
  }
}
