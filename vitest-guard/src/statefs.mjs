// Reads and writes below a repo-controlled `.vitest-guard/` directory. A cloned repository or a PR can commit
// `.vitest-guard/`, `.vitest-guard/run/` or `.vitest-guard/run/logs/` as a symlink (or a Windows junction), so
//  - every directory component from `.vitest-guard` down to the target is lstat-checked: a symlink, junction or
//    non-directory is refused with a clear message, never followed; created directories are 0700 (POSIX) and
//    our own wider ones are narrowed to 0700
//  - files are opened with O_NOFOLLOW (POSIX) or lstat-checked (Windows) and created 0600
//  - whole-file writes go to a fresh O_EXCL temp file that is renamed over the target (a rename replaces a symlink
//    instead of following it)
//  - recursive deletes verify the chain before and after, and never start at a link
// Dependency-free: it is also inlined into src/setup.bundle.mjs (scripts/bundle-setup.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const POSIX = process.platform !== 'win32';
const STATE = '.vitest-guard';

export class UnsafeStateError extends Error {
  constructor(msg) { super(msg); this.name = 'UnsafeStateError'; this.code = 'E_UNSAFE_STATE'; }
}
const linkMsg = (p) => `[vitest-guard] ${p} is a symbolic link or junction - refusing to follow it (vitest-guard state directories and files must be real; remove the link)`;

/** The directories to check for `p`: from the last `.vitest-guard` segment down to `p` (or `p` alone when there is none). */
function chain(p) {
  const abs = path.resolve(p);
  const segs = abs.split(path.sep);
  const i = segs.lastIndexOf(STATE);
  if (i < 0) return [abs];
  const out = [];
  for (let j = i; j < segs.length; j++) out.push(segs.slice(0, j + 1).join(path.sep) || path.sep);
  return out;
}

function checkDir(d, create) {
  let s;
  try { s = fs.lstatSync(d); }
  catch (e) {
    if (e.code !== 'ENOENT' || !create) throw e;
    try { fs.mkdirSync(d, { mode: 0o700 }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    s = fs.lstatSync(d);
  }
  if (s.isSymbolicLink()) throw new UnsafeStateError(linkMsg(d));
  if (!s.isDirectory()) throw new UnsafeStateError(`[vitest-guard] ${d} is not a directory`);
  if (POSIX && (s.mode & 0o077) !== 0 && (!process.getuid || s.uid === process.getuid())) { try { fs.chmodSync(d, 0o700); } catch {} }
}

/**
 * Verify (and with `create` make) the directory `dir` below `.vitest-guard`. Throws UnsafeStateError on a link or a
 * non-directory anywhere in the chain. Without `create`, returns false when a component is missing.
 */
export function safeDir(dir, { create = true } = {}) {
  for (const d of chain(dir)) {
    try { checkDir(d, create); }
    catch (e) { if (e.code === 'ENOENT' && !create) return false; throw e; }
  }
  return true;
}

/** lstat the final component: refuse a link, return the stats or null when missing. */
function lstatNoLink(file) {
  let s;
  try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (s.isSymbolicLink()) throw new UnsafeStateError(linkMsg(file));
  return s;
}

function openNoFollow(file, flags, mode) {
  if (!NOFOLLOW) lstatNoLink(file); // Windows: no O_NOFOLLOW - refuse links/junctions explicitly
  try { return fs.openSync(file, flags | NOFOLLOW, mode); }
  catch (e) { if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new UnsafeStateError(linkMsg(file)); throw e; }
}

/** Read a state file as text; null when it (or its directory) does not exist. Throws UnsafeStateError on a link. */
export function readStateFile(file, maxBytes = 64 * 1024 * 1024) {
  if (!safeDir(path.dirname(file), { create: false })) return null;
  let fd;
  try { fd = openNoFollow(file, fs.constants.O_RDONLY); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile()) throw new UnsafeStateError(`[vitest-guard] ${file} is not a regular file`);
    if (s.size > maxBytes) throw new UnsafeStateError(`[vitest-guard] ${file} is too large (${s.size} bytes)`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

/** Parsed JSON state file, `fallback` when missing or not JSON. Throws UnsafeStateError on a link. */
export function readStateJson(file, fallback) {
  const txt = readStateFile(file);
  if (txt === null) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

/** Atomic replace (O_EXCL temp file 0600 + rename); creates the directory chain; never writes through a link. */
export function writeStateFile(file, data) {
  safeDir(path.dirname(file));
  lstatNoLink(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = openNoFollow(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  catch (e) {
    // Windows: a rename over a file another process has open can fail (EPERM/EBUSY) -> replace in place
    try {
      const fd2 = openNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
      try { fs.writeSync(fd2, data); } finally { fs.closeSync(fd2); }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
}

/** Append (O_APPEND, O_NOFOLLOW, new files 0600); creates the directory chain. */
export function appendStateFile(file, data) {
  safeDir(path.dirname(file));
  const fd = openNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new UnsafeStateError(`[vitest-guard] ${file} is not a regular file`);
    fs.writeSync(fd, data);
  } finally { fs.closeSync(fd); }
}

/** Write `data` only when the file does not exist yet (e.g. the run/.gitignore). */
export function createStateFile(file, data) {
  safeDir(path.dirname(file));
  if (lstatNoLink(file)) return false;
  let fd;
  try { fd = openNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  return true;
}

/**
 * Remove a file or (with `recursive`) a directory below `.vitest-guard`. The chain is verified before and after, the
 * target itself must not be a link (a recursive delete never starts at a link; links inside are unlinked, not followed).
 */
export function removeState(p, { recursive = false } = {}) {
  if (!safeDir(path.dirname(p), { create: false })) return false;
  const s = lstatNoLink(p);
  if (!s) return false;
  if (s.isDirectory() && !recursive) throw new UnsafeStateError(`[vitest-guard] ${p} is a directory`);
  fs.rmSync(p, { recursive, force: true });
  safeDir(path.dirname(p), { create: false }); // a component swapped for a link meanwhile is reported
  return true;
}

/** List the names in a state directory ([] when missing). Throws UnsafeStateError on a link in the chain. */
export function listStateDir(dir) {
  if (!safeDir(dir, { create: false })) return [];
  try { return fs.readdirSync(dir); } catch { return []; }
}
