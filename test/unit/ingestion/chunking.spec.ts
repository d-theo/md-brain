import { describe, expect, it } from 'vitest';
import { contentHash } from '../../../src/domain/content-hash.js';
import { chunkId } from '../../../src/domain/ids.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import {
  estimateTokens,
  lineSlicer,
  MAX_EMBED_CHARS,
  MarkdownChunker,
} from '../../../src/ingestion/chunking.js';

const project = toProjectId('notes');
const source = (content: string, path = 'work/README.md') => ({ project, path, content });
const words = (count: number, word = 'lorem'): string =>
  Array.from({ length: count }, () => word).join(' ');

const chunksOf = (input: ReturnType<typeof source>) => chunker.chunk(input).chunks;
const chunker = new MarkdownChunker({ maxTokens: 60 });

describe('chunking', () => {
  describe('estimateTokens', () => {
    it('estimates about four characters per token', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('abcde')).toBe(2);
    });
  });

  describe('MarkdownChunker', () => {
    it('creates one chunk per section with exact lines, stable ids and an embedding header', () => {
      const content = `# Core\n${words(10)}\n\n## Run\r\n${words(10, 'npm')}\n`;

      const chunks = chunksOf(source(content));

      expect(
        chunks.map(({ chunk }) => [chunk.anchor, chunk.startLine, chunk.endLine, chunk.ordinal]),
      ).toEqual([
        ['Core', 1, 2, 0],
        ['Core > Run', 4, 5, 1],
      ]);
      const run = chunks[1];
      expect(run?.chunk).toMatchObject({
        id: chunkId({ project, path: 'work/README.md' }, 'Core > Run', 0),
        headingPath: 'Core > Run',
        title: 'Core > Run',
        text: `## Run\n${words(10, 'npm')}`,
        contentHash: contentHash(`## Run\n${words(10, 'npm')}`),
      });
      expect(run?.embedText).toBe(`work/README.md\nCore > Run\n\n## Run\n${words(10, 'npm')}`);
    });

    it('keeps chunk ids stable when other sections change', () => {
      const before = chunksOf(source(`# A\n${words(10)}\n# B\n${words(10)}`));
      const after = chunksOf(source(`# New\n${words(10)}\n# A\n${words(12)}\n# B\n${words(10)}`));

      expect(after.find(({ chunk }) => chunk.anchor === 'B')?.chunk.id).toBe(
        before.find(({ chunk }) => chunk.anchor === 'B')?.chunk.id,
      );
    });

    it('titles a preamble with the file name and disambiguates repeated headings', () => {
      const chunks = chunksOf(
        source(`${words(10)}\n# Usage\n${words(10)}\n# Usage\n${words(10)}`, 'docs/guide.md'),
      );

      expect(chunks.map(({ chunk }) => [chunk.anchor, chunk.title, chunk.headingPath])).toEqual([
        ['(preamble)', 'guide.md', null],
        ['Usage', 'Usage', 'Usage'],
        ['Usage #2', 'Usage', 'Usage'],
      ]);
    });

    it('merges heading-only sections into the next one, but keeps short sections', () => {
      const chunks = chunksOf(
        source(
          `# Architecture\n## Domain\n### Entities\n${words(10)}\n## Short\nOne line.\n# Tiny`,
        ),
      );

      expect(chunks.map(({ chunk }) => [chunk.anchor, chunk.startLine, chunk.endLine])).toEqual([
        ['Architecture > Domain > Entities', 1, 4],
        ['Architecture > Short', 5, 6],
        ['Tiny', 7, 7],
      ]);
    });

    it('splits long sections on block boundaries with one block of overlap', () => {
      const paragraphs = [1, 2, 3, 4].map((index) => words(20, `par${index}`));
      const content = `# Long\n\n${paragraphs.join('\n\n')}`;

      const chunks = chunksOf(source(content));

      expect(chunks.map(({ chunk }) => [chunk.anchor, chunk.startLine, chunk.endLine])).toEqual([
        ['Long', 1, 5],
        ['Long', 5, 7],
        ['Long', 7, 9],
      ]);
      expect(new Set(chunks.map(({ chunk }) => chunk.id)).size).toBe(3);
    });

    it('does not repeat a block that cannot share a chunk with the next one', () => {
      const paragraphs = [1, 2, 3].map((index) => words(36, `par${index}`));

      const chunks = chunksOf(source(`# Long\n\n${paragraphs.join('\n\n')}`));

      expect(chunks.map(({ chunk }) => [chunk.startLine, chunk.endLine])).toEqual([
        [1, 3],
        [5, 5],
        [7, 7],
      ]);
    });

    it('keeps an oversized block whole', () => {
      const code = `\`\`\`\n${Array.from({ length: 20 }, () => words(5, 'code')).join('\n')}\n\`\`\``;

      const chunks = chunksOf(source(`# Code\n\n${code}\n\n${words(5)}`));

      expect(chunks.map(({ chunk }) => [chunk.startLine, chunk.endLine])).toEqual([
        [1, 1],
        [3, 24],
        [26, 26],
      ]);
    });

    it('uses sensible defaults', () => {
      expect(new MarkdownChunker().chunk(source('# A\nshort')).chunks.length).toBe(1);
    });

    it('caps the text sent to the embedding model but indexes it all', () => {
      const long = 'x'.repeat(MAX_EMBED_CHARS + 100);

      const [entry] = new MarkdownChunker({ maxTokens: 10_000 }).chunk(source(long)).chunks;

      expect(entry?.chunk.text).toBe(long);
      expect(entry?.embedText.endsWith('x'.repeat(10))).toBe(true);
      expect(entry?.embedText.length).toBeLessThan(long.length);
    });

    it('produces no chunk for an empty note', () => {
      expect(new MarkdownChunker().chunk(source(''))).toEqual({ chunks: [], relations: [] });
    });
  });

  describe('lineSlicer', () => {
    it('slices 1-based inclusive line ranges of CRLF or LF text', () => {
      const slice = lineSlicer('a\r\nb\nc');

      expect(slice(2, 3)).toBe('b\nc');
      expect(slice(1, 1)).toBe('a');
    });
  });
});
