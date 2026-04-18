/**
 * Message protocol between the Extension Host and the Webview.
 *
 * Design:
 *   - The Extension Host owns the Agent + Session + Permission logic.
 *   - The Webview is a thin view/input layer.
 *   - Every message is JSON-safe (no class instances, no functions, no Buffers).
 *
 * Naming convention:
 *   - `Host*Msg` — messages the Host sends TO the Webview
 *   - `UI*Msg`   — messages the Webview sends TO the Host
 */

// ---------- Host → Webview ----------

export type HostToWebviewMsg =
  // Initial snapshot sent after the view is ready.
  | {
      type: 'ready';
      model: string;
      cwd: string;
      sessionId: string;
      history: SerializedMessage[];
      sessions: SessionSummary[];
      cumulativeCost: number;
      totalTokens: number;
      contextWindow: number;
      bypass: boolean;
    }
  // Streaming assistant text (delta is a single token/chunk).
  | { type: 'assistant_delta'; delta: string; buffer: string }
  // Assistant turn finished (no more text this turn, might be followed by tools).
  | { type: 'assistant_done'; message: SerializedMessage }
  // A tool is about to run.
  | { type: 'tool_start'; callId: string; toolName: string; preview: string }
  // A tool finished (successfully or with an error).
  | { type: 'tool_result'; callId: string; toolName: string; content: string; isError: boolean }
  // A tool was denied by the user.
  | { type: 'tool_denied'; callId: string; toolName: string }
  // Permission request; webview must reply with `permission_response`.
  | {
      type: 'permission_request';
      id: string;
      toolName: string;
      preview: string;
    }
  // Token/cost update (fired after each round-trip).
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cumulativeCost: number;
      model: string;
      contextWindow: number;
    }
  // History was compacted automatically.
  | { type: 'compacted'; droppedMessages: number; summary: string }
  // Informational message (shown as a subtle line in the chat).
  | { type: 'info'; text: string }
  // Whole turn done — UI can re-enable the input.
  | { type: 'turn_done' }
  // Non-fatal error to display.
  | { type: 'error'; message: string; hint?: string }
  // Session was replaced (e.g. /clear, or switched from the picker).
  | {
      type: 'session_switched';
      sessionId: string;
      history: SerializedMessage[];
      model: string;
    }
  // Config / model changed externally (e.g. user ran `fine init` in a terminal).
  | { type: 'model_changed'; model: string };

// ---------- Webview → Host ----------

export type WebviewToHostMsg =
  // Webview finished loading, ready to receive state.
  | { type: 'ready' }
  // User pressed send.
  | { type: 'send'; text: string }
  // User clicked a permission button.
  | { type: 'permission_response'; id: string; decision: 'allow' | 'allow_always' | 'deny' }
  // User hit Cmd/Ctrl+C or the stop button.
  | { type: 'abort' }
  // Slash command: /clear /model /cost /compact /sessions /diff /rewind ...
  | { type: 'slash'; command: string; args: string[] }
  // Request to switch to a specific session id.
  | { type: 'open_session'; sessionId: string }
  // Webview wants an up-to-date sessions list.
  | { type: 'list_sessions' };

// ---------- JSON-safe shapes ----------

/**
 * A message serialized for the webview. Same shape as core Message type but
 * with the promise that it's fully JSON-serializable (toolCalls is always
 * an array, content is string | null).
 */
export interface SerializedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  name?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  lastAt: number;
  model: string;
  messageCount: number;
}
