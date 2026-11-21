// Cross-platform helpers: IPC endpoint, path normalisation, case sensitivity, process trees.
// Everything that differs between Linux / macOS / Windows lives here, with injectable `platform`
// so the Windows / macOS branches are unit-testable on Linux (test/platform.test.mjs).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { toPosix, contentHash } from './paths.mjs';
import { systemExe } from './git.mjs';
import { openPrivate } from './safefs.mjs';

export { contentHash };

export const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/** Forward slashes, no trailing slash, drive letter upper-cased (`c:\x` → `C:/x`). */
export function slash(p) { return toPosix(p); } // + NFC (contracts/DECISIONS.md D2.3)

/**
 * Is the filesystem holding `dir` case-insensitive? Detected, not assumed by OS (APFS/HFS+ default
 * insensitive, case-sensitive APFS exists; NTFS insensitive but per-directory case sensitivity
 * exists; Linux ext4 sensitive, but ciopfs/vfat/smb mounts are not).
 */
const ciCache = new Map();
export function isCaseInsensitiveFs(dir, { fsImpl = fs } = {}) {
  if (ciCache.has(dir)) return ciCache.get(dir);
  let res = false;
  try {
    const real = fsImpl.realpathSync(dir);
    const base = path.basename(real);
    const flipped = flipCase(base);
    if (flipped !== base) {
      const alt = path.join(path.dirname(real), flipped);
      try { const a = fsImpl.statSync(real), b = fsImpl.statSync(alt); res = a.ino === b.ino && a.dev === b.dev; } catch { res = false; }
    } else {
      // no letters in the last segment: probe with a temp file
      const probe = path.join(real, `.vto-Cp${process.pid}`);
      try { fsImpl.writeFileSync(probe, '', { flag: 'wx' }); res = fsImpl.existsSync(path.join(real, `.vto-cP${process.pid}`)); }
      catch { res = false; } finally { try { fsImpl.unlinkSync(probe); } catch {} }
    }
  } catch { res = false; }
  ciCache.set(dir, res);
  return res;
}
function flipCase(s) { return [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join(''); }

/** Key for maps of paths: slashes + optional case folding. */
export function pathKey(p, caseInsensitive) { const s = slash(p); return caseInsensitive ? s.toLowerCase() : s; }

/** Relative display path (always forward slashes). */
export function rel(root, p) {
  const r = path.relative(root, p);
  return slash(r);
}

/** Text normalisation for hashing / diffing: BOM and CRLF do not count as changes of code lines. */
export function normText(s) { return String(s).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }

/**
 * Kill a process and its children. POSIX: signal the process group when we created one
 * (detached spawn), else the pid. Windows: no signals – `taskkill /T /F` kills the tree.
 */
export function killTree(pid, { platform = process.platform, spawnSyncImpl = spawnSync, kill = process.kill.bind(process), signal = 'SIGTERM' } = {}) {
  if (!pid) return false;
  if (platform === 'win32') {
    const r = spawnSyncImpl(systemExe('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return r.status === 0;
  }
  try { kill(-pid, signal); return true; } catch {}
  try { kill(pid, signal); return true; } catch { return false; }
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Start a detached background Node process (daemon). Hidden console window on Windows. */
export function spawnDetached(script, args, { cwd, logFile, env = process.env } = {}) {
  let out = 'ignore';
  if (logFile) out = openPrivate(logFile, 'a'); // the caller verified the directory (StateDir)
  const child = spawn(process.execPath, [script, ...args], { cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true, env });
  child.unref();
  if (typeof out === 'number') fs.closeSync(out);
  return child.pid;
}

/**
 * Analyzer binary candidates, in order (SECURITY N1a): only places the USER or the vto installation
 * controls – never the project under test, never PATH, never the current directory.
 *   1. env VTO_ANALYZER (absolute path, set by the user outside the repository)
 *   2. npm package @kral/vto-analyzer-<platform>-<arch>, resolved from vto's own installation; its sha256
 *      must equal the hash pinned in vto-mcp's analyzer-manifest.json
 *   3. a local cargo build next to this checkout (development; not when installed in node_modules)
 */
export function analyzerCandidates({ platform = process.platform, arch = process.arch, here, env = process.env } = {}) {
  const exe = platform === 'win32' ? 'vto.exe' : 'vto';
  const c = [];
  if (env.VTO_ANALYZER) c.push({ env: env.VTO_ANALYZER });
  c.push({ pkg: `@kral/vto-analyzer-${platform}-${arch}`, file: `bin/${exe}` });
  if (here && !toPosix(here).split('/').includes('node_modules')) {
    c.push({ dev: path.resolve(here, '../../analyzer/target/release', exe) });
    c.push({ dev: path.resolve(here, '../../analyzer/target/debug', exe) });
  }
  return c;
}
