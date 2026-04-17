import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

interface BashInput {
  command: string;
  timeout?: number;
}

/**
 * Bash tool — execute shell commands.
 * Always requires permission because arbitrary shell commands can be destructive.
 */
export const BashTool: ToolDefinition<BashInput> = {
  name: 'bash',
  description:
    'Execute a shell command in the user\'s working directory. Returns stdout and stderr. Use this for any task that requires running shell commands (git, npm, python, etc.). Commands requiring user input cannot be used.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000, max: 600000)',
      },
    },
    required: ['command'],
  },
  needsPermission: 'always',
  renderCall: input => `$ ${input.command}`,
  execute: async (input, ctx) => runBash(input, ctx),
};

async function runBash(input: BashInput, ctx: ToolExecutionContext): Promise<ToolResult> {
  const timeoutMs = Math.min(input.timeout ?? 120_000, 600_000);

  return new Promise<ToolResult>(resolve => {
    const child = spawn('bash', ['-c', input.command], {
      cwd: ctx.cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        content: `Command timed out after ${timeoutMs}ms\nstdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
        isError: true,
      });
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve({ content: 'Aborted by user', isError: true });
    };
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);
      const combined = [
        stdout.trim() && `stdout:\n${stdout.trim()}`,
        stderr.trim() && `stderr:\n${stderr.trim()}`,
        `exit_code: ${code}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      resolve({
        content: combined || '(no output)',
        isError: code !== 0,
      });
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ content: `Failed to execute: ${err.message}`, isError: true });
    });
  });
}
