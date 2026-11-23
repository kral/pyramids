// defineVitestGuardConfig(userConfig, guardOptions) – turns a plain Vitest 5 config into a fast, guarded one.
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VitestGuardSequencer from './sequencer.mjs';
import { validateTestPaths, sanitize, escapeGlob, isInside, globProjectFiles } from './safety.mjs';
import { readStateJson, readStateFile, writeStateFile } from './statefs.mjs';
import { versionProblem } from './stateformat.mjs';
import { listTestFiles, classifyFiles, readModes, DEFAULT_AUTO_MODES, DOM_ENVS } from './auto.mjs';
import { verifyStatus, findConfigFile } from './verifystate.mjs';

// single-module bundle (scripts/bundle-setup.mjs): every setup module costs a fetch + evaluation per test file in vm pools
export const SETUP_FILE = fileURLToPath(new URL('./setup.bundle.mjs', import.meta.url));
/** last setup file in shared mode: marks the end of the setup files (see setup-tail.mjs) */
export const SETUP_TAIL_FILE = fileURLToPath(new URL('./setup-tail.mjs', import.meta.url));

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const localCache = new Map();
/**
 * Path of one of vitest-guard's setup files as Vitest of the project at `root` can load it.
 * Installed normally (inside `<root>/node_modules` or anywhere below the root) it is the file itself. Installed
 * through a symlink (`npm i -D ../vto/vitest-guard`, `npm link`, a checkout next to the project) the real file lives
 * outside the root: Vite refuses to serve it to jsdom/happy-dom tests (`server.fs.strict`) and bare imports would
 * resolve from the checkout instead of the project. Then an identical copy in `<root>/node_modules/.vitest-guard/`
 * is used (refreshed when the content differs).
 */
export function setupFileFor(root, file = SETUP_FILE) {
  const key = root + '\0' + file;
  if (localCache.has(key)) return localCache.get(key);
  let out = file;
  try {
    const rr = realOr(root), rf = realOr(file);
    if (!isInside(rr, rf)) { // S12: case-insensitive on Windows
      // the copy must itself be a REAL path inside the root: Vitest re-runs a setup file per test file by
      // invalidating exactly the path it was given (a symlinked spelling would run once per worker only)
      const nm = realOr(path.join(rr, 'node_modules'));
      const dir = path.join(nm, '.vitest-guard');
      if (fs.existsSync(nm) && nm !== rr && isInside(rr, nm) && !(fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())) {
        const to = path.join(dir, path.basename(file));
        const src = fs.readFileSync(file);
        let same = false;
        try { same = !fs.lstatSync(to).isSymbolicLink() && fs.readFileSync(to).equals(src); } catch {}
        if (!same) {
          fs.mkdirSync(dir, { recursive: true });
          const tmp = `${to}.${process.pid}.${Date.now().toString(36)}.tmp`;
          fs.writeFileSync(tmp, src, { flag: 'wx' });
          fs.renameSync(tmp, to);
        }
        out = to;
      }
    }
  } catch {}
  localCache.set(key, out);
  return out;
}
export const DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
export const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**'];

const warnedState = new Set();
const warnOnce = (msg) => { if (!warnedState.has(msg)) { warnedState.add(msg); console.warn(msg); } };

/** Every string (key or value, a few levels deep) of an unknown quarantine layout that names an existing test file. */
function filesIn(root, q) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 4 || v === null) return;
    if (typeof v === 'string') { out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 100000)) walk(x, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); walk(x, depth + 1); }
  };
  walk(q, 0);
  return validateTestPaths(root, [...out], { warn: false }).ok;
}

/** R3: a quarantine that cannot be used is a configuration error (Vitest exits 1); it never silently runs files fast. */
function quarantineError(file, why) {
  const e = new Error(`[vitest-guard] ${sanitize(file)}: ${why}. The quarantine cannot be applied, so vitest-guard refuses to run rather than run quarantined files in a fast mode (fail closed). ` +
    'Fix or remove the file (`vitest-guard check` reports the same problem with exit 2), or run unguarded with VITEST_GUARD_MODE=isolated.');
  e.code = 'E_QUARANTINE';
  return e;
}

/**
 * Raw quarantine file { version, vm: {file: info}, shared: {file: info} } (validate before use: F9).
 * R3 (fail closed): a symlinked `.vitest-guard/` or quarantine file (security review 3 S2: never followed), an
 * unreadable file, text that is not JSON (merge-conflict markers), a non-object top level and a `vm` / `shared` that
 * is not an object throw: the config does not load and Vitest exits 1.
 * B2 / S3: a newer format version throws as well. VITEST_GUARD_NEWER_STATE=failsafe (teams in the middle of an
 * upgrade) instead treats every existing test file the newer file names (anywhere in it) as quarantined for both fast
 * modes, i.e. runs it isolated; a newer file that names no existing test file still throws.
 */
/** @internal not part of the public API (no typings, may change without notice); exported for the package's own tests */
export function readQuarantineFile(root, file = '.vitest-guard/incompatible.json') {
  let txt;
  try { txt = readStateFile(path.resolve(root, file)); }
  catch (e) { throw quarantineError(file, e?.code === 'E_UNSAFE_STATE' ? String(e.message).replace(/^\[vitest-guard\] /, '') : `cannot be read (${e?.code || e?.message})`); }
  if (txt === null) return {};
  let q;
  try { q = JSON.parse(txt); } catch (e) { throw quarantineError(file, `is not valid JSON (${/^(<{7}|={7}|>{7})/m.test(txt) ? 'merge-conflict markers' : sanitize(e.message, 120)})`); }
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw quarantineError(file, 'is not a JSON object { "version": 2, "vm": {...}, "shared": {...} }');
  const problem = versionProblem('incompatible.json', q, sanitize(file));
  if (problem) {
    if (process.env.VITEST_GUARD_NEWER_STATE !== 'failsafe') throw quarantineError(file, `${problem} (or set VITEST_GUARD_NEWER_STATE=failsafe to run every test file it names isolated)`);
    const files = filesIn(root, q);
    if (!files.length) throw quarantineError(file, `${problem}; VITEST_GUARD_NEWER_STATE=failsafe, but it names no existing test file that could be run isolated`);
    warnOnce(`[vitest-guard] ${problem}. Failing safe (VITEST_GUARD_NEWER_STATE=failsafe): the ${files.length} test file(s) it names run isolated (forks) in every mode.`);
    const all = Object.fromEntries(files.map((f) => [f, { failSafe: true }]));
    return { version: q.version, newer: true, vm: all, shared: all };
  }
  for (const m of ['vm', 'shared']) if (q[m] !== undefined && (!q[m] || typeof q[m] !== 'object' || Array.isArray(q[m]))) throw quarantineError(file, `"${m}" must be an object { "<test file>": {...} }, got ${Array.isArray(q[m]) ? 'an array' : q[m] === null ? 'null' : typeof q[m]}`);
  return q;
}

/** Quarantine list for a mode, validated against the files Vitest globs for include/exclude (F9, R6). */
export function readQuarantine(root, mode, file = '.vitest-guard/incompatible.json', { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE, warn = true } = {}) {
  const q = readQuarantineFile(root, file);
  const keys = q[mode] && typeof q[mode] === 'object' && !Array.isArray(q[mode]) ? Object.keys(q[mode]) : [];
  if (!keys.length) return [];
  // Note 2: entries another config wrote are applied when they name a file of this config (running it isolated is
  // always safe), but are not warned about when they do not (they are that config's business)
  const me = ownConfigId(root);
  const foreign = (k) => isForeignEntry(q[mode][k], me);
  const files = globProjectFiles(root, include, exclude);
  const own = validateTestPaths(root, keys.filter((k) => !foreign(k)), { include, exclude, files, label: `${file} (${mode})`, warn: warn && !q.newer }).ok;
  const other = validateTestPaths(root, keys.filter(foreign), { include, exclude, files, warn: false }).ok;
  return [...own, ...other];
}

/** Note 2: id of the config this process loads (the config file relative to the root, as the CLI stores it in `config`) */
function ownConfigId(root) {
  try { const f = findConfigFile(root, process.argv.slice(2)); return f ? path.relative(root, f).split(path.sep).join('/') : null; } catch { return null; }
}
const isForeignEntry = (info, me) => !!info && typeof info === 'object' && typeof info.config === 'string' && info.config !== me;

/**
 * R6: quarantine keys are relative to the config root (where the CLI runs); a project with its own `root` globs
 * relative to that root. Returns [{ key, rel }] for the keys inside the project (rel = relative to the project root).
 */
function keysForProject(root, projRoot, keys) {
  const pr = path.relative(root, projRoot).split(path.sep).join('/');
  if (!pr) return keys.map((key) => ({ key, rel: key }));
  if (pr.startsWith('..') || path.isAbsolute(pr)) return [];
  return keys.filter((k) => typeof k === 'string' && k.startsWith(pr + '/')).map((key) => ({ key, rel: key.slice(pr.length + 1) }));
}

/**
 * B1: lane entries are relative to the directory Vitest runs in (the CLI's root); include globs of a project with its
 * own `root` are relative to that root. Entries of the project come back relative to its root, others are dropped.
 */
function laneEntriesFor(projRoot, files) {
  const pr = path.relative(process.cwd(), projRoot).split(path.sep).join('/');
  if (!pr || pr.startsWith('..') || path.isAbsolute(pr)) return files;
  return files.filter((f) => typeof f === 'string' && f.startsWith(pr + '/')).map((f) => f.slice(pr.length + 1));
}

/** VITEST_GUARD_LANE_FILE: legacy array of files or { project, files }. */
function readLane(laneFile) {
  const raw = readStateJson(laneFile, null);
  if (Array.isArray(raw)) return { project: null, files: raw };
  if (raw && typeof raw === 'object' && Array.isArray(raw.files)) return { project: typeof raw.project === 'string' ? raw.project : null, files: raw.files };
  throw new Error(`[vitest-guard] VITEST_GUARD_LANE_FILE ${laneFile}: expected a JSON array of test files or { project, files }`);
}

/**
 * Sane vmMemoryLimit: Vitest's default (totalmem / maxWorkers) is checked against heapUsed after each file;
 * with 1-2 workers it is never reached before the machine runs out of RAM (8 GB box: limit 7.7 GB,
 * worker V8 heap limit 8.2 GB). Recycling is expensive (300 MB limit: 7 recycles / 120 files, +44 % CPU),
 * so the limit must be high enough not to trigger for normal suites (peak ~330 MB) but below what the box
 * can hold for all workers at once.
 */
export function autoMemoryLimit(maxWorkers, { totalmem = os.totalmem(), heapLimit = v8.getHeapStatistics().heap_size_limit } = {}) {
  const perWorker = Math.min((totalmem * 0.5) / Math.max(1, maxWorkers), heapLimit * 0.6);
  return Math.max(512 * 1024 * 1024, Math.floor(perWorker));
}

function resolveMaxWorkers(test) {
  if (typeof test.maxWorkers === 'number') return test.maxWorkers;
  if (typeof test.maxWorkers === 'string' && test.maxWorkers.endsWith('%')) return Math.max(1, Math.floor((os.availableParallelism() * parseFloat(test.maxWorkers)) / 100));
  return Math.max(1, os.availableParallelism() - 1); // Vitest run-mode default
}

const projectName = (t) => (typeof t?.name === 'string' ? t.name : t?.name?.label) || '';

/** Mode of one project: env override > the project's own explicit pool > root pool > guard option. */
function projectMode(envMode, projTest, rootTest, gMode) {
  if (envMode === 'isolated' || envMode === 'vm' || envMode === 'shared') return { mode: envMode, keepPool: false };
  for (const t of [projTest, rootTest]) {
    if (!t || t.pool === undefined) continue;
    if (t.pool === 'vmThreads' || t.pool === 'vmForks') return { mode: 'vm', keepPool: true };
    if ((t.pool === 'threads' || t.pool === 'forks') && t.isolate === false) return { mode: 'shared', keepPool: true };
    return { mode: 'isolated', keepPool: true }; // an explicitly isolated (or custom) pool is left alone
  }
  return { mode: gMode || 'vm', keepPool: false };
}

function poolFor(mode, keepPool, projTest, rootTest, g) {
  const explicit = projTest?.pool ?? rootTest?.pool;
  if (keepPool) return mode === 'shared' ? { pool: explicit, isolate: false } : { pool: explicit };
  if (mode === 'vm') return { pool: 'vmThreads' };
  if (mode === 'shared') return { pool: g.sharedPool || 'threads', isolate: false };
  return { pool: 'forks', isolate: true };
}

/**
 * @param {import('vitest/config').ViteUserConfig} userConfig plain object (not a function)
 * @param {object} [g]
 * @param {'vm'|'shared'} [g.mode='vm']
 */
/** R5: name of mode auto's catch-all project (files neither group lists; runs isolated) */
export const AUTO_REST = 'auto:rest';
const POOL_OF = { vm: { pool: 'vmThreads' }, shared: { pool: 'threads', isolate: false }, isolated: { pool: 'forks', isolate: true } };

/**
 * mode 'auto': choose the mode per group of test files.
 *  - user `projects`: kept as the user split them; only the mode of each project is chosen;
 *  - otherwise: files are classified into a `dom` and a `node` project (src/auto.mjs).
 * Mode per group/project: g.autoModes[name] > .vitest-guard/run/modes.json (vitest-guard compare / calibrate) > defaults
 * (dom -> vm, node -> shared). Explicit pools of user projects are replaced unless g.respectPools.
 */
function autoConfig(userConfig, g, root) {
  const test = { ...(userConfig.test || {}) };
  const stored = readModes(root);
  const pick = (name, isDom) => {
    // a single-project suite measured by `compare` before (or without) the split is stored as 'root' (trial S1)
    const m = g.autoModes?.[name] ?? stored[name] ?? (!Array.isArray(test.projects) ? stored.root : undefined) ?? (isDom ? g.autoModes?.dom ?? DEFAULT_AUTO_MODES.dom : g.autoModes?.node ?? DEFAULT_AUTO_MODES.node);
    return POOL_OF[m] ? m : 'isolated';
  };
  const strip = (t) => { const { pool, isolate, ...rest } = t; return rest; };
  const groups = {};
  const record = (listed) => {
    // for the CLI: `check` on an auto config runs in auto mode and calibrates first when modes.json is missing
    try {
      const f = path.join(root, '.vitest-guard', 'run', 'auto.json');
      const txt = JSON.stringify({ auto: true, groups, nodeEnvironment: g.nodeEnvironment ?? null, ...(listed != null ? { listed } : {}) });
      let old = null; try { old = JSON.stringify(readStateJson(f, null)); } catch {}
      if (old !== txt) writeStateFile(f, txt); // refuses a symlinked .vitest-guard/ or run/
    } catch (e) { if (e?.code === 'E_UNSAFE_STATE') warnOnce(`${e.message}; auto.json is not written`); }
  };
  if (Array.isArray(test.projects)) {
    test.projects = test.projects.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const pt = { ...(p.test || {}) };
      if (g.respectPools && pt.pool !== undefined) return p;
      const env = pt.environment ?? (p.extends === true ? test.environment : undefined);
      const name = projectName(pt);
      const mode = pick(name, DOM_ENVS.has(env));
      groups[name] = mode;
      return { ...p, test: { ...strip(pt), ...POOL_OF[mode], provide: { ...(pt.provide || {}), vitestGuardAuto: DOM_ENVS.has(env) ? 'dom' : 'node' } } };
    });
    record();
    return { ...userConfig, test };
  }
  const include = test.include || DEFAULT_INCLUDE;
  const exclude = test.exclude || DEFAULT_EXCLUDE;
  const files = listTestFiles(root, include, exclude);
  const optIn = g.nodeEnvironment === 'node';
  const { dom, node } = classifyFiles(root, files, test.environment, { nodeEnvironment: g.nodeEnvironment });
  const projects = [];
  const base = strip(test);
  // node group environment: 'node' for DOM-configured suites (pragma-node files, or opt-in moved files),
  // otherwise the configured non-DOM environment stays (e.g. edge-runtime)
  const nodeEnv = DOM_ENVS.has(test.environment) || !test.environment ? 'node' : test.environment;
  if (dom.length) { groups.dom = pick('dom', true); projects.push({ extends: true, test: { name: 'dom', include: dom.map(escapeGlob), ...POOL_OF[groups.dom], provide: { vitestGuardAuto: 'dom' } } }); }
  if (node.length) { groups.node = pick('node', false); projects.push({ extends: true, test: { name: 'node', environment: nodeEnv, include: node.map(escapeGlob), ...POOL_OF[groups.node], provide: { vitestGuardAuto: 'node', vitestGuardAutoHeal: optIn } } }); }
  // R5 (fail closed): every file Vitest globs that is in neither group (a listing that differs from Vitest's) still
  // runs, in isolated forks with the configured environment: the user's include minus the two groups' literal files
  groups[AUTO_REST] = 'isolated';
  projects.push({ extends: true, test: { name: AUTO_REST, include, exclude: [...exclude, ...files.map(escapeGlob)], ...POOL_OF.isolated } });
  record(files.length); // files the dom and node groups list: the CLI hides auto:rest when Vitest lists no more than that
  if (process.env.VITEST_GUARD_AUTO_VERBOSE) console.log(`[vitest-guard] auto: dom ${dom.length} files (${projects.find((p) => p.test.name === 'dom')?.test.pool ?? '-'}), node ${node.length} files (${projects.find((p) => p.test.name === 'node')?.test.pool ?? '-'})`);
  const { include: _i, ...rootRest } = base; // root include would be merged into the projects (extends: true)
  return { ...userConfig, test: { ...rootRest, exclude, projects } };
}

// S3: the mode the config itself runs in (what `vitest run` does), for the CLI's default --mode
function configModeOf(g) {
  let m = g.mode;
  try { const o = process.env.VITEST_GUARD_OPTS ? JSON.parse(process.env.VITEST_GUARD_OPTS) : {}; if (o && o.mode) m = o.mode; } catch {}
  return m === 'shared' || m === 'auto' || m === 'isolated' ? m : 'vm';
}

// S2: the mode a plain `vitest run` of this config runs in (VITEST_GUARD_MODE overrides the config)
const effectiveMode = (g) => { const e = process.env.VITEST_GUARD_MODE; return ['vm', 'shared', 'auto', 'isolated'].includes(e) ? e : configModeOf(g); };
let warnedVerify = false;
const usesShared = (cfg) => [cfg?.test, ...(Array.isArray(cfg?.test?.projects) ? cfg.test.projects.map((p) => p?.test) : [])].some((t) => t?.provide?.vitestGuard?.mode === 'shared');

export function defineVitestGuardConfig(userConfig = {}, g = {}) {
  if (typeof userConfig === 'function' || (userConfig && typeof userConfig.then === 'function'))
    throw new Error('[vitest-guard] defineVitestGuardConfig needs a plain config object, not a function or a promise. Resolve it first, e.g. `export default defineConfig(async (env) => defineVitestGuardConfig(await base(env)))`.');
  // U-2: the vitest-guard CLI must know that the config it measures really goes through this function
  // (an unwrapped config ignores VITEST_GUARD_MODE: every "mode" would silently be the user's own pool)
  if (process.env.VITEST_GUARD_WRAP_MARKER && !g._autoDone) { try { fs.appendFileSync(process.env.VITEST_GUARD_WRAP_MARKER, JSON.stringify({ pid: process.pid, mode: process.env.VITEST_GUARD_MODE || g.mode || 'vm', configMode: configModeOf(g) }) + '\n'); } catch {} }
  const out = buildConfig(userConfig, g);
  // M6: shared mode can be green where forks are red (state left by an earlier file); only `vitest-guard verify`
  // compares the two. Say so when the gate runs in shared mode without a clean verify for this commit/config.
  if (!warnedVerify && !g._autoDone && g.verifyWarning !== false && !process.env.VITEST_GUARD_CLI && !process.env.VITEST_GUARD_LANE_FILE && process.env.VITEST_GUARD_VERIFY_WARNING !== '0' && process.env.VITEST_GUARD_MODE !== 'off' && usesShared(out)) {
    warnedVerify = true;
    try {
      const root = path.resolve(userConfig.root || userConfig.test?.root || process.cwd());
      const st = verifyStatus(root, 'shared', { configFile: findConfigFile(root, process.argv.slice(2)), configMode: effectiveMode(g) });
      if (!st.ok) console.warn(`[vitest-guard] shared mode is not verified against isolated forks: ${st.reason}. A test can pass here only because of state left by an earlier file in the same worker (false green). ` +
        'Run `vitest-guard verify --mode shared` (exit 5 = false green; records the result for this commit) and keep a periodic `VITEST_GUARD_MODE=isolated vitest run`. Silence: verifyWarning: false or VITEST_GUARD_VERIFY_WARNING=0.');
    } catch {}
  }
  return out;
}

function buildConfig(userConfig, g) {
  if (process.env.VITEST_GUARD_OPTS) g = { ...g, ...JSON.parse(process.env.VITEST_GUARD_OPTS) }; // CI / experiments
  if (g.quarantineFile !== undefined) throw new Error('[vitest-guard] the `quarantineFile` option was removed in 0.1.0-alpha.3: the CLI always reads and writes .vitest-guard/incompatible.json, so another path could never be kept in sync. Delete the option (move the file to .vitest-guard/incompatible.json).');
  const envMode = process.env.VITEST_GUARD_MODE;
  if (envMode === 'off') return userConfig;
  if ((g.mode === 'auto' || envMode === 'auto') && !g._autoDone) {
    const root0 = path.resolve(userConfig.root || userConfig.test?.root || process.cwd());
    return buildConfig(autoConfig(userConfig, g, root0), { ...g, mode: 'vm', _autoDone: true });
  }
  const test = { ...(userConfig.test || {}) };
  if (test.poolOptions) console.warn('[vitest-guard] test.poolOptions was removed in Vitest 4 and is ignored (use vmMemoryLimit / maxWorkers).');
  const root = path.resolve(userConfig.root || test.root || process.cwd());
  const quarantineFile = '.vitest-guard/incompatible.json';
  const laneFile = process.env.VITEST_GUARD_LANE_FILE;
  const lane = laneFile ? readLane(laneFile) : null;
  const ignoreQ = !!process.env.VITEST_GUARD_IGNORE_QUARANTINE;

  const maxWorkers = lane ? 1 : resolveMaxWorkers(test);
  const inline = [...new Set([...(test.server?.deps?.inline === true ? [] : test.server?.deps?.inline || []), ...(g.inline || [])])];
  if (inline.includes('react') !== inline.includes('react-dom') && test.server?.deps?.inline !== true)
    console.warn('[vitest-guard] server.deps.inline contains only one of react / react-dom: two React copies are possible.');

  const provideBase = {
    root, runDir: path.join(root, '.vitest-guard', 'run', 'logs'), stateDir: path.join(root, '.vitest-guard', 'run'),
    onDirty: g.onDirty || 'warn', react: g.react ?? true, reactPackages: g.reactPackages || [], realm: g.realm ?? true, probes: g.probes ?? true,
    restoreEnv: g.restoreEnv ?? true, reset: g.reset ?? true, resetModules: g.resetModules ?? true, // shared mode: required for vi.mock correctness (cached importers keep the first binding)
    moduleState: g.moduleState, detectPollution: g.detectPollution, diag: g.diag, ignoreListeners: g.ignoreListeners || [], ignoreModules: g.ignoreModules || [], keepGlobals: Array.isArray(g.keepGlobals) ? g.keepGlobals.filter((k) => typeof k === 'string') : [], log: g.log ?? true,
    integrity: g.integrity ?? true,
  };
  // shared mode: a tail setup file marks "setup files done" (M6); that needs the setup files to run in list order.
  // Note 3 (alpha.3): the shared-mode baseline (env, globals, DOM) is taken there, so the tail is not optional: `tail:
  // false` is refused (fail closed) and `sequence.setupFiles: 'parallel'` runs in list order (a valid order of a
  // parallel start) with a warning.
  const userSeq = test.sequence?.setupFiles;
  const tailFor = (m, t) => {
    if (m !== 'shared') return false;
    if (g.tail === false) throw new Error("[vitest-guard] tail: false is not supported in shared mode: the baseline that the resets restore (process.env, globals, DOM) must be taken after the setup files, which the tail setup file marks. Remove `tail: false` (or use mode 'vm' / 'isolated').");
    if ((t?.sequence?.setupFiles ?? userSeq) === 'parallel') warnOnce("[vitest-guard] sequence.setupFiles 'parallel' runs in list order in shared mode: the baseline is taken after the last setup file (tail setup file).");
    return true;
  };
  const seqFor = (m, t) => (tailFor(m, t) ? { sequence: { ...(t?.sequence || {}), setupFiles: 'list' } } : {});
  const withSetup = (setup, m, t) => [...(g.setup === 'import' ? [] : [setupFileFor(root)]), ...setup, ...(tailFor(m, t) ? [setupFileFor(root, SETUP_TAIL_FILE)] : [])];
  const vmLimit = () => test.vmMemoryLimit ?? g.memoryLimit ?? autoMemoryLimit(maxWorkers);

  const out = { ...userConfig, test: { ...test, maxWorkers } };
  if (inline.length) out.test.server = { ...(test.server || {}), deps: { ...(test.server?.deps || {}), inline } };
  if (lane) out.test.sequence = { ...(test.sequence || {}), sequencer: VitestGuardSequencer };

  // ---------------- multi-project config (Architecture review #10) ----------------
  if (Array.isArray(test.projects)) {
    const rootSetup = [].concat(test.setupFiles || []);
    delete out.test.setupFiles; // re-added per project so that vitest-guard's setup always runs first
    delete out.test.pool; delete out.test.isolate;
    const rootInclude = test.include, rootExclude = test.exclude;
    const projects = [];
    let anyVm = false;
    let qRaw = null; // read only when a project runs in a fast mode (an isolated run needs no quarantine)
    const quarantine = () => (qRaw ??= ignoreQ ? {} : readQuarantineFile(root, quarantineFile));
    const claimed = new Set();
    const remaps = [];
    for (const p of test.projects) {
      if (!p || typeof p !== 'object' || typeof p === 'function') {
        console.warn(`[vitest-guard] project ${typeof p === 'string' ? sanitize(JSON.stringify(p)) : '(function)'} is not an inline config and is not guarded: wrap that config with defineVitestGuardConfig itself.`);
        projects.push(p);
        continue;
      }
      const pt = { ...(p.test || {}) };
      const inherits = p.extends === true;
      const name = projectName(pt);
      const { mode, keepPool } = projectMode(envMode, pt, inherits ? test : null, g.mode);
      const pool = poolFor(mode, keepPool, pt, inherits ? test : null, g);
      if (mode === 'vm') anyVm = true;
      const include = pt.include || (inherits && rootInclude) || DEFAULT_INCLUDE;
      const exclude = pt.exclude || (inherits && rootExclude) || DEFAULT_EXCLUDE;
      const setupFiles = withSetup([...(inherits ? rootSetup : []), ...[].concat(pt.setupFiles || [])], mode, pt);
      const isoSetup = withSetup([...(inherits ? rootSetup : []), ...[].concat(pt.setupFiles || [])], 'isolated', pt);
      const seq = seqFor(mode, pt);
      const provide = (m) => ({ ...(pt.provide || {}), vitestGuard: { ...provideBase, mode: m, project: name, tail: tailFor(m, pt) } });
      if (lane) {
        if (lane.project !== null && lane.project !== name) continue;
        const projRoot = path.resolve(root, typeof (pt.root ?? p.root) === 'string' ? pt.root ?? p.root : '.');
        const files = validateTestPaths(projRoot, laneEntriesFor(projRoot, lane.files), { include, exclude, label: 'VITEST_GUARD_LANE_FILE', warn: lane.project !== null }).ok;
        if (!files.length) continue;
        projects.push({ ...p, test: { ...pt, ...pool, ...seq, include: files.map(escapeGlob), exclude, setupFiles, provide: provide(mode) } });
        continue;
      }
      const qm = mode !== 'isolated' ? quarantine()[mode] : null;
      const qKeys = qm && typeof qm === 'object' ? Object.keys(qm) : [];
      let quarantined = [];
      if (qKeys.length) {
        // R6: relative to the project's own root, checked against the files Vitest itself globs for the project
        const projRoot = path.resolve(root, typeof (pt.root ?? p.root) === 'string' ? pt.root ?? p.root : '.');
        const pairs = keysForProject(root, projRoot, qKeys);
        const v = validateTestPaths(projRoot, pairs.map((x) => x.rel), { include, exclude, files: globProjectFiles(projRoot, include, exclude), warn: false });
        quarantined = v.ok;
        for (const x of pairs) if (v.map.has(x.rel)) { claimed.add(`${mode}\0${x.key}`); if (v.map.get(x.rel) !== x.rel) remaps.push({ mode, key: x.key, to: x.key.slice(0, x.key.length - x.rel.length) + v.map.get(x.rel) }); }
      }
      projects.push({ ...p, test: { ...pt, ...pool, ...seq, include, exclude: [...exclude, ...quarantined.map(escapeGlob)], setupFiles, provide: provide(mode) } });
      if (quarantined.length) projects.push({ ...p, test: { ...pt, name: `${name || 'project'}:isolated`, pool: 'forks', isolate: true, include: quarantined.map(escapeGlob), exclude, setupFiles: isoSetup, provide: provide('isolated') } });
    }
    // F9: report quarantine entries that no project accepted
    // (only entries of a mode some project runs in: an entry of the other fast mode is not this run's business)
    const used = new Set(projects.map((x) => x?.test?.provide?.vitestGuard?.mode).filter(Boolean));
    for (const m of ['vm', 'shared']) {
      if (!qRaw || !used.has(m)) continue;
      const keys = qRaw[m] && typeof qRaw[m] === 'object' ? Object.keys(qRaw[m]) : [];
      const me = ownConfigId(root);
      const stray = keys.filter((k) => !claimed.has(`${m}\0${k}`) && !isForeignEntry(qRaw[m][k], me));
      for (const k of stray.slice(0, 20)) if (!qRaw.newer) warnOnce(`[vitest-guard] ignoring ${sanitize(quarantineFile)} (${m}) entry ${sanitize(JSON.stringify(String(k)), 200)}: no project runs it in mode ${m} (stale entry? \`vitest-guard check --prune\` removes it)`);
    }
    for (const r of remaps) warnOnce(`[vitest-guard] ${sanitize(quarantineFile)} (${r.mode}) entry ${sanitize(JSON.stringify(r.key), 200)} is spelled differently on disk (case or Unicode form): applied to ${sanitize(JSON.stringify(r.to), 200)}; re-spell the key (\`vitest-guard check\` rewrites it)`);
    if (anyVm) out.test.vmMemoryLimit = vmLimit();
    out.test.projects = projects;
    return out;
  }

  // ---------------- single-project config ----------------
  const mode = envMode === 'isolated' || envMode === 'vm' || envMode === 'shared' ? envMode : g.mode || 'vm';
  const userSetup = [].concat(test.setupFiles || []);
  const include = test.include || DEFAULT_INCLUDE;
  const exclude = test.exclude || DEFAULT_EXCLUDE;
  const setupFiles = withSetup(userSetup, mode, null);
  const isoSetup = withSetup(userSetup, 'isolated', null);
  for (const k of ['setupFiles', 'include', 'exclude', 'pool', 'isolate']) delete out.test[k];
  const provide = (m) => ({ ...(test.provide || {}), vitestGuard: { ...provideBase, mode: m, tail: tailFor(m, null) } });
  if (tailFor(mode, null)) out.test.sequence = { ...(out.test.sequence || {}), setupFiles: 'list' };

  if (mode === 'isolated') {
    Object.assign(out.test, { pool: 'forks', isolate: true, include, exclude, setupFiles: isoSetup, provide: provide('isolated') });
    return out;
  }
  const fast = mode === 'vm' ? { pool: 'vmThreads', vmMemoryLimit: vmLimit() } : { pool: g.sharedPool || 'threads', isolate: false };

  if (lane) {
    // one lane of a shared-mode plan: exactly these (validated) files, one worker, plan order
    const files = validateTestPaths(root, laneEntriesFor(root, lane.files), { include, exclude, label: 'VITEST_GUARD_LANE_FILE' }).ok;
    if (!files.length) throw new Error('[vitest-guard] VITEST_GUARD_LANE_FILE contains no valid test file');
    Object.assign(out.test, { ...fast, include: files.map(escapeGlob), exclude, setupFiles, provide: provide(mode) });
    return out;
  }
  const quarantined = ignoreQ ? [] : readQuarantine(root, mode, quarantineFile, { include, exclude });
  if (!quarantined.length && !g.alwaysProjects) {
    // no quarantine: no projects at all - a single inline project measurably costs CPU (~4 % on heavy)
    Object.assign(out.test, { ...fast, include, exclude, setupFiles, provide: provide(mode) });
    return out;
  }
  if (mode === 'vm') out.test.vmMemoryLimit = fast.vmMemoryLimit; // read from the root config only
  out.test.projects = [{ extends: true, test: { name: `vitest-guard:${mode}`, ...fast, include, exclude: [...exclude, ...quarantined.map(escapeGlob)], setupFiles, provide: provide(mode) } }];
  if (quarantined.length) out.test.projects.push({ extends: true, test: { name: 'vitest-guard:isolated', pool: 'forks', isolate: true, include: quarantined.map(escapeGlob), exclude, setupFiles: isoSetup, provide: provide('isolated') } });
  return out;
}

export { VitestGuardSequencer };
