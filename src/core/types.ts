/**
 * Core unified types — internally use OpenAI-compatible format as the "canonical" format.
 * Providers adapt to/from this canonical format.
 *
 * Why OpenAI format as canonical?
 *   - Broadest ecosystem support (OpenAI, Azure, DeepSeek, OpenRouter, Ollama, vLLM, etc.)
 *   - tool_calls on message level is simpler than Anthropic's content-block model
 *   - Easy to convert to Anthropic format when needed
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded string, per OpenAI spec
}

export interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[]; // Only on assistant messages
  toolCallId?: string; // Only on tool (result) messages
  name?: string; // Tool name on tool messages
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema for the input parameters */
  parameters: Record<string, unknown>;
  /**
   * Whether this tool requires user approval before execution.
   * 'always' — always ask; 'never' — auto-approve (read-only); 'once' — ask then remember.
   *
   * Note: `'never'` is ALSO the signal for the concurrency partitioner that this tool
   * is safe to run in parallel with other 'never' tools. Any 'always'/'once' tool is
   * treated as having side-effects and is executed serially relative to others.
   */
  needsPermission: 'always' | 'never' | 'once';
  /**
   * Render a short description of what the tool is about to do.
   * Shown in the permission dialog.
   */
  renderCall(input: Input): string;
  /** Execute the tool */
  execute(
    input: Input,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  cwd: string;
  abortSignal: AbortSignal;
  /** Current session (if any). Tools may record snapshots here for rewind. */
  session?: import('../session/Session.js').Session;
  /** Tool-call id assigned by the model; useful for snapshot correlation. */
  toolCallId?: string;
  /**
   * Opt-in event forwarder. Tools that spawn their own agents (like SpawnAgentTool)
   * push subagent events here so the host's UI stream sees them in real time.
   * Agent installs this when it calls the tool; it's `undefined` outside that flow.
   */
  forwardEvent?: (ev: unknown) => void;
  /**
   * Parent agent's permission prompt, propagated down into tools that create
   * nested agents (SpawnAgentTool). Lets a subagent bubble tool-permission
   * requests up to the real UI instead of auto-denying — otherwise a subagent
   * that tries to call `bash`/`edit_file` dies immediately.
   */
  parentPermissionPrompt?: import('../permission/PermissionManager.js').PermissionPrompt;
}

export interface ToolResult {
  /** Stringified result sent back to the model */
  content: string;
  /** Whether this execution errored */
  isError?: boolean;
}

/** A streaming event from a Provider. */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; finishReason: FinishReason; usage?: Usage }
  | { type: 'error'; error: Error };

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface QueryOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt: string;
  abortSignal: AbortSignal;
  /** Hints; providers may ignore unsupported ones */
  temperature?: number;
  maxTokens?: number;
}
