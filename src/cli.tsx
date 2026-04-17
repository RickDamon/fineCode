#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { Agent } from './core/Agent.js';
import { createProvider, PRESETS } from './providers/factory.js';
import { PermissionManager } from './permission/PermissionManager.js';
import { buildSystemPrompt } from './context/SystemPrompt.js';
import { DEFAULT_TOOLS } from './tools/index.js';
import { REPL } from './ui/REPL.js';
import { resolveConfig, CONFIG_FILE } from './config/Config.js';
import { runInit } from './commands/init.js';
import { runDoctor } from './commands/doctor.js';
import { scheduleUpdateCheck } from './utils/updateCheck.js';
import { Session } from './session/Session.js';
import { connectMCPServers, disconnectMCPServers, type MCPServerRecord } from './mcp/McpClient.js';
import { readConfig } from './config/Config.js';
import type { ToolDefinition, Message } from './core/types.js';

interface PermissionRequest {
  tool: ToolDefinition;
  preview: string;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

/** Read package.json version so we don't hardcode it in two places. */
function readPkgVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', 'package.json'),
      path.join(here, '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? '0.0.0';
      }
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

async function main() {
  const program = new Command();
  const version = readPkgVersion();

  program
    .name('fine')
    .description('A minimal, model-agnostic coding agent inspired by Claude Code')
    .version(version, '-v, --version', 'output the current version');

  // --- Subcommands ---
  program
    .command('init')
    .description('Interactive setup: saves defaults to ~/.fineCode/config.json')
    .action(async () => {
      await runInit();
      process.exit(0);
    });

  program
    .command('config')
    .description(`Print the current config file path (${CONFIG_FILE})`)
    .action(() => {
      console.log(CONFIG_FILE);
      process.exit(0);
    });

  program
    .command('doctor')
    .description('Diagnose environment and configuration (node, config, network, API key, models)')
    .action(async () => {
      await runDoctor();
    });

  program
    .command('sessions')
    .description('List recent sessions and their ids')
    .action(() => {
      const list = Session.list(30);
      if (list.length === 0) {
        console.log('No sessions found.');
        process.exit(0);
      }
      for (const m of list) {
        const ts = new Date(m.lastAt).toISOString();
        const title = (m.title ?? '(untitled)').replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${m.id}  ${ts}  [${m.model}]  ${title}`);
      }
      process.exit(0);
    });

  // --- Default command: launch REPL ---
  program
    .option('-m, --model <model>', 'Model identifier (e.g. gpt-4o, claude-sonnet-4-5, deepseek-chat)')
    .option('-k, --api-key <key>', 'API key (falls back to env and config file)')
    .option('-u, --base-url <url>', 'Base URL for OpenAI-compatible endpoints')
    .option('-p, --preset <name>', `Preset: ${Object.keys(PRESETS).join(', ')}`)
    .option('--provider <type>', 'Force provider: openai | anthropic | ollama')
    .option('--bypass', 'Auto-approve all tool calls (yolo mode)', false)
    .option('--cwd <dir>', 'Working directory (defaults to current)')
    .option('-c, --continue', 'Continue the most recent session for this directory', false)
    .option('--resume <id>', 'Resume a specific session by id (see `fine sessions`)')
    .action(async (opts: CliFlags) => {
      await launchRepl(opts, version);
    });

  await program.parseAsync();
}

interface CliFlags {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  preset?: string;
  provider?: 'openai' | 'anthropic' | 'ollama';
  bypass?: boolean;
  cwd?: string;
  continue?: boolean;
  resume?: string;
}

/** Parse resolved config and boot the Ink REPL. */
async function launchRepl(opts: CliFlags, version: string): Promise<void> {
  scheduleUpdateCheck(version);

  const resolved = resolveConfig({
    model: opts.model,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    preset: opts.preset,
    provider: opts.provider,
    bypass: opts.bypass,
  });

  if (!resolved.model) {
    if (!resolved.fromFile) {
      console.error('No model configured.');
      console.error('');
      console.error('  Run `fine init` for interactive setup,');
      console.error('  or pass --model (e.g. `fine -m deepseek-chat -p deepseek`).');
      process.exit(1);
    }
    console.error('Model is required. Run `fine init` to set a default.');
    process.exit(1);
  }

  let baseUrl = resolved.baseUrl;
  if (resolved.preset) {
    const preset = PRESETS[resolved.preset];
    if (!preset) {
      console.error(
        `Unknown preset: ${resolved.preset}. Valid: ${Object.keys(PRESETS).join(', ')}`,
      );
      process.exit(1);
    }
    baseUrl = baseUrl ?? preset.baseUrl;
  }

  let apiKey = resolved.apiKey;
  const isOllama = resolved.preset === 'ollama' || resolved.provider === 'ollama';
  if (!apiKey && !isOllama) {
    console.error('No API key found.');
    console.error('');
    console.error('  Set it one of these ways:');
    console.error('    1. `fine init` (saves to config file)');
    console.error('    2. Environment variable (e.g. DEEPSEEK_API_KEY=...)');
    console.error('    3. `--api-key <key>` flag');
    process.exit(1);
  }
  if (isOllama && !apiKey) apiKey = 'ollama';

  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  // --- Session: new / continue / resume ---
  let session: Session;
  let initialHistory: Message[] = [];
  if (opts.resume) {
    const loaded = Session.load(opts.resume);
    if (!loaded) {
      console.error(`Session not found: ${opts.resume}`);
      console.error('Run `fine sessions` to list valid ids.');
      process.exit(1);
    }
    session = loaded.session;
    initialHistory = loaded.messages;
  } else if (opts.continue) {
    const recent = Session.mostRecent(cwd);
    if (!recent) {
      console.error('No previous session found for this directory.');
      console.error('Start a new one: `fine` (no flags).');
      process.exit(1);
    }
    const loaded = Session.load(recent.id);
    if (!loaded) {
      console.error(`Failed to load session ${recent.id}.`);
      process.exit(1);
    }
    session = loaded.session;
    initialHistory = loaded.messages;
  } else {
    session = Session.create({ cwd, model: resolved.model });
  }

  const provider = createProvider({
    model: session.getMeta().model, // honor stored model on resume
    apiKey,
    baseUrl,
    provider: resolved.provider,
  });

  const systemPrompt = await buildSystemPrompt(cwd);
  const permissionManager = new PermissionManager({ bypass: resolved.bypass });

  let uiPermissionHandler: ((req: PermissionRequest) => void) | null = null;
  const registerHandler = (fn: (req: PermissionRequest) => void) => {
    uiPermissionHandler = fn;
  };

  const permissionPrompt = (tool: ToolDefinition, _input: unknown, preview: string) =>
    new Promise<'allow' | 'allow_always' | 'deny'>(resolve => {
      if (!uiPermissionHandler) {
        resolve('deny');
        return;
      }
      uiPermissionHandler({ tool, preview, resolve });
    });

  const agent = new Agent({
    provider,
    tools: DEFAULT_TOOLS,
    permissionManager,
    permissionPrompt,
    systemPrompt,
    cwd,
    session,
    initialHistory,
  });

  // --- Connect MCP servers (if any) and register their tools ---
  const stored = readConfig();
  let mcpRecords: MCPServerRecord[] = [];
  if (stored.mcpServers && Object.keys(stored.mcpServers).length > 0) {
    const { tools: mcpTools, records } = await connectMCPServers(stored.mcpServers, {
      log: line => process.stderr.write(line + '\n'),
    });
    mcpRecords = records;
    for (const t of mcpTools) agent.registerTool(t);
  }

  // The REPL needs a mutable session reference so /clear can swap it.
  // eslint-disable-next-line prefer-const
  let currentSession = session;
  const setSession = (s: Session) => {
    currentSession = s;
  };
  void currentSession;

  const { waitUntilExit } = render(
    React.createElement(REPL, {
      agent,
      modelName: provider.name,
      session,
      setSession,
      onPermissionRequest: registerHandler,
    }),
  );
  await waitUntilExit();
  session.close();
  if (mcpRecords.length > 0) await disconnectMCPServers(mcpRecords);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
