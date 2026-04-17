/**
 * Anchors — pinned notes that survive context compaction.
 *
 * Storage: in Session meta under `anchors`. Persisted to disk so `fine -c`
 * keeps them around across restarts.
 *
 * Injection: anchors are prepended to the system prompt as a `# Pinned context`
 * block each time the agent builds a turn. They are NOT stored in history, so:
 *   - compaction cannot drop them
 *   - they cost prompt tokens every turn (user's choice — short anchors only)
 *
 * Commands:
 *   /anchor <text>           — add an anchor (id auto-generated)
 *   /anchors                 — list with ids
 *   /unanchor <id>           — remove one
 *   /unanchor all            — clear all
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readConfig } from '../config/Config.js';

export interface Anchor {
  id: string;
  text: string;
  addedAt: number;
}

const ANCHORS_FILE = path.join(os.homedir(), '.fineCode', 'anchors.json');

/**
 * Anchors are stored globally (not per-session) for now: they typically
 * represent "long-term" context like "always use pnpm, not npm". If we later
 * want per-session anchors we can move them to Session meta.
 *
 * Shape on disk: { "<id>": { id, text, addedAt } }
 */
function loadAnchors(): Record<string, Anchor> {
  try {
    if (!fs.existsSync(ANCHORS_FILE)) return {};
    const raw = fs.readFileSync(ANCHORS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, Anchor>;
  } catch {
    /* ignore, fall through */
  }
  return {};
}

function saveAnchors(map: Record<string, Anchor>): void {
  const dir = path.dirname(ANCHORS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = ANCHORS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ANCHORS_FILE);
}

export function listAnchors(): Anchor[] {
  return Object.values(loadAnchors()).sort((a, b) => a.addedAt - b.addedAt);
}

export function addAnchor(text: string): Anchor {
  const map = loadAnchors();
  const id = crypto.randomBytes(3).toString('hex');
  const anchor: Anchor = { id, text: text.trim(), addedAt: Date.now() };
  map[id] = anchor;
  saveAnchors(map);
  return anchor;
}

export function removeAnchor(id: string): boolean {
  if (id === 'all') {
    saveAnchors({});
    return true;
  }
  const map = loadAnchors();
  if (!(id in map)) return false;
  delete map[id];
  saveAnchors(map);
  return true;
}

/**
 * Build the "# Pinned context" block for injection into the system prompt.
 * Returns null if there are no anchors (to avoid an empty section).
 *
 * Also pulls anchors from `config.json` (stored under `anchors`) so users can
 * version-control anchors per-project by editing that file directly.
 */
export function anchorsSystemBlock(): string | null {
  const fromDisk = loadAnchors();
  const fromConfigRaw = readConfig().anchors ?? {};
  // Config-file anchors may be stored without an explicit id field (users hand-write them);
  // inject the map-key as id so the render is consistent.
  const fromConfig: Record<string, Anchor> = {};
  for (const [key, v] of Object.entries(fromConfigRaw)) {
    fromConfig[key] = { id: key, text: v.text, addedAt: v.addedAt };
  }
  const all = { ...fromConfig, ...fromDisk }; // disk wins over config
  const entries = Object.values(all);
  if (entries.length === 0) return null;
  const lines = entries
    .sort((a, b) => a.addedAt - b.addedAt)
    .map(a => `- [${a.id}] ${a.text}`);
  return `# Pinned context (anchors — always visible, never compacted)\n${lines.join('\n')}`;
}
