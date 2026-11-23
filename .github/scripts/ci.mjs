#!/usr/bin/env node
// CI as one script: `.github/workflows/ci.yml` runs exactly these steps, and `node .github/scripts/ci.mjs all`
// runs them on a developer machine. Dependency-free (node only).
//
//   node .github/scripts/ci.mjs <step>… [--allow-skips]
//   steps: install lint vitest-guard | all   (`all` = lint + vitest-guard; run `install` once on a fresh clone)
//   VG_VITEST=<x.y.z> with the vitest-guard step: install that Vitest (--no-save) first, e.g. VG_VITEST=4.1.8
//
// Rules enforced here:
//   - a SKIPPED test is a failure unless it is on the platform allow-list below or the caller
//     passes --allow-skips / VG_ALLOW_SKIPS=1 (a skip is not a pass);
//   - the committed setup bundle must be what the sources produce (check:bundle).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VG_CI_REPO ? path.resolve(process.env.VG_CI_REPO) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const argv = process.argv.slice(2);
const ALLOW_SKIPS = argv.includes('--allow-skips') || process.env.VG_ALLOW_SKIPS === '1';
// Skips that are legitimate on one platform: matched against "<test name> <skip reason>".
const PLATFORM_SKIPS = WIN ? /symlink|posix|shebang|permission|chmod|\bpty\b|O_NOFOLLOW|unix/i : null;

const log = (s) => process.stdout.write(`\n\x1b[1m▶ ${s}\x1b[0m\n`);
const rel = (p) => path.relative(REPO, p) || '.';
class StepError extends Error {}
const fail = (msg) => { throw new StepError(msg); };

/** Run a command (argv, no shell except npm on Windows), streaming output; returns { status, out } with `capture`. */
function sh(cmd, args, { cwd = REPO, env = process.env, capture = false, ok = [0] } = {}) {
  process.stdout.write(`  $ ${[path.basename(cmd), ...args].join(' ')}   (${rel(cwd)})\n`);
  // npm is a .cmd shim on Windows: it needs a shell there; every argument we pass is a constant of this file
  const shell = WIN && /^(npm|npx)$/.test(cmd);
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell, stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (!ok.includes(r.status)) {
    if (capture) process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    fail(`${path.basename(cmd)} ${args.join(' ')} exited with ${r.status ?? r.signal}`);
  }
  return { status: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}
const node = (args, o) => sh(process.execPath, args, o);

function listFiles(dir, test, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, test, out);
    else if (e.isFile() && test(p)) out.push(p);
  }
  return out;
}

function checkSkips(kind, skipped) {
  const bad = skipped.filter((s) => !(PLATFORM_SKIPS && PLATFORM_SKIPS.test(s)));
  for (const s of skipped) process.stdout.write(`  skipped: ${s}${bad.includes(s) ? '' : '   (allowed on this platform)'}\n`);
  if (bad.length && !ALLOW_SKIPS) fail(`${kind}: ${bad.length} test(s) were skipped – a skipped test is not a passed test. Install the prerequisite, or pass --allow-skips on purpose.`);
}

/** node:test with TAP output; fails on failures and on skips that are not allowed. */
function nodeTests(cwd, files, env = {}) {
  if (!files.length) fail(`no test files in ${rel(cwd)}`);
  const r = sh(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map((f) => path.relative(cwd, f))], { cwd, env: { ...process.env, CI: process.env.CI ?? 'true', ...env }, capture: true, ok: [0, 1] });
  const lines = r.out.split('\n');
  const failed = lines.filter((l) => /^\s*not ok \d+/.test(l) && !/# (SKIP|TODO)/i.test(l));
  const skipped = lines.map((l) => /^\s*ok \d+ - (.*?) # SKIP\s*(.*)$/i.exec(l)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`.trim());
  const count = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.out) ?? [])[1] ?? 0);
  process.stdout.write(`  tests ${count('tests')}, pass ${count('pass')}, fail ${count('fail')}, skipped ${count('skipped')}\n`);
  // a test file that died natively (exitCode > 255: an NTSTATUS on Windows, e.g. 3221226505 = 0xC0000409) leaves no
  // subtest output: run it once more on its own so its stderr reaches the log
  for (const m of r.out.matchAll(/^not ok \d+ - (.+)\n(?:  .*\n)*?  exitCode: (\d+)/gm)) {
    if (Number(m[2]) <= 255) continue;
    const file = m[1].replace(/\\\\/g, '\\');
    process.stdout.write(`  ${file} died with exit code ${m[2]} (0x${Number(m[2]).toString(16)}); re-running it alone for its stderr:\n`);
    const d = spawnSync(process.execPath, [file], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(`${(d.stdout || '').split('\n').slice(-30).join('\n')}\n--- stderr ---\n${(d.stderr || '').split('\n').slice(-60).join('\n')}\n--- exit ${d.status ?? d.signal} ---\n`);
  }
  if (r.status !== 0 || failed.length) { process.stdout.write(r.out.split('\n').filter((l) => !/^\s+(Test\.|async |at |node:)/.test(l)).join('\n') + r.err); fail(`${failed.length || 'some'} test(s) failed in ${rel(cwd)}`); }
  if (!count('tests')) fail(`0 tests ran in ${rel(cwd)}`);
  checkSkips(rel(cwd), skipped);
}
const testFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f)) : []);
const need = (p, hint) => { if (!fs.existsSync(path.join(REPO, p))) fail(`${p} is missing: ${hint}`); };

// ------------------------------------------------------------------ steps
// VG_VITEST=<x.y.z>: run the suite against another Vitest than the lockfile's (installed --no-save, lockfile untouched)
function useVitest(dir) {
  const vg = process.env.VG_VITEST;
  if (!vg) return;
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(vg)) fail(`VG_VITEST must be an exact version such as 4.1.8, got "${vg}"`);
  sh('npm', ['install', '--no-save', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', `vitest@${vg}`], { cwd: path.join(REPO, dir) });
  const have = JSON.parse(fs.readFileSync(path.join(REPO, dir, 'node_modules/vitest/package.json'), 'utf8')).version;
  if (have !== vg) fail(`expected vitest ${vg} in ${dir}/node_modules, found ${have}`);
  process.stdout.write(`  ${dir} runs against vitest ${have}\n`);
}

const STEPS = {
  /** `npm ci --ignore-scripts` from the lockfile (no install script ever runs) */
  install() {
    if (!fs.existsSync(path.join(REPO, 'vitest-guard/package-lock.json'))) fail('vitest-guard/package-lock.json is missing – every package installs from a lockfile');
    sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(REPO, 'vitest-guard') });
  },

  /** static checks: syntax of every script, repo hygiene (docs, workflow pins) */
  lint() {
    const scripts = listFiles(REPO, (p) => /\.(mjs|cjs)$/.test(p));
    let bad = 0;
    for (const f of scripts) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) { bad++; process.stdout.write(`  SyntaxError: ${rel(f)}\n${r.stderr.split('\n').slice(0, 6).join('\n')}\n`); }
    }
    process.stdout.write(`  node --check: ${scripts.length} files, ${bad} with errors\n`);
    if (bad) fail(`${bad} script(s) do not parse`);
    node([path.join(REPO, '.github/scripts/check-repo.mjs')]);
  },

  'vitest-guard'() {
    need('vitest-guard/node_modules/vitest', 'npm --prefix vitest-guard ci --ignore-scripts');
    useVitest('vitest-guard');
    node([path.join(REPO, 'vitest-guard/scripts/bundle-setup.mjs'), '--check'], { cwd: path.join(REPO, 'vitest-guard') });
    nodeTests(path.join(REPO, 'vitest-guard'), testFiles(path.join(REPO, 'vitest-guard/test')));
  },
};

const wanted = argv.filter((a) => !a.startsWith('--'));
const order = ['lint', 'vitest-guard'];
const steps = wanted.flatMap((w) => (w === 'all' ? order : [w]));
if (!steps.length || steps.some((s) => !Object.hasOwn(STEPS, s))) {
  process.stderr.write(`usage: node .github/scripts/ci.mjs <install|${order.join('|')}|all>… [--allow-skips]\n`);
  process.exit(2);
}
const results = [];
for (const s of steps) {
  const t0 = Date.now();
  log(`${s}  (node ${process.versions.node}, ${process.platform}-${process.arch})`);
  try { STEPS[s](); results.push([s, 'ok', Date.now() - t0]); }
  catch (e) {
    if (!(e instanceof StepError)) throw e;
    process.stdout.write(`\x1b[31m✗ ${s}: ${e.message}\x1b[0m\n`);
    results.push([s, 'FAILED', Date.now() - t0, e.message]);
  }
}
if (results.length > 1 || results.some((r) => r[1] !== 'ok')) {
  process.stdout.write('\nSummary\n' + results.map(([s, st, ms, msg]) => `  ${st.padEnd(6)} ${s.padEnd(13)} ${(ms / 1000).toFixed(1)} s${msg ? `   ${msg}` : ''}`).join('\n') + '\n');
}
process.exit(results.some((r) => r[1] !== 'ok') ? 1 : 0);
