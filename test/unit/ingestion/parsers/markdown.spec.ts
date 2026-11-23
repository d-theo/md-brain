import { describe, expect, it } from 'vitest';
import {
  parseMarkdown,
  parseMarkdownSections,
} from '../../../../src/ingestion/parsers/markdown.js';

describe('markdown parser', () => {
  describe('parseMarkdownSections', () => {
    it('splits at H1-H3 with heading trails and exact lines', () => {
      const source = [
        'Intro line', // 1
        '', // 2
        '# Title', // 3
        'Text', // 4
        '', // 5
        '## Setup **local**', // 6
        '#### Deep heading stays inside', // 7
        '| a | b |', // 8
        '|---|---|', // 9
        '| 1 | 2 |', // 10
        '### Sub', // 11
        '```ts', // 12
        '# not a heading', // 13
        '```', // 14
        '## Next', // 15
        '', // 16
      ].join('\n');

      const sections = parseMarkdownSections(source);

      expect(
        sections.map((section) => [section.headings, section.startLine, section.endLine]),
      ).toEqual([
        [[], 1, 1],
        [['Title'], 3, 4],
        [['Title', 'Setup local'], 6, 10],
        [['Title', 'Setup local', 'Sub'], 11, 14],
        [['Title', 'Next'], 15, 15],
      ]);
      expect(sections[2]?.blocks).toEqual([
        { startLine: 6, endLine: 6 },
        { startLine: 7, endLine: 7 },
        { startLine: 8, endLine: 10 },
      ]);
    });

    it('pops the heading trail when going back up', () => {
      const sections = parseMarkdownSections('# A\n## B\n### C\n# D\n### E\n');

      expect(sections.map((section) => section.headings)).toEqual([
        ['A'],
        ['A', 'B'],
        ['A', 'B', 'C'],
        ['D'],
        ['D', 'E'],
      ]);
    });

    it('returns nothing for an empty document', () => {
      expect(parseMarkdownSections('')).toEqual([]);
      expect(parseMarkdownSections('\n\n')).toEqual([]);
    });
  });

  describe('parseMarkdown', () => {
    it('collects inline links and reference definitions, not images or inline code', () => {
      const source = [
        'See [the doc](./doc.md) and [site](https://x.y).', // 1
        '![diagram](./img.png) and `not/a/link.md`', // 2
        '- [nested **link**](../up.md)', // 3
        '', // 4
        'Read [the guide][guide].', // 5
        '', // 6
        '[guide]: guide.md', // 7
      ].join('\n');

      expect(parseMarkdown(source).references).toEqual([
        { url: './doc.md', line: 1 },
        { url: 'https://x.y', line: 1 },
        { url: '../up.md', line: 3 },
        { url: 'guide.md', line: 7 },
      ]);
    });

    it('ignores links without destination', () => {
      expect(parseMarkdown('[empty]()').references).toEqual([]);
    });
  });
});
