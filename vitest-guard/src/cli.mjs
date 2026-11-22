// vitest-guard CLI: check | verify | compare | calibrate | plan | run | hunt | scan | report
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVitest, signature, vitestBin, childCpuSeconds } from './runner.mjs';
import { readRunLogs, clearRunLogs, predecessors, updateDurations, heapReport, selfTime, ensureStateDir } from './logs.mjs';
import { buildGraph, planLanes, readVto } from './plan.mjs';
import { scanFile } from './scan.mjs';
import { validEdges, pickKnown, privateTmp, sanitizeText } from './safety.mjs';
import { safeDir, readStateJson, readStateFile, writeStateFile, listStateDir, removeState } from './statefs.mjs';
import { STATE_VERSIONS, VOLATILE_VERSIONS, assertStateVersion, versionProblem, stamp } from './stateformat.mjs';
import { findConfigFile, gitHead, configKey } from './verifystate.mjs';
import { summary, table, painter, colorEnabled, verdictOf } from './ui.mjs';
import { startSwan } from './swan.mjs';

// contracts/DECISIONS.md D3: 0 ok | 1 test failures (incl. unexplained/flaky) | 2 usage or config error |
// 4 quarantine/conflict state changed | 5 false green. (3 = "run all" belongs to selection tools.)
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NEW_QUARANTINE: 4, FALSE_GREEN: 5 };

// flags that never take a value (so `vitest-guard --verbose check` does not swallow the command)
const BOOLEAN_FLAGS = new Set(['verbose', 'help', 'version', 'prune', 'compare', 'commit-state', 'quarantine', 'diag', 'reset-modules', 'confirm', 'hunt', 'plan', 'heal', 'replan', 'clean', 'calibrate', 'write']);
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--no-')) o[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) o[k] = v;
      else if (!BOOLEAN_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
      else o[k] = true;
    }
    else o._.push(a);
  }
  return o;
}

export function ctx(o) {
  const root = path.resolve(o.root || process.cwd());
  const dir = path.join(root, '.vitest-guard');
  const config = o.config ? path.resolve(o.config) : findConfigFile(root) || undefined;
  // A4: committed state = .vitest-guard/{incompatible,conflicts}.json only; everything volatile lives in .vitest-guard/run/
  // (git-ignored), run logs in .vitest-guard/run/logs/. --commit-state keeps durations/pollution next to the
  // committed files for teams that want stable plans across machines.
  const stateDir = path.join(dir, 'run');
  return { root, dir, stateDir, runDir: path.join(stateDir, 'logs'), commitState: !!o['commit-state'], config, mode: o.mode || (readAuto(stateDir).auto ? 'auto' : 'vm'), verbose: !!o.verbose, lanes: Number(o.lanes || Math.max(1, os.availableParallelism() - 1)), filters: o._[0] === 'hunt' ? [] : o._.slice(1) };
}
const readAuto = (stateDir) => { try { return readStateJson(path.join(stateDir, 'auto.json'), {}) || {}; } catch { return {}; } };
const COMMITTED = new Set(['incompatible.json', 'conflicts.json']);
const OPT_IN = new Set(['durations.json', 'pollution.json']); // others (auto.json, modes.json, env.json, …) live in run/
export const statePath = (c, n) => P(c, n);
const P = (c, n) => (COMMITTED.has(n) || (c.commitState && OPT_IN.has(n)) ? path.join(c.dir, n) : path.join(c.stateDir, n));
// reads fall back to the pre-A4 location (.vitest-guard/<name>) only for the two history files that older versions
// kept there (N9: a committed file must not be able to stand in for run state such as modes.json)
// B2: a committed (or --commit-state) file with a newer format version throws StateVersionError (exit 2); a newer
// volatile file in run/ is ignored (it is re-created). Reads and writes never follow a link (statefs.mjs).
const relOf = (c, f) => path.relative(c.root, f).split(path.sep).join('/');
const gate = (c, n, v, file, d) => {
  if (STATE_VERSIONS[n]) return assertStateVersion(n, v, relOf(c, file));
  return VOLATILE_VERSIONS[n] && versionProblem(n, v) ? d : v;
};
export const loadState = (c, n, d) => load(c, n, d);
const load = (c, n, d) => {
  let file = P(c, n), v = readStateJson(file, undefined);
  if (v === undefined && OPT_IN.has(n)) { file = path.join(c.dir, n); v = readStateJson(file, undefined); }
  return v === undefined ? d : gate(c, n, v, file, d);
};
export const saveState = (c, n, v) => save(c, n, v);
const save = (c, n, v) => {
  const file = P(c, n), txt = JSON.stringify(stamp(n, v), null, 2) + '\n'; // writers always write the current version
  if (file.startsWith(c.stateDir)) ensureStateDir(c.stateDir); else safeDir(c.dir);
  let old = null; try { old = readStateFile(file); } catch (e) { if (e?.code === 'E_UNSAFE_STATE') throw e; }
  if (old === txt) return; // unchanged content: do not touch the file
  if (old !== null && STATE_VERSIONS[n]) { let cur; try { cur = JSON.parse(old); } catch {} if (cur) assertStateVersion(n, cur, relOf(c, file)); } // never downgrade a newer file
  writeStateFile(file, txt);
};
/**
 * Before any command touches state: refuse a symlinked / junctioned `.vitest-guard`, `run/`, `run/logs/` or a linked
 * entry in them (security review 3 S2), and a committed state file with a newer format version (B2).
 * @returns {string|null} the message for exit 2
 */
export function checkState(c) {
  try {
    for (const d of [c.dir, c.stateDir, c.runDir]) for (const n of listStateDir(d)) {
      let st; try { st = fs.lstatSync(path.join(d, n)); } catch { continue; }
      if (st.isSymbolicLink()) return `[vitest-guard] ${relOf(c, path.join(d, n))} is a symbolic link or junction - refusing to follow it (vitest-guard state must be real files and directories; remove the link). Nothing was run or written.`;
    }
    for (const n of Object.keys(STATE_VERSIONS)) load(c, n, null);
  } catch (e) {
    if (e?.code === 'E_UNSAFE_STATE') return `${e.message}. Nothing was run or written.`;
    if (e?.code === 'E_STATE_VERSION') return `${e.message} (unknown fields are kept, a newer format is never misread or rewritten). Nothing was run or written.`;
    throw e;
  }
  return null;
}
const say = (...a) => console.log('[vitest-guard]', ...a.map((x) => (typeof x === 'string' ? sanitizeText(x) : x))); // names come from the project (H1)

// B2: no on-disk cache of `vitest list`: a stale file list (a test file added to a directory without one, a change
// in a file the config imports, quarantine/auto state) silently drops tests from every result. One listing per CLI
// process (the command's own view of the suite), recomputed when the filters change.
/** [{ file, project }] from `vitest list` (authoritative: only what Vitest itself would run). */
export function listSpecs(c) {
  const key = JSON.stringify(c.filters);
  if (c.specsMemo?.key === key) return c.specsMemo.specs;
  const specs = listSpecsUncached(c);
  c.specsMemo = { key, specs };
  return specs;
}
export function listFiles(c) {
  return [...new Set(listSpecs(c).map((x) => x.file))].sort();
}
function listSpecsUncached(c) {
  const tmp = privateTmp();
  const marker = tmp.file('wrapped');
  const r = spawnSync(process.execPath, [vitestBin(c.root), 'list', '--filesOnly', '--json', ...(c.config ? ['--config', c.config] : []), ...c.filters], { cwd: c.root, env: { ...process.env, VITEST_GUARD_MODE: 'isolated', VITEST_GUARD_CLI: '1', VITEST_GUARD_WRAP_MARKER: marker }, encoding: 'utf8', maxBuffer: 64 << 20 });
  c.wrapped = fs.existsSync(marker); // U-2: defineVitestGuardConfig leaves a line there when the config goes through it
  // S3: the mode the config itself runs in (the CLI's default --mode)
  try { const first = JSON.parse(fs.readFileSync(marker, 'utf8').split('\n')[0]); if (['vm', 'shared', 'auto', 'isolated'].includes(first.configMode)) c.configMode = first.configMode; } catch {}
  tmp.cleanup();
  // the JSON array starts on its own line; anything printed before it (config logs like '[vitest-guard] …') is skipped
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
  // F9: committed .vitest-guard/*.json only refer to files Vitest itself lists; anything else is dropped
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
  ensureStateDir(c.stateDir);
  writeStateFile(laneFile, JSON.stringify({ project: project || null, files }));
  return runVitest({ root: c.root, config: c.config, mode, laneFile, verbose: c.verbose, tag });
}

/**
 * Results of several jobs. S10: a pass never replaces a failure of the same file from another job. S7: log/error
 * are carried. `expected` (job index -> files that job was meant to run) restricts each job to its own files
 * (Vitest filters are substrings: `src/a.test.js` also runs `src/a.test.jsx`) and lists what produced no result.
 */
function merge(results, expected = null) {
  const files = new Map();
  let code = 0, log = '', error;
  results.forEach((r, i) => {
    const own = expected ? new Set(expected[i]) : null;
    for (const [k, v] of r.files) { if (own && !own.has(k)) continue; const prev = files.get(k); if (prev && prev.status !== 'passed' && v.status === 'passed') continue; files.set(k, v); }
    if (r.code) code = r.code;
    log += r.log || '';
    if (r.error) { code = code || 1; error = error ? error + '; ' + r.error : r.error; console.error(r.error + '\n' + (r.log || '').slice(-3000)); }
  });
  const missing = expected ? [...new Set(expected.flat())].filter((f) => !files.has(f)).sort() : [];
  if (missing.length) code = code || 1;
  return { files, code, log, error, missing };
}

/** B1/S1: a planned file without a result must never count as passed. */
function sayMissing(what, missing, log = '') {
  if (!missing.length) return;
  say(`NOT RUN: ${missing.length} file(s) planned for ${what} produced no result (treated as failing): ${missing.slice(0, 20).join(' ')}${missing.length > 20 ? ' ...' : ''}`);
  const hints = (log.match(/^.*\[vitest-guard\].*(ignoring|no valid test file).*$|^.*No (projects|test files) (were )?found.*$/gm) || []).slice(0, 10);
  if (hints.length) say('  ' + hints.join('\n  '));
}

export async function cmdRunPlanned(c, o, plan) {
  plan ||= o.replan === false ? load(c, 'plan.json', null) || (await cmdPlan(c, o)) : await cmdPlan(c, o);
  if (o.clean !== false) clearRunLogs(c.runDir);
  const jobs = plan.lanes.map((l, i) => runLane(c, l.files, 'lane' + i, l.project));
  const expected = plan.lanes.map((l) => l.files);
  if (plan.isolated.length) { jobs.push(runVitest({ root: c.root, config: c.config, mode: 'isolated', files: plan.isolated, verbose: c.verbose, tag: 'isolated' })); expected.push(plan.isolated); }
  const r = merge(await Promise.all(jobs), expected);
  sayMissing('the planned shared run', r.missing, r.log);
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
    const again = await runVitest({ root: c.root, config: c.config, mode: runMode, files: open, env: { VITEST_GUARD_IGNORE_QUARANTINE: '1' }, verbose: c.verbose, tag: 'confirm' + i });
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
    say("auto: no .vitest-guard/run/modes.json yet: calibrating (vitest-guard calibrate, 20 files per group; --no-calibrate skips)");
    await cmdCompare(c, { ...o, sample: o['calibrate-sample'] ?? 20 });
  }
  const runMode = mode; // auto: VITEST_GUARD_MODE=auto, also when the config itself says another mode (trial S1)
  // quarantine bucket of a file: the fast mode it ran in (auto: its group's mode, from .vitest-guard/run/auto.json)
  const bucketOf = (f) => (auto ? load(c, 'auto.json', {}).groups?.[projectOf(c, f)] : mode);
  // S8: a filter that matches no test file is a usage error, not "0 files passed"
  const expectedFiles = listFiles(c);
  if (c.filters.length && !expectedFiles.length) { console.error(`[vitest-guard] check: no test file matches ${c.filters.map((f) => JSON.stringify(String(f).slice(0, 200))).join(' ')}\nsee --help`); return EXIT.USAGE; }
  clearRunLogs(c.runDir);
  const q = load(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  for (const m of auto ? ['vm', 'shared'] : [mode]) q[m] ||= {};
  let first;
  if (mode === 'shared' && o.plan !== false) first = await cmdRunPlanned(c, { ...o, clean: false }, await cmdPlan(c, o));
  else { first = await runVitest({ root: c.root, config: c.config, mode: runMode, files: c.filters, verbose: c.verbose, tag: 'check' }); const w = readRunLogs(c.runDir); updateDurations(P(c, 'durations.json'), w); if (mode === 'shared') aggregatePollution(c, w); }
  if (first.error && !first.files.size) { console.error(first.error + '\n' + (first.log || '').slice(-4000)); return EXIT.FAIL; }
  const workers = readRunLogs(c.runDir);
  const failing = [...first.files].filter(([, v]) => v.status !== 'passed').map(([k]) => k);
  say(`${mode}${mode === 'shared' && o.plan !== false ? ' (planned)' : ''}: ${first.files.size} files, ${failing.length} failing ${failing.join(' ')}`);
  if (auto) say(`auto: resolved mode per group: ${Object.entries(load(c, 'auto.json', {}).groups || {}).map(([g, m]) => `${g || 'root'} -> ${m}`).join(', ') || '(none)'}`);
  // B1/B2: every file Vitest lists must have produced a result; a file that did not run never passed
  const notRun = expectedFiles.filter((f) => !first.files.has(f));
  if (notRun.length && !first.missing?.length) sayMissing(`the ${mode} run`, notRun, first.log);
  const notRunNote = notRun.map((f) => `${f} (listed by Vitest, but produced no result in the ${mode} run)`);
  let pruned = 0;
  if (o.prune) for (const m of auto ? ['vm', 'shared'] : [mode]) pruned += await prune(c, q, m);
  if (!failing.length) {
    if (notRun.length) return checkSummary(c, mode, { files: first.files.size, failing: notRun.length, unexplained: notRunNote }, report(c, workers, EXIT.FAIL));
    if (first.code) { say(`Vitest exited with code ${first.code} although no file failed (unhandled error?):\n` + (first.log || '').slice(-2000)); return checkSummary(c, mode, { files: first.files.size, unhandled: true }, report(c, workers, EXIT.FAIL)); }
    // S8: released quarantine entries changed incompatible.json: exit 4 (commit and re-run)
    return checkSummary(c, mode, { files: first.files.size, pruned }, report(c, workers, pruned ? EXIT.NEW_QUARANTINE : EXIT.OK));
  }

  const iso = await runVitest({ root: c.root, config: c.config, mode: 'isolated', files: failing, verbose: c.verbose, tag: 'isolated' });
  // only files that pass completely in forks and are not quarantined yet need an explanation (M7)
  const candidates = failing.filter((f) => iso.files.get(f)?.status === 'passed' && isFast(bucketOf(f)) && !q[bucketOf(f)]?.[f]);
  const verdict = await explainFastFailures(c, o, candidates, { runMode, bucketOf, workers });
  const genuine = [], newQ = [], conflicts = [], flaky = [], unexplained = [...notRunNote];
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
    const sig = signature(fr.message, { root: c.root }) + (modeOnly.length ? ` [${modeOnly.length} test(s): ${modeOnly.slice(0, 3).join(' | ')}]` : '');
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
  if (newQ.length || conflicts.length) say(`quarantine/conflict state changed: commit ${changedStateFiles({ newQ, conflicts })} and re-run (exit 4)`);
  // D3: 1 (failures, incl. flaky/unexplained) wins over 4 (new quarantine); 0 only when nothing failed
  const code = genuine.length || flaky.length || unexplained.length ? EXIT.FAIL : newQ.length || conflicts.length ? EXIT.NEW_QUARANTINE : EXIT.FAIL /* a file failed and nothing explains it */;
  return checkSummary(c, mode, { files: first.files.size, failing: failing.length + notRun.length, genuine, newQ, conflicts, flaky, unexplained, pruned }, report(c, workers, code));
}

/** Only the committed state files this run actually changed (pruning releases entries of incompatible.json). */
function changedStateFiles(d) {
  const n = (a) => (a ? a.length : 0);
  const files = [];
  if (n(d.newQ) || d.pruned) files.push('.vitest-guard/incompatible.json');
  if (n(d.conflicts)) files.push('.vitest-guard/conflicts.json');
  return files.join(' and ') || '.vitest-guard/incompatible.json and/or conflicts.json';
}
function checkSummary(c, mode, d, code) {
  const n = (a) => (a ? a.length : 0);
  const quarantined = Object.values(load(c, 'incompatible.json', {}) || {}).reduce((s, m) => s + (m && typeof m === 'object' ? Object.keys(m).length : 0), 0);
  const headline = code === EXIT.OK ? `${d.files} files passed in ${mode} mode`
    : d.unhandled ? `no file failed, but Vitest exited with an error (unhandled error?)`
    : code === EXIT.NEW_QUARANTINE && !n(d.newQ) && !n(d.conflicts) && d.pruned ? `${d.files} files passed in ${mode} mode; ${d.pruned} quarantine entr${d.pruned === 1 ? 'y' : 'ies'} released`
    : code === EXIT.NEW_QUARANTINE ? `${n(d.newQ) + n(d.conflicts)} ${mode}-only failure(s) explained and recorded`
    : `${n(d.genuine) || d.failing} of ${d.files} files fail`;
  const next = [];
  if (n(d.genuine)) next.push('fix the failing tests: they also fail in isolated forks, so the failure is real');
  if (n(d.flaky)) next.push(`${n(d.flaky)} flaky file(s): re-run; vitest-guard never reports an unexplained failure as ok`);
  if (n(d.unexplained)) next.push('unexplained failures: re-run with --verbose, or `vitest-guard hunt <file>`');
  if (code === EXIT.NEW_QUARANTINE) next.push(`commit ${changedStateFiles(d)}, then re-run`);
  if (code === EXIT.OK && mode === 'shared') next.push('shared realms can hide failures: confirm with `vitest-guard verify --mode shared`');
  summary({ title: `check · ${mode}`, verdict: verdictOf(code), label: code === EXIT.NEW_QUARANTINE ? 'QUARANTINE' : undefined, headline,
    facts: [['real failures', n(d.genuine) || undefined, 'red'], ['newly quarantined', n(d.newQ) || undefined, 'yellow'], ['conflicts', n(d.conflicts) || undefined, 'yellow'],
      ['flaky', n(d.flaky) || undefined, 'yellow'], ['unexplained', n(d.unexplained) || undefined, 'red'], ['released from quarantine', d.pruned || undefined, 'yellow'], ['quarantine size', quarantined || undefined], ['exit code', code]],
    next });
  return code;
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

// re-run quarantined files in the fast mode; the ones that pass now leave the quarantine.
// B6: passing alone in the fast mode proves nothing for a false-green entry (it passes there by definition) or for an
// order-dependent one (it passes without its predecessors): those must also pass in isolated forks, resp. after
// their recorded predecessors, before they are released. Returns the number of released entries.
async function prune(c, q, mode) {
  const all = listFiles(c);
  const files = Object.keys(pickKnown(q[mode], all));
  if (!files.length) return 0;
  const r = await runVitest({ root: c.root, config: c.config, mode, files, env: { VITEST_GUARD_IGNORE_QUARANTINE: '1' }, verbose: c.verbose, tag: 'prune' });
  let fixed = files.filter((f) => r.files.get(f)?.status === 'passed');
  const held = new Map();
  const fg = fixed.filter((f) => q[mode][f]?.falseGreen);
  if (fg.length) {
    const iso = await runVitest({ root: c.root, config: c.config, mode: 'isolated', files: fg, verbose: c.verbose, tag: 'prune-isolated' });
    for (const f of fg) if (iso.files.get(f)?.status !== 'passed') held.set(f, 'false green: still fails in isolated forks');
  }
  for (const f of fixed.filter((x) => !held.has(x) && Array.isArray(q[mode][x]?.after) && q[mode][x].after.length)) {
    const project = projectOf(c, f);
    const allowed = new Set(listSpecs(c).filter((x) => x.project === project).map((x) => x.file));
    const preds = q[mode][f].after.filter((p) => typeof p === 'string' && allowed.has(p) && p !== f);
    if (!preds.length) { held.set(f, 'order-dependent: recorded predecessors are gone; release by hand'); continue; }
    const rr = await runLane(c, [...preds, f], 'prune-after', project, mode);
    if (rr.files.get(f)?.status !== 'passed') held.set(f, `order-dependent: still fails after ${preds.join(' + ')}`);
  }
  for (const [f, why] of held) say(`kept in quarantine (passes alone in ${mode}, but ${why}): ${f}`);
  fixed = fixed.filter((f) => !held.has(f));
  for (const f of fixed) { delete q[mode][f]; say(`UNQUARANTINED (passes in ${mode} now): ${f}`); }
  if (fixed.length) save(c, 'incompatible.json', q);
  return fixed.length;
}

// ---------------- verify ----------------
// M6: a fast mode can be GREEN where forks are red when a test relies on state left by an earlier file of the same
// worker (a matcher, a prototype extension, a singleton of an external package). Whether that happens depends on
// the file order, so the fast side is run in several orders and each is compared with isolated forks:
//   gate      what `vitest run` does (Vitest's sequencer, the configured workers, quarantine applied)
//   forward   one worker per project, sorted file order
//   reversed  one worker per project, reverse order   (forward + reversed put every pair of files in both orders)
//   shuffle   one worker per project, seeded shuffle (--seed)
//   planned   shared mode: the planner's lanes (`vitest-guard run`)
const VERIFY_ORDERS = ['gate', 'forward', 'reversed', 'shuffle', 'planned'];
const badNumber = (o, k) => o[k] !== undefined && o[k] !== 'all' && !(Number.isFinite(Number(o[k])) && Number(o[k]) >= 1);
export async function cmdVerify(c, o) {
  for (const k of ['sample', 'seed']) if (badNumber(o, k) && !(k === 'seed' && Number(o.seed) === 0)) { console.error(`[vitest-guard] verify: --${k} must be a positive number${k === 'sample' ? ' or "all"' : ''}, got ${JSON.stringify(String(o[k]))}\nsee --help`); return EXIT.USAGE; }
  const all = listFiles(c);
  if (c.filters.length && !all.length) { console.error(`[vitest-guard] verify: no test file matches ${c.filters.map((f) => JSON.stringify(String(f).slice(0, 200))).join(' ')}\nsee --help`); return EXIT.USAGE; }
  const n = o.sample === 'all' || !o.sample ? all.length : Number(o.sample);
  let seed = Number(o.seed || 1);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const sample = n >= all.length ? all : [...all].sort(() => rnd() - 0.5).slice(0, n).sort();
  const complete = sample.length === all.length && !c.filters.length;
  const mode = c.mode, auto = mode === 'auto';
  const groups = auto ? load(c, 'auto.json', {}).groups || {} : null;
  const modeOf = (project) => (auto ? groups[project] : mode);
  const orders = o.orders ? String(o.orders).split(',').map((s) => s.trim()).filter(Boolean) : mode === 'vm' ? ['gate', 'reversed'] : ['gate', 'forward', 'reversed'];
  // --no-plan: never run the planner's lanes (the 'planned' order); asking for exactly that is a contradiction
  if (o.plan === false && orders.includes('planned')) {
    if (o.orders) { const rest = orders.filter((x) => x !== 'planned'); if (!rest.length) { console.error('[vitest-guard] verify: --orders planned contradicts --no-plan\nsee --help'); return EXIT.USAGE; } say('verify: --no-plan: skipping the planned order'); orders.splice(0, orders.length, ...rest); }
    else orders.splice(orders.indexOf('planned'), 1);
  }
  const bad = orders.filter((x) => !VERIFY_ORDERS.includes(x));
  if (bad.length || !orders.length) { console.error(`[vitest-guard] verify: unknown --orders ${bad.join(',')} (known: ${VERIFY_ORDERS.join(', ')})\nsee --help`); return EXIT.USAGE; }
  if (orders.includes('planned') && mode !== 'shared') { console.error('[vitest-guard] verify: --orders planned needs --mode shared\nsee --help'); return EXIT.USAGE; }

  const q = load(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  for (const m of ['vm', 'shared']) q[m] = q[m] && typeof q[m] === 'object' ? q[m] : {};
  const knownEdges = validEdges(load(c, 'conflicts.json', { edges: [] }).edges, all);
  const specs = listSpecs(c).filter((x) => sample.includes(x.file));
  const byProject = new Map();
  for (const x of specs) { const a = byProject.get(x.project) || []; if (!a.includes(x.file)) a.push(x.file); byProject.set(x.project, a); }

  clearRunLogs(c.runDir);
  const runs = [];
  const incomplete = []; // S1: orders in which a file that was put into the run produced no result
  for (const order of orders) {
    if (order === 'gate') { const r = await runVitest({ root: c.root, config: c.config, mode, files: complete ? [] : sample, verbose: c.verbose, tag: 'verify-gate' }); runs.push({ order, r, expected: sample }); continue; }
    if (order === 'planned') { const r = await cmdRunPlanned(c, { ...o, clean: false }, await cmdPlan(c, o, sample)); runs.push({ order, r, expected: sample }); continue; }
    const parts = [], expected = [];
    let i = 0;
    for (const [project, pf] of byProject) {
      const m = modeOf(project);
      if (!isFast(m)) continue; // this group runs isolated anyway
      let files = pf.filter((f) => !q[m][f]).sort(); // quarantined files run in forks in the gate: nothing to compare
      if (order === 'reversed') files.reverse();
      if (order === 'shuffle') files = files.map((f) => [rnd(), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      if (files.length) { parts.push(await runLane(c, files, `verify-${order}-${i++}`, project, m)); expected.push(files); }
    }
    runs.push({ order, r: merge(parts, expected), laneOnly: true, expected: expected.flat() });
  }
  for (const { order, r, expected } of runs) {
    const missing = expected.filter((f) => !r.files.has(f));
    if (missing.length) { incomplete.push(`${order}: ${missing.length} file(s)`); if (order !== 'planned') sayMissing(`verify order ${order}`, missing, r.log); }
  }
  const ref0 = await runVitest({ root: c.root, config: c.config, mode: 'isolated', files: sample, verbose: c.verbose, tag: 'verify-ref' });
  if (ref0.error && !ref0.files.size) { console.error('[vitest-guard] verify: the isolated reference run produced no report\n' + ref0.log.slice(-3000)); return EXIT.FAIL; }
  // S10: the filters are substrings and can run more files than the sample; compare the sample only
  const ref = { ...ref0, files: new Map([...ref0.files].filter(([f]) => sample.includes(f))) };
  const refMissing = sample.filter((f) => !ref.files.has(f));
  if (refMissing.length) { incomplete.push(`isolated reference: ${refMissing.length} file(s)`); sayMissing('the isolated reference run', refMissing, ref0.log); }

  const green = new Map(), red = new Map(); // "file > test" -> orders
  const fileOf = new Map();
  const note = (map, key, order) => { const a = map.get(key) || []; a.push(order); map.set(key, a); };
  const FILE_LEVEL = '(file: outside any test - collection, hooks, setup)';
  for (const { order, r, laneOnly } of runs) {
    for (const [file, rr] of ref.files) {
      const fz = r.files.get(file);
      if (!fz && laneOnly) continue; // not part of this order (quarantined / isolated group); a lost file is in `incomplete`
      let differs = false;
      for (const [t, st] of rr.tests) {
        const fs2 = fz?.tests.get(t) ?? 'missing';
        const key = `${file} > ${t}`;
        fileOf.set(key, file);
        if (st === 'failed' && fs2 === 'passed') { note(green, key, order); differs = true; }
        if (st === 'passed' && fs2 !== 'passed') { note(red, key, order); differs = true; }
      }
      // B4: a file can fail in forks before or outside any test (import-time error, beforeAll): compare the file status too
      if (!differs && fz && rr.status !== fz.status) {
        const key = `${file} > ${FILE_LEVEL}`;
        fileOf.set(key, file);
        note(rr.status === 'failed' ? green : red, key, order);
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
      say('these files run in isolated forks from now on (commit .vitest-guard/incompatible.json). A false-green file FAILS there: that failure is real, fix the test.');
    }
  }
  const gateRed = falseRed.filter((k) => red.get(k).includes('gate'));
  if (gateRed.length) say(`${new Set(gateRed.map((k) => fileOf.get(k))).size} file(s) fail in the gate order but pass isolated: run \`vitest-guard check${mode === 'vm' ? '' : ' --mode ' + mode}\` (it tells flaky from ${mode}-incompatible and quarantines)`);
  if (incomplete.length) say(`INCOMPLETE: not every file produced a result (${incomplete.join('; ')}): this verify proves nothing for those files (exit 1, no clean record written)`);
  // S1: an incomplete comparison is never recorded as a verify (the shared-mode warning of `vitest run` stays)
  if (!incomplete.length) {
    const record = { at: new Date().toISOString(), mode, head: gitHead(c.root), configKey: configKey(c.root, c.config), orders, sample: sample.length, of: all.length, complete, falseGreen, falseRed, knownRed, quarantined };
    save(c, `verify-${mode}.json`, record);
    if (auto && Object.values(groups).includes('shared')) save(c, 'verify-shared.json', record); // what the shared-mode warning of the config reads
  }
  if (!complete) say(`note: only ${sample.length} of ${all.length} files were compared; the shared-mode warning of \`vitest run\` stays until a full verify is clean`);
  // D3 (S8): 5 false green > 1 (incomplete comparison, a red gate, an order-dependent failure that was not quarantined)
  // > 4 (quarantine changed) > 0
  const unrecorded = falseRed.filter((k) => !red.get(k).includes('gate') && !quarantined.includes(fileOf.get(k)));
  const code = falseGreen.length ? EXIT.FALSE_GREEN : incomplete.length || gateRed.length || unrecorded.length ? EXIT.FAIL : quarantined.length ? EXIT.NEW_QUARANTINE : EXIT.OK;
  summary({ title: `verify · ${mode}`, verdict: verdictOf(code), label: code === EXIT.FALSE_GREEN ? 'FALSE GREEN' : code === EXIT.NEW_QUARANTINE ? 'QUARANTINE' : code === EXIT.FAIL ? (incomplete.length ? 'INCOMPLETE' : 'FAIL') : 'SAFE',
    headline: code === EXIT.OK ? `${mode} matches isolated forks on ${sample.length}${complete ? '' : ` of ${all.length}`} files` : code === EXIT.FALSE_GREEN ? `${falseGreen.length} test(s) pass in ${mode} but fail in isolated forks`
      : code === EXIT.FAIL && incomplete.length ? `not every file produced a result (${incomplete.join('; ')})` : code === EXIT.FAIL && gateRed.length ? `${gateRed.length} test(s) fail in the gate order but pass isolated` : `${falseRed.length} test(s) fail in ${mode} only (order-dependent)`,
    facts: [['orders', orders.join(', ')], ['files compared', complete ? `${sample.length} (all)` : `${sample.length} of ${all.length}`, complete ? undefined : 'yellow'],
      ['false green', falseGreen.length, falseGreen.length ? 'red' : 'green'], ['false red', falseRed.length, falseRed.length ? 'yellow' : 'green'],
      ['known conflicts', knownRed.length || undefined], ['quarantined now', quarantined.length || undefined, 'yellow'], ['exit code', code]],
    next: [...(falseGreen.length ? ['false-green files now run in isolated forks, where they FAIL: that failure is real, fix the test'] : []),
      ...(quarantined.length ? ['commit .vitest-guard/incompatible.json'] : []),
      ...(!complete ? ['decide with a full run: `vitest-guard verify --sample all`'] : [])] });
  return code;
}

// ---------------- compare (G2) ----------------
// The gain of each mode depends on what the project spends its time on: vm contexts save the per-file
// environment setup (jsdom) and import cost, but a pure-node project can be SLOWER in vmThreads than in forks
// (the real-world suite: dom -53.5 %, node +9.0 %). Measure per project instead of assuming.
export async function cmdCompare(c, o) {
  if (badNumber(o, 'sample')) { console.error(`[vitest-guard] compare: --sample must be a positive number or "all", got ${JSON.stringify(String(o.sample))}\nsee --help`); return EXIT.USAGE; }
  clearRunLogs(c.runDir);
  const specs = listSpecs(c);
  const only = o.project ? String(o.project).split(',') : null;
  const projects = [...new Set(specs.map((x) => x.project))].filter((p) => !only || only.includes(p));
  const n = o.sample === 'all' ? Infinity : Number(o.sample || 30);
  let seed = Number(o.seed || 1);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  const swan = c.verbose ? { update() {}, stop() {} } : startSwan('comparing modes');
  try {
  for (const project of projects) {
    const all = specs.filter((x) => x.project === project).map((x) => x.file);
    const sample = all.length <= n ? all : [...all].sort(() => rnd() - 0.5).slice(0, n).sort();
    const args = project ? ['--project', project] : [];
    const res = {};
    for (const mode of ['isolated', 'vm', 'shared']) {
      swan.update(`comparing modes · ${project || 'root'} · ${mode === 'isolated' ? 'forks' : mode} · ${sample.length} file${sample.length === 1 ? "" : "s"}`);
      const cpu0 = childCpuSeconds(), t0 = Date.now();
      const r = await runVitest({ root: c.root, config: c.config, mode, files: sample, args, env: { VITEST_GUARD_DIAG: '0' }, verbose: c.verbose, tag: `compare-${mode}` });
      const cpu1 = childCpuSeconds();
      const tests = new Map();
      // B4: the file status is compared too (a file can fail in forks outside any test); S10: the sample only
      for (const [file, fr] of r.files) { if (!sample.includes(file)) continue; for (const [t, st] of fr.tests) tests.set(file + ' > ' + t, st); tests.set(file + ' > (file)', fr.status); }
      const lost = sample.filter((f) => !r.files.has(f));
      res[mode] = { cpu: cpu0 !== null && cpu1 !== null ? Math.round((cpu1 - cpu0) * 10) / 10 : null, wall: Math.round((Date.now() - t0) / 100) / 10, tests, lost, failed: [...tests.values()].filter((x) => x === 'failed').length };
      if (lost.length) say(`compare: ${lost.length} file(s) produced no result in ${mode === 'isolated' ? 'forks' : mode}: ${lost.slice(0, 10).join(' ')}`);
    }
    const ref = res.isolated.tests;
    for (const mode of ['vm', 'shared']) {
      let fg = 0, fr = 0;
      for (const [t, st] of ref) { const m = res[mode].tests.get(t) ?? 'missing'; if (st === 'failed' && m === 'passed') fg++; if (st === 'passed' && m !== 'passed') fr++; }
      Object.assign(res[mode], { falseGreen: fg, falseRed: fr });
    }
    const metric = (m) => res[m].cpu ?? res[m].wall;
    const base = metric('isolated');
    // S9: without a complete reference nothing is proven: no fast mode is recommended
    const ok = res.isolated.lost.length ? [] : ['vm', 'shared'].filter((m) => !res[m].falseGreen && !res[m].falseRed && !res[m].lost.length);
    const best = ok.sort((a, b) => metric(a) - metric(b))[0];
    let rec = 'isolated (forks)', why = 'no fast mode matched isolated results';
    if (best) {
      const gain = 1 - metric(best) / base;
      if (gain >= 0.1) { rec = best; why = `${Math.round(gain * 100)} % less ${res[best].cpu !== null ? 'CPU' : 'wall time'} than forks` + (best === 'shared' ? '; shared realms can hide failures: gate on it only after a clean `vitest-guard verify --mode shared`' + (ok.includes('vm') ? ' (safer: vm)' : '') : ''); }
      else { why = `best fast mode (${best}) saves only ${Math.round(gain * 100)} %: not worth the shared-realm risk`; }
    }
    if (res.isolated.lost.length) why = 'the isolated reference run did not report every file';
    rows.push({ project: project || '(root)', files: sample.length, of: all.length, isolated: metric('isolated'), vm: metric('vm'), shared: metric('shared'), vmMismatch: res.vm.falseGreen + res.vm.falseRed, sharedMismatch: res.shared.falseGreen + res.shared.falseRed, falseGreen: res.vm.falseGreen + res.shared.falseGreen, recommend: rec, why });
  }
  } finally { swan.stop(); }
  const unit = childCpuSeconds() !== null ? 'CPU s' : 'wall s';
  const pct = (a, b) => (b ? `${a - b > 0 ? '+' : ''}${Math.round(((a - b) / b) * 100)} %` : '');
  if (Number.isFinite(n)) say(`note: a random sample can miss the few CPU-heavy files that decide the result (vm global access is slower in hot code); decide with --sample all`);
  say(`mode comparison per project (${unit}, sample; mismatches = tests whose result differs from isolated forks):`);
  for (const r of rows) say(`  ${r.project}: ${r.files}/${r.of} files | forks ${r.isolated} | vm ${r.vm} (${pct(r.vm, r.isolated)}${r.vmMismatch ? `, ${r.vmMismatch} mismatches` : ''}) | shared ${r.shared} (${pct(r.shared, r.isolated)}${r.sharedMismatch ? `, ${r.sharedMismatch} mismatches` : ''}) -> recommend ${r.recommend}: ${r.why}`);
  save(c, 'compare.json', { at: new Date().toISOString(), unit, rows });
  {
    const p = painter(colorEnabled());
    const cell = (v, base, mm) => `${v}${base ? ` ${(() => { const s = pct(v, base); return v < base ? p.green(s) : p.yellow(s); })()}` : ''}${mm ? p.red(` ⚠${mm}`) : ''}`;
    const tl = table(['project', 'files', `forks (${unit})`, 'vm', 'shared', 'recommend'],
      rows.map((r) => [r.project, `${r.files}/${r.of}`, String(r.isolated), cell(r.vm, r.isolated, r.vmMismatch), cell(r.shared, r.isolated, r.sharedMismatch), p.bold(r.recommend)]), ['l', 'r', 'r', 'r', 'r', 'l'], p);
    const mism = rows.some((r) => r.vmMismatch || r.sharedMismatch);
    summary({ title: 'compare', verdict: 'ok', label: 'MEASURED', headline: `${rows.length} project(s); ⚠N = N tests whose result differs from forks`, facts: [['exit code', EXIT.OK]], tableLines: tl,
      next: [...(Number.isFinite(n) ? ['a sample can miss the CPU-heavy files: decide with `--sample all`'] : []), ...(mism ? ['mismatching modes are never recommended; see `vitest-guard verify`'] : []),
        ...rows.filter((r) => r.recommend === 'shared').map((r) => `${r.project}: gate on shared only after a clean \`vitest-guard verify --mode shared\``)] });
  }
  if (o.write !== false) {
    // mode 'auto' reads these per project/group (overridable with autoModes in the config)
    const modes = { ...(load(c, 'modes.json', {}).modes || {}) };
    for (const r of rows) modes[r.project === '(root)' ? 'root' : r.project] = r.recommend.startsWith('isolated') ? 'isolated' : r.recommend;
    save(c, 'modes.json', { at: new Date().toISOString(), sample: Number.isFinite(n) ? n : 'all', modes });
    say(`modes for mode 'auto' -> .vitest-guard/run/modes.json: ${JSON.stringify(modes)}`);
  }
  // D3 (S8): a counted false green is exit 5; false reds and timings are measurements (exit 0)
  return rows.some((r) => r.falseGreen) ? EXIT.FALSE_GREEN : EXIT.OK;
}

export async function cmdHunt(c, o) {
  const victim = o._[1];
  if (!victim) { console.error('[vitest-guard] hunt: missing <victim> (a test file, e.g. vitest-guard hunt src/a.test.ts)\nsee --help'); return EXIT.USAGE; }
  if (!listFiles(c).includes(victim)) { console.error(`[vitest-guard] hunt: ${JSON.stringify(String(victim).slice(0, 200))} is not a test file of this project (use the path as printed by vitest list, relative to the root, with /)\nsee --help`); return EXIT.USAGE; }
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
  return n ? EXIT.NEW_QUARANTINE : EXIT.OK; // D3 (S8): incompatible.json changed
}

// A4 migration: volatile files that older versions wrote next to the committed ones move into .vitest-guard/run/.
// Architecture review 3 S3: nothing is ever deleted here, and a file git tracks is never moved (a teammate or CI step
// without --commit-state must not "un-commit" durations.json / pollution.json): it only gets a hint.
/** The tracked-state hint is shown once per set of affected files: a marker in the private run dir remembers it. */
function hintShown(c, tracked) {
  const key = [...tracked].sort().join(',');
  const marker = path.join(c.stateDir, 'migrate-hint.json');
  try { if (readStateJson(marker, {})?.shown === key) return true; } catch {}
  try { ensureStateDir(c.stateDir); writeStateFile(marker, JSON.stringify({ shown: key }) + '\n'); } catch {}
  return false;
}
/** Paths below `.vitest-guard/` that git tracks (root-relative, `/`); null when git is unavailable or this is no repo. */
function trackedState(c) {
  const git = findGitBinary();
  if (!git) return null;
  const r = spawnSync(git, ['-C', c.root, 'ls-files', '-z', '--', '.vitest-guard'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return new Set(r.stdout.split('\0').filter(Boolean));
}
/** git from PATH, never from the project directory (security review H4: a repo can ship its own git.exe). */
function findGitBinary() {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) { const f = path.join(dir, 'git' + ext.toLowerCase()); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  }
  return null;
}
export function migrateState(c) {
  let names = [];
  try { names = listStateDir(c.dir); } catch { return; } // a linked chain is reported by checkState
  const candidates = names.filter((n) => ['plan.json', 'files-cache.json', 'settings.json', 'compare.json'].includes(n) || /^verify-.*\.json$/.test(n) || (!c.commitState && OPT_IN.has(n)));
  const moved = [], tracked = [], kept = [];
  if (candidates.length) {
    const inGit = trackedState(c);
    for (const n of candidates) {
      if (inGit === null ? OPT_IN.has(n) : inGit.has(`.vitest-guard/${n}`)) { tracked.push(n); continue; } // no git: keep the history files
      const to = path.join(c.stateDir, n);
      try {
        ensureStateDir(c.stateDir);
        if (fs.existsSync(to)) { kept.push(n); continue; }
        fs.renameSync(path.join(c.dir, n), to); moved.push(n);
      } catch {}
    }
  }
  try { for (const n of listStateDir(c.stateDir)) if (/^(w-.*\.jsonl|lane-.*\.json)$/.test(n)) removeState(path.join(c.stateDir, n)); } catch {}
  if (moved.length) say(`moved ${moved.length} volatile file(s) from .vitest-guard/ to .vitest-guard/run/ (git-ignored): ${moved.join(', ')}. Only incompatible.json and conflicts.json${c.commitState ? ', durations.json and pollution.json' : ''} are meant to be committed.`);
  if (tracked.length && !hintShown(c, tracked)) say(`.vitest-guard/${tracked.join(', .vitest-guard/')} ${tracked.length > 1 ? 'are' : 'is'} committed but this run has no --commit-state: left untouched and not updated (updates go to .vitest-guard/run/). Pass --commit-state to keep ${tracked.length > 1 ? 'them' : 'it'} current, or \`git rm\` ${tracked.length > 1 ? 'them' : 'it'}.`);
  if (kept.length) say(`.vitest-guard/${kept.join(', .vitest-guard/')}: a newer copy exists in .vitest-guard/run/; the old one was left in place - delete it.`);
}

const EXIT_HELP = `exit codes (docs/vitest-guard/cli.md#exit-codes):
  0  ok
  1  test failures (genuine, flaky or unexplained failures; a refuted claim)
  2  usage or config error (bad arguments, config not wrapped with defineVitestGuardConfig, missing vitest)
  3  run all (not returned by vitest-guard; reserved for the selection tools of vto)
  4  new quarantine: incompatible.json and/or conflicts.json in .vitest-guard/ changed - commit the changed file(s) and re-run
  5  false green: a test passes in the fast mode and fails in isolated forks (verify)`;
const GLOBAL_OPTS = `global options:
  --mode vm|shared|auto   fast mode to run (default: the config's mode, else vm); isolated forks are the reference run
  --config <file>         Vitest config to use (default: found in --root; must be wrapped with defineVitestGuardConfig)
  --root <dir>            project root (default: current directory)
  --verbose               stream Vitest's own output instead of collecting it
  --no-diag               lean runs: no pollution diff / module-state scan (sets VITEST_GUARD_DIAG=0)
  --no-reset-modules      shared mode without vi.resetModules() between files (sets resetModules:false in VITEST_GUARD_OPTS; the planner then adds vi.mock edges)
  --commit-state          keep durations.json / pollution.json in .vitest-guard/ (committed) instead of .vitest-guard/run/
  --version, --help       print version / help and exit 0 (also: vitest-guard help <command>, vitest-guard <command> --help)`;
// name -> { usage, text, opts: [flags the command reads] }
const COMMAND_HELP = {
  check: { usage: 'vitest-guard check [filters...] [options]', opts: ['prune', 'retries', 'confirm', 'hunt', 'plan', 'compare', 'calibrate', 'calibrate-sample', 'lanes', 'vto-raw', 'sample', 'project', 'seed', 'write'],
    text: `Run the suite in the fast mode; every failing file re-runs in isolated forks and is explained:
  fails in forks too                       -> genuine failure (exit 1)
  fails alone in the fast mode             -> quarantined in .vitest-guard/incompatible.json (exit 4)
  fails only after other files (shared)    -> conflict edge in conflicts.json (exit 4); vm mode: quarantined with "after"
  passes on a re-run, same conditions      -> FLAKY, not quarantined (exit 1)
Mode 'shared' runs the planner's lanes. Mode 'auto' calibrates first when .vitest-guard/run/modes.json is missing.
options:
  [filters...]        Vitest file filters (substring of the path)
  --prune             first re-run quarantined files in the fast mode and release the ones that pass now
  --retries N         confirmation re-runs of a failing file (default 2)
  --no-confirm        skip confirmation: every fast-only failure counts as mode-incompatible
  --no-hunt           do not bisect predecessors; a pass on re-run is reported as flaky
  --no-plan           shared mode: plain Vitest run instead of the planner's lanes
  --lanes N           planner lanes (default: CPUs - 1)
  --vto-raw <dir>     use vto raw records for the planner (module graph, durations)
  --compare           run \`compare\` afterwards
  --no-calibrate      auto mode: do not calibrate when modes.json is missing
  --calibrate-sample N  files per group for that calibration (default 20)` },
  verify: { usage: 'vitest-guard verify [filters...] [options]', opts: ['sample', 'seed', 'orders', 'quarantine', 'plan', 'lanes', 'vto-raw'],
    text: `Compare per-test pass/fail of the fast mode with isolated forks, in several file orders; records the result
(.vitest-guard/run/verify-<mode>.json) for the shared-mode warning of \`vitest run\`. Files with a false green (or an
order-dependent failure) are quarantined unless --no-quarantine.
options:
  --sample N|all      files to compare (default all; N = seeded random sample, the result is then "incomplete")
  --seed S            seed of the sample and of the shuffle order (default 1)
  --orders a,b,...    gate, forward, reversed, shuffle, planned (default: vm gate,reversed; shared gate,forward,reversed;
                      'planned' needs --mode shared)
  --no-quarantine     report only, do not write incompatible.json
  --no-plan           never run the planned order (error if --orders names only planned)
exit: 5 false green wins over 1 (incomplete, red gate, unrecorded false red) over 4 (new quarantine) over 0.` },
  compare: { usage: 'vitest-guard compare [options]', opts: ['sample', 'project', 'seed', 'write'],
    text: `Per project: CPU (wall time where /proc is unavailable) of isolated forks vs vm vs shared on a sample, plus result
mismatches against forks, then a recommended mode. Writes .vitest-guard/run/compare.json and modes.json (for mode 'auto').
options:
  --sample N|all      files per project (default 30; a random sample can miss the few heavy files: use all to decide)
  --seed S            sample seed (default 1)
  --project a,b       only these projects
  --no-write          do not write modes.json` },
  calibrate: { usage: 'vitest-guard calibrate [options]', opts: ['sample', 'project', 'seed', 'write'],
    text: `Quick \`compare\` (20 files per project by default) that writes .vitest-guard/run/modes.json for mode 'auto'.
options: --sample N|all (default 20), --project a,b, --seed S, --no-write` },
  plan: { usage: 'vitest-guard plan [options]', opts: ['lanes', 'vto-raw'],
    text: `Build the conflict graph and the lanes for shared mode (one plan per project) -> .vitest-guard/run/plan.json.
options: --lanes N (default CPUs - 1), --vto-raw <dir> (vto raw records)` },
  run: { usage: 'vitest-guard run [options]', opts: ['heal', 'replan', 'clean', 'lanes', 'vto-raw', 'prune', 'retries', 'confirm', 'hunt', 'plan', 'compare', 'calibrate', 'calibrate-sample'],
    text: `Planned shared-mode run: one shared worker per lane, quarantined files in forks. Always --mode shared.
By default self-healing (same as \`check --mode shared\`): shared-only failures are bisected -> conflicts.json.
options:
  --no-heal           just run the plan and report failures (exit 1 if any), no bisecting
  --no-replan         with --no-heal: reuse .vitest-guard/run/plan.json instead of re-planning
  --lanes N, --vto-raw <dir>   as for plan; the check options (--retries, --no-hunt, ...) apply without --no-heal` },
  hunt: { usage: 'vitest-guard hunt <victim> [--before a,b,c]', opts: ['before'],
    text: `Bisect which earlier file of the same shared worker makes <victim> fail; records the edge in conflicts.json.
<victim> is a test file path relative to the root. Uses the predecessors recorded in the last run logs.
options: --before a,b,c   candidate predecessors instead of the recorded ones
exit: 4 polluter found and recorded, 0 none found, 2 not a test file.` },
  scan: { usage: 'vitest-guard scan [--quarantine]', opts: ['quarantine'],
    text: `Static scan of the test files for shared-mode risks (top-level mutation of globals, prototypes, ...). Does not run tests.
options: --quarantine   put the risky files into .vitest-guard/incompatible.json (shared)` },
  report: { usage: 'vitest-guard report', opts: [],
    text: `Summary of the last run logs (.vitest-guard/run/logs): layer self-time, leakiest files, dirty file starts, ignored volatile modules.` },
};
const HELP = `usage: vitest-guard <command> [options]   (vitest-guard <command> --help for details)
commands (all but scan and report need a config wrapped with defineVitestGuardConfig):
  check     run in the fast mode, re-run failures in isolated forks, quarantine mode-only failures
  verify    compare the fast mode with isolated forks in several file orders (false green / false red)
  compare   forks vs vm vs shared per project: CPU, mismatches, recommended mode
  calibrate quick compare that writes modes.json for mode 'auto'
  plan      conflict graph + lanes for shared mode -> .vitest-guard/run/plan.json
  run       execute the plan (shared mode), self-healing
  hunt      <victim>  bisect which earlier file pollutes it
  scan      static scan for shared-mode risks
  report    summary of the last run logs
${GLOBAL_OPTS}
${EXIT_HELP}`;
export function helpFor(cmd) {
  const h = COMMAND_HELP[cmd];
  return h ? `usage: ${h.usage}\n\n${h.text}\n\n${GLOBAL_OPTS}\n${EXIT_HELP}` : null;
}
const KNOWN_FLAGS = new Set(['mode', 'config', 'root', 'verbose', 'diag', 'reset-modules', 'commit-state', 'help', 'version']);

const NEEDS_WRAP = new Set(['check', 'verify', 'compare', 'calibrate', 'plan', 'run', 'hunt']);
/** U-2: refuse to measure a config that does not go through defineVitestGuardConfig (VITEST_GUARD_MODE would do nothing). */
export function requireWrapped(c) {
  listSpecs(c);
  if (c.wrapped) return null;
  const rel = c.config ? path.relative(c.root, c.config) || c.config : null;
  return `[vitest-guard] ${rel ? `${rel} is not wrapped with defineVitestGuardConfig` : `no Vitest config found in ${c.root}`}: VITEST_GUARD_MODE would have no effect, so every "mode" would run in your own pool ` +
    `and the result (quarantine, mode comparison, modes.json) would be wrong. Nothing was run or written.
  fix:  import { defineVitestGuardConfig } from '${PKG.name}';
        export default defineVitestGuardConfig(defineConfig({ /* your config */ }));
  or:   keep your config and pass a wrapped one:  vitest-guard ${'<command>'} --config vitest.guard.config.ts
see --help`;
}
const PKG = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); } catch { return { name: '@jirikral/vitest-guard', version: '0.0.0' }; } })();
const COMMANDS = new Set(['check', 'verify', 'compare', 'calibrate', 'plan', 'run', 'hunt', 'scan', 'report']);

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.version || o._[0] === 'version') { console.log(`${PKG.name} ${PKG.version}`); return EXIT.OK; }
  if (o._[0] === 'help' || (typeof o.help === 'string' && !o._[0])) { const t = o._[1] || (typeof o.help === 'string' ? o.help : ''); const h = helpFor(t); if (t && !h) { console.error(`[vitest-guard] unknown command ${JSON.stringify(t.slice(0, 40))}\nsee --help`); return EXIT.USAGE; } console.log(h || HELP); return EXIT.OK; }
  if (o.help || !o._[0]) { console.log((o.help && helpFor(o._[0])) || HELP); return EXIT.OK; }
  if (!COMMANDS.has(o._[0])) { console.error(`[vitest-guard] unknown command ${JSON.stringify(String(o._[0]).slice(0, 40))}\nsee --help`); return EXIT.USAGE; }
  if (o.mode !== undefined && !['vm', 'shared', 'auto'].includes(o.mode)) { console.error(`[vitest-guard] --mode must be vm, shared or auto\nsee --help`); return EXIT.USAGE; }
  if (o.config && !fs.existsSync(path.resolve(o.config))) { console.error(`[vitest-guard] --config ${o.config}: no such file\nsee --help`); return EXIT.USAGE; }
  // a mistyped option would otherwise be ignored silently (e.g. --no-hnt)
  const unknown = Object.keys(o).filter((k) => k !== '_' && !KNOWN_FLAGS.has(k) && !COMMAND_HELP[o._[0]].opts.includes(k));
  if (unknown.length) console.error(`[vitest-guard] ${o._[0]}: ignoring unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => '--' + k).join(', ')} (see ${o._[0]} --help)`);
  process.env.VITEST_GUARD_CLI = '1';
  if (o.diag === false) process.env.VITEST_GUARD_DIAG = '0'; // lean runs: no pollution diff / module-state scan
  if (o['reset-modules'] === false) process.env.VITEST_GUARD_OPTS = JSON.stringify({ ...JSON.parse(process.env.VITEST_GUARD_OPTS || '{}'), resetModules: false }); // planner then adds transitive vi.mock edges
  const c = ctx(o);
  try { vitestBin(c.root); } catch (e) { console.error(`[vitest-guard] ${e.message}\nsee --help`); return EXIT.USAGE; }
  const unsafe = checkState(c);
  if (unsafe) { console.error(unsafe); return EXIT.USAGE; }
  migrateState(c);
  if (NEEDS_WRAP.has(o._[0])) {
    let err;
    try { err = requireWrapped(c); } catch (e) { console.error(`[vitest-guard] ${e.message}`); return EXIT.USAGE; }
    if (err) { console.error(err); return EXIT.USAGE; }
  }
  // S3: without --mode, check / verify test the mode the config runs in (what `vitest run` gates on)
  if (['check', 'verify'].includes(o._[0])) {
    try { listSpecs(c); } catch {}
    if (!o.mode && ['vm', 'shared', 'auto'].includes(c.configMode)) c.mode = c.configMode;
    else if (!o.mode && c.mode !== 'auto' && readJson(path.join(c.stateDir, 'auto.json'), {}).auto) c.mode = 'auto'; // older config marker without configMode
    if (o.mode && c.configMode && c.configMode !== o.mode) say(`config mode: ${c.configMode}, ${o._[0] === 'check' ? 'checking' : 'verifying'}: ${o.mode}`);
  }
  switch (o._[0]) {
    case 'check': { const code = await cmdCheck(c, o); if (o.compare) await cmdCompare(c, o); return code; }
    case 'compare': return cmdCompare(c, o);
    case 'calibrate': return cmdCompare(c, { ...o, sample: o.sample ?? 20 });
    case 'verify': return cmdVerify(c, o);
    case 'plan': await cmdPlan(c, o); return EXIT.OK;
    case 'run': {
      // planned shared run; self-healing unless --no-heal (shared-only failures are bisected -> conflicts.json)
      c.mode = 'shared';
      if (o.heal !== false) return cmdCheck(c, o);
      const r = await cmdRunPlanned(c, o); const failed = [...r.files].filter(([, v]) => v.status !== 'passed').map(([k]) => k);
      // B3: Vitest's exit code (unhandled errors, crashed lanes) and files without a result count as failures
      const notRun = listFiles(c).filter((f) => !r.files.has(f) && !r.missing.includes(f));
      if (notRun.length) sayMissing('the planned shared run (not in the plan: --no-replan with a stale plan?)', notRun);
      if (r.code && !failed.length && !r.missing.length && !notRun.length) say(`Vitest exited with code ${r.code} although no file failed (unhandled error?):\n` + (r.log || '').slice(-2000));
      say(`planned shared run: ${r.files.size} files, ${failed.length} failed ${failed.join(' ')}${r.missing.length + notRun.length ? `, ${r.missing.length + notRun.length} not run` : ''}`);
      return failed.length || r.code || r.missing.length || notRun.length ? EXIT.FAIL : EXIT.OK;
    }
    case 'hunt': return cmdHunt(c, o);
    case 'scan': return cmdScan(c, o);
    case 'report': return report(c, readRunLogs(c.runDir), EXIT.OK);
    default: return EXIT.USAGE;
  }
}
