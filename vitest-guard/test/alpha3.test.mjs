// Regression tests for 0.1.0-alpha.3: the known limits of alpha.2 closed (fail closed).
//  S5      added globals and navigator overrides are reset between files of a shared worker
//  note 1  provenance of testers / intervals is the call site in the test file chain (T2)
//  S2      verify records order-dependent entries so that `check --prune` does not release them (G2)
//  note 2  two guarded configs in one root keep each other's quarantine entries (T6); incompatible.json version 2
//  note 3  `tail: false` is refused, `sequence.setupFiles: 'parallel'` keeps the baseline after the setup files
//  S6      the fallback directory walk of mode auto prunes excluded, build and dot directories
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { project, wrappedConfig, cli, vitestRun, integration, readJson, pkgDir } from './helpers.mjs';
import { prunedDir } from '../src/auto.mjs';
import { STATE_VERSIONS } from '../src/stateformat.mjs';
import * as fp from '../src/fingerprint.mjs';

const pass = `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`;
const fgFile = `import { test, expect } from 'vitest'; import { isMainThread } from 'node:worker_threads'; test('fg', () => { expect(isMainThread).toBe(false); });\n`;
const P = (files, t = {}, guard = {}, o = {}) => project({ 'vitest.config.mjs': wrappedConfig(t, guard), 'package.json': '{"type":"module"}', ...files }, o);
const pkg = (root, name, files) => { for (const [f, s] of Object.entries(files)) { const p = path.join(root, 'node_modules', name, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); } };
const runLog = (root) => { const d = path.join(root, '.vitest-guard/run/logs'); return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); };
const one = { maxWorkers: 1, fileParallelism: false };
const noWarn = { env: { VITEST_GUARD_VERIFY_WARNING: '0' } };
const qFile = (root) => path.join(root, '.vitest-guard/incompatible.json');

// ---------------- S5 ----------------
test('S5: globals a test file adds are deleted after it; a package global defined at load and setup-file globals stay', integration, () => {
  const root = P({
    'setup.js': `globalThis.__fromSetup = 1;\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; import 'fake-polyfill'; globalThis.__top = 1;
test('a', () => { globalThis.__x = 1; window.__cfg = { a: 1 }; Object.assign(globalThis, { __assigned: 1 }); Object.defineProperty(window, 'matchMediaX', { value: () => 1, configurable: true, writable: true }); expect(globalThis.__polyfilled).toBe(true); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest';
test('b', () => { for (const k of ['__top', '__x', '__cfg', '__assigned', 'matchMediaX']) { expect(k in globalThis, k).toBe(false); expect(k in window, k).toBe(false); } expect(globalThis.__fromSetup).toBe(1); });\n`,
    'src/c.test.js': `import { test, expect } from 'vitest'; import 'fake-polyfill'; test('c', () => { expect(globalThis.__polyfilled).toBe(true); });\n`,
  }, { environment: 'jsdom', setupFiles: ['./setup.js'], ...one }, { mode: 'shared', onDirty: 'error' }, { modules: 'real' });
  pkg(root, 'fake-polyfill', { 'package.json': '{"name":"fake-polyfill","version":"1.0.0","type":"module","main":"index.js"}', 'index.js': `globalThis.__polyfilled = true;\n` });
  const r = vitestRun(root, [], noWarn);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'passed', 'src/c.test.js': 'passed' });
  const v = cli(root, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
  assert.deepEqual(runLog(root).filter((x) => x.dirty), [], 'nothing is reported: the package global is known, the rest is gone');
});

test('S5: navigator overrides (defineProperty on navigator / Navigator.prototype, assignment) are reset after the file', integration, () => {
  const root = P({
    'setup.js': `Object.defineProperty(navigator, 'vendor', { get: () => 'setup-vendor', configurable: true });\n`,
    'src/a.test.js': `import { test, expect } from 'vitest';
test('a', () => {
  Object.defineProperty(navigator, 'language', { value: 'cs-CZ', configurable: true });
  Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', { get: () => ['cs'], configurable: true });
  navigator.__extra = 1;
  expect(navigator.language).toBe('cs-CZ');
});\n`,
    'src/b.test.js': `import { test, expect } from 'vitest';
test('b', () => { expect(navigator.language).toBe('en-US'); expect(navigator.languages).toEqual(['en-US', 'en']); expect('__extra' in navigator).toBe(false); expect(navigator.vendor).toBe('setup-vendor'); });\n`,
  }, { environment: 'jsdom', setupFiles: ['./setup.js'], ...one }, { mode: 'shared', onDirty: 'error' });
  const iso = vitestRun(root, [], { env: { VITEST_GUARD_MODE: 'isolated' } });
  assert.equal(iso.code, 0, iso.out);
  const r = vitestRun(root, [], noWarn);
  assert.equal(r.code, 0, r.out);
  const v = cli(root, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
  const end = runLog(root).find((x) => x.t === 'end' && x.file === 'src/a.test.js' && x.pollution);
  assert.ok(end?.pollution.includes('navigator'), 'the override is recorded as pollution of a ' + JSON.stringify(end));
  assert.ok(!end.residual?.includes('navigator'), 'and it does not survive the reset');
});

test('S5 unit: navigator snapshots compare accessors by source and restore what changed', () => {
  const nav = { a: 1 };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try {
    Object.defineProperty(nav, 'lang', { get: () => 'en', configurable: true });
    const s0 = fp.captureNavigator();
    Object.defineProperty(nav, 'lang', { get: () => 'en', configurable: true }); // same source: not a change
    assert.deepEqual(fp.diffNavigator(s0, fp.captureNavigator()), []);
    Object.defineProperty(nav, 'lang', { get: () => 'cs', configurable: true });
    nav.b = 2;
    assert.deepEqual(fp.diffNavigator(s0, fp.captureNavigator()).sort(), ['b', 'lang']);
    assert.deepEqual(fp.restoreNavigator(s0, (k) => k === 'b'), ['b']);
    assert.equal(nav.lang, 'en');
    assert.equal(nav.b, 2);
    assert.deepEqual(fp.restoreNavigator(s0), []);
    assert.equal('b' in nav, false);
  } finally { delete globalThis.navigator; }
});

// ---------------- note 1 (T2) ----------------
test('note 1: a tester / interval a node_modules package registers when the test file calls it is removed after that file', integration, () => {
  const root = P({
    'src/box.js': `export class Box { constructor(v) { this.v = v; } }\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; import { install, poll } from 'loose-matchers'; import { Box } from './box.js'; install();
test('a', () => { poll(); expect(new Box(1)).toEqual(new Box(2)); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; import { Box } from './box.js'; test('b: wrong expectation', () => { expect(new Box(1)).toEqual(new Box(2)); });\n`,
    'src/c.test.js': `import { test, expect } from 'vitest'; test('c: no ticks', async () => { const t0 = process.__vgTicks || 0; await new Promise((r) => setTimeout(r, 40)); expect(process.__vgTicks || 0).toBe(t0); });\n`,
  }, one, { mode: 'shared' }, { modules: 'real' });
  pkg(root, 'loose-matchers', { 'package.json': '{"name":"loose-matchers","version":"1.0.0","type":"module","main":"index.js"}',
    'index.js': `import { expect } from 'vitest';
export function install() { expect.addEqualityTesters([(a, b) => (a?.constructor?.name === 'Box' && b?.constructor?.name === 'Box' ? true : undefined)]); }
export function poll() { setInterval(() => { process.__vgTicks = (process.__vgTicks || 0) + 1; }, 1); }\n` });
  const iso = vitestRun(root, [], { env: { VITEST_GUARD_MODE: 'isolated' } });
  assert.deepEqual(iso.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'failed', 'src/c.test.js': 'passed' });
  const r = vitestRun(root, [], noWarn);
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'failed', 'src/c.test.js': 'passed' }, r.out);
  const c = cli(root, ['check', '--mode', 'shared']);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /FAIL \(also isolated\): src\/b\.test\.js/);
  const v = cli(root, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /false-green 0, false-red 0/);
});

// ---------------- S2 ----------------
const leakyPair = {
  'src/a.test.js': `import { test, expect } from 'vitest'; test('a', () => { process.__poison = 1; expect(1).toBe(1); });\n`,
  'src/b.test.js': `import { test, expect } from 'vitest'; test('b', () => { expect(process.__poison).toBeUndefined(); });\n`,
};
test('S2: verify records order-dependent entries with their predecessors; a nightly verify + check --prune converges', integration, () => {
  const root = P(leakyPair, one, { mode: 'shared' });
  const v1 = cli(root, ['verify', '--orders', 'forward,reversed']);
  assert.equal(v1.code, 4, v1.out);
  const e = readJson(qFile(root)).shared['src/b.test.js'];
  assert.equal(e.orderDependent, true, JSON.stringify(e));
  assert.deepEqual(e.after, ['src/a.test.js']);
  assert.equal(readJson(qFile(root)).version, STATE_VERSIONS['incompatible.json']);
  for (let i = 0; i < 2; i++) {
    const p = cli(root, ['check', '--prune']);
    assert.equal(p.code, 0, p.out);
    assert.match(p.out, /kept in quarantine \(passes alone in shared, but order-dependent: still fails after src\/a\.test\.js\): src\/b\.test\.js/);
    assert.ok(readJson(qFile(root)).shared['src/b.test.js'], 'still quarantined');
    const v = cli(root, ['verify', '--orders', 'forward,reversed']);
    assert.equal(v.code, 0, v.out);
  }
});

test('S2: a version 1 order-dependent entry without predecessors is migrated to the marker and never released by --prune', integration, () => {
  const root = P(leakyPair, one, { mode: 'shared' });
  fs.mkdirSync(path.join(root, '.vitest-guard'));
  fs.writeFileSync(qFile(root), JSON.stringify({ version: 1, vm: {}, shared: { 'src/b.test.js': { signature: 'order-dependent: fails in shared order forward, passes in isolated forks', tests: ['b'] } } }));
  const p = cli(root, ['check', '--prune']);
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /kept in quarantine .*no predecessors recorded; release by hand.*src\/b\.test\.js/);
  assert.ok(readJson(qFile(root)).shared['src/b.test.js']);
});

// ---------------- note 2 (T6) ----------------
test('note 2: two guarded configs in one root never prune each other\'s quarantine entries', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'int/fg.test.js': fgFile, 'int/ok.test.js': pass }, { include: ['src/**/*.test.js'] });
  fs.writeFileSync(path.join(root, 'vitest.int.config.mjs'), wrappedConfig({ include: ['int/**/*.test.js'] }, {}));
  const v = cli(root, ['verify', '--config', 'vitest.int.config.mjs']);
  assert.equal(v.code, 5, v.out);
  const q = readJson(qFile(root));
  assert.equal(q.version, 2);
  assert.equal(q.vm['int/fg.test.js'].config, 'vitest.int.config.mjs');
  const c = cli(root, ['check']);
  assert.equal(c.code, 0, c.out);
  assert.doesNotMatch(c.out, /STALE/);
  const p = cli(root, ['check', '--prune']);
  assert.equal(p.code, 0, p.out);
  assert.ok(readJson(qFile(root)).vm['int/fg.test.js'], 'the int config\'s entry survives the default config\'s prune');
  const r = vitestRun(root, ['--config', 'vitest.int.config.mjs'], noWarn);
  assert.equal(r.status['int/fg.test.js'], 'failed', 'still runs isolated (where it fails) for the int config');
  const d = vitestRun(root, [], noWarn);
  assert.equal(d.code, 0, d.out);
  assert.doesNotMatch(d.out, /ignoring .*int\/fg/, 'no warning about the other config\'s entry');
});

test('note 2: version 1 entries: kept when the file exists but this config does not list it, removed by --prune when the file is gone', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'int/fg.test.js': fgFile }, { include: ['src/**/*.test.js'] });
  fs.mkdirSync(path.join(root, '.vitest-guard'));
  fs.writeFileSync(qFile(root), JSON.stringify({ version: 1, vm: { 'int/fg.test.js': { signature: 'false green', falseGreen: true }, 'src/gone.test.js': { signature: 'x' } }, shared: {} }));
  const c = cli(root, ['check']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /kept quarantine entry \(vm\) of another config .*int\/fg\.test\.js/);
  assert.match(c.out, /STALE quarantine entry \(vm\): src\/gone\.test\.js/);
  const p = cli(root, ['check', '--prune']);
  assert.equal(p.code, 4, p.out);
  const q = readJson(qFile(root));
  assert.equal(q.version, 2, 'migrated on write');
  assert.deepEqual(Object.keys(q.vm), ['int/fg.test.js']);
});

// ---------------- note 3 ----------------
test('note 3: tail: false is refused in shared mode; setupFiles "parallel" still takes the baseline after the setup files', integration, () => {
  const files = {
    'setup.js': `process.env.FROM_SETUP = '1';\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; process.env.RV_LEAK = '1'; test('a', () => { expect(1).toBe(1); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; test('b', () => { expect(process.env.RV_LEAK).toBeUndefined(); expect(process.env.FROM_SETUP).toBe('1'); });\n`,
  };
  const off = P(files, { setupFiles: ['./setup.js'], ...one }, { mode: 'shared', tail: false });
  const r0 = vitestRun(off, [], noWarn);
  assert.equal(r0.code, 1, r0.out);
  assert.match(r0.out, /tail: false is not supported in shared mode/);
  const par = P(files, { setupFiles: ['./setup.js'], sequence: { setupFiles: 'parallel' }, ...one }, { mode: 'shared', onDirty: 'error' });
  const r1 = vitestRun(par, [], noWarn);
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /setupFiles 'parallel' runs in list order in shared mode/);
  const v = cli(par, ['verify', '--mode', 'shared', '--orders', 'forward', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
});

// ---------------- S6 ----------------
test('S6 unit: the fallback walk of mode auto prunes excluded, build and dot directories', () => {
  assert.equal(prunedDir('dist', 'dist', []), true);
  assert.equal(prunedDir('pkg/.cache', '.cache', []), true);
  assert.equal(prunedDir('src/gen', 'gen', ['**/gen/**']), true);
  assert.equal(prunedDir('src', 'src', ['**/gen/**', '**/*.snap']), false);
  assert.equal(prunedDir('src', 'src', ['src/*.test.js']), false, 'an exclude of some files does not prune the directory');
  // the walk itself: tinyglobby is not resolvable from a directory without node_modules (cwd there too)
  const root = project({ 'src/a.test.js': pass, 'src/gen/g.test.js': pass, 'dist/d.test.js': pass, '.cache/c.test.js': pass, 'lib/l.test.js': pass }, { modules: 'none' });
  const code = `import(${JSON.stringify(pathToFileURL(path.join(pkgDir, 'src', 'auto.mjs')).href)}).then((m) => console.log(JSON.stringify(m.listTestFiles(process.cwd(), ['**/*.test.js'], ['**/node_modules/**', '**/gen/**']))))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ['lib/l.test.js', 'src/a.test.js']);
});
