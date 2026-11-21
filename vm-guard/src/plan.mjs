// Shared-mode scheduler: conflict graph -> greedy colouring into <= lanes groups balanced by duration,
// order inside a group (victims first, polluters last). Each lane later runs as ONE shared worker.
import fs from 'node:fs';
import path from 'node:path';
import { scanFile, scanSource, isStatefulModule } from './scan.mjs';

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
function resolveModule(p) { for (const e of EXTS) { try { if (fs.statSync(p + e).isFile()) return p + e; } catch {} } return null; }

/** vto v2 raw dir -> { durations: {testFile: ms}, modules: {testFile: [abs paths]} } */
export function readVto(rawDir, root) {
  const durations = {}, modules = {};
  let names = [];
  try { names = fs.readdirSync(rawDir).filter((n) => n.endsWith('.jsonl')); } catch { return { durations, modules }; }
  for (const n of names) for (const l of fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const rel = (f) => path.relative(root, f).split(path.sep).join('/');
    if (r.t === 'test' && typeof r.durationMs === 'number') durations[rel(r.file)] = (durations[rel(r.file)] || 0) + r.durationMs;
    if (r.t === 'fileload') { const k = rel(r.testFile); const s = new Set(modules[k] || []); for (const m of r.modules || []) s.add(typeof m === 'string' ? m : m.file); modules[k] = [...s]; }
  }
  return { durations, modules };
}

export function buildGraph({ root, files, history = [], pollution = {}, orderOnly = [], vto = { modules: {} }, srcScan = true, mockEdges = false }) {
  const scans = new Map(files.map((f) => [f, scanFile(path.join(root, f))]));
  const modCache = new Map();
  const modInfo = (abs) => {
    if (modCache.has(abs)) return modCache.get(abs);
    let info = { stateful: false, imports: [] };
    try { const src = fs.readFileSync(abs, 'utf8'); const sc = scanSource(src, abs); info = { stateful: isStatefulModule(src), imports: sc.imports }; } catch {}
    modCache.set(abs, info);
    return info;
  };
  // modules (project sources) per test file: vto fileload if present, else direct relative imports of the test file
  // transitive project-module graph (static relative imports), used when no vto fileload data exists
  const relCache = new Map();
  const relOf = (abs) => { if (!relCache.has(abs)) { let r = []; try { r = scanSource(fs.readFileSync(abs, 'utf8'), abs).relImports.map(resolveModule).filter(Boolean); } catch {} relCache.set(abs, r); } return relCache.get(abs); };
  const closure = (starts) => { const seen = new Set(); const st = [...starts]; while (st.length) { const m = st.pop(); if (seen.has(m)) continue; seen.add(m); st.push(...relOf(m)); } return [...seen]; };
  const modsOf = new Map();
  for (const f of files) {
    const fromVto = vto.modules[f];
    const list = fromVto || (srcScan ? closure(scans.get(f).relImports.map(resolveModule).filter(Boolean)) : []);
    modsOf.set(f, list.filter((m) => !/\.(test|spec)\./.test(m)));
  }
  const pkgsOf = new Map(files.map((f) => { const s = new Set(scans.get(f).imports); for (const m of modsOf.get(f)) for (const p of modInfo(m).imports) s.add(p); return [f, s]; }));
  const statefulOf = new Map(files.map((f) => [f, new Set(modsOf.get(f).filter((m) => modInfo(m).stateful))]));

  const hard = new Map(files.map((f) => [f, new Map()]));
  const soft = new Map(files.map((f) => [f, new Map()]));
  const addEdge = (g, a, b, why) => { if (a === b || !g.has(a) || !g.has(b)) return; g.get(a).set(b, why); g.get(b).set(a, why); };
  const edges = [];
  const hardEdge = (a, b, why) => { if (a !== b && hard.has(a) && hard.has(b) && !hard.get(a).has(b)) { addEdge(hard, a, b, why); edges.push({ a, b, why, hard: true }); } };

  for (const e of history) hardEdge(e.a, e.b, `history: ${e.signature || 'shared-only failure'}`);
  // node_modules mocks leak into later files of the same worker (repro shared/p_mocknm -> v_mocknm)
  const mockers = files.flatMap((f) => scans.get(f).mocks.filter((m) => m.bare).map((m) => [f, m.pkg]));
  for (const [a, pkg] of mockers) for (const b of files) if (pkgsOf.get(b).has(pkg)) hardEdge(a, b, `vi.mock('${pkg}') vs import`);
  // same module mocked with different factories
  const byTarget = new Map();
  for (const f of files) for (const m of scans.get(f).mocks) { const a = byTarget.get(m.target) || []; a.push([f, m.factory]); byTarget.set(m.target, a); }
  for (const [target, list] of byTarget) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[i][1] !== list[j][1]) hardEdge(list[i][0], list[j][0], `conflicting vi.mock(${path.basename(target)})`);
  // without resetModules (shared mode), vi.mock of a project module only reaches files that import it
  // directly: a cached importer keeps whichever binding (real or mocked) it got first. Then a file that
  // mocks M conflicts with every file whose module graph reaches M without the same mock.
  if (mockEdges) {
    // Every file's factory creates its own mock instances, so even identical vi.mock() calls conflict once a
    // cached project module (not the test itself) holds the first file's binding. Edge: a mocks M, and b
    // reaches M through another project module, or imports M without mocking it.
    const strip = (m) => m.replace(/\.(m?[jt]sx?)$/, '').replace(/\/index$/, '');
    const reachesVia = (b, M) => modsOf.get(b).some((x) => strip(x) !== M && relOf(x).some((y) => strip(y) === M));
    for (const a of files) for (const m of scans.get(a).mocks.filter((x) => !x.bare)) {
      const M = strip(m.target);
      for (const b of files) {
        if (b === a || !modsOf.get(b).some((x) => strip(x) === M)) continue;
        const bMocks = scans.get(b).mocks.some((x) => strip(x.target) === M);
        if (!bMocks || reachesVia(b, M) || reachesVia(a, M)) hardEdge(a, b, `vi.mock(${path.basename(M)}): cached importer keeps the first binding`);
      }
    }
  }
  // runtime pollution of node_modules singletons that the reset hooks cannot undo
  for (const [a, kinds] of Object.entries(pollution)) for (const k of kinds) {
    const pkg = k.startsWith('singleton:') ? k.slice(10) : null;
    if (pkg) for (const b of files) if (pkgsOf.get(b).has(pkg)) hardEdge(a, b, `pollutes ${pkg}`);
  }
  // soft: share a project module with module-level mutable state
  const byStateful = new Map();
  for (const f of files) for (const m of statefulOf.get(f)) { const a = byStateful.get(m) || []; a.push(f); byStateful.set(m, a); }
  for (const [m, list] of byStateful) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { addEdge(soft, list[i], list[j], `stateful ${path.basename(m)}`); }

  const polluters = new Set([...files.filter((f) => scans.get(f).pollutes.length || scans.get(f).mitigated.length), ...Object.keys(pollution), ...orderOnly, ...history.map((e) => e.a)]);
  const victims = new Set(history.map((e) => e.b));
  return { files, scans, hard, soft, edges, polluters, victims, statefulOf };
}

// softPenalty: one shared stateful module in a lane costs this fraction of the ideal lane load, so
// separating soft conflicts beats perfect balance but never isolates anything
export function planLanes(graph, { lanes = 2, durations = {}, isolated = [], softPenalty = 0.25 } = {}) {
  const known = Object.values(durations).filter((x) => x > 0).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 100;
  const dur = (f) => durations[f] ?? fallback;
  const iso = new Set(isolated);
  const L = Array.from({ length: lanes }, () => ({ files: [], load: 0 }));
  const order = graph.files.filter((f) => !iso.has(f)).sort((a, b) => dur(b) - dur(a) || a.localeCompare(b));
  const target = order.reduce((s, f) => s + dur(f), 0) / Math.max(1, lanes);
  for (const f of order) {
    let best = null, bestCost = Infinity;
    for (const lane of L) {
      if (lane.files.some((g) => graph.hard.get(f).has(g))) continue;
      const softN = lane.files.filter((g) => graph.soft.get(f).has(g)).length;
      const cost = lane.load + softN * softPenalty * target;
      if (cost < bestCost) { bestCost = cost; best = lane; }
    }
    if (!best) { iso.add(f); continue; }
    best.files.push(f); best.load += dur(f);
  }
  const rank = (f) => (graph.victims.has(f) ? 0 : graph.polluters.has(f) ? 2 : 1);
  for (const lane of L) lane.files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { lanes: L.filter((l) => l.files.length).map((l) => ({ files: l.files, estMs: Math.round(l.load) })), isolated: [...iso].sort() };
}
