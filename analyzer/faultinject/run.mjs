#!/usr/bin/env node
// Fault-injection recall check for `vto affected` (REVIEW-1 §7.3, VALIDATION-real-suite F1).
//
//   node faultinject/run.mjs [--project DIR] [--n 40] [--seed 1] [--src src] [--vto PATH]
//                            [--collector DIR] [--full-every 10] [--keep] [--innermost] [--importers]
//
// 1. copies the project to a temp dir (node_modules symlinked), `git init` + commit = base
// 2. records the coverage map at the base with the REAL product path: collector/run-raw.mjs
//    (v2 engine, real fileload records, meta with gitHead/root, format 2.1 root-relative paths)
// 3. N times: one random single-line mutation in a source file → `vto affected --git HEAD --json`
//    (default = file granularity; the test-granularity selection is recorded for comparison)
// 4. oracle = complement: Vitest's own `list --changed HEAD` graph ∪ test files that use node:fs,
//    minus test files whose tests are all selected (a miss can only be a failing UNSELECTED test);
//    every --full-every'th mutant runs the FULL suite to validate the reduced oracle
// 5. a miss is confirmed only if the test fails twice more with the mutant and passes on the base
//    (flake confirmation); syntax-invalid and hanging mutants are reported separately
// Tests are keyed by (file, full name, line). Exit 1 on any confirmed miss of a syntax-valid mutant.
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = {
  project: path.join(here, 'fixture'), n: 40, seed: 1, src: 'src', keep: false, innermost: false, importers: false,
  vto: path.resolve(here, '../target/release/vto'), collector: path.resolve(here, '../../collector'), 'full-every': 10,
};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  if (typeof opt[k] === 'boolean') opt[k] = true;
  else if (k in opt) { opt[k] = typeof opt[k] === 'number' ? Number(args[++i]) : args[++i]; }
  else { console.error(`unknown option ${args[i]}`); process.exit(2); }
}

// ---------- deterministic RNG ----------
let s = (opt.seed * 2654435761) >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ---------- project copy ----------
const proj = path.resolve(opt.project);
const work = mkdtempSync(path.join(tmpdir(), 'vto-fi-'));
cpSync(proj, work, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.git|\.vto-fi|\.vto|overlap-report)(\/|$)/.test(path.relative(proj, p)) });
const nm = path.join(proj, 'node_modules');
if (existsSync(nm)) symlinkSync(realpathSync(nm), path.join(work, 'node_modules'));
const ENV = { ...process.env, CI: '1', FORCE_COLOR: '0' };
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
sh('git', ['init', '-q']);
sh('git', ['-c', 'user.email=fi@vto', '-c', 'user.name=fi', 'add', '-A']);
sh('git', ['-c', 'user.email=fi@vto', '-c', 'user.name=fi', 'commit', '-qm', 'base']);
writeFileSync(path.join(work, '.git', 'info', 'exclude'), '.vto-fi/\nnode_modules\n');

// ---------- record the map at the base with the real collector runner ----------
const rawDir = path.join(work, '.vto-fi', 'raw');
const vitestBin = path.join(work, 'node_modules', '.bin', 'vitest');
const t0 = Date.now();
let rec;
for (let k = 0; k < 3; k++) { // load-induced flakes of the base run are retried
  rec = spawnSync(process.execPath, [path.join(opt.collector, 'run-raw.mjs'), rawDir, '--engine', 'v2'], { cwd: work, encoding: 'utf8', env: ENV, maxBuffer: 256 << 20 });
  if (rec.status === 0) break;
  console.error(`base collector run failed (attempt ${k + 1}), retrying`);
}
if (rec.status !== 0) { console.error('base run with the collector failed:\n' + rec.stdout.slice(-3000) + rec.stderr.slice(-3000)); process.exit(2); }
console.error(`map recorded in ${Date.now() - t0} ms`);

// ---------- base test list (from the raw records; only vto's own w-*.jsonl files) ----------
const baseTests = [];
const walkRaw = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkRaw(path.join(d, e.name)) : /^w-.*\.jsonl$/.test(e.name) ? [path.join(d, e.name)] : []);
let metaRoot = work;
for (const f of walkRaw(rawDir)) for (const l of readFileSync(f, 'utf8').split('\n')) {
  if (!l) continue;
  const r = JSON.parse(l);
  if (r.t === 'meta' && r.root) metaRoot = r.root;
}
for (const f of walkRaw(rawDir)) for (const l of readFileSync(f, 'utf8').split('\n')) {
  if (!l) continue;
  const r = JSON.parse(l);
  // format 2.1: root-relative paths → resolve against meta.root, then relative to the work dir
  if (r.t === 'test') baseTests.push({ file: path.relative(work, path.resolve(metaRoot, r.file)), name: r.name, line: r.line ?? null });
}
const key = (t) => `${t.file}\u0000${t.name}\u0000${t.line ?? ''}`;
const allKeys = new Set(baseTests.map(key));
// reporter results may lack a location → (file, name) → keys
const byFileName = new Map();
for (const t of baseTests) {
  const k = `${t.file}\u0000${t.name}`;
  if (!byFileName.has(k)) byFileName.set(k, []);
  byFileName.get(k).push(key(t));
}
const testFiles = [...new Set(baseTests.map((t) => t.file))];
const totByFile = new Map();
for (const t of baseTests) totByFile.set(t.file, (totByFile.get(t.file) || 0) + 1);
// test files that read project files through node:fs (invisible to any module graph)
const FS_READERS = testFiles.filter((f) => /['"](?:node:)?fs(?:\/promises)?['"]/.test(readFileSync(path.join(work, f), 'utf8')));
console.error(`base: ${allKeys.size} tests in ${testFiles.length} files; fs readers: ${FS_READERS.length}`);

// ---------- suite runs (own process group, killed after a timeout: mutants can loop forever) ----------
const SUITE_TIMEOUT = Number(process.env.VTO_FI_TIMEOUT_MS || 120000);
const fiDir = path.join(work, '.vto-fi');
function runVitest(argv) {
  return new Promise((resolve) => {
    const p = spawn(vitestBin, argv, { cwd: work, detached: true, stdio: 'ignore', env: ENV });
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve('timeout'); }, SUITE_TIMEOUT);
    p.on('exit', () => { clearTimeout(t); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve('done'); });
  });
}
async function runSuite(files) {
  const out = path.join(fiDir, 'result.json');
  rmSync(out, { force: true });
  const st = await runVitest(['run', '--reporter=json', `--outputFile=${out}`, '--includeTaskLocation', '--passWithNoTests', ...(files ?? [])]);
  if (st === 'timeout') return { failing: [], timeout: true };
  if (!existsSync(out)) return { failing: [...allKeys], crashed: true, loadFailure: true };
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const failing = [];
  let loadFailure = false;
  for (const tr of j.testResults) {
    const file = path.relative(work, tr.name);
    const res = tr.assertionResults ?? [];
    if (tr.status === 'failed' && res.every((a) => a.status !== 'failed')) {
      loadFailure = true; // file-level failure (syntax / import / collect error)
      for (const t of baseTests) if (t.file === file) failing.push(key(t));
    }
    for (const a of res) {
      if (a.status !== 'failed') continue;
      const name = [...a.ancestorTitles, a.title].join(' > ');
      const line = a.location?.line;
      const exact = key({ file, name, line });
      if (line != null && allKeys.has(exact)) failing.push(exact);
      else failing.push(...(byFileName.get(`${file}\u0000${name}`) ?? [exact]));
    }
  }
  return { failing: [...new Set(failing)], loadFailure };
}
function changedFiles() {
  const r = spawnSync(vitestBin, ['list', '--changed', 'HEAD', '--filesOnly', '--json'], { cwd: work, encoding: 'utf8', env: ENV, maxBuffer: 64 << 20 });
  const txt = r.stdout.slice(r.stdout.indexOf('['));
  try { return [...new Set(JSON.parse(txt).map((x) => path.relative(work, x.file)))]; } catch { return null; }
}
const sanity = await runSuite();
if (sanity.failing.length) { console.error('suite fails at the base:', sanity.failing.slice(0, 10)); process.exit(2); }

// ---------- syntax check of mutants (oxc-parser from the project's node_modules, optional) ----------
let parseSync = null;
try { ({ parseSync } = createRequire(path.join(work, 'package.json'))('oxc-parser')); } catch { console.error('oxc-parser not found – syntax-invalid mutants are not separated'); }
const syntaxOk = (file, code) => {
  if (file.endsWith('.json')) { try { JSON.parse(code); return true; } catch { return false; } }
  if (!parseSync) return true;
  const lang = /\.[cm]?tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : /\.[cm]?jsx$/.test(file) ? 'jsx' : 'js';
  const r = parseSync(file, code, { lang, sourceType: 'module' });
  return !r.errors?.some((e) => e.severity === 'Error' || !e.severity);
};

// ---------- mutation operators (single line) ----------
const OPS = [
  ['number+1', /(?<![\w.$#])(\d+(?:\.\d+)?)(?![\w.])/g, (m) => String(Number(m) + 1)],
  ['<=→<', /<=/g, () => '<'],
  ['>=→>', />=/g, () => '>'],
  ['<→<=', /(?<![<=])<(?![=<\/a-zA-Z])/g, () => '<='],
  ['>→>=', /(?<![=>-])>(?![=>])/g, () => '>='],
  ['===→!==', /===/g, () => '!=='],
  ['!==→===', /!==/g, () => '==='],
  ['&&→||', /&&/g, () => '||'],
  ['||→&&', /\|\|/g, () => '&&'],
  ['??→||', /\?\?/g, () => '||'],
  ['+→-', / \+ /g, () => ' - '],
  ['-→+', / - /g, () => ' + '],
  ['*→/', / \* /g, () => ' / '],
  ['string', /'([^'\\\n]*)'/g, (m) => `'${m.slice(1, -1)}_x'`],
  ['true↔false', /\b(true|false)\b/g, (m) => (m === 'true' ? 'false' : 'true')],
  ['++→--', /\+\+/g, () => '--'],
  ['delete line', /^(?!\s*[{}]?\s*$)(?!.*[{}]).*;\s*$/g, () => ''],
];
const JSON_OPS = [
  ['number+1', /(?<![\w.#"-])(-?\d+(?:\.\d+)?)(?![\w.]|")/g, (m) => String(Number(m) + 1)],
  ['true↔false', /\b(true|false)\b/g, (m) => (m === 'true' ? 'false' : 'true')],
  ['json string value', /(?<=[:\[,]\s*)"([^"\\\n]*)"(?!\s*:)/g, (m) => `"${m.slice(1, -1)}_x"`],
];
function walk(d) {
  const out = [];
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(?:[cm]?[jt]sx?|json|css)$/.test(e) && !/\.(test|spec)\./.test(e) && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const srcFiles = walk(path.join(work, opt.src));
const vtoArgs = (extra) => ['affected', rawDir, '--git', 'HEAD', '--root', work, '--json', '--quiet',
  ...(opt.innermost ? ['--innermost'] : []), ...(opt.importers ? ['--importers'] : []), ...extra];

const results = [];
let attempts = 0;
while (results.length < opt.n && attempts < opt.n * 100) {
  attempts++;
  const file = pick(srcFiles);
  const rel = path.relative(work, file);
  const orig = readFileSync(file, 'utf8');
  const lines = orig.split('\n');
  const li = Math.floor(rnd() * lines.length);
  const line = lines[li];
  if (!line.trim() || /^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\b/.test(line)) continue;
  const [opName, re, fn] = pick(rel.endsWith('.json') ? JSON_OPS : OPS);
  const matches = [...line.matchAll(re)];
  if (!matches.length) continue;
  const m = pick(matches);
  const mutated = line.slice(0, m.index) + fn(m[0]) + line.slice(m.index + m[0].length);
  if (mutated === line) continue;
  lines[li] = mutated;
  const code = lines.join('\n');
  const valid = syntaxOk(rel, code);
  writeFileSync(file, code);
  try {
    const aff = spawnSync(opt.vto, vtoArgs([]), { cwd: work, encoding: 'utf8' });
    if (aff.status !== 0 && aff.status !== 3) { console.error(aff.stderr); process.exit(2); }
    const a = JSON.parse(aff.stdout);
    const affT = JSON.parse(spawnSync(opt.vto, vtoArgs(['--test-granularity']), { cwd: work, encoding: 'utf8' }).stdout || '{"runAll":true,"tests":[]}');
    const selOf = (x) => (x.runAll ? allKeys : new Set(x.tests.map((t) => key({ file: t.file, name: t.name, line: t.line }))));
    const selected = selOf(a);
    const selectedT = selOf(affT);
    const full = results.length % opt['full-every'] === opt['full-every'] - 1;
    // complement oracle
    const graph = a.runAll && !full ? null : changedFiles();
    const oracleAll = graph ? [...new Set([...graph, ...FS_READERS])] : null;
    const selByFile = new Map();
    for (const k of selected) { const f = k.split('\u0000')[0]; selByFile.set(f, (selByFile.get(f) || 0) + 1); }
    const oracleFiles = oracleAll ? oracleAll.filter((f) => (selByFile.get(f) || 0) < (totByFile.get(f) || 0)) : null;
    const r = a.runAll && !full ? { failing: [], skipped: true }
      : !full && oracleFiles && !oracleFiles.length ? { failing: [], skipped: true }
      : await runSuite(full || !oracleFiles ? undefined : oracleFiles);
    let missed = r.failing.filter((k) => !selected.has(k));
    let flaky = [];
    if (missed.length && !r.timeout) {
      // confirm: must fail in 2 more runs with the mutant and pass on the unmutated base
      const mf = [...new Set(missed.map((k) => k.split('\u0000')[0]))];
      const again1 = await runSuite(mf), again2 = await runSuite(mf);
      writeFileSync(file, orig);
      const base = await runSuite(mf);
      writeFileSync(file, code);
      const confirmed = missed.filter((k) => again1.failing.includes(k) && again2.failing.includes(k) && !base.failing.includes(k));
      flaky = missed.filter((k) => !confirmed.includes(k));
      missed = confirmed;
    }
    const missedT = full ? r.failing.filter((k) => !selectedT.has(k)) : null; // only meaningful on full runs
    results.push({ file: rel, line: li + 1, op: opName, before: line.trim(), after: mutated.trim(), runAll: a.runAll, reasons: a.reasons,
      selected: selected.size, selectedTest: selectedT.size, failing: r.failing.length, oracle: full ? 'full' : a.runAll ? 'none(runAll)' : 'complement',
      oracleFiles: oracleFiles?.length ?? null, missed: missed.map((k) => k.replaceAll('\u0000', ' > ')), flaky: flaky.map((k) => k.replaceAll('\u0000', ' > ')),
      missedTestGranularity: missedT?.length ?? null, crashed: !!r.crashed, loadFailure: !!r.loadFailure, syntaxInvalid: !valid, timeout: !!r.timeout,
      detected: r.failing.length === 0 || r.failing.some((k) => selected.has(k)) });
    const x = results.at(-1);
    console.error(`${String(results.length).padStart(3)} ${x.timeout ? 'HANG' : x.missed.length ? (x.syntaxInvalid ? 'SYNX' : 'MISS') : 'ok  '} ${rel}:${li + 1} [${opName}] failing ${x.failing}, selected ${a.runAll ? 'ALL' : x.selected}/${allKeys.size} (test-granularity ${affT.runAll ? 'ALL' : x.selectedTest}) [${x.oracle}${oracleFiles ? ` ${oracleFiles.length} files` : ''}]${x.missed.length ? ' missed: ' + x.missed.slice(0, 5).join(', ') : ''}${flaky.length ? ' flaky(not a miss): ' + x.flaky.slice(0, 3).join(', ') : ''}`);
  } finally { writeFileSync(file, orig); }
}

// Syntax-invalid mutants break every importer at collection time – a parse error, not a semantic change;
// they are reported separately (they only have to be DETECTED). Every syntax-valid mutant – incl. ones that
// throw at import time – counts towards the 100 % recall target.
const stats = (rs) => {
  const killed = rs.filter((r) => r.failing > 0);
  const failing = killed.reduce((a, r) => a + r.failing, 0);
  const missed = killed.reduce((a, r) => a + r.missed.length, 0);
  return { mutants: rs.length, killed: killed.length, failing, missed, recall: failing ? (failing - missed) / failing : 1,
    undetected: killed.filter((r) => !r.detected).length,
    frac: rs.reduce((a, r) => a + r.selected / allKeys.size, 0) / Math.max(1, rs.length),
    fracTest: rs.reduce((a, r) => a + r.selectedTest / allKeys.size, 0) / Math.max(1, rs.length) };
};
const hangs = results.filter((r) => r.timeout);
const normal = stats(results.filter((r) => !r.syntaxInvalid && !r.timeout));
const synx = stats(results.filter((r) => r.syntaxInvalid));
const fulls = results.filter((r) => r.oracle === 'full' && !r.syntaxInvalid && !r.timeout);
const fullT = { runs: fulls.length, failing: fulls.reduce((a, r) => a + r.failing, 0), missed: fulls.reduce((a, r) => a + (r.missedTestGranularity ?? 0), 0) };
const runAll = results.filter((r) => r.runAll).length;
const flakyN = results.reduce((a, r) => a + r.flaky.length, 0);
writeFileSync(path.join(here, 'last-result.json'), JSON.stringify({ summary: { project: proj, tests: allKeys.size, runAll, hangs: hangs.length, flaky: flakyN, syntaxValid: normal, syntaxInvalid: synx, testGranularityOnFullRuns: fullT }, results }, null, 2));
const pc = (x) => (x * 100).toFixed(1) + ' %';
console.log(`\nfault injection: ${results.length} mutants (${normal.killed + synx.killed} killed, ${runAll} run-all, ${flakyN} flaky failures discarded) on ${allKeys.size} tests`);
console.log(`syntax-valid   : ${normal.mutants} mutants, ${normal.killed} killed · test recall ${pc(normal.recall)} (${normal.failing - normal.missed}/${normal.failing}) · selected: file granularity ${pc(normal.frac)}, test granularity ${pc(normal.fracTest)}`);
console.log(`syntax-invalid : ${synx.mutants} mutants (reported separately) · detected ${synx.killed - synx.undetected}/${synx.killed}`);
if (hangs.length) console.log(`hanging        : ${hangs.length} mutants (suite killed after ${SUITE_TIMEOUT / 1000} s)`);
console.log(`test granularity (full-suite runs only): ${fullT.runs} runs, missed ${fullT.missed}/${fullT.failing} failing tests`);
if (!opt.keep) rmSync(work, { recursive: true, force: true }); else console.log(`work dir kept: ${work}`);
process.exit(normal.missed > 0 || synx.undetected > 0 ? 1 : 0);
