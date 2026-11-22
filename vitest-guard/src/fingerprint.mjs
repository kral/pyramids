// State fingerprints used by the leak detector. Two layers:
//  - "outer" state: lives in the worker realm (process, Node builtins). Leaks between files in BOTH fast
//    modes (vmThreads: repro/leak – process.env, process listeners, process-stashed singletons, patched
//    node:http; shared: everything).
//  - "context" state: DOM, storage, globals, timers, mocks, node_modules singletons. Fresh per file in
//    vmThreads, shared in isolate:false.
import { createRequire } from 'node:module';

import vm from 'node:vm';
// Set by Vitest itself per environment (Vite env mirrored into process.env), so they differ between a
// jsdom file and a node file without any user code touching them.
export const VITEST_OWNED_ENV = new Set(['NODE_ENV', 'TEST', 'SSR', 'MODE', 'DEV', 'PROD', 'BASE_URL']);

export const BUILTINS = ['http', 'https', 'net', 'tls', 'dns', 'fs', 'fs/promises', 'child_process', 'events', 'util', 'timers', 'crypto', 'stream', 'zlib', 'os', 'path', 'url', 'worker_threads']; // not 'module': vm pools hand every context its own fake Module
const nodeRequire = createRequire(import.meta.url);

// The outer-realm layer is compiled ONCE per worker in the worker's main realm (vm.runInThisContext).
// vm pools disable V8's compilation cache and re-evaluate setup modules for every test file, so functions
// defined in this module are compiled again per file; this code only touches outer-realm objects
// (process, builtins), so running it there is both cheaper and more correct.
const OUTER_SRC = `(function (process, BUILTINS) {
  const table = [];
  for (const m of BUILTINS) {
    let mod;
    try { mod = process.getBuiltinModule('node:' + m); } catch { continue; }
    if (!mod) continue;
    const keys = [];
    for (const k of Object.keys(mod)) { const d = Object.getOwnPropertyDescriptor(mod, k); if (d && 'value' in d && (typeof d.value === 'function' || (typeof d.value === 'object' && d.value))) keys.push(k); }
    table.push([m, mod, keys]);
  }
  function captureOuter() {
    const builtins = new Map();
    for (const [m, mod, keys] of table) { const vals = new Map(); for (const k of keys) vals.set(k, mod[k]); builtins.set(m, vals); }
    const listeners = {};
    for (const e of process.eventNames()) listeners[String(e)] = process.listenerCount(e);
    return { env: { ...process.env }, listeners, procKeys: new Set(Reflect.ownKeys(process).map(String)), builtins };
  }
  function diffOuter(base, now, opts) {
    const ignoreListeners = (opts && opts.ignoreListeners) || [];
    const out = [];
    const envKeys = new Set([...Object.keys(base.env), ...Object.keys(now.env)]);
    const envDiff = [...envKeys].filter((k) => base.env[k] !== now.env[k] && !k.startsWith('VITEST') && !['NODE_ENV', 'TEST', 'SSR', 'MODE', 'DEV', 'PROD', 'BASE_URL'].includes(k)); // set by Vitest per environment (keep in sync with VITEST_OWNED_ENV)
    if (envDiff.length) out.push({ kind: 'process.env', keys: envDiff.slice(0, 20) });
    const ev = new Set([...Object.keys(base.listeners), ...Object.keys(now.listeners)]);
    const lsn = [...ev].filter((e) => !ignoreListeners.includes(e) && (now.listeners[e] || 0) > (base.listeners[e] || 0));
    if (lsn.length) out.push({ kind: 'process listeners', keys: lsn.map((e) => e + ':+' + ((now.listeners[e] || 0) - (base.listeners[e] || 0))) });
    const added = [...now.procKeys].filter((k) => !base.procKeys.has(k));
    if (added.length) out.push({ kind: 'process properties', keys: added.slice(0, 20) });
    const patched = [];
    for (const [m, vals] of now.builtins) { const b = base.builtins.get(m); if (!b) continue; for (const [k, v] of vals) if (b.has(k) && b.get(k) !== v) patched.push('node:' + m + '.' + k); }
    if (patched.length) out.push({ kind: 'patched builtins', keys: patched.slice(0, 20) });
    return out;
  }
  function restoreEnv(baseEnv) {
    for (const k of Object.keys(process.env)) if (!(k in baseEnv)) delete process.env[k];
    for (const [k, v] of Object.entries(baseEnv)) if (process.env[k] !== v) process.env[k] = v;
  }
  return { captureOuter, diffOuter, restoreEnv };
})`;
const FPC = Symbol.for('vitest-guard.fp-cache');
function outerApi() {
  const c = (process[FPC] ??= {});
  return (c.api ??= vm.runInThisContext(OUTER_SRC, { filename: 'vitest-guard:outer-fingerprint.js' })(process, BUILTINS));
}
export const captureOuter = () => outerApi().captureOuter();
export const diffOuter = (base, now, opts) => outerApi().diffOuter(base, now, opts);
export const restoreEnv = (baseEnv) => outerApi().restoreEnv(baseEnv);

/** S12: a path or stack frame inside node_modules, with either separator (Windows: C:\\…\\node_modules\\…) */
export const inNodeModules = (s) => String(s).replace(/\\/g, '/').includes('/node_modules/');

// ---------- context layer (shared mode) ----------
export const WATCHED_GLOBALS = ['Date', 'Math.random', 'Date.now', 'console.log', 'console.info', 'console.warn', 'console.error', 'console.debug',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'matchMedia', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'innerWidth', 'innerHeight', 'scrollTo', 'open', 'alert',
  'confirm', 'navigator', 'location', 'localStorage', 'sessionStorage', 'crypto', 'performance.now', 'URL.createObjectURL', 'Element.prototype.scrollIntoView',
  'HTMLElement.prototype.focus', 'Element.prototype.getBoundingClientRect', 'HTMLCanvasElement.prototype.getContext', 'window.getComputedStyle'];

function getPath(path) {
  let o = globalThis;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (o == null) return { ok: false };
    if (i === parts.length - 1) return { ok: true, owner: o, key: parts[i], value: o[parts[i]], has: Object.prototype.hasOwnProperty.call(o, parts[i]), desc: Object.getOwnPropertyDescriptor(o, parts[i]) };
    o = o[parts[i]];
  }
  return { ok: false };
}

export function captureGlobals() {
  const m = new Map();
  for (const p of WATCHED_GLOBALS) { try { const r = getPath(p); if (r.ok) m.set(p, r); } catch {} }
  return m;
}

export function diffGlobals(base, now) {
  const changed = [];
  for (const [p, b] of base) { const n = now.get(p); if (!n || n.value !== b.value) changed.push(p); }
  return changed;
}

export function restoreGlobals(base) {
  const restored = [];
  for (const [p, b] of base) {
    try {
      const n = getPath(p);
      if (!n.ok || n.value === b.value) continue;
      if (b.desc) Object.defineProperty(b.owner, b.key, b.desc);
      else if (!b.has) delete n.owner[n.key];
      if (getPath(p).value !== b.value) b.owner[b.key] = b.value;
      restored.push(p);
    } catch {}
  }
  return restored;
}

// <head> nodes owned by long-lived libraries (CSS-in-JS caches, Vite CSS injection). Removing them breaks the
// library's own bookkeeping (emotion re-creates its insertion point every file), so they are neither
// reported nor removed.
const LIB_HEAD = /emotion|styled|jss|mui|data-vite-dev-id|data-s(c|tyled)/i;
export const isLibHeadNode = (n) => { try { return !!n.getAttributeNames && n.getAttributeNames().some((a) => LIB_HEAD.test(a) || LIB_HEAD.test(n.getAttribute(a) || '')); } catch { return false; } };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
export function captureDom() {
  if (typeof document === 'undefined') return null;
  const de = document.documentElement;
  return {
    body: document.body ? document.body.innerHTML.length + ':' + hash(document.body.innerHTML) : '',
    headNodes: document.head ? [...document.head.childNodes].filter((n) => !isLibHeadNode(n)) : [],
    title: document.title,
    attrs: de ? [...de.attributes].map((a) => [a.name, a.value]) : [],
    bodyAttrs: document.body ? [...document.body.attributes].map((a) => [a.name, a.value]) : [],
    local: safeKeys(() => localStorage), session: safeKeys(() => sessionStorage),
    cookie: (() => { try { return String(document.cookie); } catch { return ''; } })(), // S5
    href: (() => { try { return String(globalThis.location?.href ?? ''); } catch { return ''; } })(),
  };
}
const cookiePairs = (c) => String(c || '').split(';').map((x) => x.trim()).filter(Boolean);
function safeKeys(get) { try { const s = get(); const r = []; for (let i = 0; i < s.length; i++) r.push(s.key(i)); return r.sort(); } catch { return []; } }

export function diffDom(base, now) {
  if (!base || !now) return [];
  const out = [];
  if (base.body !== now.body) out.push('document.body');
  if (base.headNodes.length !== now.headNodes.length || now.headNodes.some((n, i) => n !== base.headNodes[i])) out.push('document.head');
  if (base.title !== now.title) out.push('document.title');
  if (JSON.stringify(base.attrs) !== JSON.stringify(now.attrs)) out.push('<html> attributes');
  if (JSON.stringify(base.bodyAttrs) !== JSON.stringify(now.bodyAttrs)) out.push('<body> attributes');
  if (base.local.join() !== now.local.join()) out.push('localStorage');
  if (base.session.join() !== now.session.join()) out.push('sessionStorage');
  if (base.cookie !== now.cookie) out.push('document.cookie');
  if (base.href !== now.href) out.push('location');
  return out;
}

export function restoreDom(base) {
  if (!base || typeof document === 'undefined') return;
  try { if (document.body) document.body.innerHTML = ''; } catch {}
  try { for (const n of [...document.head.childNodes]) if (!base.headNodes.includes(n) && !isLibHeadNode(n)) n.remove(); } catch {}
  try { if (document.title !== base.title) document.title = base.title; } catch {} // assigning creates a <title> node
  const resetAttrs = (el, attrs) => { if (!el) return; for (const a of [...el.attributes]) el.removeAttribute(a.name); for (const [k, v] of attrs) el.setAttribute(k, v); };
  try { resetAttrs(document.documentElement, base.attrs); resetAttrs(document.body, base.bodyAttrs); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  // S5: cookies the baseline did not have (or had with another value) expire, on every path prefix of the current URL
  try {
    const keep = new Set(cookiePairs(base.cookie));
    const paths = ['/'];
    try { const segs = String(location.pathname || '/').split('/').filter(Boolean); for (let i = 1; i <= segs.length; i++) paths.push('/' + segs.slice(0, i).join('/')); } catch {}
    for (const pair of cookiePairs(document.cookie)) {
      if (keep.has(pair)) continue;
      const name = pair.split('=')[0];
      for (const p of paths) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}`;
    }
  } catch {}
  // S5: the URL (history.pushState / replaceState of a router) goes back to the baseline URL (same origin only)
  try { if (base.href && location.href !== base.href) history.replaceState(null, '', base.href); } catch {}
}

// S5: own properties of the global object that a file added (globalThis.__cfg = …, window.x = …). They are reported,
// not deleted: a package in node_modules (cached for the whole worker) may have defined one on first import.
const LIB_GLOBALS = /^(__vite|__vitest|IS_REACT_ACT_ENVIRONMENT$|__EMOTION_|__REACT_DEVTOOLS_|regeneratorRuntime$|__core-js)/;
export function captureGlobalKeys() {
  try { return new Set(Object.getOwnPropertyNames(globalThis).filter((k) => !LIB_GLOBALS.test(k))); } catch { return new Set(); }
}
/** keys in `now` that neither `base` nor `known` has */
export function addedKeys(base, now, known = null) {
  const out = [];
  if (!base || !now) return out;
  for (const k of now) if (!base.has(k) && !(known && known.has(k))) out.push(k);
  return out;
}

// S5: expect.addEqualityTesters() pushes into one array shared by every file of a long-lived worker
/** @returns {Array|null} the live array of custom equality testers */
export function equalityTesters() {
  try { const a = globalThis[Symbol.for('$$jest-matchers-object')]?.customEqualityTesters; return Array.isArray(a) ? a : null; } catch { return null; }
}

// CJS module-level state of loaded node_modules packages (auto-detect): one level of primitives and
// collection sizes of every loaded module's exports object. Incremental: a module whose exports have
// nothing to fingerprint at first sight is never looked at again (most of MUI/icons/react-dom internals).
const modSeen = new Set();
const modTracked = []; // [id, keys[]]: only keys that held a primitive or a collection at first sight
let modCount = -1;
function sigKeys(ex) {
  const keys = [];
  const all = Object.keys(ex);
  if (all.length > 500) return keys; // barrel files (icon packs) are not state holders
  for (const k of all) {
    if (k === '__esModule' || k === 'default' || k === 'version') continue;
    let v; try { v = ex[k]; } catch { continue; }
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean' || v === null || v === undefined || v instanceof Map || v instanceof Set || Array.isArray(v)) keys.push(k);
  }
  return keys;
}
function moduleSig(ex, keys) {
  let sig = '';
  for (const k of keys) {
    let v; try { v = ex[k]; } catch { continue; }
    if (v instanceof Map || v instanceof Set) sig += k + '#' + v.size + ';';
    else if (Array.isArray(v)) sig += k + '#' + v.length + ';';
    else sig += k + '=' + String(v) + ';';
  }
  return sig;
}
export function captureModuleState() {
  const cache = nodeRequire.cache;
  const ids = Object.keys(cache);
  if (ids.length !== modCount) {
    modCount = ids.length;
    for (const id of ids) {
      if (modSeen.has(id)) continue;
      modSeen.add(id);
      const nid = id.replace(/\\/g, '/'); // S12: require.cache keys use \ on Windows
      if (!nid.includes('/node_modules/') || nid.includes('/node_modules/vitest/') || nid.includes('/node_modules/@vitest/') || nid.includes('/node_modules/vitest-guard/') || nid.includes('/node_modules/@jirikral/vitest-guard/') || nid.includes('/node_modules/vite/')) continue;
      const ex = cache[id]?.exports;
      if (!ex || typeof ex !== 'object') continue;
      const keys = sigKeys(ex);
      if (keys.length) modTracked.push([id, keys]);
    }
  }
  const m = new Map();
  for (const [id, keys] of modTracked) { const ex = cache[id]?.exports; if (ex && typeof ex === 'object') m.set(id, moduleSig(ex, keys)); }
  return m;
}
export function diffModuleState(base, now) {
  const out = [];
  for (const [id, sig] of now) { const b = base.get(id); if (b !== undefined && b !== sig) out.push(moduleName(id)); }
  return out;
}
/** S12: the part of a module path after the last node_modules/, with / (also for Windows paths) */
export const moduleName = (id) => { const n = String(id).replace(/\\/g, '/'); return n.slice(n.lastIndexOf('/node_modules/') + 14); };

// ---------- extensions of built-ins and of the matcher registry (shared mode, REVIEW-2-correctness M6) ----------
// A test file that adds `String.prototype.shout` or calls `expect.extend({ toBeEven })` makes every later file in
// the shared worker pass with it, although the same file fails in forks. Names only (cheap: ~40 objects).
export const EXT_OWNERS = ['Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Error', 'ArrayBuffer', 'Uint8Array', 'Math', 'JSON', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'Element', 'HTMLElement', 'Node', 'EventTarget', 'Event'];
const JEST_MATCHERS = Symbol.for('$$jest-matchers-object');
/** @returns {Set<string>} e.g. 'String.prototype.shout', 'Array.from2', 'matcher:toBeEven' */
export function captureExt() {
  const out = new Set();
  for (const name of EXT_OWNERS) {
    const o = globalThis[name];
    if (o == null) continue;
    try { for (const k of Reflect.ownKeys(o)) out.add(name + '.' + String(k)); } catch {}
    const p = typeof o === 'function' ? o.prototype : null;
    if (p) { try { for (const k of Reflect.ownKeys(p)) out.add(name + '.prototype.' + String(k)); } catch {} }
  }
  try { for (const k of Object.keys(globalThis[JEST_MATCHERS]?.matchers || {})) out.add('matcher:' + k); } catch {}
  return out;
}
export function diffExt(base, now) {
  const added = [];
  for (const k of now) if (!base.has(k)) added.push(k);
  return added;
}
/** Remove added names again (string-keyed only). `assertionProto` = Object.getPrototypeOf(expect(0)). @returns names removed */
export function removeExt(names, { expect: ex, assertionProto } = {}) {
  const gone = [];
  for (const n of names) {
    try {
      if (n.startsWith('matcher:')) {
        const k = n.slice(8);
        delete globalThis[JEST_MATCHERS]?.matchers?.[k];
        for (let o = assertionProto; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, k)) { delete o[k]; break; }
        if (ex && Object.prototype.hasOwnProperty.call(ex, k)) delete ex[k];
        gone.push(n);
        continue;
      }
      const parts = n.split('.');
      if (parts.some((p) => p.startsWith('Symbol('))) continue;
      const key = parts.pop();
      let o = globalThis;
      for (const p of parts) o = o?.[p];
      if (o && delete o[key]) gone.push(n);
    } catch {}
  }
  return gone;
}
