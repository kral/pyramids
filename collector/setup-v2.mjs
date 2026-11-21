// vto v2 collector – Vitest setupFile (prepended to the user's setupFiles by the runner).
// Resets the per-file hit arrays created by plugin.mjs before each test and collects them
// after everything belonging to the test has run (afterEach hooks, beforeEach cleanups,
// fixture teardown, RTL cleanup/unmount, onTestFinished callbacks). Records are buffered and
// written once per test file (afterAll) – see FORMAT.md (v2).
//
// Per test file it also writes a "fileload" record: hits caused by module evaluation (imports,
// collection) and by suite-level hooks (beforeAll/afterAll), plus the instrumented modules loaded.
// Hits found at the next beforeEach that cannot come from suite hooks are late work of the
// previous test → that test is marked "leaky".
import { beforeAll, beforeEach, afterAll, expect } from 'vitest';
import * as vitestApi from 'vitest';
import { createRequire } from 'node:module';
import { threadId } from 'node:worker_threads';
import vm from 'node:vm';
// node:fs is NOT imported statically: in vm pools the context's `node:fs` ESM namespace is a snapshot
// taken on first import – it must be taken after wrapFs() so the test file's named imports see it.
// process.getBuiltinModule: Node >= 20.16 / 22.3; older: createRequire.
const builtin = typeof process.getBuiltinModule === 'function' ? (id) => process.getBuiltinModule(id) : createRequire(import.meta.url);
const fsb = builtin('node:fs'), pathb = builtin('node:path'), urlb = builtin('node:url');
const { appendFileSync, mkdirSync } = fsb;

const G = globalThis;
const reg = G.__vto_reg || (G.__vto_reg = Object.create(null));
const blk = G.__vto_blk || (G.__vto_blk = Object.create(null));
// captured before user code can install fake timers
const realImmediate = G.setImmediate?.bind(G);
const now = () => performance.now();

// ---- root and path identity (contracts/DECISIONS.md D2) ------------------------------------------
// Pure factory (no fs access) so that Windows / case-insensitive / NFD behaviour is testable on any OS:
// collector/test reaches it through __vto_state.makePaths. collector/paths.mjs holds the same rules for
// the main process – this file must stay self-contained (it is copied into the project).
const NONASCII = /[^\x00-\x7f]/;
function makePaths({ root, alts = [], win = false, ci = false, cwd = () => process.cwd(), path = pathb, fileURLToPath = urlb.fileURLToPath }) {
  const P = win ? path.win32 : path.posix;
  const urlOpt = win === (process.platform === 'win32') ? undefined : { windows: win };
  // separators, drive letter, NFC
  const slash = (s) => {
    if (win) {
      if (s.includes('\\')) s = s.split('\\').join('/');
      if (s.startsWith('//?/')) s = s.startsWith('//?/UNC/') ? '//' + s.slice(8) : s.slice(4);
      if (s.charCodeAt(1) === 58 && s.charCodeAt(0) > 96) s = s[0].toUpperCase() + s.slice(1);
    }
    return NONASCII.test(s) ? s.normalize('NFC') : s;
  };
  // canonical root first, then other spellings of the same directory (the raw VTO_ROOT, cwd): test code
  // builds paths from process.cwd() / a subst drive / a symlinked checkout, Vite reports real paths
  const roots = [...new Set([root, ...alts].filter(Boolean).map((r) => slash(r).replace(/\/+$/, '') + '/'))];
  const lower = roots.map((r) => r.toLowerCase());
  const fastOk = !win && !roots.some((r) => NONASCII.test(r));
  /** root-relative key ('' for the root itself) or null when `f` (already slash()-ed) is outside the root */
  const inRoot = (f) => {
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i], n = r.length;
      if (f.length >= n) { if (f.startsWith(r) || (ci && f.slice(0, n).toLowerCase() === lower[i])) return f.slice(n); }
      else if (f.length === n - 1 && (r.startsWith(f) || (ci && lower[i].startsWith(f.toLowerCase())))) return '';
    }
    return null;
  };
  const relCache = new Map();
  /** module / test file path → root-relative key; outside the root: absolute with `/` */
  const rel = (f) => {
    if (!f) return f;
    let r = relCache.get(f);
    if (r === undefined) { const s = slash(f); r = inRoot(s) ?? s; relCache.set(f, r); }
    return r;
  };
  /** like rel(), but null for paths outside the root (module filter) */
  const relIn = (f) => { const r = inRoot(slash(f)); return r === null ? null : r; };
  /** cheap pre-filter for fs paths: true = certainly not a project path (vm pools call fs thousands of times per file) */
  const skip = (p) => {
    if (p.includes('node_modules')) return true;
    if (!fastOk || p.charCodeAt(0) !== 47) return false;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (p.startsWith(r) || (p.length === r.length - 1 && r.startsWith(p)) || (ci && p.slice(0, r.length - 1).toLowerCase() === lower[i].slice(0, -1))) return false;
    }
    return true;
  };
  /** first argument of an fs call (string | Buffer | URL) → root-relative key, or null when not a project path */
  const read = (p) => {
    let f;
    if (typeof p === 'string') { if (skip(p)) return null; f = p; }
    else if (!p || typeof p !== 'object') return null;
    else if (typeof p.href === 'string' && p.protocol === 'file:') f = fileURLToPath(p.href, urlOpt); // never URL.pathname: `/C:/…` on Windows
    else if (typeof p.byteLength === 'number' && typeof p.toString === 'function' && p.constructor?.name === 'Buffer') f = p.toString();
    else return null;
    if (f.startsWith('file:')) { try { f = fileURLToPath(f, urlOpt); } catch {} }
    f = P.isAbsolute(f) ? P.normalize(f) : P.resolve(cwd(), f); // resolves `.` and `..` segments
    f = slash(f);
    if (f.length > 1 && f.endsWith('/')) f = f.replace(/\/+$/, '');
    const r = inRoot(f);
    if (r === null || r.includes('node_modules/') || r.startsWith('.vto-tmp/') || r.startsWith('.vto/')) return null;
    return r || '.';
  };
  /** static directory prefix of a glob pattern (`src/**` + `/*.ts` → `src`), resolved against `base` */
  const globBase = (pattern, base) => {
    if (typeof pattern !== 'string') return null;
    const segs = pattern.split(win ? /[\\/]/ : '/');
    let n = 0;
    while (n < segs.length && !/[*?[\]{}()!]/.test(segs[n])) n++;
    const stat = segs.slice(0, n).join('/') || '.';
    let b = base;
    if (b && typeof b === 'object' && typeof b.href === 'string') { try { b = fileURLToPath(b.href, urlOpt); } catch { b = null; } }
    return P.isAbsolute(stat) ? stat : P.resolve(typeof b === 'string' ? P.resolve(cwd(), b) : cwd(), stat);
  };
  return { root: roots[0], roots, rel, relIn, read, globBase, slash, ci, win };
}

// D2.4: case-insensitivity is probed per root (flip the case of an existing name, same file?), not assumed
function probeCaseInsensitive(root) {
  const fallback = /^[A-Za-z]:|^[\\/]{2}/.test(root);
  const flip = (s) => { const u = s.toUpperCase(); return u !== s ? u : s.toLowerCase(); };
  try {
    let name = pathb.basename(root), dir = pathb.dirname(root);
    if (!name || flip(name) === name) {
      dir = root;
      name = ['package.json', ...fsb.readdirSync(root)].find((n) => flip(n) !== n && fsb.existsSync(pathb.join(root, n)));
      if (!name) return fallback;
    }
    const a = fsb.statSync(pathb.join(dir, name));
    let b;
    try { b = fsb.statSync(pathb.join(dir, flip(name))); } catch { return false; }
    return process.platform === 'win32' ? true : a.dev === b.dev && a.ino === b.ino;
  } catch { return fallback; }
}

function collect() {
  let hits = null;
  for (const k in reg) {
    const a = reg[k];
    let i = a.indexOf(1);
    if (i === -1) continue;
    const ids = [];
    while (i !== -1) { ids.push(i); i = a.indexOf(1, i + 1); }
    (hits ??= {})[k] = ids;
  }
  return hits;
}
function reset() { for (const k in reg) reg[k].fill(0); }
function merge(into, hits) {
  for (const k in hits) into[k] = into[k] ? [...new Set([...into[k], ...hits[k]])].sort((a, b) => a - b) : hits[k];
}

// Per-worker state lives in the worker's OUTER realm: in vm pools (vmThreads/vmForks) every test file
// gets a fresh vm context (fresh globalThis) but the same process – keeping state on the context's
// globalThis would register one exit hook per file and retain every file's context. The state holds
// no per-file objects after a file finished (S.cur is released).
let OUTER = G;
try { OUTER = vm.runInThisContext('globalThis'); } catch {}
const S = OUTER.__vto_state || (OUTER.__vto_state = (() => {
  const dir = process.env.VTO_RAW_DIR;
  if (!dir) throw new Error('vto: VTO_RAW_DIR is not set (run through vitest-overlap)');
  mkdirSync(dir, { recursive: true });
  const run = process.env.VTO_RUN_ID || Math.random().toString(36).slice(2, 10);
  const st = { out: `${dir}/w-${run}-${process.pid}-${threadId}.jsonl`, pending: new Map(), active: new Set(), warned: false, emitted: new Map(), cur: null, makePaths };
  // canonical root (D2.1): realpath of VTO_ROOT / cwd; the given spelling and cwd stay accepted as aliases
  const given = process.env.VTO_ROOT || process.cwd();
  let canon = given;
  try { canon = fsb.realpathSync.native(given); } catch {}
  const env = process.env.VTO_CASE_INSENSITIVE;
  const ci = env === '1' ? true : env === '0' ? false : probeCaseInsensitive(canon);
  st.paths = makePaths({ root: canon, alts: [given, process.cwd()], win: process.platform === 'win32', ci });
  // finishes a file whose afterAll never ran (import error, bail, worker shutdown) – best effort
  st.flush = () => { const c = st.cur; if (c && !c.done) { try { c.finish(true); } catch {} } };
  process.on('exit', () => st.flush()); // safety net (not reached when the pool kills the worker with a signal)
  return st;
})());
const PATHS = S.paths, rel = PATHS.rel;
const relHits = (h) => { const o = {}; for (const k in h) o[rel(k)] = h[k]; return o; };

function finalize(r) {
  const t = r.task, state = t.result?.state;
  return {
    t: 'test', file: rel(t.file?.filepath), name: r.name, line: t.location?.line ?? null,
    state: state === 'fail' ? 'fail' : 'pass', durationMs: r.durationMs, assertions: r.assertions,
    ...(r.tainted ? { tainted: true } : {}), ...(r.leaky ? { leaky: true } : {}),
    ...(r.assertHash ? { assertHash: r.assertHash } : {}), ...(r.domHash ? { domHash: r.domHash } : {}), hits: r.hits ? relHits(r.hits) : {},
  };
}

function fullName(task) {
  const names = [task.name];
  for (let s = task.suite; s && s !== task.file && s.name; s = s.suite) names.unshift(s.name);
  return names.join(' > ');
}

// ---- files/dirs read through node:fs (fileload.reads) -------------------------------------------
// Tests that read project files (guards over src/, CSS/JSON fixtures, snapshots of directory listings)
// depend on those files without importing them. The real `fs` builtin is shared by all vm contexts of
// the worker, so it is wrapped once per worker; reads are attributed to the test file currently
// running (S.cur.reads). Every entry point that takes a PATH is wrapped: fd / FileHandle / stream reads
// are covered by their `open`, copies by their source, globs by the static directory of the pattern.
// Libraries that call through `fs` at call time or copy its functions after the wrap (graceful-fs,
// fs-extra, fast-glob, tinyglobby) are covered; a graceful-fs loaded before vto is reported as
// readsComplete:false.
const PATH_FIRST = ['readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync', 'opendirSync', 'accessSync',
  'readFile', 'readdir', 'stat', 'lstat', 'opendir', 'access', 'exists', 'createReadStream',
  'openSync', 'open', 'openAsBlob', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'readlinkSync', 'readlink',
  'realpathSync', 'realpath', 'statfsSync', 'statfs', 'watch', 'watchFile'];
const PATH_FIRST_PROMISES = ['readFile', 'readdir', 'stat', 'lstat', 'opendir', 'access', 'open', 'copyFile', 'cp', 'readlink', 'realpath', 'statfs', 'watch'];
function wrapFs() {
  if (S.fsWrapped) return;
  S.fsWrapped = true;
  const fs = fsb;
  if (fs[Symbol.for('graceful-fs.queue')] !== undefined) S.readsEscaped = 'graceful-fs was loaded before vto';
  const paths = S.paths;
  // listing = the call enumerates a directory (readdir, opendir, cp, glob). The project root itself ('.')
  // is recorded only for those: Node's own glob / resolver code stats every ancestor directory, and a '.'
  // entry means "selected for every change".
  const rec = (p, listing) => {
    const c = S.cur;
    if (!c || !c.reads) return;
    try { const r = paths.read(p); if (r !== null && (r !== '.' || listing === true)) c.reads.add(r); } catch {}
  };
  const recList = (p) => rec(p, true);
  const recGlob = (pattern, opts) => {
    const c = S.cur;
    if (!c || !c.reads) return;
    try {
      const cwd = opts && typeof opts === 'object' ? opts.cwd : undefined;
      for (const pat of Array.isArray(pattern) ? pattern : [pattern]) { const b = paths.globBase(pat, cwd); if (b) rec(b, true); }
    } catch {}
  };
  const wrap = (obj, name, record = rec) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__vto) return;
    const w = record === recGlob
      ? function (p, o, ...rest) { recGlob(p, o); return orig.call(this, p, o, ...rest); }
      : function (p, ...rest) { record(p); return orig.call(this, p, ...rest); };
    Object.defineProperties(w, Object.getOwnPropertyDescriptors(orig)); // keep util.promisify.custom, realpath.native etc.
    Object.defineProperty(w, 'name', { value: orig.name });
    Object.defineProperty(w, '__vto', { value: true });
    try { obj[name] = w; } catch {}
    return w;
  };
  const LISTING = /^(?:readdir|opendir|cp)/;
  for (const n of PATH_FIRST) { const w = wrap(fs, n, LISTING.test(n) ? recList : rec); if (w && typeof w.native === 'function') wrap(w, 'native'); }
  for (const n of PATH_FIRST_PROMISES) wrap(fs.promises, n, LISTING.test(n) ? recList : rec);
  wrap(fs, 'globSync', recGlob); wrap(fs, 'glob', recGlob); wrap(fs.promises, 'glob', recGlob);
  S.fsOk = fs.readFileSync.__vto === true && fs.openSync.__vto === true && fs.promises?.open?.__vto === true;
}

// ---- child processes and worker threads ----------------------------------------------------------
// Their file reads are invisible to the fs wrappers of this worker. Record that the test file used
// them (fileload.spawnsProcesses / usesWorkers, readsComplete:false) so that selection can fall back to
// "select this file for every change".
function wrapProc() {
  if (S.procWrapped) return;
  S.procWrapped = true;
  const flagger = (key) => () => { const c = S.cur; if (c) c[key] = true; };
  const wrap = (obj, name, flag) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function' || orig.__vto) return;
    const w = function (...args) { flag(); return orig.apply(this, args); };
    Object.defineProperties(w, Object.getOwnPropertyDescriptors(orig));
    Object.defineProperty(w, 'name', { value: orig.name });
    Object.defineProperty(w, '__vto', { value: true });
    try { obj[name] = w; } catch {}
  };
  try {
    const cp = builtin('node:child_process'), spawns = flagger('spawns');
    for (const n of ['spawnSync', 'execSync', 'execFileSync']) wrap(cp, n, spawns);
    wrap(cp.ChildProcess?.prototype, 'spawn', spawns); // spawn, exec, execFile, fork (and execa, cross-spawn, tinyexec…)
  } catch {}
  try {
    const wt = builtin('node:worker_threads'), workers = flagger('workers'), W = wt.Worker;
    if (typeof W === 'function' && !W.__vto) {
      const PW = new Proxy(W, { construct(t, args, nt) { workers(); return Reflect.construct(t, args, nt === PW ? t : nt); }, get(t, k, r) { return k === '__vto' ? true : Reflect.get(t, k, r); } });
      wt.Worker = PW;
    }
  } catch {}
}

// ---- per test file --------------------------------------------------------------------------
// The setup file is evaluated before the test file is imported: anything hit now belongs to an
// earlier file in this worker (isolate:false) – drop it so import-time hits start clean.
S.flush(); // a previous file of this worker whose afterAll never ran
reset();
const TRACK_READS = process.env.VTO_READS !== '0'; // VTO_READS=0: don't record fs reads (no `reads` field at all)
if (TRACK_READS) wrapFs();
wrapProc();
try { builtin('node:module').syncBuiltinESMExports(); } catch {} // named ESM imports see the wrappers
// vm pools keep a per-context snapshot of builtin ESM namespaces (taken when `vitest` was imported):
// Vitest's own sync refreshes them, so the test file's `import { readFileSync } from 'node:fs'` sees the wrapper
try { G.__vitest_required__?.syncBuiltinESMExports?.(); } catch {}
// does test code really get the wrappers? (K5: if the re-sync ever stops working, `reads` would be silently
// empty – then no `reads` field is written and the analyzer falls back to its source heuristics)
let readsVisible = false;
if (TRACK_READS && S.fsOk) {
  try { const ns = await import('node:fs'); readsVisible = ns.readFileSync?.__vto === true && ns.default?.openSync?.__vto === true; } catch {}
}
const fh = G.__vto_fh || (G.__vto_fh = Object.create(null));
let fileTask = null; // the RunnerTestFile being collected (Vitest >= 5 exports TestRunner; else taken from the hooks)
try { fileTask = vitestApi.TestRunner?.getCurrentSuite?.()?.file ?? null; } catch {}
let testPath = fileTask?.filepath ?? null;
if (!testPath) { try { testPath = (G[Symbol.for('expect-global')] ?? expect).getState().testPath ?? null; } catch {} }
let last = null;     // record of the previous test in this file
let fileLoad = null; // set by beforeAll: { hits } of import time + suite hooks

const cur = S.cur = {
  done: false, reads: readsVisible ? new Set() : null, spawns: false, workers: false,
  mods: new Set(), seen: new Set(), modulesComplete: true,
  finish: finishFile,
};

// Modules of this test file: instrumented modules (registry) plus every other project module the module
// runner evaluated (barrels, JSON, CSS, ?raw, svg, files with `vto-ignore-file`). Called after
// collection AND at the end of the file: `await import()`, lazy routes, vi.resetModules() + re-import
// and imports inside tests / hooks load modules long after the first beforeAll (vi.resetModules() keeps
// the runner's file → module map, so the final snapshot is complete).
function snapshotModules() {
  const { mods, seen } = cur;
  for (const k in reg) mods.add(k);
  let files = null;
  try { files = G.__vitest_worker__?.evaluatedModules?.fileToModulesMap?.keys?.() ?? null; } catch {}
  if (!files) { cur.modulesComplete = false; return; }
  for (let f of files) {
    if (typeof f !== 'string' || seen.has(f)) continue;
    seen.add(f);
    if (f.includes('/node_modules/')) continue;
    const q = f.indexOf('?');
    if (q !== -1) f = f.slice(0, q);
    if (f === testPath || mods.has(f)) continue;
    const r = PATHS.relIn(f);
    if (r === null || r === '' || r.startsWith('.vto-tmp/') || r.startsWith('.vto/setup/') || r === rel(testPath)) continue;
    mods.add(f);
  }
}

function finishFile(partial) {
  if (cur.done) return;
  cur.done = true;
  if (S.cur === cur) S.cur = null; // release this file's context
  // every test skipped at collection: no hook ran. Nothing is written here – the runner records the
  // skipped tests (run-raw.mjs writeUnrun), and a test file without a fileload record means "coverage unknown"
  if (partial === true && (fileTask?.mode === 'skip' || fileTask?.mode === 'todo')) { S.pending.clear(); S.active.clear(); return; }
  snapshotModules();
  const testFile = rel(testPath ?? fileTask?.filepath ?? null);
  let lines = '';
  const fileRec = (f) => {
    const b = blk[f];
    if (b !== undefined && S.emitted.get(f) !== b) {
      S.emitted.set(f, b);
      lines += `{"t":"file","file":${JSON.stringify(rel(f))},${fh[f] ? `"sha256":"${fh[f]}",` : ''}"blocks":${b}}\n`;
    }
  };
  for (const f of cur.mods) fileRec(f);
  for (const r of S.pending.values()) if (r.hits) for (const f in r.hits) fileRec(f);
  // tests that have no record: skipped at collection (.skip / skipIf / runIf / -t filter / .only elsewhere),
  // todo, or never started (a beforeAll threw, bail). Written as hit-less records so that selection knows them.
  let error = partial === true && fileTask?.result?.state !== 'skip' && fileTask?.mode !== 'skip';
  const notRun = [];
  const walk = (suite) => {
    for (const t of suite.tasks ?? []) {
      if (t.type === 'suite') { if (t.result?.errors?.length) error = true; walk(t); }
      else if (t.type === 'test' && !S.pending.has(t.id)) {
        if (t.mode === 'run' || t.mode === 'queued') error = true; // should have run
        notRun.push({ t: 'test', file: testFile, name: t.fullTestName ?? fullName(t), line: t.location?.line ?? null, state: t.mode === 'todo' ? 'todo' : 'skip', hits: {} });
      }
    }
  };
  if (fileTask) { try { if (fileTask.result?.errors?.length) error = true; walk(fileTask); } catch {} }
  if (testFile) {
    const lt = G.__vto_lt || {}, loadMs = {}, modules = [];
    const seenRel = new Set();
    for (const m of cur.mods) {
      const r = rel(m);
      if (seenRel.has(r)) continue;
      seenRel.add(r); modules.push(r);
      if (lt[m] !== undefined) loadMs[r] = Math.round(lt[m] * 1000) / 1000;
    }
    const escaped = cur.spawns || cur.workers || !!S.readsEscaped;
    lines += JSON.stringify({
      t: 'fileload', testFile, hits: relHits(fileLoad?.hits ?? collect() ?? {}), modules, loadMs,
      ...(cur.reads ? { reads: [...cur.reads].sort() } : {}),
      ...(escaped ? { readsComplete: false } : cur.reads ? { readsComplete: true } : {}),
      ...(cur.spawns ? { spawnsProcesses: true } : {}), ...(cur.workers ? { usesWorkers: true } : {}),
      ...(cur.modulesComplete ? {} : { modulesComplete: false }),
      ...(error ? { error: true } : {}),
    }) + '\n';
  }
  for (const r of S.pending.values()) lines += JSON.stringify(finalize(r)) + '\n';
  for (const r of notRun) lines += JSON.stringify(r) + '\n';
  S.pending.clear();
  S.active.clear();
  if (lines) appendFileSync(S.out, lines, { mode: 0o600 });
}

// --async-timeout: raise RTL's asyncUtilTimeout (findBy*/waitFor) – collection is slower than a plain run.
// Applied in a beforeAll, i.e. after every setup file (the user's own configure() would otherwise win).
const ASYNC_TIMEOUT = Number(process.env.VTO_ASYNC_TIMEOUT) || 0;
if (ASYNC_TIMEOUT) beforeAll(async () => {
  try { (await import('@testing-library/dom')).configure({ asyncUtilTimeout: ASYNC_TIMEOUT }); } catch {}
});

beforeAll(({}, suite) => {
  // runs after collection (all imports evaluated), before the user's beforeAll hooks
  if (!fileTask && suite?.type === 'suite' && suite.filepath) fileTask = suite;
  if (!testPath) testPath = fileTask?.filepath ?? null;
  snapshotModules();
  fileLoad = { hits: collect() ?? {} };
  reset();
});

beforeEach((ctx) => {
  const task = ctx.task;
  if (!fileTask) fileTask = task.file ?? null;
  if (!testPath) testPath = task.file?.filepath ?? null;
  // collect before reset: hits since the previous test was collected
  const between = collect();
  if (between) {
    if (last && last.task.suite === task.suite && S.pending.get(last.task.id) === last) last.leaky = true; // late async work of the previous test
    else if (fileLoad) merge(fileLoad.hits, between);                                                     // suite beforeAll/afterAll hooks
  }
  // concurrency taint: every test overlapping in time with another one
  for (const r of S.active) if (r.task.result && r.task.result.state !== 'run') S.active.delete(r); // stale (finish callback never ran)
  const rec = { task, name: task.fullTestName ?? fullName(task), durationMs: null, assertions: null, hits: null, tainted: false };
  if (S.active.size) {
    rec.tainted = true;
    for (const r of S.active) r.tainted = true;
    if (!S.warned) { S.warned = true; console.warn('[vto] concurrent tests detected – per-test attribution is unreliable (maxConcurrency should be 1)'); }
  }
  S.active.add(rec);
  reset();
  const t0 = now();
  // onTestFinished callbacks run in 'stack' order after afterEach hooks and fixture cleanups:
  // registered first (our setup file is first) → runs last.
  ctx.onTestFinished(async () => {
    // let pending effect flushes settle (React scheduler macrotasks) – only DOM environments render
    if (realImmediate && G.document !== undefined) await new Promise((r) => realImmediate(r));
    rec.durationMs = Math.round((now() - t0) * 1000) / 1000;
    try { rec.assertions = (ctx._local ? ctx.expect : (G[Symbol.for('expect-global')] ?? expect)).getState().assertionCalls ?? null; } catch {}
    rec.hits = collect();
    reset();
    const sig = G.__vto_signals?.get(task.id);
    if (sig) { rec.assertHash = sig.assertHash; rec.domHash = sig.domHash; G.__vto_signals.delete(task.id); }
    S.active.delete(rec);
    S.pending.set(task.id, rec); // retries/repeats: the last attempt wins
    last = rec;
  });
});

afterAll(() => {
  if (process.env.VTO_HEAP_LOG) { // diagnostics: heap after each test file (with --expose-gc: after a full GC)
    try { (OUTER.gc || G.gc)?.(); } catch {}
    appendFileSync(process.env.VTO_HEAP_LOG, `${process.pid}-${threadId} ${process.memoryUsage().heapUsed} ${process.listenerCount('exit')}\n`);
  }
  // runs last among afterAll hooks: hits since the last test = suite afterAll hooks (or leaks)
  const tail = collect();
  if (tail && fileLoad) merge(fileLoad.hits, tail);
  reset();
  finishFile(false);
});
