#!/usr/bin/env node
// Benchmark on a COPY of the bench project (Linux: tree CPU via /proc):
//   node dev/bench.mjs --root /tmp/vto-work/bench --out /tmp/vto-work/bench-results.json [--pool forks]
// Needs an existing map (.vto/) – run `vto-daemon run-affected` once (cold collection) before.
// Per scenario (edit → measure → revert):
//   plain   : cold `npx vitest run <affected files>` (no vto), output size with agent default (minimal) and default reporter
//   state   : stateless `vto-daemon run-affected --no-daemon` (cold Vitest per call, instrumented)
//   warm    : MCP run_affected through the warm daemon
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { treeCpuMs } from './proc-cpu.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('--root'));
const outFile = opt('--out', '/tmp/vto-bench.json');
const plainCfg = opt('--config', null); // config for the plain Vitest runs (e.g. the generated vm-guard wrapper)
const cfgArgs = plainCfg ? ['--config', plainCfg] : [];
const CLI = path.join(here, '../bin/vto-daemon.mjs');
const res = { root, at: new Date().toISOString(), scenarios: [], tokens: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(res, null, 2));

function timed(cmd, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('bash', ['-c', `TIMEFORMAT='%R %U %S'; { time ${[cmd, ...args].map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(' ')} > /tmp/vto-bench.out 2>&1 ; } 2> /tmp/vto-bench.time`], { cwd: root, env: { ...process.env, ...env } });
    p.on('exit', () => {
      const [wall, u, s] = fs.readFileSync('/tmp/vto-bench.time', 'utf8').trim().split('\n').pop().split(' ').map(Number);
      const out = fs.readFileSync('/tmp/vto-bench.out', 'utf8');
      resolve({ wallMs: Math.round(wall * 1000), cpuMs: Math.round((u + s) * 1000), outChars: out.length, outTokens: Math.ceil(out.length / 4), ...(capture ? { out } : {}), elapsed: Date.now() - t0 });
    });
  });
}
const edit = (f, from, to) => { const p = path.join(root, f); const s = fs.readFileSync(p, 'utf8'); if (!s.includes(from)) throw new Error(`${f}: "${from}" not found`); fs.writeFileSync(p, s.replace(from, to)); };

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../bin/vto-mcp.mjs'), '--root', root], stderr: 'inherit' });
const mcp = new Client({ name: 'vto-bench', version: '0' });
await mcp.connect(transport);
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 3600e3 });
  const text = r.content.map((c) => c.text).join('');
  const o = JSON.parse(text.slice(text.indexOf('\n') + 1));
  return { ms: Date.now() - t0, chars: text.length, tokens: Math.ceil(text.length / 4), o, isError: r.isError };
};
const status = (await call('daemon_status')).o;
const daemonPid = status.pid;
console.error(`daemon ${daemonPid}, map ${status.map.tests} tests`);

async function warmRun(label) {
  const cpu0 = treeCpuMs(daemonPid);
  const r = await call('run_affected');
  const cpu1 = treeCpuMs(daemonPid);
  return { label, wallMs: r.ms, treeCpuMs: Math.round(cpu1 - cpu0), laneCpuMs: r.o.cpuMs, ran: r.o.ran, failed: r.o.failed, total: r.o.total, tokens: r.tokens, chars: r.chars, firstFailureMs: r.o.firstFailureMs, runMs: r.o.ms };
}

// warm-up: lane start (not counted)
await call('run_affected');

const SCEN = [
  { name: 'CartBadge: behaviour-preserving edit', file: 'src/components/badges/CartBadge.tsx', from: 'if (count <= 0) {', to: 'if (count < 1) {' },
  { name: 'CartBadge: breaking edit (9+ → 10+)', file: 'src/components/badges/CartBadge.tsx', from: 'label = `9+`;', to: 'label = `10+`;' },
  { name: 'useQuantity hook: breaking edit (limit 10 → 9)', file: 'src/hooks/useQuantity.tsx', from: 'if (state.count + 1 > 10) {', to: 'if (state.count + 1 > 9) {' },
  { name: 'api/client.ts: top-level constant (module mocked in tests)', file: 'src/api/client.ts', from: "const BASE = 'https://api.example.test';", to: "const BASE = 'https://api2.example.test';" },
];
// pick automatic edits for the null ones: first numeric literal in a non-import line
for (const s of SCEN) if (!s.from) {
  const lines = fs.readFileSync(path.join(root, s.file), 'utf8').split('\n');
  const l = lines.find((x) => /\b\d+\b/.test(x) && !/^\s*(import|\/\/|\*)/.test(x));
  s.from = l; s.to = l.replace(/\b(\d+)\b/, (m) => String(+m + 1));
}

for (const s of SCEN) {
  console.error(`\n== ${s.name}`);
  const sc = { name: s.name, file: s.file, edit: `${s.from.trim()} → ${s.to.trim()}` };
  edit(s.file, s.from, s.to);
  const aff = await call('affected_tests', { limit: 50 });
  sc.affected = { count: aff.o.count, total: aff.o.total, files: aff.o.filesTotal, runAll: aff.o.runAll, tokens: aff.tokens, ms: aff.ms };
  const files = aff.o.files;
  if (!aff.o.runAll && files.length) {
    // plain Vitest on the affected files: agent default reporter (minimal under CLAUDECODE) and default
    sc.plainAgent = await timed('npx', ['vitest', 'run', ...cfgArgs, ...files]);
    sc.plainDefault = await timed('npx', ['vitest', 'run', ...cfgArgs, '--reporter=default', ...files]);
    sc.plainVerbose = await timed('npx', ['vitest', 'run', ...cfgArgs, '--reporter=verbose', ...files]);
  }
  // stateless vto (cold engine + lane) – advances the map; then revert + stateless again so the warm daemon sees the same change
  sc.stateless = await timed('node', [CLI, 'run-affected', '--no-daemon', '--json']);
  try { const j = JSON.parse(fs.readFileSync('/tmp/vto-bench.out', 'utf8').split('\n').filter((l) => l.startsWith('{')).pop()); sc.stateless.ran = j.ran; sc.stateless.failed = j.failed; sc.stateless.tokens = Math.ceil(JSON.stringify(j).length / 4); } catch {}
  edit(s.file, s.to, s.from);
  await timed('node', [CLI, 'run-affected', '--no-daemon', '--json']);
  edit(s.file, s.from, s.to);
  sc.warm = await warmRun('warm');
  if (sc.warm.failed) {
    const r = await call('run_affected');
    const f = r.o.failures?.[0];
    if (f) { const w = await call('why_failed', { test: f.id }); sc.whyFailed = { tokens: w.tokens, ms: w.ms }; }
  }
  edit(s.file, s.to, s.from);
  sc.warmRevert = await warmRun('warm after revert');
  res.scenarios.push(sc);
  save();
  console.error(JSON.stringify(sc));
}

// token sizes of typical calls (warm daemon)
const T = [
  ['daemon_status', {}], ['affected_tests', {}], ['coverage_of', { file: 'src/components/badges/CartBadge.tsx' }],
  ['coverage_of', { file: 'src/components/badges/CartBadge.tsx', detail: 'full' }], ['tests_for_line', { file: 'src/components/badges/CartBadge.tsx', line: 19 }],
  ['coverage_of', { test: 'test/badges/CartBadge.1.test.tsx:1' }], ['test_overlap', { file: 'test/badges/' }], ['slow_tests', {}], ['slow_imports', {}],
  ['slow_imports', { file: 'test/badges/CartBadge.1.test.tsx' }], ['suggest_env', {}], ['vm_guard_status', {}], ['savings_report', {}],
];
for (const [name, args] of T) { const r = await call(name, args); res.tokens.push({ tool: name, args, tokens: r.tokens, ms: r.ms, isError: r.isError }); console.error(`${name} ${JSON.stringify(args)}: ${r.tokens} tok, ${r.ms} ms`); }
// streaming tools on a failing run
edit(SCEN[1].file, SCEN[1].from, SCEN[1].to);
const sr = await call('start_run', { kind: 'affected' });
res.tokens.push({ tool: 'start_run', tokens: sr.tokens });
const nf = await call('next_failures', { runId: sr.o.runId, waitS: 30 });
res.tokens.push({ tool: 'next_failures', tokens: nf.tokens, ms: nf.ms });
const rs = await call('run_status', { runId: sr.o.runId });
res.tokens.push({ tool: 'run_status', tokens: rs.tokens });
await call('next_failures', { runId: sr.o.runId, cursor: nf.o.cursor, waitS: 30 });
const rf = await call('rerun_failed', { runId: sr.o.runId });
res.tokens.push({ tool: 'rerun_failed', tokens: rf.tokens });
await call('run_status', { runId: rf.o.runId });
edit(SCEN[1].file, SCEN[1].to, SCEN[1].from);
await call('run_affected');
save();
await mcp.close();
console.error(`\nresults: ${outFile}`);
