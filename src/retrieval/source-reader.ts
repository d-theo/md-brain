import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256 } from '../domain/content-hash.js';
import type { FileRecord } from '../domain/records.js';
import { toRelativePath } from '../domain/relative-path.js';

export const MAX_EXCERPT_LINES = 120;

export interface Excerpt {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  /** The requested range was longer than the excerpt limit. */
  readonly truncated: boolean;
  /** The file changed on disk since it was indexed: lines may have moved. */
  readonly stale: boolean;
  /** The file no longer exists on disk. */
  readonly missing: boolean;
}

export class SourceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAccessError';
  }
}

interface Loaded {
  readonly lines: readonly string[];
  readonly stale: boolean;
}

/**
 * Reads indexed files from disk (the source of truth), confined to the project root, and
 * checks whether they changed since indexing.
 */
export class SourceReader {
  private readonly cache = new Map<string, Loaded | null>();

  constructor(
    private readonly root: string,
    private readonly readFile: (path: string) => Uint8Array = readFileSync,
  ) {}

  absolutePath(path: string): string {
    const relativePath = toRelativePath(path);
    const absolute = resolve(join(this.root, relativePath));
    const inside = relative(resolve(this.root), absolute);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new SourceAccessError(`"${relativePath}" is outside of the project.`);
    }
    return absolute;
  }

  excerpt(
    file: FileRecord,
    startLine: number,
    endLine: number,
    maxLines = MAX_EXCERPT_LINES,
  ): Excerpt {
    const loaded = this.load(file);
    const first = Math.max(1, Math.floor(startLine));
    const requestedLast = Math.max(first, Math.floor(endLine));
    if (loaded === null) {
      return {
        startLine: first,
        endLine: requestedLast,
        text: '',
        truncated: false,
        stale: true,
        missing: true,
      };
    }
    const fileLast = Math.max(1, loaded.lines.length);
    const last = Math.min(requestedLast, fileLast, first + maxLines - 1);
    return {
      startLine: Math.min(first, fileLast),
      endLine: last,
      text: loaded.lines.slice(first - 1, last).join('\n'),
      truncated: last < Math.min(requestedLast, fileLast),
      stale: loaded.stale,
      missing: false,
    };
  }

  private load(file: FileRecord): Loaded | null {
    const cached = this.cache.get(file.id);
    if (cached !== undefined) {
      return cached;
    }
    const path = this.absolutePath(file.path);
    let loaded: Loaded | null;
    try {
      const bytes = this.readFile(path);
      loaded = {
        lines: new TextDecoder().decode(bytes).split(/\r?\n/),
        stale: sha256(bytes) !== file.contentHash,
      };
    } catch {
      loaded = null;
    }
    this.cache.set(file.id, loaded);
    return loaded;
  }
}
