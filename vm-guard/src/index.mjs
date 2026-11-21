// defineVmGuardConfig(userConfig, guardOptions) – turns a plain Vitest 5 config into a fast, guarded one.
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VmGuardSequencer from './sequencer.mjs';
import { validateTestPaths } from './safety.mjs';
import { listTestFiles, classifyFiles, readModes, DEFAULT_AUTO_MODES, DOM_ENVS } from './auto.mjs';
import { verifyStatus, findConfigFile } from './verifystate.mjs';

// single-module bundle (scripts/bundle-setup.mjs): every setup module costs a fetch + evaluation per test file in vm pools
export const SETUP_FILE = fileURLToPath(new URL('./setup.bundle.mjs', import.meta.url));
/** last setup file in shared mode: marks the end of the setup files (see setup-tail.mjs) */
export const SETUP_TAIL_FILE = fileURLToPath(new URL('./setup-tail.mjs', import.meta.url));

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const localCache = new Map();
/**
 * Path of one of vm-guard's setup files as Vitest of the project at `root` can load it.
 * Installed normally (inside `<root>/node_modules` or anywhere below the root) it is the file itself. Installed
 * through a symlink (`npm i -D ../vto/vm-guard`, `npm link`, a checkout next to the project) the real file lives
 * outside the root: Vite refuses to serve it to jsdom/happy-dom tests (`server.fs.strict`) and bare imports would
 * resolve from the checkout instead of the project. Then an identical copy in `<root>/node_modules/.vm-guard/`
 * is used (refreshed when the content differs).
 */
export function setupFileFor(root, file = SETUP_FILE) {
  const key = root + '\0' + file;
  if (localCache.has(key)) return localCache.get(key);
  let out = file;
  try {
    const rr = realOr(root), rf = realOr(file);
    if (!(rf === rr || rf.startsWith(rr + path.sep))) {
      // the copy must itself be a REAL path inside the root: Vitest re-runs a setup file per test file by
      // invalidating exactly the path it was given (a symlinked spelling would run once per worker only)
      const nm = realOr(path.join(rr, 'node_modules'));
      const dir = path.join(nm, '.vm-guard');
      if (fs.existsSync(nm) && nm.startsWith(rr + path.sep) && !(fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())) {
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

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Raw quarantine file { version, vm: {file: info}, shared: {file: info} } (validate before use: F9). */
export function readQuarantineFile(root, file = '.vm-guard/incompatible.json') {
  const q = readJson(path.resolve(root, file), {});
  return q && typeof q === 'object' && !Array.isArray(q) ? q : {};
}

/** Quarantine list for a mode, validated against include/exclude (F9). */
export function readQuarantine(root, mode, file = '.vm-guard/incompatible.json', { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE, warn = true } = {}) {
  const q = readQuarantineFile(root, file);
  const keys = q[mode] && typeof q[mode] === 'object' && !Array.isArray(q[mode]) ? Object.keys(q[mode]) : [];
  return validateTestPaths(root, keys, { include, exclude, label: `${file} (${mode})`, warn }).ok;
}

/** VM_GUARD_LANE_FILE: legacy array of files or { project, files }. */
function readLane(laneFile) {
  const raw = readJson(laneFile, null);
  if (Array.isArray(raw)) return { project: null, files: raw };
  if (raw && typeof raw === 'object' && Array.isArray(raw.files)) return { project: typeof raw.project === 'string' ? raw.project : null, files: raw.files };
  throw new Error(`[vm-guard] VM_GUARD_LANE_FILE ${laneFile}: expected a JSON array of test files or { project, files }`);
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
const POOL_OF = { vm: { pool: 'vmThreads' }, shared: { pool: 'threads', isolate: false }, isolated: { pool: 'forks', isolate: true } };

/**
 * mode 'auto': choose the mode per group of test files.
 *  - user `projects`: kept as the user split them; only the mode of each project is chosen;
 *  - otherwise: files are classified into a `dom` and a `node` project (src/auto.mjs).
 * Mode per group/project: g.autoModes[name] > .vm-guard/run/modes.json (vm-guard compare / calibrate) > defaults
 * (dom -> vm, node -> shared). Explicit pools of user projects are replaced unless g.respectPools.
 */
function autoConfig(userConfig, g, root) {
  const test = { ...(userConfig.test || {}) };
  const stored = readModes(root);
  const pick = (name, isDom) => {
    const m = g.autoModes?.[name] ?? stored[name] ?? (isDom ? g.autoModes?.dom ?? DEFAULT_AUTO_MODES.dom : g.autoModes?.node ?? DEFAULT_AUTO_MODES.node);
    return POOL_OF[m] ? m : 'isolated';
  };
  const strip = (t) => { const { pool, isolate, ...rest } = t; return rest; };
  const groups = {};
  const record = () => {
    // for the CLI: `check` on an auto config runs in auto mode and calibrates first when modes.json is missing
    try {
      const dir = path.join(root, '.vm-guard', 'run'), f = path.join(dir, 'auto.json');
      const txt = JSON.stringify({ auto: true, groups, nodeEnvironment: g.nodeEnvironment ?? null });
      let old = null; try { old = fs.readFileSync(f, 'utf8'); } catch {}
      if (old !== txt) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, txt); }
    } catch {}
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
      return { ...p, test: { ...strip(pt), ...POOL_OF[mode], provide: { ...(pt.provide || {}), vmGuardAuto: DOM_ENVS.has(env) ? 'dom' : 'node' } } };
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
  if (dom.length) { groups.dom = pick('dom', true); projects.push({ extends: true, test: { name: 'dom', include: dom, ...POOL_OF[groups.dom], provide: { vmGuardAuto: 'dom' } } }); }
  if (node.length) { groups.node = pick('node', false); projects.push({ extends: true, test: { name: 'node', environment: nodeEnv, include: node, ...POOL_OF[groups.node], provide: { vmGuardAuto: 'node', vmGuardAutoHeal: optIn } } }); }
  record();
  if (process.env.VM_GUARD_AUTO_VERBOSE) console.log(`[vm-guard] auto: dom ${dom.length} files (${projects.find((p) => p.test.name === 'dom')?.test.pool ?? '-'}), node ${node.length} files (${projects.find((p) => p.test.name === 'node')?.test.pool ?? '-'})`);
  const { include: _i, ...rootRest } = base; // root include would be merged into the projects (extends: true)
  return { ...userConfig, test: { ...rootRest, exclude, projects } };
}

let warnedVerify = false;
const usesShared = (cfg) => [cfg?.test, ...(Array.isArray(cfg?.test?.projects) ? cfg.test.projects.map((p) => p?.test) : [])].some((t) => t?.provide?.vmGuard?.mode === 'shared');

export function defineVmGuardConfig(userConfig = {}, g = {}) {
  if (typeof userConfig === 'function' || (userConfig && typeof userConfig.then === 'function'))
    throw new Error('[vm-guard] defineVmGuardConfig needs a plain config object, not a function or a promise. Resolve it first, e.g. `export default defineConfig(async (env) => defineVmGuardConfig(await base(env)))`.');
  // U-2: the vm-guard CLI must know that the config it measures really goes through this function
  // (an unwrapped config ignores VM_GUARD_MODE: every "mode" would silently be the user's own pool)
  if (process.env.VM_GUARD_WRAP_MARKER && !g._autoDone) { try { fs.appendFileSync(process.env.VM_GUARD_WRAP_MARKER, JSON.stringify({ pid: process.pid, mode: process.env.VM_GUARD_MODE || g.mode || 'vm' }) + '\n'); } catch {} }
  const out = buildConfig(userConfig, g);
  // M6: shared mode can be green where forks are red (state left by an earlier file); only `vm-guard verify`
  // compares the two. Say so when the gate runs in shared mode without a clean verify for this commit/config.
  if (!warnedVerify && !g._autoDone && g.verifyWarning !== false && !process.env.VM_GUARD_CLI && !process.env.VM_GUARD_LANE_FILE && process.env.VM_GUARD_VERIFY_WARNING !== '0' && process.env.VM_GUARD_MODE !== 'off' && usesShared(out)) {
    warnedVerify = true;
    try {
      const root = path.resolve(userConfig.root || userConfig.test?.root || process.cwd());
      const st = verifyStatus(root, 'shared', { configFile: findConfigFile(root, process.argv.slice(2)), quarantineFile: g.quarantineFile });
      if (!st.ok) console.warn(`[vm-guard] shared mode is not verified against isolated forks: ${st.reason}. A test can pass here only because of state left by an earlier file in the same worker (false green). ` +
        'Run `vm-guard verify --mode shared` (exit 5 = false green; records the result for this commit) and keep a periodic `VM_GUARD_MODE=isolated vitest run`. Silence: verifyWarning: false or VM_GUARD_VERIFY_WARNING=0.');
    } catch {}
  }
  return out;
}

function buildConfig(userConfig, g) {
  if (process.env.VM_GUARD_OPTS) g = { ...g, ...JSON.parse(process.env.VM_GUARD_OPTS) }; // CI / experiments
  const envMode = process.env.VM_GUARD_MODE;
  if (envMode === 'off') return userConfig;
  if ((g.mode === 'auto' || envMode === 'auto') && !g._autoDone) {
    const root0 = path.resolve(userConfig.root || userConfig.test?.root || process.cwd());
    return buildConfig(autoConfig(userConfig, g, root0), { ...g, mode: 'vm', _autoDone: true });
  }
  const test = { ...(userConfig.test || {}) };
  if (test.poolOptions) console.warn('[vm-guard] test.poolOptions was removed in Vitest 4 and is ignored (use vmMemoryLimit / maxWorkers).');
  const root = path.resolve(userConfig.root || test.root || process.cwd());
  const quarantineFile = g.quarantineFile || '.vm-guard/incompatible.json';
  const laneFile = process.env.VM_GUARD_LANE_FILE;
  const lane = laneFile ? readLane(laneFile) : null;
  const ignoreQ = !!process.env.VM_GUARD_IGNORE_QUARANTINE;

  const maxWorkers = lane ? 1 : resolveMaxWorkers(test);
  const inline = [...new Set([...(test.server?.deps?.inline === true ? [] : test.server?.deps?.inline || []), ...(g.inline || [])])];
  if (inline.includes('react') !== inline.includes('react-dom') && test.server?.deps?.inline !== true)
    console.warn('[vm-guard] server.deps.inline contains only one of react / react-dom: two React copies are possible.');

  const provideBase = {
    root, runDir: path.join(root, '.vm-guard', 'run', 'logs'), stateDir: path.join(root, '.vm-guard', 'run'),
    onDirty: g.onDirty || 'warn', react: g.react ?? true, realm: g.realm ?? true, probes: g.probes ?? true,
    restoreEnv: g.restoreEnv ?? true, reset: g.reset ?? true, resetModules: g.resetModules ?? true, // shared mode: required for vi.mock correctness (cached importers keep the first binding)
    moduleState: g.moduleState, detectPollution: g.detectPollution, diag: g.diag, ignoreListeners: g.ignoreListeners || [], ignoreModules: g.ignoreModules || [], log: g.log ?? true,
    integrity: g.integrity ?? true,
  };
  // shared mode: a tail setup file marks "setup files done" (M6); that needs the setup files to run in list order
  const userSeq = test.sequence?.setupFiles;
  const tailFor = (m, t) => m === 'shared' && g.tail !== false && (t?.sequence?.setupFiles ?? userSeq) !== 'parallel';
  const seqFor = (m, t) => (tailFor(m, t) ? { sequence: { ...(t?.sequence || {}), setupFiles: 'list' } } : {});
  const withSetup = (setup, m, t) => [...(g.setup === 'import' ? [] : [setupFileFor(root)]), ...setup, ...(tailFor(m, t) ? [setupFileFor(root, SETUP_TAIL_FILE)] : [])];
  const vmLimit = () => test.vmMemoryLimit ?? g.memoryLimit ?? autoMemoryLimit(maxWorkers);

  const out = { ...userConfig, test: { ...test, maxWorkers } };
  if (inline.length) out.test.server = { ...(test.server || {}), deps: { ...(test.server?.deps || {}), inline } };
  if (lane) out.test.sequence = { ...(test.sequence || {}), sequencer: VmGuardSequencer };

  // ---------------- multi-project config (Architecture review #10) ----------------
  if (Array.isArray(test.projects)) {
    const rootSetup = [].concat(test.setupFiles || []);
    delete out.test.setupFiles; // re-added per project so that vm-guard's setup always runs first
    delete out.test.pool; delete out.test.isolate;
    const rootInclude = test.include, rootExclude = test.exclude;
    const projects = [];
    let anyVm = false;
    const qRaw = ignoreQ ? {} : readQuarantineFile(root, quarantineFile);
    const claimed = new Set();
    for (const p of test.projects) {
      if (!p || typeof p !== 'object' || typeof p === 'function') {
        console.warn(`[vm-guard] project ${typeof p === 'string' ? JSON.stringify(p) : '(function)'} is not an inline config and is not guarded: wrap that config with defineVmGuardConfig itself.`);
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
      const provide = (m) => ({ ...(pt.provide || {}), vmGuard: { ...provideBase, mode: m, project: name, tail: tailFor(m, pt) } });
      if (lane) {
        if (lane.project !== null && lane.project !== name) continue;
        const files = validateTestPaths(root, lane.files, { include, exclude, label: 'VM_GUARD_LANE_FILE', warn: lane.project !== null }).ok;
        if (!files.length) continue;
        projects.push({ ...p, test: { ...pt, ...pool, ...seq, include: files, exclude, setupFiles, provide: provide(mode) } });
        continue;
      }
      const qKeys = mode !== 'isolated' && qRaw[mode] && typeof qRaw[mode] === 'object' ? Object.keys(qRaw[mode]) : [];
      const quarantined = validateTestPaths(root, qKeys, { include, exclude, warn: false }).ok;
      quarantined.forEach((f) => claimed.add(f));
      projects.push({ ...p, test: { ...pt, ...pool, ...seq, include, exclude: [...exclude, ...quarantined], setupFiles, provide: provide(mode) } });
      if (quarantined.length) projects.push({ ...p, test: { ...pt, name: `${name || 'project'}:isolated`, pool: 'forks', isolate: true, include: quarantined, exclude, setupFiles: isoSetup, provide: provide('isolated') } });
    }
    // F9: report quarantine entries that no project accepted
    for (const m of ['vm', 'shared']) {
      const keys = qRaw[m] && typeof qRaw[m] === 'object' ? Object.keys(qRaw[m]) : [];
      const stray = keys.filter((k) => !claimed.has(k));
      if (stray.length) validateTestPaths(root, stray, { include: [], label: `${quarantineFile} (${m}): no project includes it;` });
    }
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
  const provide = (m) => ({ ...(test.provide || {}), vmGuard: { ...provideBase, mode: m, tail: tailFor(m, null) } });
  if (tailFor(mode, null)) out.test.sequence = { ...(out.test.sequence || {}), setupFiles: 'list' };

  if (mode === 'isolated') {
    Object.assign(out.test, { pool: 'forks', isolate: true, include, exclude, setupFiles: isoSetup, provide: provide('isolated') });
    return out;
  }
  const fast = mode === 'vm' ? { pool: 'vmThreads', vmMemoryLimit: vmLimit() } : { pool: g.sharedPool || 'threads', isolate: false };

  if (lane) {
    // one lane of a shared-mode plan: exactly these (validated) files, one worker, plan order
    const files = validateTestPaths(root, lane.files, { include, exclude, label: 'VM_GUARD_LANE_FILE' }).ok;
    if (!files.length) throw new Error('[vm-guard] VM_GUARD_LANE_FILE contains no valid test file');
    Object.assign(out.test, { ...fast, include: files, exclude, setupFiles, provide: provide(mode) });
    return out;
  }
  const quarantined = ignoreQ ? [] : readQuarantine(root, mode, quarantineFile, { include, exclude });
  if (!quarantined.length && !g.alwaysProjects) {
    // no quarantine: no projects at all - a single inline project measurably costs CPU (~4 % on heavy)
    Object.assign(out.test, { ...fast, include, exclude, setupFiles, provide: provide(mode) });
    return out;
  }
  if (mode === 'vm') out.test.vmMemoryLimit = fast.vmMemoryLimit; // read from the root config only
  out.test.projects = [{ extends: true, test: { name: `vm-guard:${mode}`, ...fast, include, exclude: [...exclude, ...quarantined], setupFiles, provide: provide(mode) } }];
  if (quarantined.length) out.test.projects.push({ extends: true, test: { name: 'vm-guard:isolated', pool: 'forks', isolate: true, include: quarantined, exclude, setupFiles: isoSetup, provide: provide('isolated') } });
  return out;
}

export { VmGuardSequencer };
