// Safe handling of raw-data directories (SECURITY-REVIEW F5): vto never deletes a directory it did
// not create. A raw dir is "ours" when it contains the marker file `.vto-raw`. Cleaning removes only
// vto's own record files (w-*.jsonl, s-*.jsonl) – never recursively.
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const MARKER = '.vto-raw';
const OWN = /^(?:w|s)-[\w.-]+\.jsonl$/;
const ALLOWED = (n) => n === MARKER || n === '.gitignore' || OWN.test(n);

function real(p) { try { return realpathSync(p); } catch { return path.resolve(p); } }
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Throws if `dir` must never be used as a raw dir (root, home, cwd/project root or any of its ancestors). */
export function assertSafeRawDir(dir, { cwd = process.cwd() } = {}) {
  const abs = real(dir);
  const forbidden = [path.parse(abs).root, real(homedir()), real(cwd)];
  for (const f of forbidden) if (abs === f) throw new Error(`refusing to use ${abs} as raw dir (filesystem root, home or project root)`);
  if (within(real(cwd), abs)) throw new Error(`refusing to use ${abs} as raw dir: it contains the project`);
  return abs;
}

/**
 * Prepares a raw dir: creates it (0700, marker, .gitignore "*") or validates an existing one.
 * Existing dirs are accepted only when empty or carrying the marker and holding nothing but vto files.
 * clean=true removes previous w-/s-*.jsonl records.
 */
export function prepareRawDir(dir, { clean = true, cwd = process.cwd() } = {}) {
  const abs = assertSafeRawDir(dir, { cwd });
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true, mode: 0o700 });
  } else {
    if (!statSync(abs).isDirectory()) throw new Error(`raw dir ${abs} exists and is not a directory`);
    const entries = readdirSync(abs);
    if (entries.length && !entries.includes(MARKER)) throw new Error(`raw dir ${abs} is not empty and was not created by vto (no ${MARKER} marker) – refusing to touch it`);
    const foreign = entries.filter((n) => !ALLOWED(n));
    if (foreign.length) throw new Error(`raw dir ${abs} contains non-vto files (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}) – refusing to touch it`);
    if (clean) for (const n of entries) if (OWN.test(n)) unlinkSync(path.join(abs, n));
  }
  writeFileSync(path.join(abs, MARKER), 'vto raw data directory – safe to delete\n');
  if (!existsSync(path.join(abs, '.gitignore'))) writeFileSync(path.join(abs, '.gitignore'), '*\n');
  return abs;
}

/** Removes a raw dir only if it carries the marker and holds nothing but vto files. */
export function removeRawDir(dir) {
  const abs = path.resolve(dir);
  if (!existsSync(abs)) return false;
  const entries = readdirSync(abs);
  if (!entries.includes(MARKER) || entries.some((n) => !ALLOWED(n))) return false;
  for (const n of entries) unlinkSync(path.join(abs, n));
  rmdirSync(abs); // not recursive: fails (and keeps everything) if anything else appeared
  return true;
}
