import { topFolder } from '../domain/relative-path.js';
import type { Discovery, SkipReason } from './discovery.js';
import { type FileReader, readCandidate } from './sync.js';

export interface IndexPreview {
  /** Indexable notes per top-level folder. */
  readonly folders: Readonly<Record<string, number>>;
  readonly totalFiles: number;
  readonly secretFiles: readonly string[];
  readonly binaryFiles: readonly string[];
  readonly skipped: Readonly<Partial<Record<SkipReason, number>>>;
}

/** Dry run: what an index run would read, without writing anything. */
export function previewIndex(discovery: Discovery, readFile: FileReader): IndexPreview {
  const secretFiles: string[] = [];
  const binaryFiles: string[] = [];
  const folders: Record<string, number> = {};
  let totalFiles = 0;
  for (const file of discovery.files) {
    const read = readCandidate(readFile(file.absolutePath));
    if (read.kind === 'secret') {
      secretFiles.push(file.path);
    } else if (read.kind === 'binary') {
      binaryFiles.push(file.path);
    } else {
      totalFiles += 1;
      const folder = topFolder(file.path);
      folders[folder] = (folders[folder] ?? 0) + 1;
    }
  }
  const skipped: Partial<Record<SkipReason, number>> = {};
  for (const entry of discovery.skipped) {
    skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1;
  }
  return { folders, totalFiles, secretFiles, binaryFiles, skipped };
}

export function formatPreview(preview: IndexPreview): string[] {
  const lines = Object.entries(preview.folders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([folder, count]) => `${folder}: ${count} notes`);
  lines.push(`Total: ${preview.totalFiles} notes`);
  const skipped = Object.entries(preview.skipped).map(([reason, count]) => `${reason}=${count}`);
  if (skipped.length > 0) {
    lines.push(`Skipped: ${skipped.join(' ')}`);
  }
  for (const path of preview.secretFiles) {
    lines.push(`Skipped (possible secret): ${path}`);
  }
  for (const path of preview.binaryFiles) {
    lines.push(`Skipped (binary): ${path}`);
  }
  return lines;
}
