import { describe, expect, it } from 'vitest';
import type { DiscoveredFile, Discovery } from '../../../src/ingestion/discovery.js';
import { formatPreview, previewIndex } from '../../../src/ingestion/preview.js';

function aDiscoveredFile(path: string): DiscoveredFile {
  return { path, absolutePath: `/p/${path}`, size: 1, mtimeMs: 1 };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const contents: Record<string, Uint8Array> = {
  '/p/README.md': encode('# Notes'),
  '/p/work/kb.md': encode('# KB'),
  '/p/work/kb/flow.md': encode('# Flow'),
  '/p/journal/leak.md': encode('db: postgresql://admin:S3cr3tValue@db/x'),
  '/p/journal/blob.md': new Uint8Array([0x89, 0x00, 0x01]),
};

const discovery: Discovery = {
  files: [
    aDiscoveredFile('README.md'),
    aDiscoveredFile('work/kb.md'),
    aDiscoveredFile('work/kb/flow.md'),
    aDiscoveredFile('journal/leak.md'),
    aDiscoveredFile('journal/blob.md'),
  ],
  skipped: [
    { path: 'big.md', reason: 'too_large' },
    { path: 'a.txt', reason: 'unsupported' },
    { path: 'b.txt', reason: 'unsupported' },
  ],
};

const readFile = (path: string): Uint8Array => contents[path] ?? new Uint8Array();

describe('preview', () => {
  describe('previewIndex', () => {
    it('counts indexable notes per top-level folder and lists skipped ones', () => {
      const preview = previewIndex(discovery, readFile);

      expect(preview.totalFiles).toBe(3);
      expect(preview.folders).toEqual({ '.': 1, work: 2 });
      expect(preview.secretFiles).toEqual(['journal/leak.md']);
      expect(preview.binaryFiles).toEqual(['journal/blob.md']);
      expect(preview.skipped).toEqual({ too_large: 1, unsupported: 2 });
    });
  });

  describe('formatPreview', () => {
    it('renders one line per folder and the skipped files', () => {
      expect(formatPreview(previewIndex(discovery, readFile))).toEqual([
        '.: 1 notes',
        'work: 2 notes',
        'Total: 3 notes',
        'Skipped: too_large=1 unsupported=2',
        'Skipped (possible secret): journal/leak.md',
        'Skipped (binary): journal/blob.md',
      ]);
    });

    it('omits the skipped line when nothing was skipped', () => {
      const lines = formatPreview(previewIndex({ files: [], skipped: [] }, readFile));

      expect(lines).toEqual(['Total: 0 notes']);
    });
  });
});
