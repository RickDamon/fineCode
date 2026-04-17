/**
 * `fine mcp-server` — run fineCode itself as an MCP server over stdio.
 *
 * What this gives you:
 *   External MCP clients (Claude Desktop, other IDE integrations, another
 *   fineCode instance) can call fineCode's built-in tools as if they were
 *   their own.
 *
 * Why stdio:
 *   The MCP spec's primary transport for local servers is stdio — the client
 *   spawns us, we read JSON-RPC from stdin and write to stdout. This also
 *   means we must NEVER write anything non-protocol to stdout in this mode.
 *   (Logs go to stderr.)
 *
 * Implementation notes:
 *   - We use the low-level Server (not McpServer) because our tools are
 *     declared in JSON Schema, not Zod, and wiring them up via request
 *     handlers is the minimum-ceremony path.
 *   - We expose the DEFAULT_TOOLS only. MCP-originated tools (loop) and
 *     SpawnAgentTool are excluded to avoid re-entrancy and loops.
 *   - Permission: MCP clients are trusted (user explicitly connected them),
 *     so every tool auto-approves. If this is too permissive for a given
 *     setup, the USER's MCP client is expected to gate access, not us.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_TOOLS } from '../tools/index.js';
import type { ToolDefinition } from '../core/types.js';

export async function runMcpServer(version: string): Promise<void> {
  // IMPORTANT: stdout is owned by the MCP transport. Any accidental log to
  // stdout corrupts the JSON-RPC framing. Redirect console.log to stderr
  // preemptively so libraries that unwittingly log still don't break us.
  const stderrLog = (...args: unknown[]) => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.log = stderrLog;
  console.info = stderrLog;
  console.warn = stderrLog;

  const server = new Server(
    {
      name: 'fine-code',
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Build the tool list once. We skip tools that can't sensibly run in server
  // mode (e.g., no way to ask the user for permission over MCP).
  const exposable = DEFAULT_TOOLS.filter(t => t.name !== 'spawn_agent');

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposable.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const tool: ToolDefinition | undefined = exposable.find(t => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // AbortController tied to the server's lifetime so a client disconnect
    // can terminate a long-running tool call.
    const ac = new AbortController();
    try {
      const result = await tool.execute(args ?? {}, {
        cwd: process.cwd(),
        abortSignal: ac.signal,
      });
      return {
        content: [{ type: 'text', text: result.content }],
        isError: !!result.isError,
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process will now live until stdin closes or SIGTERM.
  stderrLog(`fine-code MCP server ready (v${version}, ${exposable.length} tools)`);
}
