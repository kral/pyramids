// Reads the per-worker run logs written by setup.mjs (.vitest-guard/run/w-<pid>-<tid>.jsonl).
import path from 'node:path';
import { safeDir, listStateDir, readStateFile, createStateFile, removeState } from './statefs.mjs';

export function readRunLogs(runDir) {
  const workers = [];
  let names = [];
  names = listStateDir(runDir).filter((n) => n.startsWith('w-') && n.endsWith('.jsonl')); // refuses a linked run/ or logs/
  for (const n of names) {
    const recs = (readStateFile(path.join(runDir, n)) ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const files = new Map();
    for (const r of recs) {
      if (r.t === 'volatile') { (workers.volatile ??= new Set()).add(r.module); continue; }
      const e = files.get(r.file + '#' + r.seq) || { file: r.file, seq: r.seq };
      if (r.t === 'start') Object.assign(e, { mode: r.mode, prev: r.prev, dirty: r.dirty, lane: r.lane });
      if (r.t === 'end') Object.assign(e, { durationMs: r.durationMs, heapStart: r.heapStart, heapEnd: r.heapEnd, pollution: r.pollution, residual: r.residual, selfMs: r.selfMs });
      files.set(r.file + '#' + r.seq, e);
    }
    workers.push({ id: n.slice(2, -6), files: [...files.values()].sort((a, b) => a.seq - b.seq) });
  }
  return workers;
}

export function clearRunLogs(runDir) {
  removeState(runDir, { recursive: true }); // .vitest-guard/run/logs only: state next to it survives; never through a link
}

/** Files that ran before `file` in the same worker (most recent last). */
export function predecessors(workers, file) {
  for (const w of workers) {
    const i = w.files.findIndex((f) => f.file === file);
    if (i >= 0) return w.files.slice(0, i).map((f) => f.file);
  }
  return [];
}

/** .vitest-guard/run/ holds only volatile state: make git ignore all of it (A4). */
export function ensureStateDir(dir) {
  safeDir(dir); // creates .vitest-guard/run 0700; refuses a symlinked / junctioned component
  createStateFile(path.join(dir, '.gitignore'), '# vitest-guard volatile state (run logs, verify and compare records): never commit\n*\n');
}

export function selfTime(workers) {
  let ms = 0, files = 0;
  for (const w of workers) for (const f of w.files) if (typeof f.selfMs === 'number') { ms += f.selfMs; files++; }
  return { ms: Math.round(ms), files, perFileMs: files ? Math.round((ms / files) * 100) / 100 : 0 };
}

export function heapReport(workers, top = 10) {
  const rows = [];
  for (const w of workers) for (const f of w.files) if (f.heapEnd != null) rows.push({ file: f.file, worker: w.id, deltaMB: (f.heapEnd - f.heapStart) / 1048576, endMB: f.heapEnd / 1048576 });
  const byFile = new Map();
  for (const r of rows) { const a = byFile.get(r.file) || []; a.push(r.deltaMB); byFile.set(r.file, a); }
  const leakiest = [...byFile].map(([file, ds]) => ({ file, deltaMB: Math.round((ds.reduce((x, y) => x + y, 0) / ds.length) * 10) / 10 })).sort((a, b) => b.deltaMB - a.deltaMB).slice(0, top);
  const trend = workers.map((w) => { const h = w.files.filter((f) => f.heapEnd != null).map((f) => f.heapEnd / 1048576); return { worker: w.id, files: h.length, firstMB: Math.round(h[0] || 0), lastMB: Math.round(h.at(-1) || 0), maxMB: Math.round(Math.max(0, ...h)) }; });
  return { leakiest, trend };
}
