import type { ToolDefinition } from '../core/types.js';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export type PermissionPrompt = (
  tool: ToolDefinition,
  input: unknown,
  preview: string,
) => Promise<PermissionDecision>;

/**
 * PermissionManager — three-state model inspired by Claude Code.
 *
 *   allow        — this one time only
 *   allow_always — this tool for the rest of the session
 *   deny         — cancel; model gets an error back
 *
 * "bypass" mode (yolo) is the override: everything auto-approved.
 */
export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private bypass: boolean;

  constructor(opts: { bypass?: boolean } = {}) {
    this.bypass = opts.bypass ?? false;
  }

  async request(
    tool: ToolDefinition,
    input: unknown,
    prompt: PermissionPrompt,
  ): Promise<PermissionDecision> {
    if (this.bypass) return 'allow';
    if (tool.needsPermission === 'never') return 'allow';
    if (this.alwaysAllowed.has(tool.name)) return 'allow';

    const preview = safeRender(tool, input);
    const decision = await prompt(tool, input, preview);

    if (decision === 'allow_always') {
      this.alwaysAllowed.add(tool.name);
    }
    return decision;
  }

  isBypass(): boolean {
    return this.bypass;
  }
}

function safeRender(tool: ToolDefinition, input: unknown): string {
  try {
    return tool.renderCall(input as any);
  } catch {
    return `${tool.name}(...)`;
  }
}
