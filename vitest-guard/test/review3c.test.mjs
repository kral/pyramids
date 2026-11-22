// Regression tests for the re-review of the correctness fixes (review 3, round c): R1-R6, the case-mismatched
// quarantine key (item 3), S1, S3 (in statefs.test.mjs), S4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, wrappedConfig, cli, vitestRun, integration, readJson } from './helpers.mjs';
import { readQuarantineFile } from '../src/index.mjs';
import { listTestFiles } from '../src/auto.mjs';
import { validateTestPaths, matchesGlobDot } from '../src/safety.mjs';
import VitestGuardSequencer from '../src/sequencer.mjs';

const pass = `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`;
const bad = `import { test, expect } from 'vitest'; test('bad', () => { expect(1).toBe(2); });\n`;
const fgFile = `import { test, expect } from 'vitest'; import { isMainThread } from 'node:worker_threads'; test('fg', () => { expect(isMainThread).toBe(false); });\n`;
const P = (files, t = {}, guard = {}, o = {}) => project({ 'vitest.config.mjs': wrappedConfig(t, guard), 'package.json': '{"type":"module"}', ...files }, o);
const pkg = (root, name, files) => { for (const [f, s] of Object.entries(files)) { const p = path.join(root, 'node_modules', name, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); } };
const runLog = (root) => { const d = path.join(root, '.vitest-guard/run/logs'); return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); };
const quiet = (fn) => { const w = console.warn; let out = ''; console.warn = (...a) => { out += a.join(' ') + '\n'; }; try { return [fn(), out]; } finally { console.warn = w; } };
const one = { maxWorkers: 1, fileParallelism: false };

// ---------------- R1 ----------------
test('R1: env set by a package a setup file imports (dotenv/config pattern) survives the resets in shared mode; no dirty starts', integration, () => {
  const root = P({
    'setup.js': `import 'fake-dotenv/config';\nimport 'fake-instrument';\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; test('a', () => { expect(process.env.API_URL).toBe('http://x'); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; test('b', () => { expect(process.env.API_URL).toBe('http://x'); });\n`,
    'src/c.test.js': `import { test, expect } from 'vitest'; test('c', () => { expect(process.env.API_URL).toBe('http://x'); expect(process.__instrumented).toBe(true); });\n`,
  }, { setupFiles: ['./setup.js'], ...one }, { mode: 'shared', onDirty: 'error' }, { modules: 'real' });
  pkg(root, 'fake-dotenv', { 'package.json': '{"name":"fake-dotenv","version":"1.0.0"}', 'config.js': `process.env.API_URL = 'http://x';\n` });
  pkg(root, 'fake-instrument', { 'package.json': '{"name":"fake-instrument","version":"1.0.0"}', 'index.js': `process.on('warning', () => {}); process.__instrumented = true;\n` });
  const r = vitestRun(root, [], { env: { VITEST_GUARD_VERIFY_WARNING: '0' } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'passed', 'src/c.test.js': 'passed' });
  assert.deepEqual(runLog(root).filter((x) => x.dirty), [], 'state of a once-per-worker setup package is not blamed on a test file');
  const v = cli(root, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 0, v.out);
});

// ---------------- R2 ----------------
test('R2: an equality tester a node_modules package registers on import stays for the whole shared worker', integration, () => {
  const money = `import 'money-matchers';\nexport class Money { #a; constructor(a) { this.#a = a; } get amount() { return this.#a; } }\n`;
  const root = P({
    'src/money.js': money,
    'src/a.test.js': `import { test, expect } from 'vitest'; import { Money } from './money.js'; test('a', () => { expect(new Money(1)).toEqual(new Money(1)); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; import { Money } from './money.js'; test('b', () => { expect(new Money(1)).not.toEqual(new Money(2)); });\n`,
    'src/c.test.js': `import { test, expect } from 'vitest'; import { Money } from './money.js'; test('c: wrong', () => { expect(new Money(1)).toEqual(new Money(2)); });\n`,
  }, one, { mode: 'shared' }, { modules: 'real' });
  pkg(root, 'money-matchers', { 'package.json': '{"name":"money-matchers","version":"1.0.0","type":"module","main":"index.js"}',
    'index.js': `import { expect } from 'vitest';\nexpect.addEqualityTesters([(a, b) => (a && b && a.constructor?.name === 'Money' && b.constructor?.name === 'Money' ? a.amount === b.amount : undefined)]);\n` });
  const r = vitestRun(root, [], { env: { VITEST_GUARD_VERIFY_WARNING: '0' } });
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'passed', 'src/c.test.js': 'failed' }, r.out);
  const c = cli(root, ['check', '--mode', 'shared']);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /FAIL \(also isolated\): src\/c\.test\.js/);
});

// ---------------- R3 ----------------
test('R3 unit: an unusable incompatible.json throws (not JSON, wrong shape, symlink) instead of reading as "no quarantine"', () => {
  const root = project({ 'src/a.test.js': '' });
  const f = path.join(root, '.vitest-guard/incompatible.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const good = JSON.stringify({ version: 1, vm: { 'src/a.test.js': {} }, shared: {} }, null, 2);
  fs.writeFileSync(f, `<<<<<<< HEAD\n${good}\n=======\n${good}\n>>>>>>> branch\n`);
  assert.throws(() => readQuarantineFile(root), /not valid JSON \(merge-conflict markers\).*refuses to run/s);
  for (const body of ['[]', '"x"', JSON.stringify({ vm: ['src/a.test.js'] }), JSON.stringify({ shared: null })]) {
    fs.writeFileSync(f, body);
    assert.throws(() => readQuarantineFile(root), /refuses to run/, body);
  }
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(root, 'q.json'), good);
    fs.rmSync(f); fs.symlinkSync('../q.json', f);
    assert.throws(() => readQuarantineFile(root), /symbolic link or junction.*refuses to run/s);
  }
  fs.rmSync(f); assert.deepEqual(readQuarantineFile(root), {}, 'a missing file is no quarantine');
});

test('R3: an unparsable or wrong-shaped incompatible.json fails `vitest run` (exit 1) and `check` (exit 2, file untouched)', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/fg.test.js': fgFile }, {}, { verifyWarning: false });
  const v = cli(root, ['verify']);
  assert.equal(v.code, 5, v.out);
  const f = path.join(root, '.vitest-guard/incompatible.json');
  const good = fs.readFileSync(f, 'utf8');
  for (const body of [`<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> branch\n`, JSON.stringify({ version: 1, vm: ['src/fg.test.js'], shared: {} })]) {
    fs.writeFileSync(f, body);
    const r = vitestRun(root);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.status, {}, 'nothing ran fast');
    assert.match(r.out, /refuses to run/);
    const c = cli(root, ['check']);
    assert.equal(c.code, 2, c.out);
    assert.match(c.out, /incompatible\.json (is not valid JSON|"vm" must be an object)/);
    assert.equal(fs.readFileSync(f, 'utf8'), body, 'never overwritten');
  }
});

// ---------------- R4 ----------------
test('R4 unit: the lane sequencer ranks by the lane base, not by a project root, and refuses files that are not in the lane', async () => {
  const root = project({});
  const lane = path.join(root, 'lane.json');
  fs.writeFileSync(lane, JSON.stringify({ project: 'a', base: root, files: ['packages/a/src/z.test.js', 'packages/a/src/m.test.js', 'packages/a/src/b.test.js'] }));
  const spec = (f) => ({ moduleId: path.join(root, f), project: { config: { root: path.join(root, 'packages/a') } } });
  const old = process.env.VITEST_GUARD_LANE_FILE;
  process.env.VITEST_GUARD_LANE_FILE = lane;
  try {
    const s = new VitestGuardSequencer({ config: { root } });
    const out = await s.sort(['packages/a/src/b.test.js', 'packages/a/src/m.test.js', 'packages/a/src/z.test.js'].map(spec));
    assert.deepEqual(out.map((x) => path.relative(root, x.moduleId).split(path.sep).join('/')), ['packages/a/src/z.test.js', 'packages/a/src/m.test.js', 'packages/a/src/b.test.js']);
    await assert.rejects(() => s.sort([spec('packages/a/src/other.test.js')]), /not in the lane file/);
  } finally { if (old === undefined) delete process.env.VITEST_GUARD_LANE_FILE; else process.env.VITEST_GUARD_LANE_FILE = old; }
});

test('R4: verify runs the reversed order for a project with its own root (finds the false green)', integration, () => {
  const root = P({
    'packages/a/src/m.test.js': pass,
    'packages/a/src/z.test.js': `import { test, expect } from 'vitest'; test('z', () => { process.__rvZ = 1; expect(1).toBe(1); });\n`,
    'packages/a/src/b.test.js': `import { test, expect } from 'vitest'; test('b needs z', () => { expect(process.__rvZ).toBe(1); });\n`,
  }, { projects: [{ test: { name: 'a', root: 'packages/a', include: ['src/**/*.test.js'] } }] }, { mode: 'shared' });
  const r = cli(root, ['verify', '--no-quarantine', '--orders', 'forward,reversed']);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /FALSE GREEN.*packages\/a\/src\/b\.test\.js > b needs z {2}\[order: reversed\]/);
  assert.doesNotMatch(r.out, /ORDER MISMATCH/);
  const starts = runLog(root).filter((x) => x.t === 'start' && x.lane === 'lane-verify-reversed-0.json').map((x) => x.file);
  assert.deepEqual(starts, ['packages/a/src/z.test.js', 'packages/a/src/m.test.js', 'packages/a/src/b.test.js']);
});

// ---------------- R5 ----------------
test('R5 unit: auto lists files as Vitest globs them (./ patterns, symlinked directories, nested dot directories)', () => {
  const root = project({ 'src/a.test.js': '', 'tests/b.test.js': '', 'shared-tests/c.test.js': '', '.a/.b/d.test.js': '' });
  fs.symlinkSync('../shared-tests', path.join(root, 'src/linked'), 'junction');
  assert.deepEqual(listTestFiles(root, ['./src/**/*.test.js', 'tests/**/*.test.js', '.a/**/*.test.js'], ['**/node_modules/**']),
    ['.a/.b/d.test.js', 'src/a.test.js', 'src/linked/c.test.js', 'tests/b.test.js']);
  assert.equal(matchesGlobDot('src/a.test.js', './src/**/*.test.js'), true);
});

test('R5: mode auto drops no test file Vitest runs (./ include, symlinked test directory); anything unclassified runs isolated', integration, () => {
  const root = P({ 'tests/a.test.js': pass, 'src/bad.test.js': bad, 'shared-tests/bad2.test.js': bad },
    { include: ['./src/**/*.test.js', 'tests/**/*.test.js'] }, { mode: 'auto', verifyWarning: false });
  fs.symlinkSync('../shared-tests', path.join(root, 'src/linked'), 'junction');
  const expected = { 'src/bad.test.js': 'failed', 'src/linked/bad2.test.js': 'failed', 'tests/a.test.js': 'passed' };
  assert.deepEqual(vitestRun(root, [], { env: { VITEST_GUARD_MODE: 'off' } }).status, expected);
  for (const env of [{}, { VITEST_GUARD_MODE: 'isolated' }]) {
    const r = vitestRun(root, [], { env });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.status, expected, JSON.stringify(env));
  }
  const c = cli(root, ['check', '--no-calibrate']);
  assert.equal(c.code, 1, c.out);
  // the catch-all group: present, isolated, empty here
  assert.equal(readJson(path.join(root, '.vitest-guard/run/auto.json')).groups['auto:rest'], 'isolated');
});

// ---------------- R6 ----------------
test('R6: a quarantine entry of a project with its own root, or under a ./ include, really runs isolated afterwards', integration, () => {
  for (const [files, t] of [
    [{ 'packages/a/src/a.test.js': pass, 'packages/a/src/fg.test.js': fgFile }, { projects: [{ test: { name: 'a', root: 'packages/a', include: ['src/**/*.test.js'] } }] }],
    [{ 'src/a.test.js': pass, 'src/fg.test.js': fgFile }, { include: ['./src/**/*.test.js'] }],
  ]) {
    const root = P(files, t, { verifyWarning: false });
    const v = cli(root, ['verify']);
    assert.equal(v.code, 5, v.out);
    assert.doesNotMatch(v.out, /QUARANTINE NOT APPLIED/);
    const r = vitestRun(root);
    assert.equal(r.code, 1, r.out);
    assert.equal(Object.entries(r.status).find(([f]) => f.endsWith('fg.test.js'))[1], 'failed', 'the false-green file runs in forks, where it fails');
    assert.doesNotMatch(r.out, /ignoring .*incompatible\.json/);
    const c = cli(root, ['check']);
    assert.equal(c.code, 1, c.out);
    assert.match(c.out, /FAIL \(also isolated\): .*fg\.test\.js/);
  }
});

test('R6: check fails when the config does not apply a quarantine entry (quarantine never silently ignored)', integration, () => {
  // the config reads another quarantine file than the CLI writes: its entries are not applied
  const root = P({ 'src/a.test.js': pass, 'src/fg.test.js': fgFile }, {}, { quarantineFile: '.vitest-guard/other.json', verifyWarning: false });
  const v = cli(root, ['verify']);
  assert.equal(v.code, 5, v.out);
  assert.match(v.out, /QUARANTINE NOT APPLIED: the config still runs src\/fg\.test\.js in a fast mode/);
  assert.match(v.out, /INCOMPLETE: quarantine not applied/);
  const c = cli(root, ['check']);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /QUARANTINE NOT APPLIED: src\/fg\.test\.js/);
});

test('N2 / R6: a stale false-green entry fails check until --prune removes it (exit 4)', integration, () => {
  const root = P({ 'src/a.test.js': pass, '.vitest-guard/incompatible.json': JSON.stringify({ version: 1, vm: { 'src/gone.test.js': { falseGreen: true, signature: 'x' } }, shared: { 'src/old.test.js': { signature: 'y' } } }) }, {}, { verifyWarning: false });
  const c = cli(root, ['check']);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /STALE quarantine entry \(vm\): src\/gone\.test\.js .*guarded a false green/);
  const p = cli(root, ['check', '--prune']);
  assert.equal(p.code, 4, p.out);
  assert.match(p.out, /REMOVED stale quarantine entry \(vm.*src\/gone\.test\.js/);
  const q = readJson(path.join(root, '.vitest-guard/incompatible.json'));
  assert.deepEqual([q.vm, q.shared], [{}, {}]);
  assert.equal(cli(root, ['check']).code, 0);
});

// ---------------- item 3: case / Unicode form of a quarantine key ----------------
test('item 3: a quarantine key spelled differently from the file on disk is applied to that file (warning); check rewrites the key', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/Fg.test.js': fgFile }, {}, { verifyWarning: false });
  assert.equal(cli(root, ['verify']).code, 5);
  fs.renameSync(path.join(root, 'src/Fg.test.js'), path.join(root, 'src/fg.tmp'));
  fs.renameSync(path.join(root, 'src/fg.tmp'), path.join(root, 'src/fg.test.js')); // stands in for NTFS/APFS spelling
  const r = vitestRun(root);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.status['src/fg.test.js'], 'failed', 'runs isolated (fails there), not fast');
  assert.match(r.out, /entry "src\/Fg\.test\.js" is spelled differently on disk .*applied to "src\/fg\.test\.js"/);
  const c = cli(root, ['check']);
  assert.match(c.out, /RE-SPELLED quarantine key \(vm\): src\/Fg\.test\.js -> src\/fg\.test\.js/);
  assert.deepEqual(Object.keys(readJson(path.join(root, '.vitest-guard/incompatible.json')).vm), ['src/fg.test.js']);
});

test('item 3 unit: NFC/NFD and case are folded when matching quarantine keys against the globbed files', () => {
  const name = 'příklad'.normalize('NFC');
  const root = project({ [`src/${name}.test.js`]: '' });
  const [r, out] = quiet(() => validateTestPaths(root, [`SRC/${'příklad'.normalize('NFD').toUpperCase()}.test.js`], { files: [`src/${name}.test.js`], label: 'q' }));
  assert.deepEqual(r.ok, [`src/${name}.test.js`]);
  assert.match(out, /spelled differently on disk/);
});

// ---------------- S1 ----------------
test('S1: the same file in two projects: a failure in one project is not overwritten by a pass in the other', integration, () => {
  const root = P({ 'src/a.test.js': pass,
    'src/x.test.js': `import { test, expect, inject } from 'vitest'; import { isMainThread } from 'node:worker_threads'; test('x', () => { if (inject('strict')) expect(isMainThread).toBe(false); });\n` },
  { projects: [{ test: { name: 'p1', include: ['src/**/*.test.js'], provide: { strict: true } } }, { test: { name: 'p2', include: ['src/**/*.test.js'], provide: { strict: false } } }] });
  const v = cli(root, ['verify', '--no-quarantine']);
  assert.equal(v.code, 5, v.out);
  assert.match(v.out, /FALSE GREEN.*src\/x\.test\.js > x/);
});

// ---------------- S4 ----------------
test('S4: without resetModules an interval of a cached project module keeps running (as in forks); test-file intervals are still cleared', integration, () => {
  const root = P({
    'src/poller.js': `export const state = { ticks: 0 }; setInterval(() => { state.ticks++; }, 1);\n`,
    ...Object.fromEntries(['a', 'b'].map((me) => { const other = me === 'a' ? 'b' : 'a'; return [`src/${me}.test.js`, `import { test, expect } from 'vitest'; import { state } from './poller.js';
setInterval(() => { globalThis.__own_${me} = (globalThis.__own_${me} || 0) + 1; }, 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test('poller alive', async () => { const t0 = state.ticks; await wait(30); expect(state.ticks).toBeGreaterThan(t0); });
test('own interval of the other file is gone', async () => { const t0 = globalThis.__own_${other} || 0; await wait(30); expect(globalThis.__own_${other} || 0).toBe(t0); });\n`]; })),
  }, { ...one, sequence: { shuffle: false } }, { mode: 'shared', resetModules: false, verifyWarning: false });
  const r = vitestRun(root);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'src/a.test.js': 'passed', 'src/b.test.js': 'passed' });
});
