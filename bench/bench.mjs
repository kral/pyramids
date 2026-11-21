#!/usr/bin/env node
// Benchmark: plain `vitest run` vs vto collector (v2 instrumentation, v8 precise coverage).
//   node vto/bench/bench.mjs <projectDir> [--modes plain,v2,v8] [--reps N] [--warmup] [--raw DIR]
//        [-- extra vitest args (e.g. --pool threads --environment happy-dom)]
// Prints one line per run and a summary table (median wall time, overhead, per-test overhead, raw size).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const extra = dd >= 0 ? argv.slice(dd + 1) : [];
const proj = path.resolve(own[0] ?? '.');
const opt = (k, d) => { const i = own.indexOf('--' + k); return i >= 0 ? own[i + 1] : d; };
const modes = opt('modes', 'plain,v2,v8').split(',');
const reps = Number(opt('reps', 1));
const warmup = own.includes('--warmup');
const rawBase = opt('raw', '/tmp/vto-bench-raw');

const dirSize = (d) => { let s = 0, n = 0; try { for (const f of readdirSync(d)) { s += statSync(path.join(d, f)).size; n++; } } catch {} return { s, n }; };
function run(mode) {
  const raw = `${rawBase}-${mode}`;
  const cmd = mode === 'plain'
    ? [path.join(proj, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=dot', ...extra]
    : [path.join(here, '../collector/run-raw.mjs'), raw, '--engine', mode, '--reporter=dot', ...extra];
  if (mode !== 'plain') rmSync(raw, { recursive: true, force: true });
  const t0 = process.hrtime.bigint();
  // bash `times` → user/sys CPU of all waited-for descendants (forks pool included, threads are in-process)
  const sh = `${[process.execPath, ...cmd].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}; st=$?; echo "@@TIMES"; times; exit $st`;
  const r = spawnSync('bash', ['-c', sh], { cwd: proj, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  let out = (r.stdout || '') + (r.stderr || '');
  const tm = /@@TIMES\n.*\n(\d+)m([\d.]+)s (\d+)m([\d.]+)s/.exec(out);
  const cpu = tm ? (Number(tm[1]) * 60 + Number(tm[2]) + Number(tm[3]) * 60 + Number(tm[4])) * 1000 : NaN;
  out = out.split('@@TIMES')[0].replace(/\x1b\[[0-9;]*m/g, '');
  const tests = Number(/Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(out)?.[1] ?? NaN);
  const failed = Number(/Tests\s+(\d+) failed/.exec(out)?.[1] ?? 0);
  const dur = /Duration\s+([\d.]+)(m?s)/.exec(out);
  const vdur = dur ? Number(dur[1]) * (dur[2] === 's' ? 1000 : 1) : NaN;
  let size = { s: 0, n: 0 }, records = 0;
  if (mode !== 'plain') {
    size = dirSize(raw);
    for (const f of readdirSync(raw)) records += (readFileSync(path.join(raw, f), 'utf8').match(/"t":"test"/g) || []).length;
  }
  if (r.status !== 0) console.error(out.split('\n').slice(-30).join('\n'));
  return { mode, wall, cpu, vdur, tests, failed, status: r.status, rawBytes: size.s, rawFiles: size.n, records };
}

const res = {};
for (const m of modes) {
  res[m] = [];
  if (warmup) { const w = run(m); console.log(`warmup ${m}: ${(w.wall / 1000).toFixed(1)} s`); }
  for (let i = 0; i < reps; i++) {
    const r = run(m);
    res[m].push(r);
    console.log(`${m.padEnd(5)} wall ${(r.wall / 1000).toFixed(2)} s  cpu ${(r.cpu / 1000).toFixed(2)} s  vitest ${(r.vdur / 1000).toFixed(2)} s  tests ${r.tests}${r.failed ? ` (${r.failed} failed)` : ''}  exit ${r.status}` +
      (m === 'plain' ? '' : `  raw ${(r.rawBytes / 1e6).toFixed(2)} MB in ${r.rawFiles} files, ${r.records} test records`));
  }
}
const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const base = res.plain ? med(res.plain.map((r) => r.wall)) : null;
const baseC = res.plain ? med(res.plain.map((r) => r.cpu)) : null;
const f = (ms) => `${(ms / 1000).toFixed(2)} s`;
console.log(`\n| mode | wall (median of ${reps}) | wall overhead | CPU (user+sys) | CPU overhead | CPU overhead / test | raw size |`);
console.log('|---|---|---|---|---|---|---|');
for (const m of modes) {
  const w = med(res[m].map((r) => r.wall)), c = med(res[m].map((r) => r.cpu)), t = res[m][0].tests;
  const isBase = m === 'plain' || !base;
  console.log(`| ${m} | ${f(w)} | ${isBase ? '–' : `${f(w - base)} (${(((w - base) / base) * 100).toFixed(1)} %)`} | ${f(c)} | ` +
    `${isBase ? '–' : `${f(c - baseC)} (${(((c - baseC) / baseC) * 100).toFixed(1)} %)`} | ${isBase ? `${(c / t).toFixed(2)} ms/test total` : `${((c - baseC) / t).toFixed(2)} ms`} | ` +
    `${m === 'plain' ? '–' : `${(res[m][0].rawBytes / 1e6).toFixed(2)} MB`} |`);
}
