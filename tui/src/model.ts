// Event → state reducer. Deliberately mutable (O(1) per event, no copying of 10k-element
// structures); every change bumps `version`, which is what the React layer subscribes to.
// Pure selectors that turn this state into rows / header numbers live in view.ts.
import type { Frame, RunEndEvent, VtoEvent } from './events.js';
import { fileOfTestId } from './events.js';

export type FixState = 'none' | 'pending' | 'fixed' | 'still-failing';

export interface FailureItem {
  id: string;
  /** original id when sanitising changed it (only for requests to the daemon) */
  rawId?: string;
  seq: number;
  file: string;
  line: number;
  message: string;
  diff?: string;
  frames: Frame[];
  groupKey: string;
  coveredChanged: string[];
  project?: string;
  fix: FixState;
  /** local ms timestamp of arrival (for "x s ago" and e2e assertions) */
  at: number;
  fixedAt?: number;
}

export interface GroupItem {
  key: string;
  firstSeq: number;
  /** first line of the first failure's message */
  title: string;
  ids: string[];
}

export interface ProjectStats {
  name: string;
  /** exact when the daemon sends run-start.projects, otherwise undefined */
  total?: number;
  filesTotal?: number;
  filesStarted: number;
  done: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface RunState {
  runId: string;
  kind: string;
  pool?: string;
  total: number;
  files: number;
  filesStarted: number;
  startedAt: number;
  passed: number;
  failed: number;
  skipped: number;
  /** from the last progress event (authoritative when ahead of local counts) */
  progressDone: number;
  progressFailed: number;
  etaMs?: number;
  etaAt?: number;
  projects: Map<string, ProjectStats>;
  fileProject: Map<string, string>;
  seen: Map<string, 'pass' | 'fail' | 'skip'>;
  failures: Map<string, FailureItem>;
  groups: Map<string, GroupItem>;
  /** group keys in order of first appearance – stable, append-only (selection never jumps) */
  groupOrder: string[];
  end?: RunEndEvent & { at: number };
  /** count of fix-rerun events (incl. still failing) */
  fixReruns: number;
  /**
   * A `rerun_failed` run (kind "failed") is an overlay: its results are mapped back onto the
   * failures of the run it re-runs (pass → fixed, fail → still failing) and the UI stays on the
   * base run instead of jumping to a 3-test run.
   */
  overlayOf?: string;
}

/**
 * Where a failure "is": the assertion line inside the test file (a frame in the test file, else
 * failure.file:line – which may be the `it(` line) and the first project frame outside the test
 * file (usually the place to fix). Works for both the daemon's and the mock's frame conventions.
 */
export function failingLocation(f: { file: string; line: number; frames?: Frame[] }): Frame {
  const inTest = f.frames?.filter((x) => x.file === f.file) ?? [];
  return inTest.find((x) => x.line === f.line) ?? inTest[0] ?? { file: f.file, line: f.line };
}
export function projectFrame(f: { file: string; frames?: Frame[] }): Frame | undefined {
  return f.frames?.find((x) => x.file !== f.file);
}

export interface StoreOptions { now?: () => number; pinnedRunId?: string }

/** Normalised error text → stable group key when the daemon did not send `group`. */
export function fallbackGroupKey(message: string): string {
  const norm = (message.split('\n')[0] ?? '')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/(["'`]).*?\1/g, 'S')
    .trim();
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'm-' + (h >>> 0).toString(16);
}

function newRun(runId: string, now: number): RunState {
  return {
    runId, kind: 'tests', total: 0, files: 0, filesStarted: 0, startedAt: now,
    passed: 0, failed: 0, skipped: 0, progressDone: 0, progressFailed: 0,
    projects: new Map(), fileProject: new Map(), seen: new Map(), failures: new Map(), groups: new Map(),
    groupOrder: [], fixReruns: 0,
  };
}

export class RunStore {
  runs = new Map<string, RunState>();
  runOrder: string[] = [];
  currentId: string | null = null;
  version = 0;
  eventsApplied = 0;
  private now: () => number;
  private pinned?: string;
  private listeners = new Set<() => void>();

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.pinned = opts.pinnedRunId;
  }

  get current(): RunState | null { return this.currentId ? this.runs.get(this.currentId) ?? null : null; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const l of this.listeners) l(); }

  private run(runId: string): RunState {
    let r = this.runs.get(runId);
    if (!r) {
      r = newRun(runId, this.now());
      this.runs.set(runId, r);
      this.runOrder.push(runId);
      if (!this.pinned || this.pinned === runId) this.currentId = runId;
      else if (!this.currentId) this.currentId = runId;
    }
    return r;
  }

  private project(r: RunState, name: string): ProjectStats {
    let p = r.projects.get(name);
    if (!p) { p = { name, filesStarted: 0, done: 0, passed: 0, failed: 0, skipped: 0 }; r.projects.set(name, p); }
    return p;
  }

  /** Apply a batch and notify subscribers once. */
  applyMany(evs: readonly VtoEvent[]): void {
    if (!evs.length) return;
    for (const e of evs) this.applyOne(e);
    this.version++;
    this.emit();
  }
  apply(ev: VtoEvent): void { this.applyMany([ev]); }

  /** Local state change (e.g. a rerun request was sent) – not from the stream. */
  markPending(runId: string, ids: string[]): void {
    const r = this.runs.get(runId);
    if (!r) return;
    let changed = false;
    for (const id of ids) {
      const f = r.failures.get(id);
      if (f && f.fix !== 'fixed') { f.fix = 'pending'; changed = true; }
    }
    if (changed) { this.version++; this.emit(); }
  }

  private overlayFailure(r: RunState, id: string): FailureItem | undefined {
    return r.overlayOf ? this.runs.get(r.overlayOf)?.failures.get(id) : undefined;
  }

  /** A rerun request failed: back from "pending" to "failed". */
  clearPending(runId: string, ids: string[]): void {
    const r = this.runs.get(runId);
    if (!r) return;
    for (const id of ids) { const f = r.failures.get(id); if (f?.fix === 'pending') f.fix = 'none'; }
    this.version++; this.emit();
  }

  private applyOne(e: VtoEvent): void {
    this.eventsApplied++;
    const now = this.now();
    switch (e.ev) {
      case 'run-start': {
        const isNew = !this.runs.has(e.runId);
        const base = this.currentId ? this.runs.get(this.currentId) : undefined;
        const r = this.run(e.runId);
        if (e.kind === 'failed' && base && base !== r && !base.overlayOf) {
          r.overlayOf = base.runId;
          if (isNew && this.currentId === r.runId) this.currentId = base.runId;
        }
        r.kind = e.kind; r.pool = e.pool; r.total = e.total; r.files = e.files; r.startedAt = now;
        if (e.projects) {
          for (const [name, v] of Object.entries(e.projects)) {
            const p = this.project(r, name);
            p.total = v.total; p.filesTotal = v.files;
          }
        }
        if (!r.overlayOf && (!this.pinned || this.pinned === e.runId)) this.currentId = e.runId;
        return;
      }
      case 'file-start': {
        const r = this.run(e.runId);
        const name = e.project || 'default';
        if (!r.fileProject.has(e.file)) {
          r.fileProject.set(e.file, name);
          r.filesStarted++;
          this.project(r, name).filesStarted++;
        }
        return;
      }
      case 'test': {
        const r = this.run(e.runId);
        const prev = r.seen.get(e.id);
        if (prev === e.state) return; // duplicate
        const p = this.project(r, r.fileProject.get(fileOfTestId(e.id)) ?? 'default');
        if (prev) { // retried test changed state: move the count
          r[prevKey(prev)]--; p[prevKey(prev)]--;
        } else { p.done++; }
        r.seen.set(e.id, e.state);
        r[prevKey(e.state)]++; p[prevKey(e.state)]++;
        const bf = this.overlayFailure(r, e.id);
        if (bf && e.state !== 'skip') {
          if (e.state === 'pass') { bf.fix = 'fixed'; bf.fixedAt = now; } else bf.fix = 'still-failing';
        }
        return;
      }
      case 'failure': {
        const r = this.run(e.runId);
        const bf = this.overlayFailure(r, e.id);
        if (bf) { // newest error of a re-run test replaces the old one (position/group stay)
          bf.fix = 'still-failing'; bf.message = e.message; bf.diff = e.diff; bf.frames = e.frames ?? bf.frames; bf.line = e.line || bf.line;
        }
        const groupKey = e.group ?? fallbackGroupKey(e.message);
        const project = r.fileProject.get(e.file) ?? r.fileProject.get(fileOfTestId(e.id));
        const existing = r.failures.get(e.id);
        const item: FailureItem = {
          id: e.id, rawId: e.rawId, seq: e.seq, file: e.file, line: e.line, message: e.message, diff: e.diff,
          frames: e.frames ?? [], groupKey, coveredChanged: e.coveredChanged ?? [], project,
          fix: existing?.fix === 'pending' ? 'pending' : 'none', at: now,
        };
        r.failures.set(e.id, item);
        // a failure without (or before) its `test` event still counts as a failed test
        if (r.seen.get(e.id) !== 'fail') {
          const prev = r.seen.get(e.id);
          const p = this.project(r, project ?? 'default');
          if (prev) { r[prevKey(prev)]--; p[prevKey(prev)]--; } else p.done++;
          r.seen.set(e.id, 'fail'); r.failed++; p.failed++;
        }
        let g = r.groups.get(groupKey);
        if (!g) {
          g = { key: groupKey, firstSeq: e.seq, title: e.message.split('\n')[0] ?? e.message, ids: [] };
          r.groups.set(groupKey, g);
          r.groupOrder.push(groupKey);
        }
        if (existing && existing.groupKey !== groupKey) {
          const og = r.groups.get(existing.groupKey);
          if (og) og.ids = og.ids.filter((x) => x !== e.id);
        }
        if (!g.ids.includes(e.id)) g.ids.push(e.id);
        return;
      }
      case 'progress': {
        const r = this.run(e.runId);
        r.progressDone = Math.max(r.progressDone, e.done);
        r.progressFailed = e.failed;
        if (e.etaMs !== undefined) { r.etaMs = e.etaMs; r.etaAt = now; }
        return;
      }
      case 'fix-rerun': {
        const r = this.run(e.runId);
        r.fixReruns++;
        const f = r.failures.get(e.id);
        if (!f) return;
        if (e.state === 'pass') { f.fix = 'fixed'; f.fixedAt = now; }
        else f.fix = 'still-failing';
        return;
      }
      case 'run-end': {
        const r = this.run(e.runId);
        r.end = { ...e, at: now };
        r.etaMs = 0; r.etaAt = now;
        if (r.overlayOf) { // tests that were requested but never reported go back to "failed"
          for (const f of this.runs.get(r.overlayOf)?.failures.values() ?? []) if (f.fix === 'pending') f.fix = 'none';
        }
        return;
      }
    }
  }
}

function prevKey(s: 'pass' | 'fail' | 'skip'): 'passed' | 'failed' | 'skipped' {
  return s === 'pass' ? 'passed' : s === 'fail' ? 'failed' : 'skipped';
}
