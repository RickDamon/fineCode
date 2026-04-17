import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Agent } from '../core/Agent.js';
import type { ToolDefinition } from '../core/types.js';
import { ProviderError } from '../core/ProviderError.js';
import type { Session } from '../session/Session.js';
import { formatCost, formatTokens, getModelRate } from '../constants/pricing.js';
import { tryRunSlashCommand, type SlashResult } from '../commands/slash.js';
import { shouldAutoCompact, compactHistory, KEEP_TAIL_DEFAULT } from '../commands/compact.js';

const MAX_TOOL_OUTPUT_PREVIEW = 400;
const MAX_TOOL_OUTPUT_LINES_EXPANDED = 40;

type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      preview: string;
      status: 'running' | 'ok' | 'error' | 'denied';
      output?: string;
      outputBytes?: number;
      outputLines?: number;
    }
  | { kind: 'error'; text: string; hint?: string }
  | { kind: 'info'; text: string; level?: 'info' | 'ok' | 'warn' | 'error' };

interface PermissionRequest {
  tool: ToolDefinition;
  preview: string;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

interface Props {
  agent: Agent;
  modelName: string;
  /** Must be passed by the caller (Session + setter so /clear can swap it). */
  session: Session;
  setSession: (s: Session) => void;
  onPermissionRequest: (register: (req: PermissionRequest) => void) => void;
}

export function REPL({ agent, modelName, session, setSession, onPermissionRequest }: Props) {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([
    {
      kind: 'info',
      text: `fine · model: ${modelName} · session: ${session.id} · /help for commands · Ctrl+C to exit`,
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [headerModel, setHeaderModel] = useState(modelName);
  const [usage, setUsage] = useState({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cumulativeCost: 0,
  });
  const [compacting, setCompacting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Sync usage from agent whenever a tick happens. Seed from agent in case we resumed.
  useEffect(() => {
    const s = agent.getCostSummary();
    setUsage(s);
  }, [agent]);

  // Register permission handler.
  useEffect(() => {
    onPermissionRequest(req => setPermission(req));
  }, [onPermissionRequest]);

  // Permission dialog key handler.
  useInput(
    (ch, key) => {
      if (!permission) return;
      if (ch === 'y' || key.return) {
        permission.resolve('allow');
        setPermission(null);
      } else if (ch === 'a') {
        permission.resolve('allow_always');
        setPermission(null);
      } else if (ch === 'n' || key.escape) {
        permission.resolve('deny');
        setPermission(null);
      }
    },
    { isActive: permission !== null },
  );

  // Ctrl+C handling during busy.
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === 'c') {
        if (busy && abortRef.current) {
          abortRef.current.abort();
        } else {
          exit();
        }
      }
    },
    { isActive: !permission },
  );

  const pushLines = (lines: string[], level: DisplayItem['kind'] | 'ok' | 'warn' = 'info') => {
    const mapped = lines.map<DisplayItem>(text => {
      if (level === 'error') return { kind: 'error', text };
      if (level === 'ok' || level === 'warn' || level === 'info')
        return { kind: 'info', text, level };
      return { kind: 'info', text };
    });
    setItems(prev => [...prev, ...mapped]);
  };

  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput('');

    // Slash command path — short-circuits the agent loop.
    if (text.startsWith('/')) {
      setItems(prev => [...prev, { kind: 'user', text }]);
      const result: SlashResult | null = await tryRunSlashCommand(text.trim(), {
        agent,
        session,
        setSession,
        onModelChange: name => setHeaderModel(name),
        onExit: () => exit(),
      });
      if (result) {
        pushLines(result.lines, result.level ?? 'info');
      }
      return;
    }

    setItems(prev => [...prev, { kind: 'user', text }]);

    // Auto-compact check BEFORE firing the turn, so a huge context doesn't crash the request.
    const model = session.getMeta().model;
    if (shouldAutoCompact(model, usage.totalTokens)) {
      setCompacting(true);
      try {
        const { summary, kept } = await compactHistory(agent.getHistory(), model, KEEP_TAIL_DEFAULT);
        const dropped = agent.compactWithSummary(summary, kept);
        setItems(prev => [
          ...prev,
          {
            kind: 'info',
            level: 'warn',
            text: `Auto-compacted ${dropped} messages (approaching context window).`,
          },
        ]);
      } catch (e) {
        setItems(prev => [
          ...prev,
          { kind: 'error', text: `Auto-compact failed: ${(e as Error).message}` },
        ]);
      } finally {
        setCompacting(false);
      }
    }

    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;

    let currentAssistantIdx = -1;

    try {
      for await (const event of agent.run(text, ac.signal)) {
        await new Promise(r => setImmediate(r)); // yield to render

        if (event.type === 'assistant_text') {
          setItems(prev => {
            const next = [...prev];
            if (currentAssistantIdx === -1) {
              currentAssistantIdx = next.length;
              next.push({ kind: 'assistant', text: event.buffer });
            } else {
              next[currentAssistantIdx] = { kind: 'assistant', text: event.buffer };
            }
            return next;
          });
        } else if (event.type === 'assistant_done') {
          currentAssistantIdx = -1;
        } else if (event.type === 'tool_start') {
          setItems(prev => [
            ...prev,
            {
              kind: 'tool',
              name: event.tool.name,
              preview: event.tool.renderCall(safeParseArgs(event.call.arguments)),
              status: 'running',
            },
          ]);
        } else if (event.type === 'tool_result') {
          setItems(prev => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i]!;
              if (it.kind === 'tool' && it.status === 'running' && it.name === event.tool.name) {
                const lineCount = event.content.split('\n').length;
                next[i] = {
                  ...it,
                  status: event.isError ? 'error' : 'ok',
                  output: foldLongOutput(event.content),
                  outputBytes: event.content.length,
                  outputLines: lineCount,
                };
                break;
              }
            }
            return next;
          });
        } else if (event.type === 'tool_denied') {
          setItems(prev => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i]!;
              if (it.kind === 'tool' && it.status === 'running' && it.name === event.tool.name) {
                next[i] = { ...it, status: 'denied' };
                break;
              }
            }
            return next;
          });
        } else if (event.type === 'usage') {
          setUsage({
            promptTokens: agent.getCostSummary().promptTokens,
            completionTokens: agent.getCostSummary().completionTokens,
            totalTokens: agent.getCostSummary().totalTokens,
            cumulativeCost: event.cumulativeCost,
          });
        } else if (event.type === 'subagent_event') {
          // Render subagent activity inline, indented, and dimmed so parent flow stays readable.
          const sub = event.event;
          const prefix = `  ${'  '.repeat(event.depth - 1)}↳ [${event.agentName}]`;
          if (sub.type === 'assistant_text') {
            // Only show the first ~120 chars of the rolling buffer to avoid noise.
            const preview = sub.buffer.slice(0, 120);
            setItems(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (
                last &&
                last.kind === 'info' &&
                last.level === 'info' &&
                last.text.startsWith(prefix + ' ')
              ) {
                next[next.length - 1] = { kind: 'info', level: 'info', text: `${prefix} ${preview}` };
              } else {
                next.push({ kind: 'info', level: 'info', text: `${prefix} ${preview}` });
              }
              return next;
            });
          } else if (sub.type === 'tool_start') {
            setItems(prev => [
              ...prev,
              { kind: 'info', level: 'info', text: `${prefix} ⧖ ${sub.tool.name}` },
            ]);
          } else if (sub.type === 'tool_result') {
            setItems(prev => [
              ...prev,
              {
                kind: 'info',
                level: sub.isError ? 'error' : 'ok',
                text: `${prefix} ${sub.isError ? '✗' : '✓'} ${sub.tool.name}`,
              },
            ]);
          } else if (sub.type === 'error') {
            setItems(prev => [
              ...prev,
              { kind: 'info', level: 'error', text: `${prefix} ✗ ${sub.error.message.slice(0, 120)}` },
            ]);
          }
        } else if (event.type === 'error') {
          const err = event.error;
          if (err instanceof ProviderError) {
            const header = err.status ? `[${err.status}] ${err.message}` : err.message;
            setItems(prev => [...prev, { kind: 'error', text: header, hint: err.hint }]);
          } else {
            setItems(prev => [...prev, { kind: 'error', text: err.message }]);
          }
        }
      }
    } catch (err) {
      setItems(prev => [...prev, { kind: 'error', text: (err as Error).message }]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const model = session.getMeta().model;
  const ctxWindow = getModelRate(model).contextWindow;
  const ctxPercent = ctxWindow ? Math.min(100, Math.round((usage.totalTokens / ctxWindow) * 100)) : 0;

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <ItemView key={i} item={item} />
      ))}

      {busy && !permission && (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> thinking… (Ctrl+C to interrupt)</Text>
        </Box>
      )}

      {compacting && (
        <Box>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> compacting history…</Text>
        </Box>
      )}

      {permission && <PermissionDialog req={permission} />}

      {!busy && !permission && !compacting && (
        <Box marginTop={1}>
          <Text color="green">❯ </Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}

      {/* Status bar — always visible */}
      <Box marginTop={1}>
        <Text dimColor>
          {headerModel} · {formatTokens(usage.totalTokens)} tokens
          {ctxWindow ? ` (${ctxPercent}% of ${formatTokens(ctxWindow)})` : ''}
          {' · '}
          {formatCost(usage.cumulativeCost)}
        </Text>
      </Box>
    </Box>
  );
}

function ItemView({ item }: { item: DisplayItem }) {
  if (item.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color="green" bold>❯ </Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <Box marginTop={1}>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === 'tool') {
    const statusIcon = {
      running: '⧖',
      ok: '✓',
      error: '✗',
      denied: '⊘',
    }[item.status];
    const statusColor = {
      running: 'yellow',
      ok: 'green',
      error: 'red',
      denied: 'gray',
    }[item.status] as 'yellow' | 'green' | 'red' | 'gray';
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={statusColor}>{statusIcon} </Text>
          <Text color="cyan">{item.name}</Text>
          <Text dimColor> · {item.preview}</Text>
          {item.outputBytes != null && item.outputBytes > MAX_TOOL_OUTPUT_PREVIEW && (
            <Text dimColor>
              {' '}
              ({item.outputLines} lines, {item.outputBytes} bytes)
            </Text>
          )}
        </Box>
        {item.output && (
          <Box paddingLeft={2}>
            <Text dimColor>{item.output}</Text>
          </Box>
        )}
      </Box>
    );
  }
  if (item.kind === 'error') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="red">Error: {item.text}</Text>
        {item.hint && (
          <Box paddingLeft={2}>
            <Text color="yellow">{item.hint}</Text>
          </Box>
        )}
      </Box>
    );
  }
  // info with optional level
  const color =
    item.level === 'ok'
      ? 'green'
      : item.level === 'warn'
        ? 'yellow'
        : item.level === 'error'
          ? 'red'
          : undefined;
  return (
    <Box>
      <Text color={color} dimColor={!color}>
        {item.text}
      </Text>
    </Box>
  );
}

function PermissionDialog({ req }: { req: PermissionRequest }) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        Permission requested
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">{req.tool.name}</Text>
          <Text dimColor> · {req.preview}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[y] allow once   [a] always allow this tool   [n] deny</Text>
      </Box>
    </Box>
  );
}

function safeParseArgs(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Fold very long tool output: keep head and tail, drop the middle with a marker.
 * This keeps the REPL readable when a command dumps thousands of lines.
 */
function foldLongOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_PREVIEW) return s;
  const lines = s.split('\n');
  if (lines.length <= MAX_TOOL_OUTPUT_LINES_EXPANDED) {
    return s.slice(0, MAX_TOOL_OUTPUT_PREVIEW) + `\n…(${s.length - MAX_TOOL_OUTPUT_PREVIEW} more bytes)`;
  }
  const head = lines.slice(0, 15).join('\n');
  const tail = lines.slice(-10).join('\n');
  return `${head}\n…(${lines.length - 25} lines folded)…\n${tail}`;
}