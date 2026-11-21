// Realm-tolerance for Vitest vm pools (vmThreads / vmForks).
//
// In a vm pool every test file runs in its own vm context, but Node builtins (fs, util, http…), native
// addons and the globals the environment copies from Node (structuredClone, fetch/Response, Buffer,
// AbortController…) live in the worker's *outer* realm. Objects they return carry the outer realm's
// intrinsics, so `instanceof Array/Error/Map/Promise/Uint8Array` is false and toStrictEqual/toEqual
// compare constructors that differ. Reproduced in vmguard-lab/repro/realm (21 of 53 assertions).
import vm from 'node:vm';

const ERRORS = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'];
const TYPED = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
export const REALM_CTORS = ['Object', 'Array', ...ERRORS, 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', ...TYPED];

// Web globals Node has but the vm environments do not expose (probe: repro/probe). MSW 2/3 needs the
// streams (jsdom) and BroadcastChannel (happy-dom) and fails at import without them.
export const MISSING_GLOBALS = ['ReadableStream', 'WritableStream', 'TransformStream', 'TextEncoderStream', 'TextDecoderStream',
  'CompressionStream', 'DecompressionStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
  'BroadcastChannel', 'MessageChannel', 'MessagePort', 'MessageEvent', 'CryptoKey', 'SubtleCrypto'];

/** DOM globals watched by the auto-mode probe and by the node-group miss detector. */
export const DOM_KEYS = ['document', 'window', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'customElements', 'DOMParser', 'matchMedia'];

const MARK = Symbol.for('vm-guard.realm');
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];

export function getOuterGlobal() {
  return vm.runInThisContext('globalThis');
}

/** True when this module is evaluated inside a vm context different from the worker's main realm. */
export function isForeignRealmContext(g = globalThis) {
  return getOuterGlobal() !== g;
}

/**
 * Installs Symbol.hasInstance on the context's intrinsic constructors so that an object created by the
 * same intrinsic of the outer realm also counts. Exact: only the outer realm's *same* constructor (and its
 * subclasses, e.g. outer TypeError for Error, Buffer for Uint8Array) is accepted, and user subclasses
 * (`class MyError extends Error`) keep the ordinary semantics (`this !== inner`).
 */
export function installHasInstanceShims(g = globalThis, outer = getOuterGlobal(), names = REALM_CTORS) {
  const installed = [];
  if (outer === g) return installed;
  for (const name of names) {
    const inner = g[name];
    const foreign = outer[name];
    if (typeof inner !== 'function' || typeof foreign !== 'function' || inner === foreign) continue;
    const own = Object.getOwnPropertyDescriptor(inner, Symbol.hasInstance);
    if (own && own.value && own.value[MARK]) continue;
    const shim = function (value) {
      if (ordinaryHasInstance.call(this, value)) return true;
      return this === inner && ordinaryHasInstance.call(foreign, value);
    };
    shim[MARK] = true;
    Object.defineProperty(inner, Symbol.hasInstance, { value: shim, configurable: true, writable: true });
    installed.push(name);
  }
  return installed;
}

/** Copies Web globals that exist in the worker realm but are missing in the vm context. */
export function installMissingGlobals(g = globalThis, outer = getOuterGlobal(), names = MISSING_GLOBALS) {
  const added = [];
  if (outer === g) return added;
  for (const name of names) {
    if (typeof g[name] !== 'undefined') continue;
    const v = outer[name];
    if (typeof v === 'undefined') continue;
    Object.defineProperty(g, name, { value: v, configurable: true, writable: true, enumerable: false });
    added.push(name);
  }
  // jsdom's vm context ships a `crypto` without `subtle` (repro/web: crypto.subtle.digest)
  try {
    if (g.crypto && !g.crypto.subtle && outer.crypto?.subtle) {
      Object.defineProperty(g.crypto, 'subtle', { value: outer.crypto.subtle, configurable: true });
      added.push('crypto.subtle');
    }
  } catch {}
  return added;
}

/**
 * Equality tester for expect(): when either side is an object built on an outer-realm intrinsic
 * prototype, compare a shallow same-realm copy instead. Children are handled when eq() recurses,
 * so the copy never needs to be deep. Keeps toStrictEqual strict (forwards strictCheck).
 */
export function createRealmEqualityTester(g = globalThis, outer = getOuterGlobal(), names = REALM_CTORS) {
  const protoToName = new Map();
  if (outer !== g) {
    for (const name of names) {
      const f = outer[name];
      if (typeof f === 'function' && f !== g[name] && f.prototype) protoToName.set(f.prototype, name);
    }
  }
  const isForeign = (x) => x !== null && typeof x === 'object' && protoToName.has(Object.getPrototypeOf(x));
  const copyProps = (from, to, skip) => {
    for (const key of Reflect.ownKeys(from)) {
      if (skip && skip.has(key)) continue;
      const d = Object.getOwnPropertyDescriptor(from, key);
      try { Object.defineProperty(to, key, d); } catch {}
    }
    return to;
  };
  const LENGTH = new Set(['length']);
  function adopt(x) {
    const name = protoToName.get(Object.getPrototypeOf(x));
    const Inner = g[name];
    switch (name) {
      case 'Object': return copyProps(x, {});
      case 'Array': { const r = new Inner(x.length); return copyProps(x, r, LENGTH); }
      case 'Map': return new Inner(x);
      case 'Set': return new Inner(x);
      case 'Date': return new Inner(x.getTime());
      case 'RegExp': { const r = new Inner(x.source, x.flags); r.lastIndex = x.lastIndex; return r; }
      case 'ArrayBuffer': case 'SharedArrayBuffer': { const r = new Inner(x.byteLength); new g.Uint8Array(r).set(new outer.Uint8Array(x)); return r; }
      case 'DataView': return new Inner(adopt(x.buffer), x.byteOffset, x.byteLength);
      case 'WeakMap': case 'WeakSet': case 'Promise': return x;
      default:
        if (TYPED.includes(name)) return new Inner(x);
        if (ERRORS.includes(name)) return copyProps(x, Object.create(Inner.prototype));
        return x;
    }
  }
  const tester = function vmGuardRealmEquality(a, b, customTesters) {
    const fa = isForeign(a);
    const fb = isForeign(b);
    if (!fa && !fb) return undefined;
    const strict = Array.isArray(customTesters) && customTesters.some((t) => t && t.name === 'typeEquality');
    return this.equals(fa ? adopt(a) : a, fb ? adopt(b) : b, customTesters, strict);
  };
  tester.isForeign = isForeign;
  tester.adopt = adopt;
  return tester;
}
