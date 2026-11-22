#!/usr/bin/env node
// vto-daemon – CLI for humans, git hooks and CI (same engine/output rules as the MCP server).
//
//   vto-daemon status | affected [--base REF] | run [--full|--failed] [--file F[:LINE]]... [--name TEXT] [--base REF]
//              | run-affected [--base REF]        (stateless: no daemon, in-process engine)
//              | watch                            (stream events of the daemon, plain text)
//              | why <test-id> | savings [--since 30d] | ci-report [--base REF] [--full] [--out FILE]
//              | stop | serve [ROOT]
//   common: --root DIR, --json, --no-daemon, --bail N, --timeout S, --clean (no instrumentation)
//   pool: the project's own Vitest pool unless .vto/config.json / the user config / VTO_POOL says otherwise
//   exit: 0 ok · 1 test failures · 2 usage/config error · 3 run all (affected: no safe selection)
import path from 'node:path';
import fs from 'node:fs';
import { Backend, findRoot } from '../src/client.mjs';
import { serve } from '../src/daemon.mjs';

const argv = process.argv.slice(2);
if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === '--version') argv.splice(0, 0, 'status'); // flags before any command
const cmd = argv.shift() || 'status';
const flags = { files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => argv[++i];
  if (a === '--root') flags.root = val();
  else if (a === '--json') flags.json = true;
  else if (a === '--no-daemon') flags.noDaemon = true;
  else if (a === '--base') flags.base = val();
  else if (a === '--file') flags.files.push(val());
  else if (a === '--name') flags.name = val();
  else if (a === '--full') flags.full = true;
  else if (a === '--failed') flags.failed = true;
  else if (a === '--clean') flags.clean = true;
  else if (a === '--bail') flags.bail = +val();
  else if (a === '--timeout') flags.timeout = +val();
  else if (a === '--since') flags.since = val();
  else if (a === '--out') flags.out = val();
  else if (a === '-h' || a === '--help') { usage(0); }
  else if (a === '--version') { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); process.exit(0); }
  else if (!a.startsWith('-')) (flags.pos ||= []).push(a);
  else usageError(`unknown option ${a}`);
}
function usage(code) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}
// contracts/DECISIONS.md D3: usage errors = exit 2, message + one line to stderr (not the whole usage text)
function usageError(msg) { console.error(`vto-daemon: ${msg}\nsee --help`); process.exit(2); }

if (cmd === 'serve') {
  await serve(flags.pos?.[0] || flags.root || process.cwd());
} else {
  const root = path.resolve(flags.root || findRoot());
  const stateless = cmd === 'run-affected' || cmd === 'ci-report' || flags.noDaemon;
  const autostartCmds = new Set(['status', 'affected', 'run', 'watch', 'why', 'savings']);
  let b;
  if (cmd === 'stop') {
    const { connectDaemon } = await import('../src/client.mjs');
    const c = await connectDaemon(root, { autostart: false, client: 'vto-cli' }).catch(() => null);
    if (!c) { out({ stopped: false, note: 'no daemon running' }); process.exit(0); }
    await c.call('stop'); c.close(); out({ stopped: true }); process.exit(0);
  }
  // the swan glides while the daemon starts and the metrics are read (TTY only, after 0.4 s)
  const swan = cmd === 'savings' && !flags.json ? (await import('../../vitest-guard/src/swan.mjs')).startSwan('reading savings') : null;
  try { b = await Backend.open(root, { daemon: !stateless && autostartCmds.has(cmd), client: 'vto-cli' }); }
  catch (e) { swan?.stop(); console.error(`vto: ${e.message}`); process.exit(2); }
  if (b.daemonError && !flags.json) console.error(`vto: daemon unavailable (${b.daemonError}); running in-process`);
  let code = 0;
  try {
    if (cmd === 'status') out(await b.call('status'));
    else if (cmd === 'affected') { const a = await b.call('affected', { base: flags.base, limit: 100 }); out(a); if (a.runAll) code = 3; } // D3: 3 = run all
    else if (cmd === 'why') out(await b.call('why_failed', { test: flags.pos?.[0] }));
    else if (cmd === 'savings') { let r; try { r = await b.call('savings', { since: flags.since || '30d' }); } finally { swan?.stop(); } flags.json ? out(r) : await printSavings(r); }
    else if (cmd === 'watch') await watch(b);
    else if (cmd === 'run' || cmd === 'run-affected' || cmd === 'ci-report') {
      const kind = flags.full ? 'full' : flags.failed ? 'failed' : flags.files.length || flags.name ? 'tests' : 'affected';
      const filters = kind === 'tests' ? (flags.files.length ? flags.files : [undefined]).map((f) => {
        const m = f && /^(.*?)(?::(\d+))?$/.exec(f);
        return { ...(m ? { file: m[1] } : {}), ...(m?.[2] ? { line: +m[2] } : {}), ...(flags.name ? { name: flags.name } : {}) };
      }) : undefined;
      // the swan glides with live progress; failures are printed above it as they arrive (TTY only)
      const human = !flags.json && cmd !== 'ci-report';
      const runSwan = human ? (await import('../../vitest-guard/src/swan.mjs')).startSwan('starting the run') : null;
      const prog = { runId: null, total: 0, done: 0, failed: 0, files: 0, filesTotal: 0 };
      const fmt = (x) => x.toLocaleString('en-US');
      if (human) b.on('event', (ev) => {
        if (prog.runId && ev.runId && ev.runId !== prog.runId) return;
        if (ev.ev === 'run-start') { prog.total = ev.total || 0; prog.filesTotal = ev.files || 0; }
        else if (ev.ev === 'progress') Object.assign(prog, { done: ev.done ?? prog.done, failed: ev.failed ?? prog.failed, files: ev.files ?? prog.files, filesTotal: ev.filesTotal || prog.filesTotal });
        else if (ev.ev === 'failure') runSwan.log(`✗ ${ev.id}\n  ${String(ev.message).split('\n')[0]}`);
        else return;
        // the first full run does not know the test count yet: count files then
        const what = prog.total ? `${fmt(prog.done)} / ${fmt(prog.total)} tests` : `${fmt(prog.done)} test${prog.done === 1 ? '' : 's'}${prog.filesTotal ? ` · ${fmt(prog.files)} / ${fmt(prog.filesTotal)} files` : ''}`;
        runSwan.update(what + (prog.failed ? ` · ${fmt(prog.failed)} failed` : ''));
      });
      if (b.kind === 'daemon') await b.call('subscribe', { topics: ['run'], replay: false });
      const s = await b.call('start_run', { kind, filters, base: flags.base, bail: flags.bail, timeoutS: flags.timeout, instrumented: !flags.clean });
      prog.runId = s.runId; if (s.total) prog.total = s.total;
      if (human) runSwan.log(`vto: ${s.runId} ${s.kind}: ${s.total} tests in ${s.files} files, pool ${s.pool}${s.runAll ? ` (run all: ${(s.reasons || []).join('; ')})` : ''}`);
      let r;
      try { r = await b.call('wait_run', { runId: s.runId }); } finally { runSwan?.stop(); }
      if (cmd === 'ci-report') {
        const rep = await b.call('ci_summary', { runId: s.runId });
        if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(rep, null, 2) + '\n');
        out(rep);
      } else flags.json ? out(r) : printRun(r);
      code = r.failed ? 1 : r.status === 'error' ? 2 : 0;
    } else { await b.close(); usageError(`unknown command ${cmd}`); }
  } catch (e) { console.error(`vto: ${e.message}`); code = 2; }
  await b.close();
  process.exit(code);
}

function out(o) { console.log(JSON.stringify(o, null, flags.json ? 0 : 2)); }

function printRun(r) {
  const head = `${r.failed ? '✗' : '✓'} ${r.kind} run ${r.runId}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped of ${r.total} in ${(r.ms / 1000).toFixed(1)} s` +
    `${r.cpuMs != null ? ` (cpu ${(r.cpuMs / 1000).toFixed(1)} s)` : ''}${r.runAll ? ' [run all]' : ''} [pool ${r.pool || 'project config'}]`;
  console.log(head);
  for (const f of r.failures || []) {
    console.log(`  ✗ ${f.id}${f.sameErrorIn ? `  (same error in ${f.sameErrorIn} tests)` : ''}`);
    console.log(`    ${f.error}`);
    if (f.at) console.log(`    at ${f.at.join(' ← ')}`);
    if (f.diff) console.log(f.diff.split('\n').map((l) => '    ' + l).join('\n'));
  }
  if (r.moreFailureGroups) console.log(`  … ${r.moreFailureGroups} more failure groups (vto-daemon why <id>)`);
  if (r.error) console.log(`  error: ${r.error}`);
}

async function printSavings(r) {
  const { summary, table, painter, colorEnabled } = await import('../../vitest-guard/src/ui.mjs');
  const p = painter(colorEnabled());
  const min = (ms) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)} h` : `${(ms / 60000).toFixed(1)} min`);
  const n = (x) => Math.round(x).toLocaleString('en-US');
  if (!r.runs) {
    summary({ tool: 'vto', title: `savings · last ${r.since}`, verdict: 'warn', label: 'NO DATA', headline: 'no finished runs recorded in this period',
      next: ['record the map once with a full run: `vto run full`', 'then work as usual with `vto run`; every run is measured', 'before installing anywhere: `vto savings estimate --suite-min MIN`'] });
    return;
  }
  const t = r.tokens;
  const tokenRows = t.runsMeasured ? [
    ['vto answers', n(t.returned), ''],
    ['classic default reporter', n(t.classicDefault), p.green(n(t.saved.vsDefault) + ' saved')],
    ['classic minimal (agents)', n(t.classicMinimal), p.green(n(t.saved.vsMinimal) + ' saved')],
    ['classic verbose', n(t.classicVerbose), p.green(n(t.saved.vsVerbose) + ' saved')],
  ] : [];
  const est = r.estimated.wall + r.estimated.cpu;
  summary({
    tool: 'vto', title: `savings · last ${r.since}`, verdict: 'ok', label: 'MEASURED',
    headline: `${n(r.fullRunsAvoided)} full runs avoided in ${n(r.runs)} runs (${n(r.fullRuns)} full)`,
    facts: [
      ['wall time saved', min(r.wallSavedMs), 'green'],
      ['CPU saved', `${r.cpuHoursSaved} h`, 'green'],
      ['vs forks baseline', r.wallSavedVsForksMs ? `${min(r.wallSavedVsForksMs)} wall, ${(r.cpuSavedVsForksMs / 3600e3).toFixed(2)} h CPU` : undefined],
      ['test-minutes skipped', r.testMinutesSaved || undefined],
      ['first failure sooner', r.ttffRuns ? `${min(r.ttffGainedMs)} over ${n(r.ttffRuns)} failing runs` : undefined],
      ['basis', `measured ${r.measured.wall} runs, estimated ${r.estimated.wall} (no full run of that pool to compare with)`, est ? 'yellow' : undefined],
    ],
    tableLines: tokenRows.length ? table([`tokens (${t.runsMeasured} runs)`, 'tokens', ''], tokenRows, ['l', 'r', 'r'], p) : [],
    next: [...(est ? ['run `vto run full` once per pool so savings are measured, not extrapolated'] : []), 'formulas: mcp/SAVINGS.md · machine-readable: --json'],
  });
}

async function watch(b) {
  await b.call('subscribe', { topics: ['run'] });
  console.error('vto: watching (Ctrl+C to quit; runs keep going in the daemon)');
  b.on('event', (ev) => {
    if (ev.ev === 'run-start') console.log(`▶ ${ev.runId} ${ev.kind}: ${ev.total} tests, ${ev.files} files [${ev.pool}]`);
    else if (ev.ev === 'failure') console.log(`✗ ${ev.id}\n  ${String(ev.message).split('\n')[0]}${ev.frames?.[0] ? `\n  at ${ev.frames[0].file}:${ev.frames[0].line}` : ''}`);
    else if (ev.ev === 'fix-rerun') console.log(`${ev.state === 'pass' ? '✓ fixed' : '✗ still failing'}: ${ev.id}`);
    else if (ev.ev === 'run-end') console.log(`■ ${ev.runId}: ${ev.passed} passed, ${ev.failed} failed in ${(ev.ms / 1000).toFixed(1)} s`);
  });
  await new Promise((r) => b.on('close', r));
}
