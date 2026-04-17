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
import type { ToolDefinition } from './core/types.js';

interface PermissionRequest {
  tool: ToolDefinition;
  preview: string;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

/** Read package.json version so we don't hardcode it in two places. */
function readPkgVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // When shipped via npm, package.json sits next to dist/.
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

  // --- `fine init` subcommand ---
  program
    .command('init')
    .description('Interactive setup: saves defaults to ~/.fineCode/config.json')
    .action(async () => {
      await runInit();
      process.exit(0);
    });

  // --- `fine config` helpers ---
  program
    .command('config')
    .description(`Print the current config file path (${CONFIG_FILE})`)
    .action(() => {
      console.log(CONFIG_FILE);
      process.exit(0);
    });

  // --- `fine doctor` diagnostics ---
  program
    .command('doctor')
    .description('Diagnose environment and configuration (node, config, network, API key, models)')
    .action(async () => {
      await runDoctor();
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
}

/** Parse resolved config and boot the Ink REPL. */
async function launchRepl(opts: CliFlags, version: string): Promise<void> {
  // Fire the update check early (non-blocking).
  scheduleUpdateCheck(version);

  // Resolve config: CLI flags > env > ~/.fineCode/config.json
  const resolved = resolveConfig({
    model: opts.model,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    preset: opts.preset,
    provider: opts.provider,
    bypass: opts.bypass,
  });

  // First-run guidance: if no model and no config file exists, point user to `fine init`.
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

  // Resolve preset → baseUrl fallback (preset only supplies baseUrl when not explicit).
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

  // API key required except for ollama.
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

  // Build provider.
  const provider = createProvider({
    model: resolved.model,
    apiKey,
    baseUrl,
    provider: resolved.provider,
  });

  // Build system prompt with live env info.
  const systemPrompt = await buildSystemPrompt(cwd);

  // Permission manager (and bridge between UI and agent).
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
  });

  // Launch UI.
  const { waitUntilExit } = render(
    React.createElement(REPL, {
      agent,
      modelName: provider.name,
      onPermissionRequest: registerHandler,
    }),
  );
  await waitUntilExit();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
