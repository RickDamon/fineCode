/**
 * Central path resolver — everything profile-scoped lives under the same root.
 *
 * Layout:
 *   ~/.fineCode/                             default profile root
 *     config.json
 *     anchors.json
 *     memory.json
 *     sessions/<id>.jsonl
 *     sessions/<id>.meta.json
 *     sessions/<id>.snapshots/
 *     skills/*.md
 *     FINE.md                                user-global rules
 *
 *   ~/.fineCode/profiles/<name>/             named profiles ("work", "side", ...)
 *     (same structure as above)
 *
 * Why a mutable global state (gasp) instead of threading a paths object
 * everywhere: the CLI resolves the profile exactly ONCE at boot, then every
 * module just reads the current path. Passing a `paths` arg through every
 * function that touches disk would be 200+ lines of plumbing for a setting
 * that never changes inside a single process.
 */

import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.fineCode');

let activeRoot: string = DEFAULT_ROOT;
let activeProfile: string | null = null; // null = default profile

/**
 * Switch the active profile. Call this exactly once near CLI startup, BEFORE
 * any other module reads config / sessions / anchors.
 *
 * Passing null or 'default' resets to the default root (~/.fineCode).
 */
export function setActiveProfile(name: string | null): void {
  if (!name || name === 'default') {
    activeRoot = DEFAULT_ROOT;
    activeProfile = null;
    return;
  }
  // Validate: profile names must be filesystem-safe.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, digits, hyphen, underscore; max 64 chars.`,
    );
  }
  activeRoot = path.join(DEFAULT_ROOT, 'profiles', name);
  activeProfile = name;
}

export function getActiveProfile(): string | null {
  return activeProfile;
}

/** The profile root dir. Used by things that need to scan it directly. */
export function profileRoot(): string {
  return activeRoot;
}

export function configFile(): string {
  return path.join(activeRoot, 'config.json');
}

export function sessionsDir(): string {
  return path.join(activeRoot, 'sessions');
}

export function anchorsFile(): string {
  return path.join(activeRoot, 'anchors.json');
}

export function skillsDir(): string {
  return path.join(activeRoot, 'skills');
}

export function memoryFile(): string {
  return path.join(activeRoot, 'memory.json');
}

/** User-global FINE.md (per-profile). */
export function userFineMd(): string[] {
  return [path.join(activeRoot, 'FINE.md'), path.join(activeRoot, 'CLAUDE.md')];
}

/** List existing profiles (directory names under ~/.fineCode/profiles/). */
export function listProfileNames(): string[] {
  try {
    const dir = path.join(DEFAULT_ROOT, 'profiles');
    // Late import to avoid circular deps with fs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}
