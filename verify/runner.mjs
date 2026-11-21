#!/usr/bin/env node
// vto verify – Vitest launcher (run in the project root).
//   node runner.mjs verify <plan.json> [vitest filters…]   mutant schemata run (setup-verify + plugin)
//   node runner.mjs collect <rawDir> [--signals] [vitest filters…]
//        v2 coverage collection like collector/run-raw.mjs (+ cheap signals setup appended when --signals)
// Mirrors collector/run-raw.mjs (Vitest's own config loading); the collector itself is not modified.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const collectorDir = process.env.VTO_COLLECTOR_DIR || path.join(here, '..', 'collector');
const argv = process.argv.slice(2);
const mode = argv.shift();
const fail = (msg) => { console.error(`vto verify: ${msg}`); process.exit(2); };
if (mode !== 'verify' && mode !== 'collect') fail('usage: runner.mjs verify <plan.json> | collect <rawDir> [--signals]');

const req = createRequire(path.join(process.cwd(), 'package.json'));
let vitestEntry;
try { vitestEntry = req.resolve('vitest/node'); } catch { fail(`cannot find "vitest" from ${process.cwd()}`); }
const { createVitest, parseCLI } = await import(pathToFileURL(vitestEntry).href);

const plugins = [];
const prepend = [];
const append = [];
const extra = {};
let filters = [];
let collectorPlugin = null;
if (mode === 'verify') {
  const planFile = path.resolve(argv.shift());
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  process.env.VTO_VERIFY_PLAN = planFile;
  const { default: vtoMutants } = await import('./plugin.mjs');
  plugins.push(vtoMutants(plan));
  prepend.push(path.join(here, 'setup-verify.mjs'));
  filters = plan.testFiles;
  extra.testTimeout = plan.testTimeout ?? 2000;
  extra.hookTimeout = Math.max(extra.testTimeout, 2000);
  extra.reporters = [['dot']];
  extra.silent = true;
} else {
  const rawDir = path.resolve(argv.shift());
  const signals = argv.includes('--signals');
  if (signals) argv.splice(argv.indexOf('--signals'), 1);
  const noCov = argv.includes('--no-coverage');
  if (noCov) argv.splice(argv.indexOf('--no-coverage'), 1);
  process.env.VTO_RAW_DIR = rawDir;
  // never delete a user-supplied dir (SECURITY-REVIEW F5): validate / create with marker, clean only vto files
  try { (await import(pathToFileURL(path.join(collectorDir, 'rawdir.mjs')).href)).prepareRawDir(rawDir); } catch (e) { fail(e.message); }
  writeFileSync(path.join(rawDir, 'w-meta.jsonl'), JSON.stringify({ t: 'meta', engine: 'v2', root: process.cwd(), startedAt: new Date().toISOString() }) + '\n');
  if (!noCov) {
    const { default: vtoInstrument } = await import(pathToFileURL(path.join(collectorDir, 'plugin.mjs')).href);
    collectorPlugin = vtoInstrument();
    plugins.push(collectorPlugin);
    prepend.push(path.join(collectorDir, 'setup-v2.mjs'));
  }
  if (signals) append.push(path.join(here, 'signals-setup.mjs'));
}

const { filter, options } = parseCLI(['vitest', 'run', ...argv]);
const vitest = await createVitest('test', {
  ...options, watch: false, run: true,
  coverage: { enabled: false },
  includeTaskLocation: true,
  ...extra,
}, {
  plugins,
  // setup files outside the project root are otherwise refused by Vite's fs guard (/@fs/… not found)
  server: { fs: { allow: [process.cwd(), here, collectorDir] } },
}, { cliFilters: [...filter, ...filters] });
collectorPlugin?.vto?.setVitest?.(vitest);
for (const project of vitest.projects) {
  const c = project.config;
  for (const f of prepend.slice().reverse()) if (!c.setupFiles.includes(f)) c.setupFiles.unshift(f);
  for (const f of append) if (!c.setupFiles.includes(f)) c.setupFiles.push(f);
  c.includeTaskLocation = true;
  c.maxConcurrency = 1;
  if (c.sequence) c.sequence.concurrent = false;
  if (mode === 'verify') { c.retry = 0; c.bail = 0; c.testTimeout = extra.testTimeout; c.hookTimeout = extra.hookTimeout; }
}
let code = 0;
try {
  await vitest.start([...filter, ...filters]);
  code = process.exitCode ?? 0;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await vitest.close();
}
process.exit(code);
