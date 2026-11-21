// vto engine: the core used by every front end (CLI without daemon, MCP server, daemon).
// It owns the map (MapStore), the selection, the lanes (warm Vitest child processes) and the runs
// (event stream, failures, live coverage, metrics). Stateless use = create, call, close: all state
// lives in .vto/ on disk. The daemon keeps one Engine alive (warm lanes, fix loop, subscribers).
//
// The class is assembled from cohesive modules (REVIEW-2-architecture A-8):
//   lock.mjs     engine.lock (one engine per .vto/)
//   lanes.mjs    lanes, pool, worker budget, test file list
//   runner.mjs   runs: start/queue/execute, failures, map patch, fix loop
//   events.mjs   publish, run log, progress, live coverage
//   queries.mjs  coverage / why_failed queries
//   tasks.mjs    task queue
//   store.mjs    the map (MapStore);  select.mjs  affected-test selection
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { MapStore } from './store.mjs';
import { Scanner } from './scan.mjs';
import { select, selectionCount } from './select.mjs';
import { page } from './format.mjs';
import { redactDeep } from './redact.mjs';
import os from 'node:os';
import { canonicalRoot, samePath } from './paths.mjs';
import { StateDir, appendPrivate, readPrivate } from './safefs.mjs';
import { trackedBelow } from './git.mjs';
import { logField } from './ipc.mjs';
import { POOLS } from './lanes.mjs';
import { Metrics } from './metrics.mjs';
import * as analysis from './analysis.mjs';
import { userError } from './errors.mjs';
import { isVitestProject, findConfig } from './project.mjs';
import { LockMixin } from './lock.mjs';
import { LanesMixin } from './lanes.mjs';
import { RunnerMixin } from './runner.mjs';
import { EventsMixin } from './events.mjs';
import { QueriesMixin } from './queries.mjs';
import { TasksMixin } from './tasks.mjs';

export const API_VERSION = 'vto/1';

export const DEFAULT_CONFIG = { pool: 'config', fixLoop: true, idleMinutes: 30, coverageCap: 3 };

/**
 * User-level configuration, outside every repository (SECURITY N9): $XDG_CONFIG_HOME/vto/config.json
 * (%APPDATA%\\vto\\config.json on Windows): { ...defaults, projects: { "<canonical root>": {...} } }.
 * It wins over the project's .vto/config.json, so a repository cannot widen what the user restricted
 * (mcpAllowRuns) or choose the pool against the user's setting.
 */
export function userConfig(root, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const base = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming')) : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(base, 'vto', 'config.json'), 'utf8')); } catch { return {}; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const { projects, ...defaults } = j;
  const mine = projects && typeof projects === 'object' ? Object.entries(projects).find(([k]) => samePath(k, root, true))?.[1] : null;
  return { ...defaults, ...(mine && typeof mine === 'object' ? mine : {}) };
}

export class Engine extends EventEmitter {
  constructor(root, { mode = 'stateless', log, config = {} } = {}) {
    super();
    this.setMaxListeners(100);
    // D2.1: the canonical (realpath) root, whatever spelling the caller used (symlink, junction, subst, case)
    this.root = canonicalRoot(root);
    this.mode = mode;
    this.dir = path.join(this.root, '.vto');
    /** every write below .vto/ is checked: no symlink is followed, directories 0700, files 0600 (N5, F11) */
    this.sd = new StateDir(this.root, '.vto');
    this.log = log || ((m) => { try { appendPrivate(this.sd.file('engine.log'), `${new Date().toISOString()} ${logField(m, 4000)}\n`); } catch {} });
    this.store = new MapStore(this.root, this.dir, { stateDir: this.sd });
    this.scanner = new Scanner();
    this.lanes = new Map();
    this.runs = new Map();
    this.queue = Promise.resolve();
    this.active = null;
    this.coverageSubs = 0;
    this.config = config;
    this.startedAt = Date.now();
  }

  async init() {
    // never create .vto/ in a directory that is not a Vitest project (e.g. the vto sources themselves)
    if (this.config.requireVitest !== false && !isVitestProject(this.root)) throw userError(`${this.root} is not a Vitest project (no vitest in package.json/node_modules and no vitest/vite config)`);
    await this.checkStateDir();
    try { fs.writeFileSync(path.join(this.dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); } catch {}
    let fileCfg = {};
    try { fileCfg = JSON.parse(readPrivate(path.join(this.dir, 'config.json')).toString('utf8')); } catch {}
    if (!fileCfg || typeof fileCfg !== 'object' || Array.isArray(fileCfg)) fileCfg = {};
    // precedence: defaults < VTO_POOL < project .vto/config.json < user-level config < programmatic.
    // U-6: the default pool is the PROJECT's configured pool ("config"): vto never switches the pool
    // (vm-guard vm/shared, auto groups) unless the user configured it.
    this.config = { ...DEFAULT_CONFIG, ...(process.env.VTO_POOL ? { pool: process.env.VTO_POOL } : {}), ...fileCfg, ...userConfig(this.root), ...this.config };
    if (!POOLS.has(this.config.pool)) throw userError(`unknown pool "${String(this.config.pool).slice(0, 40)}" (use one of: ${[...POOLS].join(', ')})`);
    this.lockFile = path.join(this.dir, 'engine.lock');
    this.acquireLock();
    this.store.load();
    this.metrics = new Metrics(this.dir, this.sd);
    return this;
  }

  /**
   * .vto/ must be a real directory that the repository does not ship (N5): a committed .vto/ (state,
   * config.json, symlinks) would let a PR or a cloned repository steer the daemon and redirect its writes.
   */
  async checkStateDir() {
    try { this.sd.dir(); } catch (e) { throw userError(e.message); }
    const links = this.sd.symlinks();
    if (links.length) throw userError(`vto: symbolic link inside .vto/ (${links.slice(0, 3).map((l) => path.relative(this.root, l)).join(', ')}) – refusing to use this state directory; delete .vto/ and run again`);
    const tracked = await trackedBelow(this.root, '.vto');
    if (tracked?.length) throw userError(`vto: .vto/ is tracked by git (${tracked.slice(0, 3).join(', ')}${tracked.length > 3 ? ', …' : ''}) – it is local state and must not come from the repository; run \`git rm -r --cached .vto\` and delete it`);
    for (const d of ['raw', 'runs', 'map', 'setup', 'blobs']) if (this.sd.exists(d)) this.sd.dir(d);
  }

  // ------------------------------------------------------------------ envelope
  envelope(o, extra = {}) {
    const st = this.store.state;
    return redactDeep({
      v: API_VERSION, ...o,
      // U-6: every answer names the pool the tests run in
      ...(o.pool == null ? { pool: this.poolName() } : {}),
      stale: st.stale.length > 0, ...(st.stale.length ? { staleReasons: st.stale.slice(0, 3) } : {}),
      mapAgeS: st.updatedAt ? Math.round((Date.now() - Date.parse(st.updatedAt)) / 1000) : null,
      ...extra,
    });
  }

  // ------------------------------------------------------------------ selection
  async affected({ base, diff, limit = 20, cursor } = {}) {
    const sel = await select(this, { base, diff });
    const count = selectionCount(this, sel);
    const files = [...sel.files.keys()].map((f) => this.store.relOf(f)).sort();
    const p = page(files, { limit, cursor });
    this.store.save();
    return this.envelope({
      count, total: sel.total, runAll: sel.runAll, reasons: sel.reasons.slice(0, 5),
      changed: sel.changed.slice(0, 10), ...(sel.changed.length > 10 ? { changedMore: sel.changed.length - 10 } : {}),
      files: p.items, filesTotal: p.total, ...(p.cursor ? { cursor: p.cursor } : {}),
      ...(sel.notes.length ? { notes: sel.notes.slice(0, 3) } : {}),
      ...(sel.newFiles?.length ? { newFiles: sel.newFiles.slice(0, 5) } : {}),
      ...(sel.runAll ? { exit: 3 } : {}), // contracts/DECISIONS.md D3: machine-readable "run all"
    });
  }

  // ------------------------------------------------------------------ status
  status() {
    const st = this.store;
    const lanes = {};
    for (const [n, l] of this.lanes) lanes[n] = l.alive ? 'warm' : 'stopped';
    const lanePids = Object.fromEntries([...this.lanes].filter(([, l]) => l.alive).map(([n, l]) => [n, l.proc.pid]));
    const mem = process.memoryUsage();
    return this.envelope({
      root: this.root, mode: this.mode, pid: process.pid, uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      lanes, lanePids, warm: [...this.lanes.values()].some((l) => l.alive), pool: this.poolName(), vitest: st.state.lane?.vitest,
      map: { tests: st.testCount(), testFiles: st.tests.size, sourceFiles: st.blocks.size, gitHead: st.state.gitHead, fullRunAt: st.state.fullRunAt,
        dirtyTests: Object.keys(st.state.dirtyTests).length, dirtyFiles: Object.keys(st.state.dirtyFiles).length, failing: Object.keys(st.state.failing).length },
      memoryMB: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
      ...(this.active ? { activeRun: { runId: this.active.runId, kind: this.active.kind, done: this.active.counts.pass + this.active.counts.fail + this.active.counts.skip, total: this.active.total } } : {}),
      lastRun: st.state.lastRun,
    });
  }

  // ------------------------------------------------------------------ analysis (scoped queries only)
  testOverlap(p) { return analysis.testOverlap(this, p); }
  slowTests(p) { return analysis.slowTests(this, p); }
  slowImports(p) { return analysis.slowImports(this, p); }
  suggestEnv(p) { return analysis.suggestEnv(this, p); }
  vmGuardStatus(p) { return analysis.vmGuardStatus(this, p); }
  savings(p) { return this.envelope(this.metrics.report(p)); }

  async close() {
    for (const l of this.lanes.values()) await l.close().catch(() => l.kill());
    this.lanes.clear();
    try { this.store.save(); } catch {}
    this.releaseLock();
  }
}
for (const M of [LockMixin, LanesMixin, RunnerMixin, EventsMixin, QueriesMixin, TasksMixin]) {
  for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(Engine.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
}

export { userError, isVitestProject, findConfig };
