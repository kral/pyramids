#!/usr/bin/env node
/**
 * vitest-overlap – finds Vitest tests whose coverage overlaps unnecessarily.
 *
 * Usage (from the project root):
 *   npx vitest-overlap [--out DIR] [--threshold X] [--engine v2|v8] [--keep-raw] [--raw DIR] [-- vitest args/filters]
 *
 *   --out DIR        report folder (default ./overlap-report)
 *   --threshold X    Jaccard threshold for near-duplicate pairs (default 0.9)
 *   --engine E       v2 = own instrumentation (default, fast), v8 = V8 precise coverage (fallback;
 *                    its raw data contains the transformed source of every covered file)
 *   --async-timeout MS  RTL asyncUtilTimeout during collection (findBy* and waitFor; collection is slower)
 *   --signals        also record assertHash / domHash per test (≈0.5 ms/test extra)
 *   --keep-raw       keep the raw per-test data (printed path); default: deleted afterwards
 *   --raw DIR        write raw data to DIR instead of a temp dir (implies --keep-raw)
 *   --analyze-only   skip running tests, analyze an existing --raw DIR
 *   everything after `--` is passed to Vitest (filters, --project, --pool, -t …)
 *
 * Analyzer binary: $VTO_BIN, then ./analyzer/target/release/vto next to this script, then `vto` on PATH.
 * Exit code: Vitest's exit code if tests failed (the report is still produced), else the analyzer's.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { prepareRawDir, removeRawDir, assertSafeRawDir } from './collector/rawdir.mjs';
import { canonicalRoot } from './collector/paths.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const vitestArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const opt = { out: 'overlap-report', threshold: null, engine: 'v2', keepRaw: false, raw: null, analyzeOnly: false, passthrough: [] };
for (let i = 0; i < own.length; i++) {
  const a = own[i];
  const val = () => { const v = own[++i]; if (v === undefined) die(`missing value for ${a}`, 2); return v; };
  if (a === '--out') opt.out = val();
  else if (a === '--threshold') { opt.threshold = val(); if (!(Number(opt.threshold) >= 0 && Number(opt.threshold) <= 1)) die('--threshold must be within 0..1', 2); }
  else if (a === '--engine') { opt.engine = val(); if (!['v2', 'v8'].includes(opt.engine)) die('--engine must be v2 or v8', 2); }
  else if (a === '--keep-raw') opt.keepRaw = true;
  else if (a === '--signals') process.env.VTO_SIGNALS = '1';
  else if (a === '--async-timeout') { const v = Number(val()); if (!(v > 0)) die('--async-timeout must be a positive number of ms', 2); process.env.VTO_ASYNC_TIMEOUT = String(v); }
  else if (a === '--raw') { opt.raw = val(); opt.keepRaw = true; }
  else if (a === '--analyze-only') opt.analyzeOnly = true;
  else if (a === '--top') opt.passthrough.push('--top', val());
  else if (a === '--timings' || a === '--quiet' || a === '-q') opt.passthrough.push(a);
  else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*\n/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
  else die(`unknown option ${a} (vitest arguments go after --)`, 2);
}
function die(msg, code = 2) { console.error(`vitest-overlap: ${msg}`); process.exit(code); }

function findAnalyzer() {
  const cands = [];
  if (process.env.VTO_BIN) {
    if (!existsSync(process.env.VTO_BIN)) die(`$VTO_BIN points to a missing file: ${process.env.VTO_BIN}`);
    return process.env.VTO_BIN;
  }
  const exe = process.platform === 'win32' ? 'vto.exe' : 'vto';
  cands.push(path.join(here, 'analyzer', 'target', 'release', exe), path.join(here, '..', 'analyzer', 'target', 'release', exe));
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['vto'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  die(`analyzer binary not found. Build it (cargo build --release in ${path.join(here, 'analyzer')}), ` +
    `put \`vto\` on PATH or set VTO_BIN.\n  looked in: ${cands.join(', ')}`);
}

const bin = findAnalyzer(); // fail fast, before running the whole suite
// canonical project root (contracts/DECISIONS.md D2): realpath, so that collector, analyzer and git agree
// on one spelling when the checkout is reached through a symlink / junction / subst drive
const cwd = path.resolve(canonicalRoot(process.cwd()));
// raw dir: our own mkdtemp dir (0700), or a user-given --raw dir validated before anything runs (F5)
let rawDir;
try {
  if (opt.raw) rawDir = opt.analyzeOnly ? assertSafeRawDir(opt.raw) : prepareRawDir(opt.raw);
  else rawDir = prepareRawDir(mkdtempSync(path.join(tmpdir(), 'vto-raw-')));
} catch (e) { die(e.message, 2); }
let cleaned = false;
// only the temp dir is ever removed, and only if it still carries the marker and nothing but vto files
const cleanup = () => { if (!opt.keepRaw && !opt.raw && !cleaned) { cleaned = true; removeRawDir(rawDir); } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

let testCode = 0;
if (!opt.analyzeOnly) {
  console.error(`vitest-overlap: running tests (engine ${opt.engine})…`);
  const r = spawnSync(process.execPath, [path.join(here, 'collector', 'run-raw.mjs'), rawDir, '--engine', opt.engine, '--no-clean', ...vitestArgs],
    { cwd, stdio: 'inherit', env: { ...process.env, VTO_RAW_DIR: rawDir } });
  testCode = r.status ?? 1;
  if (r.error) { cleanup(); die(`cannot run collector: ${r.error.message}`, 1); }
  if (testCode === 2) { cleanup(); process.exit(2); } // vto usage/config error (already printed)
  if (testCode !== 0) console.error(`vitest-overlap: Vitest exited with code ${testCode} – failed tests are marked in the report`);
} else if (!existsSync(rawDir)) die(`--analyze-only: raw dir ${rawDir} does not exist`);

const aArgs = [rawDir, '--out', path.resolve(opt.out), '--root', cwd, ...opt.passthrough];
if (opt.threshold != null) aArgs.push('--threshold', String(opt.threshold));
const a = spawnSync(bin, aArgs, { cwd, stdio: 'inherit' });
if (a.error) { cleanup(); die(`cannot run analyzer ${bin}: ${a.error.message}`, 1); }
if (opt.keepRaw) console.error(`vitest-overlap: raw data kept in ${rawDir}`);
cleanup();
process.exit(testCode || (a.status ?? 1));
