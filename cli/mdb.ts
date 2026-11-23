import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, resolveConfigPath } from '../src/config/load-config.js';
import type { ProjectConfig } from '../src/config/project-config.js';
import { describeError } from '../src/domain/errors.js';
import type { SearchFilter } from '../src/domain/ports.js';
import { toFolder } from '../src/domain/relative-path.js';
import { ProjectDiscovery } from '../src/ingestion/discovery.js';
import { formatPreview, previewIndex } from '../src/ingestion/preview.js';
import { ProjectIndexer } from '../src/ingestion/project-indexer.js';
import type { FileReader } from '../src/ingestion/sync.js';
import { duplicatesReport, formatDuplicatesReport } from '../src/knowledge/duplicates-report.js';
import { createMcpServer } from '../src/mcp/server.js';
import { formatEvalReport, loadEvalSuite, runEval } from '../src/retrieval/eval.js';
import { KnowledgeService } from '../src/retrieval/knowledge-service.js';
import { SearchService } from '../src/retrieval/search-service.js';
import { createRuntime, type RuntimeFactory, resetProject } from './runtime.js';

export const USAGE = [
  'Usage: mdb <command> <project> [options]',
  '',
  'Commands:',
  '  index <project> [--rebuild|--dry-run]  Index a single project (incremental by default)',
  '  status <project>             Show index status of a project',
  '  search <project> <query>     Search the notes of a project',
  '  duplicates <project> [--kind similar_to] [--limit n]  Review duplicates and similar chunks',
  '  eval <project> [--eval-file f]  Run the reference queries (default eval/<project>.yaml)',
  '  mcp --project <project>      Start the MCP server (stdio) for a single project',
  '',
  'Search options:',
  '  --folder <path>   restrict to a folder (repeatable)',
  '  --limit <n>       number of results (default 10)',
  '',
  'Options:',
  '  --config <path>  Configuration file (default: $MD_BRAIN_CONFIG or ./config.yaml)',
].join('\n');

export const COMMANDS = ['index', 'status', 'search', 'duplicates', 'eval', 'mcp'] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CliInvocation {
  readonly command: Command;
  readonly project: ProjectConfig;
  /** Free text after the project (empty when none). */
  readonly query: string;
  readonly rebuild: boolean;
  readonly dryRun: boolean;
  readonly filter: SearchFilter;
  readonly limit: number;
  readonly kinds: readonly ('duplicate_of' | 'similar_to')[];
  /** Reference queries: `--eval-file`, else `eval/<project>.yaml` next to the configuration. */
  readonly evalPath: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function isCommand(value: string): value is Command {
  return COMMANDS.some((command) => command === value);
}

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      project: { type: 'string' },
      rebuild: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      folder: { type: 'string', multiple: true },
      limit: { type: 'string' },
      kind: { type: 'string', multiple: true },
      'eval-file': { type: 'string' },
    },
  });
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 10;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CliUsageError(`Invalid --limit "${value}".`);
  }
  return limit;
}

export function parseInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): CliInvocation {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    throw new CliUsageError(describeError(error));
  }
  const { values, positionals } = parsed;
  if (values.all) {
    throw new CliUsageError('Processing all projects at once is not supported: name one project.');
  }
  const [command, positionalProject, ...rest] = positionals;
  if (command === undefined || !isCommand(command)) {
    throw new CliUsageError(
      command === undefined ? 'Missing command.' : `Unknown command "${command}".`,
    );
  }
  const projectId = values.project ?? positionalProject;
  if (projectId === undefined) {
    throw new CliUsageError(`Command "${command}" requires a project.`);
  }
  const queryParts = values.project === undefined ? rest : [positionalProject, ...rest];
  const query = queryParts
    .filter((part) => part !== undefined)
    .join(' ')
    .trim();
  if (command === 'search' && query.length === 0) {
    throw new CliUsageError('Command "search" requires a query.');
  }
  if ((values.rebuild || values['dry-run']) && command !== 'index') {
    throw new CliUsageError('--rebuild and --dry-run are only valid with "index".');
  }
  if (values.rebuild && values['dry-run']) {
    throw new CliUsageError('--rebuild and --dry-run cannot be combined.');
  }
  let filter: SearchFilter;
  try {
    filter = values.folder === undefined ? {} : { folders: values.folder.map(toFolder) };
  } catch (error) {
    throw new CliUsageError(describeError(error));
  }
  const limit = parseLimit(values.limit);
  const kinds = (values.kind ?? ['duplicate_of']).map((kind) => {
    if (kind !== 'duplicate_of' && kind !== 'similar_to') {
      throw new CliUsageError(`Unknown --kind "${kind}" (expected duplicate_of, similar_to).`);
    }
    return kind;
  });
  const configPath = resolveConfigPath(values.config, env);
  const config = loadConfig(configPath);
  return {
    command,
    project: config.project(projectId),
    query,
    rebuild: values.rebuild,
    dryRun: values['dry-run'],
    filter,
    limit,
    kinds,
    evalPath: resolve(
      values['eval-file'] ?? join(dirname(configPath), 'eval', `${projectId}.yaml`),
    ),
  };
}

export interface CliDependencies {
  readonly readFile: FileReader;
  readonly createRuntime: RuntimeFactory;
  readonly resetProject: (project: ProjectConfig) => Promise<void>;
  /** Serves an MCP server until its transport closes (stdio by default). */
  readonly serve: (server: McpServer) => Promise<void>;
}

/** Connects the server to stdin/stdout and resolves when the client disconnects. */
export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}

const defaultDependencies: CliDependencies = {
  readFile: readFileSync,
  createRuntime,
  resetProject,
  serve: serveStdio,
};

async function indexCommand(
  invocation: CliInvocation,
  io: CliIo,
  deps: CliDependencies,
): Promise<number> {
  const { project } = invocation;
  if (invocation.dryRun) {
    const discovery = await new ProjectDiscovery(project).discover();
    for (const line of formatPreview(previewIndex(discovery, deps.readFile))) {
      io.out(line);
    }
    return 0;
  }
  if (invocation.rebuild) {
    await deps.resetProject(project);
  }
  const runtime = deps.createRuntime(project);
  try {
    const { report, embeddings, similarity, parseFailures } = await new ProjectIndexer({
      project,
      store: runtime.store,
      vectors: runtime.vectors,
      embeddings: runtime.embeddings,
      readFile: deps.readFile,
    }).run();
    const totals = Object.entries(report.totals)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    io.out(`Indexed ${project.id} (run ${report.runId}): ${totals}`);
    io.out(
      `Embeddings (${runtime.embeddings.model}): computed=${embeddings.computed} cached=${embeddings.cached}`,
    );
    io.out(
      `Similarity: compared=${similarity.compared} duplicates=${similarity.duplicates} similar=${similarity.similar}`,
    );
    for (const path of report.secretFiles) {
      io.out(`Skipped (possible secret): ${path}`);
    }
    for (const failure of parseFailures) {
      io.out(`Not parsed (indexed without chunks): ${failure.path}: ${failure.reason}`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function searchCommand(
  invocation: CliInvocation,
  io: CliIo,
  deps: CliDependencies,
): Promise<number> {
  const runtime = deps.createRuntime(invocation.project, { readOnly: true });
  try {
    const results = await new SearchService(
      runtime.store,
      runtime.vectors,
      runtime.embeddings,
    ).search(invocation.query, invocation.filter, invocation.limit);
    if (results.length === 0) {
      io.out('No result.');
    }
    results.forEach((result, index) => {
      const ranks = Object.entries(result.ranks)
        .map(([source, rank]) => `${source}#${rank}`)
        .join(' ');
      const title = result.title === null ? '' : `  ${result.title}`;
      io.out(
        `${index + 1}. ${result.score.toFixed(4)} ${result.path}:L${result.startLine}-L${result.endLine}${title} (${ranks})`,
      );
    });
    return 0;
  } finally {
    runtime.close();
  }
}

function duplicatesCommand(invocation: CliInvocation, io: CliIo, deps: CliDependencies): number {
  const runtime = deps.createRuntime(invocation.project, { readOnly: true });
  try {
    const report = duplicatesReport(runtime.store, invocation.kinds, invocation.limit);
    for (const line of formatDuplicatesReport(report)) {
      io.out(line);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

function statusCommand(invocation: CliInvocation, io: CliIo, deps: CliDependencies): number {
  const runtime = deps.createRuntime(invocation.project, { readOnly: true });
  try {
    const overview = new KnowledgeService(
      invocation.project,
      runtime.store,
      runtime.vectors,
      runtime.embeddings,
    ).getOverview();
    const run = overview.index.lastRun;
    io.out(`Project ${overview.project.id} (${overview.project.root})`);
    io.out(`Embedding model: ${overview.index.embeddingModel}`);
    io.out(
      run === null
        ? 'Last run: none'
        : `Last run: #${run.id} at ${run.finishedAt ?? '?'} ${Object.entries(run.stats)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')}`,
    );
    io.out(`Notes: ${overview.notes} (broken links: ${overview.brokenLinks})`);
    for (const [folder, count] of Object.entries(overview.folders)) {
      io.out(`  ${folder}: ${count} notes`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function evalCommand(
  invocation: CliInvocation,
  io: CliIo,
  deps: CliDependencies,
): Promise<number> {
  const suite = loadEvalSuite(invocation.evalPath);
  const runtime = deps.createRuntime(invocation.project, { readOnly: true });
  try {
    const service = new KnowledgeService(
      invocation.project,
      runtime.store,
      runtime.vectors,
      runtime.embeddings,
    );
    const report = await runEval(service, suite);
    for (const line of formatEvalReport(report, suite)) {
      io.out(line);
    }
    return report.passed ? 0 : 1;
  } finally {
    runtime.close();
  }
}

/** MCP server over stdio: stdout carries the protocol only, nothing else is printed there. */
async function mcpCommand(invocation: CliInvocation, deps: CliDependencies): Promise<number> {
  const runtime = deps.createRuntime(invocation.project, { readOnly: true });
  try {
    const service = new KnowledgeService(
      invocation.project,
      runtime.store,
      runtime.vectors,
      runtime.embeddings,
    );
    await deps.serve(createMcpServer(invocation.project, service));
    return 0;
  } finally {
    runtime.close();
  }
}

export async function run(
  argv: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = {},
  deps: CliDependencies = defaultDependencies,
): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  let invocation: CliInvocation;
  try {
    invocation = parseInvocation(argv, env);
  } catch (error) {
    io.err(describeError(error));
    if (error instanceof CliUsageError) {
      io.err(USAGE);
    }
    return 1;
  }
  try {
    switch (invocation.command) {
      case 'index':
        return await indexCommand(invocation, io, deps);
      case 'search':
        return await searchCommand(invocation, io, deps);
      case 'duplicates':
        return duplicatesCommand(invocation, io, deps);
      case 'mcp':
        return await mcpCommand(invocation, deps);
      case 'status':
        return statusCommand(invocation, io, deps);
      case 'eval':
        return await evalCommand(invocation, io, deps);
    }
  } catch (error) {
    io.err(describeError(error));
    return 1;
  }
}

/* v8 ignore start -- process entry point, exercised by the built CLI only */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // A closed pipe (`mdb ... | head`) ends the output, it is not a failure.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
  process.exitCode = await run(
    process.argv.slice(2),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    process.env,
  );
}
/* v8 ignore stop */
