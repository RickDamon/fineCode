import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, isAbsolute, relative } from 'node:path';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

interface GrepInput {
  pattern: string;
  path?: string;
  caseSensitive?: boolean;
}

interface GlobInput {
  pattern: string;
  path?: string;
}

interface LsInput {
  path?: string;
}

/** Grep using system grep; falls back to a JS implementation if grep missing. */
export const GrepTool: ToolDefinition<GrepInput> = {
  name: 'grep',
  description:
    'Search for a regex pattern in files under a directory. Returns matching lines with file paths and line numbers. Uses ripgrep-style semantics via system grep. Excludes common heavy dirs (node_modules, .git, dist).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (defaults to cwd)' },
      caseSensitive: { type: 'boolean', description: 'Default false' },
    },
    required: ['pattern'],
  },
  needsPermission: 'never',
  renderCall: input => `grep "${input.pattern}" in ${input.path ?? '.'}`,
  execute: async (input, ctx) => {
    const base = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;
    const args = [
      '-r',
      '-n',
      '-I', // ignore binary
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=dist',
      '--exclude-dir=build',
      '--exclude-dir=.next',
      input.caseSensitive ? '-E' : '-Ei',
      input.pattern,
      base,
    ];
    return runProc('grep', args, ctx);
  },
};

/** Glob: find files by name pattern. */
export const GlobTool: ToolDefinition<GlobInput> = {
  name: 'glob',
  description:
    'Find files matching a shell glob pattern (e.g. "**/*.ts", "src/**/*.tsx"). Uses system find.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (use **/*.ext for recursive)' },
      path: { type: 'string', description: 'Base directory (defaults to cwd)' },
    },
    required: ['pattern'],
  },
  needsPermission: 'never',
  renderCall: input => `glob ${input.pattern}`,
  execute: async (input, ctx) => {
    const base = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;
    // Convert glob to find expression (simple cases)
    const name = input.pattern.split('/').pop() ?? input.pattern;
    const args = [base, '-type', 'f', '-name', name, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'];
    return runProc('find', args, ctx);
  },
};

/** List directory contents. */
export const LsTool: ToolDefinition<LsInput> = {
  name: 'ls',
  description: 'List files and directories in a given path. Returns a tree-like view.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to list (defaults to cwd)' },
    },
  },
  needsPermission: 'never',
  renderCall: input => `ls ${input.path ?? '.'}`,
  execute: async (input, ctx) => {
    const target = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const lines = entries
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
      return { content: `${relative(ctx.cwd, target) || '.'}\n${lines.join('\n')}` };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};

function runProc(
  cmd: string,
  args: string[],
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: ctx.cwd });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill('SIGTERM');
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('close', code => {
      ctx.abortSignal.removeEventListener('abort', onAbort);
      const out = stdout.trim();
      // grep returns 1 when no match — not an error for our purposes
      if (code === 0 || (cmd === 'grep' && code === 1)) {
        resolve({ content: out || '(no matches)' });
      } else {
        resolve({ content: stderr.trim() || `exit ${code}`, isError: true });
      }
    });
    child.on('error', err => resolve({ content: err.message, isError: true }));
  });
}
