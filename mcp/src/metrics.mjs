// Local, append-only metrics log (.vto/metrics.jsonl). Nothing leaves the machine.
// Formulas: mcp/SAVINGS.md. Every number in a report says whether it is measured or estimated.
import fs from 'node:fs';
import path from 'node:path';
import { StateDir, appendPrivate } from './safefs.mjs';

const DAY = 86400e3;

export class Metrics {
  constructor(dir, stateDir) { this.file = path.join(dir, 'metrics.jsonl'); this.sd = stateDir || new StateDir(path.dirname(path.resolve(dir)), path.basename(dir)); }
  // N5/F11: never through a symlink, 0600
  append(o) { try { this.sd.dir(); appendPrivate(this.file, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch {} }
  read() {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  }
  recordRun(eng, run) {
    if (!run.startedAt) return;
    const ran = run.counts.pass + run.counts.fail + run.counts.skip;
    this.append({
      t: 'run', runId: run.runId, kind: run.kind, mode: eng.mode, pool: run.pool || eng.poolName(), instrumented: run.instrumented, status: run.status,
      testsRun: ran, suiteTotal: Math.max(eng.store.testCount(), ran), filesRun: run.files, suiteFiles: eng.store.state.testFiles?.length || eng.store.tests.size,
      wallMs: run.ms ?? null, cpuMs: run.cpuMs ?? null, failed: run.counts.fail, ttffMs: run.firstFailureMs ?? null,
      testMsSum: run.testMsSum ?? null, classic: run.classic || null, ci: !!process.env.CI,
    });
  }
  recordTokens(tool, tokens, runId) { this.append({ t: 'tokens', tool, tokens, ...(runId ? { runId } : {}) }); }

  /** Aggregation (SAVINGS.md §2). */
  report({ since = '30d' } = {}) {
    const all = this.read();
    const from = Date.now() - parseSince(since);
    const runs = all.filter((r) => r.t === 'run' && Date.parse(r.at) >= from && r.status === 'done');
    const allFull = all.filter((r) => r.t === 'run' && r.status === 'done' && isFull(r));
    const tokByRun = new Map();
    let tokTotal = 0;
    for (const t of all) if (t.t === 'tokens' && Date.parse(t.at) >= from) { tokTotal += t.tokens; if (t.runId) tokByRun.set(t.runId, (tokByRun.get(t.runId) || 0) + t.tokens); }
    const lastFull = (pool, at) => { let best = null; for (const f of allFull) if (f.pool === pool && (!best || f.at > best.at)) best = f; return best; };
    const baselinePool = (p) => p === 'forks' || p === 'threads';
    const out = {
      since, runs: runs.length, fullRuns: runs.filter(isFull).length, partialRuns: 0, fullRunsAvoided: 0,
      wallSavedMs: 0, cpuSavedMs: 0, wallSavedVsForksMs: 0, cpuSavedVsForksMs: 0, testMinutesSaved: 0,
      tokens: { returned: tokTotal, classicDefault: 0, classicMinimal: 0, classicVerbose: 0, runsMeasured: 0 },
      ttffGainedMs: 0, ttffRuns: 0, estimated: { wall: 0, cpu: 0 }, measured: { wall: 0, cpu: 0 }, perPool: {},
    };
    for (const r of runs) {
      if (isFull(r)) continue;
      out.partialRuns++; out.fullRunsAvoided++;
      const cf = lastFull(r.pool);
      let cfWall, cfCpu, est = false;
      if (cf) { cfWall = cf.wallMs; cfCpu = cf.cpuMs; }
      else if (r.testsRun) { cfWall = r.wallMs * r.suiteTotal / r.testsRun; cfCpu = r.cpuMs != null ? r.cpuMs * r.suiteTotal / r.testsRun : null; est = true; }
      if (cfWall != null && r.wallMs != null) { out.wallSavedMs += Math.max(0, cfWall - r.wallMs); est ? out.estimated.wall++ : out.measured.wall++; }
      if (cfCpu != null && r.cpuMs != null) { out.cpuSavedMs += Math.max(0, cfCpu - r.cpuMs); est ? out.estimated.cpu++ : out.measured.cpu++; }
      const fk = lastFull('forks');
      if (fk && !baselinePool(r.pool)) { out.wallSavedVsForksMs += Math.max(0, fk.wallMs - r.wallMs); if (fk.cpuMs != null && r.cpuMs != null) out.cpuSavedVsForksMs += Math.max(0, fk.cpuMs - r.cpuMs); }
      else if (fk) { out.wallSavedVsForksMs += Math.max(0, fk.wallMs - r.wallMs); }
      const meanTestMs = cf?.testMsSum && cf.testsRun ? cf.testMsSum / cf.testsRun : null;
      if (meanTestMs != null) out.testMinutesSaved += ((r.suiteTotal - r.testsRun) * meanTestMs) / 60000;
      if (r.failed && r.ttffMs != null && cfWall != null) { out.ttffGainedMs += Math.max(0, cfWall - r.ttffMs); out.ttffRuns++; }
      if (cf?.classic && r.classic) {
        out.tokens.runsMeasured++;
        for (const k of ['default', 'minimal', 'verbose']) {
          const a = cf.classic[k], b = r.classic[k];
          if (!a || !b) continue;
          // full-suite output with this run's failures: everything before the end section of the full run + this run's end section
          const chars = a.chars - a.endChars + b.endChars;
          out.tokens['classic' + k[0].toUpperCase() + k.slice(1)] += Math.ceil(chars / 4);
        }
      }
      const pp = (out.perPool[r.pool] ||= { runs: 0, lastFull: cf ? { wallMs: cf.wallMs, cpuMs: cf.cpuMs, at: cf.at, tests: cf.testsRun } : null });
      pp.runs++;
    }
    out.tokens.saved = { vsDefault: out.tokens.classicDefault - out.tokens.returned, vsMinimal: out.tokens.classicMinimal - out.tokens.returned, vsVerbose: out.tokens.classicVerbose - out.tokens.returned };
    out.cpuHoursSaved = round(out.cpuSavedMs / 3600e3, 3);
    out.wallHoursSaved = round(out.wallSavedMs / 3600e3, 3);
    out.testMinutesSaved = round(out.testMinutesSaved, 1);
    out.formulas = 'see mcp/SAVINGS.md';
    return out;
  }

  /** CI summary for one pipeline run (vto ci-report). */
  ciSummary(run, eng) {
    const all = this.read();
    let fk = null, same = null;
    for (const r of all) if (r.t === 'run' && r.status === 'done' && isFull(r)) { if (r.pool === 'forks') fk = r; if (r.pool === run.pool) same = r; }
    const base = same || fk;
    return {
      v: 'vto-ci/1', at: new Date().toISOString(), runId: run.runId, kind: run.kind, pool: run.pool, runAll: !!run.runAll,
      durationMs: run.ms, cpuMs: run.cpuMs ?? null, selected: run.counts.pass + run.counts.fail + run.counts.skip, total: eng.store.testCount(),
      failed: run.counts.fail, baseline: base ? { pool: base.pool, durationMs: base.wallMs, cpuMs: base.cpuMs, measuredAt: base.at, measured: true } : null,
      savedMs: base && run.ms != null ? Math.max(0, base.wallMs - run.ms) : null,
      savedCpuMs: base?.cpuMs != null && run.cpuMs != null ? Math.max(0, base.cpuMs - run.cpuMs) : null,
    };
  }
}

const isFull = (r) => r.kind === 'full' && r.suiteTotal && r.testsRun >= 0.95 * r.suiteTotal;
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
export function parseSince(s) {
  const m = /^(\d+)\s*([dhm])$/.exec(String(s));
  if (!m) return 30 * DAY;
  return +m[1] * (m[2] === 'd' ? DAY : m[2] === 'h' ? 3600e3 : 60e3);
}
