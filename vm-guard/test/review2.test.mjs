// Regression tests for the second review round:
//   C-M6  shared mode: order-dependent false greens (verify in several orders, quarantine, warning of `vitest run`)
//   C-M7  check: a deterministic vm-only failure is not FLAKY and never exits 0
//   U-2   the CLI refuses a config that is not wrapped with defineVmGuardConfig
//   F5    installed through a symlink: Vitest is resolved from the consumer project
//   D3    exit codes of contracts/DECISIONS.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, wrappedConfig, cli, vitestRun, integration, readJson, pkgDir, vitestDir } from './helpers.mjs';

// without a cache Vitest runs bigger files first: the padding makes the polluter run before its victims
const PAD = '// ' + 'polluter runs first '.repeat(20) + '\n';
const filler = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`test/f${i + 1}.test.ts`, `import { it, expect } from 'vitest';\nit('filler ${i + 1}', () => { expect(${i} + 1).toBe(${i + 1}); });\n`]));

test('D3: exit codes follow contracts/DECISIONS.md; --help/--version exit 0 without loading Vitest; usage errors exit 2', async () => {
  const { EXIT } = await import('../src/cli.mjs');
  assert.deepEqual(EXIT, { OK: 0, FAIL: 1, USAGE: 2, NEW_QUARANTINE: 4, FALSE_GREEN: 5 });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-empty-')); // no vitest here at all
  const v = cli(empty, ['--version']); assert.equal(v.code, 0); assert.match(v.stdout, /^@kral\/vm-guard \d+\.\d+\.\d+/);
  const h = cli(empty, ['--help']); assert.equal(h.code, 0); assert.match(h.stdout, /exit codes: 0 ok \| 1 test failures/); assert.match(h.stdout, /compare/); assert.match(h.stdout, /calibrate/);
  const u = cli(empty, ['frobnicate']); assert.equal(u.code, 2); assert.match(u.stderr, /unknown command/); assert.match(u.stderr, /see --help/); assert.ok(u.stderr.split('\n').length < 5, 'not the whole usage text');
  const n = cli(empty, ['check']); assert.equal(n.code, 2); assert.match(n.stderr, /vitest is not installed/);
  assert.equal(cli(empty, ['check', '--mode', 'turbo']).code, 2);
  assert.equal(cli(empty, ['check', '--config', 'nope.config.ts']).code, 2);
});

test('U-2: check / compare / calibrate / verify refuse a config that is not wrapped (exit 2, nothing measured or written)', integration, () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': `export default { test: { include: ['test/**/*.test.ts'] } };\n`,
    'vitest.guard.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'] }, { mode: 'vm' }),
    ...filler(2),
  });
  for (const cmd of ['check', 'compare', 'calibrate', 'verify', 'plan', 'run']) {
    const r = cli(root, [cmd]);
    assert.equal(r.code, 2, `${cmd}: ${r.out}`);
    assert.match(r.stderr, /vitest\.config\.mjs is not wrapped with defineVmGuardConfig/, cmd);
    assert.match(r.stderr, /defineVmGuardConfig\(defineConfig\(/, 'fix hint');
    assert.doesNotMatch(r.out, /recommend|files, 0 failing/, `${cmd} must not report a measurement`);
  }
  assert.ok(!fs.existsSync(path.join(root, '.vm-guard/run/modes.json')), 'no modes.json from an unwrapped config');
  assert.ok(!fs.existsSync(path.join(root, '.vm-guard/run/compare.json')));
  assert.ok(!fs.existsSync(path.join(root, '.vm-guard/incompatible.json')));
  // the same project with a wrapped config works
  const ok = cli(root, ['check', '--config', 'vitest.guard.config.mjs']);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /vm: 2 files, 0 failing/);
});

test('C-M7: a failure that is deterministic in vm (alone, or after a polluter) is quarantined with exit 4; only a pass on a same-conditions retry is FLAKY (exit 1)', integration, () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-flaky-')), 'ran-once');
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'], maxWorkers: 1 }, { mode: 'vm' }),
    // reviewer repro lab-vmg2: outer-realm state set by one file, relied upon by another
    'test/a-platform.test.ts': `import { it, expect } from 'vitest';\nimport util from 'node:util';\n${PAD}util.inspect.defaultOptions.depth = 0;\nit('sets platform options', () => { expect(util.inspect.defaultOptions.depth).toBe(0); });\n`,
    'test/b-victim.test.ts': `import { it, expect } from 'vitest';\nimport util from 'node:util';\nit('shows the nested value', () => { expect(util.inspect({ a: { b: 1 } })).toBe('{ a: { b: 1 } }'); });\n`,
    // fails in every vm context, passes in forks (object from the worker realm)
    'test/c-realm.test.ts': `import { it, expect } from 'vitest';\nit('plain object', () => { expect(Object.getPrototypeOf(process.versions) === Object.prototype).toBe(true); });\n`,
    // genuinely flaky: fails the first time it runs, passes afterwards (also with the same predecessors)
    'test/d-flaky.test.ts': `import { it, expect } from 'vitest';\nimport fs from 'node:fs';\nit('once', () => { const first = !fs.existsSync(${JSON.stringify(marker)}); fs.writeFileSync(${JSON.stringify(marker)}, '1'); expect(first).toBe(false); });\n`,
    ...filler(3),
  }, { modules: 'real' }); // own node_modules/.vite: Vitest's result cache (failed files first) must not come from another test
  const r = cli(root, ['check', '--mode', 'vm']);
  const q = readJson(path.join(root, '.vm-guard/incompatible.json'));
  assert.match(r.out, /ORDER-DEPENDENT in vm \(deterministic, not flaky\): test\/b-victim\.test\.ts fails after test\/a-platform\.test\.ts/, r.out);
  assert.doesNotMatch(r.out, /FLAKY[^\n]*b-victim/, 'the victim must not be called flaky');
  assert.deepEqual(q.vm['test/b-victim.test.ts']?.after, ['test/a-platform.test.ts']);
  assert.ok(q.vm['test/c-realm.test.ts'], 'vm-incompatible file quarantined');
  assert.match(r.out, /FLAKY[^\n]*test\/d-flaky\.test\.ts/); assert.equal(q.vm['test/d-flaky.test.ts'], undefined, 'flaky files are not quarantined');
  assert.equal(r.code, 1, 'a flaky failure is not "ok": exit 1 (D3), it wins over 4');
  // second check: flake gone, quarantined files run in forks -> green; nothing new
  const r2 = cli(root, ['check', '--mode', 'vm']);
  assert.equal(r2.code, 0, r2.out); assert.match(r2.out, /0 failing/);
  assert.equal(vitestRun(root).code, 0, 'the gate is green with the quarantine');
});

test('C-M7: without the flaky file the same check exits 4 (new quarantine), never 0', integration, () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'], maxWorkers: 1 }, { mode: 'vm' }),
    'test/a-platform.test.ts': `import { it, expect } from 'vitest';\nimport util from 'node:util';\n${PAD}util.inspect.defaultOptions.depth = 0;\nit('sets platform options', () => { expect(util.inspect.defaultOptions.depth).toBe(0); });\n`,
    'test/b-victim.test.ts': `import { it, expect } from 'vitest';\nimport util from 'node:util';\nit('shows the nested value', () => { expect(util.inspect({ a: { b: 1 } })).toBe('{ a: { b: 1 } }'); });\n`,
    ...filler(2),
  }, { modules: 'real' });
  const r = cli(root, ['check', '--mode', 'vm']);
  assert.match(r.out, /vm: 4 files, 1 failing test\/b-victim\.test\.ts/, r.out);
  assert.equal(r.code, 4, r.out);
  assert.ok(readJson(path.join(root, '.vm-guard/incompatible.json')).vm['test/b-victim.test.ts']);
  // the old behaviour (re-run the victim alone, call it flaky) can still be asked for, but it is never exit 0
  fs.rmSync(path.join(root, '.vm-guard'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'node_modules/.vite'), { recursive: true, force: true }); // cold again: same file order
  const nh = cli(root, ['check', '--mode', 'vm', '--no-hunt']);
  assert.match(nh.out, /1 failing test\/b-victim\.test\.ts/, nh.out);
  assert.equal(nh.code, 1, nh.out);
});

const m6Project = () => project({
  'package.json': '{"type":"module"}',
  'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'], maxWorkers: 1 }, { mode: 'shared' }),
  'node_modules/fake-registry/package.json': '{"name":"fake-registry","version":"1.0.0","main":"index.js"}',
  'node_modules/fake-registry/index.js': `const plugins = new Set();\nexports.extend = (p) => { plugins.add(p); };\nexports.format = (n) => { if (!plugins.has('currency')) throw new Error('currency plugin not registered'); return n.toFixed(2) + ' Kč'; };\n`,
  // reviewer repro lab-vmg: one file sets up three kinds of state, three files silently rely on it
  'test/a-setup-user.test.ts': `import { it, expect } from 'vitest';\nimport registry from 'fake-registry';\n${PAD}registry.extend('currency');\nexpect.extend({ toBeEven(n) { return { pass: n % 2 === 0, message: () => n + ' is not even' }; } });\n(String.prototype as any).shout = function () { return this.toUpperCase() + '!'; };\nit('formats with the plugin', () => { expect(registry.format(1)).toBe('1.00 Kč'); });\n`,
  'test/b-singleton.test.ts': `import { it, expect } from 'vitest';\nimport registry from 'fake-registry';\nit('formats a price', () => { expect(registry.format(2)).toBe('2.00 Kč'); });\n`,
  'test/c-matcher.test.ts': `import { it, expect } from 'vitest';\nit('is even', () => { (expect(4) as any).toBeEven(); });\n`,
  'test/d-proto.test.ts': `import { it, expect } from 'vitest';\nit('shouts', () => { expect(('hi' as any).shout()).toBe('HI!'); });\n`,
  ...filler(4),
}, { modules: 'real' });

test('C-M6: shared mode - verify finds the order-dependent false green in the gate order, quarantines it, records the result; `vitest run` warns until then', integration, () => {
  const root = m6Project();
  const forks = vitestRun(m6Project(), [], { env: { VM_GUARD_MODE: 'isolated' } });
  for (const f of ['b-singleton', 'c-matcher', 'd-proto']) assert.equal(forks.status[`test/${f}.test.ts`], 'failed', `precondition: ${f} fails in forks`);
  // the CI gate: plain `vitest run`, cold cache
  const gate = vitestRun(root);
  assert.match(gate.out, /\[vm-guard\] shared mode is not verified against isolated forks: no verify run has been recorded/, 'warning without a verify record');
  // matcher and prototype extensions of a test file no longer reach the next file (reset after each file)
  assert.equal(gate.status['test/c-matcher.test.ts'], 'failed', 'expect.extend from another file must not leak');
  assert.equal(gate.status['test/d-proto.test.ts'], 'failed', 'String.prototype extension from another file must not leak');
  assert.equal(gate.status['test/a-setup-user.test.ts'], 'passed');
  assert.equal(gate.status['test/b-singleton.test.ts'], 'passed', 'state inside an external package is invisible to the reset: this is the false green verify must find');
  fs.rmSync(path.join(root, 'node_modules/.vite'), { recursive: true, force: true }); // keep the gate order of a cold CI run for verify

  const v = cli(root, ['verify', '--mode', 'shared']);
  assert.equal(v.code, 5, v.out);
  assert.match(v.out, /FALSE GREEN \(passes fast, fails isolated\): test\/b-singleton\.test\.ts > formats a price\s+\[order: gate, forward\]/);
  assert.match(v.out, /orders gate \+ forward \+ reversed: false-green 1, false-red 0/);
  const q = readJson(path.join(root, '.vm-guard/incompatible.json'));
  assert.equal(q.shared['test/b-singleton.test.ts']?.falseGreen, true, 'quarantined');
  const rec = readJson(path.join(root, '.vm-guard/run/verify-shared.json'));
  assert.deepEqual(rec.falseGreen, ['test/b-singleton.test.ts > formats a price']); assert.equal(rec.complete, true); assert.deepEqual(rec.orders, ['gate', 'forward', 'reversed']);

  // the gate now tells the truth (the file runs in forks and fails) and still warns: the last verify was not clean
  const gate2 = vitestRun(root);
  assert.equal(gate2.status['test/b-singleton.test.ts'], 'failed'); assert.notEqual(gate2.code, 0);
  assert.match(gate2.out, /the last verify \([^)]*\) found 1 false green/);
  // a clean verify silences the warning; changing the config brings it back
  const v2 = cli(root, ['verify', '--mode', 'shared']);
  assert.equal(v2.code, 0, v2.out); assert.match(v2.out, /false-green 0, false-red 0/);
  assert.doesNotMatch(vitestRun(root).out, /not verified against isolated forks/);
  fs.rmSync(path.join(root, '.vm-guard/run/verify-shared.json'));
  assert.doesNotMatch(vitestRun(root, [], { env: { VM_GUARD_VERIFY_WARNING: '0' } }).out, /not verified against isolated forks/, 'can be silenced');
  cli(root, ['verify', '--mode', 'shared']);
  fs.appendFileSync(path.join(root, 'vitest.config.mjs'), '// changed\n');
  assert.match(vitestRun(root).out, /the config or the quarantine changed since the last verify/);
});

test('C-M6: the false green is also found when the gate order happens to hide it (polluter runs last): forward + reversed cover both orders', integration, () => {
  const root = m6Project();
  // rename so that the polluter sorts (and runs) last in the gate: then gate order agrees with forks by luck
  fs.renameSync(path.join(root, 'test/a-setup-user.test.ts'), path.join(root, 'test/z-setup-user.test.ts'));
  const onlyGate = cli(root, ['verify', '--mode', 'shared', '--orders', 'gate', '--no-quarantine']);
  const v = cli(root, ['verify', '--mode', 'shared', '--no-quarantine']);
  assert.equal(v.code, 5, v.out);
  assert.match(v.out, /FALSE GREEN[^\n]*b-singleton[^\n]*\[order: [^\]]*reversed/);
  assert.ok(!fs.existsSync(path.join(root, '.vm-guard/incompatible.json')), '--no-quarantine writes nothing');
  assert.ok([0, 5].includes(onlyGate.code), onlyGate.out); // informational: the single gate order may or may not see it
  assert.equal(cli(root, ['verify', '--mode', 'shared', '--orders', 'sideways']).code, 2);
});

test('C-M6: shared-mode warning names the commit when HEAD moved since the verify', async () => {
  const { verifyStatus, verifyFile, configKey, gitHead } = await import('../src/verifystate.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-vs-')));
  fs.writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {}');
  fs.mkdirSync(path.join(root, '.git/refs/heads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
  assert.equal(gitHead(root), 'a'.repeat(40));
  assert.equal(verifyStatus(root, 'shared').ok, false);
  fs.mkdirSync(path.join(root, '.vm-guard/run'), { recursive: true });
  const rec = { at: 'T', head: gitHead(root), configKey: configKey(root, path.join(root, 'vitest.config.ts')), complete: true, falseGreen: [], falseRed: [] };
  fs.writeFileSync(verifyFile(root, 'shared'), JSON.stringify(rec));
  assert.equal(verifyStatus(root, 'shared').ok, true);
  fs.writeFileSync(path.join(root, '.git/refs/heads/main'), 'b'.repeat(40) + '\n');
  assert.match(verifyStatus(root, 'shared').reason, /was for commit aaaaaaaaa, HEAD is bbbbbbbbb/);
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'b'.repeat(40) + '\n'); // detached
  fs.writeFileSync(verifyFile(root, 'shared'), JSON.stringify({ ...rec, head: 'b'.repeat(40), complete: false, sample: 5, of: 9 }));
  assert.match(verifyStatus(root, 'shared').reason, /only a sample \(5 of 9 files\)/);
  fs.writeFileSync(verifyFile(root, 'shared'), JSON.stringify({ ...rec, head: 'b'.repeat(40) }));
  fs.mkdirSync(path.join(root, '.vm-guard'), { recursive: true }); fs.writeFileSync(path.join(root, '.vm-guard/incompatible.json'), '{"shared":{}}');
  assert.match(verifyStatus(root, 'shared').reason, /config or the quarantine changed/);
});

test('F5: installed through a symlink (npm i -D <path>) - Vitest comes from the consumer project, setup files are served, CLI works', integration, () => {
  // a copy of the package WITHOUT node_modules, outside the consumer: any bare `vitest` import from its real path fails
  const pkg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-pkg-')));
  for (const n of ['src', 'bin', 'package.json']) fs.cpSync(path.join(pkgDir, n), path.join(pkg, n), { recursive: true });
  const name = readJson(path.join(pkg, 'package.json')).name;
  const root = project({
    'package.json': '{"name":"consumer","type":"module"}',
    'vitest.config.mjs': `import { defineVmGuardConfig } from '${name}';\nexport default defineVmGuardConfig({ test: { include: ['test/**/*.test.ts'] } }, { mode: 'vm' });\n`,
    'test/node.test.ts': `import { it, expect } from 'vitest';\nit('node', () => { expect(1).toBe(1); });\n`,
    'test/dom.test.ts': `// @vitest-environment jsdom\nimport { it, expect } from 'vitest';\nit('dom', () => { document.title = 'x'; expect(document.title).toBe('x'); });\n`,
  }, { modules: 'real' });
  fs.mkdirSync(path.join(root, 'node_modules', path.dirname(name)), { recursive: true });
  fs.symlinkSync(pkg, path.join(root, 'node_modules', name));
  const bin = path.join(root, 'node_modules', name, 'bin', 'vm-guard.mjs');
  for (const mode of ['vm', 'shared', 'isolated']) {
    const r = vitestRun(root, [], { env: { VM_GUARD_MODE: mode, VM_GUARD_VERIFY_WARNING: '0' } });
    assert.equal(r.code, 0, `${mode}: ${r.out}`);
    assert.deepEqual(r.status, { 'test/dom.test.ts': 'passed', 'test/node.test.ts': 'passed' }, mode);
  }
  assert.ok(fs.existsSync(path.join(root, 'node_modules/.vm-guard/setup.bundle.mjs')), 'setup served from inside the project');
  // per-file behaviour must survive the copy: the setup runs for EVERY file (one start record per file in the run log)
  const logs = fs.readdirSync(path.join(root, '.vm-guard/run/logs')).flatMap((n) => fs.readFileSync(path.join(root, '.vm-guard/run/logs', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  // the log accumulates over the three mode runs above: every file must have started in each run
  assert.deepEqual([...new Set(logs.filter((l) => l.t === 'start').map((l) => l.file))].sort(), ['test/dom.test.ts', 'test/node.test.ts']);
  assert.equal(cli(root, ['--version'], { bin }).code, 0);
  const c = cli(root, ['check'], { bin });
  assert.equal(c.code, 0, c.out); assert.match(c.out, /vm: 2 files, 0 failing/);
  const l = cli(root, ['verify', '--mode', 'shared'], { bin }); // lanes use the sequencer: must not import vitest from the checkout
  assert.equal(l.code, 0, l.out);
});

test('install: package metadata lets `npm ci && npm test` work from a clean clone', () => {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  assert.match(pkg.name, /^@[\w-]+\/vm-guard$/, 'scoped name: `npx vm-guard` must never fetch the unrelated npm package');
  assert.equal(pkg.peerDependencies.vitest, '>=5.1 <6');
  assert.ok(pkg.devDependencies.vitest && pkg.devDependencies.jsdom, 'own tests need vitest + jsdom');
  const lock = readJson(path.join(pkgDir, 'package-lock.json'));
  assert.equal(lock.packages[''].name, pkg.name); assert.ok(lock.packages['node_modules/vitest']?.version, 'lockfile pins vitest');
  assert.deepEqual(pkg.files.filter((f, i, a) => a.indexOf(f) !== i), [], 'no duplicate files entries');
  assert.ok(pkg.files.includes('README.cs.md'));
  for (const f of Object.values(pkg.exports).map((e) => (typeof e === 'string' ? e : e.default))) assert.ok(fs.existsSync(path.join(pkgDir, f)), f);
  const fresh = spawnSync(process.execPath, [path.join(pkgDir, 'scripts/bundle-setup.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, 'committed setup.bundle.mjs is stale: ' + fresh.stderr);
  // no static import of vitest in anything the config or the CLI loads in the main process
  for (const f of ['index.mjs', 'cli.mjs', 'sequencer.mjs', 'runner.mjs', 'auto.mjs', 'envstore.mjs', 'verifystate.mjs', 'plan.mjs', 'logs.mjs', 'safety.mjs', 'scan.mjs'])
    assert.doesNotMatch(fs.readFileSync(path.join(pkgDir, 'src', f), 'utf8'), /^import[^\n]*from\s+'vitest/m, f);
  assert.ok(vitestDir || process.env.VM_GUARD_TEST_NO_INTEGRATION === '1');
});
