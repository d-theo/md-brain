import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeService, NotFoundError } from '../../../src/retrieval/knowledge-service.js';
import { E2eProject } from '../../support/e2e-project.js';
import { writeMiniNotes } from '../../support/mini-notes.js';

const ARCHITECTURE = 'work/kb/architecture.md';
const JOURNAL = 'journal/2026-11-23.md';

describe('KnowledgeService', () => {
  let project: E2eProject;
  let service: KnowledgeService;

  beforeAll(async () => {
    project = new E2eProject();
    writeMiniNotes(project.fixture);
    await project.index();
    service = new KnowledgeService(
      project.config,
      project.store,
      project.vectors,
      project.embeddings,
    );
  });

  afterAll(async () => {
    await project.dispose();
  });

  describe('search', () => {
    it('returns ranked sections with locations and excerpts read from disk', async () => {
      const hits = await service.search('ollama qdrant vectors indexer', { limit: 5 });
      const architecture = hits.find((hit) => hit.path === ARCHITECTURE);

      expect(architecture).toMatchObject({
        location: `${ARCHITECTURE}:L1-L4`,
        title: 'Architecture',
        excerpt: { stale: false, missing: false },
      });
      expect(architecture?.excerpt?.text).toContain('embeds them with Ollama');
      expect(architecture?.matchedBy).toContain('semantic');
    });

    it('restricts the search to folders given in any reasonable form', async () => {
      const hits = await service.search('spaghetti garlic', { folders: ['./personal/'] });

      expect(hits.map((hit) => hit.path)).toEqual(['personal/recipes/pasta.md']);
    });

    it('stops adding excerpts when the context budget is spent', async () => {
      const hits = await service.search('notes journal architecture', {
        limit: 4,
        maxContextChars: 10,
      });

      expect(hits.length).toBeGreaterThan(1);
      expect(hits[0]?.excerpt).not.toBeNull();
      expect(hits.slice(1).every((hit) => hit.excerpt === null)).toBe(true);
    });

    it('never returns excluded or secret-bearing notes', async () => {
      const hits = await service.search('wifi admin password old archive', { limit: 20 });

      expect(hits.map((hit) => hit.path)).not.toContain('personal/leak.md');
      expect(hits.map((hit) => hit.path)).not.toContain('work/archive/old.md');
    });
  });

  describe('getNote', () => {
    it('describes a note: sections, links, backlinks, similar sections and excerpt', () => {
      const note = service.getNote(ARCHITECTURE);

      expect(note.location).toBe(ARCHITECTURE);
      expect(note.stale).toBe(false);
      expect(note.sections).toEqual([
        { title: 'Architecture', lines: 'L1-L4' },
        { title: 'Architecture > Storage', lines: 'L6-L11' },
        { title: 'Architecture > Checklist', lines: 'L13-L15' },
      ]);
      expect(note.links).toEqual([
        { target: 'work/kb/embeddings.md', line: 4, note: 'work/kb/embeddings.md' },
        { target: 'README.md', line: 4, note: 'README.md' },
        { target: 'work/storage.md', line: 11, note: null },
      ]);
      expect(note.backlinks.map((link) => link.from).sort()).toEqual([
        'README.md',
        JOURNAL,
        'work/kb/embeddings.md',
      ]);
      expect(note.similar.some((entry) => entry.target.startsWith(`${JOURNAL}:L`))).toBe(true);
      expect(note.excerpt.text.split('\n')[0]).toBe('# Architecture');
    });

    it('accepts path suffixes, locations and line ranges', () => {
      const note = service.getNote('kb/embeddings.md:L1-L3', 3, 4);

      expect(note.location).toBe('work/kb/embeddings.md');
      expect(note.excerpt).toMatchObject({ startLine: 3, endLine: 4 });
      expect(note.links).toEqual([{ target: 'work/kb/architecture', line: 4, note: ARCHITECTURE }]);
      expect(note.backlinks).toEqual([{ from: ARCHITECTURE, line: 4 }]);
    });

    it('flags notes changed on disk since indexing', () => {
      writeFileSync(join(project.fixture.root, 'personal/recipes/pasta.md'), '# Pasta\nedited');

      expect(service.getNote('pasta.md').stale).toBe(true);
    });

    it('rejects unknown and ambiguous paths', () => {
      expect(() => service.getNote('nope.md')).toThrow(NotFoundError);
      expect(() => service.getNote('.md')).toThrow(NotFoundError);
      expect(() => service.getNote('md')).toThrow('No indexed note matches "md".');
    });
  });

  describe('getOverview', () => {
    it('summarises folders, most linked notes, broken links and index state', () => {
      const overview = service.getOverview();

      expect(overview.project.id).toBe(project.config.id);
      expect(overview.index.embeddingModel).toBe('fake-bow');
      expect(overview.index.lastRun?.stats).toMatchObject({ added: 5, skippedSecret: 1 });
      expect(overview.notes).toBe(5);
      expect(overview.folders).toEqual({ '.': 1, journal: 1, personal: 1, work: 2 });
      expect(overview.mostLinked[0]).toEqual({ path: ARCHITECTURE, backlinks: 3 });
      expect(overview.mostLinked).toHaveLength(4);
      expect(overview.brokenLinks).toBe(2);
    });
  });
});
