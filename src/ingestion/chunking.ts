import { posix } from 'node:path';
import { lastPart } from '../domain/collections.js';
import { contentHash } from '../domain/content-hash.js';
import { chunkId } from '../domain/ids.js';
import type { ProjectId } from '../domain/project-id.js';
import type { ChunkInput, RelationInput } from '../domain/records.js';
import { type MarkdownReference, type MarkdownSection, parseMarkdown } from './parsers/markdown.js';

export interface ChunkSource {
  readonly project: ProjectId;
  readonly path: string;
  readonly content: string;
}

export interface PreparedChunk {
  readonly chunk: ChunkInput;
  /** Text sent to the embedding model: location header + chunk text. */
  readonly embedText: string;
}

export interface ParsedFile {
  readonly chunks: readonly PreparedChunk[];
  readonly relations: readonly RelationInput[];
}

export interface Chunker {
  /** Bump whenever the output changes, so that already indexed files are re-chunked. */
  readonly version: string;
  chunk(source: ChunkSource): ParsedFile;
}

/** Characters of chunk text sent to the embedding model (the lexical index keeps it all). */
export const MAX_EMBED_CHARS = 8_000;

interface ChunkSpec {
  readonly anchor: string;
  readonly part: number;
  readonly headingPath: string | null;
  readonly title: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

/** Builds stored chunks (with stable ids) and their embedding texts from chunk specs. */
function buildChunks(source: ChunkSource, specs: readonly ChunkSpec[]): PreparedChunk[] {
  const file = { project: source.project, path: source.path };
  return specs.map((spec, ordinal) => ({
    chunk: {
      id: chunkId(file, spec.anchor, spec.part),
      ordinal,
      anchor: spec.anchor,
      headingPath: spec.headingPath,
      startLine: spec.startLine,
      endLine: spec.endLine,
      contentHash: contentHash(spec.text),
      tokenCount: estimateTokens(spec.text),
      text: spec.text,
      title: spec.title,
    },
    embedText: `${source.path}\n${spec.title}\n\n${spec.text.slice(0, MAX_EMBED_CHARS)}`,
  }));
}

/** 1-based inclusive line slicing helper. */
export function lineSlicer(content: string): (start: number, end: number) => string {
  const lines = content.split(/\r?\n/);
  return (start, end) => lines.slice(start - 1, end).join('\n');
}

/** Rough token estimate (~4 characters per token), enough to size chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MarkdownChunkerOptions {
  readonly maxTokens: number;
}

const DEFAULT_MARKDOWN_OPTIONS: MarkdownChunkerOptions = { maxTokens: 800 };

interface Span {
  readonly headings: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One chunk per heading section (H1-H3). Heading-only sections (a title directly followed by a
 * sub-title) are merged into the next one; long sections are split on block boundaries with one
 * block of overlap. Tables and code blocks are never cut.
 */
export class MarkdownChunker implements Chunker {
  readonly version = 'markdown-1';

  constructor(private readonly options: MarkdownChunkerOptions = DEFAULT_MARKDOWN_OPTIONS) {}

  chunk(source: ChunkSource): ParsedFile {
    const slice = lineSlicer(source.content);
    const document = parseMarkdown(source.content);
    const sections = this.mergeHeadingOnly(document.sections);
    const occurrences = new Map<string, number>();
    const specs: ChunkSpec[] = [];
    const fileName = lastPart(source.path, '/');
    for (const section of sections) {
      const headingPath = section.headings.join(' > ');
      const base = headingPath === '' ? '(preamble)' : headingPath;
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const anchor = occurrence === 0 ? base : `${base} #${occurrence + 1}`;
      const title = headingPath === '' ? fileName : headingPath;
      this.split(section, slice).forEach((span, part) => {
        specs.push({
          anchor,
          part,
          headingPath: headingPath === '' ? null : headingPath,
          title,
          startLine: span.startLine,
          endLine: span.endLine,
          text: slice(span.startLine, span.endLine),
        });
      });
    }
    const chunks = buildChunks(source, specs);
    return { chunks, relations: markdownLinks(source.path, chunks, document.references) };
  }

  private mergeHeadingOnly(sections: readonly MarkdownSection[]): MarkdownSection[] {
    const merged: MarkdownSection[] = [];
    let pending: MarkdownSection | undefined;
    for (const section of sections) {
      const current: MarkdownSection =
        pending === undefined
          ? section
          : {
              ...section,
              startLine: pending.startLine,
              blocks: [...pending.blocks, ...section.blocks],
            };
      pending = undefined;
      const isLast = section === sections.at(-1);
      if (!isLast && section.blocks.length === 1 && section.headings.length > 0) {
        pending = current;
      } else {
        merged.push(current);
      }
    }
    return merged;
  }

  private split(section: MarkdownSection, slice: (start: number, end: number) => string): Span[] {
    if (estimateTokens(slice(section.startLine, section.endLine)) <= this.options.maxTokens) {
      return [section];
    }
    const spans: Span[] = [];
    let first = 0;
    while (first < section.blocks.length) {
      let last = first;
      while (
        last + 1 < section.blocks.length &&
        estimateTokens(
          slice(blockAt(section, first).startLine, blockAt(section, last + 1).endLine),
        ) <= this.options.maxTokens
      ) {
        last += 1;
      }
      spans.push({
        headings: section.headings,
        startLine: blockAt(section, first).startLine,
        endLine: blockAt(section, last).endLine,
      });
      if (last + 1 >= section.blocks.length) {
        break;
      }
      const overlap =
        last > first &&
        estimateTokens(
          slice(blockAt(section, last).startLine, blockAt(section, last + 1).endLine),
        ) <= this.options.maxTokens;
      first = overlap ? last : last + 1;
    }
    return spans;
  }
}

function blockAt(section: MarkdownSection, index: number) {
  const block = section.blocks[index];
  if (block === undefined) {
    throw new RangeError(`No block ${index} in section starting at line ${section.startLine}.`);
  }
  return block;
}

/**
 * Root-relative target of a link found in the note at `path`, null for external links, anchors
 * and targets outside of the project. `/a.md` is relative to the project root.
 */
export function resolveMarkdownLink(path: string, url: string): string | null {
  const target = url.split(/[?#]/, 1).join('');
  if (target.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  const base = decoded.startsWith('/') ? '' : posix.dirname(path);
  const resolved = posix.normalize(posix.join(base, decoded.replace(/^\/+/, '')));
  return resolved.startsWith('..') || resolved === '.' ? null : resolved.replace(/\/$/, '');
}

/** Deterministic links of the chunks of a note to other files of the project. */
function markdownLinks(
  path: string,
  chunks: readonly PreparedChunk[],
  references: readonly MarkdownReference[],
): RelationInput[] {
  const relations: RelationInput[] = [];
  for (const reference of references) {
    const owner = chunks.find(
      ({ chunk }) => chunk.startLine <= reference.line && reference.line <= chunk.endLine,
    );
    const target = resolveMarkdownLink(path, reference.url.trim());
    if (owner === undefined || target === null) {
      continue;
    }
    relations.push({
      srcId: owner.chunk.id,
      kind: 'md_link',
      dstType: 'file',
      dstId: null,
      dstRef: target,
      origin: 'deterministic',
      method: 'markdown',
      score: null,
      line: reference.line,
    });
  }
  return relations;
}
