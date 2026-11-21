// vto optional signals (VTO_SIGNALS=1 / vitest-overlap --signals) – Vitest setupFile APPENDED after
// the user's setup files, so its afterEach runs FIRST in 'stack' order (before RTL cleanup()).
// Per test it computes
//   domHash    – hash of document.body.innerHTML at the end of the test body (before cleanup)
//   assertHash – hash of the assertion fingerprints [matcher|negated|hash(actual)|hash(expected)]
// and hands them to setup-v2.mjs (globalThis.__vto_signals), which adds them to the test record.
// Based on verify/signals-setup.mjs. Cost ≈ 0.5 ms/test, therefore opt-in.
import { beforeEach, afterEach, chai } from 'vitest';

const G = globalThis;
const S = G.__vto_sig || (G.__vto_sig = { wrapped: new WeakSet() });
const OUT = G.__vto_signals || (G.__vto_signals = new Map());
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


beforeEach((ctx) => {
  wrapMatchers(); // cheap after the first call; catches matchers added by expect.extend
  current = { task: ctx.task, asserts: [], us: 0 };
});

afterEach((ctx) => {
  if (!current || current.task !== ctx.task) return;
  const body = G.document?.body;
  OUT.set(ctx.task.id, { domHash: body ? h(body.innerHTML) : null, assertHash: h(current.asserts.join(';')) });
  current = null;
});
