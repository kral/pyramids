// Root and path identity (contracts/DECISIONS.md D2) and the content hash (D1) for the daemon.
//  - canonical root = realpath, `/` separators, upper-case drive letter, NFC
//  - path keys are root-relative (files outside the root: absolute canonical), NFC
//  - case policy is probed per root; two keys are the same file when equal after NFC, or after
//    NFC + lower-casing on a case-insensitive file system (drive-letter / UNC paths always fold)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

/** `\` → `/`, `\\?\` prefix removed, upper-case drive letter, NFC, no trailing slash. */
export function toPosix(p) {
  let s = String(p).split('\\').join('/');
  if (s.startsWith('//?/')) s = s.startsWith('//?/UNC/') ? '//' + s.slice(8) : s.slice(4);
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return s.normalize('NFC');
}

export const isAbs = (s) => /^(?:[A-Za-z]:\/|\/)/.test(s);

/** Lexical normalisation of a `/` path: no `.`/`..`/empty segments (keeps a `//server` UNC start). */
export function normSegments(s) {
  s = toPosix(s);
  let prefix = '';
  if (/^[A-Za-z]:\//.test(s)) { prefix = s.slice(0, 3); s = s.slice(3); }
  else if (s.startsWith('//')) { prefix = '//'; s = s.slice(2); }
  else if (s.startsWith('/')) { prefix = '/'; s = s.slice(1); }
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!prefix) out.push('..'); continue; }
    out.push(seg);
  }
  return prefix + out.join('/');
}

/** D2.1 */
export function canonicalRoot(p = process.cwd()) {
  const abs = path.resolve(p);
  return toPosix(real(abs) ?? abs);
}

/** D2.2: realpath of the file or, when it does not exist, of its nearest existing parent. */
export function canonicalFile(f) {
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
  return toPosix(r);
}

/** D2.4 probe: flip the case of an existing entry and see whether it is the same file. */
const ciCache = new Map();
export function isCaseInsensitive(root, { fsImpl = fs } = {}) {
  const key = toPosix(root);
  if (fsImpl === fs && ciCache.has(key)) return ciCache.get(key);
  const fallback = /^[A-Za-z]:|^\/\//.test(key);
  const flip = (s) => { const u = s.toUpperCase(); return u !== s ? u : s.toLowerCase(); };
  let res = fallback;
  try {
    let name = path.basename(root), dir = path.dirname(root);
    if (!name || flip(name) === name) {
      dir = root;
      name = ['package.json', ...fsImpl.readdirSync(root)].find((n) => flip(n) !== n && fsImpl.existsSync(path.join(root, n)));
    }
    if (name) {
      const a = fsImpl.statSync(path.join(dir, name));
      let b = null;
      try { b = fsImpl.statSync(path.join(dir, flip(name))); } catch {}
      res = !!b && (a.ino ? a.ino === b.ino && a.dev === b.dev : true);
    }
  } catch { res = fallback; }
  if (fsImpl === fs) ciCache.set(key, res);
  return res;
}

/** Comparison key of a path spelling (fixture contracts/fixtures/path-identity.json). */
export function foldKey(p, caseInsensitive) {
  const s = normSegments(p);
  return caseInsensitive || /^[A-Za-z]:\/|^\/\//.test(s) ? s.toLowerCase() : s;
}
export function samePath(a, b, caseInsensitive) { return foldKey(a, caseInsensitive) === foldKey(b, caseInsensitive); }

/** abs (canonical spelling) → stored key: root-relative below the root, else absolute. */
export function relKey(root, abs) {
  const s = toPosix(abs);
  if (s === root) return '';
  if (s.startsWith(root + '/')) return s.slice(root.length + 1);
  if (!isAbs(s)) return normSegments(s);
  // case-insensitive spelling difference of the root itself (drive letter paths, D2.4)
  if (/^[A-Za-z]:\/|^\/\//.test(root) && s.toLowerCase().startsWith(root.toLowerCase() + '/')) return s.slice(root.length + 1);
  return s;
}
/** stored key → abs path under the READER's root (D2.6: maps are portable). */
export function absKey(root, key) {
  if (typeof key !== 'string') return key;
  const s = toPosix(key);
  return isAbs(s) ? normSegments(s) : normSegments(`${root}/${s}`);
}

/** D1: SHA-256 of the bytes after removing one UTF-8 BOM and CRLF → LF. */
export function contentHash(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  let i = buf.indexOf(0x0d);
  if (i === -1) return createHash('sha256').update(buf).digest('hex');
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  if (i > 0) { buf.copy(out, 0, 0, i); n = i; }
  for (; i < buf.length; i++) { if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; out[n++] = buf[i]; }
  return createHash('sha256').update(out.subarray(0, n)).digest('hex');
}
