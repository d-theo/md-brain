import { z } from 'zod';
import { describeError } from '../domain/errors.js';
import type { Hit, KnowledgeService } from '../retrieval/knowledge-service.js';

const text = z.string().trim().min(1).max(500);

export const TOOL_INPUTS = {
  search_notes: z.object({
    query: text.describe('Question or keywords, in French or English.'),
    folders: z
      .array(z.string().trim().min(1).max(300))
      .max(20)
      .optional()
      .describe('Restrict to notes inside these folders (relative to the root, e.g. work/2026).'),
    limit: z.int().min(1).max(20).default(8).describe('Number of results (1-20).'),
  }),
  get_note: z.object({
    path: text.describe('Note path or unambiguous path suffix (projects/kb.md, kb.md...).'),
    startLine: z.int().min(1).optional(),
    endLine: z.int().min(1).optional(),
  }),
  get_overview: z.object({}),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

export interface ToolDefinition {
  readonly title: string;
  readonly description: string;
}

export const TOOL_DEFINITIONS: Readonly<Record<ToolName, ToolDefinition>> = {
  search_notes: {
    title: 'Search notes',
    description:
      'Hybrid (semantic + lexical) search over the Markdown notes. Returns ranked sections with file:line locations and excerpts read from disk.',
  },
  get_note: {
    title: 'Get note',
    description:
      'Everything known about one note: sections outline, outgoing links (with the indexed note they point at), backlinks, duplicate/similar sections in other notes, and the requested lines read from disk (flagged stale when the file changed since indexing).',
  },
  get_overview: {
    title: 'Get overview',
    description:
      'Notes per folder, most linked notes, number of broken links and state of the index. Start here to orient yourself.',
  },
};

export interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
}

function formatHits(hits: readonly Hit[]): string {
  if (hits.length === 0) {
    return 'No result.';
  }
  return hits
    .map((hit, index) => {
      const title = hit.title === null ? '' : ` — ${hit.title}`;
      const flags = [
        hit.excerpt?.stale === true ? 'STALE: file changed since indexing, re-read it' : null,
        hit.excerpt?.truncated === true ? 'excerpt truncated' : null,
      ].filter((flag) => flag !== null);
      const header = `${index + 1}. ${hit.location}${title} (${hit.matchedBy.join(', ')})`;
      const notes = flags.length === 0 ? '' : `\n   ${flags.join('; ')}`;
      const excerpt =
        hit.excerpt === null || hit.excerpt.text.length === 0
          ? ''
          : `\n\`\`\`markdown\n${hit.excerpt.text}\n\`\`\``;
      return `${header}${notes}${excerpt}`;
    })
    .join('\n\n');
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** Runs a tool on validated arguments; any failure becomes a tool error (never a crash). */
export async function runTool(
  service: KnowledgeService,
  tool: ToolName,
  rawArgs: unknown,
): Promise<ToolResult> {
  try {
    switch (tool) {
      case 'search_notes': {
        const { query, ...options } = TOOL_INPUTS.search_notes.parse(rawArgs);
        return { isError: false, text: formatHits(await service.search(query, options)) };
      }
      case 'get_note': {
        const args = TOOL_INPUTS.get_note.parse(rawArgs);
        return {
          isError: false,
          text: json(service.getNote(args.path, args.startLine, args.endLine)),
        };
      }
      case 'get_overview':
        TOOL_INPUTS.get_overview.parse(rawArgs);
        return { isError: false, text: json(service.getOverview()) };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { isError: true, text: `Invalid arguments:\n${z.prettifyError(error)}` };
    }
    return { isError: true, text: describeError(error) };
  }
}
