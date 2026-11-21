// Path containment for everything the TUI opens or reads on behalf of untrusted event data
// (frame paths from test output, committed run logs, CI artifacts).
//
// A frame path is accepted only when, after resolving symlinks, it is a regular file inside the
// project root. UNC, device and NTFS-stream spellings are rejected *before* any file-system call:
// on Windows even `fs.existsSync('\\\\host\\share\\x')` opens an SMB connection and leaks NTLM
// credentials.
import fs from 'node:fs';
import path from 'node:path';

export interface FsLike {
  realpathSync(p: string): string;
  statSync(p: string): { isFile(): boolean; size: number; mtimeMs: number };
}
const realFs: FsLike = {
  realpathSync: (p) => fs.realpathSync.native(p),
  statSync: (p) => fs.statSync(p),
};

/** Extensions `o` may hand to an editor. Text source formats only: never executables, shortcuts, scripts for OS hosts. */
export const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'json5', 'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm',
  'md', 'mdx', 'graphql', 'gql', 'yml', 'yaml', 'toml', 'snap', 'txt',
]);

export type PathError = 'invalid path' | 'outside the project root' | 'not found' | 'not a regular file' | 'not a source file';

/** String-level checks; no file-system access. `platform` is injectable for tests. */
export function rejectSpelling(file: string, platform: NodeJS.Platform = process.platform): PathError | null {
  if (typeof file !== 'string' || !file || file.length > 4096 || /[\0\r\n]/.test(file)) return 'invalid path';
  // UNC (\\host\share, //host/share), device (\\.\, \\?\) and their forward-slash forms – on every
  // platform: a log recorded on Linux can be viewed on Windows
  if (/^[\\/]{2}/.test(file)) return 'outside the project root';
  if (/^file:/i.test(file) || /^[a-z][a-z0-9+.-]+:\/\//i.test(file)) return 'invalid path';
  if (platform === 'win32') {
    // drive-relative "C:foo", alternate data streams "a.ts:stream", reserved device names
    const rest = /^[A-Za-z]:[\\/]/.test(file) ? file.slice(3) : file;
    if (/^[A-Za-z]:/.test(rest) || rest.includes(':')) return 'invalid path';
    if (rest.split(/[\\/]/).some((seg) => /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\.|$)/i.test(seg))) return 'invalid path';
  }
  return null;
}

function inside(realRoot: string, real: string, p: typeof path.posix): boolean {
  const rel = p.relative(realRoot, real);
  return rel !== '' && !rel.startsWith('..' + p.sep) && rel !== '..' && !p.isAbsolute(rel);
}

export interface Resolved { ok: true; abs: string; rel: string; size: number; mtimeMs: number }
export interface Rejected { ok: false; error: PathError }

/**
 * Resolve `file` (relative to `root`, or absolute) to a real path inside the real root.
 * `requireSource` additionally demands a source-like extension (used by `o`/`O`).
 */
export function resolveInsideRoot(root: string, file: string, o: { requireSource?: boolean; fs?: FsLike; platform?: NodeJS.Platform } = {}): Resolved | Rejected {
  const platform = o.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fsx = o.fs ?? realFs;
  const bad = rejectSpelling(file, platform);
  if (bad) return { ok: false, error: bad };
  let realRoot: string;
  try { realRoot = fsx.realpathSync(p.resolve(root)); } catch { return { ok: false, error: 'not found' }; }
  const lexical = p.resolve(realRoot, file);
  // cheap lexical test first: `../../etc/passwd` never reaches the file system. An absolute path
  // may still be spelled through a symlinked root, so that case is decided after realpath.
  if (!p.isAbsolute(file) && !inside(realRoot, lexical, p)) return { ok: false, error: 'outside the project root' };
  let real: string;
  try { real = fsx.realpathSync(p.isAbsolute(file) ? p.resolve(file) : lexical); } catch { return { ok: false, error: 'not found' }; }
  if (/^[\\/]{2}/.test(real)) return { ok: false, error: 'outside the project root' };
  if (!inside(realRoot, real, p)) return { ok: false, error: 'outside the project root' };
  let st: ReturnType<FsLike['statSync']>;
  try { st = fsx.statSync(real); } catch { return { ok: false, error: 'not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a regular file' };
  if (o.requireSource) {
    const ext = p.extname(real).slice(1).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) return { ok: false, error: 'not a source file' };
  }
  return { ok: true, abs: real, rel: p.relative(realRoot, real).split(p.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs };
}
