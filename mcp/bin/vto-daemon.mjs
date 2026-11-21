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
  try { b = await Backend.open(root, { daemon: !stateless && autostartCmds.has(cmd), client: 'vto-cli' }); }
  catch (e) { console.error(`vto: ${e.message}`); process.exit(2); }
  if (b.daemonError && !flags.json) console.error(`vto: daemon unavailable (${b.daemonError}); running in-process`);
  let code = 0;
  try {
    if (cmd === 'status') out(await b.call('status'));
    else if (cmd === 'affected') { const a = await b.call('affected', { base: flags.base, limit: 100 }); out(a); if (a.runAll) code = 3; } // D3: 3 = run all
    else if (cmd === 'why') out(await b.call('why_failed', { test: flags.pos?.[0] }));
    else if (cmd === 'savings') { const r = await b.call('savings', { since: flags.since || '30d' }); flags.json ? out(r) : printSavings(r); }
    else if (cmd === 'watch') await watch(b);
    else if (cmd === 'run' || cmd === 'run-affected' || cmd === 'ci-report') {
      const kind = flags.full ? 'full' : flags.failed ? 'failed' : flags.files.length || flags.name ? 'tests' : 'affected';
      const filters = kind === 'tests' ? (flags.files.length ? flags.files : [undefined]).map((f) => {
        const m = f && /^(.*?)(?::(\d+))?$/.exec(f);
        return { ...(m ? { file: m[1] } : {}), ...(m?.[2] ? { line: +m[2] } : {}), ...(flags.name ? { name: flags.name } : {}) };
      }) : undefined;
      if (!flags.json && cmd !== 'ci-report') b.on('event', (ev) => { if (ev.ev === 'failure') console.error(`✗ ${ev.id}\n  ${String(ev.message).split('\n')[0]}`); });
      if (b.kind === 'daemon') await b.call('subscribe', { topics: ['run'], replay: false });
      const s = await b.call('start_run', { kind, filters, base: flags.base, bail: flags.bail, timeoutS: flags.timeout, instrumented: !flags.clean });
      if (!flags.json && cmd !== 'ci-report') console.error(`vto: ${s.runId} ${s.kind}: ${s.total} tests in ${s.files} files, pool ${s.pool}${s.runAll ? ` (run all: ${(s.reasons || []).join('; ')})` : ''}`);
      const r = await b.call('wait_run', { runId: s.runId });
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

function printSavings(r) {
  const m = (ms) => `${(ms / 60000).toFixed(1)} min`;
  console.log(`vto savings since ${r.since}: ${r.runs} runs (${r.fullRuns} full, ${r.partialRuns} partial)`);
  console.log(`  full runs avoided        ${r.fullRunsAvoided}`);
  console.log(`  wall time saved          ${m(r.wallSavedMs)}   (vs forks baseline ${m(r.wallSavedVsForksMs)})`);
  console.log(`  CPU saved                ${r.cpuHoursSaved} h   (vs forks baseline ${(r.cpuSavedVsForksMs / 3600e3).toFixed(3)} h)`);
  console.log(`  test-minutes saved       ${r.testMinutesSaved}`);
  console.log(`  tokens returned          ${r.tokens.returned}  (classic: default ${r.tokens.classicDefault}, minimal/agent ${r.tokens.classicMinimal}, verbose ${r.tokens.classicVerbose}; ${r.tokens.runsMeasured} runs measured)`);
  console.log(`  time-to-first-failure    ${m(r.ttffGainedMs)} gained over ${r.ttffRuns} failing runs`);
  console.log(`  measured/estimated       wall ${r.measured.wall}/${r.estimated.wall}, cpu ${r.measured.cpu}/${r.estimated.cpu} runs  (formulas: mcp/SAVINGS.md)`);
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
