// vm-guard CLI: check | verify | compare | calibrate | plan | run | hunt | scan | report
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVitest, signature, vitestBin, childCpuSeconds } from './runner.mjs';
import { readRunLogs, clearRunLogs, predecessors, updateDurations, heapReport, selfTime, ensureStateDir } from './logs.mjs';
import { buildGraph, planLanes, readVto } from './plan.mjs';
import { scanFile } from './scan.mjs';
import { readJson } from './index.mjs';
import { validEdges, pickKnown, privateTmp } from './safety.mjs';
import { findConfigFile, gitHead, configKey } from './verifystate.mjs';

// contracts/DECISIONS.md D3: 0 ok | 1 test failures (incl. unexplained/flaky) | 2 usage or config error |
// 4 quarantine/conflict state changed | 5 false green. (3 = "run all" belongs to selection tools.)
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NEW_QUARANTINE: 4, FALSE_GREEN: 5 };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) o[a.slice(5)] = false;
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) o[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[k] = argv[++i]; else o[k] = true; }
    else o._.push(a);
  }
  return o;
}

export function ctx(o) {
  const root = path.resolve(o.root || process.cwd());
  const dir = path.join(root, '.vm-guard');
  const config = o.config ? path.resolve(o.config) : findConfigFile(root) || undefined;
  // A4: committed state = .vm-guard/{incompatible,conflicts}.json only; everything volatile lives in .vm-guard/run/
  // (git-ignored), run logs in .vm-guard/run/logs/. --commit-state keeps durations/pollution next to the
  // committed files for teams that want stable plans across machines.
  const stateDir = path.join(dir, 'run');
  return { root, dir, stateDir, runDir: path.join(stateDir, 'logs'), commitState: !!o['commit-state'], config, mode: o.mode || (readJson(path.join(stateDir, 'auto.json'), {}).auto ? 'auto' : 'vm'), verbose: !!o.verbose, lanes: Number(o.lanes || Math.max(1, os.availableParallelism() - 1)), filters: o._[0] === 'hunt' ? [] : o._.slice(1) };
}
const COMMITTED = new Set(['incompatible.json', 'conflicts.json']);
const OPT_IN = new Set(['durations.json', 'pollution.json']); // others (auto.json, modes.json, env.json, …) live in run/
export const statePath = (c, n) => P(c, n);
const P = (c, n) => (COMMITTED.has(n) || (c.commitState && OPT_IN.has(n)) ? path.join(c.dir, n) : path.join(c.stateDir, n));
// reads fall back to the pre-A4 location (.vm-guard/<name>) only for the two history files that older versions
// kept there (N9: a committed file must not be able to stand in for run state such as modes.json)
const load = (c, n, d) => { const v = readJson(P(c, n), undefined); return v !== undefined ? v : OPT_IN.has(n) ? readJson(path.join(c.dir, n), d) : d; };
export const saveState = (c, n, v) => save(c, n, v);
const save = (c, n, v) => {
  const file = P(c, n), txt = JSON.stringify(v, null, 2) + '\n';
  if (file.startsWith(c.stateDir)) ensureStateDir(c.stateDir); else fs.mkdirSync(c.dir, { recursive: true });
  try { if (fs.readFileSync(file, 'utf8') === txt) return; } catch {} // unchanged content: do not touch the file
  fs.writeFileSync(file, txt);
};
const say = (...a) => console.log('[vm-guard]', ...a);

// `vitest list` costs a full config load (~1 s CPU): cache it. Valid while the directories holding test
// files (and their ancestors up to the root) keep their mtime - adding/removing/renaming a test file
// changes it - and the config file and filters are unchanged.
const mtime = (p) => { try { return Math.floor(fs.statSync(p).mtimeMs); } catch { return -1; } };
function dirsOf(root, files) {
  const dirs = new Set([root]);
  for (const f of files) { let d = path.dirname(path.join(root, f)); while (d.startsWith(root) && !dirs.has(d)) { dirs.add(d); d = path.dirname(d); } }
  return [...dirs];
}
/** [{ file, project }] from `vitest list` (authoritative: only what Vitest itself would run). */
export function listSpecs(c) {
  const cacheFile = P(c, 'files-cache.json');
  const cached = readJson(cacheFile, null);
  const cfg = c.config ? mtime(c.config) : 0;
  if (cached && cached.v === 3 && cached.wrapped === true && cached.cfg === cfg && JSON.stringify(cached.filters) === JSON.stringify(c.filters) && Object.entries(cached.dirs).every(([d, m]) => mtime(d) === m)) { c.wrapped = cached.wrapped; return cached.specs; }
  const specs = listSpecsUncached(c);
  const files = [...new Set(specs.map((x) => x.file))];
  if (c.wrapped) try { ensureStateDir(c.stateDir); fs.writeFileSync(cacheFile, JSON.stringify({ v: 3, wrapped: c.wrapped, cfg, filters: c.filters, dirs: Object.fromEntries(dirsOf(c.root, files).map((d) => [d, mtime(d)])), specs })); } catch {}
  return specs;
}
export function listFiles(c) {
  return [...new Set(listSpecs(c).map((x) => x.file))].sort();
}
function listSpecsUncached(c) {
  const tmp = privateTmp();
  const marker = tmp.file('wrapped');
  const r = spawnSync(process.execPath, [vitestBin(c.root), 'list', '--filesOnly', '--json', ...(c.config ? ['--config', c.config] : []), ...c.filters], { cwd: c.root, env: { ...process.env, VM_GUARD_MODE: 'isolated', VM_GUARD_CLI: '1', VM_GUARD_WRAP_MARKER: marker }, encoding: 'utf8', maxBuffer: 64 << 20 });
  c.wrapped = fs.existsSync(marker); // U-2: defineVmGuardConfig leaves a line there when the config goes through it
  tmp.cleanup();
  // the JSON array starts on its own line; anything printed before it (config logs like '[vm-guard] …') is skipped
  const m = /^\[\s*$|^\[\]|^\[\{/m.exec(r.stdout);
  const txt = m ? r.stdout.slice(m.index) : '';
  // project names lose the ':isolated' suffix of quarantine siblings: lanes target the original project
  try { return JSON.parse(txt).map((x) => ({ file: path.relative(c.root, x.file).split(path.sep).join('/'), project: (x.projectName || '').replace(/:isolated$/, '') })).sort((a, b) => a.file.localeCompare(b.file) || a.project.localeCompare(b.project)); } catch { throw new Error('cannot list test files:\n' + r.stdout + r.stderr); }
}
const projectOf = (c, file) => listSpecs(c).find((x) => x.file === file)?.project ?? '';

// pollution.json: { residual: {file: kinds}  – survived the reset hooks: drives conflict edges,
//                   mitigated: {file: kinds} – undone by the reset hooks: only used to order polluters last }
function aggregatePollution(c, workers) {
  const pol = load(c, 'pollution.json', {});
  pol.residual ||= {}; pol.mitigated ||= {};
  const add = (bucket, file, kinds) => { if (kinds.length) pol[bucket][file] = [...new Set([...(pol[bucket][file] || []), ...kinds])]; };
  const keysOf = (dirty) => new Set((dirty || []).flatMap((d) => (d.kind === 'singleton' ? d.keys.map((k) => 'singleton:' + k) : [d.kind])));
  for (const w of workers) {
    let before = new Set();
    for (const f of w.files) {
      // a dirty start is blamed on the previous file only when it is NEW dirt (persisting dirt, e.g. an
      // initialised singleton, would otherwise blame every later file)
      const now = keysOf(f.dirty);
      if (f.prev) add('residual', f.prev, [...now].filter((k) => !before.has(k)));
      add('residual', f.file, (f.residual || []).filter((k) => !now.has(k)));
      add('mitigated', f.file, (f.pollution || []).filter((k) => !now.has(k) && !(f.residual || []).includes(k)));
      before = now;
    }
  }
  save(c, 'pollution.json', pol);
  return pol;
}

// ---------------- plan / run (shared mode) ----------------
export async function cmdPlan(c, o, files = listFiles(c)) {
  // F9: committed .vm-guard/*.json only refer to files Vitest itself lists; anything else is dropped
  const q = load(c, 'incompatible.json', {});
  const history = validEdges(load(c, 'conflicts.json', { edges: [] }).edges, files);
  const pollution = load(c, 'pollution.json', {});
  const residual = pickKnown(pollution.residual, files);
  const mitigated = pickKnown(pollution.mitigated, files);
  let durations = pickKnown(load(c, 'durations.json', {}), files);
  let vto = { modules: {}, durations: {} };
  if (o['vto-raw']) { vto = readVto(path.resolve(o['vto-raw']), c.root); durations = { ...pickKnown(vto.durations, files), ...durations }; }
  const mockEdges = o['reset-modules'] === false || (o['reset-modules'] !== true && load(c, 'settings.json', {}).resetModules === false);
  const isolatedQ = Object.keys(pickKnown(q.shared, files));
  // one plan per project: a lane is one Vitest process restricted to one project (its own environment/pool)
  const specs = listSpecs(c).filter((x) => files.includes(x.file));
  const byProject = new Map();
  for (const x of specs.length ? specs : files.map((file) => ({ file, project: '' }))) { const a = byProject.get(x.project) || []; if (!a.includes(x.file)) a.push(x.file); byProject.set(x.project, a); }
  const lanes = [], isolated = new Set(), edges = [], polluters = new Set();
  for (const [project, pf] of byProject) {
    const g = buildGraph({ root: c.root, files: pf, history, pollution: residual, orderOnly: Object.keys(mitigated), vto, mockEdges });
    const plan = planLanes(g, { lanes: c.lanes, durations, isolated: isolatedQ.filter((f) => pf.includes(f)) });
    for (const l of plan.lanes) lanes.push({ project, ...l });
    plan.isolated.forEach((f) => isolated.add(f));
    edges.push(...g.edges.map((e) => ({ project, ...e })));
    g.polluters.forEach((f) => polluters.add(f));
  }
  const out = { version: 2, createdAt: new Date().toISOString(), lanes, isolated: [...isolated].sort(), edges, polluters: [...polluters].sort() };
  save(c, 'plan.json', out);
  say(`plan: ${lanes.length} lanes (${lanes.map((l) => `${l.project ? l.project + ': ' : ''}${l.files.length} files ~${l.estMs} ms`).join(', ')}), isolated ${out.isolated.length}, hard edges ${edges.length}`);
  return out;
}

async function runLane(c, files, tag, project = null, mode = 'shared') {
  const laneFile = path.join(c.runDir, `lane-${tag}.json`);
  ensureStateDir(c.stateDir); fs.mkdirSync(c.runDir, { recursive: true });
  fs.writeFileSync(laneFile, JSON.stringify({ project: project || null, files }));
  return runVitest({ root: c.root, config: c.config, mode, laneFile, verbose: c.verbose, tag });
}

function merge(results) {
  const files = new Map();
  let code = 0;
  for (const r of results) { for (const [k, v] of r.files) files.set(k, v); if (r.code) code = r.code; if (r.error) { code = code || 1; console.error(r.error + '\n' + r.log.slice(-3000)); } }
  return { files, code };
}

export async function cmdRunPlanned(c, o, plan) {
  plan ||= o.replan === false ? load(c, 'plan.json', null) || (await cmdPlan(c, o)) : await cmdPlan(c, o);
  if (o.clean !== false) clearRunLogs(c.runDir);
  const jobs = plan.lanes.map((l, i) => runLane(c, l.files, 'lane' + i, l.project));
  if (plan.isolated.length) jobs.push(runVitest({ root: c.root, config: c.config, mode: 'isolated', files: plan.isolated, verbose: c.verbose, tag: 'isolated' }));
  const r = merge(await Promise.all(jobs));
  const workers = readRunLogs(c.runDir);
  updateDurations(P(c, 'durations.json'), workers);
  aggregatePollution(c, workers);
  return r;
}

// ---------------- hunt ----------------
export async function hunt(c, victim, preds, mode = 'shared') {
  const project = projectOf(c, victim);
  const allowed = new Set(listSpecs(c).filter((x) => x.project === project).map((x) => x.file));
  preds = preds.filter((f) => allowed.has(f) && f !== victim); // F9: only files of the victim's project
  const failsWith = async (list) => (await runLane(c, [...list, victim], 'hunt', project, mode)).files.get(victim)?.status !== 'passed';
  if (!preds.length) return { found: false, reason: `no predecessors in the ${mode} worker` };
  if (!(await failsWith(preds))) return { found: false, reason: 'did not reproduce with the recorded predecessor order' };
  if (await failsWith([])) return { found: false, reason: `fails alone in a ${mode} worker (not order-dependent: ${mode}-incompatible)`, alone: true };
  let cand = preds, runs = 2;
  while (cand.length > 1) {
    const half = Math.ceil(cand.length / 2);
    const a = cand.slice(0, half), b = cand.slice(half);
    runs++;
    if (await failsWith(a)) { cand = a; continue; }
    runs++;
    if (await failsWith(b)) { cand = b; continue; }
    return { found: true, polluters: cand, runs, note: 'needs a combination of files' };
  }
  return { found: true, polluters: cand, runs };
}

function addConflicts(c, victim, polluters, sig) {
  const conf = load(c, 'conflicts.json', { version: 1, edges: [] });
  let added = 0;
  for (const p of polluters) if (!conf.edges.some((e) => e.a === p && e.b === victim)) { conf.edges.push({ a: p, b: victim, kind: 'history', signature: sig, seen: new Date().toISOString().slice(0, 10) }); added++; }
  if (added) save(c, 'conflicts.json', conf);
  return added;
}

// ---------------- check ----------------
const isFast = (m) => m === 'vm' || m === 'shared';

/**
 * M7: why did `file` fail in the fast mode although it passes in forks?
 *  - 'alone'  fails in the fast mode on its own, repeatedly       -> mode-incompatible: quarantine
 *  - 'order'  passes alone, fails again after the files that ran before it in the same worker (replayed in the
 *             recorded order)                                     -> deterministic, caused by `polluters`
 *  - 'flaky'  passed on a retry under the same conditions (same mode, same predecessors)
 * Only 'flaky' is flaky. A victim that merely passes when re-run WITHOUT its predecessors is not.
 */
async function explainFastFailures(c, o, candidates, { runMode, bucketOf, workers }) {
  const verdict = new Map();
  if (!candidates.length) return verdict;
  if (o.confirm === false) { for (const f of candidates) verdict.set(f, { kind: 'alone', note: 'not confirmed (--no-confirm)' }); return verdict; }
  const retries = Math.max(1, Number(o.retries ?? 2) || 2);
  const viaHunt = o.hunt !== false;
  // shared mode always bisects (as before); vm mode first separates files that fail on their own
  let open = candidates.filter((f) => bucketOf(f) !== 'shared' || !viaHunt);
  const hunted = candidates.filter((f) => !open.includes(f));
  for (let i = 0; i < retries && open.length; i++) {
    const again = await runVitest({ root: c.root, config: c.config, mode: runMode, files: open, env: { VM_GUARD_IGNORE_QUARANTINE: '1' }, verbose: c.verbose, tag: 'confirm' + i });
    const passed = open.filter((f) => again.files.get(f)?.status === 'passed');
    for (const f of passed) verdict.set(f, { kind: 'retry-pass', attempt: i + 1 });
    open = open.filter((f) => !passed.includes(f));
  }
  for (const f of open) verdict.set(f, { kind: 'alone', note: `failed in ${retries + 1} ${bucketOf(f)} runs` });
  for (const f of [...hunted, ...[...verdict].filter(([, v]) => v.kind === 'retry-pass').map(([f]) => f)]) {
    const bucket = bucketOf(f);
    if (!viaHunt) { verdict.set(f, { kind: 'flaky', note: `passed on a ${bucket} re-run (predecessors not replayed: --no-hunt)` }); continue; }
    const h = await hunt(c, f, predecessors(workers, f), bucket);
    if (h.found) verdict.set(f, { kind: 'order', polluters: h.polluters, runs: h.runs, note: h.note });
    else if (h.alone) verdict.set(f, { kind: 'alone', note: h.reason });
    else verdict.set(f, { kind: 'flaky', note: h.reason });
  }
  return verdict;
}

export async function cmdCheck(c, o) {
  const mode = c.mode;
  const auto = mode === 'auto';
  if (auto && !load(c, 'modes.json', null)?.modes && o.calibrate !== false) {
    // first check of a mode-'auto' config: measure forks/vm/shared per group before choosing modes
    say("auto: no .vm-guard/run/modes.json yet: calibrating (vm-guard calibrate, 20 files per group; --no-calibrate skips)");
    await cmdCompare(c, { ...o, sample: o['calibrate-sample'] ?? 20 });
  }
  const runMode = auto ? undefined : mode; // auto: the config's own per-group modes
  // quarantine bucket of a file: the fast mode it ran in (auto: its group's mode, from .vm-guard/run/auto.json)
  const bucketOf = (f) => (auto ? load(c, 'auto.json', {}).groups?.[projectOf(c, f)] : mode);
  clearRunLogs(c.runDir);
  const q = load(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  for (const m of auto ? ['vm', 'shared'] : [mode]) q[m] ||= {};
  let first;
  if (mode === 'shared' && o.plan !== false) first = await cmdRunPlanned(c, { ...o, clean: false }, await cmdPlan(c, o));
  else { first = await runVitest({ root: c.root, config: c.config, mode: runMode, files: c.filters, verbose: c.verbose, tag: 'check' }); const w = readRunLogs(c.runDir); updateDurations(P(c, 'durations.json'), w); if (mode === 'shared') aggregatePollution(c, w); }
  if (first.error && !first.files.size) { console.error(first.error + '\n' + first.log.slice(-4000)); return EXIT.FAIL; }
  const workers = readRunLogs(c.runDir);
  const failing = [...first.files].filter(([, v]) => v.status !== 'passed').map(([k]) => k);
  say(`${mode}${mode === 'shared' && o.plan !== false ? ' (planned)' : ''}: ${first.files.size} files, ${failing.length} failing ${failing.join(' ')}`);
  if (o.prune) for (const m of auto ? ['vm', 'shared'] : [mode]) await prune(c, q, m);
  if (!failing.length) {
    if (first.code) { say(`Vitest exited with code ${first.code} although no file failed (unhandled error?):\n` + first.log.slice(-2000)); return report(c, workers, EXIT.FAIL); }
    return report(c, workers, EXIT.OK);
  }

  const iso = await runVitest({ root: c.root, config: c.config, mode: 'isolated', files: failing, verbose: c.verbose, tag: 'isolated' });
  // only files that pass completely in forks and are not quarantined yet need an explanation (M7)
  const candidates = failing.filter((f) => iso.files.get(f)?.status === 'passed' && isFast(bucketOf(f)) && !q[bucketOf(f)]?.[f]);
  const verdict = await explainFastFailures(c, o, candidates, { runMode, bucketOf, workers });
  const genuine = [], newQ = [], conflicts = [], flaky = [], unexplained = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const f of failing) {
    const fr = first.files.get(f), ir = iso.files.get(f);
    if (!ir) { genuine.push(f); continue; }
    // per test: a test that passes isolated but not in the fast mode is a mode-specific failure
    const modeOnly = [...ir.tests].filter(([t, st]) => st === 'passed' && fr.tests.get(t) !== 'passed').map(([t]) => t);
    const fileLevel = ir.status === 'passed' && !modeOnly.length; // failed outside a test (collection, hook, setup) in the fast mode only
    const real = ir.status !== 'passed';
    if (real) genuine.push(f);
    if (!modeOnly.length && !fileLevel) continue; // fails the same way in forks
    const bucket = bucketOf(f);
    if (!isFast(bucket)) { if (!real) unexplained.push(`${f} (failed in the ${mode} run, passes on its own in forks; its group already runs isolated)`); continue; }
    if (q[bucket][f]) { if (!real) unexplained.push(`${f} (quarantined, but failed in the ${mode} run)`); continue; }
    const v = verdict.get(f) || { kind: 'alone', note: 'some tests also fail isolated' };
    const sig = signature(fr.message) + (modeOnly.length ? ` [${modeOnly.length} test(s): ${modeOnly.slice(0, 3).join(' | ')}]` : '');
    if (v.kind === 'flaky') { flaky.push(f); say(`FLAKY (failed in ${bucket}, passed in forks and on a ${bucket} re-run under the same conditions: ${v.note}): ${f}`); continue; }
    if (v.kind === 'order' && bucket === 'shared') { addConflicts(c, f, v.polluters, sig); conflicts.push(`${f} <- ${v.polluters.join(' + ')} (${v.runs} runs)`); continue; }
    q[bucket][f] = { signature: sig, tests: modeOnly.slice(0, 20), firstSeen: today, pool: bucket === 'vm' ? 'vmThreads' : 'threads isolate:false',
      ...(v.kind === 'order' ? { after: v.polluters.slice(0, 20), reason: 'order-dependent: fails only after the listed file(s) in the same worker' } : {}) };
    newQ.push(f);
    if (v.kind === 'order') say(`ORDER-DEPENDENT in ${bucket} (deterministic, not flaky): ${f} fails after ${v.polluters.join(' + ')} (state leaked through the worker realm)`);
  }
  if (newQ.length) save(c, 'incompatible.json', q);
  for (const f of genuine) say(`FAIL (also isolated): ${f}`);
  for (const f of newQ) say(`QUARANTINED (${bucketOf(f)}-only failure): ${f} :: ${q[bucketOf(f)][f].signature}`);
  for (const s of conflicts) say(`CONFLICT recorded: ${s}`);
  for (const s of unexplained) say(`UNEXPLAINED failure: ${s}`);
  if (flaky.length) say(`${flaky.length} flaky file(s): not quarantined; exit 1 (a failure that was not explained is never reported as ok)`);
  if (newQ.length || conflicts.length) say('quarantine/conflict state changed: commit .vm-guard/incompatible.json / conflicts.json and re-run (exit 4)');
  // D3: 1 (failures, incl. flaky/unexplained) wins over 4 (new quarantine); 0 only when nothing failed
  return report(c, workers, genuine.length || flaky.length || unexplained.length ? EXIT.FAIL : newQ.length || conflicts.length ? EXIT.NEW_QUARANTINE : EXIT.FAIL /* a file failed and nothing explains it */);
}

function report(c, workers, code) {
  const st = selfTime(workers);
  if (st.files) say(`layer self-time: ${st.ms} ms over ${st.files} files (${st.perFileMs} ms/file; excludes the per-file fetch of the setup module itself)`);
  const h = heapReport(workers, 5);
  if (h.leakiest.length) say('leakiest files (avg heap delta MB): ' + h.leakiest.map((x) => `${x.file} ${x.deltaMB}`).join(', '));
  const dirty = workers.flatMap((w) => w.files.filter((f) => f.dirty?.length).map((f) => `${f.prev} -> ${f.file}: ${f.dirty.map((d) => d.kind).join(', ')}`));
  if (dirty.length) say(`${dirty.length} dirty file starts, e.g.:\n  ` + dirty.slice(0, 8).join('\n  '));
  if (workers.volatile?.size) say('volatile node_modules state (ignored): ' + [...workers.volatile].join(', '));
  return code;
}

// re-run quarantined files in the fast mode; the ones that pass now leave the quarantine
async function prune(c, q, mode) {
  const files = Object.keys(pickKnown(q[mode], listFiles(c)));
  if (!files.length) return;
  const r = await runVitest({ root: c.root, config: c.config, mode, files, env: { VM_GUARD_IGNORE_QUARANTINE: '1' }, verbose: c.verbose, tag: 'prune' });
  const fixed = files.filter((f) => r.files.get(f)?.status === 'passed');
  for (const f of fixed) { delete q[mode][f]; say(`UNQUARANTINED (passes in ${mode} now): ${f}`); }
  if (fixed.length) save(c, 'incompatible.json', q);
}

// ---------------- verify ----------------
// M6: a fast mode can be GREEN where forks are red when a test relies on state left by an earlier file of the same
// worker (a matcher, a prototype extension, a singleton of an external package). Whether that happens depends on
// the file order, so the fast side is run in several orders and each is compared with isolated forks:
//   gate      what `vitest run` does (Vitest's sequencer, the configured workers, quarantine applied)
//   forward   one worker per project, sorted file order
//   reversed  one worker per project, reverse order   (forward + reversed put every pair of files in both orders)
//   shuffle   one worker per project, seeded shuffle (--seed)
//   planned   shared mode: the planner's lanes (`vm-guard run`)
const VERIFY_ORDERS = ['gate', 'forward', 'reversed', 'shuffle', 'planned'];
export async function cmdVerify(c, o) {
  const all = listFiles(c);
  const n = o.sample === 'all' || !o.sample ? all.length : Number(o.sample);
  let seed = Number(o.seed || 1);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const sample = n >= all.length ? all : [...all].sort(() => rnd() - 0.5).slice(0, n).sort();
  const complete = sample.length === all.length && !c.filters.length;
  const mode = c.mode, auto = mode === 'auto';
  const groups = auto ? load(c, 'auto.json', {}).groups || {} : null;
  const modeOf = (project) => (auto ? groups[project] : mode);
  const orders = o.orders ? String(o.orders).split(',').map((s) => s.trim()).filter(Boolean) : mode === 'vm' ? ['gate', 'reversed'] : ['gate', 'forward', 'reversed'];
  const bad = orders.filter((x) => !VERIFY_ORDERS.includes(x));
  if (bad.length || !orders.length) { console.error(`[vm-guard] verify: unknown --orders ${bad.join(',')} (known: ${VERIFY_ORDERS.join(', ')})\nsee --help`); return EXIT.USAGE; }
  if (orders.includes('planned') && mode !== 'shared') { console.error('[vm-guard] verify: --orders planned needs --mode shared\nsee --help'); return EXIT.USAGE; }

  const q = load(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  for (const m of ['vm', 'shared']) q[m] = q[m] && typeof q[m] === 'object' ? q[m] : {};
  const knownEdges = validEdges(load(c, 'conflicts.json', { edges: [] }).edges, all);
  const specs = listSpecs(c).filter((x) => sample.includes(x.file));
  const byProject = new Map();
  for (const x of specs) { const a = byProject.get(x.project) || []; if (!a.includes(x.file)) a.push(x.file); byProject.set(x.project, a); }

  clearRunLogs(c.runDir);
  const runs = [];
  for (const order of orders) {
    if (order === 'gate') { runs.push({ order, r: await runVitest({ root: c.root, config: c.config, mode, files: complete ? [] : sample, verbose: c.verbose, tag: 'verify-gate' }) }); continue; }
    if (order === 'planned') { runs.push({ order, r: await cmdRunPlanned(c, { ...o, clean: false }, await cmdPlan(c, o, sample)) }); continue; }
    const parts = [];
    let i = 0;
    for (const [project, pf] of byProject) {
      const m = modeOf(project);
      if (!isFast(m)) continue; // this group runs isolated anyway
      let files = pf.filter((f) => !q[m][f]).sort(); // quarantined files run in forks in the gate: nothing to compare
      if (order === 'reversed') files.reverse();
      if (order === 'shuffle') files = files.map((f) => [rnd(), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      if (files.length) parts.push(await runLane(c, files, `verify-${order}-${i++}`, project, m));
    }
    runs.push({ order, r: merge(parts), laneOnly: true });
  }
  const ref = await runVitest({ root: c.root, config: c.config, mode: 'isolated', files: sample, verbose: c.verbose, tag: 'verify-ref' });
  if (ref.error && !ref.files.size) { console.error('[vm-guard] verify: the isolated reference run produced no report\n' + ref.log.slice(-3000)); return EXIT.FAIL; }

  const green = new Map(), red = new Map(); // "file > test" -> orders
  const fileOf = new Map();
  const note = (map, key, order) => { const a = map.get(key) || []; a.push(order); map.set(key, a); };
  for (const { order, r, laneOnly } of runs) {
    for (const [file, rr] of ref.files) {
      const fz = r.files.get(file);
      if (!fz && laneOnly) continue; // not part of this order (quarantined / isolated group)
      for (const [t, st] of rr.tests) {
        const fs2 = fz?.tests.get(t) ?? 'missing';
        const key = `${file} > ${t}`;
        fileOf.set(key, file);
        if (st === 'failed' && fs2 === 'passed') note(green, key, order);
        if (st === 'passed' && fs2 !== 'passed') note(red, key, order);
      }
    }
  }
  const victims = new Set(knownEdges.map((e) => e.b));
  const falseGreen = [...green.keys()].sort();
  // a recorded conflict (conflicts.json) explains a false red in a single-worker order: the planner keeps the pair apart
  const knownRed = [...red].filter(([k, ord]) => !ord.includes('gate') && !ord.includes('planned') && victims.has(fileOf.get(k))).map(([k]) => k).sort();
  const falseRed = [...red.keys()].filter((k) => !knownRed.includes(k)).sort();
  const label = (map, k) => `${k}  [order: ${map.get(k).join(', ')}]`;
  say(`verify ${mode} vs isolated forks on ${sample.length}${complete ? '' : ` of ${all.length}`} files, orders ${orders.join(' + ')}: false-green ${falseGreen.length}, false-red ${falseRed.length}${knownRed.length ? `, known conflicts ${knownRed.length}` : ''}`);
  for (const t of falseGreen.slice(0, 30)) say('  FALSE GREEN (passes fast, fails isolated): ' + label(green, t));
  for (const t of falseRed.slice(0, 30)) say('  false red (fails fast, passes isolated): ' + label(red, t));

  // detect AND quarantine: a file with a false green must run in forks, where its real result shows;
  // a file that fails only in some order is one re-ordering away from a red gate
  const quarantined = [];
  if (o.quarantine !== false) {
    const today = new Date().toISOString().slice(0, 10);
    const put = (file, info) => {
      const m = modeOf(projectOf(c, file));
      if (!isFast(m) || q[m][file]) return;
      q[m][file] = { ...info, firstSeen: today, pool: m === 'vm' ? 'vmThreads' : 'threads isolate:false' };
      quarantined.push(file);
    };
    for (const file of new Set(falseGreen.map((k) => fileOf.get(k)))) {
      const tests = falseGreen.filter((k) => fileOf.get(k) === file);
      put(file, { signature: `false green: passes in ${mode} (order ${[...new Set(tests.flatMap((k) => green.get(k)))].join(', ')}) but fails in isolated forks`, tests: tests.map((k) => k.slice(file.length + 3)).slice(0, 20), falseGreen: true });
    }
    for (const file of new Set(falseRed.filter((k) => !red.get(k).includes('gate')).map((k) => fileOf.get(k)))) {
      const tests = falseRed.filter((k) => fileOf.get(k) === file);
      put(file, { signature: `order-dependent: fails in ${mode} order ${[...new Set(tests.flatMap((k) => red.get(k)))].join(', ')}, passes in isolated forks`, tests: tests.map((k) => k.slice(file.length + 3)).slice(0, 20) });
    }
    if (quarantined.length) {
      save(c, 'incompatible.json', q);
      for (const f of quarantined) say(`QUARANTINED: ${f} :: ${(q.vm[f] || q.shared[f]).signature}`);
      say('these files run in isolated forks from now on (commit .vm-guard/incompatible.json). A false-green file FAILS there: that failure is real, fix the test.');
    }
  }
  const gateRed = falseRed.filter((k) => red.get(k).includes('gate'));
  if (gateRed.length) say(`${new Set(gateRed.map((k) => fileOf.get(k))).size} file(s) fail in the gate order but pass isolated: run \`vm-guard check${mode === 'vm' ? '' : ' --mode ' + mode}\` (it tells flaky from ${mode}-incompatible and quarantines)`);
  const record = { at: new Date().toISOString(), mode, head: gitHead(c.root), configKey: configKey(c.root, c.config), orders, sample: sample.length, of: all.length, complete, falseGreen, falseRed, knownRed, quarantined };
  save(c, `verify-${mode}.json`, record);
  if (auto && Object.values(groups).includes('shared')) save(c, 'verify-shared.json', record); // what the shared-mode warning of the config reads
  if (!complete) say(`note: only ${sample.length} of ${all.length} files were compared; the shared-mode warning of \`vitest run\` stays until a full verify is clean`);
  return falseGreen.length ? EXIT.FALSE_GREEN : falseRed.length || quarantined.length ? EXIT.NEW_QUARANTINE : EXIT.OK;
}

// ---------------- compare (G2) ----------------
// The gain of each mode depends on what the project spends its time on: vm contexts save the per-file
// environment setup (jsdom) and import cost, but a pure-node project can be SLOWER in vmThreads than in forks
// (the real-world suite: dom -53.5 %, node +9.0 %). Measure per project instead of assuming.
export async function cmdCompare(c, o) {
  clearRunLogs(c.runDir);
  const specs = listSpecs(c);
  const only = o.project ? String(o.project).split(',') : null;
  const projects = [...new Set(specs.map((x) => x.project))].filter((p) => !only || only.includes(p));
  const n = o.sample === 'all' ? Infinity : Number(o.sample || 30);
  let seed = Number(o.seed || 1);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  for (const project of projects) {
    const all = specs.filter((x) => x.project === project).map((x) => x.file);
    const sample = all.length <= n ? all : [...all].sort(() => rnd() - 0.5).slice(0, n).sort();
    const args = project ? ['--project', project] : [];
    const res = {};
    for (const mode of ['isolated', 'vm', 'shared']) {
      const cpu0 = childCpuSeconds(), t0 = Date.now();
      const r = await runVitest({ root: c.root, config: c.config, mode, files: sample, args, env: { VM_GUARD_DIAG: '0' }, verbose: c.verbose, tag: `compare-${mode}` });
      const cpu1 = childCpuSeconds();
      const tests = new Map();
      for (const [file, fr] of r.files) for (const [t, st] of fr.tests) tests.set(file + ' > ' + t, st);
      res[mode] = { cpu: cpu0 !== null && cpu1 !== null ? Math.round((cpu1 - cpu0) * 10) / 10 : null, wall: Math.round((Date.now() - t0) / 100) / 10, tests, failed: [...tests.values()].filter((x) => x === 'failed').length };
    }
    const ref = res.isolated.tests;
    for (const mode of ['vm', 'shared']) {
      let fg = 0, fr = 0;
      for (const [t, st] of ref) { const m = res[mode].tests.get(t) ?? 'missing'; if (st === 'failed' && m === 'passed') fg++; if (st === 'passed' && m !== 'passed') fr++; }
      Object.assign(res[mode], { falseGreen: fg, falseRed: fr });
    }
    const metric = (m) => res[m].cpu ?? res[m].wall;
    const base = metric('isolated');
    const ok = ['vm', 'shared'].filter((m) => !res[m].falseGreen && !res[m].falseRed);
    const best = ok.sort((a, b) => metric(a) - metric(b))[0];
    let rec = 'isolated (forks)', why = 'no fast mode matched isolated results';
    if (best) {
      const gain = 1 - metric(best) / base;
      if (gain >= 0.1) { rec = best; why = `${Math.round(gain * 100)} % less ${res[best].cpu !== null ? 'CPU' : 'wall time'} than forks` + (best === 'shared' ? '; shared realms can hide failures: gate on it only after a clean `vm-guard verify --mode shared`' + (ok.includes('vm') ? ' (safer: vm)' : '') : ''); }
      else { why = `best fast mode (${best}) saves only ${Math.round(gain * 100)} %: not worth the shared-realm risk`; }
    }
    rows.push({ project: project || '(root)', files: sample.length, of: all.length, isolated: metric('isolated'), vm: metric('vm'), shared: metric('shared'), vmMismatch: res.vm.falseGreen + res.vm.falseRed, sharedMismatch: res.shared.falseGreen + res.shared.falseRed, recommend: rec, why });
  }
  const unit = childCpuSeconds() !== null ? 'CPU s' : 'wall s';
  const pct = (a, b) => (b ? `${a - b > 0 ? '+' : ''}${Math.round(((a - b) / b) * 100)} %` : '');
  if (Number.isFinite(n)) say(`note: a random sample can miss the few CPU-heavy files that decide the result (vm global access is slower in hot code); decide with --sample all`);
  say(`mode comparison per project (${unit}, sample; mismatches = tests whose result differs from isolated forks):`);
  for (const r of rows) say(`  ${r.project}: ${r.files}/${r.of} files | forks ${r.isolated} | vm ${r.vm} (${pct(r.vm, r.isolated)}${r.vmMismatch ? `, ${r.vmMismatch} mismatches` : ''}) | shared ${r.shared} (${pct(r.shared, r.isolated)}${r.sharedMismatch ? `, ${r.sharedMismatch} mismatches` : ''}) -> recommend ${r.recommend}: ${r.why}`);
  save(c, 'compare.json', { at: new Date().toISOString(), unit, rows });
  if (o.write !== false) {
    // mode 'auto' reads these per project/group (overridable with autoModes in the config)
    const modes = { ...(load(c, 'modes.json', {}).modes || {}) };
    for (const r of rows) modes[r.project === '(root)' ? 'root' : r.project] = r.recommend.startsWith('isolated') ? 'isolated' : r.recommend;
    save(c, 'modes.json', { at: new Date().toISOString(), sample: Number.isFinite(n) ? n : 'all', modes });
    say(`modes for mode 'auto' -> .vm-guard/run/modes.json: ${JSON.stringify(modes)}`);
  }
  return EXIT.OK;
}

export async function cmdHunt(c, o) {
  const victim = o._[1];
  if (!listFiles(c).includes(victim)) { say(`hunt: ${JSON.stringify(String(victim))} is not a test file of this project`); return EXIT.USAGE; }
  const workers = readRunLogs(c.runDir);
  const preds = o.before ? o.before.split(',') : predecessors(workers, victim);
  const h = await hunt(c, victim, preds, 'shared');
  if (h.found) { addConflicts(c, victim, h.polluters, 'hunt'); say(`polluter of ${victim}: ${h.polluters.join(' + ')} (${h.runs} runs) -> conflicts.json`); return EXIT.NEW_QUARANTINE; }
  say(`no polluter: ${h.reason}`);
  return EXIT.OK;
}

export async function cmdScan(c, o) {
  const files = listFiles(c);
  const q = load(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  q.shared ||= {};
  let n = 0, risky = 0;
  for (const f of files) {
    const s = scanFile(path.join(c.root, f));
    if (!s.pollutes.length) continue;
    risky++;
    say(`${f}: ${s.pollutes.join(', ')}${s.traits.topLevel.length ? ' [line ' + s.traits.topLevel.map((t) => t.line).join(',') + ']' : ''}`);
    if (o.quarantine && !q.shared[f]) { q.shared[f] = { signature: 'static: ' + s.pollutes.join(', '), firstSeen: new Date().toISOString().slice(0, 10), pool: 'threads isolate:false' }; n++; }
  }
  if (n) { save(c, 'incompatible.json', q); say(`${n} files quarantined for shared mode`); }
  say(`scan: ${risky} of ${files.length} test files have shared-mode risks`);
  return EXIT.OK;
}

// A4 migration: volatile files that older versions wrote next to the committed ones move into .vm-guard/run/
export function migrateState(c) {
  let moved = 0;
  let names = [];
  try { names = fs.readdirSync(c.dir); } catch { return; }
  for (const n of names) {
    const volatile = ['plan.json', 'files-cache.json', 'settings.json', 'compare.json'].includes(n) || /^verify-.*\.json$/.test(n) || (!c.commitState && OPT_IN.has(n));
    if (!volatile) continue;
    ensureStateDir(c.stateDir);
    const to = path.join(c.stateDir, n);
    try { if (!fs.existsSync(to)) fs.renameSync(path.join(c.dir, n), to); else fs.rmSync(path.join(c.dir, n)); moved++; } catch {}
  }
  try { for (const n of fs.readdirSync(c.stateDir)) if (/^(w-.*\.jsonl|lane-.*\.json)$/.test(n)) fs.rmSync(path.join(c.stateDir, n)); } catch {}
  if (moved) say(`moved ${moved} volatile file(s) from .vm-guard/ to .vm-guard/run/ (git-ignored); commit the removal. Only incompatible.json and conflicts.json${c.commitState ? ', durations.json and pollution.json' : ''} are meant to be committed.`);
}

const HELP = `usage: vm-guard <command> [--mode vm|shared] [--config file] [--root dir] [--verbose]
commands (all of them need a config wrapped with defineVmGuardConfig):
  check     run in the fast mode; failing files re-run in isolated forks, then explained:
            fails on its own in the fast mode / only after another file -> .vm-guard/incompatible.json (shared: conflicts.json);
            passes on a re-run under the same conditions -> FLAKY (exit 1)
            [--prune] [--retries N=2] [--no-confirm] [--no-hunt] [--no-plan] [--compare] [--commit-state]
  verify    compare per-test pass/fail of the fast mode with isolated forks, in several file orders
            [--sample N|all] [--seed s] [--orders gate,forward,reversed,shuffle,planned] [--no-quarantine]
            files with a false green are quarantined; the result is recorded for the shared-mode warning of \`vitest run\`
  compare   per project: CPU of forks vs vm vs shared on a sample + mismatches -> recommended mode
            [--sample N|all] [--project a,b] [--no-write]
  calibrate quick compare (20 files/project) that writes .vm-guard/run/modes.json for mode 'auto'  [--sample N]
  plan      conflict graph + lanes -> .vm-guard/run/plan.json   [--lanes N] [--vto-raw dir]
  run       execute the plan (one shared worker per lane, isolated bucket in forks)  [--no-heal]
  hunt      <victim> [--before a,b,c]  bisect the files that ran before it in the same shared worker
  scan      static scan for shared-mode risks  [--quarantine]
  report    summary of the last run logs
options: --version, --help
exit codes: 0 ok | 1 test failures (also flaky / unexplained) | 2 usage or config error (e.g. config not wrapped)
            4 quarantine or conflict state changed: commit it and re-run | 5 false green (verify)`;

const NEEDS_WRAP = new Set(['check', 'verify', 'compare', 'calibrate', 'plan', 'run', 'hunt']);
/** U-2: refuse to measure a config that does not go through defineVmGuardConfig (VM_GUARD_MODE would do nothing). */
export function requireWrapped(c) {
  listSpecs(c);
  if (c.wrapped) return null;
  const rel = c.config ? path.relative(c.root, c.config) || c.config : null;
  return `[vm-guard] ${rel ? `${rel} is not wrapped with defineVmGuardConfig` : `no Vitest config found in ${c.root}`}: VM_GUARD_MODE would have no effect, so every "mode" would run in your own pool ` +
    `and the result (quarantine, mode comparison, modes.json) would be wrong. Nothing was run or written.
  fix:  import { defineVmGuardConfig } from '${PKG.name}';
        export default defineVmGuardConfig(defineConfig({ /* your config */ }));
  or:   keep your config and pass a wrapped one:  vm-guard ${'<command>'} --config vitest.guard.config.ts
see --help`;
}
const PKG = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); } catch { return { name: '@kral/vm-guard', version: '0.0.0' }; } })();
const COMMANDS = new Set(['check', 'verify', 'compare', 'calibrate', 'plan', 'run', 'hunt', 'scan', 'report']);

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.version || o._[0] === 'version') { console.log(`${PKG.name} ${PKG.version}`); return EXIT.OK; }
  if (o.help || !o._[0] || o._[0] === 'help') { console.log(HELP); return EXIT.OK; }
  if (!COMMANDS.has(o._[0])) { console.error(`[vm-guard] unknown command ${JSON.stringify(String(o._[0]).slice(0, 40))}\nsee --help`); return EXIT.USAGE; }
  if (o.mode !== undefined && !['vm', 'shared', 'auto'].includes(o.mode)) { console.error(`[vm-guard] --mode must be vm, shared or auto\nsee --help`); return EXIT.USAGE; }
  if (o.config && !fs.existsSync(path.resolve(o.config))) { console.error(`[vm-guard] --config ${o.config}: no such file\nsee --help`); return EXIT.USAGE; }
  process.env.VM_GUARD_CLI = '1';
  if (o.diag === false) process.env.VM_GUARD_DIAG = '0'; // lean runs: no pollution diff / module-state scan
  if (o['reset-modules'] === false) process.env.VM_GUARD_OPTS = JSON.stringify({ ...JSON.parse(process.env.VM_GUARD_OPTS || '{}'), resetModules: false }); // planner then adds transitive vi.mock edges
  const c = ctx(o);
  try { vitestBin(c.root); } catch (e) { console.error(`[vm-guard] ${e.message}\nsee --help`); return EXIT.USAGE; }
  migrateState(c);
  if (NEEDS_WRAP.has(o._[0])) {
    let err;
    try { err = requireWrapped(c); } catch (e) { console.error(`[vm-guard] ${e.message}`); return EXIT.USAGE; }
    if (err) { console.error(err); return EXIT.USAGE; }
  }
  switch (o._[0]) {
    case 'check': {
      if (!o.mode && c.mode !== 'auto') {
        // the config writes .vm-guard/run/auto.json when it uses mode 'auto'; make sure it has been loaded once
        try { listSpecs(c); } catch {}
        if (readJson(path.join(c.stateDir, 'auto.json'), {}).auto) c.mode = 'auto';
      } const code = await cmdCheck(c, o); if (o.compare) await cmdCompare(c, o); return code; }
    case 'compare': return cmdCompare(c, o);
    case 'calibrate': return cmdCompare(c, { ...o, sample: o.sample ?? 20 });
    case 'verify': return cmdVerify(c, o);
    case 'plan': await cmdPlan(c, o); return EXIT.OK;
    case 'run': {
      // planned shared run; self-healing unless --no-heal (shared-only failures are bisected -> conflicts.json)
      c.mode = 'shared';
      if (o.heal !== false) return cmdCheck(c, o);
      const r = await cmdRunPlanned(c, o); const failed = [...r.files].filter(([, v]) => v.status !== 'passed').map(([k]) => k);
      say(`planned shared run: ${r.files.size} files, ${failed.length} failed ${failed.join(' ')}`); return failed.length ? EXIT.FAIL : EXIT.OK;
    }
    case 'hunt': return cmdHunt(c, o);
    case 'scan': return cmdScan(c, o);
    case 'report': return report(c, readRunLogs(c.runDir), EXIT.OK);
    default: return EXIT.USAGE;
  }
}
