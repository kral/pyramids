#!/usr/bin/env node
/**
 * vto verify – mutation testing that confirms or rejects redundancy candidates of report.json.
 *
 *   node verify.mjs --raw DIR --report report.json [--root DIR] [--out DIR]
 *                   [--strategy schemata|per-mutant] [--sample N] [--timeout MS] [--hang MS]
 *                   [--async-timeout MS] [--max-mutants N] [--ops a,b,…] [--only-pairs FILE]
 *
 *   --strategy schemata   (default) all mutants of a file compiled into one module, ONE Vitest run;
 *                         each test is re-run inside its worker once per mutant (test.repeats)
 *   --strategy per-mutant classic baseline for comparison: one Vitest process per mutant; with
 *                         --sample N only N random mutants are run and the total is extrapolated
 *   --timeout MS          per attempt test timeout (default: clamp(10 × slowest planned test, 1000, 5000))
 *   --hang MS             watchdog: kill + resume when no attempt finishes for MS (default 4 × timeout)
 *   --async-timeout MS    RTL asyncUtilTimeout during verification (default 400; 0 = keep project's)
 *   --ops LIST|spec       mutation operators (default all; spec = the base set without cond-const/constant/jsx-value/method)
 *   --max-mutants N       at most N mutants per candidate (evenly sampled), default unlimited
 *   --confirm             extra Vitest run re-checking verdicts that hinge on <= 2 mutants (flaky attempts are dropped)
 *   --min-mutants N       fewer than N mutants for a pair → "not refuted (k mutants)" instead of confirmed (default 10)
 *   --lang en|cs          output language (default en; also VTO_LANG=cs)
 *   --only-pairs FILE     JSON [[unitA, unitB], …] – verify only these ordered pairs (tiered pipelines)
 *   -q, --quiet           no progress on stderr
 *   --help, --version
 *
 * Writes <out>/verify.json and <out>/verify.md (English; Czech with VTO_LANG=cs).
 * Verdicts: "confirmed" needs >= --min-mutants mutants, no mutant killed only by A, bodies that do not differ
 * only in literals (signs and numbers included) and no call that A makes with arguments B never uses.
 * Everything else that mutation cannot tell apart is "not refuted". verify.md lists every confirmed pair.
 *
 * Exit code: 0 ok, 2 usage error or no report unit found in the raw data.
 */
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMutants, lineIndex, parse, pseudoSpans, OPS_SPEC, OPS_EXT } from './mutate.mjs';
import { markdown } from './report-md.mjs';
import { lang, t as tr } from './i18n.mjs';
import { staticFeatures, dataDriven, inputsDiffer } from './static-features.mjs';
import { term } from './sanitize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  // the header comment of this file is the help text (a constant; nothing untrusted is printed)
  const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const from = head.findIndex((l) => l.startsWith('/**')), to = head.findIndex((l) => l.startsWith(' */'));
  process.stdout.write(head.slice(from + 1, to).map((l) => l.replace(/^ \* ?/, '')).join('\n')
    .replace('node verify.mjs', 'vto verify overlap   (node verify/verify.mjs)') + '\n');
  process.exit(0);
}
if (args.includes('--version') || args.includes('-V')) {
  let v = 'unknown';
  try { v = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version; } catch { /* standalone copy */ }
  process.stdout.write(`vto verify ${v}\n`);
  process.exit(0);
}
const opt = { raw: null, report: null, root: process.cwd(), out: 'verify-report', strategy: 'schemata', sample: 0,
  timeout: 0, hang: 0, asyncTimeout: 400, confirm: false, minMutants: 10, maxMutants: 0, ops: null, onlyPairs: null, quiet: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--raw') opt.raw = v();
  else if (a === '--report') opt.report = v();
  else if (a === '--root') opt.root = v();
  else if (a === '--out') opt.out = v();
  else if (a === '--strategy') opt.strategy = v();
  else if (a === '--sample') opt.sample = +v();
  else if (a === '--timeout') opt.timeout = +v();
  else if (a === '--hang') opt.hang = +v();
  else if (a === '--async-timeout') opt.asyncTimeout = +v();
  else if (a === '--max-mutants') opt.maxMutants = +v();
  else if (a === '--ops') { const x = v(); opt.ops = new Set(x === 'spec' ? OPS_SPEC : x === 'ext' ? OPS_EXT : x.split(',')); }
  else if (a === '--only-pairs') opt.onlyPairs = v();
  else if (a === '--confirm') opt.confirm = true;
  else if (a === '--min-mutants') opt.minMutants = +v();
  else if (a === '--lang') v();
  else if (a === '-q' || a === '--quiet') opt.quiet = true;
  else { console.error(`vto verify: unknown option ${term(a)} (see --help)`); process.exit(2); }
}
if (!opt.raw || !opt.report) { console.error('usage: vto verify overlap --raw DIR --report report.json [--root DIR] [--out DIR]   (--help for all options)'); process.exit(2); }
const LANG = lang();
const L = tr(LANG);
const root = path.resolve(opt.root);
const outDir = path.resolve(opt.out);
const log = (...x) => { if (!opt.quiet) console.error('vto verify:', ...x); };
const T0 = performance.now();
const timing = {};
const lap = (k, t) => { timing[k] = Math.round(performance.now() - t); };

// ------------------------------------------------------------------ raw data
// Accepts a raw dir (searched recursively: shard sub-dirs; only w-*.jsonl, symlinks skipped) or a stored map
// file. Paths of format 2.1 / stored maps are relative to meta.root (or --root) → resolved to absolute.
let t = performance.now();
const blocksOf = new Map();      // abs file → blocks
const raw = new Map();           // key absTestFile::name → record
function rawFiles(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return [];
  if (st.isFile()) return [p];
  const out = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...rawFiles(q));
    else if (e.isFile() && /^w-.*\.jsonl$/.test(e.name)) out.push(q);
  }
  return out;
}
const rawList = rawFiles(path.resolve(opt.raw));
// metas first: a dir's meta gives the root for every raw file in that dir
const rootOfDir = new Map();
let anyMetaRoot = null;
const parsed = rawList.map((f) => {
  const recs = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch { /* foreign / truncated line */ }
  }
  for (const r of recs) if (r.t === 'meta') {
    const rt = r.root ?? (r.stored || r.pathBase === 'root' ? root : null);
    if (rt) { rootOfDir.set(path.dirname(f), rt); anyMetaRoot ??= rt; }
  }
  return [f, recs];
});
for (const [f, recs] of parsed) {
  const base = rootOfDir.get(path.dirname(f)) ?? anyMetaRoot ?? root;
  const abs = (p) => (p == null ? p : path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.resolve(base, p)).split(path.sep).join('/');
  for (const r of recs) {
    if (r.t === 'file') blocksOf.set(abs(r.file), r.blocks);
    else if (r.t === 'test') {
      const hits = {};
      for (const [k, v] of Object.entries(r.hits || {})) hits[abs(k)] = v;
      raw.set(`${abs(r.file)}::${r.name}`, { ...r, file: abs(r.file), hits });
    }
  }
}
const report = JSON.parse(readFileSync(opt.report, 'utf8'));
const units = new Map(); // id → { id, names, keys, atoms:Set, excluded, line, file }
let missing = 0;
for (const u of report.tests) {
  const m = /^(.*?):(\d+|\?)/.exec(u.id);
  const rel = u.file ?? (m ? m[1] : u.id);
  const absF = path.resolve(root, rel).split(path.sep).join('/');
  const keys = u.names.map((n) => `${absF}::${n}`).filter((k) => raw.has(k));
  const atoms = new Set();
  let excluded = null;
  for (const k of keys) {
    const r = raw.get(k);
    if (r.state === 'skip') excluded = L.ex.skipped;
    else if (r.state !== 'pass') excluded = L.ex.failed;
    else if (r.tainted) excluded = L.ex.tainted;
    else if (r.leaky || r.late) excluded = L.ex.leaky;
    else if (r.contaminated) excluded = L.ex.contaminated;
    for (const [file, ids] of Object.entries(r.hits || {})) for (const id of ids) atoms.add(`${file}#${id}`);
  }
  if (!keys.length) { excluded = L.ex.missing; missing++; }
  if (u.failed) excluded = L.ex.failed;
  if (u.excluded && typeof u.excluded === 'string') excluded = L.ex[u.excluded] ?? u.excluded;
  units.set(u.id, { id: u.id, names: u.names, keys, atoms, excluded, file: absF, line: u.line ?? (m ? m[2] : null) });
}
if (report.tests.length && missing === report.tests.length) {
  console.error(`vto verify: ${L.log.noUnits(report.tests.length, report.tests[0].id)}`);
  process.exit(2);
}
if (missing) log(L.log.someMissing(missing, report.tests.length));
lap('load', t);

// ------------------------------------------------------------------ candidates
const candidates = [];
// report schema: identical = [[ids]] or [{tier, tests}], subsumed = [{test, by, byCount?}] (by may be capped)
for (const g of report.identical || []) candidates.push({ type: 'identical', units: Array.isArray(g) ? g : g.tests, tier: g.tier });
for (const s of report.subsumed || []) {
  let by = s.by;
  if (s.byCount != null && s.byCount > by.length) { // capped list → recompute all strict supersets from raw hits
    const A = units.get(s.test)?.atoms;
    by = A ? [...units.values()].filter((u) => u.id !== s.test && u.atoms.size > A.size && [...A].every((x) => u.atoms.has(x))).map((u) => u.id) : by;
  }
  for (const b of by) candidates.push({ type: 'subsumed', units: [s.test, b], tier: s.tier });
}
let onlyPairs = null;
if (opt.onlyPairs) onlyPairs = new Set(JSON.parse(readFileSync(opt.onlyPairs, 'utf8')).map(([a, b]) => `${a}\u0000${b}`));

// ------------------------------------------------------------------ mutants
t = performance.now();
const neededFiles = new Set();
for (const c of candidates) for (const a of units.get(c.units[0])?.atoms ?? []) neededFiles.add(a.slice(0, a.lastIndexOf('#')));
const mutants = [];              // global list, id = index + 1
const mutantsByAtom = new Map(); // atom → [id]
const fileProblems = {};
for (const file of neededFiles) {
  const blocks = blocksOf.get(file);
  let code;
  try { code = readFileSync(file, 'utf8'); } catch { fileProblems[file] = 'cannot read file'; continue; }
  const program = parse(code, file);
  if (!program || !blocks) { fileProblems[file] = 'cannot parse'; continue; }
  const idx = lineIndex(code);
  const pseudo = pseudoSpans(program);
  const spans = blocks.map(([l1, c1, l2, c2, kind], id) => {
    const s = idx.off(l1, c1), e = idx.off(l2, c2);
    return { id, s, e, kind, pseudo: kind === 'b' && pseudo.has(`${s}:${e}`) };
  }).filter((b) => !b.pseudo);
  for (const m of generateMutants(code, file, program)) {
    if (opt.ops && !opt.ops.has(m.op)) continue;
    // innermost real block containing the whole mutated range
    let best = null;
    for (const b of spans) if (b.s <= m.start && m.end <= b.e && (!best || b.e - b.s < best.e - best.s)) best = b;
    if (!best) continue; // module top level – never attributed to a test
    const id = mutants.length + 1;
    const atom = `${file}#${best.id}`;
    mutants.push({ id, file, atom, block: best.id, ...m });
    if (!mutantsByAtom.has(atom)) mutantsByAtom.set(atom, []);
    mutantsByAtom.get(atom).push(id);
  }
}
lap('mutants', t);

function candidateMutants(c) {
  const ids = [];
  for (const a of units.get(c.units[0]).atoms) for (const id of mutantsByAtom.get(a) ?? []) ids.push(id);
  ids.sort((x, y) => x - y);
  if (opt.maxMutants && ids.length > opt.maxMutants) {
    c.sampled = true;
    const step = ids.length / opt.maxMutants;
    return Array.from({ length: opt.maxMutants }, (_, i) => ids[Math.floor(i * step)]);
  }
  return ids;
}

// ------------------------------------------------------------------ plan
const plannedByKey = new Map(); // raw key → Set(mutant ids)
const candInfo = [];
for (const c of candidates) {
  const us = c.units.map((id) => units.get(id));
  const ex = us.find((u) => !u || u.excluded);
  const pairs = [];
  if (c.type === 'subsumed') pairs.push([c.units[0], c.units[1]]);
  else for (const a of c.units) for (const b of c.units) if (a !== b) pairs.push([a, b]);
  const wanted = onlyPairs ? pairs.filter(([a, b]) => onlyPairs.has(`${a}\u0000${b}`)) : pairs;
  const info = { ...c, pairs: wanted, mutants: [], excluded: ex ? (ex.excluded ?? L.ex.missing) : null };
  candInfo.push(info);
  if (ex || !wanted.length) continue;
  info.mutants = candidateMutants(info);
  const involved = new Set(wanted.flat());
  for (const uid of involved) for (const k of units.get(uid).keys) {
    if (!plannedByKey.has(k)) plannedByKey.set(k, new Set());
    for (const id of info.mutants) plannedByKey.get(k).add(id);
  }
}
const planFiles = {};
const usedMutants = new Set();
for (const s of plannedByKey.values()) for (const id of s) usedMutants.add(id);
for (const id of usedMutants) {
  const m = mutants[id - 1];
  (planFiles[m.file] ||= []).push({ id, kind: m.kind, start: m.start, end: m.end, at: m.at, text: m.text, expr: m.expr });
}
const attemptsPlanned = [...plannedByKey.values()].reduce((s, x) => s + x.size, 0);
const maxDur = Math.max(0, ...[...plannedByKey.keys()].map((k) => raw.get(k)?.durationMs ?? 0));
const testTimeout = opt.timeout || Math.min(5000, Math.max(1000, Math.ceil(maxDur * 10)));
const hangMs = opt.hang || Math.max(8000, testTimeout * 4);
log(L.log.plan(candidates.length, mutants.length, usedMutants.size, plannedByKey.size, attemptsPlanned, testTimeout));

function unitState(uid) {
  const u = units.get(uid);
  let ran = false, baseOk = true;
  const kills = new Set(), runs = new Set(), flaky = new Set();
  for (const k of u.keys) {
    const x = results.get(k);
    if (!x) continue;
    ran = true;
    if (x.base.some((p) => !p)) baseOk = false;
    for (const m of x.flaky) flaky.add(m);
    for (const m of x.kills.keys()) if (!x.flaky.has(m)) kills.add(m);
    for (const m of x.runs.keys()) if (!x.flaky.has(m)) runs.add(m);
  }
  return { ran, kills, runs, baseOk, flaky };
}

// ------------------------------------------------------------------ execution
const results = new Map(); // key → { base: [pass…], kills: Map(m → {e,ms}), runs: Map(m → ms) }
const mkRes = (map) => (k) => { if (!map.has(k)) map.set(k, { base: [], kills: new Map(), runs: new Map(), flaky: new Set() }); return map.get(k); };
let res = mkRes(results);
const workDir = path.join(outDir, '.work');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function runVitest(plan, tag) {
  const dir = path.join(workDir, tag);
  mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify({ ...plan, outDir: dir }));
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [path.join(here, 'runner.mjs'), 'verify', planFile], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: { ...process.env, FORCE_COLOR: '0' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 1e5) stderr = stderr.slice(-5e4); });
    let lastSize = -1, lastChange = performance.now(), killedByWatchdog = false;
    const timer = setInterval(() => {
      let size = 0;
      for (const f of readdirSync(dir)) if (f.startsWith('r-')) try { size += readFileSync(path.join(dir, f)).length; } catch {}
      if (size !== lastSize) { lastSize = size; lastChange = performance.now(); }
      // armed once results flow; before that only a generous startup limit applies
      else if (performance.now() - lastChange > (size > 0 ? hangMs : Math.max(hangMs, 180000))) {
        killedByWatchdog = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 500);
    child.on('exit', (code) => {
      clearInterval(timer);
      resolve({ dir, code, ms: performance.now() - t0, killedByWatchdog, stderr });
    });
  });
}

/** parses r-*.jsonl of a run; returns the (key, mutant) that was running when the watchdog fired */
function ingest(dir) {
  const hung = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('r-')) continue;
    let open = null;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.s !== undefined) { open = r; continue; }
      open = null;
      const x = res(r.k);
      if (r.m === 0) x.base.push(!r.f);
      else {
        x.runs.set(r.m, r.ms);
        if (r.f) x.kills.set(r.m, { e: r.e, ms: r.ms, timeout: /timed out/i.test(r.e || '') });
      }
    }
    if (open) hung.push(open);
  }
  return hung;
}

const basePlan = { testTimeout, asyncUtilTimeout: opt.asyncTimeout || undefined };
const runStats = { vitestRuns: 0, watchdogKills: 0, runMs: [] };
const testFilesOf = (keys) => [...new Set(keys.map((k) => path.relative(root, k.split('::')[0])))];

t = performance.now();
if (opt.strategy === 'schemata') {
  let pending = new Map([...plannedByKey].map(([k, s]) => [k, [...s]]));
  for (let round = 0; pending.size && round < 50; round++) {
    const plan = { ...basePlan, files: planFiles, tests: Object.fromEntries(pending), testFiles: testFilesOf([...pending.keys()]) };
    const r = await runVitest(plan, `run-${round}`);
    runStats.vitestRuns++; runStats.runMs.push(Math.round(r.ms));
    const hung = ingest(r.dir);
    if (!r.killedByWatchdog) {
      if (r.code !== 0 && r.code !== 1) log(`${L.log.vitestCode(r.code)}\n${r.stderr.slice(-2000)}`);
      break;
    }
    runStats.watchdogKills++;
    for (const h of hung) if (h.m !== 0) { res(h.s).kills.set(h.m, { e: 'hang (watchdog)', ms: hangMs, timeout: true }); res(h.s).runs.set(h.m, hangMs); }
    log(L.log.watchdog(hung.map((h) => `${h.s.split('::')[1]} @ mutant ${h.m}`).join(', ')));
    const next = new Map();
    for (const [k, ms] of pending) {
      const done = results.get(k);
      const rest = ms.filter((m) => !done?.runs.has(m));
      if (rest.length) next.set(k, rest);
    }
    pending = next;
  }
  // confirmation round: re-run every DECISIVE attempt once (A killed m while B survived it). Attempts whose
  // outcome changes are flaky (timing, async) and are dropped from the comparison instead of deciding it.
  if (opt.confirm) {
    const recheck = new Map();
    const addR = (uid, m) => { for (const k of units.get(uid).keys) { if (!recheck.has(k)) recheck.set(k, new Set()); recheck.get(k).add(m); } };
    for (const c of candInfo) {
      if (c.excluded || !c.mutants.length) continue;
      for (const [a, b] of c.pairs) {
        const A = unitState(a), B = unitState(b);
        // only verdicts that hinge on ≤ 2 mutants are re-checked; more independent decisive kills are robust
        const dec = c.mutants.filter((m) => A.kills.has(m) && !B.kills.has(m) && B.runs.has(m));
        if (dec.length && dec.length <= 2) for (const m of dec) { addR(a, m); addR(b, m); }
      }
    }
    if (recheck.size) {
      const second = new Map();
      const keep = res;
      res = mkRes(second);
      const plan = { ...basePlan, files: planFiles, tests: Object.fromEntries([...recheck].map(([k, v]) => [k, [...v]])), testFiles: testFilesOf([...recheck.keys()]) };
      const r = await runVitest(plan, 'confirm');
      runStats.vitestRuns++; runStats.runMs.push(Math.round(r.ms));
      ingest(r.dir);
      res = keep;
      let flaky = 0, rechecked = 0;
      for (const [k, ms] of recheck) for (const m of ms) {
        const x = results.get(k), y = second.get(k);
        if (!y?.runs.has(m)) continue;
        rechecked++;
        if (x.kills.has(m) !== y.kills.has(m)) { x.flaky.add(m); flaky++; }
      }
      runStats.confirm = { rechecked, flaky };
      log(L.log.confirm(rechecked, flaky));
    }
  }
} else if (opt.strategy === 'per-mutant') {
  // one Vitest process per mutant, only the tests covering it, no in-worker iteration
  const byMutant = new Map();
  for (const [k, s] of plannedByKey) for (const m of s) { if (!byMutant.has(m)) byMutant.set(m, []); byMutant.get(m).push(k); }
  let ids = [...byMutant.keys()];
  if (opt.sample && opt.sample < ids.length) {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    ids = ids.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).slice(0, opt.sample).map((x) => x[1]);
  }
  // baseline once (all planned tests, no mutants)
  const b = await runVitest({ ...basePlan, files: {}, baseline: false, tests: Object.fromEntries([...plannedByKey.keys()].map((k) => [k, [0]])),
    testFiles: testFilesOf([...plannedByKey.keys()]) }, 'baseline');
  runStats.vitestRuns++; runStats.runMs.push(Math.round(b.ms));
  ingest(b.dir);
  for (const k of plannedByKey.keys()) { const x = res(k); x.base.push(x.base[0] ?? false); }
  for (const m of ids) {
    const keys = byMutant.get(m);
    const mm = mutants[m - 1];
    const r = await runVitest({ ...basePlan, baseline: false, files: { [mm.file]: planFiles[mm.file].filter((x) => x.id === m) },
      tests: Object.fromEntries(keys.map((k) => [k, [m]])), testFiles: testFilesOf(keys) }, `m-${m}`);
    runStats.vitestRuns++; runStats.runMs.push(Math.round(r.ms));
    const hung = ingest(r.dir);
    if (r.killedByWatchdog) for (const h of hung) { res(h.s).kills.set(h.m, { e: 'hang (watchdog)', timeout: true }); res(h.s).runs.set(h.m, hangMs); }
  }
  runStats.sampledMutants = ids.length;
  runStats.totalMutantsInPlan = byMutant.size;
} else { console.error(`unknown strategy ${opt.strategy}`); process.exit(2); }
lap('run', t);

// ------------------------------------------------------------------ verdicts
t = performance.now();
const mutDesc = (id) => {
  const m = mutants[id - 1];
  return { id, file: path.relative(root, m.file), line: m.line, col: m.col, op: m.op, desc: m.desc, original: m.original };
};
// verdict codes (language independent); labels via i18n
const V_OK = 'confirmed', V_DIFF = 'differs', V_NR = 'not-refuted', V_NA = 'unverifiable';
// static features of the involved test files (skeleton/data → data-driven pairs)
const statCache = new Map();
const statOf = (uid) => {
  const u = units.get(uid);
  if (!statCache.has(u.file)) { try { statCache.set(u.file, staticFeatures(u.file)); } catch { statCache.set(u.file, new Map()); } }
  return statCache.get(u.file).get(u.names[0]);
};
const pairResults = [];
const candResults = [];
for (const c of candInfo) {
  const out = { type: c.type, tier: c.tier, units: c.units, mutants: c.mutants.length, pairs: [] };
  if (c.excluded) { out.verdict = V_NA; out.reason = L.reason.excluded(c.excluded); }
  else if (!c.pairs.length) { out.verdict = 'skipped'; }
  else if (!c.mutants.length) { out.verdict = V_NA; out.reason = L.reason.noMutants; }
  for (const [a, b] of c.pairs) {
    const p = { a, b, type: c.type, mutants: c.mutants.length };
    if (c.excluded) Object.assign(p, { verdict: V_NA, reason: out.reason });
    else if (!c.mutants.length) Object.assign(p, { verdict: V_NA, reason: out.reason });
    else {
      const A = unitState(a), B = unitState(b);
      const M = new Set(c.mutants);
      const ran = [...M].filter((m) => A.runs.has(m) && B.runs.has(m));
      const Ka = new Set([...A.kills].filter((m) => M.has(m) && B.runs.has(m)));
      const Kb = new Set([...B.kills].filter((m) => M.has(m) && A.runs.has(m)));
      p.executed = ran.length;
      p.killedA = Ka.size; p.killedB = Kb.size;
      if (!A.ran || !B.ran || !ran.length) Object.assign(p, { verdict: V_NA, reason: L.reason.notRun });
      else if (!A.baseOk || !B.baseOk) Object.assign(p, { verdict: V_NA, reason: L.reason.baseFail });
      else {
        const onlyA = [...Ka].filter((m) => !Kb.has(m));
        if (onlyA.length) Object.assign(p, { verdict: V_DIFF, onlyA: onlyA.map(mutDesc) });
        else if (!Ka.size && !Kb.size) Object.assign(p, { verdict: V_NA, reason: L.reason.noKill, weak: true });
        else {
          // mutation could not tell A from B. Only CONFIRM when the evidence can see the difference at all:
          //  - same test line (it.each rows) or bodies differing only in literals / data paths → data-driven,
          //    code mutants are blind to data → "not refuted"
          //  - fewer than --min-mutants mutants, or a sampled mutant set → "not refuted (k mutants)"
          const ua = units.get(a), ub = units.get(b);
          const sameLine = ua.file === ub.file && ua.line != null && String(ua.line) === String(ub.line);
          const sa = sameLine ? null : statOf(a), sb = sameLine ? null : statOf(b);
          const dd = sameLine ? null : dataDriven(sa, sb);
          // A feeds a callee arguments that B never uses → a different input partition (C-M8)
          const idiff = sameLine || dd ? null : inputsDiffer(sa, sb);
          const k = ran.length;
          const base = { killed: Ka.size, onlyB: [...Kb].filter((m) => !Ka.has(m)).length };
          if (sameLine) Object.assign(p, base, { verdict: V_NR, reason: L.reason.parametric, label: L.notRefutedLabel(k) });
          else if (dd) Object.assign(p, base, { verdict: V_NR, reason: L.reason.dataDriven(dd), label: L.notRefutedLabel(k) });
          else if (!sa || !sb) Object.assign(p, base, { verdict: V_NR, reason: L.reason.noStatic, label: L.notRefutedLabel(k) });
          else if (idiff) Object.assign(p, base, { verdict: V_NR, reason: L.reason.inputsDiffer(idiff), label: L.notRefutedLabel(k) });
          else if (k < opt.minMutants) Object.assign(p, base, { verdict: V_NR, reason: L.reason.fewMutants(k, opt.minMutants), label: L.notRefutedLabel(k) });
          else if (c.sampled) Object.assign(p, base, { verdict: V_NR, reason: L.reason.sampled(k), label: L.notRefutedLabel(k) });
          else Object.assign(p, base, { verdict: V_OK, reason: L.reason.confirmed(k, Ka.size, Kb.size) });
        }
      }
    }
    p.label ??= L.verdict[p.verdict];
    out.pairs.push(p);
    pairResults.push(p);
  }
  if (!out.verdict) {
    const vs = out.pairs.map((p) => p.verdict);
    out.verdict = vs.every((v) => v === V_OK) ? V_OK : vs.some((v) => v === V_DIFF) ? V_DIFF
      : vs.some((v) => v === V_NR) && vs.every((v) => v === V_OK || v === V_NR) ? V_NR : V_NA;
    if (c.type === 'identical' && out.verdict === V_DIFF) {
      // partition the group by kill sets
      const cls = new Map();
      for (const u of c.units) {
        const k = [...unitState(u).kills].filter((m) => c.mutants.includes(m)).sort((x, y) => x - y).join(',');
        if (!cls.has(k)) cls.set(k, []);
        cls.get(k).push(u);
      }
      out.classes = [...cls.entries()].map(([k, us]) => ({ units: us, killed: k ? k.split(',').length : 0 }));
    }
  }
  out.label = L.verdict[out.verdict] ?? out.verdict;
  candResults.push(out);
}
lap('verdicts', t);

// ------------------------------------------------------------------ stats + output
let executed = 0, killed = 0, timeouts = 0, attemptMs = 0;
const perMutantTests = new Map();
for (const x of results.values()) {
  executed += x.runs.size;
  killed += x.kills.size;
  for (const [m, ms] of x.runs) { attemptMs += ms ?? 0; perMutantTests.set(m, (perMutantTests.get(m) ?? 0) + 1); }
  for (const k of x.kills.values()) if (k.timeout) timeouts++;
}
const tpm = [...perMutantTests.values()];
const stats = {
  strategy: opt.strategy, candidates: candidates.length, pairs: pairResults.length,
  mutantsGenerated: mutants.length, mutantsUsed: usedMutants.size, testsPlanned: plannedByKey.size,
  attemptsPlanned, attemptsExecuted: executed, attemptsKilled: killed, timeouts,
  testsPerMutant: tpm.length ? { mean: +(tpm.reduce((s, x) => s + x, 0) / tpm.length).toFixed(2), max: Math.max(...tpm) } : null,
  attemptMsSum: Math.round(attemptMs), testTimeout, asyncUtilTimeout: opt.asyncTimeout || null,
  ...runStats, timing: { ...timing, total: Math.round(performance.now() - T0) },
};
const verdictCounts = {};
for (const p of pairResults) verdictCounts[p.verdict] = (verdictCounts[p.verdict] ?? 0) + 1;
stats.verdicts = verdictCounts;
stats.verdictLabels = L.verdict;
stats.minMutants = opt.minMutants;
const json = { generatedAt: new Date().toISOString(), lang: LANG, stats, fileProblems, candidates: candResults,
  mutants: [...usedMutants].sort((a, b) => a - b).map(mutDesc) };
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify(json, null, 1));
writeFileSync(path.join(outDir, 'verify.md'), markdown(json, LANG));
log(L.log.done((stats.timing.total / 1000).toFixed(1), executed, Object.entries(verdictCounts).map(([k, n]) => `${L.verdict[k] ?? k}: ${n}`).join(', '), path.join(outDir, 'verify.md')));
