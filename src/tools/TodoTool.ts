import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

/**
 * TodoTool — in-session task tracker, inspired by Claude Code's todo_write.
 * Helps the model organize multi-step work and gives the user visible progress.
 *
 * Storage:
 *   - If the current ToolExecutionContext has a Session attached, todos live
 *     on the Session and are persisted to disk — survives `fine -c`, and each
 *     session has its own list so concurrent subagents can't clobber the
 *     parent's todos.
 *   - If no session (one-shot invocations, tests), we fall back to a
 *     per-process in-memory map keyed by `agentKey` (toolCallId's agent
 *     prefix when available, else 'default').
 *
 * This replaces the earlier single module-level `let todos: TodoItem[] = []`
 * which was shared globally — a real bug once subagents started calling
 * todo_write in parallel with the parent.
 */

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/** In-memory fallback for contexts without a Session. Keyed by agentKey. */
const fallbackStore = new Map<string, TodoItem[]>();

/**
 * Back-compat export. Returns the "default" bucket's in-memory todos if no
 * session was ever attached. When a session is in play, prefer
 * `session.getTodos()` directly — this helper can't access sessions without
 * a context.
 */
export function getTodos(): TodoItem[] {
  return [...(fallbackStore.get('default') ?? [])];
}

interface TodoInput {
  todos: TodoItem[];
  merge?: boolean;
}

function readTodos(ctx: ToolExecutionContext): TodoItem[] {
  if (ctx.session) return ctx.session.getTodos();
  return [...(fallbackStore.get(keyFor(ctx)) ?? [])];
}

function writeTodos(ctx: ToolExecutionContext, todos: TodoItem[]): void {
  if (ctx.session) {
    ctx.session.setTodos(todos);
    return;
  }
  fallbackStore.set(keyFor(ctx), todos);
}

/** Pick a stable per-agent key when we have no session. In practice almost
 *  every real call has a session; this is defensive for tests / MCP. */
function keyFor(ctx: ToolExecutionContext): string {
  // toolCallId is per-call, but we can get an agent-stable prefix from the
  // cwd — multiple subagents sharing a cwd would still collide, but a Session
  // is the real fix for that case and is always attached in production.
  return ctx.cwd ?? 'default';
}

export const TodoTool: ToolDefinition<TodoInput> = {
  name: 'todo_write',
  description:
    'Create or update a structured task list for the current session. Use for complex multi-step tasks (3+ steps). Use merge=true to update individual items by id while keeping others; merge=false replaces the entire list. Only ONE todo should be in_progress at a time.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
          },
          required: ['id', 'content', 'status'],
        },
      },
      merge: {
        type: 'boolean',
        description: 'If true, merge by id; if false (default), replace entire list',
      },
    },
    required: ['todos'],
  },
  needsPermission: 'never',
  renderCall: input => `todos(${input.todos.length} items${input.merge ? ', merge' : ''})`,
  execute: async (input: TodoInput, ctx: ToolExecutionContext): Promise<ToolResult> => {
    const current = readTodos(ctx);
    let next: TodoItem[];
    if (input.merge) {
      const byId = new Map(current.map(t => [t.id, t]));
      for (const t of input.todos) byId.set(t.id, t);
      next = Array.from(byId.values());
    } else {
      next = [...input.todos];
    }
    writeTodos(ctx, next);

    const lines = next.map(t => {
      const marker =
        t.status === 'completed'
          ? '[x]'
          : t.status === 'in_progress'
            ? '[~]'
            : t.status === 'cancelled'
              ? '[-]'
              : '[ ]';
      return `${marker} ${t.content}`;
    });
    return { content: `Todos updated:\n${lines.join('\n')}` };
  },
};
