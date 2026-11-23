import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
// Regression tests for SECURITY-REVIEW F8 (PoC 8), F9 (PoC 9), F12 and the projects support (ARCHITECTURE #10).
// Integration tests spawn real Vitest (devDependency); see test/helpers.mjs for the opt-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateTestPaths, privateTmp, readOwnedFile, validEdges, pickKnown } from '../src/safety.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
import { integration, vitestDir, VITEST_MAJOR } from './helpers.mjs'; // no silent skip: fails without vitest unless VITEST_GUARD_TEST_NO_INTEGRATION=1

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'vmg-test-'));
  for (const [f, src] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), src); }
  if (vitestDir) fs.symlinkSync(vitestDir, path.join(root, 'node_modules'));
  return root;
}
const quiet = (fn) => { const w = console.warn; const msgs = []; console.warn = (m) => msgs.push(String(m)); try { return [fn(), msgs]; } finally { console.warn = w; } };

// ---------------- F9 ----------------
test('F9: validateTestPaths accepts only literal, existing, included test files', () => {
  const root = project({ 'test/a.test.ts': '', 'scripts/release-helper.mjs': '', 'test/dir/b.test.ts': '' });
  fs.symlinkSync('/etc/passwd', path.join(root, 'test/evil.test.ts'));
  const include = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
  const [r, warns] = quiet(() => validateTestPaths(root, ['test/a.test.ts', 'test/dir/b.test.ts', 'scripts/release-helper.mjs', '../outside.test.ts', '/etc/x.test.ts',
    'test/../scripts/release-helper.mjs', './test/a.test.ts', 'test/*.test.ts', 'test\\a.test.ts', 'test/missing.test.ts', 'test/evil.test.ts', 42, 'C:/x.test.ts'], { include, exclude: ['**/dir/**'] }));
  assert.deepEqual(r.ok, ['test/a.test.ts']);
  const why = Object.fromEntries(r.rejected.map((x) => [String(x.entry), x.reason]));
  assert.match(why['scripts/release-helper.mjs'], /include/);
  assert.match(why['../outside.test.ts'], /normalized/);
  assert.match(why['/etc/x.test.ts'], /absolute/);
  assert.match(why['test/*.test.ts'], /glob/);
  assert.match(why['test/dir/b.test.ts'], /exclude/);
  assert.match(why['test/missing.test.ts'], /exist/);
  assert.match(why['test/evil.test.ts'], /outside/);
  assert.match(why['C:/x.test.ts'], /absolute/);
  assert.ok(warns.length >= 10);
});

test('F9 / PoC 9: quarantine entries never reach include (single project)', async () => {
  const root = project({ 'package.json': '{"type":"module"}', 'test/a.test.ts': '', 'scripts/release-helper.mjs': '',
    '.vitest-guard/incompatible.json': JSON.stringify({ version: 1, vm: { 'scripts/release-helper.mjs': {}, '../../etc/x.test.ts': {}, 'test/*.ts': {}, 'test/a.test.ts': {} }, shared: {} }) });
  const { defineVitestGuardConfig } = await importIndex();
  const [cfg, warns] = quiet(() => defineVitestGuardConfig({ root, test: { environment: 'node' } }, { mode: 'vm' }));
  const iso = cfg.test.projects.find((p) => p.test.name === 'vitest-guard:isolated');
  assert.deepEqual(iso.test.include, ['test/a.test.ts']);
  assert.ok(warns.some((w) => w.includes('release-helper') && w.includes('include')));
  assert.ok(!JSON.stringify(cfg.test.projects).includes('release-helper'));
});

test('F9: VITEST_GUARD_LANE_FILE entries are validated', async () => {
  const root = project({ 'test/a.test.ts': '', 'scripts/release-helper.mjs': '' });
  const lane = path.join(root, 'lane.json');
  fs.writeFileSync(lane, JSON.stringify(['scripts/release-helper.mjs', 'test/a.test.ts']));
  const { defineVitestGuardConfig } = await importIndex();
  process.env.VITEST_GUARD_LANE_FILE = lane;
  try {
    const [cfg] = quiet(() => defineVitestGuardConfig({ root, test: {} }, { mode: 'shared' }));
    assert.deepEqual(cfg.test.include, ['test/a.test.ts']);
    fs.writeFileSync(lane, JSON.stringify(['scripts/release-helper.mjs']));
    assert.throws(() => quiet(() => defineVitestGuardConfig({ root, test: {} }, { mode: 'shared' })), /no valid test file/);
  } finally { delete process.env.VITEST_GUARD_LANE_FILE; }
});

test('F9: conflict edges and per-file maps are restricted to listed files', () => {
  const files = ['t/a.test.ts', 't/b.test.ts'];
  assert.deepEqual(validEdges([{ a: 't/a.test.ts', b: 't/b.test.ts' }, { a: 'scripts/x.mjs', b: 't/a.test.ts' }, null, 'x', { a: 't/a.test.ts', b: 't/a.test.ts' }], files), [{ a: 't/a.test.ts', b: 't/b.test.ts' }]);
  assert.deepEqual(pickKnown({ 't/a.test.ts': 1, '/abs': 2, __proto__: { x: 1 } }, files), { 't/a.test.ts': 1 });
  assert.deepEqual(pickKnown(['t/a.test.ts'], files), {});
});

test('F9 / PoC 9 end to end: a non-test module listed in incompatible.json is not executed', integration, async () => {
  const root = project({
    'package.json': '{"type":"module","name":"p9"}',
    'vitest.config.mjs': `import { defineVitestGuardConfig } from '${pathToFileURL(path.join(here, '..', 'src', 'index.mjs')).href}';\nexport default defineVitestGuardConfig({ test: { environment: 'node' } }, { mode: 'vm' });\n`,
    'test/a.test.ts': `import { it, expect } from 'vitest';\nit('a', () => expect(1).toBe(1));\n`,
    'scripts/release-helper.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../PAYLOAD-RAN.txt', import.meta.url), 'ran');\n`,
    '.vitest-guard/incompatible.json': JSON.stringify({ version: 1, vm: { 'scripts/release-helper.mjs': { signature: 'x' } }, shared: {} }),
  });
  const { runVitest } = await import('../src/runner.mjs');
  const r = await runVitest({ root, config: path.join(root, 'vitest.config.mjs'), tag: 'poc9' });
  assert.equal(fs.existsSync(path.join(root, 'PAYLOAD-RAN.txt')), false, 'payload must not run');
  assert.equal(r.files.get('test/a.test.ts')?.status, 'passed');
  assert.match(r.log, /ignoring .*release-helper/);
});

// ---------------- F8 ----------------
test('F8: private temp dir is 0700 with an unpredictable name, removed on cleanup', { skip: process.platform === 'win32' && 'POSIX permission bits do not apply on Windows (per-user %TEMP% with ACLs)' }, () => {
  const a = privateTmp(), b = privateTmp();
  try {
    assert.notEqual(a.dir, b.dir);
    assert.equal(fs.statSync(a.dir).mode & 0o777, 0o700);
    assert.ok(!a.dir.includes(String(process.pid)), 'name must not be derived from the pid');
  } finally { a.cleanup(); b.cleanup(); }
  assert.equal(fs.existsSync(a.dir), false);
});

test('F8: readOwnedFile refuses symlinks, hard links and non-private directories', { skip: process.platform === 'win32' && 'POSIX permission bits do not apply on Windows (per-user %TEMP% with ACLs)' }, () => {
  const t = privateTmp();
  try {
    const victim = path.join(fs.realpathSync.native(os.tmpdir()), `vmg-victim-${Date.now()}.txt`);
    fs.writeFileSync(victim, 'secret');
    const link = t.file('link.json'); fs.symlinkSync(victim, link);
    assert.throws(() => readOwnedFile(link), /ELOOP|symbolic|not a regular/i);
    const hard = t.file('hard.json'); fs.linkSync(victim, hard);
    assert.throws(() => readOwnedFile(hard), /hard links/);
    const ok = t.file('ok.json'); fs.writeFileSync(ok, '{"a":1}');
    assert.equal(readOwnedFile(ok), '{"a":1}');
    fs.chmodSync(t.dir, 0o755);
    assert.throws(() => readOwnedFile(ok), /group\/others/);
    fs.rmSync(victim);
  } finally { t.cleanup(); }
});

test('F8 / PoC 8 end to end: planted files at the old predictable paths are neither clobbered nor read', integration, async () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': 'export default { test: { environment: "node" } };\n',
    'test/a.test.ts': `import { it, expect } from 'vitest';\nit('fails for real', () => expect(1).toBe(2));\n`,
  });
  // attacker: symlinks for every predictable name the old runner used (pid of this process, seq 1..5)
  const victim = path.join(root, 'notes.txt');
  fs.writeFileSync(victim, 'do not overwrite');
  const forged = path.join(root, 'forged.json');
  fs.writeFileSync(forged, JSON.stringify({ testResults: [{ name: path.join(root, 'test/a.test.ts'), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 'fails for real', status: 'passed', failureMessages: [] }] }] }));
  const planted = [];
  for (let i = 1; i <= 5; i++) for (const tag of ['poc8', 'run', 'check']) {
    const p = path.join(fs.realpathSync.native(os.tmpdir()), `vitest-guard-${process.pid}-${i}-${tag}.json`);
    try { fs.rmSync(p, { force: true }); fs.symlinkSync(i % 2 ? victim : forged, p); planted.push(p); } catch {}
  }
  try {
    const { runVitest } = await import('../src/runner.mjs');
    const r = await runVitest({ root, config: path.join(root, 'vitest.config.mjs'), tag: 'poc8' });
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do not overwrite');
    assert.equal(r.files.get('test/a.test.ts')?.status, 'failed', 'result must come from the real run, not the forged file');
  } finally { for (const p of planted) fs.rmSync(p, { force: true }); }
});

// ---------------- F12 ----------------
test('F12: a file that replaces a core matcher fails the next file in a shared worker', integration, async () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': `import { defineVitestGuardConfig } from '${pathToFileURL(path.join(here, '..', 'src', 'index.mjs')).href}';\nexport default defineVitestGuardConfig({ test: { environment: 'node' } }, { mode: 'shared' });\n`,
    'test/1-tamper.test.ts': `import { it, expect } from 'vitest';\nit('tampers', () => { const p = Object.getPrototypeOf(expect(0)); let o = p; while (o && !Object.getOwnPropertyDescriptor(o, 'toBe')) o = Object.getPrototypeOf(o); Object.defineProperty(o, 'toBe', { value: function () { return this; }, configurable: true, writable: true }); expect(1).toBe(1); });\n`,
    'test/2-gate.test.ts': `import { it, expect } from 'vitest';\nit('security gate', () => { expect('admin').toBe('guest'); });\n`,
  });
  const lane = path.join(root, 'lane.json');
  fs.writeFileSync(lane, JSON.stringify({ project: null, files: ['test/1-tamper.test.ts', 'test/2-gate.test.ts'] }));
  const { runVitest } = await import('../src/runner.mjs');
  const r = await runVitest({ root, config: path.join(root, 'vitest.config.mjs'), mode: 'shared', laneFile: lane, tag: 'f12' });
  assert.equal(r.files.get('test/2-gate.test.ts')?.status, 'failed');
  assert.match(r.files.get('test/2-gate.test.ts')?.message || '', /integrity: .*matcher\.toBe/);
  const off = await runVitest({ root, config: path.join(root, 'vitest.config.mjs'), mode: 'shared', laneFile: lane, env: { VITEST_GUARD_OPTS: '{"integrity":false}' }, tag: 'f12off' });
  assert.equal(off.files.get('test/2-gate.test.ts')?.status, 'passed', 'control: without the check the tampered matcher gives a false green');
});

// ---------------- projects (ARCHITECTURE #10) ----------------
test('projects: each inline project is wrapped, explicit pools kept, setup first, quarantine per project', async () => {
  const root = project({ 'tests/ui/a.test.tsx': '', 'tests/logic/b.test.ts': '', 'tests/logic/c.test.ts': '',
    '.vitest-guard/incompatible.json': JSON.stringify({ vm: { 'tests/logic/b.test.ts': {}, 'scripts/x.mjs': {} }, shared: {} }) });
  const { defineVitestGuardConfig, SETUP_FILE } = await importIndex();
  const user = { root, test: { setupFiles: ['./root-setup.ts'], projects: [
    { extends: true, test: { name: 'dom', environment: 'jsdom', pool: 'vmThreads', include: ['tests/ui/**/*.test.{ts,tsx}'] } },
    { extends: true, test: { name: 'node', environment: 'node', pool: 'forks', include: ['tests/**/*.test.ts'], exclude: ['tests/ui/**'] } },
    { test: { name: 'plain', include: ['tests/logic/**/*.test.ts'], setupFiles: ['./p.ts'] } },
    'packages/*',
  ] } };
  const [cfg, warns] = quiet(() => defineVitestGuardConfig(user));
  const byName = Object.fromEntries(cfg.test.projects.filter((p) => typeof p === 'object').map((p) => [p.test.name, p]));
  assert.equal(byName.dom.test.pool, 'vmThreads');
  assert.equal(byName.node.test.pool, 'forks', 'explicit isolated pool is kept');
  assert.equal(byName.plain.test.pool, 'vmThreads', 'no explicit pool -> guard mode (vm)');
  assert.deepEqual(byName.dom.test.setupFiles, [SETUP_FILE, './root-setup.ts']);
  // Vitest 5 inline projects inherit the root config unless `extends: false`; Vitest 4 only with `extends: true`
  if (VITEST_MAJOR >= 5) assert.deepEqual(byName.plain.test.setupFiles, [SETUP_FILE, './root-setup.ts', './p.ts'], 'v5: a project without `extends` inherits the root setup');
  else assert.deepEqual(byName.plain.test.setupFiles, [SETUP_FILE, './p.ts'], 'v4: non-extending project does not get root setup');
  assert.equal(cfg.test.setupFiles, undefined);
  assert.equal(byName.dom.test.provide.vitestGuard.mode, 'vm');
  assert.equal(byName.node.test.provide.vitestGuard.mode, 'isolated');
  assert.deepEqual(byName['plain:isolated'].test.include, ['tests/logic/b.test.ts']);
  assert.ok(byName.plain.test.exclude.includes('tests/logic/b.test.ts'));
  assert.equal(byName['node:isolated'], undefined, 'quarantine applies only to vm/shared projects');
  assert.ok(cfg.test.projects.includes('packages/*'));
  assert.ok(warns.some((w) => w.includes('packages/*')));
  assert.ok(warns.some((w) => w.includes('scripts/x.mjs')));
  assert.ok(typeof cfg.test.vmMemoryLimit === 'number');
  process.env.VITEST_GUARD_MODE = 'isolated';
  try {
    const [iso] = quiet(() => defineVitestGuardConfig(user));
    for (const p of iso.test.projects.filter((x) => typeof x === 'object')) assert.equal(p.test.pool, 'forks');
  } finally { delete process.env.VITEST_GUARD_MODE; }
});

test('projects: lane file keeps only the lane project and its validated files', async () => {
  const root = project({ 'tests/ui/a.test.tsx': '', 'tests/logic/b.test.ts': '' });
  const lane = path.join(root, 'lane.json');
  fs.writeFileSync(lane, JSON.stringify({ project: 'node', files: ['tests/logic/b.test.ts', 'tests/ui/a.test.tsx'] }));
  const { defineVitestGuardConfig } = await importIndex();
  process.env.VITEST_GUARD_LANE_FILE = lane; process.env.VITEST_GUARD_MODE = 'shared';
  try {
    const [cfg] = quiet(() => defineVitestGuardConfig({ root, test: { projects: [
      { extends: true, test: { name: 'dom', include: ['tests/ui/**/*.test.tsx'] } },
      { extends: true, test: { name: 'node', include: ['tests/**/*.test.ts'] } }] } }));
    assert.equal(cfg.test.projects.length, 1);
    assert.equal(cfg.test.projects[0].test.name, 'node');
    assert.deepEqual(cfg.test.projects[0].test.include, ['tests/logic/b.test.ts']);
    assert.equal(cfg.test.projects[0].test.isolate, false);
    assert.equal(cfg.test.maxWorkers, 1);
  } finally { delete process.env.VITEST_GUARD_LANE_FILE; delete process.env.VITEST_GUARD_MODE; }
});

async function importIndex() {
  // index.mjs imports the sequencer, which needs vitest/node; fall back to a stub when vitest is absent
  return import('../src/index.mjs');
}
