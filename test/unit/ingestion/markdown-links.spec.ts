import { describe, expect, it } from 'vitest';
import { toProjectId } from '../../../src/domain/project-id.js';
import { MarkdownChunker, resolveMarkdownLink } from '../../../src/ingestion/chunking.js';

describe('markdown links', () => {
  describe('resolveMarkdownLink', () => {
    it.each([
      ['work/kb/a.md', '../README.md#setup', 'work/README.md'],
      ['work/README.md', './kb/flow%20map.md', 'work/kb/flow map.md'],
      ['work/README.md', 'kb/', 'work/kb'],
      ['README.md', 'journal/2026.md?plain=1', 'journal/2026.md'],
      ['work/kb/a.md', '/journal/2026', 'journal/2026'],
      ['work/kb/a.md', 'b', 'work/kb/b'],
    ])('resolves %s + %s -> %s', (path, url, expected) => {
      expect(resolveMarkdownLink(path, url)).toBe(expected);
    });

    it.each([
      'https://example.com',
      'mailto:a@b.c',
      'obsidian://open?vault=x',
      '//cdn.example.com/x.md',
      '#anchor',
      '../../outside.md',
      '..',
      '/',
      '%E0%A4%A.md',
      '',
    ])('ignores %j', (url) => {
      expect(resolveMarkdownLink('work/README.md', url)).toBeNull();
    });
  });

  describe('MarkdownChunker relations', () => {
    it('links the chunk holding each link to the root-relative target', () => {
      const content = [
        '# Architecture', // 1
        'See [embeddings](./embeddings.md), [site](https://x.y) and [home](/README.md).', // 2
        '', // 3
        '## Storage', // 4
        'Details in [the guide][guide] and [the anchor](#storage).', // 5
        '', // 6
        '[guide]: ../guide.md', // 7
      ].join('\n');

      const { chunks, relations } = new MarkdownChunker().chunk({
        project: toProjectId('notes'),
        path: 'work/kb/architecture.md',
        content,
      });

      expect(relations.map((relation) => [relation.srcId, relation.dstRef, relation.line])).toEqual(
        [
          [chunks[0]?.chunk.id, 'work/kb/embeddings.md', 2],
          [chunks[0]?.chunk.id, 'README.md', 2],
          [chunks[1]?.chunk.id, 'work/guide.md', 7],
        ],
      );
      expect(relations.every((relation) => relation.kind === 'md_link')).toBe(true);
      expect(relations[0]).toMatchObject({
        dstType: 'file',
        dstId: null,
        origin: 'deterministic',
        method: 'markdown',
        score: null,
      });
    });
  });
});
