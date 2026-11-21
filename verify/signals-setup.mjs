// vto cheap signals – Vitest setupFile APPENDED after the user's setup files, so its afterEach runs
// FIRST in 'stack' order, i.e. before RTL cleanup() unmounts the tree.
// Per test it records
//   dom     – hash of document.body.innerHTML at the end of the test body (before cleanup)
//   asserts – assertion fingerprint: [matcher|negated|hash(actual)|hash(expected args)] per expect matcher
// as {"t":"sig","file","name","dom","asserts":[...] ,"us":<overhead µs>} into $VTO_RAW_DIR/s-<pid>-<thread>.jsonl
import { beforeEach, afterEach, afterAll, chai } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

const G = globalThis;
const dir = process.env.VTO_RAW_DIR;
const S = G.__vto_sig || (G.__vto_sig = (() => {
  mkdirSync(dir, { recursive: true });
  return { out: `${dir}/s-${process.pid}-${threadId}.jsonl`, lines: [], wrapped: new WeakSet() };
})());
const now = () => performance.now();

// FNV-1a 32 bit
function h(str) {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(36);
}

function ser(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v.length > 2000 ? v.slice(0, 2000) : v);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'symbol') return v.toString();
  if (t === 'function') {
    if (v.mock) return `mock(${ser(v.mock.calls, depth + 1)})`;
    return `fn:${v.name}`;
  }
  if (typeof v.nodeType === 'number') return v.nodeType === 1 ? `el:${v.outerHTML}` : `node:${v.nodeType}:${v.textContent}`;
  if (v.asymmetricMatch) return `asym:${v.toString?.()}:${ser(v.sample, depth + 1)}`;
  if (v instanceof Error) return `err:${v.name}:${v.message}`;
  if (v instanceof RegExp) return String(v);
  if (depth > 3) return '…';
  if (Array.isArray(v)) return `[${v.slice(0, 50).map((x) => ser(x, depth + 1)).join(',')}]`;
  if (typeof v.then === 'function') return 'promise';
  const keys = Object.keys(v).sort().slice(0, 50);
  return `{${keys.map((k) => `${k}:${ser(v[k], depth + 1)}`).join(',')}}`;
}

let current = null;
let depth = 0;

function wrapMatchers() {
  const proto = chai.Assertion.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function' || name === 'constructor' || name === 'assert' || name === 'withTest' || name.startsWith('_')) continue;
    if (S.wrapped.has(d.value)) continue;
    const orig = d.value;
    const wrapped = function (...args) {
      if (current && depth === 0) {
        const t0 = now();
        let actual;
        try { actual = chai.util.flag(this, 'object'); } catch {}
        const neg = chai.util.flag(this, 'negate') ? '!' : '';
        let fp;
        try { fp = `${name}${neg}|${h(ser(actual))}|${h(ser(args))}`; } catch { fp = `${name}${neg}|?|?`; }
        current.asserts.push(fp);
        current.us += (now() - t0) * 1000;
      }
      depth++;
      try { return orig.apply(this, args); } finally { depth--; }
    };
    S.wrapped.add(wrapped);
    Object.defineProperty(proto, name, { ...d, value: wrapped });
  }
}

function fullName(task) {
  const names = [task.name];
  for (let s = task.suite; s && s !== task.file && s.name; s = s.suite) names.unshift(s.name);
  return names.join(' > ');
}

beforeEach((ctx) => {
  const t0 = now();
  wrapMatchers(); // cheap after the first call (WeakSet lookups); catches matchers added by expect.extend
  current = { task: ctx.task, asserts: [], dom: null, us: (now() - t0) * 1000 };
});

afterEach((ctx) => {
  if (!current || current.task !== ctx.task) return;
  const t0 = now();
  const body = G.document?.body;
  current.dom = body ? h(body.innerHTML) : null;
  current.us += (now() - t0) * 1000;
  const c = current;
  current = null;
  S.lines.push(JSON.stringify({ t: 'sig', file: c.task.file?.filepath, name: c.task.fullTestName ?? fullName(c.task),
    line: c.task.location?.line ?? null, dom: c.dom, asserts: c.asserts, us: Math.round(c.us) }));
});

afterAll(() => {
  if (S.lines.length) { appendFileSync(S.out, S.lines.join('\n') + '\n'); S.lines = []; }
});
