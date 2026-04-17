import { BashTool } from './BashTool.js';
import { FileReadTool } from './FileReadTool.js';
import { FileWriteTool, FileEditTool } from './FileEditTool.js';
import { GrepTool, GlobTool, LsTool } from './SearchTools.js';
import { TodoTool } from './TodoTool.js';
import type { ToolDefinition } from '../core/types.js';

/** The default tool set. Order matters for model attention — put most-used first. */
export const DEFAULT_TOOLS: ToolDefinition[] = [
  BashTool,
  FileReadTool,
  FileEditTool,
  FileWriteTool,
  GrepTool,
  GlobTool,
  LsTool,
  TodoTool,
] as ToolDefinition[];

export {
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GrepTool,
  GlobTool,
  LsTool,
  TodoTool,
};
