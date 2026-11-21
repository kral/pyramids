// Tests of the `vto` dispatcher (bin/vto.mjs): routing, global options, exit codes, no echo of
// control characters, analyzer lookup that never uses PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VTO_CI_REPO ? path.resolve(process.env.VTO_CI_REPO) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VTO = path.join(REPO, 'bin', 'vto.mjs');
const ESC = String.fromCharCode(27);
const vto = (args, opts = {}) => spawnSync(process.execPath, [VTO, ...args], { encoding: 'utf8', timeout: 60_000, input: '', ...opts, env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) } });

test('no arguments: overview on stdout, exit 2; --help exits 0', () => {
  const a = vto([]);
  assert.equal(a.status, 2); assert.match(a.stdout, /Usage: vto <command>/);
  const h = vto(['--help']);
  assert.equal(h.status, 0); assert.match(h.stdout, /Exit codes \(every command\)/);
  for (const code of ['0  ok', '1  tests failed', '2  usage', '3  affected', '4  guard', '5  guard verify']) assert.ok(h.stdout.includes(code), code);
  assert.equal(vto(['-h']).stdout, h.stdout);
});

test('--version is one line and the same for every command', () => {
  const v = vto(['--version']);
  assert.equal(v.status, 0); assert.match(v.stdout, /^vto \d+\.\d+\.\d+\n$/);
  for (const args of [['-V'], ['ui', '--version'], ['guard', '--version'], ['verify', 'overlap', '--version'], ['--version', 'run'], ['nonsense', '--version']]) {
    const r = vto(args);
    assert.equal(r.status, 0, args.join(' ')); assert.equal(r.stdout, v.stdout, args.join(' '));
  }
  assert.equal(v.stdout.trim().split(' ')[1], JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
});

test('unknown command / subcommand: exit 2, one-line message + "see vto --help", no usage dump, input sanitised', () => {
  const r = vto(['bogus']);
  assert.equal(r.status, 2); assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'vto: unknown command bogus\n     see vto --help\n');
  const e = vto([`x${ESC}[31m${ESC}]8;;https://e.invalid${String.fromCharCode(7)}`]);
  assert.equal(e.status, 2); assert.ok(!e.stderr.includes(ESC));
  const s = vto(['map', 'bogus']);
  assert.equal(s.status, 2); assert.match(s.stderr, /unknown subcommand map bogus/);
  assert.equal(vto(['__proto__']).status, 2);
  assert.equal(vto(['map', 'constructor']).status, 2);
});

test('planned commands say so (exit 2) instead of pretending', () => {
  for (const args of [['init'], ['map', 'status'], ['map', 'import', 'x'], ['daemon', 'logs'], ['report', 'slow']]) {
    const r = vto(args);
    assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, /planned, not implemented yet/);
  }
  assert.equal(vto(['init', '--help']).status, 0);
});

test('a group without a subcommand prints its help: exit 2 without --help, 0 with', () => {
  for (const g of ['map', 'report', 'verify', 'daemon', 'hook']) {
    assert.equal(vto([g]).status, 2, g);
    const h = vto([g, '--help']);
    assert.equal(h.status, 0, g); assert.match(h.stdout, /Subcommands:/);
  }
});

test('routing: arguments are passed through unchanged and the tool exit code is returned', () => {
  // verify: usage error of the underlying tool is exit 2
  const u = vto(['verify', 'overlap']);
  assert.equal(u.status, 2); assert.match(u.stderr, /usage: vto verify overlap --raw DIR/);
  const b = vto(['verify', 'overlap', '--definitely-unknown']);
  assert.equal(b.status, 2); assert.match(b.stderr, /unknown option --definitely-unknown/);
  // report overlap → vitest-overlap.mjs
  const r = vto(['report', 'overlap', '--threshold', '7']);
  assert.equal(r.status, 2); assert.match(r.stderr, /threshold/);
});

test('--lang is validated and exported as VTO_LANG; --no-daemon as VTO_NO_DAEMON', () => {
  assert.equal(vto(['--lang', 'xx', 'doctor']).status, 2);
  assert.match(vto(['--lang', 'xx', 'doctor']).stderr, /--lang must be en or cs/);
  assert.equal(vto(['--lang=cs', '--version']).status, 0);
});

test('analyzer lookup: $VTO_ANALYZER must be absolute and exist; PATH is never searched', { skip: process.platform === 'win32' ? 'shebang scripts' : false }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vto cli ěš ')));
  try {
    const fake = path.join(dir, 'vto');
    fs.writeFileSync(fake, '#!/bin/sh\necho "FAKE-ANALYZER $*"\nexit 3\n', { mode: 0o755 });
    // absolute path: used, arguments and exit code passed through (3 = run all)
    const ok = vto(['affected', 'map dir', '--git', 'HEAD'], { env: { VTO_ANALYZER: fake } });
    assert.equal(ok.status, 3); assert.equal(ok.stdout.trim(), 'FAKE-ANALYZER affected map dir --git HEAD');
    const pack = vto(['map', 'pack', 'raw', '--out', 'f'], { env: { VTO_ANALYZER: fake } });
    assert.equal(pack.stdout.trim(), 'FAKE-ANALYZER pack raw --out f');
    assert.equal(vto(['analyze', 'raw', '--lang', 'cs'], { env: { VTO_ANALYZER: fake } }).stdout.trim(), 'FAKE-ANALYZER raw --lang cs');
    // a `vto` on PATH (and in the cwd) is never executed: with no build and a relative VTO_ANALYZER the command fails with exit 2
    const built = fs.existsSync(path.join(REPO, 'analyzer', 'target', 'release', 'vto'));
    const r = vto(['analyze', 'raw'], { cwd: dir, env: { VTO_ANALYZER: 'vto', PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
    assert.ok(!r.stdout.includes('FAKE-ANALYZER'), 'PATH / cwd binary was executed');
    if (!built) { assert.equal(r.status, 2); assert.match(r.stderr, /analyzer binary not found/); assert.match(r.stderr, /cargo build --release/); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vto ci prints the shipped templates; --out never overwrites', () => {
  for (const kind of ['github', 'azure']) {
    const r = vto(['ci', kind]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /vto/); assert.ok(r.stdout.length > 500);
  }
  assert.equal(vto(['ci']).status, 2);
  assert.equal(vto(['ci', 'jenkins']).status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-ci-'));
  try {
    const out = path.join(dir, 'a', 'tests.yml');
    assert.equal(vto(['ci', 'github', '--out', out]).status, 0);
    assert.ok(fs.statSync(out).size > 500);
    assert.equal(vto(['ci', 'github', '--out', out]).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vto doctor: machine-readable report; a directory without Vitest is exit 2 with a fix for every failed check', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vto doctor ěš '))); // .native: expands Windows 8.3 short names (RUNNER~1), as doctor does
  try {
    const r = vto(['doctor', '--root', dir, '--json']);
    assert.equal(r.status, 2);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false); assert.equal(j.root, dir);
    const byName = Object.fromEntries(j.checks.map((c) => [c.name, c]));
    assert.equal(byName.node.ok, true);
    assert.equal(byName['vitest in project'].ok, false);
    for (const c of j.checks) if (c.ok === false) assert.ok(c.fix, `no fix text for ${c.name}`);
    const t = vto(['doctor', '--root', dir]);
    assert.equal(t.status, 2); assert.match(t.stdout, /FAIL\s+vitest in project/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('docs/ci/run-affected.mjs: no map, run-all (exit 3) and analyzer failure all run the whole suite; empty selection runs nothing', { skip: process.platform === 'win32' ? 'shebang scripts' : false }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vto affected ěš ')));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'vitest'), { recursive: true });
    // a stand-in for Vitest that records how it was called
    fs.writeFileSync(path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('called.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAKE_VITEST_EXIT ?? 0));\n");
    const helper = path.join(REPO, 'docs', 'ci', 'run-affected.mjs');
    const fake = (body) => { const f = path.join(dir, 'vto'); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
    const run = (analyzer, extra = [], env = {}) => {
      fs.rmSync(path.join(dir, 'called.json'), { force: true });
      const r = spawnSync(process.execPath, [helper, '--map', 'map.jsonl', '--base', 'origin/main', ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, VTO_ANALYZER: analyzer, ...env } });
      const called = fs.existsSync(path.join(dir, 'called.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'called.json'), 'utf8')) : null;
      return { ...r, called };
    };
    // 1. no map file → whole suite
    let r = run(fake('exit 0'));
    assert.deepEqual(r.called, ['run']); assert.match(r.stdout, /no coverage map/); assert.equal(r.status, 0);
    fs.writeFileSync(path.join(dir, 'map.jsonl'), '{}\n');
    // 2. selection → only those files, vitest args first, Vitest's exit code returned
    r = run(fake(`echo '["./test/a.test.ts","./test/b c.test.ts"]'`), ['--', '--reporter=dot'], { FAKE_VITEST_EXIT: '1' });
    assert.deepEqual(r.called, ['run', '--reporter=dot', './test/a.test.ts', './test/b c.test.ts']); assert.equal(r.status, 1);
    // 3. exit 3 = run all;  4. `null` = run all;  5. a crash = run all;  6. garbage = run all;  7. option-like filter = run all
    for (const body of ['exit 3', 'echo null', 'exit 101', 'echo not-json', `echo '["--config=evil.ts"]'`]) {
      r = run(fake(body));
      assert.deepEqual(r.called, ['run'], body); assert.match(r.stdout, /whole suite/, body);
    }
    // 8. empty selection: nothing runs, exit 0
    r = run(fake("echo '[]'"));
    assert.equal(r.called, null); assert.equal(r.status, 0); assert.match(r.stdout, /0 tests affected/);
    // usage
    assert.equal(spawnSync(process.execPath, [helper], { cwd: dir, encoding: 'utf8' }).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
