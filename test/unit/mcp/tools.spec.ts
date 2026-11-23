import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/domain/content-hash.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import { runTool, TOOL_DEFINITIONS, TOOL_INPUTS } from '../../../src/mcp/tools.js';
import { KnowledgeService } from '../../../src/retrieval/knowledge-service.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { FakeEmbeddingProvider } from '../../support/fake-embeddings.js';
import { aChunk, aFile, aPayload } from '../../support/fixtures.js';
import { InMemoryVectorStore } from '../../support/in-memory-vector-store.js';
import { aProjectConfig } from '../../support/project-config.js';

const project = toProjectId('tools-test');

async function serviceWithStaleHit() {
  const store = SqliteMetadataStore.open(':memory:', project);
  const file = aFile(project, { path: 'work/missing.md', contentHash: 'indexed-hash' });
  const chunk = { ...aChunk(project, file, 0, 'valkey cluster notes'), headingPath: null };
  store.replaceFile(file, [chunk]);
  const vectors = new InMemoryVectorStore();
  const embeddings = new FakeEmbeddingProvider(8);
  await vectors.upsert([
    {
      id: chunk.id,
      vector: await embeddings.embedQuery('valkey'),
      payload: aPayload({ fileId: file.id, path: file.path }),
    },
  ]);
  return {
    store,
    service: new KnowledgeService(
      aProjectConfig(project, '/nonexistent-root'),
      store,
      vectors,
      embeddings,
    ),
  };
}

describe('mcp tools', () => {
  it('defines a title and a description for every tool', () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toEqual(Object.keys(TOOL_INPUTS));
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      expect(definition.description.length).toBeGreaterThan(40);
    }
  });

  it('flags excerpts of notes that changed or disappeared', async () => {
    const { store, service } = await serviceWithStaleHit();

    const result = await runTool(service, 'search_notes', { query: 'valkey' });

    expect(result).toEqual({
      isError: false,
      text: '1. work/missing.md:L1-L9 (semantic, lexical)\n   STALE: file changed since indexing, re-read it',
    });
    store.close();
  });

  it('renders titles and flags truncated excerpts of long sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'md-tools-'));
    const content = ['# Long', ...Array.from({ length: 60 }, (_, index) => `line ${index}`)].join(
      '\n',
    );
    writeFileSync(join(root, 'long.md'), content);
    const store = SqliteMetadataStore.open(':memory:', project);
    const file = aFile(project, { path: 'long.md', contentHash: sha256(content) });
    const chunk = { ...aChunk(project, file, 0, 'valkey long section'), startLine: 1, endLine: 61 };
    store.replaceFile(file, [chunk]);
    const vectors = new InMemoryVectorStore();
    const embeddings = new FakeEmbeddingProvider(8);
    await vectors.upsert([
      {
        id: chunk.id,
        vector: await embeddings.embedQuery('valkey'),
        payload: aPayload({ fileId: file.id, path: file.path }),
      },
    ]);
    const service = new KnowledgeService(aProjectConfig(project, root), store, vectors, embeddings);

    const result = await runTool(service, 'search_notes', { query: 'valkey' });

    expect(result.text.split('\n').slice(0, 3)).toEqual([
      '1. long.md:L1-L61 — Section 0 (semantic, lexical)',
      '   excerpt truncated',
      '```markdown',
    ]);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects invalid arguments', async () => {
    const { store, service } = await serviceWithStaleHit();

    const result = await runTool(service, 'search_notes', { query: '' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Invalid arguments:/);
    store.close();
  });

  it('turns unexpected failures into tool errors', async () => {
    const { store, service } = await serviceWithStaleHit();
    store.close();

    const result = await runTool(service, 'get_overview', {});

    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });
});
