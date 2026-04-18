/**
 * Agent Bridge — runs a fineCode Agent inside the VS Code Extension Host and
 * pipes its events into a Webview via postMessage.
 *
 * Responsibilities:
 *   - Construct Provider + Agent + Session + PermissionManager (same wiring
 *     as src/cli.tsx `launchRepl`, but without Ink).
 *   - For each user turn: run `agent.run()` and translate every AgentEvent
 *     into a HostToWebviewMsg.
 *   - For permission prompts: assign an id, send a `permission_request` to
 *     the webview, await the matching `permission_response`.
 *
 * What it intentionally does NOT do:
 *   - UI rendering (that's the webview)
 *   - Slash command semantics (delegated to a small dispatcher here, but the
 *     heavy ones like compact/diff reuse existing src/commands/* modules)
 */

import * as vscode from 'vscode';
import * as path from 'node:path';

// Core fineCode imports — these live in ../src and are bundled by esbuild.
// NOTE: esbuild follows the `.js` extension convention used by the ESM core.
import { Agent, type AgentEvent } from '../../src/core/Agent.js';
import { createProvider, PRESETS } from '../../src/providers/factory.js';
import { PermissionManager } from '../../src/permission/PermissionManager.js';
import { buildSystemPrompt } from '../../src/context/SystemPrompt.js';
import { applyMode } from '../../src/context/WorkflowModes.js';
import { matchSkills, skillsSystemBlock } from '../../src/context/Skills.js';
import { DEFAULT_TOOLS } from '../../src/tools/index.js';
import { Session } from '../../src/session/Session.js';
import { resolveConfig, readConfig } from '../../src/config/Config.js';
import { createSpawnAgentTool } from '../../src/tools/SpawnAgentTool.js';
import { wrapGenericError } from '../../src/core/ProviderError.js';
import { getModelRate } from '../../src/constants/pricing.js';
import type { ToolDefinition, Message } from '../../src/core/types.js';

import type {
  HostToWebviewMsg,
  WebviewToHostMsg,
  SerializedMessage,
  SessionSummary,
} from './protocol.js';

type Decision = 'allow' | 'allow_always' | 'deny';

/**
 * Merge VS Code settings over ~/.fineCode/config.json.
 * VS Code settings take precedence (so users can override per-workspace).
 */
function resolveRuntimeConfig(): {
  model: string;
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  bypass: boolean;
  provider?: 'openai' | 'anthropic' | 'ollama';
} {
  const cfg = vscode.workspace.getConfiguration('fineCode');
  const fromVsCode = {
    model: (cfg.get<string>('model') || '').trim() || undefined,
    preset: (cfg.get<string>('preset') || '').trim() || undefined,
    apiKey: (cfg.get<string>('apiKey') || '').trim() || undefined,
    baseUrl: (cfg.get<string>('baseUrl') || '').trim() || undefined,
    bypass: cfg.get<boolean>('bypassPermissions') ?? false,
  };

  // Fall through to the same resolution pipeline the CLI uses (env + file).
  const resolved = resolveConfig({
    model: fromVsCode.model,
    preset: fromVsCode.preset,
    apiKey: fromVsCode.apiKey,
    baseUrl: fromVsCode.baseUrl,
    bypass: fromVsCode.bypass,
  });

  // Apply preset base URL if the user chose a preset but didn't override URL.
  let baseUrl = resolved.baseUrl;
  if (resolved.preset && !baseUrl) {
    const p = PRESETS[resolved.preset];
    if (p?.baseUrl) baseUrl = p.baseUrl;
  }

  return {
    model: resolved.model ?? '',
    preset: resolved.preset,
    baseUrl,
    apiKey: resolved.apiKey,
    bypass: resolved.bypass ?? false,
    provider: resolved.provider,
  };
}

function serializeMessage(m: Message): SerializedMessage {
  return {
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    toolCallId: m.toolCallId,
    name: m.name,
  };
}

function listSessionSummaries(limit = 20): SessionSummary[] {
  return Session.list(limit).map(m => ({
    id: m.id,
    title: m.title ?? '(untitled)',
    lastAt: m.lastAt,
    model: m.model,
    messageCount: m.messageCount,
  }));
}

/**
 * Owns one Agent + one Webview. Lifecycle: created when the chat view
 * becomes visible for the first time (or via `fineCode.open`).
 */
export class AgentBridge {
  private readonly output: vscode.OutputChannel;
  private agent!: Agent;
  private session!: Session;
  private permissionManager!: PermissionManager;
  private model: string = '';
  private cwd: string;

  private webview: vscode.Webview | null = null;
  /** Promise resolvers for in-flight permission prompts, keyed by id. */
  private pendingPermissions = new Map<string, (d: Decision) => void>();
  /** AbortController for the currently-running turn; null when idle. */
  private currentAbort: AbortController | null = null;
  private turnCounter = 0;

  constructor(_ctx: vscode.ExtensionContext, cwd: string, output: vscode.OutputChannel) {
    this.cwd = cwd;
    this.output = output;
  }

  /** Build provider + session + agent. Throws if config is incomplete. */
  async initialize(opts: { resumeSessionId?: string; continueLatest?: boolean } = {}): Promise<void> {
    const rc = resolveRuntimeConfig();
    if (!rc.model) {
      throw new Error(
        'No model configured. Open "fineCode: Open Config File" or set "fineCode.model" in VS Code settings.',
      );
    }

    const isOllama = rc.preset === 'ollama' || rc.provider === 'ollama';
    if (!rc.apiKey && !isOllama) {
      throw new Error(
        'No API key found. Run `fine init` in a terminal, or set "fineCode.apiKey" in VS Code settings.',
      );
    }

    this.model = rc.model;

    // Session: resume / continue / new
    let session: Session;
    let initialHistory: Message[] = [];
    if (opts.resumeSessionId) {
      const loaded = Session.load(opts.resumeSessionId);
      if (!loaded) throw new Error(`Session not found: ${opts.resumeSessionId}`);
      session = loaded.session;
      initialHistory = loaded.messages;
    } else if (opts.continueLatest) {
      const recent = Session.mostRecent(this.cwd);
      if (recent) {
        const loaded = Session.load(recent.id);
        if (loaded) {
          session = loaded.session;
          initialHistory = loaded.messages;
        } else {
          session = Session.create({ cwd: this.cwd, model: rc.model });
        }
      } else {
        session = Session.create({ cwd: this.cwd, model: rc.model });
      }
    } else {
      session = Session.create({ cwd: this.cwd, model: rc.model });
    }
    this.session = session;

    const provider = createProvider({
      model: session.getMeta().model,
      apiKey: rc.apiKey ?? 'ollama',
      baseUrl: rc.baseUrl,
      provider: rc.provider,
    });
    this.model = provider.model;

    const systemPromptBase = await buildSystemPrompt(this.cwd);
    const systemPrompt = applyMode(systemPromptBase, session.getMeta().mode ?? 'none');

    this.permissionManager = new PermissionManager({ bypass: rc.bypass });

    // Bridge the permission callback: webview gets a message, we wait for reply.
    const permissionPrompt = (tool: ToolDefinition, _input: unknown, preview: string) =>
      new Promise<Decision>(resolve => {
        if (!this.webview) {
          resolve('deny');
          return;
        }
        const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.pendingPermissions.set(id, resolve);
        this.post({
          type: 'permission_request',
          id,
          toolName: tool.name,
          preview,
        });
      });

    this.agent = new Agent({
      provider,
      tools: DEFAULT_TOOLS,
      permissionManager: this.permissionManager,
      permissionPrompt,
      systemPrompt,
      cwd: this.cwd,
      session,
      initialHistory,
    });

    // Skills augmenter: same behavior as the CLI.
    this.agent.setSystemPromptAugmenter(userInput => {
      const matched = matchSkills(userInput);
      return skillsSystemBlock(matched);
    });

    // Register spawn_agent (model can delegate to subagents).
    const currentToolList = (this.agent as unknown as { config: { tools: ToolDefinition[] } }).config.tools;
    const spawnTool = createSpawnAgentTool({
      parentTools: currentToolList,
      parentModel: provider.model,
      cwd: this.cwd,
      parentSystemPrompt: systemPrompt,
      depth: 0,
    });
    this.agent.registerTool(spawnTool);

    // MCP connection is intentionally deferred — it can fail / hang, and we
    // don't want to block the first chat panel from appearing. We'll wire it
    // in a v2 once basic chat works.
    void readConfig;

    this.log(`fineCode initialized: model=${provider.model}, session=${session.id}, cwd=${this.cwd}`);
  }

  /** Attach a webview; sends the initial snapshot. */
  attach(webview: vscode.Webview): void {
    this.webview = webview;

    webview.onDidReceiveMessage((msg: WebviewToHostMsg) => {
      void this.handleWebviewMessage(msg);
    });
  }

  /** Called when the view is disposed; cancels in-flight work. */
  dispose(): void {
    this.currentAbort?.abort();
    // Reject any pending permission with deny so the agent unwinds cleanly.
    for (const resolve of this.pendingPermissions.values()) resolve('deny');
    this.pendingPermissions.clear();
    this.session?.close();
    this.webview = null;
  }

  // -------- message handling --------

  private async handleWebviewMessage(msg: WebviewToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendInitialSnapshot();
        return;
      case 'send':
        await this.runTurn(msg.text);
        return;
      case 'permission_response': {
        const resolve = this.pendingPermissions.get(msg.id);
        if (resolve) {
          this.pendingPermissions.delete(msg.id);
          resolve(msg.decision);
        }
        return;
      }
      case 'abort':
        this.currentAbort?.abort();
        return;
      case 'slash':
        await this.handleSlash(msg.command, msg.args);
        return;
      case 'open_session':
        await this.switchSession(msg.sessionId);
        return;
      case 'list_sessions':
        this.post({
          type: 'ready',
          model: this.model,
          cwd: this.cwd,
          sessionId: this.session.id,
          history: this.agent.getHistory().map(serializeMessage),
          sessions: listSessionSummaries(),
          cumulativeCost: this.agent.getCostSummary().cumulativeCost,
          totalTokens: this.agent.getCostSummary().totalTokens,
          contextWindow: getModelRate(this.model).contextWindow,
          bypass: this.permissionManager.isBypass(),
        });
        return;
    }
  }

  private sendInitialSnapshot(): void {
    const history = this.agent.getHistory().map(serializeMessage);
    const cost = this.agent.getCostSummary();
    this.post({
      type: 'ready',
      model: this.model,
      cwd: this.cwd,
      sessionId: this.session.id,
      history,
      sessions: listSessionSummaries(),
      cumulativeCost: cost.cumulativeCost,
      totalTokens: cost.totalTokens,
      contextWindow: getModelRate(this.model).contextWindow,
      bypass: this.permissionManager.isBypass(),
    });
  }

  /** Run one user turn. Drives the agent and maps events to the webview. */
  private async runTurn(text: string): Promise<void> {
    // If already running, reject — the UI should gate sending too but defense
    // in depth.
    if (this.currentAbort) {
      this.post({ type: 'info', text: 'Previous turn still running — ignored.' });
      return;
    }

    this.turnCounter += 1;
    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      for await (const ev of this.agent.run(text, abort.signal)) {
        this.emitEvent(ev);
      }
    } catch (err) {
      const wrapped = wrapGenericError(err, { model: this.model });
      this.post({
        type: 'error',
        message: wrapped.message,
        hint: wrapped.hint || undefined,
      });
    } finally {
      this.currentAbort = null;
      this.post({ type: 'turn_done' });
    }
  }

  private emitEvent(ev: AgentEvent): void {
    switch (ev.type) {
      case 'assistant_text':
        this.post({ type: 'assistant_delta', delta: ev.delta, buffer: ev.buffer });
        return;
      case 'assistant_done':
        this.post({ type: 'assistant_done', message: serializeMessage(ev.message) });
        return;
      case 'tool_start':
        this.post({
          type: 'tool_start',
          callId: ev.call.id,
          toolName: ev.tool.name,
          preview: safeRenderPreview(ev.tool, ev.call.arguments),
        });
        return;
      case 'tool_result':
        this.post({
          type: 'tool_result',
          callId: ev.call.id,
          toolName: ev.tool.name,
          content: truncateForUI(ev.content),
          isError: ev.isError,
        });
        return;
      case 'tool_denied':
        this.post({ type: 'tool_denied', callId: ev.call.id, toolName: ev.tool.name });
        return;
      case 'usage':
        this.post({
          type: 'usage',
          promptTokens: ev.usage.promptTokens,
          completionTokens: ev.usage.completionTokens,
          totalTokens: ev.usage.totalTokens,
          cumulativeCost: ev.cumulativeCost,
          model: ev.model,
          contextWindow: getModelRate(ev.model).contextWindow,
        });
        return;
      case 'compacted':
        this.post({ type: 'compacted', droppedMessages: ev.droppedMessages, summary: ev.summary });
        return;
      case 'info':
        this.post({ type: 'info', text: ev.text });
        return;
      case 'subagent_event':
        // For v1 we surface subagent activity as info lines. v2 can render a
        // dedicated collapsible block.
        this.post({
          type: 'info',
          text: `[${ev.agentName} · depth ${ev.depth}] ${summarizeSubEvent(ev.event)}`,
        });
        return;
      case 'turn_done':
        // We emit our own 'turn_done' in the finally block after the generator
        // completes; ignore here to avoid double-firing.
        return;
      case 'error':
        this.post({ type: 'error', message: ev.error.message });
        return;
    }
  }

  // -------- slash commands --------

  private async handleSlash(command: string, args: string[]): Promise<void> {
    // Keep the v1 set minimal; match the most-used CLI commands. Heavy ones
    // (/compact, /diff, /rewind) lean on existing src/commands/* modules.
    switch (command) {
      case 'help':
        this.post({
          type: 'info',
          text:
            'Slash commands: /help /clear /model <name> /cost /compact /sessions /diff [path] /rewind',
        });
        return;
      case 'clear':
        await this.clearHistory();
        return;
      case 'model': {
        const name = args[0];
        if (!name) {
          this.post({ type: 'info', text: `Current model: ${this.model}` });
          return;
        }
        await this.switchModel(name);
        return;
      }
      case 'cost': {
        const c = this.agent.getCostSummary();
        this.post({
          type: 'info',
          text: `tokens: ${c.totalTokens} (prompt ${c.promptTokens} / completion ${c.completionTokens}) · cost: $${c.cumulativeCost.toFixed(4)}`,
        });
        return;
      }
      case 'compact': {
        const { compactHistory } = await import('../../src/commands/compact.js');
        try {
          const result = await compactHistory(this.agent.getHistory(), this.model);
          const droppedCount = this.agent.compactWithSummary(result.summary, result.kept);
          this.post({
            type: 'compacted',
            droppedMessages: droppedCount,
            summary: result.summary,
          });
        } catch (err) {
          this.post({ type: 'error', message: `Compact failed: ${(err as Error).message}` });
        }
        return;
      }
      case 'sessions':
        this.post({
          type: 'info',
          text:
            `Sessions:\n` +
            listSessionSummaries(10)
              .map(s => `  ${s.id}  [${s.model}]  ${s.title}`)
              .join('\n'),
        });
        return;
      case 'diff': {
        const { unifiedDiff } = await import('../../src/utils/diff.js');
        const snapshots = this.session.getSnapshots();
        const filter = args[0];
        const filtered = filter ? snapshots.filter(s => s.path.includes(filter)) : snapshots;
        if (filtered.length === 0) {
          this.post({ type: 'info', text: 'No file changes in this session.' });
          return;
        }
        const fs = await import('node:fs');
        const parts: string[] = [];
        for (const snap of filtered) {
          const original = this.session.readSnapshot(snap.hash);
          if (!original) continue;
          let current = '';
          try {
            current = fs.readFileSync(snap.path, 'utf8');
          } catch {
            current = '(file no longer exists)';
          }
          const d = unifiedDiff(original.toString('utf8'), current, {
            fromLabel: snap.path,
            toLabel: snap.path,
          });
          if (d.identical) continue;
          parts.push(`${d.diff}\n(+${d.added} -${d.removed})`);
        }
        this.post({
          type: 'info',
          text: parts.length ? parts.join('\n\n') : 'No effective changes.',
        });
        return;
      }
      default:
        this.post({ type: 'info', text: `Unknown command: /${command}. Try /help.` });
    }
  }

  private async clearHistory(): Promise<void> {
    // Start a new session so persistence doesn't mix old + new turns.
    const newSession = Session.create({ cwd: this.cwd, model: this.model });
    this.session.close();
    this.session = newSession;
    this.agent.clearHistory();
    // Replace the agent's internal session reference.
    (this.agent as unknown as { config: { session: Session } }).config.session = newSession;
    this.post({
      type: 'session_switched',
      sessionId: newSession.id,
      history: [],
      model: this.model,
    });
    this.post({ type: 'info', text: 'New session started.' });
  }

  private async switchModel(name: string): Promise<void> {
    const rc = resolveRuntimeConfig();
    try {
      const provider = createProvider({
        model: name,
        apiKey: rc.apiKey ?? 'ollama',
        baseUrl: rc.baseUrl,
        provider: rc.provider,
      });
      this.agent.setProvider(provider);
      this.model = provider.model;
      this.session.setModel(provider.model);
      this.post({ type: 'model_changed', model: provider.model });
      this.post({ type: 'info', text: `Model switched to ${provider.model}` });
    } catch (err) {
      this.post({ type: 'error', message: `Failed to switch model: ${(err as Error).message}` });
    }
  }

  private async switchSession(id: string): Promise<void> {
    const loaded = Session.load(id);
    if (!loaded) {
      this.post({ type: 'error', message: `Session not found: ${id}` });
      return;
    }
    this.session.close();
    this.session = loaded.session;
    this.agent.clearHistory();
    (this.agent as unknown as { config: { session: Session; initialHistory?: Message[] } }).config.session = loaded.session;
    // Re-seed in-memory history by loading directly.
    for (const m of loaded.messages) {
      (this.agent as unknown as { history: Message[] }).history.push(m);
    }
    this.post({
      type: 'session_switched',
      sessionId: loaded.session.id,
      history: loaded.messages.map(serializeMessage),
      model: this.model,
    });
  }

  // -------- utilities --------

  private post(msg: HostToWebviewMsg): void {
    this.webview?.postMessage(msg);
  }

  private log(line: string): void {
    this.output.appendLine(`[fineCode] ${line}`);
  }
}

/** Safely render a tool-call preview string for the permission dialog. */
function safeRenderPreview(tool: ToolDefinition, argsJson: string): string {
  try {
    const input = JSON.parse(argsJson);
    return tool.renderCall(input);
  } catch {
    return `${tool.name}(...)`;
  }
}

/**
 * Truncate very long tool output for UI display. The agent's history gets the
 * micro-compacted version separately; this is purely for the webview to avoid
 * postMessage payloads in the megabytes.
 */
function truncateForUI(s: string, max = 32_000): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return `${head}\n\n…[${s.length - head.length - tail.length} chars truncated in UI]…\n\n${tail}`;
}

function summarizeSubEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case 'assistant_text':
      return `· ${ev.delta.slice(0, 80)}`;
    case 'tool_start':
      return `→ ${ev.tool.name}`;
    case 'tool_result':
      return `✓ ${ev.tool.name}${ev.isError ? ' (error)' : ''}`;
    case 'usage':
      return `usage: ${ev.usage.totalTokens} tok`;
    default:
      return ev.type;
  }
}

// Silence unused import warning — path is reserved for a future feature (relative cwd rendering).
void path;
