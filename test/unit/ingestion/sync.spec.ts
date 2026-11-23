import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/domain/content-hash.js';
import { readCandidate } from '../../../src/ingestion/sync.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sync', () => {
  describe('readCandidate', () => {
    it('returns text with the hash of the raw bytes', () => {
      const bytes = encode('# Titre accentué\r\n');

      expect(readCandidate(bytes)).toEqual({
        kind: 'text',
        content: '# Titre accentué\r\n',
        hash: sha256(bytes),
      });
    });

    it('treats NUL bytes and invalid UTF-8 as binary', () => {
      expect(readCandidate(new Uint8Array([0x41, 0x00]))).toEqual({ kind: 'binary' });
      expect(readCandidate(new Uint8Array([0xc3, 0x28]))).toEqual({ kind: 'binary' });
    });

    it('never returns the content of a file that looks like it has secrets', () => {
      expect(readCandidate(encode('postgresql://admin:S3cr3tValue@db/x'))).toEqual({
        kind: 'secret',
      });
    });
  });
});
