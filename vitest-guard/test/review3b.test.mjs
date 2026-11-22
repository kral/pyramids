// Regression tests for the third review round (correctness), second batch: S2 stale auto.json, S4 baseline before the
// first test file, S5 state the resets and the detector missed, S9 compare without a usable reference, S12 Windows paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, wrappedConfig, cli, vitestRun, integration, readJson } from './helpers.mjs';
import { verifyStatus, configKey, gitHead } from '../src/verifystate.mjs';

const pass = `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`;
const P = (files, t = {}, guard = {}) => project({ 'vitest.config.mjs': wrappedConfig(t, guard), 'package.json': '{"type":"module"}', ...files });

test('S2 unit: an auto verify record does not count for a config that runs in another mode', () => {
  const root = P({ 'src/a.test.js': pass });
  const cfg = path.join(root, 'vitest.config.mjs');
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  const rec = (mode) => fs.writeFileSync(path.join(root, '.vitest-guard/run/verify-shared.json'), JSON.stringify({ at: 'T', mode, head: gitHead(root), configKey: configKey(root, cfg), complete: true, falseGreen: [] }));
  rec('auto');
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'auto' }).ok, true);
  const st = verifyStatus(root, 'shared', { configFile: cfg, configMode: 'shared' });
  assert.equal(st.ok, false); assert.match(st.reason, /ran in mode auto, the config runs in mode shared/);
  rec('shared');
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'shared' }).ok, true);
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'vm' }).ok, true, 'a shared verify still covers shared projects of a vm config');
});

test('S2: a leftover auto.json does not make check / verify run in mode auto; an auto verify does not silence a shared run', integration, () => {
  const root = P({ 'src/a.test.js': pass }, {}, { mode: 'auto' });
  const v = cli(root, ['verify']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /verify · auto/);
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/verify-shared.json')), 'auto with a shared group writes verify-shared.json');
  assert.doesNotMatch(vitestRun(root).out, /not verified/, 'the auto config itself is verified');
  // same config file, but the run is forced into shared mode: the auto record compared another pool layout
  assert.match(vitestRun(root, [], { env: { VITEST_GUARD_MODE: 'shared' } }).out, /not verified.*ran in mode auto/);
  // leave mode 'auto' (auto.json stays behind): the CLI follows the config, not the leftover file
  const cfg = path.join(root, 'vitest.config.mjs');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('"mode":"auto"', '"mode":"isolated"'));
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/auto.json')));
  const c = cli(root, ['check']);
  assert.doesNotMatch(c.out, /check · auto|auto: resolved mode/, c.out);
});

test('S9: compare recommends no fast mode when the isolated reference is not usable (unhandled error, no failing file)', integration, () => {
  const root = P({
    'src/a.test.js': `import { test, expect } from 'vitest'; test('ok', () => { if (process.env.VITEST_GUARD_MODE === 'isolated') Promise.reject(new Error('boom only in forks')); expect(1).toBe(1); });\n`,
    'src/b.test.js': pass,
  });
  const r = cli(root, ['compare', '--sample', 'all']);
  const rows = readJson(path.join(root, '.vitest-guard/run/compare.json')).rows;
  assert.equal(rows[0].recommend, 'isolated (forks)', r.out);
  assert.match(rows[0].why, /isolated reference run is not usable/);
  assert.equal(readJson(path.join(root, '.vitest-guard/run/modes.json')).modes.root, 'isolated');
});

const jsdom = { environment: 'jsdom' };
const runLog = (root) => { const d = path.join(root, '.vitest-guard/run/logs'); return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); };

test('S4: the baseline is taken before the first file\'s top-level code (shared and vm); setup-file state stays and is not reported', integration, () => {
  const root = P({
    'setup.js': `process.env.FROM_SETUP = '1';\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; globalThis.fetch = () => 'mock'; process.env.RV_LEAK = '1'; document.title = 'A'; test('a', () => { expect(1).toBe(1); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest'; test('b', () => { expect(String(globalThis.fetch)).not.toContain('mock'); expect(process.env.RV_LEAK).toBeUndefined(); expect(document.title).toBe(''); expect(process.env.FROM_SETUP).toBe('1'); });\n`,
  }, { ...jsdom, setupFiles: ['./setup.js'] });
  for (const mode of ['shared', 'vm']) {
    const r = cli(root, ['verify', '--mode', mode, '--orders', 'forward', '--no-quarantine']);
    assert.equal(r.code, 0, `${mode}\n${r.out}`);
    assert.match(r.out, /false-green 0, false-red 0/);
    const log = runLog(root);
    assert.deepEqual(log.filter((x) => x.dirty), [], `${mode}: no file starts dirty (setup-file env is not a leak)`);
    if (mode === 'shared') assert.ok(log.some((x) => x.t === 'end' && x.file === 'src/a.test.js' && !x.mode && x.pollution?.includes('process.env')), 'the first file\'s top-level pollution is recorded');
  }
});

test('S5: cookies, the URL, intervals and equality testers are reset after a file; added globals are reported', integration, () => {
  const root = P({
    'setup.js': `import { expect } from 'vitest'; expect.addEqualityTesters([(a, b) => (a && b && a.__eqAny && b.__eqAny ? true : undefined)]);\n`,
    'src/a.test.js': `import { test, expect } from 'vitest'; test('pollute', () => { document.cookie = 's=1'; history.pushState({}, '', '/users/5'); globalThis.__x = 1; globalThis.__iv = setInterval(() => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }, 1); expect.addEqualityTesters([() => true]); });\n`,
    'src/b.test.js': `import { test, expect } from 'vitest';
test('clean', async () => {
  expect(document.cookie).toBe('');
  expect(location.pathname).toBe('/');
  const t0 = globalThis.__ticks || 0; await new Promise((r) => setTimeout(r, 30)); expect(globalThis.__ticks || 0).toBe(t0);
  expect(() => expect({ a: 1 }).toEqual({ a: 2 })).toThrow();
  expect({ __eqAny: 1 }).toEqual({ __eqAny: 2 }); // the setup file's tester is kept
});\n`,
  }, { ...jsdom, setupFiles: ['./setup.js'] });
  const r = cli(root, ['verify', '--mode', 'shared', '--orders', 'forward', '--no-quarantine']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /false-green 0, false-red 0/);
  const log = runLog(root);
  const end = log.find((x) => x.t === 'end' && x.file === 'src/a.test.js' && x.pollution);
  for (const k of ['dom/storage', 'timers', 'equality testers', 'added globals']) assert.ok(end.pollution.includes(k), k + ' ' + JSON.stringify(end));
  const start = log.find((x) => x.t === 'start' && x.file === 'src/b.test.js' && x.dirty);
  assert.deepEqual(start?.dirty.map((d) => d.kind), ['added globals'], JSON.stringify(start));
  assert.ok(start.dirty[0].keys.includes('__x'));
});

test('S12 unit: node_modules checks and module names accept Windows separators', async () => {
  const fp = await import('../src/fingerprint.mjs');
  assert.equal(fp.inNodeModules('    at Object.<anonymous> (C:\\proj\\node_modules\\lib\\index.js:3:9)'), true);
  assert.equal(fp.inNodeModules('    at file:///C:/proj/node_modules/lib/index.mjs:3:9'), true);
  assert.equal(fp.inNodeModules('    at C:\\proj\\src\\a.test.js:3:9'), false);
  assert.equal(fp.moduleName('C:\\proj\\node_modules\\@scope\\lib\\dist\\x.js'), '@scope/lib/dist/x.js');
  assert.equal(fp.moduleName('/p/node_modules/a/node_modules/b/i.js'), 'b/i.js');
  // a require.cache key with backslashes (what Node uses on Windows) is scanned and reported by package path
  const { createRequire } = await import('node:module');
  const cache = createRequire(import.meta.url).cache;
  const id = 'C:\\proj\\node_modules\\vg-fake-lib\\index.js';
  const exp = { count: 0 };
  cache[id] = { id, exports: exp, loaded: true, children: [] };
  try {
    const base = fp.captureModuleState();
    assert.ok(base.has(id), 'tracked');
    exp.count = 1;
    assert.deepEqual(fp.diffModuleState(base, fp.captureModuleState()), ['vg-fake-lib/index.js']);
  } finally { delete cache[id]; }
});

test('S12 unit: isInside is separator-aware, and case-insensitive with either separator on Windows', async () => {
  const { isInside } = await import('../src/safety.mjs');
  const win = { platform: 'win32' }, posix = { platform: 'linux' };
  assert.equal(isInside('C:\\Proj', 'c:\\proj\\node_modules\\x', win), true);
  assert.equal(isInside('C:\\Proj', 'C:/Proj/src/a.test.ts', win), true);
  assert.equal(isInside('C:\\Proj', 'C:\\Proj', win), true);
  assert.equal(isInside('C:\\Proj', 'C:\\Project\\x', win), false, 'no prefix match without a separator');
  assert.equal(isInside('C:\\', 'C:\\x', win), true);
  assert.equal(isInside('/a/b', '/a/bc', posix), false);
  assert.equal(isInside('/a/b', '/a/b/c', posix), true);
  assert.equal(isInside('/a/B', '/a/b/c', posix), false, 'POSIX stays case-sensitive');
});

test('S12 / review 3 item 3: a quarantine key whose case or Unicode form differs from the file on disk is remapped to the on-disk spelling', async () => {
  const { validateTestPaths } = await import('../src/safety.mjs');
  const root = project({ 'src/button.test.js': '', [`src/${'příklad'.normalize('NFC')}.test.js`]: '', 'src/twin.test.js': '', 'src/Twin.test.js': '' });
  const r = validateTestPaths(root, ['src/Button.test.js', 'src/button.test.js', `src/${'příklad'.normalize('NFD')}.test.js`, 'src/TWIN.test.js'], { warn: false });
  const twins = fs.readdirSync(path.join(root, 'src')).filter((n) => /^twin/i.test(n)).length; // 1 on a case-insensitive file system
  assert.deepEqual(r.ok.slice(0, 2), ['src/button.test.js', `src/${'příklad'.normalize('NFC')}.test.js`]);
  assert.deepEqual(r.remapped.map((x) => x.entry).slice(0, 2), ['src/Button.test.js', `src/${'příklad'.normalize('NFD')}.test.js`]);
  assert.equal(r.map.get('src/Button.test.js'), 'src/button.test.js');
  if (twins === 2) assert.deepEqual(r.rejected.map((x) => x.entry), ['src/TWIN.test.js'], 'two candidates (case-sensitive file system): rejected, never guessed');
});

test('N5 unit: a verify that ran only some of the default orders is not a clean verify', () => {
  const root = P({ 'src/a.test.js': pass });
  const cfg = path.join(root, 'vitest.config.mjs');
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  const rec = (mode, orders) => fs.writeFileSync(path.join(root, `.vitest-guard/run/verify-${mode}.json`), JSON.stringify({ at: 'T', mode, orders, head: gitHead(root), configKey: configKey(root, cfg), complete: true, falseGreen: [] }));
  rec('shared', ['gate']);
  assert.match(verifyStatus(root, 'shared', { configFile: cfg }).reason, /ran only the orders gate/);
  rec('shared', ['gate', 'forward', 'reversed']);
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg }).ok, true);
  rec('vm', ['gate', 'reversed']);
  assert.equal(verifyStatus(root, 'vm', { configFile: cfg }).ok, true);
});

test('N7/N8: a hook of a nested suite that throws fails the file; verify says how many tests fail in both modes', integration, async () => {
  const { runVitest } = await import('../src/runner.mjs');
  const root = P({
    'src/h.test.js': `import { describe, test, afterAll, expect } from 'vitest'; describe('s', () => { afterAll(() => { throw new Error('hook'); }); test('t', () => { expect(1).toBe(1); }); });\n`,
    'src/f.test.js': `import { test, expect } from 'vitest'; test('bad', () => { expect(1).toBe(2); });\n`,
  });
  const r = await runVitest({ root, mode: 'isolated', tag: 'n8' });
  assert.equal(r.files.get('src/h.test.js').status, 'failed');
  assert.match(r.files.get('src/h.test.js').message, /outside any test/);
  const v = cli(root, ['verify', '--mode', 'shared']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /SAFE .*\(1 test\(s\) fail in both\)/);
  assert.match(v.out, /fail in both modes\s+1/);
});
