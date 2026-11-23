import { contentHash } from '../../src/domain/content-hash.js';
import { chunkId, fileId } from '../../src/domain/ids.js';
import type { ChunkPayload, VectorPoint } from '../../src/domain/ports.js';
import { type ProjectId, toProjectId } from '../../src/domain/project-id.js';
import type { ChunkInput, FileRecord, RelationInput } from '../../src/domain/records.js';

let sequence = 0;

/** Unique project id per test run, so parallel runs never share Qdrant collections. */
export function uniqueProjectId(prefix = 'mdtest'): ProjectId {
  sequence += 1;
  return toProjectId(`${prefix}-${process.pid}-${Date.now().toString(36)}-${sequence}`);
}

export function aFile(
  project: ProjectId,
  overrides: Partial<Omit<FileRecord, 'id'>> = {},
): FileRecord {
  const path = overrides.path ?? 'notes/README.md';
  return {
    path,
    size: 42,
    mtimeMs: 1_700_000_000_000,
    contentHash: 'f'.repeat(64),
    lastRunId: null,
    pipelineVersion: 'test-1',
    ...overrides,
    id: fileId({ project, path }),
  };
}

export function aChunk(
  project: ProjectId,
  file: FileRecord,
  ordinal: number,
  text: string,
): ChunkInput {
  const anchor = `Section ${ordinal}`;
  return {
    id: chunkId({ project, path: file.path }, anchor, ordinal),
    ordinal,
    anchor,
    headingPath: anchor,
    startLine: ordinal * 10 + 1,
    endLine: ordinal * 10 + 9,
    contentHash: contentHash(text),
    tokenCount: text.split(/\s+/).length,
    text,
    title: anchor,
  };
}

export function aLink(srcId: string, target: string, line = 1): RelationInput {
  return {
    srcId,
    kind: 'md_link',
    dstType: 'file',
    dstId: null,
    dstRef: target,
    origin: 'deterministic',
    method: 'markdown',
    score: null,
    line,
  };
}

export function aSimilarity(
  srcId: string,
  dstId: string,
  score: number,
  kind: 'duplicate_of' | 'similar_to' = 'similar_to',
): RelationInput {
  return {
    srcId,
    kind,
    dstType: 'chunk',
    dstId,
    dstRef: dstId,
    origin: 'suggested',
    method: 'embedding',
    score,
    line: null,
  };
}

export function aPayload(overrides: Partial<ChunkPayload> = {}): ChunkPayload {
  return {
    fileId: 'file-1',
    path: 'work/notes/kb.md',
    folders: ['work', 'work/notes'],
    startLine: 1,
    endLine: 10,
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

/** Deterministic unit vector pointing mostly along `axis`. */
export function aVector(dimensions: number, axis: number, noise = 0.01): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === axis ? 1 : noise));
}

export function aPoint(
  project: ProjectId,
  dimensions: number,
  ordinal: number,
  payload: Partial<ChunkPayload> = {},
): VectorPoint {
  return {
    id: chunkId({ project, path: `note-${ordinal}.md` }, 'anchor', ordinal),
    vector: aVector(dimensions, ordinal % dimensions),
    payload: aPayload(payload),
  };
}
