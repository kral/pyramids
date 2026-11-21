// The ONLY place in the daemon that spawns git (contracts/DECISIONS.md D4; port of analyzer/src/git.rs).
//  - binary: resolved once by walking PATH; relative / empty entries and the current directory are
//    skipped, nothing below the project root is a candidate, no shell, argv array
//  - fixed hardening prefix on every call: nothing from the checkout's config may execute
//    (fsmonitor, hooks, external diff, textconv, pager, ssh/credential helpers), names unquoted
//  - scrubbed environment; read-only sub-commands only; path lists read with -z
//  - any failure → null (callers answer "run all"), never an empty diff
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toPosix, canonicalRoot } from './paths.mjs';

export const GIT_HARDEN = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat',
  '-c', 'diff.external=', '-c', 'core.quotePath=false',
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false', '-c', 'diff.renames=false',
  '-c', 'submodule.recurse=false', '-c', 'core.sshCommand=false',
  '-c', 'credential.helper=', '--no-pager',
];
export const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--text', '--no-renames', '--ignore-submodules=none'];
const ALLOWED = new Set(['rev-parse', 'diff', 'ls-files', 'cat-file', 'status', 'merge-base']);
const ENV_DROP = /^(GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_PAGER|PAGER|GIT_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i;
export const MAX_OUTPUT = 256 * 1024 * 1024;

export const BASE_RE = /^[A-Za-z0-9._\/~^@{}-]{1,256}$/;
export function validBase(b) { return typeof b === 'string' && BASE_RE.test(b) && !b.startsWith('-') && !b.includes('..'); }

export function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!ENV_DROP.test(k)) out[k] = v;
  out.GIT_OPTIONAL_LOCKS = '0'; out.GIT_TERMINAL_PROMPT = '0'; out.LC_ALL = 'C';
  return out;
}

/**
 * Absolute path of an executable found on PATH (D4.1). Skips relative and empty entries, the
 * current directory and every directory at or below `avoid` (the project root): Windows'
 * implicit "current directory first" lookup and repo-supplied binaries are never used.
 */
export function findOnPath(name, { env = process.env, platform = process.platform, cwd = process.cwd(), avoid = [], fsImpl = fs } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  const exts = platform === 'win32' ? ['.exe', '.com'] : ['']; // never .bat/.cmd: they need a shell
  const fold = (s) => { const t = toPosix(P.normalize(s)); return platform === 'win32' ? t.toLowerCase() : t; };
  const bad = [cwd, ...avoid].filter(Boolean).map(fold);
  for (let dir of raw.split(sep)) {
    dir = dir.replace(/^"(.*)"$/, '$1');
    if (!dir || !P.isAbsolute(dir)) continue;
    const d = fold(dir);
    if (bad.some((b, i) => (i === 0 ? d === b : d === b || d.startsWith(b + '/')))) continue;
    for (const e of exts) {
      const p = P.join(dir, /\.[A-Za-z]{3}$/.test(name) && platform === 'win32' ? name : name + e);
      try { if (fsImpl.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

/** Windows system tools by absolute path (%SystemRoot%\System32), never by bare name (N1c). */
export function systemExe(name, { env = process.env } = {}) {
  const sysroot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return path.win32.join(sysroot, 'System32', name);
}

const gitCache = new Map();
export function findGit(root) {
  const k = root || '';
  if (!gitCache.has(k)) gitCache.set(k, findOnPath('git', { avoid: root ? [root] : [] }));
  return gitCache.get(k);
}
export function _resetGitCache() { gitCache.clear(); }

/**
 * Run a hardened, read-only git command in `root`. → Buffer (stdout) | null on ANY failure.
 * `info` (optional object) receives {error} for diagnostics.
 */
export function git(root, args, { timeoutMs = 60000, info, input } = {}) {
  return new Promise((resolve) => {
    const fail = (why) => { if (info) info.error = why; resolve(null); };
    if (!ALLOWED.has(args[0])) return fail(`git sub-command "${args[0]}" is not allowed`);
    const bin = findGit(root);
    if (!bin) return fail('git not found on PATH');
    let p;
    try { p = spawn(bin, ['-C', root, ...GIT_HARDEN, ...args], { cwd: root, env: gitEnv(), windowsHide: true, shell: false, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
    catch (e) { return fail(`git could not start: ${e.message}`); }
    const chunks = []; let size = 0, err = '', done = false;
    const finish = (v, why) => { if (done) return; done = true; clearTimeout(t); if (v === null) fail(why); else resolve(v); };
    const t = setTimeout(() => { try { p.kill(); } catch {} finish(null, 'git timeout'); }, timeoutMs);
    p.stdout.on('data', (d) => { size += d.length; if (size > MAX_OUTPUT) { try { p.kill(); } catch {} finish(null, 'git output too large'); } else chunks.push(d); });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    p.on('error', (e) => finish(null, `git failed: ${e.message}`));
    p.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null, `git ${args[0]} exited ${code}: ${err.trim().split('\n')[0].slice(0, 200)}`));
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

const splitZ = (buf) => buf.toString('utf8').split('\0').filter((s) => s.length);

/** user-supplied revision → commit sha | null (D4.5) */
export async function resolveRev(root, rev) {
  if (!validBase(rev)) return null;
  const o = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  const sha = o?.toString('utf8').trim();
  return sha && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
}
export async function head(root) { const o = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}']); return o ? o.toString('utf8').trim() || null : null; }
/** canonical git top level (D2) | null */
export async function topLevel(root) {
  const o = await git(root, ['rev-parse', '--show-toplevel']);
  const s = o?.toString('utf8').replace(/\r?\n$/, '');
  return s ? canonicalRoot(s) : null;
}
/** names (relative to the git top level) that differ between `sha` and the working tree | null */
export async function diffNames(root, sha, info) {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const o = await git(root, ['diff', '--name-only', '-z', ...DIFF_FLAGS, '--end-of-options', sha, '--'], { info });
  return o ? splitZ(o) : null;
}
/** content of `<sha>:<gitPath>` | null (missing at that commit) */
export function blobAt(root, sha, gitPath) {
  if (!/^[0-9a-f]{40,64}$/.test(sha) || gitPath.includes('\0')) return Promise.resolve(null);
  return git(root, ['cat-file', 'blob', `${sha}:${gitPath}`]); // the argument starts with a validated hex sha: it cannot be an option
}
/** every file git knows or would add (tracked + untracked, not ignored), relative to cwd=root | null */
export async function listFiles(root, info) {
  const o = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'], { info });
  return o ? splitZ(o) : null;
}
/** paths below `rel` that git tracks (index) | null when not a repository */
export async function trackedBelow(root, rel) {
  const o = await git(root, ['ls-files', '-z', '--cached', '--', rel]);
  return o ? splitZ(o) : null;
}
