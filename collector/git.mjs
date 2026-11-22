// Hardened, read-only git invocation for the collector runner (contracts/DECISIONS.md, D4).
// Nothing else in collector/ may spawn git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { contentHash } from './hash.mjs';

const ALLOWED = new Set(['rev-parse', 'status']);
const PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat',
  '-c', 'diff.external=', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false', '-c', 'diff.renames=false', '-c', 'submodule.recurse=false', '-c', 'core.sshCommand=false',
  '-c', 'credential.helper=', '--no-pager'];
const DROP = /^(?:GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_PAGER|PAGER|GIT_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i;

const found = new Map(); // project root -> absolute git path | null (not found)
const inside = (dir, base) => { const fold = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x; const r = path.relative(fold(base), fold(dir)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
/**
 * Absolute path of git from PATH entries OUTSIDE the project: relative / empty entries, the current directory,
 * anything inside the project root or cwd and any node_modules directory are skipped (a project must not
 * supply the binary that is run against it, e.g. node_modules/.bin/git).
 */
export function findGit(env = process.env, cwd = process.cwd(), root = cwd) {
  const key = path.resolve(root);
  if (found.has(key)) return found.get(key);
  const win = process.platform === 'win32';
  const names = win ? ['git.exe'] : ['git'];
  const bases = [path.resolve(cwd), key];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const d = path.resolve(dir);
    if (bases.some((b) => inside(d, b)) || d.split(path.sep).includes('node_modules')) continue;
    for (const n of names) {
      const cand = path.join(d, n);
      try { if (fs.statSync(cand).isFile()) { if (!win) fs.accessSync(cand, fs.constants.X_OK); found.set(key, cand); return cand; } } catch {}
    }
  }
  found.set(key, null);
  return null;
}

/** Runs `git -C root <hardened prefix> <sub> ...args`; returns stdout (Buffer) or null on any failure. */
export function git(root, sub, args = []) {
  if (!ALLOWED.has(sub)) throw new Error(`vto: git ${sub} is not allowed`);
  const exe = findGit(process.env, process.cwd(), root);
  if (!exe) return null;
  const env = {};
  for (const k in process.env) if (!DROP.test(k)) env[k] = process.env[k];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  try {
    return execFileSync(exe, ['-C', root, ...PREFIX, sub, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  } catch { return null; }
}

/**
 * { gitHead, dirty, dirtyFiles } of the work tree at `root` (canonical). dirtyFiles: one
 * `{ path, sha256 }` per path from `status --porcelain=v1 -z --untracked-files=all`; path relative to
 * `root` (via `rel`; outside the root: absolute), sha256 = contentHash at record time, null = the file
 * does not exist (deleted / renamed away). Files above 32 MiB and directories are listed as plain paths.
 * dirty/dirtyFiles are null when git is unavailable / not a repository.
 */
export function workTreeState(root, rel) {
  const head = git(root, 'rev-parse', ['--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])?.toString().trim() || null;
  const top = git(root, 'rev-parse', ['--show-toplevel'])?.toString().replace(/\r?\n$/, '') || null;
  const st = top && git(root, 'status', ['--porcelain=v1', '-z', '--untracked-files=all']);
  if (!st) return { gitHead: head, dirty: null, dirtyFiles: null };
  const files = new Map();
  const add = (abs) => {
    const key = rel(abs);
    if (files.has(key)) return;
    let entry = key;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= 32 * 1024 * 1024) entry = { path: key, sha256: contentHash(fs.readFileSync(abs)) };
    } catch (e) { if (e?.code === 'ENOENT') entry = { path: key, sha256: null }; }
    files.set(key, entry);
  };
  const parts = st.toString('utf8').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    add(path.resolve(top, e.slice(3)));
    if (e[0] === 'R' || e[0] === 'C') { const from = parts[++i]; if (from) add(path.resolve(top, from)); } // "XY to\0from\0"
  }
  return { gitHead: head, dirty: files.size > 0, dirtyFiles: [...files.keys()].sort().map((k) => files.get(k)) };
}
