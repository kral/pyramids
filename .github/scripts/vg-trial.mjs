#!/usr/bin/env node
// vitest-guard trial on a generated React 19 + RTL + jsdom suite (CI: .github/workflows/vitest-guard-trial.yml).
//
//   node .github/scripts/vg-trial.mjs <projectDir> <outDir>
//
// The project must already have `npm ci` done and @jirikral/vitest-guard installed from the packed tarball.
// Measures a plain `vitest run`, compare, check and verify in vm and shared mode, then injects two faults with an
// exact expected outcome (D3 exit codes). Writes results.json + summary.md to outDir; exit 1 when an expectation fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [proj, out] = process.argv.slice(2).map((p) => path.resolve(p));
if (!proj || !out) { console.error('usage: vg-trial.mjs <projectDir> <outDir>'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const BIN = path.join(proj, 'node_modules', '@jirikral', 'vitest-guard', 'bin', 'vitest-guard.mjs');
const VITEST = path.join(proj, 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(BIN)) { console.error(`vitest-guard is not installed in ${proj}`); process.exit(2); }

// wrap the generated config (kept as vitest.plain.config.ts for the baseline)
const cfg = path.join(proj, 'vitest.config.ts');
const plain = path.join(proj, 'vitest.plain.config.ts');
if (!fs.existsSync(plain)) fs.copyFileSync(cfg, plain);
fs.writeFileSync(cfg, `import { defineVitestGuardConfig } from '@jirikral/vitest-guard';
import base from './vitest.plain.config';
export default defineVitestGuardConfig(base, { mode: 'vm' });
`);

const results = [];
let failed = 0;
function step(name, args, { expect, vitest = false } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [vitest ? VITEST : BIN, ...args], {
    cwd: proj, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', VTO_NO_ANIMATION: '1' },
  });
  const wall = Math.round((Date.now() - t0) / 100) / 10;
  const log = `$ ${vitest ? 'vitest' : 'vitest-guard'} ${args.join(' ')}\n${r.stdout || ''}${r.stderr || ''}${r.error ? '\n' + r.error.stack : ''}`;
  const file = path.join(out, `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-')}.log`);
  fs.writeFileSync(file, log);
  const ok = !expect || expect.includes(r.status);
  if (!ok) failed++;
  const row = { name, args: args.join(' '), exit: r.status, expect: expect || null, ok, wallS: wall, log: path.basename(file) };
  results.push(row);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: exit ${r.status}${expect ? ` (expected ${expect.join('|')})` : ''}, ${wall} s`);
  if (!ok) console.log(log.split('\n').slice(-40).join('\n'));
  return { ...row, stdout: r.stdout || '' };
}

const count = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => /\.test\.tsx?$/.test(String(f))).length;
console.log(`project: ${count(path.join(proj, 'test'))} test files, node ${process.version}, ${process.platform}`);

// 1. baseline: plain Vitest (forks)
step('baseline vitest run (forks)', ['run', '--config', 'vitest.plain.config.ts', '--reporter=dot'], { vitest: true, expect: [0, 1] });
// 2. modes compared on the whole suite (CPU per mode, result mismatches against forks)
step('compare --sample all', ['compare', '--sample', 'all'], { expect: [0] });
// 3. fast modes on the whole suite: 0 = clean, 4 = quarantine recorded; never 5 (false green) or 2
step('check (vm)', ['check'], { expect: [0, 4] });
step('verify --mode vm --sample all', ['verify', '--mode', 'vm', '--sample', 'all'], { expect: [0, 4] });
step('check --mode shared', ['check', '--mode', 'shared'], { expect: [0, 4] });
step('verify --mode shared --sample all', ['verify', '--mode', 'shared', '--sample', 'all'], { expect: [0, 4] });

// 4. injected faults, exact outcomes
const leak = path.join(proj, 'test', 'zz-trial-leak');
fs.mkdirSync(leak, { recursive: true });
fs.writeFileSync(path.join(leak, 'a-sets.test.tsx'), `import { test, expect } from 'vitest';
test('sets a global for the next file', () => { (globalThis as any).__vgTrialLeak = true; expect(true).toBe(true); });
`);
fs.writeFileSync(path.join(leak, 'b-needs.test.tsx'), `import { test, expect } from 'vitest';
test('passes only after a-sets ran in the same realm', () => { expect((globalThis as any).__vgTrialLeak).toBe(true); });
`);
// the dependent test passes in a shared realm and fails in isolated forks: that is a false green (5)
step('fault: leaked global → verify shared = false green', ['verify', '--mode', 'shared', '--no-quarantine', 'test/zz-trial-leak'], { expect: [5] });
fs.rmSync(leak, { recursive: true, force: true });

const bad = path.join(proj, 'test', 'zz-trial-fail');
fs.mkdirSync(bad, { recursive: true });
fs.writeFileSync(path.join(bad, 'real.test.tsx'), `import { test, expect } from 'vitest';
test('really broken', () => { expect(1 + 1).toBe(3); });
`);
// a failure that also happens in isolated forks is real: exit 1, never quarantined
const real = step('fault: real failure → check = 1', ['check', 'test/zz-trial-fail'], { expect: [1] });
if (!/FAIL \(also isolated\)/.test(real.stdout)) { failed++; console.log('FAIL the real failure was not reported as "FAIL (also isolated)"'); results.at(-1).ok = false; }
fs.rmSync(bad, { recursive: true, force: true });

// state left by the trial (for the artifact)
for (const f of ['incompatible.json', 'conflicts.json']) {
  const p = path.join(proj, '.vitest-guard', f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(out, f));
}
const md = [`### vitest-guard trial · ${process.platform} · node ${process.version}`, '', '| step | exit | expected | wall s |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.ok ? '✅' : '❌'} ${r.name} | ${r.exit} | ${r.expect ? r.expect.join(' / ') : '–'} | ${r.wallS} |`), ''].join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), md);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);
process.exit(failed ? 1 : 0);
