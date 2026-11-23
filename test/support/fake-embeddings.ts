import type { EmbeddingProvider } from '../../src/domain/ports.js';

/**
 * Deterministic bag-of-words embeddings: texts sharing words get close vectors. Good enough to
 * exercise the pipeline without Ollama.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'fake-bow';
  readonly documentCalls: string[][] = [];
  readonly queryCalls: string[] = [];

  constructor(readonly dimensions = 64) {}

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    this.documentCalls.push([...texts]);
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(query: string): Promise<number[]> {
    this.queryCalls.push(query);
    return this.vector(query);
  }

  get embeddedDocuments(): number {
    return this.documentCalls.reduce((sum, call) => sum + call.length, 0);
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let hash = 0;
      for (const char of word) {
        hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
      }
      const index = hash % this.dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}
