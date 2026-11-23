// vitest-guard setup file. Put it FIRST in `setupFiles` (defineVitestGuardConfig does that).
// Runs once per test file in both fast modes:
//   mode 'vm'     (vmThreads): realm shims, missing globals, outer-realm leak detector, env restore
//   mode 'shared' (threads/forks + isolate:false): per-file reset hooks + full leak detector
//   mode 'isolated' (forks quarantine / nightly): only records timing + heap (for the planner)
import { beforeAll, afterAll, expect, vi, inject } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { getOuterGlobal, installHasInstanceShims, installMissingGlobals, createRealmEqualityTester, DOM_KEYS } from './realm.mjs';
import * as fp from './fingerprint.mjs';
import * as sfs from './statefs.mjs';
import * as safety from './safety.mjs';

const T0 = performance.now(); // self-time accounting (logged as selfMs per file)
const PROF = process.env.VITEST_GUARD_PROFILE ? {} : null;
const sect = (name, t) => { if (PROF) PROF[name] = (PROF[name] || 0) + performance.now() - t; };
const W = Symbol.for('vitest-guard.worker');
// F12: the worker store is a non-writable, non-configurable property: a test file can no longer swap it for a
// fresh object to erase the baseline (it can still mutate fields; the realms are not a security boundary)
if (!Object.prototype.hasOwnProperty.call(process, W)) Object.defineProperty(process, W, { value: { seq: 0, prev: null, base: null, roots: new Set(), listeners: [], intervals: new Map(), patched: false, react: null, out: null }, writable: false, configurable: false, enumerable: false });
const worker = process[W];
worker.testers ??= new Map(); // R2: equality tester -> 'lib' | 'file' | 'project' (who registered it)
worker.extNow = null; // set by setup-tail.mjs (last setup file) through worker.afterSetup
worker.pre = null; // S4: shared mode with the tail: state after this file's setup files, before its own code (afterSetup)

let opts = {};
try { opts = inject('vitestGuard') || {}; } catch {}
const outer = (worker.outer ??= getOuterGlobal()); // worker store lives in the outer realm, so this is compiled once per worker
// S4: the outer realm (process.env, process listeners, builtins) BEFORE the user's setup files and the test file's own
// top-level code ran. This module is the first setup file and runs again for every test file. In vm mode the first
// file's snapshot is the baseline the resets restore (setup files run again per context). In shared mode (R1) the
// baseline is the state AFTER the first file's setup files (the tail hook; without it the first beforeAll): a package
// a setup file imports (`import 'dotenv/config'`) is evaluated once per worker, so what it set must survive the
// resets. There this snapshot only shows what the previous file left behind.
const preOuter = fp.captureOuter();
const inVm = outer !== globalThis;
const mode = opts.mode || (inVm ? 'vm' : 'shared');
const root = opts.root || process.cwd();
const runDir = opts.runDir || path.join(root, '.vitest-guard', 'run', 'logs');
const stateDir = opts.stateDir || path.dirname(runDir);
const onDirty = opts.onDirty || 'warn'; // 'warn' | 'error' | 'silent'
// diagnostics (end-of-file pollution diff, residual after reset, node_modules export-state scan) cost CPU;
// on by default only in runs driven by the vitest-guard CLI (check / run / hunt / verify set VITEST_GUARD_DIAG=1)
const diag = opts.diag ?? process.env.VITEST_GUARD_DIAG === '1';
const moduleState = opts.moduleState ?? diag;
const detectPollution = opts.detectPollution ?? diag;

let autoGroup = null, autoHeal = false;
try { autoGroup = inject('vitestGuardAuto') || null; autoHeal = !!inject('vitestGuardAutoHeal'); } catch {}
const envName = () => { try { return globalThis.__vitest_worker__?.environment?.name ?? globalThis.__vitest_worker__?.ctx?.environment?.name ?? null; } catch { return null; } };

// ---- mode 'auto': DOM probe (dom group) and DOM-miss detector (node group) ----
// Records go to .vitest-guard/run/env-<pid>-<tid>.jsonl; the next config load folds them into env.json and
// re-classifies (a node-group file that touched the DOM moves to the dom group: self-healing).
// state writes never follow a symlink / junction in .vitest-guard/ (security review 3 S2): refused once per worker, with a warning
function stateWrite(fn) {
  if (worker.stateRefused) return;
  try { fn(); } catch (e) {
    if (e?.code !== 'E_UNSAFE_STATE') return;
    worker.stateRefused = true;
    console.warn(`${e.message}; this worker writes no vitest-guard state`);
  }
}
const GITIGNORE = '# vitest-guard volatile state (logs, plan, caches, durations): never commit\n*\n';
function envRecord(rec) {
  stateWrite(() => sfs.appendStateFile(path.join(stateDir, `env-${process.pid}-${threadId}.jsonl`), JSON.stringify(rec) + '\n'));
}
let domTouched = false, domVia = null;
const probeSaved = [];
let probeObserver = null;
function probeRestore() { for (const [k, d] of probeSaved) { try { Object.defineProperty(globalThis, k, d); } catch {} } probeSaved.length = 0; }
if (autoGroup === 'dom' && typeof globalThis.document !== 'undefined') {
  // document mutations first (`document` itself is unforgeable on a vm-pool jsdom window, so it cannot be
  // trapped); created BEFORE the traps so that the probe does not trip its own MutationObserver trap
  try {
    probeObserver = new globalThis.MutationObserver(() => { if (!domTouched) { domTouched = true; domVia = 'document mutation'; } probeObserver.disconnect(); });
    probeObserver.observe(globalThis.document, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch {}
  // getter traps on configurable DOM globals (first access restores them: zero cost afterwards)
  for (const k of DOM_KEYS) {
    const d = Object.getOwnPropertyDescriptor(globalThis, k);
    if (!d || !d.configurable) continue;
    probeSaved.push([k, d]);
    Object.defineProperty(globalThis, k, {
      configurable: true, enumerable: d.enumerable,
      get() { if (!domTouched) { domTouched = true; domVia = k; } probeRestore(); return d.get ? d.get.call(globalThis) : d.value; },
      set(v) { if (!domTouched) { domTouched = true; domVia = k; } probeRestore(); globalThis[k] = v; },
    });
  }
}
// node group: record-only traps on the DOM globals the node environment does not have. A getter returns
// undefined (typeof checks keep working) and remembers the key; only a FAILED file that touched one counts as
// a DOM miss, so library feature detection (`typeof window`) in passing files never moves a file.
const nodeTouched = [];
const nodeTraps = [];
if (autoGroup === 'node' && autoHeal) {
  for (const k of DOM_KEYS) {
    if (k in globalThis) continue;
    try {
      Object.defineProperty(globalThis, k, { configurable: true, enumerable: false,
        get() { if (!nodeTouched.includes(k)) nodeTouched.push(k); return undefined; },
        set(v) { Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true, enumerable: true }); } });
      nodeTraps.push(k);
    } catch {}
  }
}
const DOM_MISS = new RegExp(`\\b(${DOM_KEYS.join('|')}) is not defined\\b`);
function collectErrors(task, out = []) {
  for (const e of task.result?.errors || []) out.push(e);
  for (const t of task.tasks || []) collectErrors(t, out);
  return out;
}

// ---- provenance: who caused a registration (equality tester, interval, global, navigator override) ----
// Note 1 (alpha.3): the decision is the call site in the test file chain, not the registering module's path. Only the
// synchronous part of the stack counts (frames before the first `at async`: an async continuation names who awaited,
// e.g. the test file that imported a package, not who called): a frame of the current test file -> 'file' (a package
// function the test file calls, as in `install()`), else a frame of another project module -> 'project', else a frame
// in node_modules -> 'lib' (a package at import time), else 'unknown'. Vitest's and vitest-guard's own frames and Node
// internals are skipped.
const VITEST_FRAME = /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:vitest|@vitest[\\/][^\\/]+)[\\/]/;
const SELF_PATH = (() => { try { return fileURLToPath(import.meta.url).replace(/\\/g, '/'); } catch { return null; } })();
const normPath = (s) => String(s).replace(/\\/g, '/').replace(/^file:\/\/\/?/, '/');
function whoCalled() {
  const lim = Error.stackTraceLimit;
  let st = '';
  try { Error.stackTraceLimit = 100; st = new Error().stack || ''; } catch {} finally { Error.stackTraceLimit = lim; }
  let cur = null; try { cur = expect.getState().testPath || null; } catch {}
  cur = cur ? normPath(cur) : null;
  let lib = false, project = false;
  for (const f of st.split('\n').slice(1)) {
    if (!/^\s*at /.test(f)) continue;
    if (/^\s*at async /.test(f)) break;
    const n = f.replace(/\\/g, '/');
    if ((SELF_PATH && n.includes(SELF_PATH)) || VITEST_FRAME.test(f) || /\(node:|^\s*at node:|\(<anonymous>\)$|vitest-guard:outer-fingerprint/.test(f) || !/[\\/]/.test(f)) continue;
    if (cur && (n.includes(cur) || n.includes('file://' + cur))) return 'file';
    if (fp.inNodeModules(n)) lib = true; else project = true;
  }
  return project ? 'project' : lib ? 'lib' : 'unknown';
}

// ---- R2: who registered an equality tester (shared mode) ----
// A package in node_modules (evaluated once per worker) that registers one on import keeps it for the whole worker;
// testers registered from the test file chain (also through a package function the file calls) or, with
// resetModules, by a project module that is evaluated again are removed after the file. The registry array's push is
// instrumented (every path - expect.addEqualityTesters, a test context's expect - ends there); remembered by identity.
function patchTesters() {
  const eq = fp.equalityTesters();
  if (!eq || Object.prototype.hasOwnProperty.call(eq, 'push')) return;
  const push = Array.prototype.push;
  try {
    Object.defineProperty(eq, 'push', { configurable: true, writable: true, enumerable: false, value: function (...items) {
      const w = whoCalled();
      const who = w === 'unknown' ? 'project' : w;
      for (const t of items) if (typeof t === 'function') worker.testers.set(t, who);
      return push.apply(this, items);
    } });
  } catch {}
}

// ---- run log (one jsonl per worker) ----
function log(rec) {
  if (opts.log === false) return;
  stateWrite(() => {
    if (!worker.out) {
      sfs.safeDir(runDir);
      sfs.createStateFile(path.join(stateDir, '.gitignore'), GITIGNORE);
      worker.out = path.join(runDir, `w-${process.pid}-${threadId}.jsonl`); }
    sfs.appendStateFile(worker.out, JSON.stringify(rec) + '\n');
  });
}
// R4: the lane this worker runs (the CLI compares the recorded order with the lane's order)
const LANE = process.env.VITEST_GUARD_LANE_FILE ? path.basename(process.env.VITEST_GUARD_LANE_FILE) : undefined;
const rel = (f) => (f ? path.relative(root, f).split(path.sep).join('/') : f);

// ---- (a) realm tolerance (vm only) ----
let tS = performance.now();
if (inVm && opts.realm !== false) {
  installHasInstanceShims(globalThis, outer);
  installMissingGlobals(globalThis, outer);
  expect.addEqualityTesters([createRealmEqualityTester(globalThis, outer)]);
}
sect('top:realm', tS); tS = performance.now();

// ---- duplicate React detector (once per worker) ----
if (opts.react !== false && worker.react === null) {
  worker.react = 'ok';
  try {
    const rq = createRequire(path.join(root, 'package.json'));
    const real = (p) => fs.realpathSync(p);
    const fromRoot = real(rq.resolve('react'));
    const seen = { '<root>': fromRoot };
    // only packages the project itself declares (a nested project must not pick up a parent's node_modules)
    let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
    const reactDeps = ['react-dom', '@testing-library/react', 'react-i18next', '@tanstack/react-query', 'react-redux', '@mui/material', '@emotion/react', 'react-router', 'react-router-dom', 'react-hook-form', 'zustand', 'jotai', ...(opts.reactPackages || [])];
    for (const dep of reactDeps.filter((d) => declared.has(d))) {
      let base; try { base = path.dirname(rq.resolve(dep + '/package.json')); } catch { continue; }
      try { seen[dep] = real(createRequire(path.join(base, 'package.json')).resolve('react')); } catch {}
    }
    const copies = [...new Set(Object.values(seen))];
    if (copies.length > 1) {
      worker.react = 'dup';
      const msg = `[vitest-guard] Duplicate React: ${Object.entries(seen).map(([k, v]) => `${k} -> ${v}`).join('; ')}. ` +
        'Hooks will throw "Invalid hook call". Dedupe the package (npm dedupe / resolve.dedupe: ["react","react-dom"]).';
      worker.reactMsg = msg;
    }
  } catch {}
}
sect('top:react', tS);
if (worker.react === 'dup' && opts.react !== 'warn') throw new Error(worker.reactMsg);

// ---- shared mode: one-time instrumentation of the long-lived realm ----
if (mode === 'shared' && !worker.patched) {
  worker.patched = true;
  patchTesters();
  const track = (target, label) => {
    if (!target || !target.addEventListener) return;
    const add = target.addEventListener, remove = target.removeEventListener;
    target.addEventListener = function (type, fn, o) {
      const st = new Error().stack || '';
      const caller = st.split('\n')[2] || ''; // [0] Error, [1] this wrapper, [2] whoever registered
      const fromLib = fp.inNodeModules(caller); // S12: CJS frames on Windows are C:\…\node_modules\…
      if (!fromLib) worker.listeners.push({ target, label, type, fn, o, file: worker.current });
      return add.call(this, type, fn, o);
    };
    target.removeEventListener = function (type, fn, o) {
      const i = worker.listeners.findIndex((l) => l.target === target && l.type === type && l.fn === fn);
      if (i >= 0) worker.listeners.splice(i, 1);
      return remove.call(this, type, fn, o);
    };
  };
  if (typeof window !== 'undefined') track(window, 'window');
  if (typeof document !== 'undefined') track(document, 'document');
  // S5 (alpha.3): who adds an own property to the global object (`globalThis.x = …`, `window.x = …`, Object.assign,
  // Object.defineProperty) or overrides a navigator property. A plain assignment of a name the global object does not
  // have reaches its prototype chain: a Proxy there sees it (and then defines the property as an ordinary assignment
  // would). Object.defineProperty / defineProperties / Reflect.defineProperty are wrapped (callable Proxies: same
  // name, length and native toString). Only the provenance is recorded here; the resets after the file use it.
  const hasOwn = Object.prototype.hasOwnProperty;
  worker.globalWho = new Map(); worker.navWho = new Map();
  const note = (o, k) => {
    if (typeof k !== 'string') return;
    if (o === globalThis) { if (!hasOwn.call(globalThis, k)) worker.globalWho.set(k, whoCalled()); }
    else if (o === worker.navRef) worker.navWho.set(k, whoCalled());
    else if (o === worker.navProto) worker.navWho.set('prototype.' + k, whoCalled());
  };
  const watched = (o) => o === globalThis || (o != null && (o === worker.navRef || o === worker.navProto));
  try {
    const proto = Object.getPrototypeOf(globalThis);
    if (proto) {
      const px = new Proxy(proto, { set(t, k, v, r) { if (r === globalThis) note(globalThis, k); return Reflect.set(t, k, v, r); } });
      worker.globalTrap = Reflect.setPrototypeOf(globalThis, px);
    }
  } catch {}
  try {
    for (const [owner, name, multi] of [[Object, 'defineProperty', false], [Object, 'defineProperties', true], [Reflect, 'defineProperty', false]]) {
      const orig = owner[name];
      if (typeof orig !== 'function') continue;
      owner[name] = new Proxy(orig, { apply(t, self, args) {
        if (watched(args[0])) { try { if (multi) { for (const k of Reflect.ownKeys(Object(args[1]))) note(args[0], k); } else note(args[0], args[1]); } catch {} }
        return Reflect.apply(t, self, args);
      } });
    }
  } catch {}
  // S5: intervals the test file chain starts (also through a package function it calls; not a package at import)
  // and never clears keep running into the next files; they are cleared at the end of the file that started them (in
  // forks they die with the file's process)
  try {
    const si = globalThis.setInterval, ci = globalThis.clearInterval;
    if (typeof si === 'function' && typeof ci === 'function' && !si.__vitestGuard) {
      const setI = function (...a) {
        const id = si.apply(this, a);
        // Note 1: provenance by the call site in the test file chain (a package function the test file calls counts as the file's)
        const who = whoCalled();
        if (who !== 'lib') worker.intervals.set(id, { file: worker.current, own: who === 'file' });
        return id;
      };
      const clearI = function (id) { worker.intervals.delete(id); return ci.apply(this, arguments); };
      for (const [w, o] of [[setI, si], [clearI, ci]]) { try { for (const k of Reflect.ownKeys(o)) if (!(k in w)) Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(o, k)); } catch {} }
      Object.defineProperty(setI, '__vitestGuard', { value: true });
      worker.clearInterval = ci;
      globalThis.setInterval = setI; globalThis.clearInterval = clearI;
    }
  } catch {}
  try {
    const rq = createRequire(path.join(root, 'package.json'));
    const client = rq('react-dom/client');
    const create = client.createRoot;
    if (typeof create === 'function' && !create.__vitestGuard) {
      const wrapped = function (...a) {
        const r = create.apply(this, a);
        const un = r.unmount.bind(r);
        worker.roots.add(r);
        r.unmount = () => { worker.roots.delete(r); return un(); };
        return r;
      };
      wrapped.__vitestGuard = true;
      client.createRoot = wrapped;
    }
  } catch {}
}

// S5 (alpha.3): the navigator object whose overrides are recorded (re-read per file: an environment can replace it)
if (mode === 'shared') {
  try { const n = globalThis.navigator; worker.navRef = n && typeof n === 'object' ? n : null; const p = worker.navRef && Object.getPrototypeOf(worker.navRef); worker.navProto = p && p !== Object.prototype ? p : null; } catch { worker.navRef = worker.navProto = null; }
}

// probes use vi.importActual (a file that vi.mock()s the package must not confuse them); the actual
// module is long-lived in shared mode, so it is loaded once per worker and cached
worker.probeMods ??= {};
const actual = async (id) => (worker.probeMods[id] ??= await vi.importActual(id));
const probes = mode === 'shared' && opts.probes !== false ? [
  ['i18next', async () => { const m = (await actual('i18next')).default; return `${m.isInitialized}|${m.language}`; }],
  ['@tanstack/query-core', async () => { const m = await actual('@tanstack/query-core'); return `${m.onlineManager.isOnline()}|${m.focusManager.isFocused()}`; }],
] : [];
async function runProbes() {
  const r = {};
  for (const [name, f] of probes) {
    if (worker.probeOff?.has(name)) continue; try { r[name] = await f(); } catch { (worker.probeOff ??= new Set()).add(name); } }
  return r;
}

// bound at file start: a test that leaves fake timers on must not fake our clock
const realNow = performance.now.bind(performance);
// known exporters of parser scratch state (stylis exports line/column/position/characters of the last parse,
// used by emotion/MUI): a changed value there is not a leak
const DEFAULT_IGNORED_MODULES = ['stylis/dist/umd/stylis.js', 'stylis/dist/stylis.mjs'];
// M6: names on built-in prototypes / in the matcher registry once ALL setup files have run (setup-tail.mjs calls this)
// S4: the context baseline (DOM, globals, module state, probes) is taken there too, before the test file's top-level code
if (mode === 'shared' && opts.tail) worker.afterSetup = async () => {
  try { worker.extNow = fp.captureExt(); } catch {}
  // R1: the first file's capture is the worker's baseline: taken also without diagnostics
  try { worker.pre = { outer: detectPollution || !worker.base ? fp.captureOuter() : null, ctx: await captureCtx() }; } catch { worker.pre = null; }
};
else worker.afterSetup = null;
const captureCtx = async () => ({ dom: fp.captureDom(), globals: fp.captureGlobals(), keys: fp.captureGlobalKeys(), nav: fp.captureNavigator(), eqLen: fp.equalityTesters()?.length ?? 0, mods: moduleState ? fp.captureModuleState() : new Map(), probes: await runProbes() });
let selfMs = realNow() - T0; // top-level of this module
let fileStart = 0, heapStart = 0, file = '', fileOuter = null, fileCtx = null;
// ---- F12: integrity of the assertion API in long-lived realms (shared mode) ----
// A previous file in the same worker could replace expect / core matchers / vi so that later files pass
// regardless of their assertions. Snapshot once per worker, compare at every file start; a mismatch fails the
// file (the CLI then re-runs it isolated). expect.extend() of other matcher names stays allowed (jest-dom etc.).
const CORE_MATCHERS = ['toBe', 'toEqual', 'toStrictEqual', 'toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN',
  'toContain', 'toContainEqual', 'toHaveLength', 'toHaveProperty', 'toMatch', 'toMatchObject', 'toThrow', 'toThrowError', 'toBeInstanceOf',
  'toBeGreaterThan', 'toBeLessThan', 'toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith',
  'toHaveReturned', 'toHaveReturnedWith', 'toMatchSnapshot', 'toMatchInlineSnapshot', 'toSatisfy', 'resolves', 'rejects', 'not'];
const EXPECT_STATICS = ['extend', 'getState', 'setState', 'assertions', 'hasAssertions', 'soft', 'poll', 'addEqualityTesters', 'addSnapshotSerializer', 'unreachable', 'any', 'anything', 'objectContaining', 'arrayContaining', 'stringContaining', 'stringMatching'];
const VI_FNS = ['fn', 'spyOn', 'mock', 'doMock', 'unmock', 'mocked', 'isMockFunction', 'useFakeTimers', 'useRealTimers', 'restoreAllMocks', 'resetModules', 'importActual'];
function integritySnapshot() {
  const snap = new Map();
  snap.set('expect', expect);
  for (const k of EXPECT_STATICS) snap.set('expect.' + k, expect[k]);
  for (const k of VI_FNS) snap.set('vi.' + k, vi[k]);
  let proto = null;
  try { proto = Object.getPrototypeOf(expect(0)); } catch {}
  for (const k of CORE_MATCHERS) {
    let d; for (let o = proto; o && !d; o = Object.getPrototypeOf(o)) d = Object.getOwnPropertyDescriptor(o, k);
    snap.set('matcher.' + k, d ? d.value ?? d.get : undefined);
  }
  for (const k of ['Function.prototype.call', 'Function.prototype.apply', 'Object.is', 'JSON.stringify', 'Promise.prototype.then']) {
    const [a, b, c] = k.split('.'); snap.set(k, c ? globalThis[a][b][c] : globalThis[a][b]);
  }
  return snap;
}
function integrityDiff(base, now) {
  const bad = [];
  for (const [k, v] of base) if (now.get(k) !== v) bad.push(k);
  return bad;
}

beforeAll(async () => {
  const b0 = realNow();
  try { await beforeAllBody(); } finally { selfMs += realNow() - b0; }
});
async function beforeAllBody() {
  file = rel(expect.getState().testPath);
  worker.current = file;
  worker.seq++;
  heapStart = v8.getHeapStatistics().used_heap_size;
  fileStart = realNow();
  let t = performance.now();
  const pre = worker.pre; worker.pre = null;
  // Note 3 (alpha.3): in shared mode the baseline must be taken after the setup files (the tail hook). The config sets
  // the tail up (and refuses `tail: false`); a tail that did not run fails the file instead of taking the baseline
  // after the file's own top-level code.
  if (mode === 'shared' && opts.tail && !pre) throw new Error(`[vitest-guard] the tail setup file (setup-tail.mjs) did not run before ${safety.sanitize(file)}: the shared-mode baseline cannot be taken after the setup files. Keep the setup files vitest-guard adds (its setup file first, setup-tail.mjs last) and sequence.setupFiles 'list'.`);
  if (mode === 'shared' && !opts.tail && !worker.warnedNoTail) { worker.warnedNoTail = true; console.warn('[vitest-guard] shared mode without the tail setup file (setup used without defineVitestGuardConfig?): the baseline is taken after the first file\'s top-level code, so state that file sets at import becomes part of it. Use defineVitestGuardConfig.'); }
  if (mode === 'shared') patchTesters(); // the registry array may have been replaced
  const outerNow = preOuter; // S4: before the setup files and this file's top-level code (what the previous file left)
  // what THIS file starts from, for its own pollution diff (after its setup files; without the tail also after its top level)
  fileOuter = detectPollution ? pre?.outer ?? fp.captureOuter() : null;
  sect('before:outer', t); t = performance.now();
  const ctx = mode === 'shared' ? pre?.ctx ?? await captureCtx() : null;
  fileCtx = ctx;
  sect('before:ctx', t);
  if (mode === 'shared' && opts.integrity !== false) {
    const snap = integritySnapshot();
    if (!worker.integrity) worker.integrity = snap;
    else {
      const bad = integrityDiff(worker.integrity, snap);
      if (bad.length) {
        log({ t: 'integrity', file, prev: worker.prev, replaced: bad });
        throw new Error(`[vitest-guard] integrity: ${bad.slice(0, 8).join(', ')} replaced before ${file} started (previous file in this worker: ${worker.prev}). ` +
          'Shared realms are not a security boundary; this file must run isolated (vitest-guard check re-runs it in forks).');
      }
    }
  }
  // M6: extensions left by earlier files = present after this file's setup files, absent after the first file's
  const ext = mode === 'shared' ? worker.extNow : null;
  let extLeft = [];
  if (ext) {
    if (!worker.extKnown) worker.extKnown = new Set(ext);
    else { extLeft = fp.diffExt(worker.extKnown, ext); for (const k of extLeft) worker.extKnown.add(k); }
  }
  if (!worker.base) {
    // R1: shared mode restores to the state after the first file's setup files (tail), else after its top level
    worker.base = { outer: mode === 'shared' ? pre?.outer ?? fp.captureOuter() : outerNow, ...(ctx || {}) };
    log({ t: 'start', file, seq: worker.seq, mode, pid: process.pid, tid: threadId, lane: LANE });
    if (mode === 'shared') stateWrite(() => { const f = path.join(stateDir, 'settings.json'), t = JSON.stringify({ resetModules: !!opts.resetModules }); let old = null; try { old = sfs.readStateFile(f); } catch {} if (old !== t) sfs.writeStateFile(f, t); });
    return;
  }
  const dirty = fp.diffOuter(worker.base.outer, outerNow, { ignoreListeners: opts.ignoreListeners || [] });
  if (ctx) {
    const d = fp.diffDom(worker.base.dom, ctx.dom); if (d.length) dirty.push({ kind: 'dom/storage', keys: d });
    const g = fp.diffGlobals(worker.base.globals, ctx.globals); if (g.length) dirty.push({ kind: 'patched globals', keys: g });
    // S5: added own properties of the global object are reported once per worker (then known: no repeated warning)
    worker.keysKnown ??= new Set();
    const ak = fp.addedKeys(worker.base.keys, ctx.keys, worker.keysKnown);
    if (ak.length) { dirty.push({ kind: 'added globals', keys: ak.slice(0, 20) }); for (const k of ak) worker.keysKnown.add(k); }
    const nv = fp.diffNavigator(worker.base.nav, ctx.nav).filter((k) => worker.navWho?.get(k) !== 'lib');
    if (nv.length) dirty.push({ kind: 'navigator', keys: nv.slice(0, 20) });
    // modules whose exported state keeps CHANGING between consecutive file starts are parser/tokenizer
    // scratch state (stylis exports line/column/position): changed between starts 3 times -> volatile, ignored
    // (logged as {t:'volatile'} and listed by `vitest-guard report`).
    // A real leak that persists (set once, stays) differs from the baseline but is stable, so it stays reported.
    const short = fp.moduleName; // S12: with / on Windows too
    worker.modLast ??= new Map(); worker.modStreak ??= new Map(); worker.volatile ??= new Set([...DEFAULT_IGNORED_MODULES, ...(opts.ignoreModules || [])]);
    for (const [id, sig] of ctx.mods) {
      const last = worker.modLast.get(id);
      const n = (worker.modStreak.get(id) || 0) + (last !== undefined && last !== sig ? 1 : 0);
      worker.modStreak.set(id, n); worker.modLast.set(id, sig);
      if (n >= 3 && !worker.volatile.has(short(id))) { worker.volatile.add(short(id)); log({ t: 'volatile', module: short(id) }); }
    }
    const m = fp.diffModuleState(worker.base.mods, ctx.mods).filter((k) => !worker.volatile.has(k));
    if (m.length) dirty.push({ kind: 'node_modules state', keys: m.slice(0, 20) });
    for (const k of Object.keys(ctx.probes)) if (worker.base.probes[k] !== undefined && worker.base.probes[k] !== ctx.probes[k]) dirty.push({ kind: 'singleton', keys: [k] });
    if (vi.isFakeTimers()) dirty.push({ kind: 'fake timers', keys: ['still installed'] });
    if (worker.roots.size) dirty.push({ kind: 'react roots', keys: [`${worker.roots.size} mounted`] });
    const protoLeft = extLeft.filter((k) => !k.startsWith('matcher:')), matcherLeft = extLeft.filter((k) => k.startsWith('matcher:')).map((k) => k.slice(8));
    if (protoLeft.length) dirty.push({ kind: 'built-in extensions', keys: protoLeft.slice(0, 20) });
    if (matcherLeft.length) dirty.push({ kind: 'expect matchers', keys: matcherLeft.slice(0, 20) });
    if (worker.listeners.length) dirty.push({ kind: 'window/document listeners', keys: worker.listeners.slice(0, 10).map((l) => `${l.label}:${l.type} (${l.file})`) });
    // module state of lazily loaded packages: extend the baseline with modules first seen now
    for (const [id, sig] of ctx.mods) if (!worker.base.mods.has(id)) worker.base.mods.set(id, sig);
  }
  log({ t: 'start', file, seq: worker.seq, mode, pid: process.pid, tid: threadId, lane: LANE, prev: worker.prev, dirty: dirty.length ? dirty : undefined });
  if (dirty.length && onDirty !== 'silent') {
    const msg = `[vitest-guard] ${safety.sanitize(file)} starts with state left by ${safety.sanitize(worker.prev)}: ` + dirty.map((d) => `${d.kind} [${d.keys.map((k) => safety.sanitize(k, 120)).join(', ')}]`).join('; ');
    if (onDirty === 'error') throw new Error(msg);
    console.warn(msg);
  }
}

let pendingHint = null;
afterAll(async ({}, suite) => { // Vitest 5: fixtures first (must be destructured), suite second
  if (autoGroup === 'dom' && (probeSaved.length || probeObserver)) {
    probeRestore();
    try { probeObserver?.disconnect(); } catch {}
    envRecord({ t: 'env', file: rel(expect.getState().testPath), env: envName(), dom: domTouched, via: domVia || undefined });
  }
  if (autoGroup === 'node' && autoHeal && suite) {
    for (const k of nodeTraps.splice(0)) { try { const d = Object.getOwnPropertyDescriptor(globalThis, k); if (d && d.get) delete globalThis[k]; } catch {} }
    const errors = collectErrors(suite);
    const byMsg = errors.map((e) => DOM_MISS.exec(String(e?.message || ''))).find(Boolean);
    const specific = nodeTouched.filter((k) => k !== 'window' && k !== 'navigator');
    const key = byMsg ? byMsg[1] : errors.length && nodeTouched.length ? specific[0] || nodeTouched[0] : null;
    if (key) {
      const f = rel(expect.getState().testPath);
      envRecord({ t: 'env-miss', file: f, env: envName(), key });
      const hint = `[vitest-guard] auto: ${safety.sanitize(f)} touched the DOM global '${safety.sanitize(key, 80)}' but was classified as pure node (no DOM import/usage found statically). ` +
        'It is recorded in .vitest-guard/run/env.json and runs in the dom group from the next run on (or add `// @vitest-environment jsdom`).';
      console.error(hint);
      pendingHint = hint; // thrown at the end of this hook so it shows up in every reporter
    }
  }
  const a0 = realNow();
  const extLeftover = [];
  let testersLeft = false, navLeft = [];
  const durationMs = Math.max(0, a0 - fileStart);
  let pollution;
  // M6: what this file (not its setup files) added to built-ins / matchers
  const extAdded = mode === 'shared' && worker.extNow ? fp.diffExt(worker.extNow, fp.captureExt()) : [];
  if (detectPollution && worker.base) {
    // what THIS file leaves behind before we reset it (used by the planner: polluters run last)
    const p = fp.diffOuter(fileOuter || worker.base.outer, fp.captureOuter(), { ignoreListeners: opts.ignoreListeners || [] }).map((d) => d.kind);
    if (mode === 'shared') {
      if (fp.diffDom(worker.base.dom, fp.captureDom()).length) p.push('dom/storage');
      if (fp.diffGlobals(worker.base.globals, fp.captureGlobals()).length) p.push('patched globals');
      if (fp.addedKeys(worker.base.keys, fp.captureGlobalKeys(), worker.keysKnown).length) p.push('added globals');
      if (fp.diffNavigator(fileCtx?.nav, fp.captureNavigator()).length) p.push('navigator');
      if (worker.intervals.size) p.push('timers');
      if ((fp.equalityTesters()?.length ?? 0) > (fileCtx?.eqLen ?? Infinity)) p.push('equality testers');
      if (vi.isFakeTimers()) p.push('fake timers');
      if (worker.roots.size) p.push('react roots');
      if (worker.listeners.length) p.push('listeners');
      const pr = await runProbes();
      for (const k of Object.keys(pr)) if (worker.base.probes[k] !== undefined && worker.base.probes[k] !== pr[k]) p.push('singleton:' + k);
      const m = moduleState ? fp.diffModuleState(worker.base.mods, fp.captureModuleState()).filter((k) => !worker.volatile?.has(k)) : [];
      if (m.length) p.push('node_modules state');
      if (extAdded.some((k) => !k.startsWith('matcher:'))) p.push('built-in extensions');
      if (extAdded.some((k) => k.startsWith('matcher:'))) p.push('expect matchers');
    }
    if (p.length) pollution = p;
  }
  sect('after:pollution', a0);
  let tr = performance.now();
  // ---- resets ----
  if (opts.restoreEnv !== false && worker.base) { vi.unstubAllEnvs(); fp.restoreEnv(worker.base.outer.env); }
  if (mode === 'shared' && opts.reset !== false) {
    try { vi.useRealTimers(); } catch {}
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (worker.roots.size) {
      const reactId = 'react'; // not a literal: Vite's import analysis fails the whole setup file in projects without react
      const { act } = await import(/* @vite-ignore */ reactId).catch(() => ({}));
      for (const r of [...worker.roots]) { try { act ? act(() => r.unmount()) : r.unmount(); } catch {} }
    }
    for (const l of worker.listeners.splice(0)) { try { l.target.removeEventListener(l.type, l.fn, l.o); } catch {} }
    // S5: intervals this worker's test code left running. S4 (review 3b): an interval started by a project module stays
    // with that cached module unless resetModules evaluates the module again: cleared only then (else: residual)
    for (const [id, src] of [...worker.intervals]) {
      if (src.own || opts.resetModules) { try { worker.clearInterval(id); } catch {} worker.intervals.delete(id); }
    }
    // R2: equality testers this file added: the test file's own always, a project module's only with resetModules;
    // a node_modules package's never (it is evaluated once per worker, as its other module state)
    { const eq = fp.equalityTesters();
      if (eq && fileCtx && eq.length > fileCtx.eqLen) {
        const added = eq.slice(fileCtx.eqLen);
        const keep = added.filter((t) => { const who = worker.testers.get(t); return who === 'lib' || (who === 'project' && !opts.resetModules); });
        testersLeft = keep.some((t) => worker.testers.get(t) !== 'lib');
        eq.length = fileCtx.eqLen; Array.prototype.push.apply(eq, keep); // not the instrumented push: keep who registered them
        for (const t of added) if (!keep.includes(t)) worker.testers.delete(t);
      } }
    fp.restoreGlobals(worker.base.globals);
    fp.restoreDom(worker.base.dom);
    // S5 (alpha.3): own properties of the global object this file added (not there at the baseline nor after this
    // file's setup files) are deleted when they came from the test file chain, or from a project module that
    // resetModules evaluates again. A package in node_modules that defined one at load keeps it (it is cached for the
    // worker); a name of unknown origin (or one that cannot be deleted) stays and is reported (dirty / residual).
    { const hasOwn = Object.prototype.hasOwnProperty;
      for (const k of fp.captureGlobalKeys()) {
        if (worker.base.keys?.has(k) || fileCtx?.keys?.has(k)) continue;
        const who = worker.globalWho?.get(k);
        if (who === 'lib') { (worker.keysKnown ??= new Set()).add(k); continue; }
        if (who === 'file' || (who === 'project' && opts.resetModules)) { try { delete globalThis[k]; } catch {} if (!hasOwn.call(globalThis, k)) worker.globalWho.delete(k); }
      } }
    // S5 (alpha.3): navigator properties go back to what they were after this file's setup files (a package that
    // overrode one at load, or a cached project module without resetModules, keeps it and is reported)
    if (fileCtx?.nav) navLeft = fp.restoreNavigator(fileCtx.nav, (k) => { const who = worker.navWho?.get(k); return who === 'lib' || (who === 'project' && !opts.resetModules); }).filter((k) => worker.navWho?.get(k) !== 'lib');
    try { const m = await actual('@tanstack/query-core'); m.onlineManager.setOnline(true); m.focusManager.setFocused(undefined); } catch {}
    if (opts.resetModules) vi.resetModules();
    // only with resetModules: modules are evaluated again by the next file, so an import-time extension comes back
    // for the files that import it (as in forks). Without it the names stay and the next file reports them.
    if (extAdded.length && opts.resetModules) {
      let proto = null; try { proto = Object.getPrototypeOf(expect(0)); } catch {}
      const gone = fp.removeExt(extAdded, { expect, assertionProto: proto });
      for (const k of extAdded) if (!gone.includes(k)) extLeftover.push(k);
    } else extLeftover.push(...extAdded);
  }
  sect('after:resets', tr); tr = performance.now();
  // residual = what is still dirty AFTER the resets (only this matters for the planner's conflict edges)
  let residual;
  if (pollution && worker.base) {
    const r = fp.diffOuter(worker.base.outer, fp.captureOuter(), { ignoreListeners: opts.ignoreListeners || [] }).map((d) => d.kind);
    if (mode === 'shared') {
      const pr = await runProbes();
      for (const k of Object.keys(pr)) if (worker.base.probes[k] !== undefined && worker.base.probes[k] !== pr[k]) r.push('singleton:' + k);
      if (moduleState && fp.diffModuleState(worker.base.mods, fp.captureModuleState()).filter((k) => !worker.volatile?.has(k)).length) r.push('node_modules state');
      if (fp.addedKeys(worker.base.keys, fp.captureGlobalKeys(), worker.keysKnown).length) r.push('added globals');
      if (testersLeft) r.push('equality testers');
      if (navLeft.length) r.push('navigator');
      if ([...worker.intervals.values()].some((v) => v.file === file)) r.push('timers');
      if (extLeftover.some((k) => !k.startsWith('matcher:'))) r.push('built-in extensions');
      if (extLeftover.some((k) => k.startsWith('matcher:'))) r.push('expect matchers');
    }
    if (r.length) residual = r;
  }
  sect('after:residual', tr);
  if (PROF) { worker.prof ??= {}; for (const [k, v] of Object.entries(PROF)) worker.prof[k] = (worker.prof[k] || 0) + v; }
  const heapEnd = v8.getHeapStatistics().used_heap_size;
  selfMs += realNow() - a0;
  log({ t: 'end', file, seq: worker.seq, durationMs: Math.round(durationMs * 10) / 10, heapStart, heapEnd, pollution, residual, selfMs: Math.round(selfMs * 100) / 100, ...(PROF ? { prof: Object.fromEntries(Object.entries(worker.prof).map(([k, v]) => [k, Math.round(v)])) } : {}) });
  worker.prev = file;
  if (pendingHint) { const h = pendingHint; pendingHint = null; throw new Error(h); }
});
