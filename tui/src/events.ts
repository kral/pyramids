// Event schema of the vto daemon stream (MCP.md → "Live streaming of failures").
// One JSON object per line. The TUI is lenient: unknown events and unknown fields are ignored,
// missing optional fields get defaults, so a newer daemon never crashes an older UI.

import { cleanLine, cleanText } from './sanitize.js';

export type RunKind = 'affected' | 'full' | 'tests' | string;
export type TestState = 'pass' | 'fail' | 'skip';

export interface Frame {
  file: string;
  line: number;
  col?: number;
  /** Source line as captured by the daemon (fallback when the file can't be read from disk). */
  code?: string;
}

export interface RunStartEvent {
  ev: 'run-start';
  runId: string;
  kind: RunKind;
  total: number;
  files: number;
  pool?: string;
  /**
   * Optional extension (not in MCP.md draft 1): per-project totals, enables exact per-project
   * progress bars. Without it the UI derives per-project counts from file-start/test events.
   */
  projects?: Record<string, { total?: number; files?: number }>;
}
export interface FileStartEvent { ev: 'file-start'; runId: string; file: string; project?: string }
/** `rawId` is set only when sanitising changed the id: requests to the daemon need the original. */
export interface TestEvent { ev: 'test'; runId: string; id: string; rawId?: string; state: TestState; ms?: number }
export interface FailureEvent {
  ev: 'failure';
  runId: string;
  seq: number;
  id: string;
  rawId?: string;
  file: string;
  line: number;
  message: string;
  diff?: string;
  frames?: Frame[];
  group?: string;
  coveredChanged?: string[];
}
export interface ProgressEvent { ev: 'progress'; runId: string; done: number; failed: number; etaMs?: number }
export interface FixRerunEvent { ev: 'fix-rerun'; runId: string; id: string; rawId?: string; state: 'pass' | 'fail' }
export interface RunEndEvent { ev: 'run-end'; runId: string; passed: number; failed: number; skipped: number; ms: number }

export type VtoEvent =
  | RunStartEvent
  | FileStartEvent
  | TestEvent
  | FailureEvent
  | ProgressEvent
  | FixRerunEvent
  | RunEndEvent;

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
// Every string of an event is untrusted (test names, messages, paths come from test output, and
// run logs can be committed files or CI artifacts): sanitise once, here, for all consumers.
const line = (v: unknown, d = ''): string => cleanLine(typeof v === 'string' ? v : d);
const optLine = (v: unknown): string | undefined => (typeof v === 'string' ? cleanLine(v) : undefined);
const MAX_FRAMES = 50;
const MAX_COVERED = 200;
function ids(raw: string): { id: string; rawId?: string } {
  const id = cleanLine(raw);
  return id === raw ? { id } : { id, rawId: raw };
}

/** Sanitise `run-start.projects` (keys are project names from the user's config). */
function projects(v: unknown): RunStartEvent['projects'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: NonNullable<RunStartEvent['projects']> = Object.create(null);
  let n = 0;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (++n > 200) break;
    const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    out[cleanLine(k, 200)] = { total: typeof o.total === 'number' ? o.total : undefined, files: typeof o.files === 'number' ? o.files : undefined };
  }
  return out;
}

/** Validate + normalise one decoded JSON value. Returns null for anything that is not a known event. */
export function normalizeEvent(raw: unknown): VtoEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const runId = line(o.runId).slice(0, 200);
  if (!runId) return null;
  switch (o.ev) {
    case 'run-start':
      return {
        ev: 'run-start', runId, kind: line(o.kind, 'tests').slice(0, 100), total: num(o.total), files: num(o.files),
        pool: optLine(o.pool)?.slice(0, 200),
        projects: projects(o.projects),
      };
    case 'file-start':
      if (typeof o.file !== 'string') return null;
      return { ev: 'file-start', runId, file: cleanLine(o.file), project: optLine(o.project) };
    case 'test': {
      if (typeof o.id !== 'string') return null;
      const s = o.state === 'fail' || o.state === 'skip' ? o.state : o.state === 'pass' ? 'pass' : null;
      if (!s) return null;
      return { ev: 'test', runId, ...ids(o.id), state: s, ms: typeof o.ms === 'number' ? o.ms : undefined };
    }
    case 'failure': {
      if (typeof o.id !== 'string') return null;
      const frames = Array.isArray(o.frames)
        ? (o.frames as unknown[]).slice(0, MAX_FRAMES).flatMap((f) => {
            if (!f || typeof f !== 'object') return [];
            const fr = f as Record<string, unknown>;
            if (typeof fr.file !== 'string') return [];
            return [{ file: cleanLine(fr.file), line: num(fr.line, 1), col: typeof fr.col === 'number' ? fr.col : undefined, code: typeof fr.code === 'string' ? cleanLine(fr.code, 500) : undefined }];
          })
        : [];
      return {
        ev: 'failure', runId, seq: num(o.seq), ...ids(o.id), file: line(o.file, fileOfTestId(o.id)), line: num(o.line, lineOfTestId(o.id)),
        message: cleanText(str(o.message, '(no message)')), diff: typeof o.diff === 'string' ? cleanText(o.diff) : undefined, frames,
        group: optLine(o.group)?.slice(0, 200),
        coveredChanged: Array.isArray(o.coveredChanged) ? (o.coveredChanged as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_COVERED).map((x) => cleanLine(x, 500)) : undefined,
      };
    }
    case 'progress':
      return { ev: 'progress', runId, done: num(o.done), failed: num(o.failed), etaMs: typeof o.etaMs === 'number' ? o.etaMs : undefined };
    case 'fix-rerun':
      if (typeof o.id !== 'string') return null;
      return { ev: 'fix-rerun', runId, ...ids(o.id), state: o.state === 'pass' ? 'pass' : 'fail' };
    case 'run-end':
      return { ev: 'run-end', runId, passed: num(o.passed), failed: num(o.failed), skipped: num(o.skipped), ms: num(o.ms) };
    default:
      return null;
  }
}

/** Parse one NDJSON line (tolerates CR, BOM, blank lines). */
export function parseLine(line: string): VtoEvent | null {
  const s = line.replace(/^﻿/, '').trim();
  if (!s || s[0] !== '{') return null;
  try { return normalizeEvent(JSON.parse(s)); } catch { return null; }
}

/** Incremental NDJSON splitter: feed chunks, get complete lines; keeps the partial tail. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] { const r = this.buf ? [this.buf] : []; this.buf = ''; return r; }
}

/** `src/Button.test.tsx:42 > Button > disabled` → `src/Button.test.tsx` */
export function fileOfTestId(id: string): string {
  const head = id.split(' > ')[0] ?? id;
  const m = /^(.*?):(\d+)$/.exec(head);
  return m ? m[1] : head;
}
export function lineOfTestId(id: string): number {
  const head = id.split(' > ')[0] ?? id;
  const m = /:(\d+)$/.exec(head);
  return m ? Number(m[1]) : 1;
}
/** Human name of a test: everything after the file part. */
export function nameOfTestId(id: string): string {
  const i = id.indexOf(' > ');
  return i < 0 ? id : id.slice(i + 3);
}
