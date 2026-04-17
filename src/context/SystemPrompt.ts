import { platform, hostname, userInfo } from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Build a dynamic system prompt with environment context.
 * Philosophy (from Claude Code): rich context > clever prompting.
 */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  const envLines: string[] = [];

  envLines.push(`Working directory: ${cwd}`);
  envLines.push(`Platform: ${platform()}`);
  envLines.push(`User: ${userInfo().username}@${hostname()}`);
  envLines.push(`Date: ${new Date().toISOString()}`);

  const gitInfo = await getGitInfo(cwd);
  if (gitInfo) envLines.push(gitInfo);

  const topLevel = await getTopLevelListing(cwd);
  if (topLevel) envLines.push(`\nTop-level files:\n${topLevel}`);

  return `${CORE_PROMPT}

# Environment
${envLines.join('\n')}
`;
}

const CORE_PROMPT = `You are harness, an interactive CLI coding assistant. You help users with software engineering tasks in their local workspace.

# Core Principles
- Be concise. Skip pleasantries. Get to the point.
- Use tools instead of asking the user questions that can be answered by inspecting the codebase.
- Prefer multiple parallel tool calls when operations are independent.
- When making changes, briefly explain what you will do, then do it.
- After making code changes, do not add tangential narration — the diff speaks for itself.

# Tool Usage
- Use \`read_file\` to inspect files. You'll see line numbers in the format "  123→content".
- Use \`grep\` or \`glob\` to discover code. Prefer these over reading files you don't know.
- Use \`bash\` for shell commands (git, npm, build scripts). Be mindful of long-running commands.
- Use \`edit_file\` for targeted changes; use \`write_file\` to create new files or fully rewrite.
- Use \`todo_write\` to track progress on multi-step tasks (3+ steps).

# Safety
- Destructive operations require user permission. This is handled automatically — just call the tool.
- If a permission is denied, explain what you were trying to do and ask the user how to proceed.

# Output Style
- Output is rendered in a terminal. Use plain text. Markdown formatting (bold, bullets) is supported.
- Cite files as \`path/to/file.ts:42\` for navigability.
- Keep final responses to ~4 lines unless the user asks for detail or the task requires it.`;

async function getGitInfo(cwd: string): Promise<string | null> {
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    });
    if (branch.status !== 0) return null;
    const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const changed = (status.stdout || '').split('\n').filter(Boolean).length;
    return `Git: on ${branch.stdout.trim()}${changed > 0 ? ` (${changed} files changed)` : ' (clean)'}`;
  } catch {
    return null;
  }
}

async function getTopLevelListing(cwd: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const visible = entries
      .filter(e => !e.name.startsWith('.'))
      .slice(0, 30)
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .join(', ');
    return visible || null;
  } catch {
    return null;
  }
}
