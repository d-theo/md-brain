import type { RelationKind, RelationMethod, RelationOrigin, RelationTarget } from './model.js';

/** A Markdown note of a project, with its last indexed state. */
export interface FileRecord {
  readonly id: string;
  /** Path relative to the project root (POSIX separators). */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** sha256 of the raw file content. */
  readonly contentHash: string;
  readonly lastRunId: number | null;
  /** Version of the chunker that produced the chunks of this file. */
  readonly pipelineVersion: string;
}

/** A section of a note (heading section, or part of a long one). */
export interface ChunkRecord {
  readonly id: string;
  readonly fileId: string;
  readonly ordinal: number;
  /** Heading path (with an occurrence suffix when repeated): base of the stable chunk id. */
  readonly anchor: string;
  readonly headingPath: string | null;
  readonly startLine: number;
  readonly endLine: number;
  /** sha256 of the normalised chunk text. */
  readonly contentHash: string;
  readonly tokenCount: number;
  /** Embedding model whose vector is stored in Qdrant, null while not embedded. */
  readonly embeddedModel: string | null;
}

/** Chunk to store: `text` and `title` only feed the lexical index and are not persisted. */
export interface ChunkInput extends Omit<ChunkRecord, 'fileId' | 'embeddedModel'> {
  readonly text: string;
  readonly title: string;
}

export type IndexRunStatus = 'running' | 'succeeded' | 'failed';

export interface IndexRunRecord {
  readonly id: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: IndexRunStatus;
  readonly stats: Readonly<Record<string, number>>;
}

/**
 * A relation from a chunk. Markdown links keep the target path in `dstRef` and are resolved at
 * query time (they never go stale when the target changes); similarity links point at a chunk
 * (`dstId` = `dstRef` = chunk id).
 */
export interface RelationInput {
  readonly srcId: string;
  readonly kind: RelationKind;
  readonly dstType: RelationTarget;
  readonly dstId: string | null;
  readonly dstRef: string;
  readonly origin: RelationOrigin;
  readonly method: RelationMethod;
  readonly score: number | null;
  readonly line: number | null;
}

export interface RelationRecord extends RelationInput {
  readonly fileId: string;
}
