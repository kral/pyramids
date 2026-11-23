// State-file format versions (B2), symlinks and junctions in .vitest-guard/ (security S2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, cli, vitestRun, wrappedConfig, integration } from './helpers.mjs';
import { readQuarantine, readQuarantineFile } from '../src/index.mjs';
import { ctx, saveState, loadState, statePath, checkState } from '../src/cli.mjs';
import { clearRunLogs, ensureStateDir, readRunLogs } from '../src/logs.mjs';
import { writeStateFile, appendStateFile, readStateJson, safeDir } from '../src/statefs.mjs';

const WIN = process.platform === 'win32';
const mk = (files = {}) => project(files, { prefix: 'vmg-sfs-' });
const w = (root, f, txt) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), txt); };
// directory links: a junction on Windows (needs no privilege), a symlink elsewhere
const dirLink = (target, p) => fs.symlinkSync(target, p, 'junction');
const quiet = (fn) => { const l = console.log, wn = console.warn; let out = ''; console.log = console.warn = (...a) => { out += a.join(' ') + '\n'; }; try { fn(); } finally { console.log = l; console.warn = wn; } return out; };
const victimDir = () => {
  const v = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'vmg-victim-')));
  fs.writeFileSync(path.join(v, 'w-1-1.jsonl'), 'precious\n');
  fs.mkdirSync(path.join(v, 'logs')); fs.writeFileSync(path.join(v, 'logs', 'precious.txt'), 'keep');
  return v;
};
const listAll = (d) => fs.readdirSync(d, { recursive: true }).map(String).sort();

// ---------------- B2: format versions ----------------

test('B2: the CLI refuses a committed incompatible.json / conflicts.json with a newer format version (exit 2, untouched)', () => {
  for (const [name, cur] of [['incompatible.json', 2], ['conflicts.json', 1]]) {
    const body = JSON.stringify({ version: cur + 1, files: { 'test/a.test.ts': {} } });
    const root = mk({ [`.vitest-guard/${name}`]: body, 'package.json': '{}' });
    const r = cli(root, ['check']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`\\.vitest-guard/${name.replace('.', '\\.')} has format version ${cur + 1}; this @jirikral/vitest-guard \\([^)]+\\) understands version ${cur} - upgrade`));
    assert.match(r.out, /Nothing was run or written/);
    assert.equal(fs.readFileSync(path.join(root, '.vitest-guard', name), 'utf8'), body);
  }
});

test('B2: a missing version counts as 1; writers always stamp the current version; a newer file is never overwritten', () => {
  const root = mk();
  const c = ctx({ _: ['check'], root });
  w(root, '.vitest-guard/incompatible.json', JSON.stringify({ vm: { 'a.test.ts': {} }, extra: 'kept' }));
  assert.equal(checkState(c), null);
  const q = loadState(c, 'incompatible.json', {});
  q.shared = {};
  saveState(c, 'incompatible.json', q);
  const saved = JSON.parse(fs.readFileSync(statePath(c, 'incompatible.json'), 'utf8'));
  assert.equal(Object.keys(saved)[0], 'version');
  assert.deepEqual(saved, { version: 2, vm: { 'a.test.ts': {} }, extra: 'kept', shared: {} }); // unknown fields survive; version 1 is written as 2 (alpha.3)
  saveState(c, 'conflicts.json', { edges: [] });
  assert.equal(JSON.parse(fs.readFileSync(statePath(c, 'conflicts.json'), 'utf8')).version, 1);
  // a newer file on disk (written meanwhile by a newer vitest-guard) is not rewritten in the old shape
  w(root, '.vitest-guard/conflicts.json', JSON.stringify({ version: 7, edges: [] }));
  assert.throws(() => saveState(c, 'conflicts.json', { version: 1, edges: [{ a: 'x', b: 'y' }] }), (e) => e.code === 'E_STATE_VERSION' && /version 7/.test(e.message));
  assert.equal(JSON.parse(fs.readFileSync(statePath(c, 'conflicts.json'), 'utf8')).version, 7);
  // invalid versions are refused as well
  w(root, '.vitest-guard/conflicts.json', JSON.stringify({ version: '2.0', edges: [] }));
  assert.match(checkState(c), /format version "2\.0"/);
  fs.rmSync(path.join(root, '.vitest-guard/conflicts.json'));
});

test('B2 / S3 (review 3b): a newer incompatible.json stops the config (fail closed); VITEST_GUARD_NEWER_STATE=failsafe runs every file it names isolated', () => {
  const root = mk({ 'test/a.test.ts': '', 'test/b.test.ts': '', 'test/c.test.ts': '' });
  w(root, '.vitest-guard/incompatible.json', JSON.stringify({ version: 3, quarantine: [{ file: 'test/a.test.ts', modes: ['vm'] }, { file: 'test/b.test.ts', modes: ['shared'] }], note: 'x' }));
  assert.throws(() => readQuarantineFile(root), /has format version 3; this @jirikral\/vitest-guard .* understands version 2 - upgrade .*VITEST_GUARD_NEWER_STATE=failsafe.*refuses to run/s);
  const old = process.env.VITEST_GUARD_NEWER_STATE;
  process.env.VITEST_GUARD_NEWER_STATE = 'failsafe';
  try {
    let q;
    const out = quiet(() => { q = readQuarantineFile(root); });
    assert.match(out, /Failing safe \(VITEST_GUARD_NEWER_STATE=failsafe\): the 2 test file\(s\) it names run isolated/);
    assert.equal(q.newer, true);
    for (const mode of ['vm', 'shared']) quiet(() => assert.deepEqual(readQuarantine(root, mode).sort(), ['test/a.test.ts', 'test/b.test.ts']));
    // S3: a newer file that names no existing test file cannot fail safe: it still stops the config
    w(root, '.vitest-guard/incompatible.json', JSON.stringify({ version: 3, entries: [{ path: './test/a.test.ts' }] }));
    assert.throws(() => readQuarantineFile(root), /names no existing test file/);
  } finally { if (old === undefined) delete process.env.VITEST_GUARD_NEWER_STATE; else process.env.VITEST_GUARD_NEWER_STATE = old; }
});

test('B2 end to end: plain `vitest run` with a newer incompatible.json exits 1 (config error); with failsafe the named file runs in isolated forks', integration, () => {
  const probe = (name) => `import { test, expect, inject } from 'vitest';\ntest('${name}', () => { globalThis.__mode = inject('vitestGuard').mode; expect(1).toBe(1); });\ntest('${name} mode', () => { expect(globalThis.__mode).toBe(${name === 'a' ? "'isolated'" : "'vm'"}); });\n`;
  const root = project({
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.mjs'], environment: 'node' }, { verifyWarning: false }),
    'test/a.test.mjs': probe('a'), 'test/b.test.mjs': probe('b'),
    '.vitest-guard/incompatible.json': JSON.stringify({ version: 3, entries: { 'test/a.test.mjs': { reason: 'x' } } }),
  });
  const r0 = vitestRun(root);
  assert.equal(r0.code, 1, r0.out);
  assert.deepEqual(r0.status, {});
  assert.match(r0.out, /format version 3.*refuses to run/s);
  const r = vitestRun(root, [], { env: { VITEST_GUARD_NEWER_STATE: 'failsafe' } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'test/a.test.mjs': 'passed', 'test/b.test.mjs': 'passed' });
  assert.match(r.out, /format version 3.*Failing safe/s);
});

// ---------------- S2: symlinks / junctions in .vitest-guard/ ----------------

test('S2: a symlinked / junctioned .vitest-guard/run is refused: nothing is deleted, moved or written in the target', () => {
  const victim = victimDir();
  const root = mk({ 'package.json': '{}', '.vitest-guard/compare.json': '{}' });
  dirLink(victim, path.join(root, '.vitest-guard', 'run'));
  const before = listAll(victim);
  const r = cli(root, ['check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard\/run is a symbolic link or junction - refusing to follow it/);
  assert.deepEqual(listAll(victim), before);
  assert.equal(fs.readFileSync(path.join(victim, 'w-1-1.jsonl'), 'utf8'), 'precious\n');
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard', 'compare.json')));
  // the library helpers refuse on their own as well (no reliance on the CLI's up-front check)
  const c = ctx({ _: ['check'], root });
  assert.throws(() => clearRunLogs(c.runDir), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => ensureStateDir(c.stateDir), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => saveState(c, 'compare.json', { version: 2 }), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => readRunLogs(c.runDir), (e) => e.code === 'E_UNSAFE_STATE');
    assert.deepEqual(listAll(victim), before);
});

test('S2: a symlinked / junctioned .vitest-guard/run/logs is never deleted recursively', () => {
  const victim = victimDir();
  const root = mk({ 'package.json': '{}' });
  fs.mkdirSync(path.join(root, '.vitest-guard', 'run'), { recursive: true });
  dirLink(path.join(victim, 'logs'), path.join(root, '.vitest-guard', 'run', 'logs'));
  const r = cli(root, ['check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard\/run\/logs is a symbolic link or junction/);
  assert.throws(() => clearRunLogs(path.join(root, '.vitest-guard', 'run', 'logs')), (e) => e.code === 'E_UNSAFE_STATE');
  assert.equal(fs.readFileSync(path.join(victim, 'logs', 'precious.txt'), 'utf8'), 'keep');
});

test('S2 / R3: a symlinked .vitest-guard itself is refused, also by the config wrapper (config error, never a silent fast run)', () => {
  const victim = victimDir();
  w(victim, 'incompatible.json', JSON.stringify({ vm: { 'test/a.test.ts': {} } }));
  const root = mk({ 'package.json': '{}', 'test/a.test.ts': '' });
  dirLink(victim, path.join(root, '.vitest-guard'));
  const r = cli(root, ['check']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard is a symbolic link or junction/);
  // R3 (review 3b): the config wrapper does not run quarantined files fast either: it refuses to load (Vitest exits 1)
  assert.throws(() => readQuarantine(root, 'vm'), /is a symbolic link or junction - refusing to follow it.*refuses to run/s);
});

test('S2: state files: no write, append or read through a symlinked file; private modes', { skip: WIN && 'file symlinks need a privilege on Windows (directory junctions are covered above)' }, () => {
  const victim = victimDir();
  const root = mk();
  const run = path.join(root, '.vitest-guard', 'run');
  ensureStateDir(run);
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(run, '.gitignore')).mode & 0o777, 0o600);
  fs.symlinkSync(path.join(victim, 'w-1-1.jsonl'), path.join(run, 'compare.json'));
  fs.symlinkSync(path.join(victim, 'w-1-1.jsonl'), path.join(run, 'env-1-1.jsonl'));
  fs.symlinkSync(path.join(victim, 'nope'), path.join(run, 'dangling.json'));
  assert.throws(() => writeStateFile(path.join(run, 'compare.json'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => appendStateFile(path.join(run, 'env-1-1.jsonl'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => writeStateFile(path.join(run, 'dangling.json'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => readStateJson(path.join(run, 'compare.json'), null), (e) => e.code === 'E_UNSAFE_STATE');
  assert.equal(fs.readFileSync(path.join(victim, 'w-1-1.jsonl'), 'utf8'), 'precious\n');
  assert.ok(!fs.existsSync(path.join(victim, 'nope')));
  // a dangling .gitignore link is not written through either
  const run2 = path.join(mk(), '.vitest-guard', 'run');
  fs.mkdirSync(run2, { recursive: true, mode: 0o755 });
  fs.symlinkSync(path.join(victim, 'gi'), path.join(run2, '.gitignore'));
  assert.throws(() => ensureStateDir(run2), (e) => e.code === 'E_UNSAFE_STATE');
  assert.ok(!fs.existsSync(path.join(victim, 'gi')));
  assert.equal(fs.statSync(run2).mode & 0o777, 0o700); // our own wider directory is narrowed
  writeStateFile(path.join(run, 'files-cache.json'), '{}');
  assert.equal(fs.statSync(path.join(run, 'files-cache.json')).mode & 0o777, 0o600);
  assert.equal(safeDir(path.join(root, '.vitest-guard', 'run', 'logs'), { create: false }), false);
});

test('S2 end to end: test workers write no run logs through a junctioned .vitest-guard/run; the run still passes', integration, () => {
  const victim = victimDir();
  const root = project({
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.mjs'], environment: 'node' }, { mode: 'shared', verifyWarning: false }),
    'test/a.test.mjs': "import { test, expect } from 'vitest';\ntest('a', () => expect(1).toBe(1));\n",
  });
  fs.mkdirSync(path.join(root, '.vitest-guard'));
  dirLink(victim, path.join(root, '.vitest-guard', 'run'));
  const before = listAll(victim);
  const r = vitestRun(root, ['--reporter=default']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.vitest-guard[\\/]run is a symbolic link or junction - refusing to follow it.*this worker writes no vitest-guard state/);
  assert.deepEqual(listAll(victim), before);
});
