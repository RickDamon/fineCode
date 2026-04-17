/**
 * Session — conversation persistence + usage tracking.
 *
 * Storage layout:
 *   ~/.fineCode/sessions/
 *     <session-id>.jsonl   append-only log (one JSON record per line)
 *     <session-id>.meta.json   metadata (cwd, model, createdAt, lastAt, totals)
 *
 * Why JSONL?
 *   - Append-only → crash-safe; the process can die mid-turn and nothing is corrupted.
 *   - Easy to stream-parse for large histories.
 *   - Every record is self-contained; we can skip malformed lines on resume.
 *
 * Record types:
 *   { t: 'msg', m: Message }
 *   { t: 'usage', u: Usage, model: string }
 *   { t: 'snapshot', path: string, hash: string, bytes: number }   (used by B5 /rewind)
 *   { t: 'compact', droppedMessages: number, summary: string }     (used by B1 auto-compact)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Message, Usage } from '../core/types.js';

export const SESSIONS_DIR = path.join(os.homedir(), '.fineCode', 'sessions');

export interface SessionMeta {
  id: string;
  createdAt: number;
  lastAt: number;
  cwd: string;
  model: string;
  /** First user message, used as a human-friendly label. */
  title?: string;
  /** Running totals (prompt / completion / total tokens, approx cost in USD). */
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  /** How many messages are currently in the log after any compactions. */
  messageCount: number;
  /** Active workflow mode: none / ddd / tdd / sdd. */
  mode?: 'none' | 'ddd' | 'tdd' | 'sdd';
}

export interface SnapshotRecord {
  toolCallId: string;
  /** Absolute path of the file that was edited. */
  path: string;
  /** SHA-256 of the ORIGINAL (pre-edit) content, used as the snapshot filename. */
  hash: string;
  bytes: number;
  ts: number;
}

type LogRecord =
  | { t: 'msg'; m: Message }
  | { t: 'usage'; u: Usage; model: string; cost: number }
  | { t: 'snapshot'; snap: SnapshotRecord }
  | { t: 'compact'; droppedMessages: number; summary: string };

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function newId(): string {
  // YYYYMMDD-HHMMSS-<rand4>
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export class Session {
  readonly id: string;
  readonly logPath: string;
  readonly metaPath: string;
  readonly snapshotDir: string;
  private meta: SessionMeta;
  private logStream: fs.WriteStream | null = null;
  private snapshots: SnapshotRecord[] = [];

  private constructor(id: string, meta: SessionMeta) {
    this.id = id;
    this.logPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
    this.metaPath = path.join(SESSIONS_DIR, `${id}.meta.json`);
    this.snapshotDir = path.join(SESSIONS_DIR, `${id}.snapshots`);
    this.meta = meta;
  }

  /** Create a fresh session. */
  static create(opts: { cwd: string; model: string }): Session {
    ensureDir(SESSIONS_DIR);
    const id = newId();
    const meta: SessionMeta = {
      id,
      createdAt: Date.now(),
      lastAt: Date.now(),
      cwd: opts.cwd,
      model: opts.model,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCost: 0,
      messageCount: 0,
    };
    const s = new Session(id, meta);
    s.flushMeta();
    return s;
  }

  /** Load an existing session by id. Returns null if not found. */
  static load(id: string): { session: Session; messages: Message[] } | null {
    const metaPath = path.join(SESSIONS_DIR, `${id}.meta.json`);
    const logPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(logPath)) return null;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
    const session = new Session(id, meta);
    const messages = session.replay();
    return { session, messages };
  }

  /** List recent sessions, newest first. */
  static list(limit = 20): SessionMeta[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.meta.json'));
    const metas: SessionMeta[] = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (j && typeof j === 'object' && j.id) metas.push(j as SessionMeta);
      } catch {
        /* ignore malformed meta */
      }
    }
    metas.sort((a, b) => b.lastAt - a.lastAt);
    return metas.slice(0, limit);
  }

  /** Find the most recent session for the given cwd. */
  static mostRecent(cwd?: string): SessionMeta | null {
    const all = Session.list(50);
    if (cwd) {
      return all.find(m => m.cwd === cwd) ?? all[0] ?? null;
    }
    return all[0] ?? null;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getSnapshots(): SnapshotRecord[] {
    return [...this.snapshots];
  }

  /** Re-read the log into a Message[] (used on resume). Side effect: populates snapshots. */
  private replay(): Message[] {
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const messages: Message[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        continue;
      }
      if (rec.t === 'msg') messages.push(rec.m);
      else if (rec.t === 'snapshot') this.snapshots.push(rec.snap);
      else if (rec.t === 'compact') {
        // Drop the oldest N messages and inject the summary at the front.
        const kept = messages.slice(rec.droppedMessages);
        messages.length = 0;
        messages.push({ role: 'user', content: `[Previous conversation summary] ${rec.summary}` });
        messages.push(...kept);
      }
    }
    this.meta.messageCount = messages.length;
    return messages;
  }

  private openLog(): fs.WriteStream {
    if (!this.logStream) {
      ensureDir(SESSIONS_DIR);
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a', mode: 0o600 });
    }
    return this.logStream;
  }

  private writeLine(rec: LogRecord): void {
    this.openLog().write(JSON.stringify(rec) + '\n');
  }

  private flushMeta(): void {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  /** Append a new message to the log. */
  recordMessage(m: Message): void {
    this.writeLine({ t: 'msg', m });
    this.meta.messageCount += 1;
    this.meta.lastAt = Date.now();
    // Use the first user message as the session title.
    if (!this.meta.title && m.role === 'user' && typeof m.content === 'string') {
      this.meta.title = m.content.slice(0, 80);
    }
    this.flushMeta();
  }

  /** Record token usage and running cost. */
  recordUsage(usage: Usage, model: string, cost: number): void {
    this.writeLine({ t: 'usage', u: usage, model, cost });
    this.meta.totalPromptTokens += usage.promptTokens;
    this.meta.totalCompletionTokens += usage.completionTokens;
    this.meta.totalCost += cost;
    this.flushMeta();
  }

  /** Record a file snapshot (used by write_file / edit_file before changes). */
  recordSnapshot(snap: SnapshotRecord, content: Buffer | string): void {
    ensureDir(this.snapshotDir);
    const dest = path.join(this.snapshotDir, snap.hash);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, content);
    }
    this.snapshots.push(snap);
    this.writeLine({ t: 'snapshot', snap });
  }

  /** Record a context compaction event. Caller is expected to have rewritten in-memory history already. */
  recordCompact(droppedMessages: number, summary: string): void {
    this.writeLine({ t: 'compact', droppedMessages, summary });
    this.meta.messageCount -= droppedMessages;
    if (this.meta.messageCount < 0) this.meta.messageCount = 0;
    this.flushMeta();
  }

  /** Persist the active workflow mode on the session meta. */
  setMode(mode: SessionMeta['mode']): void {
    this.meta.mode = mode;
    this.flushMeta();
  }

  /** Persist an updated model (used when /model switches). */
  setModel(model: string): void {
    this.meta.model = model;
    this.flushMeta();
  }

  /** Read a previously-saved snapshot by hash. Returns null if missing. */
  readSnapshot(hash: string): Buffer | null {
    const p = path.join(this.snapshotDir, hash);
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  close(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}
