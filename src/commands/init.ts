/**
 * `fine init` — interactive first-time setup.
 *
 * Implementation note:
 *   We deliberately DO NOT use readline here. Readline installs its own stdin
 *   listeners and competes with raw-mode handlers we need for hidden (masked)
 *   input, causing the API key to leak on screen. Instead we drive stdin in raw
 *   mode ourselves for every prompt, which guarantees consistent behavior.
 */

import { writeConfig, readConfig, type StoredConfig } from '../config/Config.js';
import { configFile } from '../config/paths.js';
import { listModels } from '../providers/models.js';

// Presets kept local to avoid a circular import with factory.ts.
const PRESET_NAMES = [
  'openai',
  'deepseek',
  'moonshot',
  'openrouter',
  'groq',
  'together',
  'ollama',
];

// Base URL per preset, mirrors providers/factory.ts PRESETS.
const PRESET_BASE_URLS: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  ollama: 'http://localhost:11434/v1',
};

/**
 * Known-good model IDs per preset. Shown to the user as a hint so they don't
 * invent names like "deepseek-v3" that the API doesn't accept. This list is
 * intentionally small — it's guidance, not validation (user can still type
 * anything).
 */
const KNOWN_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
  ollama: ['qwen2.5-coder:7b', 'llama3.1:8b'],
};

type Stdin = NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (b: boolean) => void };

/**
 * Shared raw-mode read loop used by all prompts.
 *
 * `echoMode` controls what is echoed for each character:
 *   - "plain":  echo the char itself (normal text input)
 *   - "masked": echo "*" (hidden input for secrets)
 *   - "none":   echo nothing
 *
 * Handles: Enter, Backspace, Ctrl+C.
 */
function readLineRaw(echoMode: 'plain' | 'masked' | 'none'): Promise<string> {
  const stdin = process.stdin as Stdin;

  // Non-TTY fallback: read a single line from stdin with no fancy handling.
  if (!stdin.isTTY) {
    return new Promise(resolve => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.removeListener('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  return new Promise(resolve => {
    let buffer = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        // Enter
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buffer);
          return;
        }
        // Ctrl+C
        if (ch === '\u0003') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        // Ctrl+D on empty line = submit empty
        if (ch === '\u0004' && buffer.length === 0) {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve('');
          return;
        }
        // Backspace / Delete
        if (ch === '\u007f' || ch === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (echoMode !== 'none') {
              // Erase one character on screen: back, space, back.
              process.stdout.write('\b \b');
            }
          }
          continue;
        }
        // Ignore other control chars (arrows, escape sequences, tab, etc.)
        // Printable range: 0x20..0x7e plus UTF-8 multibyte.
        const code = ch.charCodeAt(0);
        if (code < 0x20) continue;
        buffer += ch;
        if (echoMode === 'plain') process.stdout.write(ch);
        else if (echoMode === 'masked') process.stdout.write('*');
        // echoMode === 'none': write nothing
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  process.stdout.write(`${question}${suffix}: `);
  const answer = (await readLineRaw('plain')).trim();
  return answer || defaultValue || '';
}

async function askHidden(question: string): Promise<string> {
  process.stdout.write(`${question}: `);
  const answer = await readLineRaw('masked');
  return answer.trim();
}

export async function runInit(): Promise<void> {
  const existing = readConfig();

  console.log('');
  console.log('fineCode · interactive setup');
  console.log(`Config file: ${configFile()}`);
  console.log('Press Ctrl+C anytime to abort. Existing values will be used as defaults.');
  console.log('');

  // --- Step 1: preset ---
  console.log(`Available presets: ${PRESET_NAMES.join(', ')}`);
  const preset = (await ask('Preset', existing.preset ?? 'deepseek')).toLowerCase();
  if (preset && !PRESET_NAMES.includes(preset)) {
    console.warn(`Warning: "${preset}" is not a known preset, saving as custom.`);
  }

  // --- Step 2: base URL (before model, since we may ping it to list models) ---
  const defaultBaseUrl = existing.baseUrl ?? PRESET_BASE_URLS[preset] ?? '';
  const baseUrl = await ask('Base URL (leave empty to use preset default)', defaultBaseUrl);

  // --- Step 3: API key (before model, so we can auth when listing models) ---
  let apiKey = existing.apiKey ?? '';
  if (preset === 'ollama') {
    apiKey = 'ollama';
    console.log('Ollama selected — no API key required.');
  } else {
    const input = await askHidden(
      apiKey ? 'API key (press Enter to keep existing)' : 'API key',
    );
    if (input) apiKey = input;
  }

  // --- Step 4: model (try dynamic listing, fall back to hints) ---
  const defaults: Record<string, string> = {
    deepseek: 'deepseek-chat',
    openai: 'gpt-4o',
    ollama: 'qwen2.5-coder:7b',
    moonshot: 'moonshot-v1-32k',
    groq: 'llama-3.3-70b-versatile',
    openrouter: 'anthropic/claude-sonnet-4',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  };
  const defaultModel = existing.model ?? defaults[preset] ?? '';

  let modelList: string[] | null = null;
  if (baseUrl) {
    process.stdout.write('Fetching available models… ');
    const kind = preset === 'anthropic' ? 'anthropic' : 'openai';
    const fetched = await listModels({ baseUrl, apiKey, kind });
    if (fetched && fetched.length > 0) {
      modelList = fetched.map(m => m.id);
      console.log(`found ${modelList.length}.`);
    } else {
      console.log('skipped (endpoint did not return a list).');
    }
  }

  let model = '';
  if (modelList && modelList.length > 0) {
    // Show paginated list; user may enter index OR raw name.
    const preview = modelList.slice(0, 20);
    preview.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}) ${id}`));
    if (modelList.length > preview.length) {
      console.log(`  … and ${modelList.length - preview.length} more`);
    }
    const raw = await ask('Model (number or name)', defaultModel);
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= modelList.length) {
      model = modelList[num - 1]!;
    } else {
      model = raw;
    }
  } else {
    const hints = KNOWN_MODELS[preset];
    if (hints && hints.length > 0) {
      console.log(`Known models for ${preset}: ${hints.join(', ')}`);
    }
    model = await ask('Model', defaultModel);
    // Soft validation: warn when clearly wrong.
    if (hints && hints.length > 0 && !hints.includes(model)) {
      console.warn(
        `Note: "${model}" is not in the known list for ${preset}. ` +
          `Continuing anyway — make sure the provider accepts it.`,
      );
    }
  }

  if (!model) {
    console.error('Model is required. Aborting.');
    process.exit(1);
  }

  // --- Step 5: misc ---
  const bypassAns = (
    await ask('Auto-approve all tool calls? (y/N)', existing.bypass ? 'y' : 'n')
  ).toLowerCase();
  const bypass = bypassAns === 'y' || bypassAns === 'yes';

  const patch: Partial<StoredConfig> = {
    model,
    preset: preset || undefined,
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    bypass,
  };

  writeConfig(patch);
  console.log('');
  console.log(`Saved to ${configFile()} (mode 0600).`);
  console.log('You can now run `fine` with no arguments, or `fine doctor` to verify.');
}
