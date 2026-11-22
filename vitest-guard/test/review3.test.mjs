// Regression tests for the third review round (correctness): a run that cannot prove a file passed must not report
// success. B1-B7 blockers, S1/S3/S6/S7/S8/S10 should-fix, trial S1 (auto ignoring a 'root' compare result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, wrappedConfig, cli, vitestRun, integration, readJson } from './helpers.mjs';
import { escapeGlob, matchesGlobDot, validateTestPaths } from '../src/safety.mjs';

const pass = `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`;
const fail = `import { test, expect } from 'vitest'; test('bad', () => { expect(1).toBe(2); });\n`;
const P = (files, t = {}, guard = {}) => project({ 'vitest.config.mjs': wrappedConfig(t, guard), 'package.json': '{"type":"module"}', ...files });
const Q = (root, q) => { fs.mkdirSync(path.join(root, '.vitest-guard'), { recursive: true }); fs.writeFileSync(path.join(root, '.vitest-guard/incompatible.json'), JSON.stringify({ version: 1, vm: {}, shared: {}, ...q })); };

test('B1 unit: literal paths with [ ] ( ) @ and dot directories are accepted and escaped; * and ? stay refused', () => {
  // `*` and `?` cannot appear in Windows file names: that half of the case is POSIX-only
  const star = process.platform === 'win32' ? [] : ['src/x*.test.js'];
  const root = project({ 'src/[id]/a.test.js': '', 'src/(g)/b.test.js': '', 'src/@core/c.test.js': '', '.storybook/s.test.js': '', ...Object.fromEntries(star.map((f) => [f, ''])) });
  const include = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
  const r = validateTestPaths(root, ['src/[id]/a.test.js', 'src/(g)/b.test.js', 'src/@core/c.test.js', '.storybook/s.test.js', ...star], { include, warn: false });
  assert.deepEqual(r.ok, ['src/[id]/a.test.js', 'src/(g)/b.test.js', 'src/@core/c.test.js', '.storybook/s.test.js']);
  if (star.length) assert.match(r.rejected[0].reason, /glob/);
  assert.equal(escapeGlob('src/[id]/(g)/@(x)/!y.test.js'), 'src/\\[id\\]/\\(g\\)/\\@\\(x\\)/!y.test.js');
  assert.ok(matchesGlobDot('src/[id]/a.test.js', escapeGlob('src/[id]/a.test.js')), 'escaped literal matches itself');
  assert.ok(!matchesGlobDot('src/i/a.test.js', escapeGlob('src/[id]/a.test.js')), 'no character class');
});

test('B1: shared lanes run files under [id] / @core / (grp) / dot directories (exit 1 when they fail); run --no-heal too', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/[id]/page.test.js': fail, 'src/@core/x.test.js': fail, 'src/(grp)/y.test.js': fail, '.storybook/s.test.js': fail });
  const r = cli(root, ['check', '--mode', 'shared']);
  assert.equal(r.code, 1, r.out);
  for (const f of ['src/[id]/page.test.js', 'src/@core/x.test.js', 'src/(grp)/y.test.js', '.storybook/s.test.js']) assert.match(r.out, new RegExp(`FAIL \\(also isolated\\): ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), f);
  assert.doesNotMatch(r.out, /NOT RUN/);
  assert.equal(cli(root, ['run', '--no-heal']).code, 1);
});

test('B1: a project with its own root runs in lanes', integration, () => {
  const root = P({ 'packages/a/src/x.test.js': fail, 'packages/a/src/y.test.js': pass, 'src/z.test.js': pass },
    { projects: [{ test: { name: 'a', root: 'packages/a', include: ['src/**/*.test.js'] } }, { test: { name: 'main', include: ['src/**/*.test.js'] } }] });
  const r = cli(root, ['run', '--no-heal']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /3 files, 1 failed packages\/a\/src\/x\.test\.js/);
  const v = cli(root, ['verify', '--mode', 'shared']);
  assert.equal(v.code, 0, v.out); // x fails in both modes: no mismatch, and every lane reported every file
  assert.doesNotMatch(v.out, /NOT RUN|INCOMPLETE/);
});

test('B1/S1: a file that a lane cannot take (a ? in its name) is NOT RUN: check / run / verify fail instead of passing', { skip: process.platform === 'win32' ? 'POSIX-only: ? is not allowed in Windows file names' : integration.skip }, () => {
  const root = P({ 'src/a.test.js': pass, 'src/q?.test.js': pass });
  const c = cli(root, ['check', '--mode', 'shared']);
  assert.equal(c.code, 1, c.out);
  assert.match(c.out, /NOT RUN: 1 file\(s\).*src\/q\?\.test\.js/);
  assert.equal(cli(root, ['run', '--no-heal']).code, 1);
  const v = cli(root, ['verify', '--mode', 'shared']);
  assert.equal(v.code, 1, v.out);
  assert.match(v.out, /INCOMPLETE/);
  assert.ok(!fs.existsSync(path.join(root, '.vitest-guard/run/verify-shared.json')), 'no clean verify record');
});

test('B2: a test file added to a directory without one is run by the next shared check', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/lib/util.js': 'export const x = 1;\n' });
  assert.equal(cli(root, ['check', '--mode', 'shared']).code, 0);
  fs.writeFileSync(path.join(root, 'src/lib/new.test.js'), fail);
  const r = cli(root, ['check', '--mode', 'shared']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/lib\/new\.test\.js/);
  assert.equal(cli(root, ['run', '--no-heal']).code, 1);
});

test('B3/S7: an unhandled rejection fails run --no-heal and check --mode shared (no TypeError)', integration, () => {
  const root = P({ 'src/a.test.js': `import { test, expect } from 'vitest'; test('ok', () => { Promise.reject(new Error('boom-unhandled')); expect(1).toBe(1); });\n`, 'src/b.test.js': pass });
  assert.equal(cli(root, ['run', '--no-heal']).code, 1);
  const c = cli(root, ['check', '--mode', 'shared']);
  assert.equal(c.code, 1, c.out);
  assert.doesNotMatch(c.out, /TypeError/);
});

test('B4: a file that fails in forks at import time or in beforeAll is a false green in verify (exit 5) and compare (exit 5)', integration, () => {
  const a = `import { test, expect } from 'vitest'; globalThis.__helper = () => 1; test('a', () => { expect(1).toBe(1); });\n`;
  const top = P({ 'src/a.test.js': a, 'src/b.test.js': `import { test, expect } from 'vitest'; const v = globalThis.__helper(); test('b', () => { expect(v).toBe(1); });\n` });
  const v = cli(top, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 5, v.out);
  assert.match(v.out, /FALSE GREEN.*src\/b\.test\.js/);
  // compare runs one order only: an import-time failure that happens in forks only (main thread) is order-free
  const forksOnly = P({ 'src/a.test.js': pass, 'src/m.test.js': `import { test } from 'vitest'; import { isMainThread } from 'node:worker_threads';\nif (isMainThread) throw new Error('forks only');\ntest('m', () => {});\n` });
  const cmp = cli(forksOnly, ['compare', '--no-write']);
  assert.equal(cmp.code, 5, cmp.out);
  assert.doesNotMatch(cmp.out, /recommend (vm|shared)/);
  const hook = P({ 'src/a.test.js': a, 'src/b.test.js': `import { test, expect, beforeAll } from 'vitest'; let v; beforeAll(() => { v = globalThis.__helper(); }); test('b', () => { expect(v).toBe(1); });\n` });
  assert.equal(cli(hook, ['verify', '--mode', 'shared', '--no-quarantine']).code, 5);
});

test('B5: mode auto keeps test files under build/, dist/, coverage/ and dot directories', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/build/x.test.js': fail, 'src/dist/y.test.js': fail, 'src/coverage/c.test.js': fail, '.config/w.test.js': fail }, {}, { mode: 'auto' });
  for (const env of [{}, { VITEST_GUARD_MODE: 'isolated' }]) {
    const r = vitestRun(root, [], { env });
    assert.equal(r.code, 1, r.out);
    for (const f of ['src/build/x.test.js', 'src/dist/y.test.js', 'src/coverage/c.test.js', '.config/w.test.js']) assert.equal(r.status[f], 'failed', `${f} ${JSON.stringify(env)}`);
  }
});

test('B6: check --prune keeps a false-green entry that still fails in forks; S8: a real release is exit 4', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/fg.test.js': `import { test, expect } from 'vitest'; import { isMainThread } from 'node:worker_threads'; test('fg', () => { expect(isMainThread).toBe(false); });\n` });
  assert.equal(cli(root, ['verify']).code, 5);
  assert.ok(readJson(path.join(root, '.vitest-guard/incompatible.json')).vm['src/fg.test.js'].falseGreen);
  const p = cli(root, ['check', '--prune']);
  assert.match(p.out, /kept in quarantine.*src\/fg\.test\.js/);
  assert.equal(p.code, 1, p.out); // the quarantined file runs in forks, where it fails
  assert.ok(readJson(path.join(root, '.vitest-guard/incompatible.json')).vm['src/fg.test.js']);
  // a stale entry that passes everywhere is released: incompatible.json changed -> 4
  const ok = P({ 'src/a.test.js': pass, 'src/b.test.js': pass });
  Q(ok, { vm: { 'src/b.test.js': { signature: 'x' } } });
  const r = cli(ok, ['check', '--prune']);
  assert.equal(r.code, 4, r.out);
  assert.deepEqual(readJson(path.join(ok, '.vitest-guard/incompatible.json')).vm, {});
});

test('B7: duplicate test titles do not hide a false green', integration, () => {
  const root = P({ 'src/a.test.js': `import { test, expect } from 'vitest'; test('a', () => { globalThis.__leak = 1; expect(1).toBe(1); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; test.each([1, 2])('dup', (n) => { if (n === 1) expect(globalThis.__leak).toBe(1); });\n` });
  const r = cli(root, ['verify', '--mode', 'shared', '--orders', 'forward', '--no-quarantine']);
  assert.equal(r.code, 5, r.out);
});

test('S3: without --mode, check uses the mode of the config', integration, () => {
  const root = P({ 'src/a.test.js': pass }, {}, { mode: 'shared' });
  const r = cli(root, ['check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /shared \(planned\): 1 files/);
  assert.match(cli(root, ['check', '--mode', 'vm']).out, /config mode: shared, checking: vm/);
});

test('S6: a user bail does not truncate verify', integration, () => {
  const root = P({ 'src/a.test.js': fail, 'src/p.test.js': `import { test } from 'vitest'; test('p', () => { globalThis.__leak = 1; });\n`,
    'src/q.test.js': `import { test, expect } from 'vitest'; test('q', () => { expect(globalThis.__leak).toBe(1); });\n` }, { bail: 1, maxWorkers: 1, fileParallelism: false });
  assert.equal(cli(root, ['verify', '--mode', 'shared', '--orders', 'forward', '--no-quarantine']).code, 5);
});

test('S8: a filter matching nothing is exit 2; scan --quarantine that writes is exit 4', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/c.test.js': `import { test } from 'vitest'; globalThis.__x = 1; test('c', () => {});\n` });
  const r = cli(root, ['check', 'nosuchfile']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.stderr, /no test file matches/);
  assert.equal(cli(root, ['verify', 'nosuchfile']).code, 2);
  assert.equal(cli(root, ['scan', '--quarantine']).code, 4);
  assert.equal(cli(root, ['scan', '--quarantine']).code, 0, 'nothing new');
});

test('S10: the isolated job of a planned run cannot overwrite a lane failure through a substring filter', integration, () => {
  const root = P({ 'src/a.test.js': pass, 'src/a.test.jsx': `import { test, expect } from 'vitest'; import { isMainThread } from 'node:worker_threads'; test('threads-only failure', () => { expect(isMainThread).toBe(true); });\n` });
  Q(root, { shared: { 'src/a.test.js': { signature: 'x' } } });
  const r = cli(root, ['run', '--no-heal']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 failed src\/a\.test\.jsx/);
  const c = cli(root, ['check', '--mode', 'shared']);
  assert.notEqual(c.code, 0, c.out);
  assert.doesNotMatch(c.out, /TypeError/);
});

test('trial S1: mode auto on a single-project config uses a compare result stored as root and says which mode each group ran in', integration, () => {
  const root = P({ 'src/a.test.js': pass }, {}, { mode: 'auto' });
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vitest-guard/run/modes.json'), JSON.stringify({ modes: { root: 'shared' } }));
  const r = cli(root, ['check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /auto: resolved mode per group: node -> shared/);
  assert.deepEqual(readJson(path.join(root, '.vitest-guard/run/auto.json')).groups, { node: 'shared' });
});
