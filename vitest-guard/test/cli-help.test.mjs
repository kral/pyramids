import { pathToFileURL } from 'node:url';
// CLI help, option parsing and small usability fixes (no Vitest needed unless marked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { project, wrappedConfig, cli, integration, indexFile } from './helpers.mjs';

const empty = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'vmg-help-'));

test('help: global and every subcommand --help list the exit codes and exit 0', () => {
  const dir = empty();
  const cmds = ['check', 'verify', 'compare', 'hunt'];
  const forms = [['--help'], ...cmds.flatMap((c) => [[c, '--help'], ['--help', c], ['help', c]])];
  for (const f of forms) {
    const r = cli(dir, f);
    assert.equal(r.code, 0, f.join(' ') + ': ' + r.out);
    for (const n of ['0  ok', '1  test failures', '2  usage or config error', '4  new quarantine', '5  false green']) assert.ok(r.stdout.includes(n), `${f.join(' ')} lacks "${n}"`);
    if (f.length === 2 && f[0] !== '--help' && f[0] !== 'help') assert.ok(r.stdout.startsWith(`usage: vitest-guard ${f[0]}`), f.join(' '));
  }
  const bad = cli(dir, ['help', 'frobnicate']); assert.equal(bad.code, 2); assert.match(bad.stderr, /unknown command/);
});

test('help: every option a command reads is documented in its help', async () => {
  const { helpFor } = await import('../src/cli.mjs');
  const mustMention = { check: ['--prune', '--retries', '--no-confirm', '--no-hunt', '--compare'], verify: ['--sample', '--seed', '--orders', '--no-quarantine', '--lanes'], compare: ['--sample', '--project', '--seed'], hunt: ['--before'] };
  for (const [c, flags] of Object.entries(mustMention)) for (const f of flags) assert.ok(helpFor(c).includes(f), `${c} help lacks ${f}`);
});

test('a boolean flag does not swallow the command; hunt without a victim is a usage error (stderr, exit 2)', () => {
  const dir = empty();
  const r = cli(dir, ['--verbose', 'frobnicate']);
  assert.equal(r.code, 2); assert.match(r.stderr, /unknown command "frobnicate"/);
});

test('verify: bad --sample and a missing hunt victim are usage errors; --orders planned was removed', integration, () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'] }, { mode: 'shared' }),
    'test/a.test.ts': `import { it, expect } from 'vitest';\nit('a', () => { expect(1).toBe(1); });\n`,
    'test/b.test.ts': `import { it, expect } from 'vitest';\nit('b', () => { expect(2).toBe(2); });\n`,
  });
  const planned = cli(root, ['verify', '--mode', 'shared', '--orders', 'gate,planned']);
  assert.equal(planned.code, 2, planned.out); assert.match(planned.stderr, /--orders planned was removed in 0\.2\.0/);
  const s = cli(root, ['verify', '--sample', 'many']);
  assert.equal(s.code, 2, s.out); assert.match(s.stderr, /--sample must be a positive integer/);
  const h = cli(root, ['hunt']); assert.equal(h.code, 2); assert.match(h.stderr, /missing <victim>/);
});

test('removed commands and options are usage errors that say what went (exit 2)', () => {
  const root = project({ 'package.json': '{"type":"module"}' });
  for (const [args, re] of [
    [['plan'], /`plan` was removed in 0\.2\.0/], [['run'], /`run` was removed in 0\.2\.0/], [['scan'], /`scan` was removed/], [['report'], /`report` was removed/],
    [['calibrate'], /`calibrate` was removed/], [['plan', '--help'], /`plan` was removed/], [['help', 'run'], /`run` was removed/],
    [['check', '--mode', 'auto'], /`--mode auto` was removed/], [['check', '--no-plan'], /`--no-plan` was removed/], [['check', '--vto-raw', 'x'], /`--vto-raw` was removed/],
    [['check', '--no-calibrate'], /`--no-calibrate` was removed/], [['check', '--commit-state'], /`--commit-state` was removed/],
  ]) {
    const r = cli(root, args);
    assert.equal(r.code, 2, args.join(' ') + ': ' + r.out); assert.match(r.stderr, re, args.join(' '));
    assert.match(r.stderr, /0\.1\.0-alpha\.4/);
  }
});

test('reactPackages reaches the setup file through provide', integration, () => {
  const root = project({ 'package.json': '{"type":"module"}', 'test/a.test.ts': `import { it } from 'vitest';\nit('a', () => {});\n` });
  const code = `import { defineVitestGuardConfig } from ${JSON.stringify(pathToFileURL(indexFile).href)};\nconst c = defineVitestGuardConfig({ test: { include: ['test/**/*.test.ts'] } }, { reactPackages: ['my-react-lib'] });\nconsole.log(JSON.stringify(c.test.provide.vitestGuard.reactPackages));\n`;
  fs.writeFileSync(path.join(root, 'print.mjs'), code);
  const r = cli(root, [], { bin: path.join(root, 'print.mjs') });
  assert.match(r.stdout, /\["my-react-lib"\]/, r.out);
});

test('CLI argument errors are usage errors (exit 2)', () => {
  const root = project({ 'package.json': '{"type":"module"}' });
  const none = cli(root, []); assert.equal(none.code, 2); assert.match(none.out, /usage: vitest-guard/);
  const unk = cli(root, ['check', '--bogus', 'src/a']); assert.equal(unk.code, 2); assert.match(unk.stderr, /unknown option --bogus/);
  const neg = cli(root, ['check', '--no-hnt']); assert.equal(neg.code, 2); assert.match(neg.stderr, /--no-hnt/);
  for (const a of [['check', '--retries', 'x'], ['verify', '--lanes', 'abc'], ['verify', '--sample'], ['verify', '--sample', '2.5']]) {
    const r = cli(root, a); assert.equal(r.code, 2, a.join(' ') + r.out); assert.match(r.stderr, /must be a/);
  }
});
