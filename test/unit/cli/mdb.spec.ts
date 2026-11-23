import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CliDependencies,
  type CliIo,
  CliUsageError,
  parseInvocation,
  run,
  USAGE,
} from '../../../cli/mdb.js';
import { UnknownProjectError } from '../../../src/config/project-config.js';
import { toProjectId } from '../../../src/domain/project-id.js';
import { SqliteMetadataStore } from '../../../src/storage/sqlite/sqlite-metadata-store.js';
import { FakeEmbeddingProvider } from '../../support/fake-embeddings.js';
import { aChunk, aFile, aPayload } from '../../support/fixtures.js';
import { InMemoryVectorStore } from '../../support/in-memory-vector-store.js';

const CONFIG = [
  'dataDir: ./data',
  'defaults:',
  '  embeddings: { provider: ollama, host: "http://h:1", model: m, dimensions: 8, queryInstruction: q }',
  '  qdrant: { url: "http://q:1" }',
  '  knowledge: { duplicateThreshold: 0.9, similarThreshold: 0.5 }',
  'projects:',
  '  demo: { name: Demo, root: ./src, include: ["**/*.md"] }',
].join('\n');

function captureIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

describe('mdb cli', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-cli-'));
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, CONFIG);
    env = { MD_BRAIN_CONFIG: configPath };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseInvocation', () => {
    it('resolves the project of a command', () => {
      const invocation = parseInvocation(['index', 'demo', '--rebuild'], env);

      expect(invocation.filter).toEqual({});
      expect(invocation.limit).toBe(10);
      expect(invocation.command).toBe('index');
      expect(invocation.project.id).toBe('demo');
      expect(invocation.rebuild).toBe(true);
      expect(invocation.dryRun).toBe(false);
      expect(invocation.query).toBe('');
    });

    it('accepts the project as an option', () => {
      expect(parseInvocation(['mcp', '--project', 'demo'], env).project.id).toBe('demo');
    });

    it('joins the search query', () => {
      expect(parseInvocation(['search', 'demo', 'toxic', 'messages'], env).query).toBe(
        'toxic messages',
      );
      expect(parseInvocation(['search', '--project', 'demo', 'toxic'], env).query).toBe('toxic');
    });

    it('normalises folder filters', () => {
      expect(
        parseInvocation(['search', 'demo', 'q', '--folder', './work/', '--folder', 'journal'], env)
          .filter,
      ).toEqual({ folders: ['work', 'journal'] });
    });

    it('uses an explicit configuration path', () => {
      expect(
        parseInvocation(['status', 'demo', '--config', env.MD_BRAIN_CONFIG ?? ''], {}).project.id,
      ).toBe('demo');
    });

    it.each([
      [['index'], 'Command "index" requires a project.'],
      [['index', '--all'], 'Processing all projects at once is not supported'],
      [['reindex', 'demo'], 'Unknown command "reindex".'],
      [['--rebuild'], 'Missing command.'],
      [['search', 'demo'], 'Command "search" requires a query.'],
      [['status', 'demo', '--rebuild'], '--rebuild and --dry-run are only valid with "index".'],
      [['status', 'demo', '--dry-run'], '--rebuild and --dry-run are only valid with "index".'],
      [['index', 'demo', '--rebuild', '--dry-run'], '--rebuild and --dry-run cannot be combined.'],
      [['index', 'demo', '--unknown'], "Unknown option '--unknown'"],
      [['search', 'demo', 'q', '--limit', '0'], 'Invalid --limit "0".'],
      [['search', 'demo', 'q', '--folder', '../up'], 'parent segments are not allowed'],
      [['search', 'demo', 'q', '--type', 'pdf'], "Unknown option '--type'"],
      [['duplicates', 'demo', '--kind', 'twins'], 'Unknown --kind "twins"'],
    ])('rejects %j', (argv, message) => {
      expect(() => parseInvocation(argv, env)).toThrow(CliUsageError);
      expect(() => parseInvocation(argv, env)).toThrow(message);
    });

    it('rejects an unknown project', () => {
      expect(() => parseInvocation(['index', 'nope'], env)).toThrow(UnknownProjectError);
    });
  });

  describe('run', () => {
    it('prints usage and fails when no argument is given', async () => {
      const io = captureIo();

      expect(await run([], io)).toBe(1);
      expect(io.stdout).toEqual([USAGE]);
    });

    it.each(['--help', '-h'])('prints usage and succeeds with %s', async (flag) => {
      const io = captureIo();

      expect(await run(['index', flag], io)).toBe(0);
      expect(io.stdout).toEqual([USAGE]);
    });

    it('prints the usage after a usage error', async () => {
      const io = captureIo();

      expect(await run(['index'], io, env)).toBe(1);
      expect(io.stderr).toEqual(['Command "index" requires a project.', USAGE]);
    });

    it('prints configuration errors without the usage', async () => {
      const io = captureIo();

      expect(await run(['index', 'nope'], io, env)).toBe(1);
      expect(io.stderr).toEqual(['Unknown project "nope". Configured projects: demo.']);
    });

    it('previews an index run without writing anything', async () => {
      const io = captureIo();
      mkdirSync(join(dir, 'src/docs'), { recursive: true });
      writeFileSync(join(dir, 'src/docs/guide.md'), '# Guide');

      expect(
        await run(['index', 'demo', '--dry-run'], io, env, {
          readFile: readFileSync,
          createRuntime: () => {
            throw new Error('no runtime for a dry run');
          },
          resetProject: async () => undefined,
          serve: async () => undefined,
        }),
      ).toBe(0);
      expect(io.stdout).toEqual(['docs: 1 notes', 'Total: 1 notes']);
      expect(existsSync(join(dir, 'data'))).toBe(false);
    });

    it('reports discovery failures of a dry run', async () => {
      const io = captureIo();
      const configPath = join(dir, 'missing-root.yaml');
      writeFileSync(configPath, CONFIG.replace('root: ./src', 'root: ./nowhere'));

      expect(await run(['index', 'demo', '--dry-run', '--config', configPath], io, env)).toBe(1);
      expect(io.stderr[0]).toContain('ENOENT');
    });

    describe('index and search', () => {
      let runtimeDir: string;
      let vectors: InMemoryVectorStore;
      let embeddings: FakeEmbeddingProvider;
      let resets: string[];
      let deps: CliDependencies;
      let indexEnv: NodeJS.ProcessEnv;

      beforeAll(() => {
        runtimeDir = mkdtempSync(join(tmpdir(), 'md-cli-index-'));
        mkdirSync(join(runtimeDir, 'root'));
        writeFileSync(
          join(runtimeDir, 'root/kb.md'),
          '# Knowledge base\n\n## Flow\nThe indexer calls ollama for every changed note.\n',
        );
        writeFileSync(
          join(runtimeDir, 'root/leak.md'),
          '# Leak\npostgresql://admin:S3cr3tValue@db.internal/core\n',
        );
        const configPath = join(runtimeDir, 'config.yaml');
        writeFileSync(configPath, CONFIG.replace('root: ./src', 'root: ./root'));
        indexEnv = { MD_BRAIN_CONFIG: configPath };
        vectors = new InMemoryVectorStore();
        embeddings = new FakeEmbeddingProvider(8);
        resets = [];
        deps = {
          readFile: readFileSync,
          createRuntime: (project, options = {}) => {
            const store = SqliteMetadataStore.open(project.sqlitePath, project.id, {
              readOnly: options.readOnly ?? false,
            });
            return { store, vectors, embeddings, close: () => store.close() };
          },
          resetProject: async (project) => {
            resets.push(project.id);
          },
          serve: async () => undefined,
        };
      });

      afterAll(() => {
        rmSync(runtimeDir, { recursive: true, force: true });
      });

      it('indexes a project and reports what was done', async () => {
        const io = captureIo();

        expect(await run(['index', 'demo', '--rebuild'], io, indexEnv, deps)).toBe(0);
        expect(resets).toEqual(['demo']);
        expect(io.stdout).toEqual([
          'Indexed demo (run 1): added=1 changed=0 touched=0 unchanged=0 deleted=0 skippedSecret=1 skippedBinary=0',
          'Embeddings (fake-bow): computed=1 cached=0',
          'Similarity: compared=0 duplicates=0 similar=0',
          'Skipped (possible secret): leak.md',
        ]);
        expect(vectors.aliasActive).toBe(true);
      });

      it('re-indexes incrementally without resetting', async () => {
        const io = captureIo();

        expect(await run(['index', 'demo'], io, indexEnv, deps)).toBe(0);
        expect(resets).toEqual(['demo']);
        expect(io.stdout[0]).toContain('unchanged=1');
      });

      it('searches a project with filters', async () => {
        const io = captureIo();

        expect(
          await run(['search', 'demo', 'ollama', 'indexer', '--limit', '3'], io, indexEnv, deps),
        ).toBe(0);
        expect(io.stdout).toEqual([
          '1. 0.0492 kb.md:L1-L4  Knowledge base > Flow (semantic#1 lexical#1)',
        ]);
      });

      it('reports when nothing matches', async () => {
        const io = captureIo();

        expect(
          await run(['search', 'demo', 'ollama', '--folder', 'none'], io, indexEnv, deps),
        ).toBe(0);
        expect(io.stdout).toEqual(['No result.']);
      });

      it('prints search results of a folder, without title', async () => {
        const io = captureIo();
        const project = toProjectId('demo');
        const store = SqliteMetadataStore.open(':memory:', project);
        const located = new InMemoryVectorStore();
        const file = aFile(project, { path: 'work/notes.md' });
        const chunk = { ...aChunk(project, file, 0, 'valkey cluster notes'), headingPath: null };
        store.replaceFile(file, [chunk]);
        await located.upsert([
          {
            id: chunk.id,
            vector: await embeddings.embedQuery('valkey cluster notes'),
            payload: aPayload({ fileId: file.id, path: file.path, folders: ['work'] }),
          },
        ]);
        const withData: CliDependencies = {
          ...deps,
          createRuntime: () => ({
            store,
            vectors: located,
            embeddings,
            close: () => store.close(),
          }),
        };

        expect(
          await run(['search', 'demo', 'valkey', '--folder', 'work'], io, indexEnv, withData),
        ).toBe(0);
        expect(io.stdout).toEqual(['1. 0.0492 work/notes.md:L1-L9 (semantic#1 lexical#1)']);
      });

      it('reviews duplicates', async () => {
        const io = captureIo();

        expect(
          await run(
            ['duplicates', 'demo', '--kind', 'similar_to', '--limit', '5'],
            io,
            indexEnv,
            deps,
          ),
        ).toBe(0);
        expect(io.stdout).toEqual([
          'Exact duplicates:',
          '  none',
          'Suggested (embeddings):',
          '  none',
        ]);
      });

      it('serves the MCP tools of the project and closes the runtime', async () => {
        const io = captureIo();
        let tools: string[] = [];
        const serving: CliDependencies = {
          ...deps,
          serve: async (server) => {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);
            const client = new Client({ name: 'test', version: '1.0.0' });
            await client.connect(clientTransport);
            tools = (await client.listTools()).tools.map((tool) => tool.name);
            await client.close();
          },
        };

        expect(await run(['mcp', '--project', 'demo'], io, indexEnv, serving)).toBe(0);
        expect(tools).toEqual(['search_notes', 'get_note', 'get_overview']);
        expect(io.stdout).toEqual([]);
      });

      it('shows the status of the index', async () => {
        const io = captureIo();

        expect(await run(['status', 'demo'], io, indexEnv, deps)).toBe(0);
        expect(io.stdout[1]).toBe('Embedding model: m');
        expect(io.stdout[2]).toMatch(/^Last run: #\d+ at /);
        expect(io.stdout[3]).toBe('Notes: 1 (broken links: 0)');
        expect(io.stdout[4]).toBe('  .: 1 notes');
      });

      it('shows the status of a project never indexed', async () => {
        const io = captureIo();
        const empty: CliDependencies = {
          ...deps,
          createRuntime: () => {
            const store = SqliteMetadataStore.open(':memory:', toProjectId('demo'));
            return { store, vectors, embeddings, close: () => store.close() };
          },
        };

        expect(await run(['status', 'demo'], io, indexEnv, empty)).toBe(0);
        expect(io.stdout.slice(2)).toEqual(['Last run: none', 'Notes: 0 (broken links: 0)']);
      });

      it('evaluates the reference queries of a project', async () => {
        const evalFile = join(runtimeDir, 'eval.yaml');
        writeFileSync(
          evalFile,
          [
            'thresholds: { recallAt5: 1, mrrAt10: 1 }',
            'queries:',
            '  - { id: flow, query: ollama indexer, expect: [kb.md] }',
          ].join('\n'),
        );
        const passing = captureIo();
        const failing = captureIo();

        expect(await run(['eval', 'demo', '--eval-file', evalFile], passing, indexEnv, deps)).toBe(
          0,
        );
        writeFileSync(evalFile, readFileSync(evalFile, 'utf8').replace('[kb.md]', '[missing.md]'));
        expect(await run(['eval', 'demo', '--eval-file', evalFile], failing, indexEnv, deps)).toBe(
          1,
        );
        expect(passing.stdout.at(-1)).toBe('Evaluation PASSED');
        expect(failing.stdout.at(-1)).toBe('Evaluation FAILED');
      });

      it('reports runtime failures', async () => {
        const io = captureIo();
        const failing: CliDependencies = {
          ...deps,
          createRuntime: () => {
            throw new Error('qdrant down');
          },
        };

        expect(await run(['search', 'demo', 'ollama'], io, indexEnv, failing)).toBe(1);
        expect(io.stderr).toEqual(['qdrant down']);
      });
    });

    it('fails clearly without reference queries for the project', async () => {
      const io = captureIo();

      expect(await run(['eval', 'demo'], io, env)).toBe(1);
      expect(io.stderr[0]).toContain('ENOENT');
    });
  });
});
