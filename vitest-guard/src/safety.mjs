// Input validation and safe temp files (SECURITY-REVIEW F8, F9).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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
  glob = normGlob(glob);
  if (file === glob || escapeGlob(file) === glob) return true; // literal entries (path.matchesGlob ignores \\ escapes)
  if (path.matchesGlob(file, glob)) return true;
  if (!/(^|\/)\./.test(file)) return false;
  return path.matchesGlob(file.split('/').map((s) => (s.startsWith('.') ? '\uE000' + s.slice(1) : s)).join('/'), glob);
}

/** R5/R6: Vitest (tinyglobby) accepts `./src/**`; path.matchesGlob does not: drop leading `./` segments. */
export const normGlob = (g) => (typeof g === 'string' ? g.replace(/^(?:\.\/)+/, '') : g);

const globCache = new Map();
/**
 * R5/R6: the test files of a project exactly as Vitest globs them: Vitest's own tinyglobby (resolved from the
 * project's vitest, never from vitest-guard's location) with Vitest's options (`dot: true`, exclude as `ignore`,
 * `expandDirectories: false`). Root-relative paths with `/`, sorted. null when tinyglobby cannot be resolved
 * (callers then fall back to their own matching and must fail closed).
 */
export function globProjectFiles(root, include, exclude = []) {
  const key = JSON.stringify([root, include, exclude]);
  if (globCache.has(key)) return globCache.get(key);
  let out = null;
  try {
    let tg = null;
    for (const base of [path.join(root, 'package.json'), path.join(process.cwd(), 'package.json')]) {
      try { const rq = createRequire(base); tg = createRequire(rq.resolve('vitest/package.json'))('tinyglobby'); break; } catch {}
    }
    if (tg && typeof tg.globSync === 'function') {
      out = tg.globSync([].concat(include), { dot: true, cwd: root, ignore: [].concat(exclude), expandDirectories: false })
        .map((f) => path.relative(root, path.resolve(root, f)).split(path.sep).join('/')).sort();
    }
  } catch { out = null; }
  globCache.set(key, out);
  return out;
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
export function validateTestPaths(root, entries, { include, exclude = [], files = null, label = 'vitest-guard data', warn = true } = {}) {
  const ok = [], rejected = [], remapped = [];
  const map = new Map(); // entry -> the on-disk spelling it was applied to
  const realRoot = safeRealpath(root);
  const names = new Map(); // directory -> its entry names (one readdir per directory and call)
  const fileSet = files ? new Set(files) : null;
  for (const entry of entries) {
    const r = checkEntry(realRoot, entry, include, exclude, names, fileSet);
    if (r.reason) { rejected.push({ entry, reason: r.reason }); continue; }
    if (r.path !== entry) remapped.push({ entry, path: r.path });
    map.set(entry, r.path);
    if (!ok.includes(r.path)) ok.push(r.path);
  }
  if (warn && rejected.length) {
    for (const r of rejected.slice(0, 20)) console.warn(`[vitest-guard] ignoring ${sanitize(label)} entry ${sanitize(JSON.stringify(String(r.entry)), 200)}: ${r.reason}`);
    if (rejected.length > 20) console.warn(`[vitest-guard] ... and ${rejected.length - 20} more ignored ${sanitize(label)} entries`);
  }
  if (warn && remapped.length) {
    for (const r of remapped.slice(0, 20)) console.warn(`[vitest-guard] ${sanitize(label)} entry ${sanitize(JSON.stringify(r.entry), 200)} is spelled differently on disk (case or Unicode form): applied to ${sanitize(JSON.stringify(r.path), 200)}; re-spell the key (\`vitest-guard check\` rewrites it)`);
  }
  return { ok, rejected, remapped, map };
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

const fold = (x) => x.normalize('NFC').toLowerCase();
/**
 * The on-disk spelling of `entry` below `root`, segment by segment. S12 / review 3 item 3: a segment that is not
 * spelled exactly as on disk is mapped to the single directory entry that equals it case-insensitively after NFC
 * normalization (NTFS/APFS accept `src/Button.test.tsx` for `src/button.test.tsx`; macOS NFD vs Linux NFC names), so
 * a committed quarantine key keeps guarding its file. Two candidates (a case-sensitive file system) -> null.
 */
function diskSpelling(root, entry, names) {
  let dir = root;
  const out = [];
  for (const seg of entry.split('/')) {
    let set = names.get(dir);
    if (set === undefined) { try { set = fs.readdirSync(dir); } catch { set = null; } names.set(dir, set); }
    if (!set) return null;
    let name = set.includes(seg) ? seg : null;
    if (!name) {
      const cand = set.filter((n) => fold(n) === fold(seg));
      if (cand.length !== 1) return null;
      name = cand[0];
    }
    out.push(name);
    dir = path.join(dir, name);
  }
  return out.join('/');
}

function checkEntry(root, entry, include, exclude, names = new Map(), files = null) {
  const no = (reason) => ({ reason });
  if (typeof entry !== 'string' || !entry) return no('not a non-empty string');
  if (entry.length > 1024 || /[\0-\x1f\x7f]/.test(entry)) return no('control characters or too long');
  if (entry.includes('\\')) return no('backslash (use / separators)');
  if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) return no('absolute path');
  if (entry.split('/').some((s) => s === '..' || s === '.' || s === '')) return no('not a normalized relative path (., .. or empty segment)');
  if (GLOB_META.test(entry)) return no('glob metacharacters (only literal paths are accepted)');
  if (!root) return no('file does not exist');
  const p = diskSpelling(root, entry, names);
  if (p === null) return no('file does not exist');
  if (files) { if (!files.has(p)) return no('not one of the test files Vitest globs for this project (include / exclude)'); }
  else {
    if (include && !include.some((g) => matchesGlobDot(p, g))) return no('does not match the include globs');
    if (exclude.some((g) => matchesGlobDot(p, g))) return no('matches an exclude glob');
  }
  const abs = path.join(root, p);
  let st;
  try { st = fs.lstatSync(abs); } catch { return no('file does not exist'); }
  if (st.isSymbolicLink()) {
    const real = safeRealpath(abs);
    if (!real || !isInside(root, real)) return no('symlink pointing outside the project');
    try { st = fs.statSync(real); } catch { return no('dangling symlink'); }
  }
  if (!st.isFile()) return no('not a regular file');
  return { path: p };
}

function safeRealpath(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

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
