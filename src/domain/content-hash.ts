import { createHash } from 'node:crypto';

/**
 * Normalises text so that hashes ignore line-ending and trailing-whitespace noise.
 */
export function normalizeContent(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** sha256 (hex) of the normalised text: used for embedding reuse and exact duplicates. */
export function contentHash(text: string): string {
  return sha256(normalizeContent(text));
}

/** sha256 (hex) of raw content: used for file-level change detection. */
export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
