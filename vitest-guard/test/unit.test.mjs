import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHasInstanceShims, createRealmEqualityTester, installMissingGlobals } from '../src/realm.mjs';
import { autoMemoryLimit } from '../src/index.mjs';
import { signature } from '../src/runner.mjs';

const mkContext = () => { const ctx = vm.createContext({}); return { ctx, g: vm.runInContext('globalThis', ctx) }; };

test('hasInstance shims accept outer-realm intrinsics, keep subclass semantics', () => {
  const { ctx, g } = mkContext();
  g.outerArr = [1]; g.outerErr = new TypeError('x'); g.outerBuf = Buffer.from('a'); g.outerMap = new Map(); g.outerP = Promise.resolve();
  assert.equal(vm.runInContext('outerArr instanceof Array', ctx), false);
  const installed = installHasInstanceShims(g, globalThis);
  assert.ok(installed.includes('Array') && installed.includes('Error') && installed.includes('Uint8Array'));
  assert.equal(vm.runInContext('outerArr instanceof Array', ctx), true);
  assert.equal(vm.runInContext('outerErr instanceof Error && outerErr instanceof TypeError', ctx), true);
  assert.equal(vm.runInContext('outerErr instanceof RangeError', ctx), false);
  assert.equal(vm.runInContext('outerBuf instanceof Uint8Array', ctx), true);
  assert.equal(vm.runInContext('outerMap instanceof Map && outerP instanceof Promise', ctx), true);
  assert.equal(vm.runInContext('class MyErr extends Error {}; outerErr instanceof MyErr', ctx), false);
  assert.equal(vm.runInContext('class MyArr extends Array {}; [] instanceof MyArr', ctx), false);
  assert.equal(vm.runInContext('class MyArr2 extends Array {}; new MyArr2() instanceof MyArr2 && new MyArr2() instanceof Array', ctx), true);
  assert.equal(vm.runInContext('({}) instanceof Array', ctx), false);
  assert.deepEqual(installHasInstanceShims(g, globalThis), [], 'idempotent');
});

test('equality tester adopts foreign objects shallowly and forwards strictness', () => {
  const { g } = mkContext();
  const tester = createRealmEqualityTester(g, globalThis);
  let seen;
  const ctx = { equals: (a, b, testers, strict) => { seen = { a, b, strict }; return true; } };
  assert.equal(tester.call(ctx, g.Object.create(g.Object.prototype), g.Object.create(g.Object.prototype), []), undefined, 'same realm: no opinion');
  tester.call(ctx, [1, , 3], new g.Array(1, 2, 3), [{ name: 'typeEquality' }]);
  assert.equal(Object.getPrototypeOf(seen.a), g.Array.prototype);
  assert.equal(seen.a.length, 3); assert.equal(1 in seen.a, false, 'holes kept');
  assert.equal(seen.strict, true);
  tester.call(ctx, new Map([[1, 2]]), new g.Map(), []);
  assert.equal(Object.getPrototypeOf(seen.a), g.Map.prototype); assert.equal(seen.strict, false);
  const e = Object.assign(new TypeError('m'), { code: 'X' });
  tester.call(ctx, e, null, []);
  assert.equal(Object.getPrototypeOf(seen.a), g.TypeError.prototype); assert.equal(seen.a.code, 'X'); assert.equal(seen.a.message, 'm');
  tester.call(ctx, new Uint8Array([1, 2]), null, []);
  assert.equal(Object.getPrototypeOf(seen.a), g.Uint8Array.prototype);
});

test('missing globals copied only when absent', () => {
  const { g } = mkContext();
  g.WritableStream = undefined; delete g.WritableStream;
  const added = installMissingGlobals(g, globalThis, ['WritableStream', 'Array']);
  assert.deepEqual(added, ['WritableStream']);
  assert.equal(g.WritableStream, globalThis.WritableStream);
});

test('autoMemoryLimit stays below RAM share and V8 heap', () => {
  const GB = 1024 ** 3;
  assert.equal(autoMemoryLimit(1, { totalmem: 8 * GB, heapLimit: 8.2 * GB }), 4 * GB);
  assert.equal(autoMemoryLimit(2, { totalmem: 8 * GB, heapLimit: 8.2 * GB }), 2 * GB);
  assert.equal(autoMemoryLimit(4, { totalmem: 64 * GB, heapLimit: 4 * GB }), Math.floor(4 * GB * 0.6));
  assert.equal(autoMemoryLimit(64, { totalmem: 4 * GB, heapLimit: 4 * GB }), 512 * 1024 * 1024);
});

test('signature strips paths and numbers', () => {
  assert.equal(signature('\x1b[31mAssertionError: expected 5 to be 0 at /a/b/c.ts:3:4\n at x'), 'AssertionError: expected N to be N at <path>');
});

test('leak detector ignores env vars that Vitest sets per environment (SSR, MODE, …) but reports user ones', async () => {
  const { captureOuter, diffOuter, VITEST_OWNED_ENV } = await import('../src/fingerprint.mjs');
  const base = captureOuter();
  const now = captureOuter();
  now.env = { ...base.env };
  for (const k of VITEST_OWNED_ENV) now.env[k] = String(base.env[k] ?? '') + 'x';
  assert.deepEqual(diffOuter(base, now).filter((d) => d.kind === 'process.env'), []);
  now.env.MY_FLAG = '1';
  assert.deepEqual(diffOuter(base, now).find((d) => d.kind === 'process.env')?.keys, ['MY_FLAG']);
});

test('ui: plain summary without colour, colour only when forced', async () => {
  const { summary, colorEnabled, table, painter } = await import('../src/ui.mjs');
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  let out = '';
  summary({ title: 'check · vm', verdict: 'ok', headline: '3 files passed', facts: [['exit code', 0], ['skipped', undefined]], next: ['done'] }, { out: (s) => (out = s), stream: { isTTY: false }, env: {} });
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /OK {2}3 files passed/);
  assert.match(out, /exit code {2}0/);
  assert.doesNotMatch(out, /skipped/);
  summary({ title: 't', verdict: 'fail', headline: 'h' }, { out: (s) => (out = s), stream: { isTTY: false }, env: { FORCE_COLOR: '1' } });
  assert.match(out, /\x1b\[31m/);
  const t = table(['a', 'bb'], [['xyz', painter(true).red('1')]], ['l', 'r'], painter(false));
  assert.equal(t[1], 'xyz   ' + '\x1b[31m1\x1b[39m');
});
