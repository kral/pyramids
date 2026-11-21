// Scoped analysis queries over the analyzer report (never the whole report: ~220k tokens at 3k tests).
// The report is regenerated lazily when the map generation changed.
import fs from 'node:fs';
import path from 'node:path';
import * as analyzer from './analyzer.mjs';
import { page } from './format.mjs';

let cache = { gen: -1, report: null, at: 0, pending: null };

async function getReport(eng) {
  if (!eng.store.hasMap()) return null;
  if (cache.root === eng.root && cache.gen === eng.store.generation && cache.report) return cache.report;
  if (cache.pending) return cache.pending;
  const out = path.join(eng.dir, 'report');
  cache.pending = (async () => {
    eng.store.save();
    const t0 = Date.now();
    const r = await analyzer.report(eng.root, eng.store.mapDir, out);
    cache = { root: eng.root, gen: eng.store.generation, report: r, ms: Date.now() - t0, pending: null };
    return r;
  })().finally(() => { cache.pending = null; });
  return cache.pending;
}

const inScope = (id, { file, test }) => (!file || id.startsWith(file)) && (!test || id === test || id.startsWith(test));

export async function testOverlap(eng, { file, test, limit = 5, cursor } = {}) {
  const r = await getReport(eng);
  if (!r) return eng.envelope({ note: 'no map yet' });
  const items = [];
  const scope = { file, test };
  for (const g of r.identical) if (g.tests.some((t) => inScope(t, scope))) items.push({ tier: g.tier, tests: g.tests.slice(0, 3), size: g.tests.length });
  for (const s of r.subsumed) if (inScope(s.test, scope)) items.push({ tier: 'subset', test: s.test, coveredBy: s.by.slice(0, 1), coveredByCount: s.byCount });
  for (const n of r.nearDuplicates) if (inScope(n.a, scope) || inScope(n.b, scope)) items.push({ tier: 'near', a: n.a, b: n.b, jaccard: n.jaccard });
  const p = page(items, { limit, cursor });
  return eng.envelope({ scope: file || test || 'all', candidates: p.items, total: p.total, ...(p.cursor ? { cursor: p.cursor } : {}),
    note: 'candidates for review, not verdicts (vto verify confirms by mutation)' });
}

export async function slowTests(eng, { limit = 10, cursor, file } = {}) {
  const r = await getReport(eng);
  if (!r) return eng.envelope({ note: 'no map yet' });
  const all = r.tests.filter((t) => !t.excluded && t.unique === 0 && t.durationMs != null && (!file || t.file.startsWith(file))).sort((a, b) => b.durationMs - a.durationMs);
  const totalMs = all.reduce((s, t) => s + t.durationMs, 0);
  const p = page(all.map((t) => ({ id: t.id, ms: Math.round(t.durationMs * 10) / 10, blocks: t.items })), { limit, cursor });
  return eng.envelope({ withoutUniqueCoverage: p.total, totalMs: Math.round(totalMs), tests: p.items, ...(p.cursor ? { cursor: p.cursor } : {}) });
}

/** Heaviest modules: Σ own evaluation time (fileload.loadMs) over the test files that load them (from the map). */
export async function slowImports(eng, { file, limit = 10, cursor } = {}) {
  const agg = new Map();
  for (const e of eng.store.tests.values()) {
    const lm = e.fileload?.loadMs || {};
    for (const [m, ms] of Object.entries(lm)) { const a = agg.get(m) || { ms: 0, n: 0 }; a.ms += ms; a.n++; agg.set(m, a); }
  }
  const rows = [...agg].map(([m, a]) => ({ module: eng.store.relOf(m), loadMsTotal: Math.round(a.ms), loadedBy: a.n, perLoadMs: Math.round((a.ms / a.n) * 10) / 10 })).sort((x, y) => y.loadMsTotal - x.loadMsTotal);
  const p = page(rows, { limit, cursor });
  const out = { modules: p.items, total: p.total, ...(p.cursor ? { cursor: p.cursor } : {}), note: 'own (exclusive) evaluation time of project modules, summed over loading test files' };
  if (file) {
    const r = await getReport(eng).catch(() => null);
    const tf = r?.unusedImports?.testFiles.find((t) => t.testFile === file);
    out.file = file;
    out.unusedImports = tf ? tf.unused.slice(0, 20) : [];
    out.loaded = tf?.loaded ?? eng.store.tests.get(eng.store.absOf(file))?.fileload?.modules?.length ?? null;
  }
  return eng.envelope(out);
}

/** Test files whose run never touched a DOM global (collector-ext/setup-env-probe.mjs). */
export function suggestEnv(eng, { file, limit = 20, cursor } = {}) {
  const items = [];
  let probed = 0;
  for (const [tf, e] of eng.store.tests) {
    const rel = eng.store.relOf(tf);
    if (file && !rel.startsWith(file)) continue;
    if (!e.env) continue;
    probed++;
    if (e.env.dom === false && e.env.env && e.env.env !== 'node') {
      const failed = [...e.tests.values()].some((t) => t.state === 'fail');
      if (!failed) items.push({ file: rel, env: e.env.env, tests: e.tests.size });
    }
  }
  const p = page(items.sort((a, b) => b.tests - a.tests), { limit, cursor });
  return eng.envelope({ candidates: p.items, total: p.total, probedFiles: probed, ...(p.cursor ? { cursor: p.cursor } : {}),
    note: probed ? 'never accessed document/window/DOM globals after setup files: candidates for `// @vitest-environment node` (verify by running them in node)' : 'no env probe data yet: run tests through vto once' });
}

export function vmGuardStatus(eng) {
  const dir = path.join(eng.root, '.vm-guard');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const q = read('incompatible.json') || {};
  const conflicts = read('conflicts.json');
  let dirty = 0, files = 0, last = null;
  // run logs: .vm-guard/run/logs/*.jsonl (vm-guard ≥ 2d7ddf9) and the older .vm-guard/run/*.jsonl
  const logFiles = [];
  for (const d of [path.join(dir, 'run', 'logs'), path.join(dir, 'run')]) {
    try { for (const n of fs.readdirSync(d)) if (n.endsWith('.jsonl')) logFiles.push(path.join(d, n)); } catch {}
  }
  try {
    for (const p of logFiles) {
      const st = fs.statSync(p); if (!last || st.mtimeMs > last) last = st.mtimeMs;
      for (const l of fs.readFileSync(p, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.t === 'start') { files++; if (r.dirty) dirty++; } } catch {} }
    }
  } catch {}
  const lane = eng.store.state.lane;
  return eng.envelope({
    enabled: !!lane?.vmGuard, mode: lane?.vmGuard || null, pool: lane?.pool || null,
    quarantined: { vm: Object.keys(q.vm || {}).slice(0, 20), shared: Object.keys(q.shared || {}).slice(0, 20), vmCount: Object.keys(q.vm || {}).length, sharedCount: Object.keys(q.shared || {}).length },
    conflicts: conflicts ? (Array.isArray(conflicts) ? conflicts.length : Object.keys(conflicts).length) : 0,
    lastRun: last ? new Date(last).toISOString() : null, filesLogged: files, dirtyStarts: dirty,
    ...(dirty ? { hint: 'some files started with state left by a previous file (see the vm-guard README, check command, for quarantine)' } : {}),
  });
}
