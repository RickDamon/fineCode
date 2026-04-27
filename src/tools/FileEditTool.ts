import { promises as fs } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import crypto from 'node:crypto';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

interface FileWriteInput {
  path: string;
  content: string;
}

interface FileEditInput {
  path: string;
  old_str: string;
  new_str: string;
}

/**
 * Capture a pre-change snapshot of `absPath` into the session, if a session is
 * attached. Does nothing (silently) if no session, or if the file doesn't exist
 * yet (creation case — the "snapshot" is just the absence of the file).
 *
 * Callers should invoke this BEFORE writing the new contents so `/rewind` can
 * restore the previous state.
 */
async function takeSnapshot(absPath: string, ctx: ToolExecutionContext): Promise<void> {
  if (!ctx.session || !ctx.toolCallId) return;
  try {
    const buf = await fs.readFile(absPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    ctx.session.recordSnapshot(
      {
        toolCallId: ctx.toolCallId,
        path: absPath,
        hash,
        bytes: buf.byteLength,
        ts: Date.now(),
      },
      buf,
    );
  } catch (err) {
    // File doesn't exist — this is a creation. Record a zero-byte marker so
    // /rewind knows the previous state was "absent".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.session.recordSnapshot(
        {
          toolCallId: ctx.toolCallId,
          path: absPath,
          hash: 'ABSENT',
          bytes: 0,
          ts: Date.now(),
        },
        Buffer.alloc(0),
      );
    }
    // Any other error — ignore; snapshots are best-effort.
  }
}

export const FileWriteTool: ToolDefinition<FileWriteInput> = {
  name: 'write_file',
  description:
    'Create a new file or overwrite an existing file with the given content. Use this to create new files. For editing existing files prefer edit_file for precision.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      content: { type: 'string', description: 'Full content to write' },
    },
    required: ['path', 'content'],
  },
  needsPermission: 'always',
  renderCall: input => `write ${input.path} (${input.content.length} bytes)`,
  execute: async (input, ctx) => {
    const absPath = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    try {
      await takeSnapshot(absPath, ctx);
      await fs.mkdir(dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, input.content, 'utf8');
      return { content: `Wrote ${input.content.length} bytes to ${absPath}` };
    } catch (err) {
      return { content: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  },
};

export const FileEditTool: ToolDefinition<FileEditInput> = {
  name: 'edit_file',
  description:
    'Perform an exact string replacement in a file. The old_str must match exactly (including whitespace and indentation) and must be unique in the file. Use an empty new_str to delete. This is the preferred way to modify existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      old_str: { type: 'string', description: 'Exact string to find (must be unique)' },
      new_str: { type: 'string', description: 'Replacement string' },
    },
    required: ['path', 'old_str', 'new_str'],
  },
  needsPermission: 'always',
  renderCall: input => `edit ${input.path}`,
  execute: async (input, ctx) => {
    const absPath = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    try {
      const original = await fs.readFile(absPath, 'utf8');
      // CRLF-tolerant unique match. A plain indexOf would fail on Windows /
      // mixed-origin files even when the content is visually identical.
      const match = findUniqueWithCrlf(original, input.old_str);
      if (match.count === 0) {
        return { content: `old_str not found in file: ${absPath}`, isError: true };
      }
      if (match.count > 1) {
        return {
          content: `old_str appears multiple times in ${absPath}. Provide more context to make it unique.`,
          isError: true,
        };
      }
      await takeSnapshot(absPath, ctx);
      const updated =
        original.slice(0, match.start) + input.new_str + original.slice(match.end);
      await fs.writeFile(absPath, updated, 'utf8');
      return { content: `Edited ${absPath}` };
    } catch (err) {
      return { content: `Error editing file: ${(err as Error).message}`, isError: true };
    }
  },
};

/**
 * Find `needle` in `haystack` tolerating line-ending differences.
 *
 * Why: models construct `old_str` by reading tool output where newlines are
 * already \n, but the file on disk may be CRLF (Windows or mixed-origin file).
 * A raw `indexOf` will then miss the match and throw the dreaded "old_str not
 * found" error even when the text is visually identical.
 *
 * Strategy: build a regex from `needle` where every \r?\n in the needle
 * matches either \n or \r\n in the haystack. Anchor everything else exactly.
 *
 * Returns the unique match's [start, end) in the ORIGINAL haystack (so the
 * surrounding splice preserves whatever line-endings the file had).
 * Returns `{ count: 0 }` if not found, `{ count: N }` if found >1 times.
 */
function findUniqueWithCrlf(
  haystack: string,
  needle: string,
): { count: number; start?: number; end?: number } {
  const segments = needle.split(/\r?\n/);
  const escapedSegments = segments.map(escapeRegex);
  const pattern = escapedSegments.join('\\r?\\n');
  const re = new RegExp(pattern, 'g');

  let first: RegExpExecArray | null = null;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    count++;
    if (!first) first = m;
    if (count > 1) break;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!first) return { count: 0 };
  return { count, start: first.index, end: first.index + first[0].length };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
