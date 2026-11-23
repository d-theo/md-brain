import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectIndexer } from '../../../src/ingestion/project-indexer.js';
import { E2eProject } from '../../support/e2e-project.js';
import { FakeEmbeddingProvider } from '../../support/fake-embeddings.js';
import { SHARED_CHECKLIST } from '../../support/mini-notes.js';

const GUIDE = [
  '# Guide', // 1
  'Personal knowledge base: architecture notes, journal entries, recipes and reading lists.', // 2
  '', // 3
  '## Local setup', // 4
  'Start qdrant and valkey with docker compose before running the indexer on your machine.', // 5
  '', // 6
  '## Tests', // 7
  'Run the integration tests against a real qdrant started by the docker compose file. See [kb](kb.md).', // 8
].join('\n');

describe('ProjectIndexer', () => {
  let project: E2eProject;

  beforeEach(() => {
    project = new E2eProject();
    project.fixture.write('work/guide.md', GUIDE);
    project.fixture.write('work/kb.md', '# KB\n\nShort note.\n');
  });

  afterEach(async () => {
    await project.dispose();
  });

  it('indexes Markdown chunks with exact lines into SQLite, FTS and Qdrant', async () => {
    const { report, embeddings } = await project.index();

    expect(report.totals).toMatchObject({ added: 2 });
    expect(embeddings).toEqual({ requested: 4, cached: 0, computed: 4 });
    const file = project.store.getFile('work/guide.md');
    const chunks = project.store.listChunks(file?.id ?? '');
    expect(chunks.map((chunk) => [chunk.headingPath, chunk.startLine, chunk.endLine])).toEqual([
      ['Guide', 1, 2],
      ['Guide > Local setup', 4, 5],
      ['Guide > Tests', 7, 8],
    ]);
    expect(chunks.every((chunk) => chunk.embeddedModel === 'fake-bow')).toBe(true);
    expect(file?.pipelineVersion).toBe('markdown-1');
    expect(await project.vectors.count()).toBe(4);
    expect(await project.vectors.count({ folders: ['work'] })).toBe(4);
    expect(project.store.countLexicalMatches('valkey')).toBe(1);
    expect(project.store.relationsOfKind(['md_link']).map((link) => link.dstRef)).toEqual([
      'work/kb.md',
    ]);
    const aliases = await project.client.getCollectionAliases(project.config.collection.collection);
    expect(aliases.aliases.map((alias) => alias.alias_name)).toEqual([
      project.config.collection.alias,
    ]);
  });

  it('re-embeds only the chunks whose text changed', async () => {
    await project.index();
    project.fixture.write('work/guide.md', GUIDE.replace('real qdrant', 'disposable qdrant'));

    const { report, embeddings } = await project.index();

    expect(report.totals).toMatchObject({ changed: 1, unchanged: 1 });
    expect(embeddings).toEqual({ requested: 3, cached: 2, computed: 1 });
    expect(await project.vectors.count()).toBe(4);
  });

  it('sends nothing to the model when nothing changed, and never prefixes documents', async () => {
    await project.index();
    const calls = project.embeddings.embeddedDocuments;

    const { embeddings } = await project.index();

    expect(embeddings.requested).toBe(0);
    expect(project.embeddings.embeddedDocuments).toBe(calls);
    expect(project.embeddings.queryCalls).toEqual([]);
    expect(
      project.embeddings.documentCalls.flat().some((text) => text.startsWith('Instruct:')),
    ).toBe(false);
  });

  it('removes vectors, chunks and links of deleted notes', async () => {
    await project.index();
    project.fixture.remove('work/guide.md');

    await project.index();

    expect(await project.vectors.count()).toBe(1);
    expect(project.store.countLexicalMatches('valkey')).toBe(0);
    expect(project.store.relationsOfKind(['md_link'])).toEqual([]);
  });

  it('links identical sections of different notes', async () => {
    project.fixture.write('journal/a.md', `# A\n\nMonday.\n\n${SHARED_CHECKLIST}`);
    project.fixture.write('journal/b.md', `# B\n\nTuesday.\n\n${SHARED_CHECKLIST}`);

    const { similarity } = await project.index();

    expect(similarity.duplicates + similarity.similar).toBeGreaterThanOrEqual(1);
    expect(project.store.relationsOfKind(['duplicate_of', 'similar_to'])).not.toEqual([]);
    expect(project.store.duplicateGroups(10, 20).map((group) => group.length)).toEqual([2]);
  });

  it('indexes notes that cannot be parsed without chunks and reports them', async () => {
    const failing = new ProjectIndexer({
      project: project.config,
      store: project.store,
      vectors: project.vectors,
      embeddings: project.embeddings,
      chunker: {
        version: 'broken-1',
        chunk: () => {
          throw new Error('parser crashed');
        },
      },
    });

    const { parseFailures } = await failing.run();

    expect(parseFailures).toEqual([
      { path: 'work/guide.md', reason: 'parser crashed' },
      { path: 'work/kb.md', reason: 'parser crashed' },
    ]);
    const guide = project.store.getFile('work/guide.md');
    expect(guide?.pipelineVersion).toBe('broken-1');
    expect(project.store.listChunks(guide?.id ?? '')).toEqual([]);
  });

  it('refuses to reuse an index built with another embedding model', async () => {
    await project.index();
    const other = new ProjectIndexer({
      project: project.config,
      store: project.store,
      vectors: project.vectors,
      embeddings: Object.assign(new FakeEmbeddingProvider(), { model: 'another-model' }),
    });

    await expect(other.run()).rejects.toThrow('rebuild the project to change model');
  });
});
