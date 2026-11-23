import { getOrThrow, zipStrict } from '../domain/collections.js';
import { contentHash } from '../domain/content-hash.js';
import type { EmbeddingProvider, MetadataStore } from '../domain/ports.js';

export interface EmbedStats {
  readonly requested: number;
  readonly cached: number;
  readonly computed: number;
}

/**
 * Embeds documents through the per-model cache of the project store: a text already embedded
 * by the same model (same normalised content) is never sent to the model again.
 */
export class CachedEmbedder {
  private stats: EmbedStats = { requested: 0, cached: 0, computed: 0 };

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly store: MetadataStore,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get counters(): EmbedStats {
    return { ...this.stats };
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const hashes = texts.map((text) => contentHash(text));
    const vectors = this.store.getCachedEmbeddings(this.provider.model, hashes);
    const missing = new Map<string, string>();
    for (const [hash, text] of zipStrict(hashes, texts)) {
      if (!vectors.has(hash)) {
        missing.set(hash, text);
      }
    }
    const computed = await this.provider.embedDocuments([...missing.values()]);
    const fresh = new Map(zipStrict([...missing.keys()], computed));
    this.store.putCachedEmbeddings(this.provider.model, fresh);
    for (const [hash, vector] of fresh) {
      vectors.set(hash, vector);
    }
    this.stats = {
      requested: this.stats.requested + texts.length,
      cached: this.stats.cached + texts.length - missing.size,
      computed: this.stats.computed + missing.size,
    };
    return hashes.map((hash) => getOrThrow(vectors, hash, 'embedding'));
  }
}
