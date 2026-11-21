#!/usr/bin/env node
// vto – one command for every vto tool (design: docs/CLI.md).
//
// This file is a thin dispatcher: it maps `vto <command>` to the existing entry points and adds
// what they lack as a set – one `--help`, one `--version`, one place for global options and the
// exit-code table of contracts/DECISIONS.md (D3). It contains no tool logic; arguments after the
// command are passed through unchanged and the tool's exit code is returned.
//
// No dependency, no top-level import of a tool: `vto --help` works on a bare clone.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 5];
const EXE = process.platform === 'win32' ? 'vto.exe' : 'vto';

const EXIT = `Exit codes (every command):
  0  ok (for a selection: the printed selection is complete, possibly empty)
  1  tests failed
  2  usage or configuration error (bad argument, missing input, unsupported Node, config not wrapped)
  3  affected: no safe selection – run the whole suite
  4  guard: quarantine / conflict state changed – commit it and re-run
  5  guard verify: false green (a test passes in the fast mode and fails isolated)
  any other non-zero code (crash, signal): treat as "failed, run all"`;

/**
 * Command table. `node`: a JS entry point relative to the vto home, `analyzer`: the Rust binary,
 * `sub`: nested commands, `prepend`: arguments put before the user's, `todo`: designed, not built.
 */
const COMMANDS = {
  run: {
    summary: 'run tests: affected (default) | full | failed | <file[:line]>…',
    usage: 'vto run [affected|full|failed|<file[:line]>…] [--base REF] [--clean] [--bail N] [-t NAME] [--root DIR] [--json] [--no-daemon]',
    detail: 'Affected tests through the daemon (started on demand) or in-process with --no-daemon.\nMaps to: vto-daemon run-affected | run --full | run --failed | run <files>.',
    resolve(args) {
      const [first, ...rest] = args;
      if (first === undefined || first.startsWith('-')) return { node: 'mcp/bin/vto-daemon.mjs', args: ['run', ...args] };
      if (first === 'affected') return { node: 'mcp/bin/vto-daemon.mjs', args: ['run', ...rest] };
      if (first === 'full') return { node: 'mcp/bin/vto-daemon.mjs', args: ['run', '--full', ...rest] };
      if (first === 'failed') return { node: 'mcp/bin/vto-daemon.mjs', args: ['run', '--failed', ...rest] };
      return { node: 'mcp/bin/vto-daemon.mjs', args: ['run', ...args] };
    },
  },
  affected: {
    summary: 'list the tests affected by a change (no run); exit 3 = run all',
    usage: 'vto affected <map|rawDir> (--git BASE | --diff FILE --base SHA) [--json | --vitest [--print0]] [--root DIR]',
    detail: 'The selection kernel (Rust analyzer). For "select and run" use `vto run`.',
    analyzer: true, prepend: ['affected'], helpArgs: ['--help'],
  },
  why: {
    summary: 'why did this test fail / why was it selected',
    usage: 'vto why <test-id|file:line> [--root DIR] [--json]',
    node: 'mcp/bin/vto-daemon.mjs', prepend: ['why'],
  },
  ui: {
    summary: 'live terminal UI of the current run (failures, code frames, rerun, AI prompt)',
    usage: 'vto ui [--wait] [--file RUN.jsonl | --latest | --stdin | --mock] [--ci] [--root DIR]',
    node: 'tui/bin/vto-ui.mjs', helpArgs: ['--help'],
    missing: 'the TUI is not built: run `npm --prefix tui ci && npm --prefix tui run build` in the vto checkout',
    needs: 'tui/dist/cli.js',
  },
  watch: {
    summary: 'plain-text stream of the current run (no TUI)',
    usage: 'vto watch [--root DIR]',
    node: 'mcp/bin/vto-daemon.mjs', prepend: ['watch'],
  },
  daemon: {
    summary: 'daemon: start | stop | status | savings',
    usage: 'vto daemon start|stop|status|savings [--root DIR] [--json]',
    sub: {
      start: { node: 'mcp/bin/vto-daemon.mjs', prepend: ['serve'], summary: 'run the daemon in the foreground (warm Vitest + incremental map)' },
      serve: { node: 'mcp/bin/vto-daemon.mjs', prepend: ['serve'], hidden: true },
      stop: { node: 'mcp/bin/vto-daemon.mjs', prepend: ['stop'], summary: 'stop the daemon of this project' },
      status: { node: 'mcp/bin/vto-daemon.mjs', prepend: ['status'], summary: 'state of the daemon and the map' },
      savings: { node: 'mcp/bin/vto-daemon.mjs', prepend: ['savings'], summary: 'time / CPU / tokens saved [--since 30d]' },
      logs: { todo: true, summary: 'print the daemon and lane logs' },
    },
  },
  mcp: {
    summary: 'MCP server on stdio (for Claude Code, Cursor, VS Code)',
    usage: 'vto mcp [--root DIR]',
    node: 'mcp/bin/vto-mcp.mjs', noHelpForward: true,
    detail: 'Speaks MCP on stdin/stdout; start it from the client configuration, not by hand.\nExample (.mcp.json): {"mcpServers":{"vto":{"command":"node","args":["<vto>/bin/vto.mjs","mcp","--root","."]}}}',
  },
  hook: {
    summary: 'agent hooks: `vto hook claude` (PreToolUse: steer `vitest run` to run_affected)',
    usage: 'vto hook claude',
    sub: { claude: { node: 'mcp/hooks/claude-pretooluse.mjs', summary: 'Claude Code PreToolUse hook (reads the hook JSON on stdin)', noHelpForward: true } },
  },
  map: {
    summary: 'coverage map: record | pack',
    usage: 'vto map record <rawDir> [--engine v2|v8] [-- vitest args]\n       vto map pack <rawDir> --out FILE [--root DIR]',
    sub: {
      record: { node: 'collector/run-raw.mjs', summary: 'run Vitest with the collector and write raw per-test coverage' },
      pack: { analyzer: true, prepend: ['pack'], summary: 'write one portable map file from a raw dir (the only way a map travels to CI)' },
      status: { todo: true, summary: 'age, commit and size of the map' },
      import: { todo: true, summary: 'load a packed map into .vto/' },
      clear: { todo: true, summary: 'delete the map' },
    },
  },
  report: {
    summary: 'reports: overlap (tests with overlapping coverage)',
    usage: 'vto report overlap [--out DIR] [--threshold X] [--raw DIR] [--analyze-only] [-- vitest args]',
    sub: {
      overlap: { node: 'vitest-overlap.mjs', helpArgs: ['--help'], summary: 'collect per-test coverage and write overlap-report/report.md + report.json' },
      slow: { todo: true, summary: 'slowest tests / files' },
      imports: { todo: true, summary: 'most expensive module loads' },
      env: { todo: true, summary: 'test files that do not need their DOM environment' },
    },
  },
  analyze: {
    summary: 'analyse an existing raw dir / map (the analyzer without a test run)',
    usage: 'vto analyze <rawDir|map> [--out DIR] [--threshold X] [--lang en|cs]',
    analyzer: true, helpArgs: ['--help'],
  },
  verify: {
    summary: 'mutation check of redundancy candidates: `vto verify overlap`',
    usage: 'vto verify overlap --raw DIR --report overlap-report/report.json [--out DIR] [--min-mutants N]',
    sub: { overlap: { node: 'verify/verify.mjs', helpArgs: ['--help'], summary: 'confirm or reject the candidates of report.json by mutation testing' } },
  },
  guard: {
    summary: 'vitest-guard: check | verify | compare | calibrate | scan | plan | run | hunt | report',
    usage: 'vto guard <check|verify|compare|calibrate|scan|plan|run|hunt|report> [options]',
    detail: 'Fast Vitest pools made safe (vmThreads / shared workers). Needs vitest.config wrapped with defineVitestGuardConfig.',
    node: 'vitest-guard/bin/vitest-guard.mjs', helpArgs: ['--help'],
  },
  ci: {
    summary: 'print a CI template: `vto ci github` | `vto ci azure`',
    usage: 'vto ci github|azure [--out FILE]',
    builtin: ciTemplate,
  },
  doctor: {
    summary: 'check the installation: Node, analyzer binary, Vitest, git, TUI build',
    usage: 'vto doctor [--root DIR] [--json]',
    builtin: doctor,
  },
  init: { summary: 'set up a project (.vto/config.json, .gitignore, MCP + hook config)', usage: 'vto init', todo: true },
};

// ------------------------------------------------------------------ helpers
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'package.json'), 'utf8')).version ?? 'unknown'; } catch { return 'unknown'; }
}
// A message never echoes raw user input: control characters would reach the terminal / CI log.
const show = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 200);
function fail(msg, code = 2) { process.stderr.write(`vto: ${msg}\n     see vto --help\n`); process.exit(code); }

function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/**
 * The analyzer binary: $VTO_ANALYZER, else the build next to this checkout. Never PATH (`vto` on
 * npm is somebody else's package) and never anything inside the project under test.
 */
function analyzerPath(env = process.env) {
  const tried = [];
  for (const k of ['VTO_ANALYZER', 'VTO_BIN']) {
    const v = env[k];
    if (!v) continue;
    if (k === 'VTO_BIN') process.stderr.write('vto: VTO_BIN is deprecated, use VTO_ANALYZER\n');
    if (path.isAbsolute(v) && fs.existsSync(v)) return { bin: v, source: k };
    tried.push(`$${k}=${show(v)} (must be an absolute path of an existing file)`);
  }
  for (const rel of [`analyzer/target/release/${EXE}`]) {
    const p = path.join(HOME, rel);
    if (fs.existsSync(p)) return { bin: p, source: 'build' };
    tried.push(p);
  }
  return { bin: null, tried };
}

function overview() {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const rows = Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(w)}  ${c.summary}${c.todo ? '  (planned)' : ''}`);
  return `vto ${version()} – faster Vitest runs: test impact analysis, safe fast pools, overlap reports

Usage: vto <command> [options]        vto <command> --help        vto --version

Commands:
${rows.join('\n')}

Global options (before or after the command):
  --lang en|cs   output language (default en; same as VTO_LANG)
  --no-daemon    never start or use the daemon (same as VTO_NO_DAEMON=1)
  --help, -h     help of vto or of a command
  --version, -V  version of vto

${EXIT}

Environment: VTO_ANALYZER (absolute path of the analyzer binary), VTO_LANG, VTO_NO_DAEMON, VTO_EDITOR.
Docs: README.md (quickstart, which mode to use, troubleshooting), docs/CLI.md, docs/ci/.
`;
}

function commandHelp(name, c) {
  let s = `vto ${name} – ${c.summary}\n\nUsage: ${c.usage ?? `vto ${name}`}\n`;
  if (c.detail) s += `\n${c.detail}\n`;
  if (c.sub) {
    const subs = Object.entries(c.sub).filter(([, x]) => !x.hidden);
    const w = Math.max(...subs.map(([k]) => k.length));
    s += `\nSubcommands:\n${subs.map(([k, x]) => `  ${k.padEnd(w)}  ${x.summary ?? ''}${x.todo ? '  (planned)' : ''}`).join('\n')}\n`;
  }
  if (c.todo) s += '\nPlanned, not implemented yet (design: docs/CLI.md).\n';
  return s;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell: false, windowsHide: true });
    const forward = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
    child.on('error', (e) => { process.stderr.write(`vto: cannot start ${show(cmd)}: ${show(e.message)}\n`); resolve(2); });
    // a signal is "failed, run all" for scripts (D3): never 0
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function exec(target, args, env, { forHelp = false } = {}) {
  if (target.analyzer) {
    const a = analyzerPath(env);
    if (!a.bin) {
      process.stderr.write(`vto: analyzer binary not found. Tried:\n${a.tried.map((t) => `       ${t}`).join('\n')}\n` +
        '     Build it once: cargo build --release --manifest-path analyzer/Cargo.toml   (Rust >= 1.85; see README "Install")\n' +
        '     or set VTO_ANALYZER to the absolute path of a vto binary.\n');
      return 2;
    }
    return run(a.bin, [...(target.prepend ?? []), ...args], env);
  }
  const script = path.join(HOME, target.node);
  if (!fs.existsSync(script)) { process.stderr.write(`vto: ${target.node} is missing from this installation (${HOME})\n`); return 2; }
  if (target.needs && !fs.existsSync(path.join(HOME, target.needs)) && !forHelp) { process.stderr.write(`vto: ${target.missing}\n`); return 2; }
  if (target.needs && !fs.existsSync(path.join(HOME, target.needs))) return 0; // help was already printed by the dispatcher
  return run(process.execPath, [script, ...(target.prepend ?? []), ...args], env);
}

// ------------------------------------------------------------------ built-ins
function ciTemplate(args) {
  const kind = args.find((a) => !a.startsWith('-'));
  const files = { github: 'docs/ci/github-actions.yml', azure: 'docs/ci/azure-pipelines.yml' };
  if (!kind || !files[kind]) { process.stderr.write('vto ci: expected `github` or `azure`\n     see vto ci --help\n'); return 2; }
  let text;
  try { text = fs.readFileSync(path.join(HOME, files[kind]), 'utf8'); } catch { process.stderr.write(`vto ci: ${files[kind]} is missing from this installation\n`); return 2; }
  const oi = args.indexOf('--out');
  if (oi >= 0) {
    const out = args[oi + 1];
    if (!out) { process.stderr.write('vto ci: --out needs a file name\n'); return 2; }
    if (fs.existsSync(out)) { process.stderr.write(`vto ci: ${show(out)} exists – not overwritten\n`); return 2; }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, { flag: 'wx' });
    process.stderr.write(`vto ci: wrote ${show(out)}\n`);
  } else process.stdout.write(text);
  return 0;
}

async function doctor(args, env) {
  const ri = args.indexOf('--root');
  const root = path.resolve(ri >= 0 && args[ri + 1] ? args[ri + 1] : process.cwd());
  const checks = [];
  const add = (name, ok, info, fix) => checks.push({ name, ok, info, ...(ok === true ? {} : { fix }) });
  add('node', nodeOk(), process.versions.node, `Node >= ${MIN_NODE.join('.')} is required`);
  const a = analyzerPath(env);
  add('analyzer', Boolean(a.bin), a.bin ? `${a.bin} (${a.source})` : 'not found',
    'cargo build --release --manifest-path analyzer/Cargo.toml (Rust >= 1.85; Windows: MSVC Build Tools), or set VTO_ANALYZER');
  add('collector deps', fs.existsSync(path.join(HOME, 'node_modules', 'oxc-parser')), 'oxc-parser, magic-string', `npm ci --ignore-scripts   (in ${HOME})`);
  add('daemon + MCP deps', fs.existsSync(path.join(HOME, 'mcp', 'node_modules', '@modelcontextprotocol')), 'mcp/node_modules', 'npm --prefix mcp ci --ignore-scripts');
  add('tui build', fs.existsSync(path.join(HOME, 'tui', 'dist', 'cli.js')) ? true : 'optional', 'tui/dist', 'npm --prefix tui ci && npm --prefix tui run build   (only for `vto ui`)');
  let real = root;
  try { real = fs.realpathSync.native(root); } catch { /* reported below */ }
  add('project root', fs.existsSync(root), real === root ? root : `${root} → ${real} (canonical)`, 'pass --root DIR or run inside the project');
  const vp = path.join(real, 'node_modules', 'vitest', 'package.json');
  let vitest = null;
  try { vitest = JSON.parse(fs.readFileSync(vp, 'utf8')).version; } catch { /* not installed */ }
  const vOk = vitest ? Number(vitest.split('.')[0]) === 5 && Number(vitest.split('.')[1]) >= 1 : false;
  add('vitest in project', vitest ? (vOk ? true : 'untested') : false, vitest ?? 'not found in node_modules', 'vto is developed and tested against Vitest 5.1.x; run from the project root after npm ci');
  const cfg = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].find((f) => fs.existsSync(path.join(real, f)));
  add('vitest config', Boolean(cfg), cfg ?? 'none found', 'vto needs a Vitest project (vitest.config.* or vite.config.*)');
  add('git work tree', fs.existsSync(path.join(real, '.git')) ? true : 'optional', fs.existsSync(path.join(real, '.git')) ? '.git' : 'no .git here', 'selection by git diff needs a git checkout (the daemon works without one)');
  if (/[^\x00-\x7f]/.test(real) || real.includes(' ')) add('path spelling', true, 'spaces / non-ASCII characters in the path are supported');
  if (process.platform === 'win32' && (env.MSYSTEM || env.TERM_PROGRAM === 'mintty')) add('terminal', 'optional', 'Git Bash (mintty)', '`vto ui` needs Windows Terminal (or winpty); the other commands work');
  const failed = checks.filter((c) => c.ok === false);
  if (args.includes('--json')) process.stdout.write(JSON.stringify({ vto: version(), home: HOME, root: real, ok: !failed.length, checks }, null, 2) + '\n');
  else {
    process.stdout.write(`vto ${version()} (${HOME})\n`);
    for (const c of checks) {
      process.stdout.write(`  ${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : 'note'}  ${c.name.padEnd(18)} ${show(c.info)}\n`);
      if (c.ok !== true && c.fix) process.stdout.write(`        → ${c.fix}\n`);
    }
    process.stdout.write(failed.length ? `\n${failed.length} problem(s). Fix them, then run vto doctor again.\n` : '\nReady.\n');
  }
  return failed.length ? 2 : 0;
}

// ------------------------------------------------------------------ main
export async function main(argv = process.argv.slice(2), env = { ...process.env }) {
  // global options are taken from anywhere before a `--` (the rest belongs to Vitest)
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv.slice();
  const tail = dd >= 0 ? argv.slice(dd) : [];
  let help = false, ver = false;
  const rest = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-V') ver = true;
    else if (a === '--no-daemon') { env.VTO_NO_DAEMON = '1'; rest.push(a); }
    else if (a === '--lang' || a.startsWith('--lang=')) {
      const v = a.includes('=') ? a.slice(7) : own[++i];
      if (!/^(en|cs)$/.test(v ?? '')) fail('--lang must be en or cs');
      env.VTO_LANG = v; rest.push('--lang', v);
    } else rest.push(a);
  }
  // `vto --version` / `vto <anything> --version`: always the same single line
  if (ver) { process.stdout.write(`vto ${version()}\n`); return 0; }
  const name = rest[0];
  if (!name) { process.stdout.write(overview()); return help ? 0 : 2; }
  if (name === 'help') { const c = COMMANDS[rest[1]]; process.stdout.write(c ? commandHelp(rest[1], c) : overview()); return 0; }
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!cmd) fail(`unknown command ${show(name)}`);
  let args = rest.slice(1);
  // --lang / --no-daemon were consumed for the environment; only tools that know them get them back
  const strip = (list) => list.filter((a, i, all) => !(a === '--lang' || all[i - 1] === '--lang' || a === '--no-daemon'));

  let target = cmd, label = name;
  if (cmd.sub) {
    const subName = args.find((a) => !a.startsWith('-'));
    if (!subName) { process.stdout.write(commandHelp(name, cmd)); return help ? 0 : 2; }
    if (!Object.hasOwn(cmd.sub, subName)) fail(`unknown subcommand ${show(name)} ${show(subName)}`);
    target = cmd.sub[subName]; label = `${name} ${subName}`;
    args.splice(args.indexOf(subName), 1);
  }
  if (target.todo) {
    if (help) { process.stdout.write(commandHelp(label, { ...target, summary: target.summary ?? cmd.summary })); return 0; }
    fail(`\`vto ${label}\` is planned, not implemented yet (docs/CLI.md lists what exists today)`);
  }
  if (help) {
    process.stdout.write(commandHelp(label, { summary: target.summary ?? cmd.summary, usage: target.usage ?? cmd.usage, detail: target.detail ?? (cmd.sub ? undefined : cmd.detail) }));
    if (target.builtin || target.noHelpForward || !target.helpArgs) return 0;
    process.stdout.write(`\n--- options of the underlying tool (${target.analyzer ? 'analyzer' : target.node}) ---\n`);
    // help never fails because a tool could not print its own
    await exec({ ...target, prepend: [] }, target.helpArgs, env, { forHelp: true });
    return 0;
  }
  if (!nodeOk()) fail(`Node ${process.versions.node} is too old: vto needs Node >= ${MIN_NODE.join('.')}`);
  if (target.builtin) return target.builtin(args, env);
  if (target.resolve) { const r = target.resolve(strip(args)); return exec({ node: r.node }, [...r.args, ...(env.VTO_NO_DAEMON === '1' && !r.args.includes('--no-daemon') ? ['--no-daemon'] : []), ...tail], env); }
  // --lang is understood by analyzer, verify and the TUI; --no-daemon only by the daemon CLI
  const passLang = target.analyzer || /verify|vto-ui/.test(target.node ?? '');
  const passNoDaemon = /vto-daemon/.test(target.node ?? '');
  args = args.filter((a, i, all) => (passLang || !(a === '--lang' || all[i - 1] === '--lang')) && (passNoDaemon || a !== '--no-daemon'));
  return exec(target, [...args, ...tail], env);
}

const isMain = process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main().then((code) => process.exit(code), (e) => { process.stderr.write(`vto: ${show(e?.message ?? e)}\n`); process.exit(2); });
