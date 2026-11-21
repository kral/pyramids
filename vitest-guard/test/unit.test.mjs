import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHasInstanceShims, createRealmEqualityTester, installMissingGlobals } from '../src/realm.mjs';
import { scanSource, isStatefulModule } from '../src/scan.mjs';
import { buildGraph, planLanes } from '../src/plan.mjs';
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

test('scan detects mocks, factories, traits and top-level side effects', () => {
  const src = `import { a } from '../src/a';\nimport i18n from 'i18next';\nvi.mock('../src/a', () => ({ a: 1 }));\nvi.mock('@tanstack/query-core');\n// vi.mock('commented')\nwindow.foo = 1;\nsetupThing();\ndescribe('x', () => { it('y', () => { vi.useFakeTimers(); localStorage.setItem('k','v'); }); });\n`;
  const r = scanSource(src, '/p/test/x.test.ts');
  assert.deepEqual(r.mocks.map((m) => m.spec), ['../src/a', '@tanstack/query-core']);
  assert.equal(r.mocks[1].factory, 'automock'); assert.equal(r.mocks[1].pkg, '@tanstack/query-core');
  assert.equal(r.mocks[0].target, path.resolve('/p/test', '../src/a')); // platform path (D:\\p\\src\\a on Windows)
  assert.ok(r.imports.includes('i18next'));
  assert.ok(r.pollutes.includes('mock:node_modules') && r.pollutes.includes('global-assign') && r.pollutes.includes('top-level-side-effect'));
  assert.equal(r.traits.topLevel.length, 2); // window.foo = 1; setupThing();
  assert.ok(r.mitigated.includes('fakeTimers') && r.mitigated.includes('storage'));
  assert.equal(isStatefulModule('let count = 0; export const inc = () => ++count;'), true);
  assert.equal(isStatefulModule('const cache = new Map(); export const put = (k) => cache.set(k, 1);'), true);
  assert.equal(isStatefulModule('export const f = () => 1; const X = { a: 1 };'), false);
});

test('planner separates hard conflicts, overflows to isolated, balances, orders polluters last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-'));
  fs.mkdirSync(path.join(root, 't'));
  const w = (n, s) => fs.writeFileSync(path.join(root, 't', n), s);
  w('a.test.ts', `vi.mock('pkg', () => ({}));`); w('b.test.ts', `import x from 'pkg';`); w('c.test.ts', `import x from 'pkg';`);
  w('d.test.ts', `it('d', () => {})`); w('e.test.ts', `window.x = 1;`);
  const files = ['t/a.test.ts', 't/b.test.ts', 't/c.test.ts', 't/d.test.ts', 't/e.test.ts'];
  const g = buildGraph({ root, files, history: [{ a: 't/d.test.ts', b: 't/e.test.ts' }] });
  assert.equal(g.hard.get('t/a.test.ts').size, 2);
  const two = planLanes(g, { lanes: 2, durations: { 't/a.test.ts': 50, 't/b.test.ts': 40, 't/c.test.ts': 30, 't/d.test.ts': 20, 't/e.test.ts': 10 } });
  for (const l of two.lanes) { assert.ok(!(l.files.includes('t/a.test.ts') && (l.files.includes('t/b.test.ts') || l.files.includes('t/c.test.ts')))); assert.ok(!(l.files.includes('t/d.test.ts') && l.files.includes('t/e.test.ts'))); }
  const one = planLanes(g, { lanes: 1 });
  assert.ok(one.isolated.length >= 2, 'conflicting files overflow to the isolated bucket');
  const lane = one.lanes[0].files; assert.equal(lane.at(-1), lane.find((f) => g.polluters.has(f)) ? lane.filter((f) => g.polluters.has(f)).at(-1) : lane.at(-1));
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
