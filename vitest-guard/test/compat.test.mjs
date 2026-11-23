// Vitest 4.1 vs 5 differences vitest-guard depends on (alpha.4 supports both; CI runs the lockfile's 5.x, the 4.1
// line is checked by running this suite against a Vitest 4.1 install).
//  - Vitest 4.1 batches the files of a vm project into ONE run request (= one vm context) when maxWorkers is 1;
//    Vitest 5 never batches vm pools. vitest-guard's plugin sets isolate: true there; the setup file refuses a shared
//    vm context.
//  - inline projects inherit the root config only with `extends: true` on Vitest 4, by default on Vitest 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, wrappedConfig, vitestRun, cli, integration, pkgDir } from './helpers.mjs';
import { defineVitestGuardConfig, vmFileIsolationPlugin, inheritsRoot, vitestMajor } from '../src/index.mjs';

const MAJOR = vitestMajor(pkgDir);
const PLUGIN = 'vitest-guard:vm-file-isolation';
const names = (plugins) => [].concat(plugins || []).map((p) => p?.name);
const withMajor = (m, fn) => { const old = process.env.VITEST_GUARD_VITEST_MAJOR; process.env.VITEST_GUARD_VITEST_MAJOR = String(m); try { return fn(); } finally { if (old === undefined) delete process.env.VITEST_GUARD_VITEST_MAJOR; else process.env.VITEST_GUARD_VITEST_MAJOR = old; } };

test('compat unit: the installed Vitest is a supported major (4 or 5)', () => {
  assert.ok(MAJOR === 4 || MAJOR === 5, `vitest major ${MAJOR}`);
});

test('compat unit: inline project inheritance follows the Vitest major', () => {
  for (const [p, v4, v5] of [[{}, false, true], [{ extends: true }, true, true], [{ extends: false }, false, false], [{ extends: './other.config.mjs' }, false, false]]) {
    assert.equal(inheritsRoot(p, 4), v4, `v4 ${JSON.stringify(p)}`);
    assert.equal(inheritsRoot(p, 5), v5, `v5 ${JSON.stringify(p)}`);
  }
  assert.equal(inheritsRoot({}, null), true, 'unknown version: Vitest 5 semantics');
});

test('compat unit: the vm-file-isolation plugin isolates vm projects with one worker on Vitest 4 only', () => {
  const proj = (pool, maxWorkers, isolate = pool.startsWith('vm') ? false : true) => ({ config: { pool, maxWorkers, isolate } });
  const run = (version, projects, root = {}) => { vmFileIsolationPlugin().configureVitest({ vitest: { version, projects, config: root } }); return projects.map((p) => p.config.isolate); };
  assert.deepEqual(run('4.1.8', [proj('vmThreads', 1), proj('vmForks', 1), proj('vmThreads', 4), proj('threads', 1, false), proj('forks', 1)]), [true, true, false, false, true]);
  assert.deepEqual(run('4.1.8', [proj('vmThreads', undefined)], { maxWorkers: 1 }), [true], 'root maxWorkers counts');
  assert.deepEqual(run('4.1.8', [proj('vmThreads', undefined)], { maxWorkers: 3 }), [false]);
  assert.deepEqual(run(undefined, [proj('vmThreads', 1)]), [true], 'unknown version: fail closed');
  assert.deepEqual(run('5.1.1', [proj('vmThreads', 1)]), [false], 'Vitest 5 does not batch vm files');
});

test('compat unit: the plugin is added on Vitest 4 (root and non-inheriting vm projects), not on Vitest 5', () => {
  const root = project({ 'src/a.test.js': '' });
  const single = (m) => withMajor(m, () => defineVitestGuardConfig({ root, plugins: [{ name: 'user' }], test: {} }, { verifyWarning: false }));
  assert.deepEqual(names(single(4).plugins), ['user', PLUGIN]);
  assert.deepEqual(names(single(5).plugins), ['user']);
  assert.deepEqual(names(withMajor(4, () => defineVitestGuardConfig({ root, test: {} }, { mode: 'shared', verifyWarning: false })).plugins), [], 'shared mode needs no plugin');
  const multi = (m) => withMajor(m, () => defineVitestGuardConfig({ root, test: { projects: [{ test: { name: 'own' } }, { extends: true, test: { name: 'inh' } }, { plugins: [{ name: 'p' }], test: { name: 'nodevm', pool: 'threads', isolate: false } }] } }, { verifyWarning: false }));
  const m4 = multi(4);
  assert.deepEqual(names(m4.plugins), [PLUGIN]);
  assert.deepEqual(m4.test.projects.map((p) => names(p.plugins)), [[PLUGIN], [], ['p']], 'v4: the non-inheriting vm project gets its own copy; an inheriting one and a shared one do not');
  const m5 = multi(5);
  assert.deepEqual(names(m5.plugins), []);
  assert.deepEqual(m5.test.projects.map((p) => names(p.plugins)), [[], [], ['p']]);
});

test('compat unit: root setup files reach an inline project exactly when Vitest itself inherits the root config', () => {
  const root = project({ 'src/a.test.js': '' });
  const cfg = (m) => withMajor(m, () => defineVitestGuardConfig({ root, test: { setupFiles: ['./root-setup.js'], projects: [{ test: { name: 'p' } }] } }, { verifyWarning: false }));
  assert.ok(cfg(5).test.projects[0].test.setupFiles.includes('./root-setup.js'), 'v5: inherits by default');
  assert.ok(!cfg(4).test.projects[0].test.setupFiles.includes('./root-setup.js'), 'v4: only with extends: true');
});

// every file checks that it starts clean and then pollutes: order-independent, red when two files share a realm
const polluter = (k) => `import { test, expect } from 'vitest';
const seen = [globalThis.__vgMark, document.title, String(globalThis.fetch).includes('mock')];
globalThis.__vgMark = '${k}'; document.title = '${k}'; globalThis.fetch = () => 'mock';
test('${k} starts in a fresh realm', () => { expect(seen).toEqual([undefined, '', false]); });\n`;
const files = { 'src/a.test.js': polluter('a'), 'src/b.test.js': polluter('b'), 'src/c.test.js': polluter('c') };

test('compat: vm mode with maxWorkers 1 gives every file a fresh realm (Vitest 4.1 batches vm files without the plugin)', integration, () => {
  const root = project({ 'package.json': '{"type":"module"}', 'vitest.config.mjs': wrappedConfig({ environment: 'jsdom', maxWorkers: 1 }, { mode: 'vm', verifyWarning: false }), ...files });
  const r = vitestRun(root);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'passed', 'src/c.test.js': 'passed' });
  // the CLI's single-worker lanes (verify forward / reversed) as well
  const v = cli(root, ['verify', '--mode', 'vm', '--orders', 'forward,reversed', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /false-green 0, false-red 0/);
});

test('compat: a vm project that does not inherit the root config still gets a fresh realm per file; root setup files follow Vitest\'s inheritance', integration, () => {
  const expected = MAJOR >= 5 ? 'root' : 'none';
  const root = project({
    'package.json': '{"type":"module"}',
    'root-setup.js': `globalThis.__vgRoot = 'root';\n`,
    'vitest.config.mjs': wrappedConfig({ setupFiles: ['./root-setup.js'], maxWorkers: 1, projects: [{ test: { name: 'dom', environment: 'jsdom', include: ['src/**/*.test.js'] } }] }, { mode: 'vm', verifyWarning: false }),
    ...files,
    'src/d.test.js': `import { test, expect } from 'vitest'; test('root setup', () => { expect(globalThis.__vgRoot ?? 'none').toBe(${JSON.stringify(expected)}); });\n`,
  }, { modules: 'real' }); // a project that does not inherit the root `server.fs.strict: false`: the setup copy must live inside the root
  const r = vitestRun(root);
  assert.equal(r.code, 0, r.out);
  assert.equal(Object.values(r.status).filter((s) => s === 'passed').length, 4, JSON.stringify(r.status));
});

test('compat: the setup file refuses a vm context shared by two test files (fail closed, without the plugin)', integration, async () => {
  const idx = path.join(pkgDir, 'src', 'index.mjs');
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': `import { defineVitestGuardConfig } from ${JSON.stringify(pathToFileURL(idx).href)};
const c = defineVitestGuardConfig({ server: { fs: { strict: false } }, test: { environment: 'jsdom', maxWorkers: 1 } }, { mode: 'vm', verifyWarning: false });
c.plugins = (c.plugins || []).filter((p) => p.name !== ${JSON.stringify(PLUGIN)});
export default c;\n`,
    ...files,
  });
  const { runVitest } = await import('../src/runner.mjs');
  const r = await runVitest({ root, tag: 'compat-shared-ctx' });
  const st = [...r.files.values()];
  if (MAJOR >= 5) { assert.equal(r.code, 0, r.log); assert.ok(st.length === 3 && st.every((f) => f.status === 'passed'), r.log); return; } // Vitest 5 never shares a vm context
  assert.notEqual(r.code, 0, r.log);
  assert.ok(st.some((f) => f.status === 'failed' && /runs in the same vm context as/.test(f.message || '')), r.log + JSON.stringify(st));
});
