#!/usr/bin/env node
// CI helper: run only the tests affected by a pull request, with a full run as the safe fallback.
// Works the same in bash, PowerShell and cmd (no xargs, no pipes, no shell).
//
//   node <vto>/docs/ci/run-affected.mjs --map vto-map.jsonl --base origin/main [-- <vitest args>]
//
//   map present, selection possible   → vitest run <affected test files>
//   selection is empty                → nothing runs, exit 0
//   no map / stale map / config change / any analyzer error (exit 3 or anything unexpected)
//                                     → vitest run (whole suite) – never "0 tests, green"
// Exit code: Vitest's (0 ok, 1 failures); 2 for a usage error of this script.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'vto.mjs');
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const vitestArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const opt = { map: 'vto-map.jsonl', base: null, root: process.cwd() };
for (let i = 0; i < own.length; i++) {
  const a = own[i];
  if (a === '--map') opt.map = own[++i];
  else if (a === '--base') opt.base = own[++i];
  else if (a === '--root') opt.root = own[++i];
  else if (a === '--help' || a === '-h') { console.log('usage: run-affected.mjs --map FILE --base REF [--root DIR] [-- vitest args]'); process.exit(0); }
  else { console.error(`run-affected: unknown option (see --help)`); process.exit(2); }
}
if (!opt.base || !opt.map) { console.error('run-affected: --base REF is required (see --help)'); process.exit(2); }
const root = path.resolve(opt.root);
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!fs.existsSync(vitestBin)) { console.error(`run-affected: vitest is not installed in ${root} (npm ci first)`); process.exit(2); }

function vitest(filters, why) {
  console.log(`vto: ${why}`);
  const r = spawnSync(process.execPath, [vitestBin, 'run', ...vitestArgs, ...filters], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const runAll = (why) => vitest([], `running the whole suite – ${why}`);

if (!fs.existsSync(path.resolve(root, opt.map))) runAll(`no coverage map at ${opt.map} (first run, or the artifact expired)`);
const sel = spawnSync(process.execPath, [VTO, 'affected', path.resolve(root, opt.map), '--git', opt.base, '--root', root, '--vitest'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
if (sel.status === 3) runAll('the map cannot answer for this change (exit 3; reasons above)');
if (sel.status !== 0) runAll(`the selection step failed (exit ${sel.status ?? sel.signal}); treated as "run all"`);
let filters;
try { filters = JSON.parse(sel.stdout); } catch { runAll('the selection step printed no JSON'); }
if (filters === null) runAll('the analyzer answered "run all"');
if (!Array.isArray(filters) || filters.some((f) => typeof f !== 'string' || f.startsWith('-'))) runAll('unexpected selection output');
if (!filters.length) { console.log('vto: 0 tests affected by this change – nothing to run'); process.exit(0); }
// Windows limits a command line to 32 767 characters
if (filters.join(' ').length > 24_000) runAll(`${filters.length} test files selected – more than fits on a command line`);
vitest(filters, `running ${filters.length} affected test file(s) of this change`);
