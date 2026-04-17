/**
 * Minimal unified-diff generator, pure JS, no deps.
 *
 * We use it to show what the AI changed since each file's pre-edit snapshot.
 * Not trying to match `diff -u` byte-for-byte — the intent is human-readable
 * output that makes it obvious what's different.
 *
 * Algorithm: classic Myers-style LCS on lines, printed as unified diff with
 * 3 lines of context. Falls back to a summary for files > MAX_LINES to avoid
 * blocking the UI.
 */

const MAX_LINES = 5000;
const CONTEXT = 3;

/** Compute the Longest Common Subsequence of two arrays of strings. */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[0..i-1], b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

interface Op {
  kind: 'eq' | 'del' | 'add';
  line: string;
  /** 0-based line index in original (for del/eq) or new (for add). */
  oldIdx?: number;
  newIdx?: number;
}

function backtrack(a: string[], b: string[], dp: number[][]): Op[] {
  const ops: Op[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'eq', line: a[i - 1]!, oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: 'del', line: a[i - 1]!, oldIdx: i - 1 });
      i--;
    } else {
      ops.push({ kind: 'add', line: b[j - 1]!, newIdx: j - 1 });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', line: a[i - 1]!, oldIdx: i - 1 });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: 'add', line: b[j - 1]!, newIdx: j - 1 });
    j--;
  }
  return ops.reverse();
}

export interface DiffResult {
  /** Formatted unified-diff text. Empty string if files are identical. */
  diff: string;
  added: number;
  removed: number;
  identical: boolean;
  skippedReason?: string;
}

/** Produce a unified diff between two strings. */
export function unifiedDiff(
  oldStr: string,
  newStr: string,
  opts: { fromLabel?: string; toLabel?: string } = {},
): DiffResult {
  if (oldStr === newStr) return { diff: '', added: 0, removed: 0, identical: true };

  const a = oldStr.split('\n');
  const b = newStr.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      diff: `(file too large for inline diff — ${a.length} → ${b.length} lines; use an external diff tool)`,
      added: 0,
      removed: 0,
      identical: false,
      skippedReason: 'too-large',
    };
  }

  const dp = lcs(a, b);
  const ops = backtrack(a, b, dp);

  // Group ops into hunks with CONTEXT lines of surrounding eq.
  const lines: string[] = [];
  const from = opts.fromLabel ?? 'a';
  const to = opts.toLabel ?? 'b';
  lines.push(`--- ${from}`);
  lines.push(`+++ ${to}`);

  let i = 0;
  let added = 0;
  let removed = 0;

  while (i < ops.length) {
    // Skip leading equal runs.
    if (ops[i]!.kind === 'eq') {
      i++;
      continue;
    }
    // Found a change; back up for context.
    const hunkStart = Math.max(0, i - CONTEXT);
    // Find end of this hunk: extend until we've seen CONTEXT eq lines in a row with no further change.
    let j = i;
    let eqRun = 0;
    while (j < ops.length) {
      if (ops[j]!.kind === 'eq') {
        eqRun++;
        if (eqRun > CONTEXT * 2) break;
      } else {
        eqRun = 0;
      }
      j++;
    }
    const hunkEnd = Math.min(ops.length, j);

    // Compute @@ header line numbers (1-based).
    const firstOp = ops[hunkStart]!;
    const oldStart =
      (firstOp.oldIdx ?? firstOp.newIdx ?? 0) + 1; // rough; OK for human-readable output
    const newStart = (firstOp.newIdx ?? firstOp.oldIdx ?? 0) + 1;
    let oldLen = 0;
    let newLen = 0;
    for (let k = hunkStart; k < hunkEnd; k++) {
      if (ops[k]!.kind !== 'add') oldLen++;
      if (ops[k]!.kind !== 'del') newLen++;
    }
    lines.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);

    for (let k = hunkStart; k < hunkEnd; k++) {
      const op = ops[k]!;
      if (op.kind === 'eq') lines.push(` ${op.line}`);
      else if (op.kind === 'del') {
        lines.push(`-${op.line}`);
        removed++;
      } else {
        lines.push(`+${op.line}`);
        added++;
      }
    }

    i = hunkEnd;
  }

  return { diff: lines.join('\n'), added, removed, identical: false };
}
