// Writes under repo-controlled state directories (.vto/, .vm-guard/run/) – SECURITY N5 / F11.
// A cloned repository or a PR can commit these directories, symlinks included, so:
//  - every directory component below the project root is lstat-checked: a symlink (or a non-directory)
//    is refused, never followed; directories are created 0700 and narrowed to 0700 when wider
//  - files are opened with O_NOFOLLOW (POSIX) / lstat-checked (Windows) and created 0600
//  - whole-file writes go to a fresh O_EXCL temp file and are renamed over the target (a rename
//    replaces a symlink instead of following it)
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW || 0;
const POSIX = process.platform !== 'win32';

export class UnsafeStateError extends Error {
  constructor(msg) { super(msg); this.code = 'E_UNSAFE_STATE'; }
}

function checkDir(d, { create, fix = true }) {
  let s;
  try { s = fs.lstatSync(d); }
  catch (e) {
    if (e.code !== 'ENOENT' || !create) throw e;
    try { fs.mkdirSync(d, { mode: 0o700 }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    s = fs.lstatSync(d);
  }
  if (s.isSymbolicLink()) throw new UnsafeStateError(`vto: ${d} is a symbolic link – refusing to write through it (remove it; vto state directories must be real directories)`);
  if (!s.isDirectory()) throw new UnsafeStateError(`vto: ${d} is not a directory`);
  if (POSIX && fix && (s.mode & 0o077) !== 0 && (!process.getuid || s.uid === process.getuid())) { try { fs.chmodSync(d, 0o700); } catch {} }
  return d;
}

/**
 * A state directory below `base` (the project root, trusted to exist): `new StateDir(root, '.vto')`.
 * dir(...parts) verifies/creates every component and returns the path; results are cached.
 */
export class StateDir {
  constructor(base, ...top) {
    this.base = base;
    this.top = top;
    this.root = path.join(base, ...top);
    this.ok = new Set();
  }
  /** verify (and create) the directory `top/parts…`; never follows a symlink below `base` */
  dir(...parts) {
    try { return this._walk(parts, true, true); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.ok.clear(); return this._walk(parts, true, true); } // a cached directory was deleted meanwhile
  }
  /** like dir() but without the cache (before a recursive delete) */
  verify(...parts) { return this._walk(parts, true, false); }
  /** verify the chain if it exists; false when a component is missing */
  exists(...parts) { try { this._walk(parts, false, false); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  _walk(parts, create, cache) {
    let d = this.base;
    const all = [...this.top, ...parts.flatMap((p) => String(p).split(/[\\/]/)).filter(Boolean)];
    for (const seg of all) {
      if (seg === '..' || seg === '.') throw new UnsafeStateError(`vto: invalid state path segment "${seg}"`);
      d = path.join(d, seg);
      if (cache && this.ok.has(d)) continue;
      // the top-level state dirs are private (0700); nested ones inherit that protection
      checkDir(d, { create, fix: d === this.root || d.startsWith(this.root + path.sep) });
      if (cache) this.ok.add(d);
    }
    return d;
  }
  /** path of a file in a verified directory: file('runs', 'r1.jsonl') */
  file(...parts) { const name = parts.pop(); return path.join(this.dir(...parts), name); }
  /** every existing entry below the state dir that is a symlink (startup check) → list of paths */
  symlinks(maxDepth = 3) {
    const out = [];
    const walk = (d, depth) => {
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isSymbolicLink()) out.push(p);
        else if (n.isDirectory() && depth < maxDepth) walk(p, depth + 1);
      }
    };
    walk(this.root, 0);
    return out;
  }
}

/** open for writing without following a symlink at the final component; new files are 0600 */
export function openPrivate(file, flag = 'a') {
  const flags = { a: C.O_WRONLY | C.O_CREAT | C.O_APPEND, w: C.O_WRONLY | C.O_CREAT | C.O_TRUNC, wx: C.O_WRONLY | C.O_CREAT | C.O_EXCL }[flag];
  if (flags === undefined) throw new Error(`openPrivate: flag ${flag}`);
  if (!NOFOLLOW) {
    // Windows: no O_NOFOLLOW – refuse reparse points / symlinks explicitly
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new UnsafeStateError(`vto: ${file} is a symbolic link – refusing to write through it`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let fd;
  try { fd = fs.openSync(file, flags | NOFOLLOW, 0o600); }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw new UnsafeStateError(`vto: ${file} is a symbolic link – refusing to write through it`);
    throw e;
  }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile()) throw new UnsafeStateError(`vto: ${file} is not a regular file`);
    if (POSIX && (s.mode & 0o077) !== 0) { try { fs.fchmodSync(fd, 0o600); } catch {} }
  } catch (e) { fs.closeSync(fd); throw e; }
  return fd;
}

export function appendPrivate(file, data) {
  const fd = openPrivate(file, 'a');
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

/** atomic replace: O_EXCL temp file (0600) + rename; never writes through a symlink */
export function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openPrivate(tmp, 'wx');
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  catch (e) {
    // Windows: rename over a file another process has open can fail (EPERM/EBUSY) → replace in place
    try {
      const fd2 = openPrivate(file, 'w');
      try { fs.writeSync(fd2, data); } finally { fs.closeSync(fd2); }
    } finally { fs.rmSync(tmp, { force: true }); }
  }
}

export function copyPrivate(src, dst) { writePrivate(dst, fs.readFileSync(src)); }

/** read a regular file without following a symlink at the final component → Buffer | null */
export function readPrivate(file) {
  let fd;
  try {
    if (!NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, C.O_RDONLY | NOFOLLOW);
  } catch { return null; }
  try { return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null; } catch { return null; } finally { fs.closeSync(fd); }
}
