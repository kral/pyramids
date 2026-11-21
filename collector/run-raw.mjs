#!/usr/bin/env node
// vto collector runner:  node run-raw.mjs <rawDir> [--engine v2|v8] [--no-clean] [--async-timeout MS] [vitest CLI args / filters...]
// Run in the project root. Loads the user's vitest/vite config through Vitest's own API,
// appends the collector (setupFile first, instrumentation plugin for v2) and forces the
// options per-test attribution needs. Exit code = Vitest's exit code (2 = vto usage/config error).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, rmdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { prepareRawDir } from './rawdir.mjs';
import { canonicalRoot, isCaseInsensitive, makeRel } from './paths.mjs';
import { workTreeState } from './git.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('-')) {
  console.error('usage: node run-raw.mjs <rawDir> [--engine v2|v8] [vitest args...]');
  process.exit(2);
}
const rawDir = path.resolve(argv.shift());
// Canonical project root (contracts/DECISIONS.md D2): realpath of the cwd, and the process moves there, so
// that Vitest/Vite, the instrumentation plugin, the workers and the recorded paths all use ONE spelling
// (symlinked checkout, junction, subst drive, lower-case drive letter, /tmp → /private/tmp).
const ROOT = canonicalRoot(process.cwd());
try { if (path.resolve(process.cwd()) !== path.resolve(ROOT)) process.chdir(ROOT); } catch {}
const CASE_INSENSITIVE = isCaseInsensitive(ROOT);
const relp = makeRel(ROOT, CASE_INSENSITIVE);
let engine = 'v2';
const ei = argv.indexOf('--engine');
if (ei >= 0) { engine = argv[ei + 1]; argv.splice(ei, 2); }
if (engine !== 'v2' && engine !== 'v8') { console.error(`vto: unknown engine "${engine}" (v2|v8)`); process.exit(2); }
let clean = true;
const nc = argv.indexOf('--no-clean'); // shards writing into one raw dir: keep existing files
if (nc >= 0) { clean = false; argv.splice(nc, 1); }
const at = argv.indexOf('--async-timeout'); // RTL asyncUtilTimeout (ms) during collection
if (at >= 0) { process.env.VTO_ASYNC_TIMEOUT = String(Number(argv[at + 1]) || 0); argv.splice(at, 2); }
if (argv[0] === '--') argv.shift();
process.env.VTO_RAW_DIR = rawDir;
process.env.VTO_ENGINE = engine;
process.env.VTO_ROOT = ROOT;
process.env.VTO_CASE_INSENSITIVE = CASE_INSENSITIVE ? '1' : '0';
// random run id in raw file names: shards / repeated runs into the same dir never collide
process.env.VTO_RUN_ID ||= Math.random().toString(36).slice(2, 10);
// validated BEFORE anything else happens; never deletes a directory vto did not create (F5)
try { prepareRawDir(rawDir, { clean }); } catch (e) { console.error(`vto: ${e.message}`); process.exit(2); }
// hardened git (D4); dirtyFiles: tracked changes and untracked files at record time (D5.9)
const { gitHead, dirty, dirtyFiles } = workTreeState(ROOT, relp);

const fail = (msg) => { console.error(`vto: ${msg}`); try { cleanupSetup(); } catch {} process.exit(2); };
const req = createRequire(path.join(process.cwd(), 'package.json'));
let vitestEntry;
try { vitestEntry = req.resolve('vitest/node'); } catch { fail(`cannot find "vitest" from ${process.cwd()} – run from the project root`); }
const { createVitest, parseCLI } = await import(pathToFileURL(vitestEntry).href);
const vitestVersion = req('vitest/package.json').version;
if (parseInt(vitestVersion) < 4) console.warn(`vto: Vitest ${vitestVersion} is untested (built for >= 4)`);


const here = path.dirname(fileURLToPath(import.meta.url));
// The setup file must be inside the Vite fs allow-list and must resolve `vitest` to the project's
// copy → place it in <project>/node_modules/.vto/ (fallback: load it from here).
let setupFile = path.join(here, engine === 'v2' ? 'setup-v2.mjs' : 'setup.ts');
let tmpSetupDir = null;
try {
  const root = realpathSync(process.cwd());
  let dst = path.join(process.cwd(), 'node_modules', '.vto');
  const nm = path.join(process.cwd(), 'node_modules');
  if (!existsSync(nm) || !realpathSync(nm).startsWith(root + path.sep)) {
    dst = path.join(process.cwd(), '.vto-tmp');
    if (!existsSync(dst)) tmpSetupDir = dst; // delete it afterwards only if we created it
  }
  mkdirSync(dst, { recursive: true });
  if (!existsSync(path.join(dst, '.gitignore'))) writeFileSync(path.join(dst, '.gitignore'), '*\n');
  const target = path.join(dst, path.basename(setupFile));
  copyFileSync(setupFile, target);
  setupFile = target;
} catch (e) { console.warn(`vto: could not copy the setup file into the project (${e.message}); using ${setupFile}`); }
let signalsFile = null;
if (engine === 'v2' && process.env.VTO_SIGNALS === '1') {
  signalsFile = path.join(path.dirname(setupFile), 'setup-signals.mjs');
  copyFileSync(path.join(here, 'setup-signals.mjs'), signalsFile);
}
const cleanupSetup = () => {
  if (!tmpSetupDir) return;
  for (const f of ['setup-v2.mjs', 'setup.ts', 'setup-signals.mjs', '.gitignore']) rmSync(path.join(tmpSetupDir, f), { force: true });
  try { rmdirSync(tmpSetupDir); } catch {} // not recursive: anything else in there stays
};

let cli;
try { cli = parseCLI(['vitest', 'run', ...argv]); } catch (e) { fail(`invalid vitest arguments: ${e.message}`); }
const { filter, options } = cli;
for (const bad of ['watch', 'ui', 'standalone', 'mergeReports']) if (options[bad]) fail(`--${bad} is not supported`);
if (options.browser?.enabled || options.browser === true) fail('browser mode is not supported (per-test coverage needs the Node runtime); use a jsdom/happy-dom environment');

let instrument = null;
const viteOverrides = {};
if (engine === 'v2') {
  // VTO_PLUGIN: alternative instrumenter (benchmarks of instrumentation variants)
  const { default: vtoInstrument } = await import(process.env.VTO_PLUGIN ? pathToFileURL(path.resolve(process.env.VTO_PLUGIN)).href : './plugin.mjs');
  instrument = vtoInstrument();
  viteOverrides.plugins = [instrument];
}

const vitest = await createVitest('test', {
  ...options, watch: false, run: true,
  coverage: { ...(typeof options.coverage === 'object' ? options.coverage : {}), enabled: false },
  includeTaskLocation: true,
}, viteOverrides, { cliFilters: filter }).catch((e) => fail(/browser/i.test(e?.message)
  ? `browser mode is not supported (per-test collection needs the Node runtime; use jsdom/happy-dom or --project to pick a non-browser project).\n  Vitest said: ${e.message}`
  : `failed to start Vitest: ${e.stack || e.message}`));

instrument?.vto.setVitest(vitest);
// ---- per-project overrides -------------------------------------------------------------
const notes = [];
const testSetupFiles = new Set();
for (const project of vitest.projects) {
  const c = project.config;
  const label = project.name ? `project "${project.name}"` : 'root project';
  if (c.browser?.enabled) { await vitest.close(); fail(`${label} uses browser mode, which is not supported; use jsdom/happy-dom or filter it out with --project`); }
  if (c.typecheck?.only) { await vitest.close(); fail(`${label} is typecheck-only`); }
  for (const f of c.setupFiles) testSetupFiles.add(f);
  if (!c.setupFiles.includes(setupFile)) c.setupFiles.unshift(setupFile); // first → resets before user hooks, collects after them
  if (signalsFile && !c.setupFiles.includes(signalsFile)) c.setupFiles.push(signalsFile); // last → afterEach before RTL cleanup
  c.includeTaskLocation = true;
  if (c.maxConcurrency !== 1) { c.maxConcurrency = 1; } // serializes test.concurrent / describe.concurrent
  if (c.sequence) c.sequence.concurrent = false;
  if (c.sequence?.hooks && c.sequence.hooks !== 'stack') notes.push(`${label}: sequence.hooks="${c.sequence.hooks}" – afterEach code may be attributed less precisely`);
  if (c.coverage) c.coverage.enabled = false;
  if (/^vm/.test(c.pool) && engine === 'v8') notes.push(`${label}: pool "${c.pool}" with --engine v8 is unsupported – use v2`);
  if (engine === 'v2' && !project.vite?.config?.plugins?.some((p) => p.name?.startsWith('vto:instrument'))) {
    await vitest.close();
    fail(`${label} has its own Vite config/server and the instrumentation plugin could not be attached. ` +
      `Add "extends: true" to the project, or add the plugin manually: import vto from 'vitest-overlap/collector/plugin.mjs'`);
  }
}
if (vitest.config.coverage) vitest.config.coverage.enabled = false;
testSetupFiles.delete(setupFile);
if (signalsFile) testSetupFiles.delete(signalsFile);
process.env.VTO_EXCLUDE_URLS = JSON.stringify([...testSetupFiles].map((f) => pathToFileURL(f).href));
// meta (format 2.1): paths in v2 records are relative to `root` (posix separators); files outside root stay absolute
// testFiles: every test file Vitest is going to collect – files that fail to load or whose tests are all
// skipped leave no worker record, the analyzer must still know they exist
let testFiles = null;
try { testFiles = [...new Set((await vitest.globTestSpecifications(filter)).map((s) => relp(s.moduleId)))].sort(); } catch (e) { console.warn(`vto: could not list test files (${e.message}) – meta.testFiles omitted`); }
writeFileSync(path.join(rawDir, `w-${process.env.VTO_RUN_ID}-meta.jsonl`), JSON.stringify({
  t: 'meta', formatVersion: engine === 'v2' ? '2.2' : '1', version: engine === 'v2' ? 2 : 1, engine, gitHead, dirty, vitest: vitestVersion, runId: process.env.VTO_RUN_ID,
  root: ROOT, caseInsensitive: CASE_INSENSITIVE, ...(dirty && dirtyFiles ? { dirtyFiles } : {}), ...(testFiles ? { testFiles } : {}), setupFiles: [...testSetupFiles].map(relp).sort(), projects: vitest.projects.map((p) => p.name || null),
  startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
if (engine === 'v8') console.warn('vto: --engine v8 stores the transformed source of every covered project file in the raw data');
for (const n of notes) console.warn(`vto: ${n}`);

// Test files whose hooks never ran in a worker (every test skipped / todo): the worker writes nothing for
// them. Their tests are recorded here as hit-less skip/todo records (no fileload record – selection treats
// a test file without one as "coverage unknown").
function writeUnrun() {
  try {
    let lines = '';
    const walk = (file, suite) => {
      for (const t of suite.tasks ?? []) {
        if (t.type === 'suite') walk(file, t);
        else if (t.type === 'test') {
          const names = [t.name];
          for (let s = t.suite; s && s !== t.file && s.name; s = s.suite) names.unshift(s.name);
          lines += JSON.stringify({ t: 'test', file: relp(file.filepath), name: t.fullTestName ?? names.join(' > '), line: t.location?.line ?? null, state: t.mode === 'todo' ? 'todo' : 'skip', hits: {} }) + '\n';
        }
      }
    };
    for (const file of vitest.state.getFiles()) if ((file.mode === 'skip' || file.mode === 'todo') && !file.result?.errors?.length) walk(file, file);
    if (lines) writeFileSync(path.join(rawDir, `w-${process.env.VTO_RUN_ID}-unrun.jsonl`), lines, { mode: 0o600 });
  } catch (e) { console.warn(`vto: could not record skipped test files: ${e.message}`); }
}

let code = 0;
try {
  await vitest.start(filter);
  code = process.exitCode ?? 0;
  writeUnrun();
} catch (e) {
  if (e?.code !== 'VITEST_FILES_NOT_FOUND' && e?.constructor?.name !== 'FilesNotFoundError') console.error(e);
  code = 1;
} finally {
  await vitest.close();
}
cleanupSetup();
process.exit(code || (process.exitCode ?? 0));
