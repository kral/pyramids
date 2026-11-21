// `.vitest-guard/run/env.json` (format "vto-env/1", contracts/env-1.schema.json) – the daemon's side.
//
// The file has ONE owner: vitest-guard's envstore (`updateEnv`: precedence miss > probe > static, sticky
// dom:true, lock, atomic write – REVIEW-2-architecture A-6/N4, REVIEW-2-security N9). The daemon hands
// its classification to that function and never applies merge rules of its own.
// envstore is loaded from vto's own installation (sibling package / dependency), not from the project.
// Only when no envstore can be loaded does the conservative fallback below write the file: it keeps
// every foreign entry, never replaces a measured (probe / miss) entry, takes a lock, uses a
// pid-unique temp file and never follows a symlink.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { StateDir, writePrivate, readPrivate, openPrivate } from './safefs.mjs';
import { isAlive } from './platform.mjs';

export const ENV_FORMAT = 'vto-env/1';
const here = path.dirname(fileURLToPath(import.meta.url));

async function loadEnvStore() {
  const cands = [path.resolve(here, '../../vitest-guard/src/envstore.mjs')];
  const req = createRequire(import.meta.url);
  for (const spec of ['@jirikral/vitest-guard/envstore', 'vitest-guard/envstore']) { try { cands.push(req.resolve(spec)); } catch {} }
  for (const f of cands) {
    try { if (!fs.existsSync(f)) continue; const m = await import(pathToFileURL(f).href); if (typeof m.updateEnv === 'function') return m; } catch {}
  }
  return null;
}
let store = await loadEnvStore();
export function _setEnvStore(s) { store = s; }
export const envStoreAvailable = () => !!store;

/** cls: Map<absFile, {group, source, env, dom}> → entries keyed by root-relative path */
export function toEntries(cls, relOf) {
  const out = {};
  for (const [f, c] of cls) out[relOf(f)] = { group: c.group, source: c.source, env: c.env ?? null, dom: c.dom ?? null };
  return out;
}

/** Hand our classification to the owner of env.json. Never throws (classification is an optimisation). */
export function writeEnvJson(root, cls, relOf, { log = () => {} } = {}) {
  const entries = toEntries(cls, relOf);
  try {
    // N5: .vitest-guard/run/ can come from the repository – refuse symlinked directories before anyone writes
    new StateDir(root, '.vitest-guard').dir('run');
    if (store) return store.updateEnv(root, entries, { producer: 'vto-daemon' });
    return fallbackUpdate(root, entries);
  } catch (e) { log(`env.json not updated: ${e.message}`); return null; }
}

const rank = (e) => (!e || typeof e !== 'object' ? 0 : e.source === 'probe' ? (e.miss ? 3 : 2) : e.source === 'static' ? 1 : 0);

/** fallback merge: only ADD entries for unknown files or replace a static guess; measured entries are never touched */
export function fallbackMerge(curFiles, entries, at = new Date().toISOString()) {
  const files = { ...curFiles };
  const changed = [];
  for (const [k, n] of Object.entries(entries)) {
    const cur = files[k];
    if (rank(cur) >= 2) continue;                       // probe / miss of any producer: keep exactly as it is
    if (rank(cur) === 1 && rank(n) < 2 && cur.by && cur.by !== 'vto-daemon') continue; // foreign static guess
    files[k] = { group: n.group, source: n.source, env: n.env ?? null, dom: n.dom ?? null, at, by: 'vto-daemon' };
    changed.push(k);
  }
  return { files, changed };
}

export function fallbackUpdate(root, entries) {
  const sd = new StateDir(root, '.vitest-guard');
  const dir = sd.dir('run');
  const file = path.join(dir, 'env.json');
  const lock = file + '.lock';
  let fd = null;
  for (let i = 0; i < 40 && fd === null; i++) {
    try { fd = openPrivate(lock, 'wx'); fs.writeSync(fd, String(process.pid)); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { const pid = +fs.readFileSync(lock, 'utf8'); stale = !isAlive(pid) || Date.now() - fs.lstatSync(lock).mtimeMs > 30000; } catch {}
      if (stale) { try { fs.unlinkSync(lock); } catch {} } else { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch {} }
    }
  }
  if (fd === null) return { written: false, locked: false, changed: [] }; // somebody holds the lock: skip, never write unlocked
  try {
    let cur = null;
    try { cur = JSON.parse(readPrivate(file).toString('utf8')); } catch {}
    const curFiles = cur && cur.format === ENV_FORMAT && cur.files && typeof cur.files === 'object' && !Array.isArray(cur.files) ? cur.files : {};
    const at = new Date().toISOString();
    const { files, changed } = fallbackMerge(curFiles, entries, at);
    if (changed.length) writePrivate(file, JSON.stringify({ ...(cur && cur.format === ENV_FORMAT ? cur : {}), format: ENV_FORMAT, producer: 'vto-daemon', updatedAt: at, files }, null, 1) + '\n');
    return { written: changed.length > 0, locked: true, changed, files };
  } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
}
