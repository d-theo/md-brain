import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/domain/content-hash.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import { SourceAccessError, SourceReader } from '../../../src/retrieval/source-reader.js';
import { aFile } from '../../support/fixtures.js';

const project = toProjectId('reader-test');
const CONTENT = ['one', 'two', 'three', 'four', 'five'].join('\n');

describe('SourceReader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'md-reader-'));
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(root, 'work/kb.md'), CONTENT);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (overrides = {}) =>
    aFile(project, { path: 'work/kb.md', contentHash: sha256(CONTENT), ...overrides });

  describe('excerpt', () => {
    it('returns the requested lines of an unchanged note', () => {
      expect(new SourceReader(root).excerpt(file(), 2, 3)).toEqual({
        startLine: 2,
        endLine: 3,
        text: 'two\nthree',
        truncated: false,
        stale: false,
        missing: false,
      });
    });

    it('bounds the excerpt to the note and to the line limit', () => {
      const reader = new SourceReader(root);

      expect(reader.excerpt(file(), 4, 99)).toMatchObject({
        startLine: 4,
        endLine: 5,
        truncated: false,
      });
      expect(reader.excerpt(file(), 1, 5, 2)).toMatchObject({
        endLine: 2,
        text: 'one\ntwo',
        truncated: true,
      });
      expect(reader.excerpt(file(), 0, -3)).toMatchObject({
        startLine: 1,
        endLine: 1,
        text: 'one',
      });
      expect(reader.excerpt(file(), 9, 12)).toMatchObject({ startLine: 5, text: '' });
    });

    it('flags notes changed since indexing and missing notes', () => {
      const reader = new SourceReader(root);

      expect(reader.excerpt(file({ contentHash: 'old' }), 1, 1).stale).toBe(true);
      expect(reader.excerpt(file({ path: 'work/gone.md' }), 1, 2)).toEqual({
        startLine: 1,
        endLine: 2,
        text: '',
        truncated: false,
        stale: true,
        missing: true,
      });
    });

    it('caches what it read', () => {
      let reads = 0;
      const reader = new SourceReader(root, () => {
        reads += 1;
        return new TextEncoder().encode(CONTENT);
      });

      expect(reader.excerpt(file(), 1, 1).text).toBe('one');
      reader.excerpt(file(), 2, 2);
      expect(reads).toBe(1);
    });
  });

  describe('absolutePath', () => {
    it('confines paths to the project root', () => {
      const reader = new SourceReader(root);

      expect(reader.absolutePath('work/kb.md')).toBe(join(root, 'work/kb.md'));
      expect(() => reader.absolutePath('../../etc/passwd')).toThrow();
      expect(() => reader.excerpt(file({ path: '/etc/passwd' }), 1, 1)).toThrow();
      expect(new SourceAccessError('x').name).toBe('SourceAccessError');
    });
  });
});
