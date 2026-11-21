#!/usr/bin/env node
// Smoke test: every command-line entry point starts and answers --help (and --version where it
// has one) with exit 0 and some text on stdout. Catches a file that does not parse, a missing
// import and a help printer that crashes – without running a single test.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VTO_CI_REPO ? path.resolve(process.env.VTO_CI_REPO) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = process.platform === 'win32' ? 'vto.exe' : 'vto';
const analyzer = process.env.VTO_ANALYZER || path.join(REPO, 'analyzer', 'target', 'release', EXE);
const VTO = ['bin/vto.mjs'];

// [label, argv relative to the repo, { stdout: RegExp }]   (first element of argv is a node script unless `bin`)
const cases = [
  ['vitest-overlap --help', ['vitest-overlap.mjs', '--help'], /vitest-overlap/],
  ['vto --help', [...VTO, '--help'], /Usage: vto <command>/],
  ['vto --version', [...VTO, '--version'], /^vto \d+\.\d+\.\d+/],
  ['vto help run', [...VTO, 'help', 'run'], /vto run/],
  ...['run', 'affected', 'why', 'ui', 'watch', 'daemon', 'mcp', 'hook', 'map', 'report', 'analyze', 'verify', 'guard', 'ci', 'doctor', 'init']
    .flatMap((c) => [[`vto ${c} --help`, [...VTO, c, '--help'], new RegExp(`^vto ${c}`)], [`vto ${c} --version`, [...VTO, c, '--version'], /^vto \d+\.\d+\.\d+/]]),
  ['vto report overlap --help', [...VTO, 'report', 'overlap', '--help'], /vitest-overlap/],
  ['vto verify overlap --help', [...VTO, 'verify', 'overlap', '--help'], /--min-mutants/],
  ['vto map record --help', [...VTO, 'map', 'record', '--help'], /vto map record/],
  ['vto hook claude --help', [...VTO, 'hook', 'claude', '--help'], /vto hook claude/],
  ['verify --help', ['verify/verify.mjs', '--help'], /vto verify/],
  ['verify --version', ['verify/verify.mjs', '--version'], /^vto verify \d/],
  ['vm-guard --help', ['vm-guard/bin/vm-guard.mjs', '--help'], /vm-guard/],
  ['vm-guard --version', ['vm-guard/bin/vm-guard.mjs', '--version'], /\d+\.\d+\.\d+/],
  ['vto-daemon --help', ['mcp/bin/vto-daemon.mjs', '--help'], /vto-daemon|daemon/],
];
// entry points that need a build / an install: checked when present, required with VTO_REQUIRE_INTEGRATION=1
const optional = [
  ['vto-ui --help', 'tui/dist/cli.js', ['tui/bin/vto-ui.mjs', '--help'], /vto ui/],
  ['vto-ui --version', 'tui/dist/cli.js', ['tui/bin/vto-ui.mjs', '--version'], /^vto-ui \d/],
  ['vto ui --help (through the dispatcher)', 'tui/dist/cli.js', [...VTO, 'ui', '--help'], /Event source/],
  ['vto guard --help (through the dispatcher)', 'vm-guard/bin/vm-guard.mjs', [...VTO, 'guard', '--help'], /commands/],
];
const strict = process.env.VTO_REQUIRE_INTEGRATION === '1';
let failed = 0, ran = 0;
function check(label, cmd, args, re) {
  ran++;
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' }, input: '' });
  const ok = r.status === 0 && re.test(r.stdout) && !/SyntaxError|ERR_MODULE_NOT_FOUND|\\u\{a\}/.test(r.stdout + r.stderr);
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (!ok) { failed++; process.stdout.write(`       exit ${r.status ?? r.signal}; stdout: ${JSON.stringify(r.stdout.slice(0, 300))}; stderr: ${JSON.stringify(r.stderr.slice(0, 600))}\n`); }
}
for (const [label, args, re] of cases) check(label, process.execPath, args.map((a, i) => (i === 0 ? path.join(REPO, a) : a)), re);
for (const [label, needs, args, re] of optional) {
  if (!fs.existsSync(path.join(REPO, needs))) {
    process.stdout.write(`  ${strict ? 'FAIL' : 'skip'} ${label}   (${needs} not built)\n`);
    if (strict) failed++;
    continue;
  }
  check(label, process.execPath, args.map((a, i) => (i === 0 ? path.join(REPO, a) : a)), re);
}
if (fs.existsSync(analyzer)) {
  check('analyzer --help', analyzer, ['--help'], /vto/);
  check('analyzer --version', analyzer, ['--version'], /\d+\.\d+\.\d+/);
  check('vto analyze --help (through the dispatcher)', process.execPath, [path.join(REPO, 'bin/vto.mjs'), 'analyze', '--help'], /USAGE|Usage/);
} else {
  process.stdout.write(`  ${strict ? 'FAIL' : 'skip'} analyzer --help   (${path.relative(REPO, analyzer)} not built)\n`);
  if (strict) failed++;
}
process.stdout.write(`  smoke: ${ran} invocations, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
