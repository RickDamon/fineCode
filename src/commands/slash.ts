/**
 * Slash-command dispatcher for the REPL.
 *
 * Design:
 *   - Parse "/cmd arg1 arg2" from user input
 *   - Each command returns an async result describing what the REPL should do
 *     (render lines, switch model, clear history, etc.)
 *
 * Commands are intentionally data-oriented (return values) instead of imperative
 * (directly mutating UI state) so they're easy to test and keep the REPL layer
 * as a thin consumer.
 */

import type { Agent } from '../core/Agent.js';
import type { Session } from '../session/Session.js';
import { Session as SessionClass } from '../session/Session.js';
import { createProvider, PRESETS } from '../providers/factory.js';
import { getModelRate, formatCost, formatTokens } from '../constants/pricing.js';
import { compactHistory } from './compact.js';
import { applyMode, MODE_DESCRIPTIONS, type WorkflowMode } from '../context/WorkflowModes.js';
import { buildSystemPrompt } from '../context/SystemPrompt.js';
import { addAnchor, listAnchors, removeAnchor } from '../context/Anchors.js';
import { unifiedDiff } from '../utils/diff.js';

export interface SlashContext {
  agent: Agent;
  session: Session;
  /** Mutable reference so commands can replace it (e.g. /clear spawns a new session). */
  setSession: (s: Session) => void;
  /** Called when /model swaps the provider; UI may want to update its header. */
  onModelChange?: (modelName: string) => void;
  /** Called when /exit is invoked. */
  onExit: () => void;
}

export interface SlashResult {
  /** Lines to render in the REPL. Each item is one terminal line. */
  lines: string[];
  /** Optional status class for coloring. */
  level?: 'info' | 'warn' | 'error' | 'ok';
}

export interface SlashCommand {
  name: string;
  description: string;
  run(args: string, ctx: SlashContext): Promise<SlashResult> | SlashResult;
}

const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show available slash commands',
    run: () => ({
      lines: [
        'Available commands:',
        ...COMMANDS.map(c => `  /${c.name.padEnd(10)} ${c.description}`),
      ],
      level: 'info',
    }),
  },
  {
    name: 'clear',
    description: 'Start a fresh session (forgets history, keeps config)',
    run: (_args, ctx) => {
      const meta = ctx.session.getMeta();
      ctx.session.close();
      const next = SessionClass.create({ cwd: meta.cwd, model: meta.model });
      ctx.setSession(next);
      ctx.agent.clearHistory();
      return {
        lines: [`Cleared. New session: ${next.id}`],
        level: 'ok',
      };
    },
  },
  {
    name: 'cost',
    description: 'Show token usage and estimated cost for the current session',
    run: (_args, ctx) => {
      const s = ctx.agent.getCostSummary();
      const model = ctx.session.getMeta().model;
      const rate = getModelRate(model);
      return {
        lines: [
          `Model:         ${model}`,
          `Prompt tokens: ${formatTokens(s.promptTokens)}`,
          `Output tokens: ${formatTokens(s.completionTokens)}`,
          `Total tokens:  ${formatTokens(s.totalTokens)}`,
          `Estimated:     ${formatCost(s.cumulativeCost)}`,
          `Rate:          $${rate.input}/M in · $${rate.output}/M out`,
        ],
        level: 'info',
      };
    },
  },
  {
    name: 'model',
    description: 'Switch model (e.g. /model deepseek-reasoner)',
    run: async (args, ctx) => {
      const newModel = args.trim();
      if (!newModel) {
        return {
          lines: [`Current model: ${ctx.session.getMeta().model}`, 'Usage: /model <name>'],
          level: 'info',
        };
      }
      try {
        const { readConfig, inferApiKeyFromEnv } = await import('../config/Config.js');
        const cfg = readConfig();
        const preset = cfg.preset;
        const baseUrl = cfg.baseUrl ?? (preset ? PRESETS[preset]?.baseUrl : undefined);
        const apiKey =
          cfg.apiKey ??
          inferApiKeyFromEnv(newModel, cfg.provider, preset) ??
          (preset === 'ollama' || cfg.provider === 'ollama' ? 'ollama' : undefined);

        const provider = createProvider({
          model: newModel,
          apiKey,
          baseUrl,
          provider: cfg.provider,
        });
        ctx.agent.setProvider(provider);
        ctx.session.setModel(newModel);
        ctx.onModelChange?.(provider.name);
        return { lines: [`Switched to ${newModel}`], level: 'ok' };
      } catch (e) {
        return { lines: [`Failed to switch: ${(e as Error).message}`], level: 'error' };
      }
    },
  },
  {
    name: 'compact',
    description: 'Compress older messages into a summary to free up context',
    run: async (_args, ctx) => {
      const history = ctx.agent.getHistory();
      if (history.length < 4) {
        return { lines: ['Not enough messages to compact.'], level: 'info' };
      }
      const meta = ctx.session.getMeta();
      try {
        const { summary, kept } = await compactHistory(history, meta.model);
        const dropped = ctx.agent.compactWithSummary(summary, kept);
        return {
          lines: [
            `Compacted ${dropped} messages into a ${summary.length}-byte summary.`,
            `Summary preview: ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}`,
          ],
          level: 'ok',
        };
      } catch (e) {
        return { lines: [`Compact failed: ${(e as Error).message}`], level: 'error' };
      }
    },
  },
  {
    name: 'sessions',
    description: 'List recent sessions (use `fine --resume` to pick)',
    run: () => {
      const list = SessionClass.list(10);
      if (list.length === 0) return { lines: ['No sessions found.'], level: 'info' };
      return {
        lines: list.map(m => {
          const ts = new Date(m.lastAt).toLocaleString();
          const title = (m.title ?? '(untitled)').replace(/\s+/g, ' ').slice(0, 50);
          return `  ${m.id}  ${ts}  ${title}`;
        }),
        level: 'info',
      };
    },
  },
  {
    name: 'diff',
    description: 'Show a unified diff for each file the agent has changed this session',
    run: async (args, ctx) => {
      const filter = args.trim();
      const snaps = ctx.session.getSnapshots();
      if (snaps.length === 0) return { lines: ['No edits recorded in this session yet.'], level: 'info' };

      // Earliest snapshot per path = pre-edit baseline (same grouping as /rewind).
      const earliestByPath = new Map<string, (typeof snaps)[number]>();
      for (const s of snaps) {
        if (!earliestByPath.has(s.path)) earliestByPath.set(s.path, s);
      }

      const { promises: fs } = await import('node:fs');
      const lines: string[] = [];
      let filesShown = 0;
      let totalAdd = 0;
      let totalDel = 0;

      for (const s of earliestByPath.values()) {
        if (filter && !s.path.includes(filter)) continue;
        let oldContent = '';
        if (s.hash !== 'ABSENT') {
          const buf = ctx.session.readSnapshot(s.hash);
          if (!buf) {
            lines.push(`## ${s.path}  (snapshot missing)`);
            continue;
          }
          oldContent = buf.toString('utf8');
        }
        let newContent = '';
        try {
          newContent = await fs.readFile(s.path, 'utf8');
        } catch (e) {
          // File deleted after edit? Treat as empty.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            lines.push(`## ${s.path}  (read error: ${(e as Error).message})`);
            continue;
          }
        }
        const result = unifiedDiff(oldContent, newContent, {
          fromLabel: `${s.path} (snapshot)`,
          toLabel: `${s.path} (current)`,
        });
        if (result.identical) continue;
        filesShown++;
        totalAdd += result.added;
        totalDel += result.removed;
        lines.push(
          `## ${s.path}  (+${result.added} -${result.removed})`,
          result.diff || '(empty)',
          '',
        );
      }

      if (filesShown === 0) {
        return {
          lines: filter
            ? [`No diffs matching "${filter}".`]
            : ['No meaningful changes (files match their snapshots).'],
          level: 'info',
        };
      }
      return {
        lines: [`Summary: ${filesShown} file(s), +${totalAdd} -${totalDel}`, '', ...lines],
        level: 'info',
      };
    },
  },
  {
    name: 'rewind',
    description: 'Undo the most recent file edit(s) recorded in this session',
    run: async (_args, ctx) => {
      const snaps = ctx.session.getSnapshots();
      if (snaps.length === 0) return { lines: ['No snapshots to rewind.'], level: 'info' };
      // Reverse order: restore newest snapshot first so we end at the earliest recorded state
      // for that path.
      const restored: string[] = [];
      const errors: string[] = [];
      // Group by path so we only restore the oldest snapshot per path (= earliest recorded state).
      const earliestByPath = new Map<string, (typeof snaps)[number]>();
      for (const s of snaps) {
        if (!earliestByPath.has(s.path)) earliestByPath.set(s.path, s);
      }
      const { promises: fs } = await import('node:fs');
      for (const s of earliestByPath.values()) {
        try {
          if (s.hash === 'ABSENT') {
            await fs.unlink(s.path).catch(() => {});
            restored.push(`  deleted ${s.path}`);
          } else {
            const buf = ctx.session.readSnapshot(s.hash);
            if (!buf) {
              errors.push(`  missing snapshot for ${s.path}`);
              continue;
            }
            await fs.writeFile(s.path, buf);
            restored.push(`  restored ${s.path} (${buf.byteLength} bytes)`);
          }
        } catch (e) {
          errors.push(`  ${s.path}: ${(e as Error).message}`);
        }
      }
      return {
        lines: [
          `Rewound ${restored.length} file(s):`,
          ...restored,
          ...(errors.length ? ['Errors:', ...errors] : []),
          '',
          'Note: the conversation history is NOT modified. The assistant still "knows" it edited these files.',
          'Run /clear if you want a completely fresh start.',
        ],
        level: restored.length > 0 ? 'ok' : 'warn',
      };
    },
  },
  {
    name: 'mode',
    description: 'Switch workflow mode: none | ddd | tdd | sdd',
    run: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        const current = ctx.session.getMeta().mode ?? 'none';
        return {
          lines: [
            `Current mode: ${current}`,
            '',
            ...Object.entries(MODE_DESCRIPTIONS).map(([k, v]) => `  /mode ${k.padEnd(4)} — ${v}`),
          ],
          level: 'info',
        };
      }
      if (!['none', 'ddd', 'tdd', 'sdd'].includes(requested)) {
        return {
          lines: [`Unknown mode: ${requested}. Valid: none / ddd / tdd / sdd`],
          level: 'error',
        };
      }
      return applyModeAndReport(requested as WorkflowMode, ctx);
    },
  },
  { name: 'ddd', description: 'Shortcut for `/mode ddd`', run: async (_a, c) => applyModeAndReport('ddd', c) },
  { name: 'tdd', description: 'Shortcut for `/mode tdd`', run: async (_a, c) => applyModeAndReport('tdd', c) },
  { name: 'sdd', description: 'Shortcut for `/mode sdd`', run: async (_a, c) => applyModeAndReport('sdd', c) },
  {
    name: 'anchor',
    description: 'Pin a note that survives compaction (e.g. /anchor always use pnpm)',
    run: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        const all = listAnchors();
        if (all.length === 0) return { lines: ['No anchors set.'], level: 'info' };
        return {
          lines: ['Current anchors:', ...all.map(a => `  [${a.id}] ${a.text}`)],
          level: 'info',
        };
      }
      const a = addAnchor(text);
      // Also refresh the system prompt immediately so the pinned note takes effect now.
      await rebuildSystemPrompt(ctx);
      return { lines: [`Pinned [${a.id}]: ${a.text}`], level: 'ok' };
    },
  },
  {
    name: 'anchors',
    description: 'List pinned context entries',
    run: async () => {
      const all = listAnchors();
      if (all.length === 0) return { lines: ['No anchors set.'], level: 'info' };
      return {
        lines: ['Pinned context:', ...all.map(a => `  [${a.id}] ${a.text}`)],
        level: 'info',
      };
    },
  },
  {
    name: 'unanchor',
    description: 'Remove a pinned entry: /unanchor <id> or /unanchor all',
    run: async (args, ctx) => {
      const id = args.trim();
      if (!id) return { lines: ['Usage: /unanchor <id> OR /unanchor all'], level: 'error' };
      const ok = removeAnchor(id);
      if (!ok) return { lines: [`No anchor with id "${id}".`], level: 'error' };
      await rebuildSystemPrompt(ctx);
      return { lines: [id === 'all' ? 'All anchors cleared.' : `Removed [${id}].`], level: 'ok' };
    },
  },
  {
    name: 'exit',
    description: 'Exit fineCode',
    run: (_args, ctx) => {
      ctx.onExit();
      return { lines: ['Goodbye.'], level: 'info' };
    },
  },
];

const COMMAND_MAP = new Map(COMMANDS.map(c => [c.name, c]));

/**
 * Rebuild the system prompt with the current mode/anchors and hot-swap it.
 * Called after /anchor, /unanchor so pinned context takes effect immediately.
 */
async function rebuildSystemPrompt(ctx: SlashContext): Promise<void> {
  const meta = ctx.session.getMeta();
  const base = await buildSystemPrompt(meta.cwd);
  ctx.agent.setSystemPrompt(applyMode(base, meta.mode ?? 'none'));
}

/**
 * Rebuild the system prompt with the requested mode layered on and hot-swap
 * it into the agent. Persists the mode to the session so resume keeps it.
 */
async function applyModeAndReport(
  mode: WorkflowMode,
  ctx: SlashContext,
): Promise<SlashResult> {
  try {
    const meta = ctx.session.getMeta();
    const base = await buildSystemPrompt(meta.cwd);
    ctx.agent.setSystemPrompt(applyMode(base, mode));
    ctx.session.setMode(mode);
    return {
      lines:
        mode === 'none'
          ? ['Mode cleared. Back to the default harness.']
          : [`Mode set to ${mode.toUpperCase()}.`, MODE_DESCRIPTIONS[mode]],
      level: 'ok',
    };
  } catch (e) {
    return { lines: [`Failed to set mode: ${(e as Error).message}`], level: 'error' };
  }
}

/** Returns null if input is not a slash command. */
export async function tryRunSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<SlashResult | null> {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input.slice(1) : input.slice(1, space);
  const args = space === -1 ? '' : input.slice(space + 1).trim();

  const cmd = COMMAND_MAP.get(name.toLowerCase());
  if (!cmd) {
    return {
      lines: [`Unknown command: /${name}`, 'Type /help to see available commands.'],
      level: 'error',
    };
  }
  return cmd.run(args, ctx);
}

export function listCommands(): SlashCommand[] {
  return [...COMMANDS];
}
