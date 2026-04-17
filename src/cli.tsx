#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { Command } from 'commander';
import { Agent } from './core/Agent.js';
import { createProvider, PRESETS } from './providers/factory.js';
import { PermissionManager } from './permission/PermissionManager.js';
import { buildSystemPrompt } from './context/SystemPrompt.js';
import { DEFAULT_TOOLS } from './tools/index.js';
import { REPL } from './ui/REPL.js';
import type { ToolDefinition } from './core/types.js';

interface PermissionRequest {
  tool: ToolDefinition;
  preview: string;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

async function main() {
  const program = new Command();
  program
    .name('harness')
    .description('A minimal, model-agnostic coding agent inspired by Claude Code')
    .option('-m, --model <model>', 'Model identifier (e.g. gpt-4o, claude-sonnet-4-5, deepseek-chat)')
    .option('-k, --api-key <key>', 'API key (falls back to env: OPENAI_API_KEY / ANTHROPIC_API_KEY / etc.)')
    .option('-u, --base-url <url>', 'Base URL for OpenAI-compatible endpoints')
    .option('-p, --preset <name>', `Preset: ${Object.keys(PRESETS).join(', ')}`)
    .option('--provider <type>', 'Force provider: openai | anthropic | ollama')
    .option('--bypass', 'Auto-approve all tool calls (yolo mode)', false)
    .option('--cwd <dir>', 'Working directory (defaults to current)')
    .parse();

  const opts = program.opts();

  // Interactive prompting for missing required args
  const model = opts.model ?? (await promptInput('Model (e.g. gpt-4o, claude-sonnet-4-5, deepseek-chat): '));
  if (!model) {
    console.error('Model is required.');
    process.exit(1);
  }

  // Resolve preset
  let baseUrl = opts.baseUrl;
  if (opts.preset) {
    const preset = PRESETS[opts.preset];
    if (!preset) {
      console.error(`Unknown preset: ${opts.preset}. Valid: ${Object.keys(PRESETS).join(', ')}`);
      process.exit(1);
    }
    baseUrl = baseUrl ?? preset.baseUrl;
  }

  // Resolve API key
  let apiKey = opts.apiKey ?? inferApiKeyFromEnv(model, opts.provider, opts.preset);
  if (!apiKey && opts.preset !== 'ollama' && opts.provider !== 'ollama') {
    apiKey = await promptInput('API key (input hidden): ', true);
  }

  const cwd = opts.cwd ? require('node:path').resolve(opts.cwd) : process.cwd();

  // Build provider
  const provider = createProvider({
    model,
    apiKey,
    baseUrl,
    provider: opts.provider,
  });

  // Build system prompt with live env info
  const systemPrompt = await buildSystemPrompt(cwd);

  // Permission manager (and bridge between UI and agent)
  const permissionManager = new PermissionManager({ bypass: opts.bypass });

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

  // Launch UI
  const { waitUntilExit } = render(
    React.createElement(REPL, {
      agent,
      modelName: provider.name,
      onPermissionRequest: registerHandler,
    }),
  );
  await waitUntilExit();
}

function inferApiKeyFromEnv(
  model: string,
  provider: string | undefined,
  preset: string | undefined,
): string | undefined {
  // Explicit preset env vars
  const presetKey: Record<string, string | undefined> = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    moonshot: process.env.MOONSHOT_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    groq: process.env.GROQ_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    ollama: 'ollama',
  };
  if (preset && presetKey[preset]) return presetKey[preset];

  // Provider-based fallback
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return process.env.OPENAI_API_KEY;

  // Model-name heuristic
  if (model.toLowerCase().startsWith('claude-')) return process.env.ANTHROPIC_API_KEY;
  return (
    process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    process.env.GROQ_API_KEY
  );
}

async function promptInput(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    const onData = (buf: Buffer) => {
      const s = buf.toString().replace(/\r?\n$/, '');
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(s);
    };
    if (hidden && process.stdin.isTTY) {
      // best-effort hidden input
      (process.stdin as any).setRawMode?.(false);
    }
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
