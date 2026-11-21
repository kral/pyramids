// Pure selectors: RunState + UI state → view model (rows, header numbers). Unit-tested.
import type { FailureItem, GroupItem, RunState } from './model.js';

export type FilterMode = 'all' | 'failed' | 'fixed';

export interface UiFilter { mode: FilterMode; text: string }

export type GroupStatus = 'failed' | 'fixed' | 'partial' | 'pending';

export interface Row {
  /** stable key – selection is stored by key, never by index */
  key: string;
  kind: 'group' | 'member';
  groupKey: string;
  /** failure shown in the details pane when this row is selected */
  failureId: string;
  /** group rows: number of member failures (after filter) */
  count: number;
  status: GroupStatus | 'still-failing';
  expanded: boolean;
}

/** Diacritics-insensitive lower-case fold (Czech users type "selhani" for "selhání"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function groupStatus(r: RunState, g: GroupItem): GroupStatus {
  let fixed = 0, pending = 0;
  for (const id of g.ids) {
    const f = r.failures.get(id);
    if (!f) continue;
    if (f.fix === 'fixed') fixed++;
    else if (f.fix === 'pending') pending++;
  }
  if (pending) return 'pending';
  if (fixed === g.ids.length && fixed > 0) return 'fixed';
  if (fixed > 0) return 'partial';
  return 'failed';
}

function memberStatus(f: FailureItem): Row['status'] {
  return f.fix === 'fixed' ? 'fixed' : f.fix === 'pending' ? 'pending' : f.fix === 'still-failing' ? 'still-failing' : 'failed';
}

function passesMode(f: FailureItem, mode: FilterMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'fixed') return f.fix === 'fixed';
  return f.fix !== 'fixed';
}

function matchesText(f: FailureItem, needle: string): boolean {
  if (!needle) return true;
  return fold(`${f.id}\n${f.message}\n${f.file}`).includes(needle);
}

/**
 * Flattened list: one row per group; expanded groups (with >1 member) are followed by member rows.
 * Order = order of first appearance of each group, members in arrival order → append-only while a
 * run streams, so rows above the selection never move.
 */
export function buildRows(r: RunState | null, filter: UiFilter, expanded: ReadonlySet<string>): Row[] {
  if (!r) return [];
  const rows: Row[] = [];
  const needle = fold(filter.text.trim());
  for (const key of r.groupOrder) {
    const g = r.groups.get(key);
    if (!g || g.ids.length === 0) continue;
    const members: FailureItem[] = [];
    for (const id of g.ids) {
      const f = r.failures.get(id);
      if (f && passesMode(f, filter.mode) && matchesText(f, needle)) members.push(f);
    }
    if (!members.length) continue;
    const isExp = expanded.has(key) && members.length > 1;
    const st = groupStatus(r, g);
    rows.push({
      key: 'g:' + key, kind: 'group', groupKey: key, failureId: members[0].id, count: members.length,
      status: members.length === 1 ? memberStatus(members[0]) : st, expanded: isExp,
    });
    if (isExp) {
      for (const f of members) {
        rows.push({ key: 't:' + f.id, kind: 'member', groupKey: key, failureId: f.id, count: 1, status: memberStatus(f), expanded: false });
      }
    }
  }
  return rows;
}

/**
 * Resolve the selected row index from the remembered key. If the key vanished (filter change,
 * group collapsed), fall back to the group row, then to the previous index (clamped) – the cursor
 * stays where the user's eyes are instead of jumping to the top.
 */
export function resolveSelection(rows: Row[], key: string | null, prevIndex: number): number {
  if (!rows.length) return -1;
  if (key) {
    const i = rows.findIndex((x) => x.key === key);
    if (i >= 0) return i;
    if (key.startsWith('t:')) {
      const gi = rows.findIndex((x) => x.kind === 'group' && x.failureId === key.slice(2));
      if (gi >= 0) return gi;
    }
  }
  return Math.max(0, Math.min(prevIndex, rows.length - 1));
}

/** Keep `index` inside [top, top+height) moving the window as little as possible. */
export function scrollWindow(index: number, top: number, height: number, total: number): number {
  if (height <= 0) return 0;
  let t = top;
  if (index < t) t = index;
  if (index >= t + height) t = index - height + 1;
  const maxTop = Math.max(0, total - height);
  return Math.max(0, Math.min(t, maxTop));
}

export interface HeaderModel {
  runId: string;
  kind: string;
  pool?: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  skipped: number;
  fixed: number;
  groups: number;
  etaMs?: number;
  elapsedMs: number;
  ended: boolean;
  projects: Array<{ name: string; done: number; total?: number; failed: number; files: number }>;
}

export function headerModel(r: RunState | null, now: number): HeaderModel | null {
  if (!r) return null;
  const localDone = r.passed + r.failed + r.skipped;
  const done = r.end ? r.end.passed + r.end.failed + r.end.skipped : Math.max(localDone, r.progressDone);
  let fixed = 0;
  for (const f of r.failures.values()) if (f.fix === 'fixed') fixed++;
  let etaMs: number | undefined;
  if (!r.end) {
    if (r.etaMs !== undefined && r.etaAt !== undefined) etaMs = Math.max(0, r.etaMs - (now - r.etaAt));
    else if (done > 0 && r.total > done) etaMs = ((now - r.startedAt) / done) * (r.total - done);
  }
  return {
    runId: r.runId, kind: r.kind, pool: r.pool, total: Math.max(r.total, done), done,
    passed: r.end ? r.end.passed : r.passed,
    failed: r.end ? r.end.failed : Math.max(r.failed, r.progressFailed),
    skipped: r.end ? r.end.skipped : r.skipped,
    fixed, groups: r.groupOrder.length, etaMs,
    elapsedMs: r.end ? r.end.ms : now - r.startedAt,
    ended: !!r.end,
    projects: [...r.projects.values()]
      .filter((p) => p.done > 0 || p.total || p.filesStarted)
      .map((p) => ({ name: p.name, done: p.done, total: p.total, failed: p.failed, files: p.filesStarted })),
  };
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
