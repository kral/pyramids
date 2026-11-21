// The ONE reader/writer of `.vitest-guard/run/env.json` (format `vto-env/1`): which test files touch the DOM.
//
// Producers: vitest-guard `mode: 'auto'` (setup probe, DOM-miss detector) and the vto daemon (collector env probe,
// static guesses). Before this module each had its own read-modify-write with different rules and no lock
// (REVIEW-2-architecture N4/A-6, REVIEW-2-security N9): the daemon erased vitest-guard's sticky DOM-miss evidence
// and concurrent config loads lost updates. Every writer MUST go through `updateEnv()` (or `foldEnvRecords()`).
//
// No dependency on Vitest or on the rest of vitest-guard: safe to import from the daemon
// (`import { updateEnv } from '@jirikral/vitest-guard/envstore'` or by path `vitest-guard/src/envstore.mjs`).
//
// ---------------------------------------------------------------------------------------------------------
// Document:  { format: 'vto-env/1', producer, updatedAt, files: { <root-relative path, '/'>: Entry } }
// Entry:     { group: 'dom'|'node', source: 'probe'|'static', env: string|null, dom: boolean|null, at: ISO,
//              by?: producer, miss?: { key }, via?: string, …unknown fields are kept }
//
// Precedence (`mergeEnvEntry(cur, next)`), strongest first – a weaker record NEVER replaces a stronger one:
//   3  miss    probe entry with `miss: { key }`: the file FAILED in the node group after touching a DOM global.
//              Sticky: only another miss replaces it (refreshing key/at). Nothing can turn it back into node.
//   2  probe   measured at run time (`source: 'probe'`). probe vs probe: the newer one wins, EXCEPT that
//              `dom: true` is sticky – a later run that happened not to touch the DOM (dom false/null) does not
//              downgrade it (the entry is kept as it was).
//   1  static  a guess from the source text (`source: 'static'`). Replaces only another static entry.
//   0  (none / invalid)
// Entries of other files are never touched; unknown extension fields of the winning record are preserved.
// To forget evidence on purpose (file deleted, user reset) use `removeEnvEntries()`.
// ---------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ENV_FORMAT = 'vto-env/1';
/** Environments that provide a DOM in a Node worker (the daemon's extra 'browser' is not a vitest-guard pool). */
export const DOM_ENVS = new Set(['jsdom', 'happy-dom']);

export const envStateDir = (root) => path.join(root, '.vitest-guard', 'run');
export const envFilePath = (root) => path.join(envStateDir(root), 'env.json');

/** 3 = DOM miss, 2 = probe, 1 = static, 0 = none/invalid. */
export function envRank(e) {
  if (!e || typeof e !== 'object') return 0;
  if (e.source === 'probe') return e.miss && typeof e.miss === 'object' ? 3 : 2;
  return e.source === 'static' ? 1 : 0;
}

/** Path keys: root-relative, '/' separators, normalized, NFC (contracts/DECISIONS.md D2). null = not acceptable. */
export function envKey(root, file) {
  if (typeof file !== 'string' || !file || file.length > 1024 || /[\0-\x1f\x7f]/.test(file)) return null;
  let f = file;
  if (path.isAbsolute(f)) f = path.relative(root, f);
  f = f.split(path.sep).join('/').replace(/\\/g, '/').replace(/^(\.\/)+/, '').normalize('NFC');
  if (!f || f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return f;
}

/** A well-formed entry or null (N9: the file is repo-reachable data, nothing in it is trusted). */
export function normalizeEnvEntry(rec, { producer, at } = {}) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (rec.source !== 'probe' && rec.source !== 'static') return null;
  const dom = typeof rec.dom === 'boolean' ? rec.dom : null;
  const env = typeof rec.env === 'string' && rec.env.length <= 100 ? rec.env : null;
  let group = rec.group === 'dom' || rec.group === 'node' ? rec.group : null;
  const miss = rec.source === 'probe' && rec.miss && typeof rec.miss === 'object' ? { key: String(rec.miss.key ?? '').slice(0, 100) } : undefined;
  if (miss) group = 'dom';
  if (!group) group = dom === true && (!env || DOM_ENVS.has(env)) ? 'dom' : dom === false || (env && !DOM_ENVS.has(env)) ? 'node' : null;
  if (!group) return null;
  const { group: _g, source: _s, env: _e, dom: _d, miss: _m, at: _a, by: _b, ...rest } = rec;
  const out = { ...rest, group, source: rec.source, env, dom: miss ? true : dom, ...(miss ? { miss } : {}), at: typeof rec.at === 'string' ? rec.at : at || new Date().toISOString() };
  const by = typeof rec.by === 'string' ? rec.by : producer;
  if (by) out.by = String(by).slice(0, 60);
  return out;
}

/**
 * Pure precedence rule. `cur` = stored entry (or undefined), `next` = normalized new record.
 * @returns the entry to store (identity `cur` when nothing changes)
 */
export function mergeEnvEntry(cur, next) {
  const rc = envRank(cur), rn = envRank(next);
  if (!rn) return cur;
  if (!rc) return next;
  if (rn < rc) return cur; // static never replaces a measurement; nothing but a miss replaces a miss
  if (rn === 2 && rc === 2 && cur.dom === true && next.dom !== true) return cur; // touched the DOM once: stays dom
  return next;
}

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t); } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The state directory, created; null when `.vitest-guard` or `.vitest-guard/run` is a symlink (never write through it). */
function safeStateDir(root) {
  const dir = envStateDir(root);
  if (isSymlink(path.dirname(dir)) || isSymlink(dir)) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# vitest-guard volatile state (logs, plan, caches, durations): never commit\n*\n');
  } catch { return null; }
  return dir;
}

/**
 * Run `fn` while holding `.vitest-guard/run/env.json.lock` (O_EXCL lock file with pid + time).
 * A lock is stale when its holder process is gone (same machine) and it is older than 2 s, or when it is older
 * than `staleMs` (default 30 s) whatever the holder. After `timeoutMs` (default 3 s) without the lock, `fn` still
 * runs (`locked: false`): the write is atomic, so the worst case is the pre-lock behaviour (a lost update), never
 * a torn file and never a blocked test run.
 * @returns {{ locked: boolean, value: any }}
 */
export function withEnvLock(root, fn, { timeoutMs = 3000, staleMs = 30000 } = {}) {
  const dir = safeStateDir(root);
  if (!dir) return { locked: false, value: fn(false) };
  const lock = path.join(dir, 'env.json.lock');
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); held = true; break; } catch (e) {
      // Windows: a lock file that another process is deleting is briefly "delete pending" → EPERM/EACCES
      const busy = e.code === 'EEXIST' || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
      if (!busy) break;
    }
    try {
      const st = fs.lstatSync(lock);
      const age = Date.now() - st.mtimeMs;
      const pid = Number(String(fs.readFileSync(lock, 'utf8')).split(':')[0]);
      if (age > staleMs || (age > 2000 && Number.isInteger(pid) && pid > 0 && !pidAlive(pid))) {
        // take over: remove only the very lock we judged stale (same inode + mtime), then race for a fresh one
        const again = fs.lstatSync(lock);
        if (again.ino === st.ino && again.mtimeMs === st.mtimeMs) fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {}
    if (Date.now() >= deadline) break;
    sleepMs(Math.min(50, 2 + i * 3) + Math.floor(Math.random() * 5));
  }
  try { return { locked: held, value: fn(held) }; }
  finally { if (held) { try { if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true }); } catch {} } }
}

/** Read env.json: `{ files, producer, updatedAt }` with validated entries (legacy vitest-guard layout is converted). */
export function readEnv(root) {
  let doc = null;
  try {
    const f = envFilePath(root);
    if (!isSymlink(f) && fs.statSync(f).size < 64 << 20) doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  const files = {};
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    if (doc.format === ENV_FORMAT && doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files)) {
      for (const [k, v] of Object.entries(doc.files)) { const key = envKey(root, k), e = normalizeEnvEntry(v); if (key && e) files[key] = e; }
    } else if (!doc.format) {
      // vitest-guard pre-vto-env layout { <path>: { dom, source: 'probe'|'miss', key? } }
      for (const [k, v] of Object.entries(doc)) {
        if (!v || typeof v.dom !== 'boolean') continue;
        const key = envKey(root, k), e = normalizeEnvEntry({ source: 'probe', dom: v.dom, group: v.dom ? 'dom' : 'node', ...(v.source === 'miss' ? { miss: { key: v.key } } : {}), by: 'vitest-guard' });
        if (key && e) files[key] = e;
      }
    }
  }
  return { files, producer: typeof doc?.producer === 'string' ? doc.producer : null, updatedAt: typeof doc?.updatedAt === 'string' ? doc.updatedAt : null };
}

// Windows: replacing a file that another process has open (a concurrent reader) fails with
// EPERM/EBUSY/EACCES for a short moment; retry briefly instead of losing the write.
function renameWithRetry(from, to) {
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 40) throw e;
      sleep(Math.min(5 + attempt * 5, 50));
    }
  }
}

function writeEnv(root, files, producer, at) {
  const dir = safeStateDir(root);
  if (!dir) return false;
  const file = path.join(dir, 'env.json');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
    // 'wx': never follows a planted symlink; rename replaces env.json itself (also when that is a symlink)
    fs.writeFileSync(tmp, JSON.stringify({ format: ENV_FORMAT, producer, updatedAt: at, files: sorted }, null, 1) + '\n', { flag: 'wx', mode: 0o644 });
    renameWithRetry(tmp, file);
    return true;
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} return false; }
}

const entriesOf = (entries) => (entries instanceof Map ? [...entries] : Array.isArray(entries) ? entries.map((e) => (Array.isArray(e) ? e : [e?.file, e])) : Object.entries(entries || {}));

/**
 * Merge records into env.json under the lock (read → mergeEnvEntry per file → atomic replace).
 * @param {string} root project root
 * @param {Record<string, object> | Map<string, object> | Array<[string, object] | (object & {file: string})>} entries
 *        key = test file (root-relative or absolute), value = { source: 'probe'|'static', group?, env?, dom?, miss?, via?, … }
 * @param {{ producer?: string, remove?: string[], write?: boolean, lock?: object }} [o]
 *        producer: stamped as `by` on accepted records and as the document's `producer` ('vitest-guard', 'vto-daemon', …)
 *        remove: files whose entry is deleted first (the only way to drop probe/miss evidence)
 * @returns {{ files: Record<string, object>, changed: string[], rejected: string[], written: boolean, locked: boolean }}
 *          files = the merged view (what was written, or what would have been when the write failed)
 */
export function updateEnv(root, entries, { producer = 'vitest-guard', remove = [], write = true, lock } = {}) {
  const at = new Date().toISOString();
  const list = entriesOf(entries);
  let out;
  const run = (locked) => {
    const { files } = readEnv(root);
    const changed = [], rejected = [];
    for (const f of remove) { const k = envKey(root, f); if (k && files[k]) { delete files[k]; changed.push(k); } }
    for (const [file, rec] of list) {
      const key = envKey(root, file), next = normalizeEnvEntry(rec && typeof rec === 'object' ? (({ file: _f, ...r }) => r)(rec) : rec, { producer, at });
      if (!key || !next) { rejected.push(String(file)); continue; }
      const merged = mergeEnvEntry(files[key], next);
      if (merged !== files[key]) { files[key] = merged; if (!changed.includes(key)) changed.push(key); }
    }
    const written = write && changed.length ? writeEnv(root, files, producer, at) : false;
    out = { files, changed, rejected, written, locked };
  };
  if (!list.length && !remove.length) run(false); // pure read: no lock needed (the file is replaced atomically)
  else withEnvLock(root, run, lock);
  return out;
}

/** Delete entries on purpose (deleted test files, `vitest-guard` reset). */
export const removeEnvEntries = (root, files, o = {}) => updateEnv(root, {}, { ...o, remove: files });

/**
 * Fold the per-worker probe records (`.vitest-guard/run/env-<pid>-<tid>.jsonl`, written by vitest-guard's setup) and the
 * vto collector's raw env records (`.vto/raw/<lane>/env-*.jsonl`) into env.json, then delete the folded
 * per-worker files (never env.json, never vto's files). Called at config time by `mode: 'auto'`.
 * @returns {Record<string, object>} merged entries
 */
export function foldEnvRecords(root, { producer = 'vitest-guard' } = {}) {
  const stateDir = envStateDir(root);
  const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const recs = [], done = [];
  // vto collector raw env records: weakest of the probes here (applied first, so own probes of this run win ties)
  try {
    const vtoRaw = path.join(root, '.vto', 'raw');
    for (const lane of fs.readdirSync(vtoRaw)) for (const n of fs.readdirSync(path.join(vtoRaw, lane))) {
      if (!/^env-.*\.jsonl$/.test(n)) continue;
      for (const r of lines(path.join(vtoRaw, lane, n))) if (r.t === 'env' && typeof r.dom === 'boolean' && r.testFile) recs.push([r.testFile, { group: r.dom && DOM_ENVS.has(r.env) ? 'dom' : 'node', source: 'probe', env: r.env ?? null, dom: r.dom, by: 'vto' }, true]);
    }
  } catch {}
  try {
    for (const n of fs.readdirSync(stateDir)) {
      if (!/^env-.*\.jsonl$/.test(n)) continue;
      const p = path.join(stateDir, n);
      if (isSymlink(p)) continue;
      for (const r of lines(p)) {
        if (r.t === 'env' && typeof r.dom === 'boolean') recs.push([r.file, { group: r.dom && (!r.env || DOM_ENVS.has(r.env)) ? 'dom' : 'node', source: 'probe', env: r.env ?? null, dom: r.dom, by: 'vitest-guard', ...(r.via ? { via: String(r.via).slice(0, 60) } : {}) }]);
        if (r.t === 'env-miss') recs.push([r.file, { group: 'dom', source: 'probe', env: r.env ?? null, dom: true, miss: { key: r.key }, by: 'vitest-guard' }]);
      }
      done.push(p);
    }
  } catch {}
  if (!recs.length) return readEnv(root).files;
  // vto raw records only fill gaps (the daemon folds them with its own rules too); own records use the full precedence
  const cur = readEnv(root).files;
  const list = recs.filter(([f, , onlyNew]) => !onlyNew || !cur[envKey(root, f) ?? '']).map(([f, r]) => [f, r]);
  const res = updateEnv(root, list, { producer });
  if (res.written || !res.changed.length) for (const p of done) { try { fs.rmSync(p); } catch {} }
  return res.files;
}
