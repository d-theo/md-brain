import type { Heading, Nodes as Node, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString as mdToString } from 'mdast-util-to-string';
import { gfm } from 'micromark-extension-gfm';

/** Heading depths that open a new section; deeper headings stay inside their section. */
export const SECTION_DEPTH = 3;

export interface MarkdownBlock {
  readonly startLine: number;
  readonly endLine: number;
}

/** Destination of a link (inline `[text](url)` or reference definition `[ref]: url`). */
export interface MarkdownReference {
  readonly url: string;
  readonly line: number;
}

export interface MarkdownDocument {
  readonly sections: readonly MarkdownSection[];
  readonly references: readonly MarkdownReference[];
}

export interface MarkdownSection {
  /** Titles from the top-level heading down to this section's heading (empty for a preamble). */
  readonly headings: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  /** Top-level blocks of the section (heading included), used to split long sections. */
  readonly blocks: readonly MarkdownBlock[];
}

function blockOf(node: RootContent): MarkdownBlock | null {
  const start = node.position?.start.line;
  const end = node.position?.end.line;
  return start === undefined || end === undefined ? null : { startLine: start, endLine: end };
}

/**
 * Splits a Markdown document into sections at headings of depth <= SECTION_DEPTH. Line numbers
 * are 1-based and inclusive; a section ends where the next one starts (trailing blank lines
 * excluded). Content before the first heading becomes a preamble section.
 */
export function parseMarkdownSections(source: string): readonly MarkdownSection[] {
  return parseMarkdown(source).sections;
}

function collectReferences(node: Node, references: MarkdownReference[]): void {
  const line = node.position?.start.line ?? 0;
  if ((node.type === 'link' || node.type === 'definition') && node.url.length > 0) {
    references.push({ url: node.url, line });
  }
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectReferences(child, references);
    }
  }
}

/** Sections and link destinations of a Markdown document. */
export function parseMarkdown(source: string): MarkdownDocument {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const references: MarkdownReference[] = [];
  collectReferences(tree, references);
  return { sections: sectionsOf(tree), references };
}

function sectionsOf(tree: Root): MarkdownSection[] {
  const sections: { headings: string[]; blocks: MarkdownBlock[] }[] = [];
  const trail: { depth: number; title: string }[] = [];
  let current: { headings: string[]; blocks: MarkdownBlock[] } | undefined;
  for (const node of tree.children) {
    const block = blockOf(node);
    if (block === null) {
      continue;
    }
    if (isSectionHeading(node)) {
      while ((trail.at(-1)?.depth ?? 0) >= node.depth) {
        trail.pop();
      }
      trail.push({ depth: node.depth, title: mdToString(node).trim() });
      current = { headings: trail.map((entry) => entry.title), blocks: [block] };
      sections.push(current);
    } else {
      if (current === undefined) {
        current = { headings: [], blocks: [] };
        sections.push(current);
      }
      current.blocks.push(block);
    }
  }
  return sections
    .filter((section) => section.blocks.length > 0)
    .map((section) => ({
      headings: section.headings,
      startLine: section.blocks[0]?.startLine ?? 1,
      endLine: section.blocks.at(-1)?.endLine ?? 1,
      blocks: section.blocks,
    }));
}

function isSectionHeading(node: RootContent): node is Heading {
  return node.type === 'heading' && node.depth <= SECTION_DEPTH;
}
