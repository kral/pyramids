// Review 3: state-file format versions (architecture B2), migrateState and committed files (S3), symlinks and
// junctions in .vitest-guard/ (security S2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, cli, vitestRun, wrappedConfig, integration } from './helpers.mjs';
import { readQuarantine, readQuarantineFile } from '../src/index.mjs';
import { ctx, saveState, loadState, statePath, migrateState, checkState } from '../src/cli.mjs';
import { clearRunLogs, ensureStateDir, readRunLogs } from '../src/logs.mjs';
import { writeStateFile, appendStateFile, readStateJson, safeDir } from '../src/statefs.mjs';

const WIN = process.platform === 'win32';
const mk = (files = {}) => project(files, { prefix: 'vmg-sfs-' });
const w = (root, f, txt) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), txt); };
// directory links: a junction on Windows (needs no privilege), a symlink elsewhere
const dirLink = (target, p) => fs.symlinkSync(target, p, 'junction');
const quiet = (fn) => { const l = console.log, wn = console.warn; let out = ''; console.log = console.warn = (...a) => { out += a.join(' ') + '\n'; }; try { fn(); } finally { console.log = l; console.warn = wn; } return out; };
const victimDir = () => {
  const v = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-victim-')));
  fs.writeFileSync(path.join(v, 'w-1-1.jsonl'), 'precious\n');
  fs.mkdirSync(path.join(v, 'logs')); fs.writeFileSync(path.join(v, 'logs', 'precious.txt'), 'keep');
  return v;
};
const listAll = (d) => fs.readdirSync(d, { recursive: true }).map(String).sort();

// ---------------- B2: format versions ----------------

test('B2: the CLI refuses a committed incompatible.json / conflicts.json with a newer format version (exit 2, untouched)', () => {
  for (const name of ['incompatible.json', 'conflicts.json']) {
    const body = JSON.stringify({ version: 2, files: { 'test/a.test.ts': {} } });
    const root = mk({ [`.vitest-guard/${name}`]: body, 'package.json': '{}' });
    const r = cli(root, ['report']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`\\.vitest-guard/${name.replace('.', '\\.')} has format version 2; this @jirikral/vitest-guard \\([^)]+\\) understands version 1 - upgrade`));
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
  assert.deepEqual(saved, { version: 1, vm: { 'a.test.ts': {} }, extra: 'kept', shared: {} }); // unknown fields survive
  saveState(c, 'conflicts.json', { edges: [] });
  assert.equal(JSON.parse(fs.readFileSync(statePath(c, 'conflicts.json'), 'utf8')).version, 1);
  // a newer file on disk (written meanwhile by a newer vitest-guard) is not rewritten in the old shape
  w(root, '.vitest-guard/conflicts.json', JSON.stringify({ version: 7, edges: [] }));
  assert.throws(() => saveState(c, 'conflicts.json', { version: 1, edges: [{ a: 'x', b: 'y' }] }), (e) => e.code === 'E_STATE_VERSION' && /version 7/.test(e.message));
  assert.equal(JSON.parse(fs.readFileSync(statePath(c, 'conflicts.json'), 'utf8')).version, 7);
  // invalid versions are refused as well; a newer volatile plan.json is ignored (re-planned), not misread
  w(root, '.vitest-guard/conflicts.json', JSON.stringify({ version: '2.0', edges: [] }));
  assert.match(checkState(c), /format version "2\.0"/);
  fs.rmSync(path.join(root, '.vitest-guard/conflicts.json'));
  saveState(c, 'plan.json', { version: 99, lanes: [] });
  assert.equal(loadState(c, 'plan.json', null), null);
  saveState(c, 'plan.json', { version: 2, lanes: [] });
  assert.deepEqual(loadState(c, 'plan.json', null), { version: 2, lanes: [] });
});

test('B2: the config wrapper fails safe on a newer incompatible.json: every file it names runs isolated, with a warning', () => {
  const root = mk({ 'test/a.test.ts': '', 'test/b.test.ts': '', 'test/c.test.ts': '' });
  w(root, '.vitest-guard/incompatible.json', JSON.stringify({ version: 2, quarantine: [{ file: 'test/a.test.ts', modes: ['vm'] }, { file: 'test/b.test.ts', modes: ['shared'] }], note: 'x' }));
  let q;
  const out = quiet(() => { q = readQuarantineFile(root); });
  assert.match(out, /has format version 2; this @jirikral\/vitest-guard .* understands version 1 - upgrade .*Failing safe: the 2 test file\(s\) it names run isolated/);
  assert.equal(q.newer, true);
  for (const mode of ['vm', 'shared']) assert.deepEqual(readQuarantine(root, mode).sort(), ['test/a.test.ts', 'test/b.test.ts']);
});

test('B2 end to end: plain `vitest run` with a newer incompatible.json runs the named file in isolated forks', integration, () => {
  const probe = (name) => `import { test, expect, inject } from 'vitest';\ntest('${name}', () => { globalThis.__mode = inject('vitestGuard').mode; expect(1).toBe(1); });\ntest('${name} mode', () => { expect(globalThis.__mode).toBe(${name === 'a' ? "'isolated'" : "'vm'"}); });\n`;
  const root = project({
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.mjs'], environment: 'node' }, { verifyWarning: false }),
    'test/a.test.mjs': probe('a'), 'test/b.test.mjs': probe('b'),
    '.vitest-guard/incompatible.json': JSON.stringify({ version: 3, entries: { 'test/a.test.mjs': { reason: 'x' } } }),
  });
  const r = vitestRun(root);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.status, { 'test/a.test.mjs': 'passed', 'test/b.test.mjs': 'passed' });
  assert.match(r.out, /format version 3.*Failing safe/s);
});

// ---------------- S3: migrateState never moves or deletes committed state ----------------

const git = (root, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const hasGit = git(os.tmpdir(), '--version').status === 0;

test('S3: migrateState leaves a committed durations.json / pollution.json in place without --commit-state (hint only)', { skip: !hasGit && 'git not available' }, () => {
  const root = mk({ 'package.json': '{}' });
  for (const n of ['durations.json', 'pollution.json', 'incompatible.json', 'plan.json']) w(root, `.vitest-guard/${n}`, '{}\n');
  assert.equal(git(root, 'init', '-q').status, 0);
  git(root, 'add', '.vitest-guard/durations.json', '.vitest-guard/pollution.json', '.vitest-guard/incompatible.json');
  assert.equal(git(root, 'commit', '-q', '-m', 'state').status, 0);
  // the reproduction of the review: `vitest-guard report` (no wrapped config needed)
  const r = cli(root, ['report']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.vitest-guard\/durations\.json, \.vitest-guard\/pollution\.json are committed but this run has no --commit-state: left untouched/);
  assert.match(r.out, /moved 1 volatile file\(s\).*plan\.json/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.vitest-guard')).sort(), ['durations.json', 'incompatible.json', 'pollution.json', 'run']);
  assert.equal(git(root, 'status', '--porcelain', '--', '.vitest-guard').stdout.trim(), '');
  // with --commit-state they are the live files: nothing to say about them
  const r2 = cli(root, ['report', '--commit-state']);
  assert.doesNotMatch(r2.out, /left untouched/);
});

test('migrate hint for a committed durations.json is printed once per set of affected files', { skip: !hasGit && 'git not available' }, () => {
  const root = mk({ 'package.json': '{}' });
  w(root, '.vitest-guard/durations.json', '{}\n');
  assert.equal(git(root, 'init', '-q').status, 0);
  git(root, 'add', '.vitest-guard/durations.json');
  assert.equal(git(root, 'commit', '-q', '-m', 'state').status, 0);
  assert.match(cli(root, ['report']).out, /durations\.json is committed but this run has no --commit-state/);
  assert.doesNotMatch(cli(root, ['report']).out, /committed but this run has no --commit-state/);
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/migrate-hint.json')));
  // the set of affected files changes: shown again
  w(root, '.vitest-guard/pollution.json', '{}\n');
  git(root, 'add', '.vitest-guard/pollution.json'); git(root, 'commit', '-q', '-m', 'more');
  assert.match(cli(root, ['report']).out, /durations\.json, \.vitest-guard\/pollution\.json are committed/);
  assert.doesNotMatch(cli(root, ['report']).out, /committed but this run has no --commit-state/);
});

test('S3: migrateState never deletes: an old copy next to a newer run/ copy stays (with a hint)', () => {
  const root = mk();
  w(root, '.vitest-guard/plan.json', '{"old":1}');
  w(root, '.vitest-guard/run/plan.json', '{"new":1}');
  w(root, '.vitest-guard/durations.json', '{}'); // no git repo: the history files are kept where they are
  const out = quiet(() => migrateState(ctx({ _: ['check'], root })));
  assert.match(out, /plan\.json: a newer copy exists in \.vitest-guard\/run\/; the old one was left in place/);
  assert.equal(fs.readFileSync(path.join(root, '.vitest-guard/plan.json'), 'utf8'), '{"old":1}');
  assert.equal(fs.readFileSync(path.join(root, '.vitest-guard/run/plan.json'), 'utf8'), '{"new":1}');
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/durations.json')));
});

// ---------------- S2: symlinks / junctions in .vitest-guard/ ----------------

test('S2: a symlinked / junctioned .vitest-guard/run is refused: nothing is deleted, moved or written in the target', () => {
  const victim = victimDir();
  const root = mk({ 'package.json': '{}', '.vitest-guard/plan.json': '{}' });
  dirLink(victim, path.join(root, '.vitest-guard', 'run'));
  const before = listAll(victim);
  const r = cli(root, ['report']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard\/run is a symbolic link or junction - refusing to follow it/);
  assert.deepEqual(listAll(victim), before);
  assert.equal(fs.readFileSync(path.join(victim, 'w-1-1.jsonl'), 'utf8'), 'precious\n');
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard', 'plan.json')));
  // the library helpers refuse on their own as well (no reliance on the CLI's up-front check)
  const c = ctx({ _: ['check'], root });
  assert.throws(() => clearRunLogs(c.runDir), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => ensureStateDir(c.stateDir), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => saveState(c, 'plan.json', { version: 2 }), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => readRunLogs(c.runDir), (e) => e.code === 'E_UNSAFE_STATE');
  assert.equal(quiet(() => migrateState(c)), '');
  assert.deepEqual(listAll(victim), before);
});

test('S2: a symlinked / junctioned .vitest-guard/run/logs is never deleted recursively', () => {
  const victim = victimDir();
  const root = mk({ 'package.json': '{}' });
  fs.mkdirSync(path.join(root, '.vitest-guard', 'run'), { recursive: true });
  dirLink(path.join(victim, 'logs'), path.join(root, '.vitest-guard', 'run', 'logs'));
  const r = cli(root, ['report']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard\/run\/logs is a symbolic link or junction/);
  assert.throws(() => clearRunLogs(path.join(root, '.vitest-guard', 'run', 'logs')), (e) => e.code === 'E_UNSAFE_STATE');
  assert.equal(fs.readFileSync(path.join(victim, 'logs', 'precious.txt'), 'utf8'), 'keep');
});

test('S2: a symlinked .vitest-guard itself is refused, also by the config wrapper (warning, no quarantine read)', () => {
  const victim = victimDir();
  w(victim, 'incompatible.json', JSON.stringify({ vm: { 'test/a.test.ts': {} } }));
  const root = mk({ 'package.json': '{}', 'test/a.test.ts': '' });
  dirLink(victim, path.join(root, '.vitest-guard'));
  const r = cli(root, ['report']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /\.vitest-guard is a symbolic link or junction/);
  let q;
  const out = quiet(() => { q = readQuarantine(root, 'vm'); });
  assert.deepEqual(q, []);
  assert.match(out, /is a symbolic link or junction - refusing to follow it.*the quarantine is not read/);
});

test('S2: state files: no write, append or read through a symlinked file; private modes', { skip: WIN && 'file symlinks need a privilege on Windows (directory junctions are covered above)' }, () => {
  const victim = victimDir();
  const root = mk();
  const run = path.join(root, '.vitest-guard', 'run');
  ensureStateDir(run);
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(run, '.gitignore')).mode & 0o777, 0o600);
  fs.symlinkSync(path.join(victim, 'w-1-1.jsonl'), path.join(run, 'plan.json'));
  fs.symlinkSync(path.join(victim, 'w-1-1.jsonl'), path.join(run, 'env-1-1.jsonl'));
  fs.symlinkSync(path.join(victim, 'nope'), path.join(run, 'dangling.json'));
  assert.throws(() => writeStateFile(path.join(run, 'plan.json'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => appendStateFile(path.join(run, 'env-1-1.jsonl'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => writeStateFile(path.join(run, 'dangling.json'), 'x'), (e) => e.code === 'E_UNSAFE_STATE');
  assert.throws(() => readStateJson(path.join(run, 'plan.json'), null), (e) => e.code === 'E_UNSAFE_STATE');
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
