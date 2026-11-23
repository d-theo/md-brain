import { createHash } from 'node:crypto';
import type { ProjectId } from './project-id.js';

/** Fixed namespace for every chunk UUID of the knowledge base. Never change it. */
export const KB_UUID_NAMESPACE = '8f0b7e1c-5d2a-4c3b-9e6f-2a1d4b7c9e05';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** RFC 4122 name-based UUID (version 5, SHA-1). */
export function uuidV5(name: string, namespace: string): string {
  if (!UUID_PATTERN.test(namespace)) {
    throw new Error(`Invalid UUID namespace "${namespace}".`);
  }
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export interface FileLocator {
  readonly project: ProjectId;
  /** Note path relative to the project root. */
  readonly path: string;
}

export function fileId(file: FileLocator): string {
  return createHash('sha1').update(`${file.project}|${file.path}`).digest('hex');
}

/**
 * Stable chunk id (UUID v5, accepted by Qdrant as point id). `anchor` is the heading path, so the
 * id survives content edits as long as the heading exists.
 */
export function chunkId(file: FileLocator, anchor: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`Invalid chunk ordinal ${ordinal}.`);
  }
  return uuidV5(`${file.project}|${file.path}|${anchor}|${ordinal}`, KB_UUID_NAMESPACE);
}
