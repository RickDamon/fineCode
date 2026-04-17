/**
 * Skill system — distilled, reusable "how to do X" docs.
 *
 * Inspired by Hermes Agent and Claude Code's skills/. A Skill is a Markdown
 * file with frontmatter (triggers, title) followed by step-by-step guidance.
 *
 * Storage: <profile-root>/skills/*.md
 *
 * Workflow:
 *   1. User does some multi-step task. At the end, they run `/skill save <name>`
 *      which asks the current model to summarize the last N turns into a SKILL.md.
 *   2. On next startup (or /skill load), fineCode scans skills/, reads triggers,
 *      and when the user message contains a trigger keyword, the skill body is
 *      injected into the system prompt as "# Relevant skill: <name>".
 *
 * This is the MANUAL mode (user opts in via /skill save). Auto-creation (save
 * on successful turn completion) is a future iteration — it risks injecting
 * low-quality, wrong, or leaky skills.
 */

import fs from 'node:fs';
import path from 'node:path';
import { skillsDir } from '../config/paths.js';

export interface Skill {
  name: string;
  filePath: string;
  triggers: string[];
  title?: string;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse a SKILL.md string. We intentionally keep the parser trivial — only
 * top-level YAML-ish key: value scalars and `triggers: [a, b, c]` arrays.
 * Users can hand-edit skill files without fighting a full YAML parser.
 */
function parseSkill(name: string, filePath: string, raw: string): Skill {
  const m = raw.match(FRONTMATTER_RE);
  let triggers: string[] = [];
  let title: string | undefined;
  let body = raw;
  if (m) {
    const fm = m[1]!;
    for (const line of fm.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (key === 'triggers') {
        // Support: triggers: [a, "b c", d]
        const arr = val.match(/^\[(.*)\]$/);
        if (arr) {
          triggers = arr[1]!
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else {
          triggers = val
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        }
      } else if (key === 'title') {
        title = val.replace(/^["']|["']$/g, '');
      }
    }
    body = raw.slice(m[0].length);
  }
  return { name, filePath, triggers, title, body: body.trim() };
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const name = f.slice(0, -3);
      out.push(parseSkill(name, full, raw));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function loadSkill(name: string): Skill | null {
  const all = listSkills();
  return all.find(s => s.name === name) ?? null;
}

export function deleteSkill(name: string): boolean {
  const p = path.join(skillsDir(), `${name}.md`);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a Skill. Overwrites if present. Triggers is stored as a bracketed
 * array so it round-trips cleanly.
 */
export function saveSkill(name: string, opts: { title?: string; triggers?: string[]; body: string }): Skill {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const triggers = opts.triggers ?? [];
  const fm = [
    `---`,
    opts.title ? `title: ${JSON.stringify(opts.title)}` : null,
    `triggers: [${triggers.map(t => JSON.stringify(t)).join(', ')}]`,
    `---`,
    '',
    opts.body.trim(),
    '',
  ]
    .filter(l => l !== null)
    .join('\n');
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  const file = path.join(dir, `${safeName}.md`);
  fs.writeFileSync(file, fm, { mode: 0o600 });
  return { name: safeName, filePath: file, triggers, title: opts.title, body: opts.body };
}

/**
 * Given a user message, find skills whose trigger words appear in it.
 * Matching is case-insensitive and matches whole substrings (no regex).
 */
export function matchSkills(userMessage: string, skills = listSkills()): Skill[] {
  const lower = userMessage.toLowerCase();
  const out: Skill[] = [];
  for (const s of skills) {
    if (s.triggers.length === 0) continue;
    for (const t of s.triggers) {
      if (t.length >= 3 && lower.includes(t.toLowerCase())) {
        out.push(s);
        break;
      }
    }
  }
  return out;
}

/** Render one or more skills into a system-prompt block. Returns null if empty. */
export function skillsSystemBlock(skills: Skill[]): string | null {
  if (skills.length === 0) return null;
  const parts: string[] = [
    '# Relevant skills (previously learned procedures)',
    'The following skills were saved earlier by the user. They apply to the current request based on keyword match. Follow them unless the user says otherwise.',
    '',
  ];
  for (const s of skills) {
    parts.push(`## ${s.title ?? s.name}`);
    parts.push(s.body);
    parts.push('');
  }
  return parts.join('\n');
}
