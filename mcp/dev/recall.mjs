#!/usr/bin/env node
// Correctness check of run_affected against full runs (random single-line mutations, faultinject operators).
//   node dev/recall.mjs --root <copy with map> [--n 10] [--seed 1] [--config <vitest config for the full runs>] [--out file]
// For every mutant:
//   1. run_affected through the daemon (warm) → per-test states from .vto/runs/<runId>.jsonl
//   2. full run without vto (`vitest run --reporter=json`, same config/pool)  → per-test states
//   3. recall: every test failing in the full run was selected; equality: every selected test has the
//      same state as in the full run
//   4. revert, run_affected again (map back to the base version)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend } from '../src/client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('--root'));
const N = +opt('--n', 10);
const cfg = opt('--config', null);
const outFile = opt('--out', '/tmp/vto-recall.json');
let s = (+opt('--seed', 1) * 2654435761) >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = (x) => x[Math.floor(rnd() * x.length)];
const OPS = [ // analyzer/faultinject/run.mjs
  ['number+1', /(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])/g, (m) => String(Number(m) + 1)],
  ['<=→<', /<=/g, () => '<'], ['>=→>', />=/g, () => '>'], ['===→!==', /===/g, () => '!=='], ['!==→===', /!==/g, () => '==='],
  ['&&→||', /&&/g, () => '||'], ['||→&&', /\|\|/g, () => '&&'], ['??→||', /\?\?/g, () => '||'],
  ['+→-', / \+ /g, () => ' - '], ['-→+', / - /g, () => ' + '],
  ['string', /'([^'\\\n]*)'/g, (m) => `'${m.slice(1, -1)}_x'`], ['template', /`([^`$\\\n]+)`/g, (m) => '`' + m.slice(1, -1) + '_x`'],
  ['true↔false', /\b(true|false)\b/g, (m) => (m === 'true' ? 'false' : 'true')],
  ['delete line', /^(?!\s*[{}]?\s*$)(?!.*[{}]).*;\s*$/g, () => ''],
];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : []));
const srcFiles = walk(path.join(root, 'src'));

function fullRun() {
  return new Promise((resolve) => {
    const out = path.join(root, '.vto', 'recall-full.json');
    fs.rmSync(out, { force: true });
    const t0 = Date.now();
    const args = ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...(cfg ? ['--config', cfg] : [])];
    const p = spawn('npx', args, { cwd: root, stdio: 'ignore', detached: true });
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 15 * 60e3);
    p.on('exit', () => {
      clearTimeout(timer);
      const states = new Map();
      let j = null; try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
      for (const tr of j?.testResults || []) {
        const file = path.relative(root, tr.name).split(path.sep).join('/');
        const res = tr.assertionResults || [];
        if (tr.status === 'failed' && !res.some((x) => x.status === 'failed')) states.set(`${file}\0(load)`, 'fail');
        for (const r of res) states.set(`${file}\0${[...r.ancestorTitles, r.title].join(' > ')}`, r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : 'skip');
      }
      resolve({ states, ms: Date.now() - t0, ok: !!j });
    });
  });
}
const keyOf = (id) => { const m = /^(.*?):\d+ > (.*)$/s.exec(id); return m ? `${m[1]}\0${m[2]}` : id; };
function runStates(runId) {
  const st = new Map();
  for (const l of fs.readFileSync(path.join(root, '.vto', 'runs', `${runId}.jsonl`), 'utf8').split('\n')) {
    if (!l) continue; const e = JSON.parse(l);
    if (e.ev === 'test') st.set(keyOf(e.id), e.state);
    if (e.ev === 'failure' && e.load) st.set(`${e.file}\0(load)`, 'fail');
  }
  return st;
}

const b = await Backend.open(root, { daemon: true, client: 'vto-recall' });
let suite = 0;
await b.call('wait_run', { runId: (await b.call('start_run', { kind: 'affected' })).runId });
suite = (await b.call('status')).map.tests;
const results = [];
let tries = 0;
while (results.length < N && tries++ < N * 400) {
  const file = pick(srcFiles);
  const orig = fs.readFileSync(file, 'utf8');
  const lines = orig.split('\n');
  const li = Math.floor(rnd() * lines.length);
  const line = lines[li];
  if (!line.trim() || /^\s*(\/\/|\*|\/\*|import\b|export (type|interface)\b)/.test(line)) continue;
  const [op, re, fn] = pick(OPS);
  const ms = [...line.matchAll(re)];
  if (!ms.length) continue;
  const m = pick(ms);
  const mutated = line.slice(0, m.index) + fn(m[0]) + line.slice(m.index + m[0].length);
  if (mutated === line) continue;
  lines[li] = mutated;
  fs.writeFileSync(file, lines.join('\n'));
  const rel = path.relative(root, file).split(path.sep).join('/');
  const t0 = Date.now();
  const sr = await b.call('start_run', { kind: 'affected', timeoutS: 600 });
  const sum = await b.call('wait_run', { runId: sr.runId });
  const vtoMs = Date.now() - t0;
  const vto = runStates(sr.runId);
  const full = await fullRun();
  fs.writeFileSync(file, orig);
  const fullFail = [...full.states].filter(([, v]) => v === 'fail').map(([k]) => k);
  const loadFailFiles = new Set([...full.states.keys()].filter((k) => k.endsWith('\0(load)')).map((k) => k.split('\0')[0]));
  const selectedFiles = new Set([...vto.keys()].map((k) => k.split('\0')[0]));
  const missed = sum.runAll ? [] : fullFail.filter((k) => !vto.has(k) && !(k.endsWith('\0(load)') && selectedFiles.has(k.split('\0')[0])));
  const mismatch = [...vto].filter(([k, v]) => full.states.has(k) && full.states.get(k) !== v && v !== 'skip').map(([k, v]) => `${k.replace('\0', ' > ')}: vto ${v}, full ${full.states.get(k)}`);
  const r = { file: rel, line: li + 1, op, after: mutated.trim().slice(0, 80), runAll: sum.runAll, selected: sum.ran, total: sum.total, vtoFailed: sum.failed, fullFailed: fullFail.length,
    missed: missed.map((k) => k.replace('\0', ' > ')), mismatch, vtoMs, fullMs: full.ms, fullOk: full.ok, loadFailFiles: loadFailFiles.size, timedOut: !!sum.timedOut };
  results.push(r);
  console.error(`${String(results.length).padStart(2)} ${r.missed.length ? 'MISS' : r.mismatch.length ? 'DIFF' : 'ok  '} ${rel}:${li + 1} [${op}] selected ${r.runAll ? 'ALL' : r.selected}, failing full ${r.fullFailed} / vto ${r.vtoFailed}, vto ${(vtoMs / 1000).toFixed(1)} s, full ${(full.ms / 1000).toFixed(0)} s`);
  await b.call('wait_run', { runId: (await b.call('start_run', { kind: 'affected' })).runId }); // back to base
  fs.writeFileSync(outFile, JSON.stringify({ root, results }, null, 2));
}
const killed = results.filter((r) => r.fullFailed > 0);
const failing = killed.reduce((n, r) => n + r.fullFailed, 0);
const missed = results.reduce((n, r) => n + r.missed.length, 0);
const summary = { mutants: results.length, killed: killed.length, failingInFull: failing, missed, recall: failing ? (failing - missed) / failing : 1,
  stateMismatches: results.reduce((n, r) => n + r.mismatch.length, 0), runAll: results.filter((r) => r.runAll).length,
  suiteTests: suite, meanSelected: results.reduce((x, r) => x + (r.runAll ? suite : r.selected), 0) / Math.max(1, results.length),
  meanSelectedFraction: results.reduce((x, r) => x + (r.runAll ? 1 : r.selected / suite), 0) / Math.max(1, results.length),
  meanVtoS: results.reduce((x, r) => x + r.vtoMs, 0) / results.length / 1000, meanFullS: results.reduce((x, r) => x + r.fullMs, 0) / results.length / 1000 };
fs.writeFileSync(outFile, JSON.stringify({ root, summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await b.close();
process.exit(missed || summary.stateMismatches ? 1 : 0);
