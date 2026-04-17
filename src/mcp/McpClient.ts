/**
 * MCP (Model Context Protocol) client integration.
 *
 * Users declare MCP servers in ~/.fineCode/config.json under `mcpServers`:
 *
 *   "mcpServers": {
 *     "github":    { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
 *     "postgres":  { "command": "mcp-server-postgres", "args": ["postgresql://..."] }
 *   }
 *
 * On startup we spawn each server as a child process over stdio, discover the
 * tools it exposes, and wrap each one as a `ToolDefinition` that the Agent can
 * call just like the built-ins.
 *
 * Failures are non-fatal: a broken server is logged to stderr and skipped.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Optional human-readable label; defaults to the key name. */
  label?: string;
}

export interface MCPServerRecord {
  name: string;
  client: Client;
  tools: string[];
}

/**
 * Connect to all configured MCP servers and return:
 *   - The discovered tool definitions (ready to pass to Agent)
 *   - The live server records (for cleanup on shutdown)
 */
export async function connectMCPServers(
  servers: Record<string, MCPServerConfig>,
  opts: { log?: (line: string) => void } = {},
): Promise<{ tools: ToolDefinition[]; records: MCPServerRecord[] }> {
  const log = opts.log ?? (() => {});
  const tools: ToolDefinition[] = [];
  const records: MCPServerRecord[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const record = await connectOne(name, cfg);
      records.push(record);
      // Fetch tool descriptors (with schemas) and wrap each one.
      const listed = await record.client.listTools();
      for (const info of listed.tools ?? []) {
        tools.push(wrapMCPTool(record.client, name, info));
      }
      log(`MCP: connected to ${name} (${(listed.tools ?? []).length} tools)`);
    } catch (e) {
      log(`MCP: failed to connect to ${name}: ${(e as Error).message}`);
    }
  }

  return { tools, records };
}

async function connectOne(name: string, cfg: MCPServerConfig): Promise<MCPServerRecord> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
    stderr: 'pipe', // don't pollute our UI with server stderr
  });

  const client = new Client(
    { name: 'fine-code', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const listed = await client.listTools();
  return {
    name,
    client,
    tools: (listed.tools ?? []).map(t => t.name),
  };
}

/**
 * Wrap an MCP tool descriptor as a fineCode ToolDefinition.
 * - Names are prefixed "<server>__<tool>" to avoid collisions with built-ins.
 * - We request permission by default because remote tools can have side-effects.
 * - The result content from MCP is always text-coerced to a single string.
 */
function wrapMCPTool(
  client: Client,
  serverName: string,
  info: { name: string; description?: string; inputSchema?: Record<string, unknown> },
): ToolDefinition {
  const qualifiedName = `${serverName}__${info.name}`;
  const schema = info.inputSchema ?? { type: 'object', properties: {} };

  return {
    name: qualifiedName,
    description: `[MCP:${serverName}] ${info.description ?? info.name}`,
    parameters: schema,
    // MCP tools can do anything — write files, hit APIs, spawn processes.
    // Always ask the user, like BashTool.
    needsPermission: 'always',
    renderCall: (input: unknown) => {
      const preview = JSON.stringify(input);
      return `${info.name} ${preview.length > 80 ? preview.slice(0, 77) + '…' : preview}`;
    },
    execute: async (input): Promise<ToolResult> => {
      try {
        const result = await client.callTool({
          name: info.name,
          arguments: (input as Record<string, unknown>) ?? {},
        });

        // The MCP result has a `content` array of typed blocks. Flatten to text.
        // SDK types are loose here (unions covering text/image/resource), so we
        // narrow with a light cast rather than importing internal schemas.
        const parts: string[] = [];
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
          else parts.push(JSON.stringify(block));
        }
        return {
          content: parts.join('\n') || '(no content)',
          isError: !!result.isError,
        };
      } catch (e) {
        return { content: `MCP error: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

export async function disconnectMCPServers(records: MCPServerRecord[]): Promise<void> {
  await Promise.allSettled(records.map(r => r.client.close()));
}
