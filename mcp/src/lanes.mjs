// Lanes: warm Vitest child processes (main | dom+node | fix | clean), pool choice, worker budget, test file list.
// Part of the Engine (src/engine.mjs): methods are installed on Engine.prototype, `this` is the engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { triggerFiles } from './scan.mjs';
import { Lane } from './lane-client.mjs';
import { slash } from './platform.mjs';
import { classify, writeEnvJson, splitWorkers } from './classify.mjs';
import { findConfig } from './project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pools a user can configure (U-6). "config" (default) = whatever the project's Vitest config says:
 * vto does not touch the pool. Everything else is an explicit choice in .vto/config.json, the
 * user-level config or VTO_POOL: vm / shared (vitest-guard), auto (dom → vm, node → forks group lanes),
 * or a raw Vitest pool.
 */
export const POOLS = new Set(['config', 'auto', 'vm', 'shared', 'forks', 'threads', 'vmThreads', 'vmForks']);
const MB = 1048576;
/** default memory budget of all warm lanes together: a quarter of the machine, at most 4 GiB, at least 512 MiB */
export function defaultLaneBudget(totalMem = os.totalmem()) { return { maxWarm: 3, maxRssMB: Math.max(512, Math.min(4096, Math.round(totalMem / MB / 4))) }; }
const EVICT_ORDER = { clean: 0, fix: 1 }; // helper lanes go first, main lanes last


export class LanesMixin {
  // ------------------------------------------------------------------ lanes
  /** group lanes (dom / node) instead of one main lane: pool `auto` unless groups:false */
  groupsEnabled() { return this.config.groups === true || (this.config.groups !== false && this.config.pool === 'auto'); }
  /** the lane(s) of the instrumented main runs */
  mainLaneNames() { return this.groupsEnabled() ? ['dom', 'node'] : ['main']; }
  listLaneName() { return this.mainLaneNames()[0]; }
  groupPool(g) { return (this.config.groupPools || {})[g] || (g === 'dom' ? 'vm' : 'forks'); }

  lane(name = 'main') {
    let l = this.lanes.get(name);
    if (l) return l;
    let pool = this.config.pool;
    const opts = { collectorDir: this.config.collectorDir, configFile: this.config.configFile };
    if (name === 'dom' || name === 'node') {
      pool = this.groupPool(name);
      opts.group = name;
      opts.maxWorkers = this.ensureGroupWorkers()[name] || 1;
      if (name === 'node' && this.config.nodeEnvironment === 'node') opts.environment = 'node';
    }
    opts.pool = pool;
    if (name === 'main' && this.config.maxWorkers) opts.maxWorkers = this.config.maxWorkers;
    if (name === 'fix') opts.maxWorkers = 1;
    if (name === 'clean') { opts.instrument = false; opts.envProbe = false; }
    if ((pool === 'vm' || pool === 'shared') && this.config.wrapVitestGuard !== false) {
      const userConfig = this.config.configFile || findConfig(this.root);
      const vitestGuard = resolveVitestGuard(this.root);
      if (userConfig && vitestGuard) opts.wrapVitestGuard = { userConfig, vitestGuard };
    }
    l = new Lane(name, { root: this.root, rawDir: path.join(this.dir, 'raw', name), opts, log: this.log, stateDir: this.sd });
    this.lanes.set(name, l);
    return l;
  }
  async startLane(name = 'main') {
    const l = this.lane(name);
    const info = await l.start();
    if (this.mainLaneNames()[0] === name) this.recordTriggers(info);
    return info;
  }

  laneGroup(c) {
    if (c.env && !['jsdom', 'happy-dom', 'browser'].includes(c.env)) return 'node';
    return this.config.nodeEnvironment === 'node' && c.group === 'node' ? 'node' : 'dom';
  }

  /** CPU budget = configured maxWorkers or cores-1 (Vitest's run-mode default), split by measured test time */
  ensureGroupWorkers() {
    if (this.groupWorkers) return this.groupWorkers;
    const st = this.store;
    const budget = this.config.maxWorkers || Math.max(1, os.availableParallelism() - 1);
    const ms = { dom: 0, node: 0 };
    for (const [f, c] of classify(this, [...st.tests.keys()])) for (const r of st.tests.get(f).tests.values()) ms[this.laneGroup(c)] += r.durationMs || 1;
    return (this.groupWorkers = splitWorkers(budget, ms));
  }

  /** split explicit specs (or the whole test list) between the group lanes; sets worker budget once */
  async planGroups(specs) {
    const st = this.store;
    let list = specs;
    if (!list) {
      const files = await this.testFileList();
      if (!files) return null;
      list = files.map((f) => ({ file: st.relOf(f) }));
    }
    const cls = classify(this, list.map((s) => st.absOf(s.file)));
    writeEnvJson(this.root, cls, (f) => st.relOf(f), { log: this.log });
    // routing: the node lane gets files whose CONFIGURED environment is node; files that only never touched
    // the DOM (probe dom:false under jsdom/happy-dom) move there only with nodeEnvironment:'node' (their
    // environment is then switched) – measured: jsdom files in forks cost more than in vm (README)
    const out = { dom: [], node: [] };
    for (const s of list) out[this.laneGroup(cls.get(st.absOf(s.file)))].push(s);
    return out;
  }
  recordTriggers(info) {
    const st = this.store.state;
    const files = triggerFiles(this.root, info);
    const t = {};
    for (const f of files) t[f] = this.scanner.read(f)?.sha ?? null;
    // a trigger that changed while no lane ran is detected by select() before this overwrites it
    st.triggers = t;
    st.setupFiles = info.setupFiles;
    st.lane = { pool: info.pool, vitestGuard: info.vitestGuard, vitest: info.vitest, maxWorkers: info.maxWorkers };
    this.store.filesDirty = true;
  }
  async restartLanes(reason) {
    this.log(`restarting lanes: ${reason}`);
    for (const l of this.lanes.values()) await l.close().catch(() => l.kill());
    this.lanes.clear();
  }

  /** Test files on disk (abs). Cached; re-listed by the lane when a test directory's mtime changed. */
  async testFileList() {
    const st = this.store.state;
    const dirs = st.testDirs || {};
    let changed = !st.testFiles;
    for (const d of Object.keys(dirs)) { let m = null; try { m = fs.statSync(d).mtimeMs; } catch {} if (m !== dirs[d]) { changed = true; break; } }
    if (!changed) return st.testFiles;
    try {
      const files = await this.lane(this.listLaneName()).list();
      if (this.lane(this.listLaneName()).info) this.recordTriggersOnce();
      st.testFiles = files;
      const nd = {};
      for (const f of files) for (let d = path.dirname(f); d.length >= this.root.length; d = path.dirname(d)) {
        if (nd[slash(d)] !== undefined) break;
        try { nd[slash(d)] = fs.statSync(d).mtimeMs; } catch {}
        if (slash(d) === this.root) break;
      }
      st.testDirs = nd;
      return files;
    } catch (e) { this.log(`list failed: ${e.message}`); return st.testFiles || null; }
  }
  recordTriggersOnce() { if (!Object.keys(this.store.state.triggers || {}).length) this.recordTriggers(this.lane(this.listLaneName()).info); }

  /** the pool tests run in, for every answer (U-6): the real pool once a lane reported it */
  poolName() {
    if (this.groupsEnabled()) return `dom:${this.groupPool('dom')}+node:${this.groupPool('node')}`;
    const l = this.store.state.lane;
    const actual = l ? (l.vitestGuard ? `vitest-guard:${l.vitestGuard}` : l.pool) : null;
    if (this.config.pool === 'config') return actual ? `${actual} (project config)` : 'project config';
    return actual || this.config.pool;
  }

  // ------------------------------------------------------------------ memory / process budget (A-8)
  laneBudget() { return { ...defaultLaneBudget(), ...(this.config.laneBudget || {}) }; }
  /**
   * Warm lanes are whole Vitest processes (Vite server + worker pool). Keep at most `maxWarm` of them
   * and at most `maxRssMB` of resident memory (measured by each lane after its last run, process tree
   * where the OS allows it); idle lanes are closed until the budget holds – helper lanes (clean, fix)
   * first, then the least recently used. A lane that is running, or listed in `keep`, is never closed.
   * → names of the lanes that were closed
   */
  async enforceLaneBudget(keep = []) {
    const { maxWarm, maxRssMB } = this.laneBudget();
    const hold = new Set(keep);
    const warm = () => [...this.lanes.values()].filter((l) => l.alive);
    const rss = () => warm().reduce((n, l) => n + (l.rssMB || 0), 0);
    const closed = [];
    for (;;) {
      const w = warm();
      if (w.length <= maxWarm && rss() <= maxRssMB) break;
      const idle = w.filter((l) => !l.busy && !hold.has(l.name)).sort((a, b) => (EVICT_ORDER[a.name] ?? 2) - (EVICT_ORDER[b.name] ?? 2) || a.lastUsed - b.lastUsed);
      if (!idle.length) break;
      const l = idle[0];
      this.log(`lane budget: closing idle lane ${l.name} (warm ${w.length}/${maxWarm}, rss ${rss()}/${maxRssMB} MB)`);
      await l.close().catch(() => l.kill());
      this.lanes.delete(l.name);
      closed.push(l.name);
    }
    return closed;
  }

}
function resolveVitestGuard(root) {
  for (const p of [path.join(root, 'node_modules', 'vitest-guard', 'src', 'index.mjs'), path.resolve(here, '../../vitest-guard/src/index.mjs')]) if (fs.existsSync(p)) return p;
  return null;
}
