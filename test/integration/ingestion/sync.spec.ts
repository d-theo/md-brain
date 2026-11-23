import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../../../src/config/project-config.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import type { FileRecord } from '../../../src/domain/records.js';
import { ProjectDiscovery } from '../../../src/ingestion/discovery.js';
import { type FileProcessor, type FileToIndex, IndexSync } from '../../../src/ingestion/sync.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { NotesFixture } from '../../support/notes-fixture.js';
import { aProjectConfig } from '../../support/project-config.js';

const project = toProjectId('sync-test');

/** Stores files without chunks and records what it was asked to do. */
class RecordingProcessor implements FileProcessor {
  processed: string[] = [];
  removed: string[] = [];
  version = 'v1';

  constructor(private readonly store: SqliteMetadataStore) {}

  async process(file: FileToIndex): Promise<void> {
    this.processed.push(file.record.path);
    this.store.replaceFile(file.record, []);
  }

  async remove(files: readonly FileRecord[]): Promise<void> {
    for (const file of files) {
      this.removed.push(file.path);
      this.store.deleteFile(file.id);
    }
  }

  reset(): void {
    this.processed = [];
    this.removed = [];
  }
}

describe('IndexSync', () => {
  let fixture: NotesFixture;
  let config: ProjectConfig;
  let store: SqliteMetadataStore;
  let processor: RecordingProcessor;
  let reads: string[];

  async function runSync() {
    processor.reset();
    reads = [];
    return new IndexSync(config, store, new ProjectDiscovery(config), processor, (path) => {
      reads.push(path.slice(fixture.root.length + 1));
      return readFileSync(path);
    }).run();
  }

  beforeEach(() => {
    fixture = new NotesFixture(mkdtempSync(join(tmpdir(), 'md-sync-')));
    config = aProjectConfig(project, fixture.root);
    store = SqliteMetadataStore.open(config.sqlitePath, project);
    processor = new RecordingProcessor(store);
    reads = [];
    fixture.write('README.md', '# Notes');
    fixture.write('work/a.md', '# A');
    fixture.write('work/b.md', '# B');
  });

  afterEach(() => {
    store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('indexes everything on the first run, then reads nothing when nothing changed', async () => {
    const first = await runSync();

    expect(first.totals).toMatchObject({ added: 3, changed: 0, unchanged: 0, deleted: 0 });
    expect(first.processedFileIds).toHaveLength(3);

    const second = await runSync();

    expect(second.totals).toMatchObject({ added: 0, changed: 0, touched: 0, unchanged: 3 });
    expect(reads).toEqual([]);
    expect(processor.processed).toEqual([]);
    expect(store.getRun(second.runId)).toMatchObject({ status: 'succeeded', stats: second.totals });
  });

  it('re-processes only modified notes', async () => {
    await runSync();
    fixture.write('work/a.md', '# A, edited');

    const report = await runSync();

    expect(report.totals).toMatchObject({ changed: 1, unchanged: 2 });
    expect(processor.processed).toEqual(['work/a.md']);
    expect(store.getFile('work/a.md')?.lastRunId).toBe(report.runId);
  });

  it('only touches a note whose stat changed but not its content', async () => {
    await runSync();
    fixture.write('work/b.md', '# B');

    const report = await runSync();

    expect(report.totals).toMatchObject({ touched: 1, changed: 0, unchanged: 2 });
    expect(reads).toEqual(['work/b.md']);
    expect(processor.processed).toEqual([]);
    expect(store.getFile('work/b.md')?.lastRunId).toBe(report.runId);
  });

  it('re-processes notes indexed by another chunker version, without changes on disk', async () => {
    await runSync();
    processor.version = 'v2';

    const report = await runSync();

    expect(report.totals).toMatchObject({ changed: 3, unchanged: 0 });
    expect(store.getFile('README.md')?.pipelineVersion).toBe('v2');
  });

  it('handles deletions, renames and additions', async () => {
    await runSync();
    renameSync(join(fixture.root, 'work/b.md'), join(fixture.root, 'work/renamed.md'));
    fixture.remove('README.md');
    fixture.write('journal/c.md', '# C');

    const report = await runSync();

    expect(report.totals).toMatchObject({ added: 2, deleted: 2, unchanged: 1 });
    expect(processor.processed.sort()).toEqual(['journal/c.md', 'work/renamed.md']);
    expect(processor.removed.sort()).toEqual(['README.md', 'work/b.md']);
    expect(store.listFiles().map((file) => file.path)).toEqual([
      'journal/c.md',
      'work/a.md',
      'work/renamed.md',
    ]);
  });

  it('removes a note that now looks like it contains a secret, and never processes it', async () => {
    await runSync();
    fixture.write('work/a.md', 'db: postgresql://admin:S3cr3tValue@db/core');
    fixture.write('work/leak.md', 'db: postgresql://admin:S3cr3tValue@db/core');

    const report = await runSync();

    expect([...report.secretFiles].sort()).toEqual(['work/a.md', 'work/leak.md']);
    expect(report.totals).toMatchObject({ skippedSecret: 2, deleted: 0 });
    expect(processor.processed).toEqual([]);
    expect(processor.removed).toEqual(['work/a.md']);
    expect(store.getFile('work/a.md')).toBeUndefined();
  });

  it('skips binary files and removes them if they were indexed', async () => {
    await runSync();
    fixture.write('work/b.md', 'binary\0content');

    const report = await runSync();

    expect(report.totals).toMatchObject({ skippedBinary: 1 });
    expect(processor.removed).toEqual(['work/b.md']);
  });

  it('marks the run as failed when processing fails', async () => {
    const failing: FileProcessor = {
      version: 'v1',
      process: async () => {
        throw new Error('embedding down');
      },
      remove: async () => undefined,
    };
    const run = new IndexSync(config, store, new ProjectDiscovery(config), failing);

    await expect(run.run()).rejects.toThrow('embedding down');
    expect(store.latestRun()).toBeUndefined();
    expect(store.getRun(1)?.status).toBe('failed');
  });
});
