// Root and path identity for the collector's MAIN process (contracts/DECISIONS.md, D2).
// The worker side (setup-v2.mjs) must stay a single self-contained file and carries its own copy of the
// same rules (makePaths); collector/test/collector.test.mjs checks that both agree.
import fs from 'node:fs';
import path from 'node:path';

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

/** `\` → `/`, upper-case drive letter, NFC, no trailing slash (except a bare root). */
export function toPosix(p) {
  let s = p.split('\\').join('/');
  if (s.startsWith('//?/')) s = s.startsWith('//?/UNC/') ? '//' + s.slice(8) : s.slice(4); // Windows \\?\ prefix
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return s.normalize('NFC');
}

/** Canonical project root (D2.1): realpath, `/` separators, upper-case drive letter, NFC. */
export function canonicalRoot(p = process.cwd()) {
  const abs = path.resolve(p);
  return toPosix(real(abs) ?? abs);
}

/**
 * Canonical spelling of a file (D2.2): realpath of the file or, when it does not exist, of its nearest
 * existing parent. Results are cached (the plugin asks once per module).
 */
const cache = new Map();
export function canonicalFile(f) {
  let c = cache.get(f);
  if (c !== undefined) return c;
  const abs = path.resolve(f);
  let r = real(abs);
  if (r === null) {
    let dir = path.dirname(abs), tail = path.basename(abs);
    for (;;) {
      const rd = real(dir);
      if (rd !== null) { r = path.join(rd, tail); break; }
      const up = path.dirname(dir);
      if (up === dir) { r = abs; break; }
      tail = path.join(path.basename(dir), tail); dir = up;
    }
  }
  c = toPosix(r);
  cache.set(f, c);
  return c;
}

/**
 * Case-insensitivity probe (D2.4): flip the case of an existing entry and see whether it resolves to
 * the same file. Undecidable ⇒ case-sensitive on POSIX, insensitive for drive-letter / UNC roots.
 */
export function isCaseInsensitive(root) {
  const fallback = /^[A-Za-z]:|^\/\//.test(toPosix(root));
  const flip = (s) => { const u = s.toUpperCase(); return u !== s ? u : s.toLowerCase(); };
  try {
    let name = path.basename(root), dir = path.dirname(root);
    if (!name || flip(name) === name) {
      dir = root;
      name = ['package.json', ...fs.readdirSync(root)].find((n) => flip(n) !== n && fs.existsSync(path.join(root, n)));
      if (!name) return fallback;
    }
    const a = fs.statSync(path.join(dir, name));
    let b;
    try { b = fs.statSync(path.join(dir, flip(name))); } catch { return false; } // flipped spelling does not resolve
    return process.platform === 'win32' ? true : a.dev === b.dev && a.ino === b.ino;
  } catch {}
  return fallback;
}

/** Root-relative key of an absolute path (D2.2), or the canonical absolute path when outside the root. */
export function makeRel(root, ci = false) {
  const R = root.endsWith('/') ? root : root + '/', RL = R.toLowerCase();
  return (f) => {
    const p = toPosix(f);
    if (p.startsWith(R) || (ci && p.slice(0, R.length).toLowerCase() === RL)) return p.slice(R.length);
    return p;
  };
}
