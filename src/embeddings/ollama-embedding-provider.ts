import type { EmbeddingsConfig } from '../config/config-schema.js';
import { getOrThrow, zipStrict } from '../domain/collections.js';
import { describeError } from '../domain/errors.js';
import type { EmbeddingProvider } from '../domain/ports.js';

/** Subset of the `ollama` client used here (injectable for tests). */
export interface OllamaEmbedClient {
  embed(request: {
    model: string;
    input: string[];
    truncate: boolean;
    keep_alive: string;
  }): Promise<{ embeddings: number[][] }>;
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Qwen3-Embedding instruction format: queries are prefixed with the task, documents are not.
 * See https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
 */
export function formatQuery(task: string, query: string): string {
  return `Instruct: ${task}\nQuery:${query}`;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly client: OllamaEmbedClient,
    private readonly config: EmbeddingsConfig,
  ) {
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += this.config.batchSize) {
      vectors.push(...(await this.embed(texts.slice(index, index + this.config.batchSize))));
    }
    return vectors;
  }

  async embedQuery(query: string): Promise<number[]> {
    const vectors = await this.embed([formatQuery(this.config.queryInstruction, query)]);
    return getOrThrow(new Map(zipStrict([query], vectors)), query, 'query embedding');
  }

  private async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }
    let embeddings: number[][];
    try {
      ({ embeddings } = await this.client.embed({
        model: this.model,
        input,
        truncate: true,
        keep_alive: '10m',
      }));
    } catch (error) {
      throw new EmbeddingError(
        `Ollama embedding failed (${this.config.host}, ${this.model}): ${describeError(error)}`,
      );
    }
    if (embeddings.length !== input.length) {
      throw new EmbeddingError(
        `Ollama returned ${embeddings.length} embeddings for ${input.length} inputs.`,
      );
    }
    for (const vector of embeddings) {
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(
          `Model ${this.model} returned ${vector.length} dimensions, ${this.dimensions} configured.`,
        );
      }
    }
    return embeddings;
  }
}
