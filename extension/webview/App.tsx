/**
 * fineCode webview App.
 *
 * Single-file React app — keeps the bundle minimal. State lives in a reducer
 * so incoming stream deltas are trivially appendable.
 *
 * Layout:
 *   [header]          model name / cost / sessions button
 *   [messages]        scrollable list of user/assistant/tool/info blocks
 *   [permission]      inline dialog when a tool needs approval
 *   [composer]        textarea + send/stop button
 */

import { useEffect, useReducer, useRef, useCallback, useMemo } from 'react';
import type { HostToWebviewMsg, SerializedMessage, SessionSummary } from '../src/protocol.js';
import { post, subscribe } from './vscode.js';

// ---------- state ----------

interface ToolEntry {
  callId: string;
  toolName: string;
  preview: string;
  status: 'running' | 'done' | 'error' | 'denied';
  content?: string;
}

interface PermissionRequest {
  id: string;
  toolName: string;
  preview: string;
}

interface ChatBlock {
  kind: 'user' | 'assistant' | 'info' | 'error' | 'compact';
  id: string;
  text: string;
  hint?: string; // for error blocks
  tools?: ToolEntry[]; // for assistant blocks
}

interface State {
  model: string;
  cwd: string;
  sessionId: string;
  sessions: SessionSummary[];
  cumulativeCost: number;
  totalTokens: number;
  contextWindow: number;
  bypass: boolean;
  blocks: ChatBlock[];
  /** Streaming assistant block id — null when not streaming. */
  streamingId: string | null;
  /** The current assistant text buffer (updated on every delta). */
  streamingBuffer: string;
  /** Is the agent currently running a turn? */
  running: boolean;
  permission: PermissionRequest | null;
  showSessions: boolean;
  ready: boolean;
}

const initialState: State = {
  model: '...',
  cwd: '',
  sessionId: '',
  sessions: [],
  cumulativeCost: 0,
  totalTokens: 0,
  contextWindow: 8192,
  bypass: false,
  blocks: [],
  streamingId: null,
  streamingBuffer: '',
  running: false,
  permission: null,
  showSessions: false,
  ready: false,
};

type Action =
  | { type: 'host'; msg: HostToWebviewMsg }
  | { type: 'send'; text: string }
  | { type: 'toggleSessions' }
  | { type: 'closeSessions' }
  | { type: 'dismissPermission' };

function messageToBlock(m: SerializedMessage, idx: number): ChatBlock | null {
  if (m.role === 'user' && typeof m.content === 'string') {
    return { kind: 'user', id: `h-${idx}`, text: m.content };
  }
  if (m.role === 'assistant') {
    const text = typeof m.content === 'string' ? m.content : '';
    const tools = (m.toolCalls ?? []).map<ToolEntry>(tc => ({
      callId: tc.id,
      toolName: tc.name,
      preview: '',
      status: 'done',
    }));
    return { kind: 'assistant', id: `h-${idx}`, text, tools };
  }
  if (m.role === 'tool') {
    // tool results are folded into the preceding assistant block on replay,
    // but we surface them as info-style lines for transparency.
    return null;
  }
  return null;
}

function reducer(state: State, action: Action): State {
  if (action.type === 'toggleSessions') {
    return { ...state, showSessions: !state.showSessions };
  }
  if (action.type === 'closeSessions') {
    return { ...state, showSessions: false };
  }
  if (action.type === 'dismissPermission') {
    return { ...state, permission: null };
  }
  if (action.type === 'send') {
    const id = `u-${Date.now()}`;
    return {
      ...state,
      blocks: [...state.blocks, { kind: 'user', id, text: action.text }],
      running: true,
      streamingId: null,
      streamingBuffer: '',
    };
  }
  const msg = action.msg;
  switch (msg.type) {
    case 'ready': {
      const blocks: ChatBlock[] = [];
      msg.history.forEach((m: SerializedMessage, i: number) => {
        const b = messageToBlock(m, i);
        if (b) blocks.push(b);
      });
      return {
        ...state,
        ready: true,
        model: msg.model,
        cwd: msg.cwd,
        sessionId: msg.sessionId,
        sessions: msg.sessions,
        cumulativeCost: msg.cumulativeCost,
        totalTokens: msg.totalTokens,
        contextWindow: msg.contextWindow,
        bypass: msg.bypass,
        blocks,
        streamingId: null,
        streamingBuffer: '',
        running: false,
      };
    }
    case 'assistant_delta': {
      // Start a new assistant block the first time we see a delta in this turn.
      if (!state.streamingId) {
        const id = `a-${Date.now()}`;
        return {
          ...state,
          streamingId: id,
          streamingBuffer: msg.buffer,
          blocks: [...state.blocks, { kind: 'assistant', id, text: msg.buffer, tools: [] }],
        };
      }
      // Append to existing streaming block.
      return {
        ...state,
        streamingBuffer: msg.buffer,
        blocks: state.blocks.map(b =>
          b.id === state.streamingId ? { ...b, text: msg.buffer } : b,
        ),
      };
    }
    case 'assistant_done': {
      // If there's no streaming block yet (model went tool-first), create one.
      const text = typeof msg.message.content === 'string' ? msg.message.content : '';
      if (state.streamingId) {
        return {
          ...state,
          blocks: state.blocks.map(b =>
            b.id === state.streamingId ? { ...b, text } : b,
          ),
          streamingId: null,
          streamingBuffer: '',
        };
      }
      if (text || (msg.message.toolCalls && msg.message.toolCalls.length > 0)) {
        const id = `a-${Date.now()}`;
        return {
          ...state,
          blocks: [...state.blocks, { kind: 'assistant', id, text, tools: [] }],
          streamingId: null,
          streamingBuffer: '',
        };
      }
      return state;
    }
    case 'tool_start': {
      // Attach to the last assistant block (that's the natural reading order).
      const blocks = [...state.blocks];
      const lastAsst = findLastIndex(blocks, b => b.kind === 'assistant');
      const entry: ToolEntry = {
        callId: msg.callId,
        toolName: msg.toolName,
        preview: msg.preview,
        status: 'running',
      };
      if (lastAsst >= 0) {
        const b = blocks[lastAsst]!;
        blocks[lastAsst] = { ...b, tools: [...(b.tools ?? []), entry] };
      } else {
        const id = `a-${Date.now()}`;
        blocks.push({ kind: 'assistant', id, text: '', tools: [entry] });
      }
      return { ...state, blocks };
    }
    case 'tool_result': {
      return {
        ...state,
        blocks: state.blocks.map(b => {
          if (!b.tools) return b;
          return {
            ...b,
            tools: b.tools.map(t =>
              t.callId === msg.callId
                ? { ...t, status: msg.isError ? 'error' : 'done', content: msg.content }
                : t,
            ),
          };
        }),
      };
    }
    case 'tool_denied': {
      return {
        ...state,
        blocks: state.blocks.map(b => {
          if (!b.tools) return b;
          return {
            ...b,
            tools: b.tools.map(t =>
              t.callId === msg.callId ? { ...t, status: 'denied' } : t,
            ),
          };
        }),
      };
    }
    case 'permission_request': {
      return {
        ...state,
        permission: { id: msg.id, toolName: msg.toolName, preview: msg.preview },
      };
    }
    case 'usage': {
      return {
        ...state,
        model: msg.model,
        totalTokens: msg.totalTokens,
        cumulativeCost: msg.cumulativeCost,
        contextWindow: msg.contextWindow,
      };
    }
    case 'compacted': {
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: 'compact',
            id: `c-${Date.now()}`,
            text: `Context compacted (${msg.droppedMessages} messages → summary).`,
          },
        ],
      };
    }
    case 'info': {
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'info', id: `i-${Date.now()}`, text: msg.text }],
      };
    }
    case 'turn_done': {
      return { ...state, running: false, streamingId: null, streamingBuffer: '' };
    }
    case 'error': {
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: 'error', id: `e-${Date.now()}`, text: msg.message, hint: msg.hint },
        ],
        running: false,
      };
    }
    case 'session_switched': {
      const blocks: ChatBlock[] = [];
      msg.history.forEach((m: SerializedMessage, i: number) => {
        const b = messageToBlock(m, i);
        if (b) blocks.push(b);
      });
      return {
        ...state,
        sessionId: msg.sessionId,
        model: msg.model,
        blocks,
        running: false,
        streamingId: null,
        streamingBuffer: '',
        showSessions: false,
      };
    }
    case 'model_changed': {
      return { ...state, model: msg.model };
    }
  }
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

// ---------- UI ----------

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = subscribe(msg => dispatch({ type: 'host', msg }));
    post({ type: 'ready' });
    return () => {
      unsubscribe();
    };
  }, []);

  // Auto-scroll to bottom when new content arrives. We only do this when the
  // user is already near the bottom — otherwise scrolling while they're
  // reading older content would be infuriating.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [state.blocks, state.streamingBuffer]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('/')) {
        const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
        post({ type: 'slash', command: cmd!, args });
        // Echo the slash as a user block so it's clear what happened. Slash
        // commands don't trigger a real turn on the host, so we don't set
        // `running` — the host will reply with an info/compacted message
        // straight away.
        dispatch({ type: 'send', text: trimmed });
        return;
      }
      dispatch({ type: 'send', text: trimmed });
      post({ type: 'send', text: trimmed });
    },
    [],
  );

  const abort = useCallback(() => post({ type: 'abort' }), []);

  const respondPermission = useCallback(
    (id: string, decision: 'allow' | 'allow_always' | 'deny') => {
      post({ type: 'permission_response', id, decision });
      dispatch({ type: 'dismissPermission' });
    },
    [],
  );

  const openSession = useCallback((id: string) => {
    post({ type: 'open_session', sessionId: id });
  }, []);

  // Header summary string
  const headerText = useMemo(() => {
    const pct =
      state.contextWindow > 0
        ? Math.min(100, Math.round((state.totalTokens / state.contextWindow) * 100))
        : 0;
    const k = state.totalTokens >= 1000 ? `${(state.totalTokens / 1000).toFixed(1)}k` : `${state.totalTokens}`;
    const cost =
      state.cumulativeCost === 0
        ? '$0'
        : state.cumulativeCost < 0.01
          ? `$${state.cumulativeCost.toFixed(4)}`
          : `$${state.cumulativeCost.toFixed(3)}`;
    return `${k} tok (${pct}%) · ${cost}`;
  }, [state.totalTokens, state.contextWindow, state.cumulativeCost]);

  // Clear permission dialog locally once responded to.
  // The dismissPermission action handles that; no additional effect needed.

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <span className="model">{state.model}</span>
          {state.bypass && <span style={{ marginLeft: 8, color: 'var(--vscode-charts-yellow)' }}>⚠ bypass</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="cost">{headerText}</span>
          <button onClick={() => dispatch({ type: 'toggleSessions' })} title="Sessions">
            ☰
          </button>
          <button
            onClick={() => {
              post({ type: 'slash', command: 'clear', args: [] });
            }}
            title="New session"
          >
            +
          </button>
        </div>
      </header>

      {state.showSessions && (
        <SessionsDrawer
          sessions={state.sessions}
          currentId={state.sessionId}
          onPick={openSession}
          onClose={() => dispatch({ type: 'closeSessions' })}
        />
      )}

      <div ref={messagesRef} className="app__messages">
        {!state.ready && <div className="message message--info">Initializing...</div>}
        {state.blocks.map(b => (
          <MessageBlock key={b.id} block={b} />
        ))}
        {state.permission && (
          <PermissionDialog
            request={state.permission}
            onRespond={respondPermission}
          />
        )}
      </div>

      <Composer running={state.running} onSend={send} onAbort={abort} />
    </div>
  );
}

function MessageBlock({ block }: { block: ChatBlock }): JSX.Element {
  if (block.kind === 'info') {
    return <div className="message message--info">{block.text}</div>;
  }
  if (block.kind === 'compact') {
    return <div className="message message--info">— {block.text} —</div>;
  }
  if (block.kind === 'error') {
    return (
      <div className="message message--error">
        <div className="message__role">error</div>
        <div className="message__body">
          {block.text}
          {block.hint && <div style={{ marginTop: 6, opacity: 0.8 }}>{block.hint}</div>}
        </div>
      </div>
    );
  }
  if (block.kind === 'user') {
    return (
      <div className="message message--user">
        <div className="message__role">you</div>
        <div className="message__body">{block.text}</div>
      </div>
    );
  }
  // assistant
  return (
    <div className="message message--assistant">
      <div className="message__role">assistant</div>
      {block.text && <div className="message__body">{block.text}</div>}
      {block.tools?.map(t => (
        <ToolCallView key={t.callId} tool={t} />
      ))}
    </div>
  );
}

function ToolCallView({ tool }: { tool: ToolEntry }): JSX.Element {
  const cls = `tool-call tool-call--${tool.status}`;
  return (
    <div>
      <div className={cls}>
        <span className="tool-call__name">{tool.toolName}</span>
        {tool.preview && <span>· {tool.preview}</span>}
      </div>
      {tool.content && tool.status !== 'running' && (
        <details style={{ marginLeft: 18, marginTop: 4 }}>
          <summary style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', cursor: 'pointer' }}>
            output ({tool.content.length} chars)
          </summary>
          <pre
            style={{
              marginTop: 4,
              padding: 8,
              background: 'var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1))',
              maxHeight: 280,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
            }}
          >
            {tool.content}
          </pre>
        </details>
      )}
    </div>
  );
}

function PermissionDialog({
  request,
  onRespond,
}: {
  request: PermissionRequest;
  onRespond: (id: string, decision: 'allow' | 'allow_always' | 'deny') => void;
}): JSX.Element {
  return (
    <div className="permission-dialog">
      <div className="permission-dialog__title">Permission requested</div>
      <div className="permission-dialog__preview">
        <strong>{request.toolName}</strong> · {request.preview}
      </div>
      <div className="permission-dialog__actions">
        <button className="allow" onClick={() => onRespond(request.id, 'allow')}>
          Allow once
        </button>
        <button className="always" onClick={() => onRespond(request.id, 'allow_always')}>
          Always allow
        </button>
        <button className="deny" onClick={() => onRespond(request.id, 'deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

function Composer({
  running,
  onSend,
  onAbort,
}: {
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter always sends. Enter alone sends if no modifier is held
    // and shift isn't pressed (shift+enter for newlines).
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!running) sendCurrent();
    }
  };

  const sendCurrent = () => {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    ta.value = '';
    ta.style.height = ''; // reset autoexpand
    onSend(text);
  };

  return (
    <div className="app__composer">
      <textarea
        ref={taRef}
        placeholder={
          running
            ? 'Running... (Esc to stop)'
            : 'Ask fineCode anything, or use / for commands'
        }
        onKeyDown={handleKey}
        onInput={e => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = Math.min(200, el.scrollHeight) + 'px';
        }}
        disabled={running}
      />
      <div className="app__composer__row">
        <span className="app__composer__hint">
          Enter to send · Shift+Enter newline · / for commands
        </span>
        {running ? (
          <button className="stop" onClick={onAbort}>
            Stop
          </button>
        ) : (
          <button onClick={sendCurrent}>Send</button>
        )}
      </div>
    </div>
  );
}

function SessionsDrawer({
  sessions,
  currentId,
  onPick,
  onClose,
}: {
  sessions: SessionSummary[];
  currentId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sessions-drawer">
      {sessions.length === 0 && <div className="sessions-drawer__meta">No sessions yet.</div>}
      {sessions.map(s => (
        <div
          key={s.id}
          className={
            'sessions-drawer__item' + (s.id === currentId ? ' sessions-drawer__item--active' : '')
          }
          onClick={() => onPick(s.id)}
        >
          <div className="sessions-drawer__title">{s.title}</div>
          <div className="sessions-drawer__meta">
            {new Date(s.lastAt).toLocaleString()} · {s.model} · {s.messageCount} msgs
          </div>
        </div>
      ))}
    </div>
  );
}
