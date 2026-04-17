/**
 * `fine doctor` — diagnose the environment and configuration.
 *
 * Runs a series of checks, printing PASS / WARN / FAIL and a one-line hint.
 * Exits 0 if there are no FAILs (WARNs are tolerated), else 1.
 */

import fs from 'node:fs';
import { readConfig, CONFIG_FILE, inferApiKeyFromEnv } from '../config/Config.js';
import { listModels } from '../providers/models.js';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface CheckResult {
  status: Status;
  label: string;
  detail?: string;
}

// --- tiny ansi helpers (no chalk dependency here to keep doctor self-contained) ---
const supportsColor = !!process.stdout.isTTY && process.env.NO_COLOR == null;
const color = (code: number, s: string) => (supportsColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => color(32, s);
const yellow = (s: string) => color(33, s);
const red = (s: string) => color(31, s);
const dim = (s: string) => color(90, s);

function statusLabel(s: Status): string {
  if (s === 'PASS') return green('PASS');
  if (s === 'WARN') return yellow('WARN');
  return red('FAIL');
}

const PRESET_BASE_URLS: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  ollama: 'http://localhost:11434/v1',
};

/** Resolve base URL following the same rules as the runtime. */
function resolveBaseUrl(cfg: { preset?: string; baseUrl?: string }): string | undefined {
  return cfg.baseUrl ?? (cfg.preset ? PRESET_BASE_URLS[cfg.preset] : undefined);
}

// --- individual checks ---

function checkNode(): CheckResult {
  const version = process.versions.node;
  const [major] = version.split('.').map(n => parseInt(n, 10));
  if ((major ?? 0) >= 18) {
    return { status: 'PASS', label: `Node.js ${version}` };
  }
  return {
    status: 'FAIL',
    label: `Node.js ${version}`,
    detail: 'fineCode requires Node 18+. Upgrade via https://nodejs.org or nvm/brew.',
  };
}

function checkConfigFile(): CheckResult {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      status: 'WARN',
      label: 'Config file',
      detail: `Not found. Run \`fine init\` to create one (${CONFIG_FILE}).`,
    };
  }
  // Check permissions: should be 0600 on POSIX; we only warn if it's world-readable.
  try {
    const stat = fs.statSync(CONFIG_FILE);
    const mode = stat.mode & 0o777;
    if (process.platform !== 'win32' && mode & 0o044) {
      return {
        status: 'WARN',
        label: 'Config file',
        detail: `Found at ${CONFIG_FILE} but mode is ${mode.toString(8)} (others can read it). Run: chmod 600 ${CONFIG_FILE}`,
      };
    }
    return { status: 'PASS', label: `Config file (${CONFIG_FILE})` };
  } catch (e) {
    return {
      status: 'FAIL',
      label: 'Config file',
      detail: `Unreadable: ${(e as Error).message}`,
    };
  }
}

function checkConfigContents(): CheckResult {
  const cfg = readConfig();
  const missing: string[] = [];
  if (!cfg.model) missing.push('model');
  const isOllama = cfg.preset === 'ollama' || cfg.provider === 'ollama';
  const envKey = cfg.model ? inferApiKeyFromEnv(cfg.model, cfg.provider, cfg.preset) : undefined;
  if (!isOllama && !cfg.apiKey && !envKey) missing.push('apiKey');

  if (missing.length > 0) {
    return {
      status: 'FAIL',
      label: 'Required fields',
      detail: `Missing: ${missing.join(', ')}. Run \`fine init\`.`,
    };
  }
  return {
    status: 'PASS',
    label: `Required fields (model=${cfg.model}${cfg.preset ? `, preset=${cfg.preset}` : ''})`,
  };
}

async function checkConnectivity(baseUrl: string | undefined): Promise<CheckResult> {
  if (!baseUrl) {
    return { status: 'WARN', label: 'Connectivity', detail: 'No base URL resolved (skipping).' };
  }
  if (typeof fetch !== 'function') {
    return { status: 'WARN', label: 'Connectivity', detail: 'fetch unavailable (Node < 18).' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    // HEAD on root; many providers return 2xx/3xx/4xx. Any response means "reachable".
    const res = await fetch(baseUrl, { method: 'HEAD', signal: ctrl.signal });
    return { status: 'PASS', label: `Connectivity to ${baseUrl} (HTTP ${res.status})` };
  } catch (e) {
    return {
      status: 'FAIL',
      label: `Connectivity to ${baseUrl}`,
      detail: `${(e as Error).message}. Check network / VPN / proxy.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkApiKeyAndModels(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
  preset: string | undefined,
): Promise<CheckResult> {
  if (!baseUrl) return { status: 'WARN', label: 'Models /v1/models', detail: 'No base URL.' };
  const kind = preset === 'anthropic' ? 'anthropic' : 'openai';
  const list = await listModels({ baseUrl, apiKey, kind, timeoutMs: 4000 });
  if (!list) {
    return {
      status: 'WARN',
      label: 'Models /v1/models',
      detail: 'Endpoint did not return a list (could be auth failure or unsupported endpoint).',
    };
  }
  if (list.length === 0) {
    return { status: 'WARN', label: 'Models /v1/models', detail: 'Empty list returned.' };
  }
  if (model && !list.some(m => m.id === model)) {
    const preview = list.slice(0, 8).map(m => m.id).join(', ');
    return {
      status: 'FAIL',
      label: 'Model availability',
      detail: `"${model}" is NOT in server's list. Available (first 8): ${preview}${list.length > 8 ? ' …' : ''}`,
    };
  }
  return {
    status: 'PASS',
    label: `Model availability (${list.length} available, "${model}" OK)`,
  };
}

// --- runner ---

export async function runDoctor(): Promise<void> {
  console.log(dim('fineCode doctor — running checks…'));
  console.log('');

  const results: CheckResult[] = [];
  results.push(checkNode());
  results.push(checkConfigFile());
  results.push(checkConfigContents());

  const cfg = readConfig();
  const baseUrl = resolveBaseUrl(cfg);
  const envKey = cfg.model ? inferApiKeyFromEnv(cfg.model, cfg.provider, cfg.preset) : undefined;
  const apiKey = cfg.apiKey ?? envKey;

  results.push(await checkConnectivity(baseUrl));
  results.push(await checkApiKeyAndModels(baseUrl, apiKey, cfg.model, cfg.preset));

  for (const r of results) {
    console.log(`  ${statusLabel(r.status)}  ${r.label}`);
    if (r.detail) console.log(`         ${dim(r.detail)}`);
  }

  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  console.log('');
  if (failed > 0) {
    console.log(red(`${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ''}.`));
    process.exit(1);
  }
  if (warned > 0) {
    console.log(yellow(`All required checks passed, ${warned} warning(s).`));
    process.exit(0);
  }
  console.log(green('All checks passed.'));
  process.exit(0);
}
