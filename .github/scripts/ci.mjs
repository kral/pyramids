#!/usr/bin/env node
// vto's own CI, as one script: `.github/workflows/vto-ci.yml` runs exactly these steps, and
// `node .github/scripts/ci.mjs all` (= `npm run test:all`) runs them on a developer machine.
//
//   node .github/scripts/ci.mjs <step>… [--allow-skips]
//   steps: install lint smoke analyzer collector mcp tui vm-guard verify oddpath | all
//   (`all` = everything except `install`; run `install` once on a fresh clone)
//
// Rules enforced here (REVIEW-2 A-4 / U-9):
//   - a SKIPPED test is a failure unless it is on the platform allow-list below or the caller
//     passes --allow-skips / VTO_ALLOW_SKIPS=1 (integration tests used to skip themselves when a
//     fixture was not installed, and a skip counted as green);
//   - VTO_REQUIRE_INTEGRATION=1 is exported to every test so suites can fail instead of skipping;
//   - every CLI must answer --help and --version with exit 0 (the main entry point once shipped
//     with a syntax error that no job executed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VTO_CI_REPO ? path.resolve(process.env.VTO_CI_REPO) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const EXE = WIN ? 'vto.exe' : 'vto';
const argv = process.argv.slice(2);
const ALLOW_SKIPS = argv.includes('--allow-skips') || process.env.VTO_ALLOW_SKIPS === '1';
// Skips that are legitimate on one platform: matched against "<test name> <skip reason>".
const PLATFORM_SKIPS = WIN ? /symlink|posix|shebang|permission|chmod|\bpty\b|A-1:|O_NOFOLLOW|unix/i : null;

const log = (s) => process.stdout.write(`\n\x1b[1m▶ ${s}\x1b[0m\n`);
const rel = (p) => path.relative(REPO, p) || '.';
class StepError extends Error {}
const fail = (msg) => { throw new StepError(msg); };

function analyzerBin() {
  const env = process.env.VTO_ANALYZER;
  if (env) { if (!path.isAbsolute(env) || !fs.existsSync(env)) fail(`VTO_ANALYZER=${env} is not an absolute path of an existing file`); return env; }
  const p = path.join(REPO, 'analyzer', 'target', 'release', EXE);
  return fs.existsSync(p) ? p : null;
}
function baseEnv(extra = {}) {
  const bin = analyzerBin();
  return { ...process.env, CI: process.env.CI ?? 'true', VTO_REQUIRE_INTEGRATION: ALLOW_SKIPS ? '' : '1', ...(bin ? { VTO_ANALYZER: bin } : {}), ...extra };
}
/** Run a command (argv, no shell), streaming output; returns { status, out } with `capture`. */
function sh(cmd, args, { cwd = REPO, env = baseEnv(), capture = false, ok = [0], input } = {}) {
  process.stdout.write(`  $ ${[path.basename(cmd), ...args].join(' ')}   (${rel(cwd)})\n`);
  // npm/npx are .cmd shims on Windows: they need a shell there; every argument we pass is a constant of this file
  const shell = WIN && /^(npm|npx)$/.test(cmd);
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell, input, stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
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
    if (e.name === 'node_modules' || e.name === 'target' || e.name === '.git' || e.name === 'dist') continue;
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
  const r = sh(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map((f) => path.relative(cwd, f))], { cwd, env: baseEnv(env), capture: true, ok: [0, 1] });
  const lines = r.out.split('\n');
  const failed = lines.filter((l) => /^\s*not ok \d+/.test(l) && !/# (SKIP|TODO)/i.test(l));
  const skipped = lines.map((l) => /^\s*ok \d+ - (.*?) # SKIP\s*(.*)$/i.exec(l)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`.trim());
  const count = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.out) ?? [])[1] ?? 0);
  process.stdout.write(`  tests ${count('tests')}, pass ${count('pass')}, fail ${count('fail')}, skipped ${count('skipped')}\n`);
  if (r.status !== 0 || failed.length) { process.stdout.write(r.out.split('\n').filter((l) => !/^\s+(Test\.|async |at |node:)/.test(l)).join('\n') + r.err); fail(`${failed.length || 'some'} test(s) failed in ${rel(cwd)}`); }
  if (!count('tests')) fail(`0 tests ran in ${rel(cwd)}`);
  checkSkips(rel(cwd), skipped);
}

/** Vitest with a JSON report; same skip rule. */
function vitestTests(cwd, env = {}) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vto-ci-')), 'vitest.json');
  const vitest = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitest)) fail(`vitest is not installed in ${rel(cwd)} (npm ci)`);
  const r = node([vitest, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`], { cwd, env: baseEnv(env), ok: [0, 1] });
  let j;
  try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { fail(`vitest wrote no JSON report in ${rel(cwd)}`); }
  const all = j.testResults.flatMap((f) => f.assertionResults.map((a) => ({ ...a, file: path.relative(cwd, f.name) })));
  const skipped = all.filter((a) => a.status === 'pending' || a.status === 'skipped' || a.status === 'todo').map((a) => `${a.file} > ${a.fullName}`);
  process.stdout.write(`  tests ${all.length}, pass ${all.filter((a) => a.status === 'passed').length}, fail ${all.filter((a) => a.status === 'failed').length}, skipped ${skipped.length}\n`);
  if (r.status !== 0) fail(`tests failed in ${rel(cwd)}`);
  if (!all.length) fail(`0 tests ran in ${rel(cwd)}`);
  checkSkips(rel(cwd), skipped);
}
const testFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f)) : []);
const need = (p, hint) => { if (!fs.existsSync(path.join(REPO, p))) fail(`${p} is missing: ${hint}`); };

// ------------------------------------------------------------------ steps
const NPM_DIRS = ['.', 'collector/corpus', 'mcp', 'mcp/test/fixture', 'tui', 'vm-guard'];
const STEPS = {
  /** `npm ci --ignore-scripts` in every package that has a lockfile (no install script ever runs) */
  install() {
    for (const d of NPM_DIRS) {
      if (!fs.existsSync(path.join(REPO, d, 'package-lock.json'))) fail(`${d}/package-lock.json is missing – every package installs from a lockfile`);
      sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(REPO, d) });
    }
  },

  /** static checks: syntax of every script, repo hygiene (samples, docs, workflow pins) */
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

  /** every CLI answers --help and --version; the dispatcher's own tests */
  smoke() {
    node([path.join(REPO, '.github/scripts/smoke-cli.mjs')]);
    nodeTests(REPO, testFiles(path.join(REPO, '.github/scripts/test')));
  },

  analyzer() {
    const target = process.env.VTO_CARGO_TARGET ? ['--target', process.env.VTO_CARGO_TARGET] : [];
    sh('cargo', ['test', '--locked', ...target], { cwd: path.join(REPO, 'analyzer') });
    sh('cargo', ['build', '--locked', '--release', ...target], { cwd: path.join(REPO, 'analyzer') });
  },

  collector() {
    need('node_modules/oxc-parser', 'npm ci --ignore-scripts');
    need('collector/corpus/node_modules/vitest', 'npm --prefix collector/corpus ci --ignore-scripts');
    node([path.join(REPO, 'collector/selftest.mjs')]);
    const r = node([path.join(REPO, 'collector/corpus/run.mjs')], { cwd: path.join(REPO, 'collector/corpus'), capture: true });
    process.stdout.write(r.out.split('\n').slice(-6).join('\n') + '\n');
    if (/plugin (is )?missing|\bskip(ped)?\b.*plugin/i.test(r.out + r.err) && !ALLOW_SKIPS) fail('the corpus harness skipped itself (plugin not found)');
    nodeTests(REPO, testFiles(path.join(REPO, 'collector/test')));
  },

  mcp() {
    need('mcp/node_modules', 'npm --prefix mcp ci --ignore-scripts');
    need('mcp/test/fixture/node_modules', 'npm --prefix mcp/test/fixture ci --ignore-scripts');
    if (!analyzerBin()) fail('analyzer binary missing: run the `analyzer` step or set VTO_ANALYZER');
    nodeTests(path.join(REPO, 'mcp'), testFiles(path.join(REPO, 'mcp/test')));
  },

  tui() {
    need('tui/node_modules', 'npm --prefix tui ci --ignore-scripts');
    const tsc = path.join(REPO, 'tui/node_modules/typescript/bin/tsc');
    node([tsc, '-p', '.'], { cwd: path.join(REPO, 'tui') });             // typecheck + dist/ for the e2e tests and `vto ui`
    vitestTests(path.join(REPO, 'tui'), { VTO_LANG: '' });
  },

  'vm-guard'() {
    need('vm-guard/node_modules/vitest', 'npm --prefix vm-guard ci --ignore-scripts');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'vm-guard/package.json'), 'utf8'));
    if (pkg.scripts?.['check:bundle']) node([path.join(REPO, 'vm-guard/scripts/bundle-setup.mjs'), '--check'], { cwd: path.join(REPO, 'vm-guard') });
    nodeTests(path.join(REPO, 'vm-guard'), testFiles(path.join(REPO, 'vm-guard/test')), { VM_GUARD_TEST_NO_INTEGRATION: '' });
  },

  verify() {
    need('node_modules/oxc-parser', 'npm ci --ignore-scripts');
    if (!analyzerBin()) fail('analyzer binary missing: run the `analyzer` step or set VTO_ANALYZER');
    nodeTests(REPO, testFiles(path.join(REPO, 'verify/test')));
  },

  /**
   * The same checkout under a path with a space and diacritics ("Můj projekt ěš"): smoke, collector
   * and verify end-to-end. In the workflow the job is checked out into such a path directly; locally
   * the work tree is copied (node_modules linked) into the temp dir.
   */
  oddpath() {
    if (/[^\x00-\x7f]/.test(REPO) && REPO.includes(' ')) {
      process.stdout.write(`  already running in ${REPO}\n`);
    } else {
      const dst = path.join(fs.realpathSync(os.tmpdir()), `vto ci ${process.pid}`, 'Můj projekt ěš', 'vto');
      fs.mkdirSync(dst, { recursive: true });
      const skip = new Set(['node_modules', 'target', '.git', 'perf', 'bench']);
      fs.cpSync(REPO, dst, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
      for (const nm of ['node_modules', 'collector/corpus/node_modules', 'mcp/node_modules', 'mcp/test/fixture/node_modules', 'tui/node_modules', 'vm-guard/node_modules']) {
        if (fs.existsSync(path.join(REPO, nm))) fs.symlinkSync(path.join(REPO, nm), path.join(dst, nm), 'junction');
      }
      const bin = analyzerBin();
      if (!bin) fail('analyzer binary missing: run the `analyzer` step or set VTO_ANALYZER');
      try {
        node([path.join(dst, '.github/scripts/ci.mjs'), 'oddpath', ...(ALLOW_SKIPS ? ['--allow-skips'] : [])], { cwd: dst, env: { ...process.env, VTO_CI_REPO: dst, VTO_ANALYZER: bin } });
      } finally { fs.rmSync(path.dirname(path.dirname(dst)), { recursive: true, force: true }); }
      return;
    }
    STEPS.smoke();
    node([path.join(REPO, 'collector/selftest.mjs')]);
    nodeTests(REPO, testFiles(path.join(REPO, 'collector/test')));
    STEPS.verify();
  },
};

const wanted = argv.filter((a) => !a.startsWith('--'));
const order = ['lint', 'smoke', 'analyzer', 'collector', 'mcp', 'tui', 'vm-guard', 'verify', 'oddpath'];
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
  process.stdout.write('\nSummary\n' + results.map(([s, st, ms, msg]) => `  ${st.padEnd(6)} ${s.padEnd(10)} ${(ms / 1000).toFixed(1)} s${msg ? `   ${msg}` : ''}`).join('\n') + '\n');
}
process.exit(results.some((r) => r[1] !== 'ok') ? 1 : 0);
