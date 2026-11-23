import { readFileSync } from 'node:fs';
import type { ProjectConfig } from '../config/project-config.js';
import { sha256 } from '../domain/content-hash.js';
import { fileId } from '../domain/ids.js';
import type { MetadataStore } from '../domain/ports.js';
import type { FileRecord } from '../domain/records.js';
import type { DiscoveredFile, Discovery } from './discovery.js';
import { detectSecrets } from './secret-guard.js';

export interface FileToIndex {
  readonly record: FileRecord;
  readonly content: string;
}

/** Turns a new or changed file into chunks/vectors, and removes indexed files. */
export interface FileProcessor {
  /** Version of the chunker: files indexed with another one are redone. */
  readonly version: string;
  process(file: FileToIndex): Promise<void>;
  /** Must remove vectors and metadata of the given files. */
  remove(files: readonly FileRecord[]): Promise<void>;
}

export interface DiscoverySource {
  discover(): Promise<Discovery>;
}

export type FileReader = (absolutePath: string) => Uint8Array;

export interface SyncCounters {
  added: number;
  changed: number;
  touched: number;
  unchanged: number;
  deleted: number;
  skippedSecret: number;
  skippedBinary: number;
}

export interface SyncReport {
  readonly runId: number;
  readonly totals: Readonly<SyncCounters>;
  /** Paths of files skipped because they look like they contain secrets. */
  readonly secretFiles: readonly string[];
  /** Ids of the files (re)processed by this run: input of the post-passes. */
  readonly processedFileIds: readonly string[];
}

type ReadResult =
  | { readonly kind: 'text'; readonly content: string; readonly hash: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'secret' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Reads a candidate file: binary and secret-bearing files are never returned as text. */
export function readCandidate(bytes: Uint8Array): ReadResult {
  if (bytes.subarray(0, 8_000).includes(0)) {
    return { kind: 'binary' };
  }
  let content: string;
  try {
    content = utf8.decode(bytes);
  } catch {
    return { kind: 'binary' };
  }
  if (detectSecrets(content) !== null) {
    return { kind: 'secret' };
  }
  return { kind: 'text', content, hash: sha256(bytes) };
}

function statUnchanged(stored: FileRecord, file: DiscoveredFile, version: string): boolean {
  return (
    stored.pipelineVersion === version &&
    stored.size === file.size &&
    stored.mtimeMs === file.mtimeMs
  );
}

/**
 * Incremental synchronisation of a project from its files on disk. A file is re-read only when
 * its stat (size, mtime) changed; it is re-processed only when its content hash changed. Files
 * that disappeared, or now look like secrets, are removed from the index.
 */
export class IndexSync {
  constructor(
    private readonly project: ProjectConfig,
    private readonly store: MetadataStore,
    private readonly discovery: DiscoverySource,
    private readonly processor: FileProcessor,
    private readonly readFile: FileReader = readFileSync,
  ) {}

  async run(): Promise<SyncReport> {
    const runId = this.store.startRun();
    const totals: SyncCounters = {
      added: 0,
      changed: 0,
      touched: 0,
      unchanged: 0,
      deleted: 0,
      skippedSecret: 0,
      skippedBinary: 0,
    };
    const secretFiles: string[] = [];
    const processed: string[] = [];
    try {
      const { files } = await this.discovery.discover();
      const stored = new Map(this.store.listFiles().map((file) => [file.path, file]));
      const toRemove: FileRecord[] = [];
      const { version } = this.processor;
      for (const file of files) {
        const existing = stored.get(file.path);
        stored.delete(file.path);
        if (existing !== undefined && statUnchanged(existing, file, version)) {
          totals.unchanged += 1;
          continue;
        }
        const read = readCandidate(this.readFile(file.absolutePath));
        if (read.kind !== 'text') {
          if (read.kind === 'secret') {
            totals.skippedSecret += 1;
            secretFiles.push(file.path);
          } else {
            totals.skippedBinary += 1;
          }
          if (existing !== undefined) {
            toRemove.push(existing);
          }
          continue;
        }
        const record = this.toRecord(runId, file, read.hash, version);
        if (existing?.contentHash === read.hash && existing.pipelineVersion === version) {
          this.store.touchFile(record);
          totals.touched += 1;
        } else {
          await this.processor.process({ record, content: read.content });
          processed.push(record.id);
          totals[existing === undefined ? 'added' : 'changed'] += 1;
        }
      }
      totals.deleted = stored.size;
      toRemove.push(...stored.values());
      if (toRemove.length > 0) {
        await this.processor.remove(toRemove);
      }
      this.store.finishRun(runId, 'succeeded', { ...totals });
    } catch (error) {
      this.store.finishRun(runId, 'failed', { ...totals });
      throw error;
    }
    return { runId, totals, secretFiles, processedFileIds: processed };
  }

  private toRecord(
    runId: number,
    file: DiscoveredFile,
    hash: string,
    pipelineVersion: string,
  ): FileRecord {
    return {
      id: fileId({ project: this.project.id, path: file.path }),
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: hash,
      lastRunId: runId,
      pipelineVersion,
    };
  }
}
