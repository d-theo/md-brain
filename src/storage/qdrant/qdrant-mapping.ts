import { z } from 'zod';
import type { ChunkPayload, SearchFilter } from '../../domain/ports.js';

/** Payload as stored in Qdrant (snake_case, indexed fields listed in PAYLOAD_INDEXES). */
export const qdrantPayloadSchema = z.object({
  file_id: z.string(),
  path: z.string(),
  folders: z.array(z.string()),
  start_line: z.int(),
  end_line: z.int(),
  content_hash: z.string(),
});
export type QdrantPayload = z.infer<typeof qdrantPayloadSchema>;

export const PAYLOAD_INDEXES: readonly { field: keyof QdrantPayload; schema: 'keyword' }[] = [
  { field: 'file_id', schema: 'keyword' },
  { field: 'folders', schema: 'keyword' },
];

export function toQdrantPayload(payload: ChunkPayload): QdrantPayload {
  return {
    file_id: payload.fileId,
    path: payload.path,
    folders: [...payload.folders],
    start_line: payload.startLine,
    end_line: payload.endLine,
    content_hash: payload.contentHash,
  };
}

export function fromQdrantPayload(raw: unknown): ChunkPayload {
  const payload = qdrantPayloadSchema.parse(raw);
  return {
    fileId: payload.file_id,
    path: payload.path,
    folders: payload.folders,
    startLine: payload.start_line,
    endLine: payload.end_line,
    contentHash: payload.content_hash,
  };
}

export interface QdrantCondition {
  readonly key: string;
  readonly match: { readonly any: string[] };
}

export interface QdrantFilter {
  readonly must: QdrantCondition[];
  readonly must_not?: QdrantCondition[];
}

/** Translates a domain filter; an empty list matches nothing rather than everything. */
export function toQdrantFilter(filter: SearchFilter): QdrantFilter {
  const must: QdrantCondition[] = [];
  if (filter.folders !== undefined) {
    must.push({ key: 'folders', match: { any: [...filter.folders] } });
  }
  if (filter.fileIds !== undefined) {
    must.push({ key: 'file_id', match: { any: [...filter.fileIds] } });
  }
  const excluded = filter.excludeFileIds ?? [];
  return excluded.length === 0
    ? { must }
    : { must, must_not: [{ key: 'file_id', match: { any: [...excluded] } }] };
}
