import { pathToFileURL } from 'node:url';
// CLI help, option parsing and small usability fixes (no Vitest needed unless marked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { project, wrappedConfig, cli, integration, indexFile } from './helpers.mjs';

const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-help-'));

test('help: global and every subcommand --help list the D3 exit codes and exit 0', () => {
  const dir = empty();
  const cmds = ['check', 'verify', 'compare', 'calibrate', 'plan', 'run', 'hunt', 'scan', 'report'];
  const forms = [['--help'], ...cmds.flatMap((c) => [[c, '--help'], ['--help', c], ['help', c]])];
  for (const f of forms) {
    const r = cli(dir, f);
    assert.equal(r.code, 0, f.join(' ') + ': ' + r.out);
    for (const n of ['0  ok', '1  test failures', '2  usage or config error', '3  run all', '4  new quarantine', '5  false green']) assert.ok(r.stdout.includes(n), `${f.join(' ')} lacks "${n}"`);
    if (f.length === 2 && f[0] !== '--help' && f[0] !== 'help') assert.ok(r.stdout.startsWith(`usage: vitest-guard ${f[0]}`), f.join(' '));
  }
  const bad = cli(dir, ['help', 'frobnicate']); assert.equal(bad.code, 2); assert.match(bad.stderr, /unknown command/);
});

test('help: every option a command reads is documented in its help', async () => {
  const { helpFor } = await import('../src/cli.mjs');
  const mustMention = { check: ['--prune', '--retries', '--no-confirm', '--no-hunt', '--no-plan', '--no-calibrate'], verify: ['--sample', '--seed', '--orders', '--no-quarantine', '--no-plan'], compare: ['--sample', '--project', '--no-write'], hunt: ['--before'], scan: ['--quarantine'], run: ['--no-heal', '--no-replan'], plan: ['--lanes', '--vto-raw'] };
  for (const [c, flags] of Object.entries(mustMention)) for (const f of flags) assert.ok(helpFor(c).includes(f), `${c} help lacks ${f}`);
});

test('a boolean flag does not swallow the command; hunt without a victim is a usage error (stderr, exit 2)', () => {
  const dir = empty();
  const r = cli(dir, ['--verbose', 'frobnicate']);
  assert.equal(r.code, 2); assert.match(r.stderr, /unknown command "frobnicate"/);
});

test('verify --no-plan is honoured; --orders planned with --no-plan is a usage error; bad --sample is a usage error', integration, () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': wrappedConfig({ include: ['test/**/*.test.ts'] }, { mode: 'shared' }),
    'test/a.test.ts': `import { it, expect } from 'vitest';\nit('a', () => { expect(1).toBe(1); });\n`,
    'test/b.test.ts': `import { it, expect } from 'vitest';\nit('b', () => { expect(2).toBe(2); });\n`,
  });
  const base = ['verify', '--mode', 'shared'];
  const contradiction = cli(root, [...base, '--orders', 'planned', '--no-plan']);
  assert.equal(contradiction.code, 2, contradiction.out); assert.match(contradiction.stderr, /contradicts --no-plan/);
  const r = cli(root, [...base, '--orders', 'gate,planned', '--no-plan']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skipping the planned order/); assert.match(r.out, /orders gate: /);
  assert.doesNotMatch(r.out, /plan: \d+ lanes/, 'no plan may be built under --no-plan');
  const withPlan = cli(root, [...base, '--orders', 'gate,planned']);
  assert.equal(withPlan.code, 0, withPlan.out); assert.match(withPlan.out, /plan: \d+ lanes/);
  const s = cli(root, ['verify', '--sample', 'many']);
  assert.equal(s.code, 2, s.out); assert.match(s.stderr, /--sample must be a positive number/);
  const h = cli(root, ['hunt']); assert.equal(h.code, 2); assert.match(h.stderr, /missing <victim>/);
});

test('reactPackages reaches the setup file through provide', integration, () => {
  const root = project({ 'package.json': '{"type":"module"}', 'test/a.test.ts': `import { it } from 'vitest';\nit('a', () => {});\n` });
  const code = `import { defineVitestGuardConfig } from ${JSON.stringify(pathToFileURL(indexFile).href)};\nconst c = defineVitestGuardConfig({ test: { include: ['test/**/*.test.ts'] } }, { reactPackages: ['my-react-lib'] });\nconsole.log(JSON.stringify(c.test.provide.vitestGuard.reactPackages));\n`;
  fs.writeFileSync(path.join(root, 'print.mjs'), code);
  const r = cli(root, [], { bin: path.join(root, 'print.mjs') });
  assert.match(r.stdout, /\["my-react-lib"\]/, r.out);
});
