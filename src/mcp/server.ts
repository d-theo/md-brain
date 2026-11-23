import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { ProjectConfig } from '../config/project-config.js';
import type { KnowledgeService } from '../retrieval/knowledge-service.js';
import { runTool, TOOL_DEFINITIONS, TOOL_INPUTS, type ToolName } from './tools.js';

export const SERVER_VERSION = '0.1.0';

/**
 * MCP server of ONE project: read-only tools, no project parameter (no cross-project access).
 * Transport-independent: stdio today, HTTP later without touching the tools.
 */
export function createMcpServer(project: ProjectConfig, service: KnowledgeService): McpServer {
  const server = new McpServer(
    { name: `md-${project.id}`, version: SERVER_VERSION },
    {
      instructions: [
        `Markdown notes of "${project.name}" (${project.root}).`,
        'Use get_overview first, search_notes to find notes answering a question,',
        'get_note to read a note with its links, backlinks and similar notes.',
        'Results point to file:line on disk; the files remain the source of truth (re-read stale notes).',
      ].join(' '),
    },
  );
  const meta = (name: ToolName) => ({
    title: TOOL_DEFINITIONS[name].title,
    description: TOOL_DEFINITIONS[name].description,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  });
  const handle = async (name: ToolName, args: unknown): Promise<CallToolResult> => {
    const result = await runTool(service, name, args);
    return { isError: result.isError, content: [{ type: 'text', text: result.text }] };
  };
  server.registerTool(
    'search_notes',
    { ...meta('search_notes'), inputSchema: TOOL_INPUTS.search_notes },
    (args) => handle('search_notes', args),
  );
  server.registerTool(
    'get_note',
    { ...meta('get_note'), inputSchema: TOOL_INPUTS.get_note },
    (args) => handle('get_note', args),
  );
  server.registerTool(
    'get_overview',
    { ...meta('get_overview'), inputSchema: TOOL_INPUTS.get_overview },
    (args) => handle('get_overview', args),
  );
  return server;
}
