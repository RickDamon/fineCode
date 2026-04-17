import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

interface FileReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export const FileReadTool: ToolDefinition<FileReadInput> = {
  name: 'read_file',
  description:
    'Read a file from the filesystem. Returns the content with line numbers in format "LINE_NUMBER→CONTENT". Supports reading large files via offset/limit. Prefer absolute paths.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: '1-indexed start line (default 1)' },
      limit: { type: 'number', description: `Max lines to read (default ${MAX_LINES})` },
    },
    required: ['path'],
  },
  needsPermission: 'never', // read-only, safe
  renderCall: input => `read ${input.path}`,
  execute: async (input, ctx) => readFile(input, ctx),
};

async function readFile(input: FileReadInput, ctx: ToolExecutionContext): Promise<ToolResult> {
  const absPath = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      return { content: `Path is a directory, not a file: ${absPath}`, isError: true };
    }
    if (stat.size > 10 * 1024 * 1024) {
      return { content: `File too large (${stat.size} bytes). Use offset/limit.`, isError: true };
    }

    const raw = await fs.readFile(absPath, 'utf8');
    const lines = raw.split('\n');
    const offset = Math.max(0, (input.offset ?? 1) - 1);
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
    const slice = lines.slice(offset, offset + limit);

    const numbered = slice
      .map((line, i) => {
        const n = offset + i + 1;
        const truncated =
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' …(truncated)' : line;
        return `${String(n).padStart(6)}→${truncated}`;
      })
      .join('\n');

    const header = `File: ${relative(ctx.cwd, absPath) || absPath} (${lines.length} lines total)`;
    return { content: `${header}\n${numbered}` };
  } catch (err) {
    return { content: `Error reading file: ${(err as Error).message}`, isError: true };
  }
}
