/**
 * Config system for fineCode.
 *
 * Storage: ~/.fineCode/config.json (or ~/.fineCode/profiles/<name>/config.json
 * when a non-default profile is active; see config/paths.ts).
 *
 * Resolution priority (high → low):
 *   1. CLI flags  (--model / --api-key / --base-url / --preset / --provider)
 *   2. Environment variables  (OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY /
 *      MOONSHOT_API_KEY / ZHIPU_API_KEY / MINIMAX_API_KEY / OPENROUTER_API_KEY / ...)
 *   3. Config file
 *
 * The file is created with mode 0600 so the API key is readable only by the owner.
 */

import fs from 'node:fs';
import { configFile, profileRoot } from './paths.js';

export interface StoredConfig {
  /** Default model identifier, e.g. "deepseek-chat", "gpt-4o", "claude-sonnet-4-5". */
  model?: string;
  /** Preset name: openai / deepseek / moonshot / zhipu / minimax / openrouter / groq / together / ollama. */
  preset?: string;
  /** Explicit provider override: openai | anthropic | ollama. */
  provider?: 'openai' | 'anthropic' | 'ollama';
  /** Custom base URL for OpenAI-compatible endpoints. */
  baseUrl?: string;
  /** API key. Stored in plaintext (file mode 0600). Users who want more security should use env vars. */
  apiKey?: string;
  /** Misc flags. */
  bypass?: boolean;
  /** Last time we checked for a new npm version (unix ms). */
  lastUpdateCheck?: number;
  /**
   * MCP servers to auto-connect on startup. Keys are labels; values are spawn configs.
   * See src/mcp/McpClient.ts for the schema.
   */
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      label?: string;
    }
  >;
  /**
   * Named subagent presets. When the model calls spawn_agent(agent_type="research", ...)
   * it gets this preset applied. See src/tools/SpawnAgentTool.ts for the schema.
   */
  subagents?: Record<
    string,
    {
      model?: string;
      systemPrompt?: string;
      allow?: string[];
      description?: string;
      maxTurns?: number;
    }
  >;
  /**
   * Context anchors — "pinned" notes injected into every request, NOT subject to compaction.
   * Added via /anchor <text>. Keyed by short ids for easy removal.
   */
  anchors?: Record<string, { text: string; addedAt: number }>;
  /**
   * Auto-distill session into long-term memory on exit (via /exit, Ctrl+C).
   * Off by default — an extra API call on every quit surprises users.
   * Users can always run /remember manually.
   */
  autoRemember?: boolean;
}

/**
 * @deprecated Prefer `configFile()` / `profileRoot()` from ./paths.js.
 * These constants are evaluated at MODULE LOAD TIME, before setActiveProfile()
 * has a chance to run, so they always point at the default profile root.
 * Kept only as a soft-migration shim; remove once no external code reads them.
 */
export const CONFIG_DIR = profileRoot();
/** @deprecated see CONFIG_DIR */
export const CONFIG_FILE = configFile();

/** Read the stored config file. Returns `{}` if missing or malformed (never throws). */
export function readConfig(): StoredConfig {
  const file = configFile();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as StoredConfig;
    return {};
  } catch {
    return {};
  }
}

/** Write (merge) config to disk. Creates the dir if needed. File mode is 0600. */
export function writeConfig(patch: Partial<StoredConfig>): StoredConfig {
  const dir = profileRoot();
  const file = configFile();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const current = readConfig();
  const next: StoredConfig = { ...current, ...patch };
  // Write atomically: write tmp then rename.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

/** Env-var lookup mirroring the old inline logic in cli.tsx. */
export function inferApiKeyFromEnv(
  model: string,
  provider: string | undefined,
  preset: string | undefined,
): string | undefined {
  const presetKey: Record<string, string | undefined> = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    moonshot: process.env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY ?? process.env.BIGMODEL_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    groq: process.env.GROQ_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    ollama: 'ollama',
  };
  if (preset && presetKey[preset]) return presetKey[preset];

  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return process.env.OPENAI_API_KEY;

  if (model.toLowerCase().startsWith('claude-')) return process.env.ANTHROPIC_API_KEY;
  return (
    process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    process.env.KIMI_API_KEY ??
    process.env.ZHIPU_API_KEY ??
    process.env.MINIMAX_API_KEY ??
    process.env.GROQ_API_KEY
  );
}

/**
 * Resolve the effective runtime config.
 *
 * `flags` comes from commander (CLI args). Missing fields fall through to env vars, then config file.
 * Returns `undefined` for any field that could not be resolved.
 */
export interface ResolvedConfig {
  model?: string;
  preset?: string;
  provider?: 'openai' | 'anthropic' | 'ollama';
  baseUrl?: string;
  apiKey?: string;
  bypass?: boolean;
  /** Whether a config file existed at resolution time (used to prompt `fine init`). */
  fromFile: boolean;
}

export function resolveConfig(flags: Partial<StoredConfig>): ResolvedConfig {
  const stored = readConfig();
  const fromFile = fs.existsSync(configFile());

  const model = flags.model ?? stored.model;
  const preset = flags.preset ?? stored.preset;
  const provider = (flags.provider ?? stored.provider) as ResolvedConfig['provider'];
  const baseUrl = flags.baseUrl ?? stored.baseUrl;
  const bypass = flags.bypass ?? stored.bypass ?? false;

  // API key: CLI > env > stored.
  let apiKey = flags.apiKey;
  if (!apiKey && model) apiKey = inferApiKeyFromEnv(model, provider, preset);
  if (!apiKey) apiKey = stored.apiKey;

  return { model, preset, provider, baseUrl, apiKey, bypass, fromFile };
}
