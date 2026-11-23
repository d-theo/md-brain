import type { ProjectConfig } from '../config/project-config.js';
import type {
  EmbeddingProvider,
  MetadataStore,
  SearchFilter,
  VectorStore,
} from '../domain/ports.js';
import type { FileRecord, RelationRecord } from '../domain/records.js';
import { toFolder, topFolder } from '../domain/relative-path.js';
import { SIMILARITY_KINDS } from '../knowledge/similarity.js';
import { SearchService } from './search-service.js';
import { type Excerpt, SourceReader } from './source-reader.js';

const EXCERPT_LINES = 40;
const CONTEXT_CHARS = 16_000;
const NOTE_EXCERPT_LINES = 200;
const MOST_LINKED = 10;

export interface SearchOptions {
  /** Total characters of excerpts returned (the first hits get theirs). */
  readonly maxContextChars?: number | undefined;
  readonly folders?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface Hit {
  readonly location: string;
  readonly path: string;
  readonly title: string | null;
  readonly score: number;
  readonly matchedBy: readonly string[];
  readonly excerpt: Excerpt | null;
}

export interface OutgoingLink {
  readonly target: string;
  readonly line: number | null;
  /** Indexed note the link points at, null when the target is not an indexed note. */
  readonly note: string | null;
}

export interface NoteContext {
  readonly location: string;
  readonly stale: boolean;
  readonly sections: readonly { title: string | null; lines: string }[];
  readonly links: readonly OutgoingLink[];
  readonly backlinks: readonly { from: string; line: number | null }[];
  readonly similar: readonly { kind: string; target: string; score: number }[];
  readonly excerpt: Excerpt;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Without extension: `[x](note)` and `[x](note.md)` point at the same note. */
function withoutExtension(path: string): string {
  return path.replace(/\.(md|markdown)$/i, '');
}

/** Indexed note a link target designates (exact path, else the same path with an extension). */
export function resolveLinkTarget(target: string, notes: ReadonlySet<string>): string | null {
  if (notes.has(target)) {
    return target;
  }
  return [`${target}.md`, `${target}.markdown`].find((candidate) => notes.has(candidate)) ?? null;
}

/** Every agent-facing operation of one project, independent of the transport (MCP, CLI). */
export class KnowledgeService {
  private readonly searchService: SearchService;

  constructor(
    private readonly project: ProjectConfig,
    private readonly store: MetadataStore,
    vectors: VectorStore,
    embeddings: EmbeddingProvider,
    private readonly sources: () => SourceReader = () => new SourceReader(project.root),
  ) {
    this.searchService = new SearchService(store, vectors, embeddings);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Hit[]> {
    const filter: SearchFilter =
      options.folders === undefined ? {} : { folders: options.folders.map(toFolder) };
    const results = await this.searchService.search(query, filter, options.limit ?? 8);
    const reader = this.sources();
    let budget = options.maxContextChars ?? CONTEXT_CHARS;
    return results.map((result) => {
      const file = this.store.getFile(result.path);
      const excerpt =
        file === undefined || budget <= 0
          ? null
          : reader.excerpt(file, result.startLine, result.endLine, EXCERPT_LINES);
      budget -= excerpt?.text.length ?? 0;
      return {
        location: `${result.path}:L${result.startLine}-L${result.endLine}`,
        path: result.path,
        title: result.title,
        score: Number(result.score.toFixed(4)),
        matchedBy: Object.keys(result.ranks),
        excerpt,
      };
    });
  }

  getNote(path: string, startLine?: number, endLine?: number): NoteContext {
    const file = this.resolveFile(path);
    const notes = new Set(this.store.listFiles().map((note) => note.path));
    const chunks = this.store.listChunks(file.id);
    const chunkIds = chunks.map((chunk) => chunk.id);
    const excerpt = this.sources().excerpt(
      file,
      startLine ?? 1,
      endLine ?? (startLine ?? 1) + NOTE_EXCERPT_LINES - 1,
      NOTE_EXCERPT_LINES,
    );
    return {
      location: file.path,
      stale: excerpt.stale,
      sections: chunks.map((chunk) => ({
        title: chunk.headingPath,
        lines: `L${chunk.startLine}-L${chunk.endLine}`,
      })),
      links: this.store.relationsFrom(chunkIds, ['md_link']).map((relation) => ({
        target: relation.dstRef,
        line: relation.line,
        note: resolveLinkTarget(relation.dstRef, notes),
      })),
      backlinks: this.backlinks(file),
      similar: this.similar(this.store.relationsAround(chunkIds, SIMILARITY_KINDS), chunkIds),
      excerpt,
    };
  }

  getOverview() {
    const files = this.store.listFiles();
    const notes = new Set(files.map((file) => file.path));
    const folders: Record<string, number> = {};
    for (const file of files) {
      const folder = topFolder(file.path);
      folders[folder] = (folders[folder] ?? 0) + 1;
    }
    const incoming = new Map<string, Set<string>>();
    let brokenLinks = 0;
    for (const relation of this.store.relationsOfKind(['md_link'])) {
      const target = resolveLinkTarget(relation.dstRef, notes);
      if (target === null) {
        brokenLinks += 1;
      } else {
        incoming.set(target, (incoming.get(target) ?? new Set()).add(relation.fileId));
      }
    }
    const run = this.store.latestRun();
    return {
      project: { id: this.project.id, name: this.project.name, root: this.project.root },
      index: {
        embeddingModel: this.project.embeddings.model,
        lastRun:
          run === undefined ? null : { id: run.id, finishedAt: run.finishedAt, stats: run.stats },
      },
      notes: files.length,
      folders,
      mostLinked: [...incoming.entries()]
        .map(([path, sources]) => ({ path, backlinks: sources.size }))
        .sort((a, b) => b.backlinks - a.backlinks || a.path.localeCompare(b.path))
        .slice(0, MOST_LINKED),
      brokenLinks,
    };
  }

  /** Links of other notes pointing at this one (with or without its extension). */
  private backlinks(file: FileRecord) {
    const refs = [...new Set([file.path, withoutExtension(file.path)])];
    const sources = new Map(
      this.store
        .relationsTo(refs, ['md_link'])
        .filter((relation) => relation.fileId !== file.id)
        .map((relation) => [relation.fileId, relation]),
    );
    return [...sources.values()].flatMap((relation) => {
      const source = this.store.getFileById(relation.fileId);
      return source === undefined ? [] : [{ from: source.path, line: relation.line }];
    });
  }

  private similar(relations: readonly RelationRecord[], ownChunks: readonly string[]) {
    const own = new Set(ownChunks);
    const otherEnd = (relation: RelationRecord): string =>
      own.has(relation.srcId) ? relation.dstRef : relation.srcId;
    const contexts = this.store.getChunkContexts(relations.map(otherEnd));
    return relations.flatMap((relation) => {
      const other = contexts.get(otherEnd(relation));
      return other === undefined
        ? []
        : [
            {
              kind: relation.kind,
              target: `${other.file.path}:L${other.chunk.startLine}-L${other.chunk.endLine}`,
              score: Number((relation.score ?? 0).toFixed(3)),
            },
          ];
    });
  }

  private resolveFile(path: string): FileRecord {
    const files = this.store.findFilesByPath(
      path.replace(/^\.?\//, '').replace(/:L\d+(-L\d+)?$/, ''),
    );
    const [file] = files;
    if (file === undefined) {
      throw new NotFoundError(`No indexed note matches "${path}".`);
    }
    if (files.length > 1) {
      throw new NotFoundError(
        `"${path}" is ambiguous: ${files
          .slice(0, 10)
          .map((candidate) => candidate.path)
          .join(', ')}.`,
      );
    }
    return file;
  }
}
