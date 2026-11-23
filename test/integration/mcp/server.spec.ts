import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../../src/mcp/server.js';
import { KnowledgeService } from '../../../src/retrieval/knowledge-service.js';
import { E2eProject } from '../../support/e2e-project.js';
import { writeMiniNotes } from '../../support/mini-notes.js';

describe('MCP server', () => {
  let project: E2eProject;
  let client: Client;

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content;
    return {
      isError: result.isError === true,
      text: content !== undefined && content.type === 'text' ? content.text : '',
    };
  }

  beforeAll(async () => {
    project = new E2eProject();
    writeMiniNotes(project.fixture);
    await project.index();
    const service = new KnowledgeService(
      project.config,
      project.store,
      project.vectors,
      project.embeddings,
    );
    const server = createMcpServer(project.config, service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await project.dispose();
  });

  it('exposes the read-only tools of one project, without project parameter', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['search_notes', 'get_note', 'get_overview']);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.some((tool) => JSON.stringify(tool.inputSchema).includes('"project"'))).toBe(
      false,
    );
    expect(client.getServerVersion()?.name).toBe(`md-${project.config.id}`);
    expect(client.getInstructions()).toContain('get_overview first');
  });

  it('searches notes, rendering locations and excerpts as text', async () => {
    const found = await call('search_notes', { query: 'ollama qdrant indexer', limit: 2 });
    const nothing = await call('search_notes', { query: 'anything', folders: ['nowhere'] });

    expect(found.isError).toBe(false);
    expect(found.text).toMatch(/^1\. \S+:L\d+-L\d+ — /);
    expect(found.text).toContain('work/kb/architecture.md:L1-L4 — Architecture (semantic');
    expect(found.text).toContain('```markdown\n# Architecture');
    expect(nothing.text).toBe('No result.');
  });

  it('describes a note and the collection as JSON', async () => {
    const note = JSON.parse(
      (await call('get_note', { path: 'architecture.md', startLine: 1, endLine: 2 })).text,
    );
    const overview = JSON.parse((await call('get_overview')).text);

    expect(note.location).toBe('work/kb/architecture.md');
    expect(note.excerpt).toMatchObject({ startLine: 1, endLine: 2, text: '# Architecture\n' });
    expect(note.backlinks.length).toBe(3);
    expect(overview.notes).toBe(5);
    expect(overview.brokenLinks).toBe(2);
  });

  it('reports invalid arguments and unknown notes as tool errors', async () => {
    const invalid = await call('get_note', { path: '', startLine: 0 });
    const unknown = await call('get_note', { path: 'nope.md' });
    const escaping = await call('search_notes', { query: 'x', folders: ['../outside'] });

    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('Invalid arguments');
    expect(unknown).toEqual({ isError: true, text: 'No indexed note matches "nope.md".' });
    expect(escaping.isError).toBe(true);
    expect(escaping.text).toContain('parent segments are not allowed');
  });
});
