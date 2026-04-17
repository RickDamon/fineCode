/**
 * Non-blocking npm version check.
 *
 * Design:
 *   - Runs at most once per 24h (state stored in config file: lastUpdateCheck).
 *   - Uses native fetch (Node 18+) with a 1.5s timeout, silently no-ops on failure.
 *   - Never blocks startup; caller fires-and-forgets.
 *   - Outputs a single hint line to stderr if a newer version is available.
 */

import { readConfig, writeConfig } from '../config/Config.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 1500;

/**
 * Compare semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Handles "1.2.3", ignores pre-release tags for simplicity.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestVersion(pkgName: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null; // Node < 18
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kick off a background update check. Safe to call unconditionally.
 * `currentVersion` is typically `pkg.version` read at startup.
 * `pkgName` defaults to "fine-code" (the published name).
 */
export function scheduleUpdateCheck(currentVersion: string, pkgName = 'fine-code'): void {
  // Honor the common "don't call home" convention.
  if (process.env.NO_UPDATE_NOTIFIER || process.env.CI) return;

  const stored = readConfig();
  const now = Date.now();
  if (stored.lastUpdateCheck && now - stored.lastUpdateCheck < CHECK_INTERVAL_MS) return;

  // Fire-and-forget.
  void (async () => {
    const latest = await fetchLatestVersion(pkgName);
    // Best-effort persist the timestamp even on failure so we don't hammer the registry.
    try {
      writeConfig({ lastUpdateCheck: now });
    } catch {
      /* ignore */
    }
    if (!latest) return;
    if (compareSemver(latest, currentVersion) > 0) {
      // One-line hint, stderr so it doesn't pollute programmatic stdout.
      const msg = [
        '',
        `  fineCode update available: ${currentVersion} → ${latest}`,
        `  Run: npm i -g ${pkgName}`,
        '',
      ].join('\n');
      process.stderr.write(msg + '\n');
    }
  })();
}
