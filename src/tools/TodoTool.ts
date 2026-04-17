import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';

/**
 * TodoTool — in-session task tracker, inspired by Claude Code's todo_write.
 * Helps the model organize multi-step work and gives the user visible progress.
 * State is kept in-memory for the session (reset on restart).
 */

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

// Module-level state — scoped per process (one agent per process for now)
let todos: TodoItem[] = [];

export function getTodos(): TodoItem[] {
  return [...todos];
}

interface TodoInput {
  todos: TodoItem[];
  merge?: boolean;
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
  execute: async (input: TodoInput, _ctx: ToolExecutionContext): Promise<ToolResult> => {
    if (input.merge) {
      const byId = new Map(todos.map(t => [t.id, t]));
      for (const t of input.todos) byId.set(t.id, t);
      todos = Array.from(byId.values());
    } else {
      todos = [...input.todos];
    }
    const lines = todos.map(t => {
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
