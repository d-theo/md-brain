import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchError, SearchService } from '../../../src/retrieval/search-service.js';
import { E2eProject } from '../../support/e2e-project.js';

describe('SearchService', () => {
  let project: E2eProject;
  let search: SearchService;

  beforeAll(async () => {
    project = new E2eProject();
    const { fixture } = project;
    fixture.write(
      'README.md',
      '# Notes\n\n## Flux principal\nL’indexeur découpe les notes, appelle Ollama puis écrit dans Qdrant.\n',
    );
    fixture.write(
      'work/kb.md',
      '# Knowledge base\n\n## Allowlist\nThe allowlist migration replaces the whitelist notes.\n\n## Valkey\nThe cache lives in a valkey cluster.\n',
    );
    fixture.write('work/archive-notes/old.md', '# Old\nallowlist notes kept in another folder.\n');
    fixture.write(
      'journal/2026-11-23.md',
      '# 2026-11-23\n\n## Detection\nShort texts such as player names are checked by ollama.\n',
    );
    await project.index();
    search = new SearchService(project.store, project.vectors, project.embeddings);
  });

  afterAll(async () => {
    await project.dispose();
  });

  it('fuses semantic and lexical hits and points at the exact source lines', async () => {
    const [first] = await search.search('allowlist migration', {}, 5);

    expect(first).toMatchObject({
      path: 'work/kb.md',
      title: 'Knowledge base > Allowlist',
      startLine: 1,
      endLine: 4,
    });
    expect(Object.keys(first?.ranks ?? {}).sort()).toEqual(['lexical', 'semantic']);
  });

  it('matches French queries regardless of accents', async () => {
    const [first] = await search.search('decoupe des notes par l’indexeur', {}, 3);

    expect(first).toMatchObject({ path: 'README.md', title: 'Notes > Flux principal' });
  });

  it('filters by folder, subfolders included', async () => {
    const inWork = await search.search('allowlist', { folders: ['work'] }, 10);
    const inJournal = await search.search('allowlist', { folders: ['journal'] }, 10);

    expect([...new Set(inWork.map((result) => result.path))].sort()).toEqual([
      'work/archive-notes/old.md',
      'work/kb.md',
    ]);
    expect(inJournal.every((result) => result.path.startsWith('journal/'))).toBe(true);
  });

  it('prefixes queries for the model and only uses semantic search without terms', async () => {
    const results = await search.search('le la de', {}, 3);

    expect(results.every((result) => Object.keys(result.ranks).join() === 'semantic')).toBe(true);
    expect(project.embeddings.queryCalls.at(-1)).toBe('le la de');
  });

  it('returns at most two chunks per note', async () => {
    const results = await search.search('allowlist valkey cluster migration notes', {}, 10);
    const perNote = new Map<string, number>();
    for (const result of results) {
      perNote.set(result.path, (perNote.get(result.path) ?? 0) + 1);
    }

    expect(Math.max(...perNote.values())).toBeLessThanOrEqual(2);
  });

  it('drops vectors unknown to SQLite', async () => {
    const file = project.store.getFile('work/kb.md');
    const chunks = project.store.listChunks(file?.id ?? '');
    project.store.deleteFile(file?.id ?? '');

    const results = await search.search('valkey cluster', {}, 10);

    expect(results.map((result) => result.chunkId)).not.toContain(chunks[0]?.id);
  });

  it.each([
    ['', 10],
    ['x'.repeat(2_001), 10],
    ['valid', 0],
    ['valid', 51],
  ])('rejects the query %j with limit %s', async (query, limit) => {
    await expect(search.search(query, {}, limit)).rejects.toThrow(SearchError);
  });
});
