import { describe, expect, it } from 'vitest';
import type { EmbeddingsConfig } from '../../../src/config/config-schema.js';
import {
  EmbeddingError,
  formatQuery,
  type OllamaEmbedClient,
  OllamaEmbeddingProvider,
} from '../../../src/embeddings/ollama-embedding-provider.js';

const config: EmbeddingsConfig = {
  provider: 'ollama',
  host: 'http://localhost:11434',
  model: 'qwen3-embedding:0.6b',
  dimensions: 3,
  queryInstruction: 'Retrieve code',
  batchSize: 2,
};

class FakeClient implements OllamaEmbedClient {
  readonly inputs: string[][] = [];
  reply: (input: string[]) => number[][] = (input) => input.map(() => [1, 0, 0]);

  async embed(request: { model: string; input: string[] }): Promise<{ embeddings: number[][] }> {
    this.inputs.push(request.input);
    return { embeddings: this.reply(request.input) };
  }
}

describe('OllamaEmbeddingProvider', () => {
  describe('formatQuery', () => {
    it('uses the Qwen3 instruction format', () => {
      expect(formatQuery('Find docs', 'allowlist')).toBe('Instruct: Find docs\nQuery:allowlist');
    });
  });

  describe('embedDocuments', () => {
    it('embeds documents without instruction, in batches', async () => {
      const client = new FakeClient();
      const provider = new OllamaEmbeddingProvider(client, config);

      const vectors = await provider.embedDocuments(['a', 'b', 'c']);

      expect(vectors).toHaveLength(3);
      expect(client.inputs).toEqual([['a', 'b'], ['c']]);
      expect(provider.model).toBe('qwen3-embedding:0.6b');
      expect(provider.dimensions).toBe(3);
    });

    it('does not call the model for an empty list', async () => {
      const client = new FakeClient();

      expect(await new OllamaEmbeddingProvider(client, config).embedDocuments([])).toEqual([]);
      expect(client.inputs).toEqual([]);
    });

    it('rejects responses of the wrong size or dimension', async () => {
      const client = new FakeClient();
      const provider = new OllamaEmbeddingProvider(client, config);

      client.reply = () => [[1, 0, 0]];
      await expect(provider.embedDocuments(['a', 'b'])).rejects.toThrow(
        'Ollama returned 1 embeddings for 2 inputs.',
      );
      client.reply = (input) => input.map(() => [1, 0]);
      await expect(provider.embedDocuments(['a'])).rejects.toThrow(
        'returned 2 dimensions, 3 configured',
      );
    });

    it('wraps client failures', async () => {
      const client: OllamaEmbedClient = {
        embed: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      };
      const failing: OllamaEmbedClient = {
        embed: async () => {
          throw 'down';
        },
      };

      await expect(
        new OllamaEmbeddingProvider(client, config).embedDocuments(['a']),
      ).rejects.toThrow(EmbeddingError);
      await expect(new OllamaEmbeddingProvider(failing, config).embedQuery('a')).rejects.toThrow(
        'Ollama embedding failed (http://localhost:11434, qwen3-embedding:0.6b): down',
      );
    });
  });

  describe('embedQuery', () => {
    it('prefixes the query with the instruction', async () => {
      const client = new FakeClient();

      await new OllamaEmbeddingProvider(client, config).embedQuery('where is detox called?');

      expect(client.inputs).toEqual([['Instruct: Retrieve code\nQuery:where is detox called?']]);
    });

    it('fails when no vector is returned', async () => {
      const client = new FakeClient();
      client.reply = () => [];
      const provider = new OllamaEmbeddingProvider(client, { ...config });

      await expect(provider.embedQuery('q')).rejects.toThrow(
        'Ollama returned 0 embeddings for 1 inputs.',
      );
    });
  });
});
