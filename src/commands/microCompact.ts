/**
 * Micro-compact: shrink a tool result BEFORE it enters the conversation history.
 *
 * Rationale:
 *   Tool results are the biggest context hogs in coding agents (grep over a big
 *   repo, cat a huge file, long build logs). Letting them accumulate untouched
 *   causes auto-compact to fire far sooner than it should.
 *
 * Strategy (deliberately NOT LLM-based):
 *   - For structured outputs (read_file, grep, ls) we can safely head+tail
 *     truncate while preserving the structural header/path info.
 *   - For bash and everything else we also head+tail.
 *   - We NEVER call the API to summarize — that would add latency + cost to
 *     every tool call. If the user wants real summarization they can still
 *     invoke /compact manually once the history grows.
 *
 * Threshold:
 *   We only shrink outputs above MICRO_COMPACT_THRESHOLD. Smaller results pass
 *   through unchanged so single-file reads and short grep matches are exact.
 */

export const MICRO_COMPACT_THRESHOLD = 8 * 1024; // 8 KB
const HEAD_LINES = 40;
const TAIL_LINES = 20;
const HEAD_CHARS = 2000;
const TAIL_CHARS = 800;

export interface MicroCompactResult {
  content: string;
  /** Whether the content was actually shrunk. */
  compacted: boolean;
  /** Original byte length, useful for telemetry / UI hints. */
  originalBytes: number;
}

/**
 * Shrink `content` if it's bigger than the threshold. Returns the original
 * content verbatim otherwise. Includes a one-line marker so the model knows
 * the middle was elided (and can request the full thing via another tool
 * call if needed).
 */
export function microCompact(content: string, toolName?: string): MicroCompactResult {
  const originalBytes = content.length;
  if (originalBytes <= MICRO_COMPACT_THRESHOLD) {
    return { content, compacted: false, originalBytes };
  }

  const lines = content.split('\n');
  if (lines.length > HEAD_LINES + TAIL_LINES + 10) {
    // Line-based truncation — much more useful for read_file / grep / bash.
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(-TAIL_LINES).join('\n');
    const elided = lines.length - HEAD_LINES - TAIL_LINES;
    const marker =
      `\n…[micro-compacted by fineCode: ${elided} lines / ${originalBytes - head.length - tail.length} bytes elided` +
      (toolName ? ` from ${toolName}` : '') +
      `. Call the tool again with offset/limit to see the elided section.]…\n`;
    return { content: `${head}${marker}${tail}`, compacted: true, originalBytes };
  }

  // Character-based truncation for long single-line blobs (minified JS, JSON).
  const head = content.slice(0, HEAD_CHARS);
  const tail = content.slice(-TAIL_CHARS);
  const marker =
    `\n…[micro-compacted: ${originalBytes - head.length - tail.length} bytes elided` +
    (toolName ? ` from ${toolName}` : '') +
    `]…\n`;
  return { content: `${head}${marker}${tail}`, compacted: true, originalBytes };
}
