import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Agent, AgentEvent } from '../core/Agent.js';
import type { ToolDefinition } from '../core/types.js';
import { ProviderError } from '../core/ProviderError.js';

type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; preview: string; status: 'running' | 'ok' | 'error' | 'denied'; output?: string }
  | { kind: 'error'; text: string; hint?: string }
  | { kind: 'info'; text: string };

interface PermissionRequest {
  tool: ToolDefinition;
  preview: string;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
}

interface Props {
  agent: Agent;
  modelName: string;
  onPermissionRequest: (register: (req: PermissionRequest) => void) => void;
}

export function REPL({ agent, modelName, onPermissionRequest }: Props) {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([
    { kind: 'info', text: `harness · model: ${modelName} · type your question, Ctrl+C to exit` },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Register permission handler
  useEffect(() => {
    onPermissionRequest(req => setPermission(req));
  }, [onPermissionRequest]);

  // Permission dialog key handler
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

  // Ctrl+C handling during busy
  useInput(
    (_ch, key) => {
      if (key.ctrl && _ch === 'c') {
        if (busy && abortRef.current) {
          abortRef.current.abort();
        } else {
          exit();
        }
      }
    },
    { isActive: !permission },
  );

  const submit = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput('');
    setItems(prev => [...prev, { kind: 'user', text }]);
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;

    let currentAssistantText = '';
    let currentAssistantIdx = -1;

    try {
      for await (const event of agent.run(text, ac.signal)) {
        await new Promise(r => setImmediate(r)); // yield to render

        if (event.type === 'assistant_text') {
          currentAssistantText = event.buffer;
          setItems(prev => {
            const next = [...prev];
            if (currentAssistantIdx === -1) {
              currentAssistantIdx = next.length;
              next.push({ kind: 'assistant', text: currentAssistantText });
            } else {
              next[currentAssistantIdx] = { kind: 'assistant', text: currentAssistantText };
            }
            return next;
          });
        } else if (event.type === 'assistant_done') {
          currentAssistantIdx = -1; // reset for next turn
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
            // Update last running tool with this name
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i]!;
              if (it.kind === 'tool' && it.status === 'running' && it.name === event.tool.name) {
                next[i] = {
                  ...it,
                  status: event.isError ? 'error' : 'ok',
                  output: truncate(event.content, 400),
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

      {permission && <PermissionDialog req={permission} />}

      {!busy && !permission && (
        <Box marginTop={1}>
          <Text color="green">❯ </Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function ItemView({ item }: { item: DisplayItem }) {
  if (item.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color="green" bold>
          ❯{' '}
        </Text>
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
  return (
    <Box>
      <Text dimColor>{item.text}</Text>
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(${s.length - max} more bytes)`;
}
