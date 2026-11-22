// Input validation and safe temp files (SECURITY-REVIEW F8, F9).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// B1: `[ ] { } ( ) ! + @` are everyday path characters (Next.js `app/[id]`, `(group)`, `src/@core`): accepted and
// escaped (escapeGlob) wherever a literal path becomes an include/exclude entry. `*` and `?` stay refused.
const GLOB_META = /[*?]/;

/** A literal path as a glob that matches exactly that path (same escaping as tinyglobby's escapePath on win32/posix). */
export function escapeGlob(p) {
  return p.replace(/[()[\]{}|]|^!|[!+@](?=\()/g, '\\$&');
}

/**
 * path.matchesGlob with Vitest's `dot: true` semantics (Vitest globs with tinyglobby `dot: true`, so `**` also
 * matches `.storybook/`; path.matchesGlob does not). Dot segments are masked for a second attempt.
 */
export function matchesGlobDot(file, glob) {
  if (file === glob || escapeGlob(file) === glob) return true; // literal entries (path.matchesGlob ignores \\ escapes)
  if (path.matchesGlob(file, glob)) return true;
  if (!/(^|\/)\./.test(file)) return false;
  return path.matchesGlob(file.split('/').map((s) => (s.startsWith('.') ? '\uE000' + s.slice(1) : s)).join('/'), glob);
}

// C0 (incl. ESC, \n, \t), DEL, C1 (incl. U+009B CSI, U+009D OSC), soft hyphen, Arabic letter mark, zero-width and bidi
// marks/embeddings/overrides/isolates, word joiner and invisible operators, BOM, interlinear annotations, line/paragraph
// separators, Unicode tag characters and lone surrogates
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const hex = (ch) => [...ch].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
/**
 * One printable line for a name that does not come from vitest-guard itself (test file names, test titles, project
 * names, env keys, labels read from committed state): terminal controls (C0, ESC, C1, DEL) and invisible / bidi
 * characters are shown as visible `\uXXXX` escapes, so they can neither drive the terminal nor spoof the display.
 * Not for paths that are used: only for what is printed.
 */
export function sanitize(value, maxLen = 300) {
  let s = typeof value === 'string' ? value : String(value);
  if (s.length > maxLen * 2) s = s.slice(0, maxLen * 2);
  s = s.replace(UNSAFE, hex);
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

const SGR = /(\x1b\[[0-9;]*m)/;
/** Multi-line console text (CLI messages that embed names or Vitest output): like sanitize(), but keeps "\n", "\t" and plain SGR colours. */
export function sanitizeText(value) {
  const s = (typeof value === 'string' ? value : String(value)).replace(/\r\n/g, '\n');
  return s.split(SGR).map((part, i) => (i % 2 ? part : part.replace(UNSAFE, (ch) => (ch === '\n' || ch === '\t' ? ch : hex(ch))))).join('');
}

/**
 * F9: paths coming from committed / environment-supplied data (.vitest-guard/incompatible.json, conflicts.json,
 * pollution.json, durations.json, VITEST_GUARD_LANE_FILE) end up as Vitest `include` entries or decide what runs
 * where. Accept only literal, normalized, repo-relative paths of existing regular files inside the root
 * that match the project's include globs and none of its exclude globs.
 * @returns {{ ok: string[], rejected: {entry: unknown, reason: string}[] }}
 */
export function validateTestPaths(root, entries, { include, exclude = [], label = 'vitest-guard data', warn = true } = {}) {
  const ok = [], rejected = [];
  const realRoot = safeRealpath(root);
  const names = new Map(); // directory -> its entry names (one readdir per directory and call)
  for (const entry of entries) {
    const reason = checkEntry(realRoot, entry, include, exclude, names);
    if (reason) rejected.push({ entry, reason });
    else if (!ok.includes(entry)) ok.push(entry);
  }
  if (warn && rejected.length) {
    for (const r of rejected.slice(0, 20)) console.warn(`[vitest-guard] ignoring ${sanitize(label)} entry ${sanitize(JSON.stringify(String(r.entry)), 200)}: ${r.reason}`);
    if (rejected.length > 20) console.warn(`[vitest-guard] ... and ${rejected.length - 20} more ignored ${sanitize(label)} entries`);
  }
  return { ok, rejected };
}

/**
 * S12: `p` is `root` or inside it. Separator-aware (no prefix match of `/a/bc` in `/a/b`); on Windows also
 * case-insensitive and with either separator.
 */
export function isInside(root, p, { platform = process.platform } = {}) {
  const win = platform === 'win32', P = win ? path.win32 : path.posix;
  const norm = (x) => { let n = P.resolve(String(x)); if (win) n = n.toLowerCase(); return n.length > 1 && n.endsWith(P.sep) && !/^[a-z]:\\$/i.test(n) ? n.slice(0, -1) : n; };
  const r = norm(root), q = norm(p);
  return q === r || q.startsWith(r.endsWith(P.sep) ? r : r + P.sep);
}

function checkEntry(root, entry, include, exclude, names = new Map()) {
  if (typeof entry !== 'string' || !entry) return 'not a non-empty string';
  if (entry.length > 1024 || /[\0-\x1f\x7f]/.test(entry)) return 'control characters or too long';
  if (entry.includes('\\')) return 'backslash (use / separators)';
  if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) return 'absolute path';
  if (entry.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'not a normalized relative path (., .. or empty segment)';
  if (GLOB_META.test(entry)) return 'glob metacharacters (only literal paths are accepted)';
  if (include && !include.some((g) => matchesGlobDot(entry, g))) return 'does not match the include globs';
  if (exclude.some((g) => matchesGlobDot(entry, g))) return 'matches an exclude glob';
  const abs = path.join(root, entry);
  let st;
  try { st = fs.lstatSync(abs); } catch { return 'file does not exist'; }
  if (st.isSymbolicLink()) {
    const real = safeRealpath(abs);
    if (!real || !isInside(root, real)) return 'symlink pointing outside the project';
    try { st = fs.statSync(real); } catch { return 'dangling symlink'; }
  }
  if (!st.isFile()) return 'not a regular file';
  // S12: on a case-insensitive file system (NTFS, APFS) lstat accepts `src/Button.test.tsx` for `src/button.test.tsx`,
  // but Vitest's include / exclude literals compare exactly: the entry must spell every segment as the directory does
  let dir = root;
  for (const seg of entry.split('/')) {
    let set = names.get(dir);
    if (!set) { try { set = new Set(fs.readdirSync(dir)); } catch { set = null; } names.set(dir, set); }
    if (set && !set.has(seg)) return `the name on disk is spelled differently (case or Unicode form of ${JSON.stringify(seg)})`;
    dir = path.join(dir, seg);
  }
  return null;
}

function safeRealpath(p) { try { return fs.realpathSync(p); } catch { return null; } }

/** Keep only well-formed conflict edges whose both ends are in `files` (an already validated list). */
export function validEdges(edges, files) {
  const set = new Set(files);
  return (Array.isArray(edges) ? edges : []).filter((e) => e && typeof e === 'object' && set.has(e.a) && set.has(e.b) && e.a !== e.b);
}

/** Keep only keys present in `files` (pollution.json, durations.json, incompatible.json maps). */
export function pickKnown(obj, files) {
  const set = new Set(files), out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) if (set.has(k)) out[k] = v;
  return out;
}

/**
 * F8: private temp directory (mkdtemp creates it 0700 and with an unpredictable name).
 * @returns {{ dir: string, file: (name: string) => string, cleanup: () => void }}
 */
export function privateTmp(prefix = 'vitest-guard-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { fs.chmodSync(dir, 0o700); } catch {}
  return {
    dir,
    file: (name) => path.join(dir, name.replace(/[^\w.-]/g, '_')),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/**
 * F8: read a file we expect to have created ourselves inside our private dir: the directory must be ours,
 * not a symlink and 0700; the file is opened without following symlinks (O_NOFOLLOW) and must be a regular
 * file with a single link, owned by the current user.
 */
export function readOwnedFile(file, maxBytes = 256 * 1024 * 1024) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (process.platform !== 'win32') {
    const d = fs.lstatSync(path.dirname(file));
    if (!d.isDirectory()) throw new Error(`${path.dirname(file)}: not a directory`);
    if (uid !== null && d.uid !== uid) throw new Error(`${path.dirname(file)}: owned by uid ${d.uid}, expected ${uid}`);
    if (d.mode & 0o077) throw new Error(`${path.dirname(file)}: accessible by group/others (mode ${(d.mode & 0o777).toString(8)})`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file}: not a regular file`);
    if (st.nlink !== 1) throw new Error(`${file}: unexpected hard links (${st.nlink})`);
    if (uid !== null && st.uid !== uid) throw new Error(`${file}: owned by uid ${st.uid}, expected ${uid}`);
    if (st.size > maxBytes) throw new Error(`${file}: too large (${st.size} bytes)`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
